// ---------------------------------------------------------------------------
// index.js  —  Deliveroo <-> Linnworks middleware (entry point)
//
// What this app does:
//   • Receives Deliveroo order webhooks and stores them safely in a database.
//   • Pushes those orders into Linnworks (once Linnworks creds are live).
//   • Reads Linnworks stock and updates Deliveroo availability so you don't
//     oversell (once Deliveroo gives us Brand/Catalogue/Site IDs).
//
// Anything not yet "ready" is staged and logged rather than failing, so the
// service always stays up. Check GET /  to see exactly what's ready.
// ---------------------------------------------------------------------------

const express = require("express");
const config = require("./src/config");
const db = require("./src/db");
const deliveroo = require("./src/deliveroo");
const linnworks = require("./src/linnworks");
const skuMap = require("./sku-map.json"); // { "Linnworks-SKU": "DeliverooItemID" }

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Turn a raw Deliveroo order payload into a tidy structure.
function normaliseOrder(raw, receivedAt) {
  raw = raw || {};
  const orderId =
    raw.id || raw.order_id || raw.orderId || raw.orderReference || null;

  const itemsArray = Array.isArray(raw.items) ? raw.items : [];
  const lines = itemsArray.map((item, index) => ({
    LineNumber: index + 1,
    SKU: item.sku || item.code || null,
    Title: item.name || item.title || "Item",
    Quantity: item.quantity ?? item.qty ?? 1,
    Price: item.price ?? item.unit_price ?? null,
  }));

  return {
    OrderId: orderId,
    ReferenceNumber: orderId,
    Source: "Deliveroo",
    ReceivedAt: receivedAt,
    CustomerName:
      (raw.customer && raw.customer.name) || raw.customer_name || null,
    TotalPrice: raw.total_price ?? raw.total ?? null,
    Lines: lines,
    RawJson: raw,
  };
}

// Try to push any not-yet-pushed orders into Linnworks.
async function pushPendingOrdersToLinnworks() {
  if (!config.flags.linnworksReady) return;

  const pending = await db.getPendingOrders();
  for (const row of pending) {
    const structured = normaliseOrder(row.raw, row.received_at);
    try {
      await linnworks.createOrder(structured);
      await db.markPushed(row.order_id);
      console.log(`[orders] Pushed ${row.order_id} to Linnworks.`);
    } catch (err) {
      await db.markError(row.order_id, err.message);
      console.warn(`[orders] Could not push ${row.order_id}: ${err.message}`);
    }
  }
}

// Read Linnworks stock for all mapped SKUs and update Deliveroo availability.
async function runStockSync() {
  const skus = Object.keys(skuMap);
  if (!skus.length) {
    console.log("[stock] sku-map.json is empty — nothing to sync.");
    return { skus: 0, updated: 0, staged: false };
  }

  let stockBySku = {};
  if (config.flags.linnworksReady) {
    stockBySku = await linnworks.getStockLevelsBySkus(skus);
  } else {
    console.log("[stock] Linnworks not configured — cannot read real stock yet.");
  }

  const items = skus
    .map((sku) => {
      const itemId = skuMap[sku];
      if (!itemId) return null;
      const level = stockBySku[sku] ?? 0;
      return { itemId, sku, available: level > 0, stockLevel: level };
    })
    .filter(Boolean);

  const result = await deliveroo.updateAvailability(items);
  return { skus: skus.length, updated: result.sent, staged: result.staged };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Health + status dashboard (open this in a browser to see what's ready).
app.get("/", (req, res) => {
  res.json({
    message: "Deliveroo–Linnworks integration is running",
    environment: config.deliverooEnv,
    ready: config.flags,
    notes: {
      deliverooStock: config.flags.deliverooStockReady
        ? "Live"
        : "Staged — waiting for Deliveroo Brand/Catalogue/Site IDs",
      linnworks: config.flags.linnworksReady
        ? "Configured"
        : "Waiting for Linnworks app credentials",
      database: config.flags.databaseReady
        ? "Postgres (orders persist)"
        : "In-memory (orders lost on restart — add a database)",
    },
  });
});

// ----- Deliveroo order webhook -----
app.post("/deliveroo/order-webhook", async (req, res) => {
  const raw = req.body || {};
  const receivedAt = new Date().toISOString();
  const orderId =
    raw.id ||
    raw.order_id ||
    raw.orderId ||
    raw.orderReference ||
    `unknown-${receivedAt}`;

  // Acknowledge fast (Deliveroo expects a quick 200), then process.
  res.status(200).send("OK");

  try {
    await db.saveOrder(orderId, raw);
    console.log(`[webhook] Saved Deliveroo order ${orderId}`);
    // Attempt to forward to Linnworks immediately (safe no-op if not ready).
    await pushPendingOrdersToLinnworks();
  } catch (err) {
    console.error(`[webhook] Error handling ${orderId}: ${err.message}`);
  }
});

// ----- Manual stock sync trigger (protected by SYNC_SECRET) -----
// Call: POST /sync/stock  with header  x-sync-secret: <your SYNC_SECRET>
app.post("/sync/stock", async (req, res) => {
  if (config.syncSecret && req.get("x-sync-secret") !== config.syncSecret) {
    return res.status(401).json({ success: false, message: "Bad sync secret" });
  }
  try {
    const result = await runStockSync();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("[stock] sync error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ----- Linnworks Orders pull endpoint (kept for the future channel app / debug) -----
// Returns stored orders that haven't been pushed yet. Does NOT delete them.
app.post("/linnworks/orders", async (req, res) => {
  try {
    const pending = await db.getPendingOrders();
    const orders = pending.map((row) =>
      normaliseOrder(row.raw, row.received_at)
    );
    res.json({ hasMoreOrders: false, orders });
  } catch (err) {
    res.status(500).json({ hasMoreOrders: false, orders: [], error: err.message });
  }
});

// ----- Linnworks channel stubs (kept for the future App Store connector) -----
app.post("/linnworks/add-new-user", (req, res) => res.json({ success: true }));
app.post("/linnworks/user-config", (req, res) => res.json({ success: true, config: {} }));
app.post("/linnworks/save-config", (req, res) => res.json({ success: true }));
app.post("/linnworks/shipping-tags", (req, res) => res.json({ success: true, tags: [] }));
app.post("/linnworks/payment-tags", (req, res) => res.json({ success: true, tags: [] }));
app.post("/linnworks/config-deleted", (req, res) => res.json({ success: true }));
app.post("/linnworks/config-test", (req, res) => res.json({ success: true }));

// ----- Inventory update (manual/testing route, same as before) -----
app.post("/linnworks/inventory-update", async (req, res) => {
  const items = (req.body && req.body.items) || [];
  if (!Array.isArray(items)) {
    return res.status(400).json({ success: false, message: "Missing items array" });
  }
  try {
    const mapped = items
      .map((item) => {
        const sku = item.sku || item.channelSKU || "UNKNOWN";
        const level = item.stockLevel ?? item.stock ?? 0;
        const itemId = skuMap[sku];
        if (!itemId) {
          console.warn(`[inventory] No mapping for SKU '${sku}', skipping.`);
          return null;
        }
        return { itemId, sku, available: level > 0, stockLevel: level };
      })
      .filter(Boolean);

    const result = await deliveroo.updateAvailability(mapped);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("[inventory] error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
async function start() {
  await db.initDb();

  app.listen(config.port, () => {
    console.log(`Server running on port ${config.port} (env=${config.deliverooEnv})`);
    console.log("Ready flags:", JSON.stringify(config.flags));
  });

  // Optional automatic stock sync on a timer.
  if (config.stockSyncIntervalMinutes > 0) {
    const ms = config.stockSyncIntervalMinutes * 60_000;
    console.log(`[stock] Auto-sync every ${config.stockSyncIntervalMinutes} min.`);
    setInterval(() => {
      runStockSync().catch((e) => console.error("[stock] auto-sync error:", e.message));
    }, ms);
  }
}

start().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
