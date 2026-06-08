// ---------------------------------------------------------------------------
// db.js
// Stores Deliveroo orders so they SURVIVE Render restarts/redeploys.
//
// If DATABASE_URL is set (after you add a Render Postgres database), we use
// Postgres. If it is NOT set, we fall back to a simple in-memory list so the
// app still runs locally / before the DB exists — but in-memory orders are
// lost on restart, exactly like the old version. Add the database to be safe.
// ---------------------------------------------------------------------------

const config = require("./config");

let pool = null;
let useMemory = true;
const memoryOrders = []; // fallback only

async function initDb() {
  if (!config.flags.databaseReady) {
    console.log(
      "[db] No DATABASE_URL set — using in-memory store (orders lost on restart)."
    );
    useMemory = true;
    return;
  }

  const { Pool } = require("pg");
  pool = new Pool({
    connectionString: config.databaseUrl,
    // Render's managed Postgres requires SSL.
    ssl: { rejectUnauthorized: false },
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS deliveroo_orders (
      id            SERIAL PRIMARY KEY,
      order_id      TEXT UNIQUE,
      status        TEXT NOT NULL DEFAULT 'pending',
      received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      pushed_at     TIMESTAMPTZ,
      last_error    TEXT,
      raw           JSONB NOT NULL
    );
  `);

  useMemory = false;
  console.log("[db] Connected to Postgres and ensured table exists.");
}

// Save an incoming order. Ignores duplicates (same order_id) so Deliveroo
// re-sending a webhook never creates a double order.
async function saveOrder(orderId, raw) {
  if (useMemory) {
    if (!memoryOrders.find((o) => o.order_id === orderId)) {
      memoryOrders.push({
        order_id: orderId,
        status: "pending",
        received_at: new Date().toISOString(),
        raw,
      });
    }
    return;
  }

  await pool.query(
    `INSERT INTO deliveroo_orders (order_id, raw)
     VALUES ($1, $2)
     ON CONFLICT (order_id) DO NOTHING`,
    [orderId, raw]
  );
}

// Return orders that have not yet been successfully pushed to Linnworks.
async function getPendingOrders() {
  if (useMemory) {
    return memoryOrders.filter((o) => o.status !== "pushed");
  }
  const { rows } = await pool.query(
    `SELECT order_id, status, received_at, raw
     FROM deliveroo_orders
     WHERE status <> 'pushed'
     ORDER BY received_at ASC`
  );
  return rows;
}

async function markPushed(orderId) {
  if (useMemory) {
    const o = memoryOrders.find((x) => x.order_id === orderId);
    if (o) o.status = "pushed";
    return;
  }
  await pool.query(
    `UPDATE deliveroo_orders
     SET status = 'pushed', pushed_at = now(), last_error = NULL
     WHERE order_id = $1`,
    [orderId]
  );
}

async function markError(orderId, message) {
  if (useMemory) {
    const o = memoryOrders.find((x) => x.order_id === orderId);
    if (o) {
      o.status = "error";
      o.last_error = message;
    }
    return;
  }
  await pool.query(
    `UPDATE deliveroo_orders
     SET status = 'error', last_error = $2
     WHERE order_id = $1`,
    [orderId, message]
  );
}

module.exports = {
  initDb,
  saveOrder,
  getPendingOrders,
  markPushed,
  markError,
};
