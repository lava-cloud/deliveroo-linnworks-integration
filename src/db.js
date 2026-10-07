// ---------------------------------------------------------------------------
// db.js
// Persists two things so they survive Render restarts/redeploys:
//   1. Deliveroo orders waiting to be collected by Linnworks.
//   2. Channel configuration, keyed by the AuthorizationToken that Linnworks
//      receives from our AddNewUser endpoint (one row per connected account).
//
// If DATABASE_URL is set we use Postgres. If not, we fall back to in-memory
// (lost on restart) so the app still runs locally.
// ---------------------------------------------------------------------------

const config = require("./config");

let pool = null;
let useMemory = true;
const mem = { orders: [], configs: {} }; // fallback only

// Only orders accepted on the tablet go to Linnworks. A rejected or cancelled
// order must never reach the warehouse, even if Linnworks hasn't collected it.
const ACCEPTED_STATUSES = new Set(["accepted", "confirmed"]);
const DEAD_STATUSES = new Set(["rejected", "canceled", "cancelled", "failed"]);

async function initDb() {
  if (!config.flags.databaseReady) {
    console.log("[db] No DATABASE_URL — using in-memory store (lost on restart).");
    useMemory = true;
    return;
  }

  // If the database is unreachable, DO NOT crash the whole service — fall back
  // to in-memory so order ingestion keeps working. (A DB blip must never take
  // down the webhook.)
  try {
    const { Pool } = require("pg");
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: { rejectUnauthorized: false }, // Render managed Postgres needs SSL
      connectionTimeoutMillis: 10000,
    });
    // Never let an async pool error crash the process.
    pool.on("error", (e) => console.error("[db] pool error:", e.message));

    await pool.query(`
      CREATE TABLE IF NOT EXISTS deliveroo_orders (
        id           SERIAL PRIMARY KEY,
        order_id     TEXT UNIQUE,
        received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        raw          JSONB NOT NULL
      );
    `);
    await pool.query(`ALTER TABLE deliveroo_orders ADD COLUMN IF NOT EXISTS status TEXT`);
    await pool.query(`ALTER TABLE deliveroo_orders ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS channel_configs (
        auth_token   TEXT PRIMARY KEY,
        config       JSONB NOT NULL DEFAULT '{}',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    useMemory = false;
    console.log("[db] Connected to Postgres; tables ready.");
  } catch (err) {
    console.error(
      "[db] Postgres unavailable — falling back to in-memory so the service stays up:",
      err.message
    );
    useMemory = true;
    pool = null;
  }
}

// ----- Orders -----

// Record an order event. The first event stores the order; later events
// update its status, and accepted_at is stamped the first time it's accepted.
async function saveOrder(orderId, raw, status = "") {
  const accepted = ACCEPTED_STATUSES.has(status);
  if (useMemory) {
    const now = new Date().toISOString();
    let row = mem.orders.find((o) => o.order_id === orderId);
    if (!row) {
      row = { order_id: orderId, received_at: now, raw, status: null, accepted_at: null };
      mem.orders.push(row);
    }
    if (status) row.status = status;
    if (accepted && !row.accepted_at) row.accepted_at = now;
    return;
  }
  await pool.query(
    `INSERT INTO deliveroo_orders (order_id, raw, status, accepted_at)
     VALUES ($1, $2, NULLIF($3, ''), CASE WHEN $4::boolean THEN now() END)
     ON CONFLICT (order_id) DO UPDATE SET
       status      = COALESCE(EXCLUDED.status, deliveroo_orders.status),
       accepted_at = COALESCE(deliveroo_orders.accepted_at, EXCLUDED.accepted_at)`,
    [orderId, raw, status, accepted]
  );
}

// Orders ready for Linnworks, paginated: accepted, not since rejected or
// cancelled. Filtered on accepted_at, not received_at — an order placed before
// Linnworks' last poll but accepted after it must still be picked up.
// Linnworks de-duplicates by ReferenceNumber, so overlapping windows are safe.
async function getOrdersSince(sinceIso, pageNumber, pageSize) {
  const offset = (Math.max(1, pageNumber) - 1) * pageSize;
  if (useMemory) {
    const all = mem.orders
      .filter((o) => o.accepted_at && !DEAD_STATUSES.has(o.status))
      .filter((o) => !sinceIso || new Date(o.accepted_at) >= new Date(sinceIso))
      .sort((a, b) => new Date(a.accepted_at) - new Date(b.accepted_at));
    const page = all.slice(offset, offset + pageSize);
    return { rows: page, hasMore: offset + pageSize < all.length };
  }
  const { rows } = await pool.query(
    `SELECT order_id, received_at, raw FROM deliveroo_orders
     WHERE accepted_at IS NOT NULL
       AND NOT (COALESCE(status, '') = ANY($4::text[]))
       AND ($1::timestamptz IS NULL OR accepted_at >= $1)
     ORDER BY accepted_at ASC
     LIMIT $2 OFFSET $3`,
    [sinceIso || null, pageSize + 1, offset, [...DEAD_STATUSES]]
  );
  const hasMore = rows.length > pageSize;
  return { rows: rows.slice(0, pageSize), hasMore };
}

// Every recent order whatever its status, newest first (diagnostics).
async function recentOrders(limit) {
  if (useMemory) {
    return [...mem.orders]
      .sort((a, b) => new Date(b.received_at) - new Date(a.received_at))
      .slice(0, limit);
  }
  const { rows } = await pool.query(
    `SELECT order_id, received_at, status, accepted_at, raw FROM deliveroo_orders
     ORDER BY received_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

// Returns how many orders were deleted.
async function purgeOrdersOlderThan(hours) {
  if (useMemory) {
    const cutoff = Date.now() - hours * 3600 * 1000;
    const before = mem.orders.length;
    mem.orders = mem.orders.filter((o) => new Date(o.received_at).getTime() >= cutoff);
    return before - mem.orders.length;
  }
  const { rowCount } = await pool.query(
    `DELETE FROM deliveroo_orders WHERE received_at < now() - make_interval(hours => $1::int)`,
    [hours]
  );
  return rowCount;
}

// ----- Channel configuration (per connected account) -----

async function createConfig(authToken, initialConfig = {}) {
  if (useMemory) {
    mem.configs[authToken] = initialConfig;
    return;
  }
  await pool.query(
    `INSERT INTO channel_configs (auth_token, config)
     VALUES ($1, $2) ON CONFLICT (auth_token) DO NOTHING`,
    [authToken, initialConfig]
  );
}

async function saveConfig(authToken, configObj) {
  if (useMemory) {
    mem.configs[authToken] = configObj;
    return;
  }
  await pool.query(
    `INSERT INTO channel_configs (auth_token, config, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (auth_token)
     DO UPDATE SET config = $2, updated_at = now()`,
    [authToken, configObj]
  );
}

async function getConfig(authToken) {
  if (useMemory) return mem.configs[authToken] || null;
  const { rows } = await pool.query(
    `SELECT config FROM channel_configs WHERE auth_token = $1`,
    [authToken]
  );
  return rows.length ? rows[0].config : null;
}

async function deleteConfig(authToken) {
  if (useMemory) {
    delete mem.configs[authToken];
    return;
  }
  await pool.query(`DELETE FROM channel_configs WHERE auth_token = $1`, [authToken]);
}

// ----- Diagnostics -----
async function counts() {
  if (useMemory) {
    return { orders: mem.orders.length, configs: Object.keys(mem.configs).length };
  }
  const o = await pool.query(`SELECT COUNT(*)::int AS c FROM deliveroo_orders`);
  const c = await pool.query(`SELECT COUNT(*)::int AS c FROM channel_configs`);
  return { orders: o.rows[0].c, configs: c.rows[0].c };
}

module.exports = {
  initDb,
  counts,
  saveOrder,
  getOrdersSince,
  recentOrders,
  purgeOrdersOlderThan,
  createConfig,
  saveConfig,
  getConfig,
  deleteConfig,
};
