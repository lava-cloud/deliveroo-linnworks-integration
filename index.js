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
const catalogue = require("./src/catalogue");
const skuMap = require("./sku-map.json"); // { "Linnworks-or-Channel-SKU": "DeliverooItemID" }

// In-memory state for the sandbox catalogue scenarios.
const catState = { uploadUrl: null, uploadId: null, catalogueId: null, lastWebhook: null };
// Orders API state: track synced orders + last sync result for debugging.
const syncedOrders = new Set();
let lastSync = null;
const recentEvents = []; // every order webhook call (not deduped), for debugging

// PLUs (pos_item_ids) we can fulfil. Sandbox menu by default; in production
// this becomes your Linnworks SKUs. Override with DELIV_VALID_PLUS (comma list).
const VALID_PLUS = new Set(
  (process.env.DELIV_VALID_PLUS ||
    "MU11001,MU11002,OM17001,OM17002,OM17300,OM21001,OM21002,OM21003")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

// Expected product name for each known PLU — lets us catch a PLU attached to
// the wrong item (a "mismatch"). Sandbox menu; in production this comes from
// your Linnworks SKU->title mapping.
const PLU_NAMES = {
  MU11001: "Chicken Burger",
  MU11002: "Veggie Burger (V)",
  OM17001: "Mayo Sauce",
  OM17002: "BBQ Sauce",
  OM17300: "Coca Cola",
};

// Flatten an order into {name, plu} entries (items + their modifiers).
function orderLines(order) {
  const out = [];
  for (const it of order.items || []) {
    out.push({ name: it.name, plu: it.pos_item_id });
    for (const m of it.modifiers || []) out.push({ name: m.name, plu: m.pos_item_id });
  }
  return out;
}

// Decide the sync status for an order based on its PLUs.
function syncDecision(order) {
  const lines = orderLines(order);
  // Missing PLU
  if (lines.some((l) => !l.plu || String(l.plu).trim() === "")) {
    return { status: "failed", reason: "pos_item_id_not_found", notes: "Order contains an item with no PLU" };
  }
  // Unknown PLU (not in our catalogue at all)
  const unknown = lines.find((l) => !VALID_PLUS.has(String(l.plu)));
  if (unknown) {
    return { status: "failed", reason: "pos_item_id_mismatched", notes: `Unknown PLU: ${unknown.plu}` };
  }
  // Mismatched PLU (valid PLU, but attached to the wrong item)
  const mism = lines.find((l) => PLU_NAMES[l.plu] && PLU_NAMES[l.plu] !== l.name);
  if (mism) {
    return {
      status: "failed",
      reason: "pos_item_id_mismatched",
      notes: `PLU ${mism.plu} expected "${PLU_NAMES[mism.plu]}" but order had "${mism.name}"`,
    };
  }
  return { status: "succeeded", reason: "", notes: "" };
}
// Sandbox brand id (discovered via GET site brand id). Override with DELIV_BRAND_ID.
const SANDBOX_BRAND = "17b449e6-43f8-4dec-adf9-10240a5138a1";
const brandIdFor = (req) =>
  (req.body && req.body.brandId) || config.deliveroo.brandId || SANDBOX_BRAND;

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
// Deliveroo money is { fractional: <minor units>, currency_code }.
function money(m) {
  if (m && typeof m.fractional === "number") return m.fractional / 100;
  if (typeof m === "number") return m;
  return 0;
}

function toLinnworksOrder(row) {
  const raw = row.raw || {};
  // Real Deliveroo orders nest under body.order.
  const order = (raw.body && raw.body.order) || raw.order || raw;
  const orderId =
    order.id || raw.id || raw.order_id || row.order_id;

  const itemsArray = Array.isArray(order.items) ? order.items : [];
  const OrderItems = [];
  let lineNo = 0;
  const pushLine = (sku, title, qty, price) =>
    OrderItems.push({
      UseChannelTax: false,
      TaxCostInclusive: true,
      IsService: false,
      OrderLineNumber: String(++lineNo),
      SKU: sku || "",
      PricePerUnit: String(price),
      Qty: String(qty),
      TaxRate: "0",
      LinePercentDiscount: "0",
      ItemTitle: title || "Item",
      Options: [],
      CancelStatus: "NONE",
    });
  for (const item of itemsArray) {
    pushLine(item.pos_item_id || item.sku, item.name, item.quantity ?? 1, money(item.unit_price));
    // Modifiers / add-ons become their own lines so they decrement stock too.
    for (const m of item.modifiers || []) {
      pushLine(m.pos_item_id, m.name, m.quantity ?? 1, money(m.unit_price));
    }
  }

  const cust = order.customer || {};
  const custName =
    cust.name ||
    [cust.first_name, cust.last_name].filter(Boolean).join(" ") ||
    "Deliveroo Customer";
  const addr =
    (order.fulfillment && order.fulfillment.delivery_address) || cust.address || {};
  const address = {
    FullName: custName,
    Company: "",
    Address1: addr.line1 || addr.address1 || "",
    Address2: addr.line2 || addr.address2 || "",
    Address3: "",
    Town: addr.town || addr.city || "",
    Region: addr.region || "",
    PostCode: addr.postcode || addr.post_code || "",
    Country: addr.country || "United Kingdom",
    CountryCode: addr.country_code || "GB",
    PhoneNumber: cust.phone_number || cust.contact_number || "",
    EmailAddress: cust.email || "",
  };

  const noteText = order.note_to_customer || order.notes || "";
  const ExtendedProperties = noteText
    ? [{ Name: "DeliverooNote", Value: String(noteText), Type: "Order" }]
    : [];

  return {
    ReferenceNumber: String(orderId),
    ExternalReference: String(orderId),
    Site: "Deliveroo",
    ChannelBuyerName: custName,
    Currency: (order.total_price && order.total_price.currency_code) || "GBP",
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
    ExtendedProperties,
    Notes: [],
    MatchPostalServiceTag: "Deliveroo",
    MatchPaymentMethodTag: "Deliveroo",
  };
}

// --- channel logo (Linnworks manifest requires a non-empty logo URL) -------
// Generates a small solid-colour PNG at startup so we don't depend on any
// external image host. Served at GET /logo.png.
const zlib = require("zlib");
function makeSolidPng(width, height, r, g, b) {
  const crcTable = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  };
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = r;
    row[1 + x * 3 + 1] = g;
    row[1 + x * 3 + 2] = b;
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}
const LOGO_PNG = makeSolidPng(120, 120, 0, 204, 188); // small square logo
const IMG_1920 = makeSolidPng(1920, 1080, 0, 204, 188); // 16:9 catalogue image
app.get("/logo.png", (req, res) => {
  res.set("Content-Type", "image/png");
  res.send(LOGO_PNG);
});
// 1920x1080 16:9 image for catalogue items/hero (Deliveroo min size).
app.get("/img1920.png", (req, res) => {
  res.set("Content-Type", "image/png");
  res.send(IMG_1920);
});

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

// --- diagnostics (protected by SYNC_SECRET) --------------------------------
// GET /debug/status  header x-sync-secret: <SYNC_SECRET>
// Shows how many orders and connected configs exist — confirms Linnworks
// reached our AddNewUser endpoint without reading raw logs.
app.get("/debug/status", async (req, res) => {
  if (config.syncSecret && req.get("x-sync-secret") !== config.syncSecret) {
    return res.status(401).json({ error: "Bad sync secret" });
  }
  try {
    res.json({ ok: true, ...(await db.counts()), ready: config.flags });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /debug/deliveroo-discover  header x-sync-secret: <SYNC_SECRET>
// Reads your brand(s) and their sites from Deliveroo so we can capture the
// brand_id (and confirm site_id) once the API is connected. Read-only.
app.get("/debug/deliveroo-discover", async (req, res) => {
  if (config.syncSecret && req.get("x-sync-secret") !== config.syncSecret) {
    return res.status(401).json({ error: "Bad sync secret" });
  }
  try {
    const brands = await deliveroo.listBrands();
    const result = { env: config.deliverooEnv, brands: brands.body, status: brands.status, sites: {} };
    // If brands came back, try to list sites for each brand id.
    const list = Array.isArray(brands.body) ? brands.body : brands.body && brands.body.brands;
    result.menus = {};
    if (Array.isArray(list)) {
      for (const b of list) {
        const id = b.id || b.brand_id || b.brandId;
        if (id) {
          result.sites[id] = (await deliveroo.listSites(id)).body;
          result.menus[id] = (await deliveroo.listMenus(id)).body;
        }
      }
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /debug/deliveroo-stock-test  header x-sync-secret
// Body: { brandId, menuId, siteId, itemId, unavailable: true|false }
// Live test: toggles one menu item's availability in sandbox.
app.post("/debug/deliveroo-stock-test", async (req, res) => {
  if (config.syncSecret && req.get("x-sync-secret") !== config.syncSecret) {
    return res.status(401).json({ error: "Bad sync secret" });
  }
  const { brandId, menuId, siteId, itemId, unavailable } = req.body || {};
  try {
    const r = await deliveroo.setMenuItemUnavailability(
      brandId,
      menuId,
      siteId,
      itemId,
      unavailable !== false
    );
    res.json({ ok: r.status >= 200 && r.status < 300, ...r });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Catalogue events webhook (the "Missing" webhook in the portal) --------
// Register this URL in Dev Portal -> Webhooks -> Catalogue events.
app.post("/deliveroo/catalogue-webhook", (req, res) => {
  catState.lastWebhook = { at: new Date().toISOString(), body: req.body };
  console.log("[catalogue-webhook]", JSON.stringify(req.body));
  res.status(200).send("OK");
});

// --- Catalogue sandbox scenario triggers (protected by SYNC_SECRET) --------
function requireSecret(req, res) {
  if (config.syncSecret && req.get("x-sync-secret") !== config.syncSecret) {
    res.status(401).json({ error: "Bad sync secret" });
    return false;
  }
  return true;
}

// Scenario 1: Fetch brand ID via site location id. Body: { siteLocationId }
app.post("/debug/cat/brand", async (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    res.json(await catalogue.getSiteBrandId((req.body && req.body.siteLocationId) || "101"));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Scenario 2: Create catalogue upload → stores upload_url + upload_id.
app.post("/debug/cat/upload", async (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    const r = await catalogue.createUpload(brandIdFor(req));
    if (r.body && typeof r.body === "object") {
      catState.uploadUrl = r.body.upload_url || null;
      catState.uploadId = r.body.upload_id || null;
    }
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Scenario 3: Upload the sample catalogue JSON to the stored upload_url.
// Body: { catalogueId }
app.post("/debug/cat/upload-json", async (req, res) => {
  if (!requireSecret(req, res)) return;
  const catalogueId = (req.body && req.body.catalogueId) || "lava_test_catalogue_1";
  if (!catState.uploadUrl) {
    return res.status(400).json({ error: "No upload_url — run /debug/cat/upload first" });
  }
  catState.catalogueId = catalogueId;
  try {
    const json = catalogue.sampleCatalogue(catalogueId);
    const r = await catalogue.uploadCatalogueJson(catState.uploadUrl, json);
    const items = (json.catalogue && json.catalogue.items) || [];
    res.json({ uploaded: r, catalogueId, items: items.map((i) => i.id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Scenario 4: Update listings. Body: { siteId, itemIds? }
app.post("/debug/cat/listings", async (req, res) => {
  if (!requireSecret(req, res)) return;
  const siteId = (req.body && req.body.siteId) || "101";
  const catalogueId = (req.body && req.body.catalogueId) || catState.catalogueId;
  const itemIds =
    (req.body && req.body.itemIds) || ["item_lava_1", "item_lava_2"];
  try {
    res.json(await catalogue.updateListings(brandIdFor(req), catalogueId, siteId, itemIds));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Scenario 6: Update unavailabilities. Body: { itemId, status }
app.post("/debug/cat/unavail", async (req, res) => {
  if (!requireSecret(req, res)) return;
  const itemId = (req.body && req.body.itemId) || "item_lava_1";
  const siteId = (req.body && req.body.siteId) || "101";
  const catalogueId = (req.body && req.body.catalogueId) || catState.catalogueId;
  const available = (req.body && req.body.status) !== "unavailable";
  try {
    res.json(
      await catalogue.updateUnavailabilities(brandIdFor(req), catalogueId, siteId, [
        { itemId, available },
      ])
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Show the most recent Deliveroo orders we've received (raw payloads).
app.get("/debug/orders", async (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    const { rows } = await db.getOrdersSince(null, 1, 20);
    res.json({
      count: rows.length,
      orders: rows.map((r) => ({ order_id: r.order_id, received_at: r.received_at, raw: r.raw })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manually test the sync-status call against a given order id (path check).
app.post("/debug/sync-test", async (req, res) => {
  if (!requireSecret(req, res)) return;
  const orderId = (req.body && req.body.orderId) || "";
  try {
    res.json(await deliveroo.sendOrderSyncStatus(orderId, "succeeded"));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Show the last order sync-status result we sent to Deliveroo.
app.get("/debug/sync", (req, res) => {
  if (!requireSecret(req, res)) return;
  res.json({ lastSync, syncedCount: syncedOrders.size });
});

// Show every recent order webhook event (not deduped).
app.get("/debug/events", (req, res) => {
  if (!requireSecret(req, res)) return;
  res.json({ events: recentEvents });
});

// Probe whether a catalogue was processed/accepted. Body: { catalogueId }
app.post("/debug/cat/get", async (req, res) => {
  if (!requireSecret(req, res)) return;
  const catalogueId = (req.body && req.body.catalogueId) || catState.catalogueId || "lava_test_catalogue_1";
  try {
    res.json(await catalogue.getCatalogue(brandIdFor(req), catalogueId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Poll upload status by upload_id (shows processing result + error messages).
app.post("/debug/cat/upload-status", async (req, res) => {
  if (!requireSecret(req, res)) return;
  const uploadId = (req.body && req.body.uploadId) || catState.uploadId;
  if (!uploadId) return res.status(400).json({ error: "No uploadId" });
  try {
    res.json(await catalogue.getUploadStatus(brandIdFor(req), uploadId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Inspect scenario state (upload ids, last webhook received).
app.get("/debug/cat/state", (req, res) => {
  if (!requireSecret(req, res)) return;
  res.json(catState);
});

// --- Deliveroo order webhook ----------------------------------------------

app.post("/deliveroo/order-webhook", async (req, res) => {
  const raw = req.body || {};
  // Deliveroo nests the order under body.order; the event type is top-level.
  const order = (raw.body && raw.body.order) || raw.order || raw;
  const event = raw.event || "";
  const status = order.status || "";
  const orderId =
    order.id || raw.id || raw.order_id || `unknown-${new Date().toISOString()}`;

  res.status(200).send("OK"); // acknowledge fast

  // Record every event (not deduped) for debugging.
  recentEvents.unshift({
    at: new Date().toISOString(),
    event,
    orderId,
    status,
    status_log: order.status_log,
    has_remake: !!order.remake_details,
  });
  if (recentEvents.length > 30) recentEvents.pop();

  try {
    await db.saveOrder(orderId, raw);
    console.log(`[webhook] ${event || "(no event)"} ${orderId} status=${status}`);

    // On the "accepted" event, send a sync status: succeeded if we can fulfil
    // every PLU, otherwise failed with the appropriate reason.
    if (status === "accepted" && !syncedOrders.has(orderId)) {
      syncedOrders.add(orderId);
      const d = syncDecision(order);
      lastSync = {
        orderId,
        decision: d,
        ...(await deliveroo.sendOrderSyncStatus(orderId, d.status, d.reason, d.notes)),
      };
    }
  } catch (err) {
    console.error(`[webhook] Error handling ${orderId}: ${err.message}`);
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

// A "completed wizard" response. Returning StepName "UserConfig" tells
// Linnworks the setup is finished. We need no credentials from the user here
// (Deliveroo auth lives in Render), so we complete immediately.
function completedWizardResponse(configItems = []) {
  return {
    Error: null,
    StepName: "UserConfig", // signals wizard complete
    AccountName: "Deliveroo",
    WizardStepTitle: "Deliveroo",
    WizardStepDescription: "Deliveroo integration connected.",
    GlobalConfigSettings: {},
    ConfigItems: configItems,
  };
}

// ----- Setup wizard: UserConfig -----
app.post("/linnworks/user-config", async (req, res) => {
  const token = getAuthToken(req.body);
  try {
    if (token) await db.getConfig(token); // touch (ensures row exists)
  } catch (_) {}
  res.json(completedWizardResponse());
});

// ----- Setup wizard: SaveConfig -----
app.post("/linnworks/save-config", async (req, res) => {
  const token = getAuthToken(req.body);
  const items = (req.body && req.body.ConfigItems) || [];
  try {
    if (token) await db.saveConfig(token, { ConfigItems: items });
  } catch (_) {}
  res.json(completedWizardResponse(items));
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
  const orders = (req.body && req.body.Orders) || [];
  res.json({
    Error: null,
    Orders: orders.map((o) => ({
      OrderId: o.OrderId || o.ReferenceNumber,
      Error: null,
    })),
  });
});

// ----- Cancel / Refund / PostSaleOptions: acknowledge -----
app.post("/linnworks/cancel", (req, res) => {
  console.log("[lw] Cancel request received.");
  res.json({ Error: null });
});
app.post("/linnworks/refund", (req, res) => {
  console.log("[lw] Refund request received.");
  res.json({ Error: null });
});
app.post("/linnworks/post-sale-options", (req, res) => {
  res.json({ Error: null, Options: [] });
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
