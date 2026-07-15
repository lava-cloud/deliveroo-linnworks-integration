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

// Save an incoming Deliveroo order. Duplicate order ids are ignored.
async function saveOrder(orderId, raw) {
  if (useMemory) {
    if (!mem.orders.find((o) => o.order_id === orderId)) {
      mem.orders.push({
        order_id: orderId,
        received_at: new Date().toISOString(),
        raw,
      });
    }
    return;
  }
  await pool.query(
    `INSERT INTO deliveroo_orders (order_id, raw)
     VALUES ($1, $2) ON CONFLICT (order_id) DO NOTHING`,
    [orderId, raw]
  );
}

// Return orders received at/after a given time, paginated.
// Linnworks polls with UTCTimeFrom + PageNumber and de-duplicates by
// ReferenceNumber, so we simply return matching orders (never delete them).
async function getOrdersSince(sinceIso, pageNumber, pageSize) {
  const offset = (Math.max(1, pageNumber) - 1) * pageSize;
  if (useMemory) {
    const all = mem.orders
      .filter((o) => !sinceIso || new Date(o.received_at) >= new Date(sinceIso))
      .sort((a, b) => new Date(a.received_at) - new Date(b.received_at));
    const page = all.slice(offset, offset + pageSize);
    return { rows: page, hasMore: offset + pageSize < all.length };
  }
  const { rows } = await pool.query(
    `SELECT order_id, received_at, raw FROM deliveroo_orders
     WHERE ($1::timestamptz IS NULL OR received_at >= $1)
     ORDER BY received_at ASC
     LIMIT $2 OFFSET $3`,
    [sinceIso || null, pageSize + 1, offset]
  );
  const hasMore = rows.length > pageSize;
  return { rows: rows.slice(0, pageSize), hasMore };
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
  createConfig,
  saveConfig,
  getConfig,
  deleteConfig,
};
