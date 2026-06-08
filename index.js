// ---------------------------------------------------------------------------
// index.js  —  Deliveroo <-> Linnworks middleware (Channel Integration model)
//
// HOW IT WORKS (Channel Integration):
//   • Linnworks CALLS our endpoints (we don't call Linnworks).
//   • Setup wizard:  AddNewUser -> UserConfig -> SaveConfig  (issues a token).
//   • Orders:        Linnworks polls /linnworks/orders; we return Deliveroo
//                    orders we've collected, in Linnworks' exact schema.
//   • Stock:         Linnworks pushes levels to /linnworks/inventory-update;
//                    we forward availability to Deliveroo (anti-oversell).
//
// Deliveroo sends new orders to /deliveroo/order-webhook, which we store.
//
// Every endpoint returns HTTP 200 with any error inside an "Error" field,
// exactly as Linnworks requires, and responds well within the 10s limit.
// Open GET /  to see what's ready.
// ---------------------------------------------------------------------------

const crypto = require("crypto");
const express = require("express");
const config = require("./src/config");
const db = require("./src/db");
const deliveroo = require("./src/deliveroo");
const skuMap = require("./sku-map.json"); // { "Linnworks-or-Channel-SKU": "DeliverooItemID" }

const app = express();
app.use(express.json({ limit: "2mb" }));

// --- helpers ---------------------------------------------------------------

// Linnworks documents the field as "AuthorizationToken"; some places spell it
// "AuthorisationToken". Accept either so we're never tripped up by casing.
function getAuthToken(body) {
  body = body || {};
  return body.AuthorizationToken || body.AuthorisationToken || body.authToken || null;
}

// Format an ISO date as Linnworks' "yyyy-MM-dd HH:mm:ssZ".
function lwDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

// Convert a stored Deliveroo order into a Linnworks order object.
function toLinnworksOrder(row) {
  const raw = row.raw || {};
  const orderId =
    raw.id || raw.order_id || raw.orderId || raw.orderReference || row.order_id;

  const itemsArray = Array.isArray(raw.items) ? raw.items : [];
  const OrderItems = itemsArray.map((item, i) => ({
    UseChannelTax: false,
    TaxCostInclusive: true,
    IsService: false,
    OrderLineNumber: String(i + 1),
    SKU: item.sku || item.code || item.plu || "",
    PricePerUnit: String(item.price ?? item.unit_price ?? 0),
    Qty: String(item.quantity ?? item.qty ?? 1),
    TaxRate: "0",
    LinePercentDiscount: "0",
    ItemTitle: item.name || item.title || "Item",
    Options: [],
    CancelStatus: "NONE",
  }));

  const cust = raw.customer || {};
  const addr = cust.address || raw.delivery_address || {};
  const address = {
    FullName: cust.name || raw.customer_name || "Deliveroo Customer",
    Company: "",
    Address1: addr.line1 || addr.address1 || "",
    Address2: addr.line2 || addr.address2 || "",
    Address3: "",
    Town: addr.city || addr.town || "",
    Region: addr.region || "",
    PostCode: addr.postcode || addr.post_code || "",
    Country: addr.country || "United Kingdom",
    CountryCode: addr.country_code || "GB",
    PhoneNumber: cust.phone || "",
    EmailAddress: cust.email || "",
  };

  return {
    ReferenceNumber: String(orderId),
    ExternalReference: String(orderId),
    Site: "Deliveroo",
    ChannelBuyerName: cust.name || raw.customer_name || "Deliveroo Customer",
    Currency: raw.currency || "GBP",
    PaymentStatus: "PAID",
    ReceivedDate: lwDate(row.received_at),
    PaidOn: lwDate(row.received_at),
    UseChannelTax: false,
    PostalServiceCost: 0,
    PostalServiceTaxRate: 0,
    Discount: 0,
    BillingAddress: address,
    DeliveryAddress: address,
    OrderItems,
    ExtendedProperties: [],
    Notes: [],
    MatchPostalServiceTag: "Deliveroo",
    MatchPaymentMethodTag: "Deliveroo",
  };
}

// --- status / health -------------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    message: "Deliveroo–Linnworks integration is running",
    model: "Linnworks Channel Integration",
    environment: config.deliverooEnv,
    ready: config.flags,
    notes: {
      deliverooStock: config.flags.deliverooStockReady
        ? "Live"
        : "Staged — waiting for Deliveroo Brand/Catalogue/Site IDs",
      database: config.flags.databaseReady
        ? "Postgres (orders & config persist)"
        : "In-memory (lost on restart — add a database)",
    },
  });
});

// --- Deliveroo order webhook ----------------------------------------------

app.post("/deliveroo/order-webhook", async (req, res) => {
  const raw = req.body || {};
  const receivedAt = new Date().toISOString();
  const orderId =
    raw.id || raw.order_id || raw.orderId || raw.orderReference || `unknown-${receivedAt}`;

  res.status(200).send("OK"); // acknowledge fast

  try {
    await db.saveOrder(orderId, raw);
    console.log(`[webhook] Stored Deliveroo order ${orderId}`);
  } catch (err) {
    console.error(`[webhook] Error storing ${orderId}: ${err.message}`);
  }
});

// ===========================================================================
// LINNWORKS CHANNEL INTEGRATION ENDPOINTS
// ===========================================================================

// ----- Setup wizard: AddNewUser (NO AuthorizationToken on this one) -----
// We mint a token that uniquely identifies this connected account and store a
// config row against it. Linnworks then sends this token on every later call.
app.post("/linnworks/add-new-user", async (req, res) => {
  try {
    const authToken = crypto.randomUUID();
    await db.createConfig(authToken, {});
    console.log(`[lw] AddNewUser -> issued token ${authToken}`);
    res.json({ Error: null, AuthorizationToken: authToken });
  } catch (err) {
    res.json({ Error: err.message });
  }
});

// ----- Setup wizard: UserConfig (return current saved config) -----
app.post("/linnworks/user-config", async (req, res) => {
  const token = getAuthToken(req.body);
  try {
    const cfg = (token && (await db.getConfig(token))) || {};
    res.json({ Error: null, Config: cfg });
  } catch (err) {
    res.json({ Error: err.message });
  }
});

// ----- Setup wizard: SaveConfig -----
app.post("/linnworks/save-config", async (req, res) => {
  const token = getAuthToken(req.body);
  const incoming = (req.body && req.body.Config) || req.body || {};
  try {
    if (token) await db.saveConfig(token, incoming);
    res.json({ Error: null });
  } catch (err) {
    res.json({ Error: err.message });
  }
});

// ----- ConfigDeleted -----
app.post("/linnworks/config-deleted", async (req, res) => {
  const token = getAuthToken(req.body);
  try {
    if (token) await db.deleteConfig(token);
    res.json({ Error: null });
  } catch (err) {
    res.json({ Error: err.message });
  }
});

// ----- ConfigTest -----
app.post("/linnworks/config-test", (req, res) => {
  res.json({ Error: null });
});

// ----- Optional tag endpoints (empty is fine) -----
app.post("/linnworks/shipping-tags", (req, res) =>
  res.json({ Error: null, ShippingTags: [{ Tag: "Deliveroo", Name: "Deliveroo" }] })
);
app.post("/linnworks/payment-tags", (req, res) =>
  res.json({ Error: null, PaymentTags: [{ Tag: "Deliveroo", Name: "Deliveroo" }] })
);

// ----- Orders: Linnworks pulls new Deliveroo orders -----
// Request:  { AuthorizationToken, UTCTimeFrom, PageNumber }
// Response: { Error, HasMorePages, Orders: [...] }
app.post("/linnworks/orders", async (req, res) => {
  const body = req.body || {};
  const since = body.UTCTimeFrom ? String(body.UTCTimeFrom).replace(" ", "T") : null;
  const page = Number(body.PageNumber || 1);
  const PAGE_SIZE = 50;
  try {
    const { rows, hasMore } = await db.getOrdersSince(since, page, PAGE_SIZE);
    res.json({
      Error: null,
      HasMorePages: hasMore,
      Orders: rows.map(toLinnworksOrder),
    });
  } catch (err) {
    console.error("[lw] orders error:", err.message);
    res.json({ Error: err.message, HasMorePages: false, Orders: [] });
  }
});

// ----- Despatch: Linnworks tells us an order shipped (acknowledge) -----
app.post("/linnworks/despatch", (req, res) => {
  console.log("[lw] Despatch notification received.");
  res.json({ Error: null });
});

// ----- Products: list channel products for mapping -----
// We return the SKUs we know about from sku-map.json so the merchant can map
// Linnworks inventory to Deliveroo items inside Linnworks.
app.post("/linnworks/products", (req, res) => {
  const Products = Object.keys(skuMap).map((sku) => ({
    SKU: sku,
    Reference: skuMap[sku],
    Title: sku,
  }));
  res.json({ Error: null, Products });
});

// ----- PriceUpdate: acknowledge (Deliveroo pricing handled separately) -----
app.post("/linnworks/price-update", (req, res) => {
  const products = (req.body && req.body.Products) || [];
  res.json({
    Error: null,
    Products: products.map((p) => ({ SKU: p.SKU, Error: null })),
  });
});

// ----- InventoryUpdate: Linnworks pushes stock -> we update Deliveroo -----
// Request:  { AuthorizationToken, Products: [{ SKU, Reference, Quantity, ... }] }
// Response: { Error, Products: [{ SKU, Error }] }
app.post("/linnworks/inventory-update", async (req, res) => {
  const products = (req.body && req.body.Products) || [];
  if (!Array.isArray(products)) {
    return res.json({ Error: "Missing Products array", Products: [] });
  }

  // Map each channel SKU to a Deliveroo item id.
  // The Deliveroo item id can come from the mapping "Reference", from
  // sku-map.json, or the SKU may already BE the Deliveroo item id.
  const items = [];
  const perProduct = [];
  for (const p of products) {
    const sku = p.SKU;
    const qty = Number(p.Quantity ?? 0);
    const itemId = p.Reference || skuMap[sku] || sku;
    if (!itemId) {
      perProduct.push({ SKU: sku, Error: "No Deliveroo item mapping" });
      continue;
    }
    items.push({ itemId, sku, available: qty > 0, stockLevel: qty });
    perProduct.push({ SKU: sku, Error: null });
  }

  try {
    const result = await deliveroo.updateAvailability(items);
    console.log(
      `[lw] InventoryUpdate: ${items.length} item(s), ` +
        (result.staged ? "STAGED (no Deliveroo IDs yet)" : `${result.sent} sent`)
    );
    res.json({ Error: null, Products: perProduct });
  } catch (err) {
    console.error("[lw] inventory-update error:", err.message);
    res.json({ Error: err.message, Products: perProduct });
  }
});

// --- startup ---------------------------------------------------------------

async function start() {
  await db.initDb();
  app.listen(config.port, () => {
    console.log(`Server running on port ${config.port} (env=${config.deliverooEnv})`);
    console.log("Ready flags:", JSON.stringify(config.flags));
  });
}

start().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
