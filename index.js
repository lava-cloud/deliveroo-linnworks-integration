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
// { "<Linnworks SKU>": "<Deliveroo item id>" | ["<item id>", ...] } — a SKU can
// cover duplicate Deliveroo listings. Only item ids listed here are ever
// changed on Deliveroo.
const skuMap = Object.fromEntries(
  Object.entries(require(process.env.SKU_MAP_PATH || "./sku-map.json")).map(([sku, ids]) => [
    sku,
    [].concat(ids),
  ])
);
// Products deleted from the shop in the catalogue review:
// [{ item_id, sku, title, retired_on }]. They stay hidden on Deliveroo and are
// dropped from the SKU map, so stock sync never shows them again.
let retiredItems = [];
try {
  retiredItems = require(process.env.RETIRED_ITEMS_PATH || "./retired-items.json");
} catch (_) {}
const retiredIds = new Set(retiredItems.map((r) => r.item_id));
for (const [sku, ids] of Object.entries(skuMap)) {
  const kept = ids.filter((id) => !retiredIds.has(id));
  if (kept.length) skuMap[sku] = kept;
  else delete skuMap[sku];
}
deliveroo.setRetired(retiredIds);
const mappedItemIds = new Set(Object.values(skuMap).flat());
// Deliveroo product title per SKU, shown as the channel title in Linnworks.
let skuTitles = {};
try {
  skuTitles = require(process.env.SKU_TITLES_PATH || "./sku-titles.json");
} catch (_) {}
// Last quantity Linnworks sent per SKU. Linnworks compares it with what it last
// submitted on every Products call and re-sends stock when they differ.
const lastQuantity = new Map();

// In-memory state for the sandbox catalogue scenarios.
const catState = { uploadUrl: null, uploadId: null, catalogueId: null, lastWebhook: null };
// Orders API state: track synced orders + last sync result for debugging.
const syncedOrders = new Set();
let lastSync = null;
const recentEvents = []; // every order webhook call (not deduped), for debugging
const lwCalls = {}; // per Linnworks endpoint: { count, lastAt, tokens: { first 6 chars: n } }
const STARTED_AT = new Date().toISOString();

// Contract clause 2.4: Deliveroo order data must be deleted within 48 hours.
const ORDER_RETENTION_HOURS = 48;

// Render's free plan spins the service down after 15 idle minutes, and the
// ~25s cold start outlasts Deliveroo's webhook timeout, so we ping our own
// public URL to stay awake. KEEP_ALIVE=false turns it off (e.g. on a paid plan).
const keepAliveUrl =
  process.env.KEEP_ALIVE === "false"
    ? null
    : process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL || null;

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

// Strict PLU checks (unknown/mismatch) are for the sandbox certification
// scenarios. In PRODUCTION they must be OFF by default, or we'd wrongly reject
// real orders whose PLUs aren't in the sandbox list. Default: on in sandbox,
// off in production. Override with DELIV_STRICT_PLU=true/false.
const STRICT_PLU =
  (process.env.DELIV_STRICT_PLU || (config.deliverooEnv === "sandbox" ? "true" : "false")) ===
  "true";

// Decide the sync status for an order based on its PLUs.
function syncDecision(order) {
  const lines = orderLines(order);
  // Missing PLU — always a real problem (can't fulfil an unidentified item).
  if (lines.some((l) => !l.plu || String(l.plu).trim() === "")) {
    return { status: "failed", reason: "pos_item_id_not_found", notes: "Order contains an item with no PLU" };
  }
  if (STRICT_PLU) {
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
  }
  return { status: "succeeded", reason: "", notes: "" };
}
// Sandbox brand id (discovered via GET site brand id). Override with DELIV_BRAND_ID.
const SANDBOX_BRAND = "17b449e6-43f8-4dec-adf9-10240a5138a1";
const brandIdFor = (req) =>
  (req.body && req.body.brandId) || config.deliveroo.brandId || SANDBOX_BRAND;

const app = express();
// Keep the raw bytes: Deliveroo's webhook signature is over the body exactly as sent.
app.use(express.json({ limit: "2mb", verify: (req, res, buf) => (req.rawBody = buf) }));

// Deliveroo signs each webhook with a hex HMAC-SHA256 of
// "<X-Deliveroo-Sequence-Guid> <raw body>" (legacy POS events use " \n ").
const webhookSignatures = {};
function checkDeliverooSignature(req) {
  const secret = config.deliveroo.webhookSecret;
  let result = "unchecked";
  if (secret) {
    const guid = req.get("x-deliveroo-sequence-guid") || "";
    const sig = (req.get("x-deliveroo-hmac-sha256") || "").trim().toLowerCase();
    result = "missing";
    if (guid && sig) {
      result = "invalid";
      for (const sep of [" ", " \n "]) {
        const mac = crypto
          .createHmac("sha256", secret)
          .update(Buffer.concat([Buffer.from(guid + sep), req.rawBody || Buffer.alloc(0)]))
          .digest("hex");
        if (mac.length === sig.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(sig))) {
          result = "valid";
          break;
        }
      }
    }
  }
  webhookSignatures[result] = (webhookSignatures[result] || 0) + 1;
  if (result === "missing" || result === "invalid") {
    console.warn(`[webhook] ${result} signature on ${req.path}`);
  }
  return result === "valid" || result === "unchecked" || !config.deliveroo.webhookEnforce;
}

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
      deliverooStock: config.flags.stockSyncLive
        ? `Live (out of stock = ${config.outOfStockStatus})`
        : config.flags.deliverooStockReady
          ? "Staged — DELIV_STOCK_SYNC is off"
          : "Staged — no brand/site configured",
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
    res.json({
      ok: true,
      ...(await db.counts()),
      startedAt: STARTED_AT,
      uptimeMinutes: Math.round(process.uptime() / 60),
      keepAlive: keepAliveUrl || "off",
      ready: config.flags,
      mappedSkus: Object.keys(skuMap).length,
      mappedItems: mappedItemIds.size,
      retiredItems: retiredIds.size,
      webhookSignatures: {
        secretSet: Boolean(config.deliveroo.webhookSecret),
        enforce: config.deliveroo.webhookEnforce,
        ...webhookSignatures,
      },
      linnworksCalls: lwCalls,
    });
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
  if (!checkDeliverooSignature(req)) return res.status(401).send("Bad signature");
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
    const json = catalogue.sampleCatalogue(
      catalogueId,
      req.body && req.body.nonce,
      req.body && req.body.modifierType
    );
    const withAuth = !!(req.body && req.body.withAuth === true);
    const gzip = !!(req.body && req.body.gzip === true);
    const r = await catalogue.uploadCatalogueJson(catState.uploadUrl, json, withAuth, gzip);
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
  // Default to the actual item ids in our generated catalogue for this id.
  let itemIds = req.body && req.body.itemIds;
  if (!itemIds) {
    const sample = catalogue.sampleCatalogue(catalogueId);
    itemIds = ((sample.catalogue && sample.catalogue.items) || []).map((i) => i.id);
  }
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

// Generic catalogue API probe. Body: { method, path, body }
app.post("/debug/cat/raw", async (req, res) => {
  if (!requireSecret(req, res)) return;
  const { method, path, body } = req.body || {};
  try {
    res.json(await catalogue.raw(method || "GET", path, body));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Show the most recent Deliveroo orders we've received (raw payloads), with
// their latest status and whether they've been released to Linnworks.
app.get("/debug/orders", async (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    const rows = await db.recentOrders(20);
    res.json({
      count: rows.length,
      orders: rows.map((r) => ({
        order_id: r.order_id,
        received_at: r.received_at,
        status: r.status,
        accepted_at: r.accepted_at,
        raw: r.raw,
      })),
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

// Read-only: how much of sku-map.json points at items on the live menu, plus
// the menu's current unavailable/hidden items. Query: ?brandId=&siteId=
app.get("/debug/menu/check", async (req, res) => {
  if (!requireSecret(req, res)) return;
  const brandId = req.query.brandId || config.deliveroo.brandId;
  const siteId = req.query.siteId || config.deliveroo.siteId;
  if (!brandId || !siteId) return res.status(400).json({ error: "Pass ?brandId=&siteId=" });
  try {
    const menu = await deliveroo.getSiteMenu(brandId, siteId);
    if (menu.status !== 200) return res.json({ menuStatus: menu.status, body: menu.body });
    const items = (menu.body.menu && menu.body.menu.items) || [];
    const ids = new Set(items.map((i) => i.id));
    const missing = Object.entries(skuMap).flatMap(([sku, list]) =>
      list.filter((id) => !ids.has(id)).map((id) => ({ sku, id }))
    );
    const unav = await deliveroo.getSiteUnavailabilities(brandId, siteId);
    res.json({
      menuName: menu.body.name,
      menuItems: items.length,
      sellableItems: items.filter((i) => i.type === "ITEM").length,
      skuMapSkus: Object.keys(skuMap).length,
      skuMapItems: mappedItemIds.size,
      skuMapItemsOnMenu: mappedItemIds.size - missing.length,
      skuMapNotOnMenu: missing.slice(0, 20),
      itemsWithPlu: items.filter((i) => i.plu).length,
      unavailabilities: unav.body,
      stockSync: { live: config.flags.stockSyncLive, outOfStockStatus: config.outOfStockStatus },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Retired (deleted) items and whether each is hidden on the live menu now.
app.get("/debug/menu/retired", async (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    const unav = await deliveroo.getSiteUnavailabilities();
    const hidden = new Set((unav.body && unav.body.hidden_ids) || []);
    res.json({
      count: retiredItems.length,
      items: retiredItems.map((r) => ({ ...r, hiddenNow: hidden.has(r.item_id) })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Hide retired items now (also runs at startup and hourly).
app.post("/debug/menu/hide-retired", async (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    res.json(await deliveroo.hideRetired());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Emergency undo: make every hidden/unavailable item on the live menu
// orderable, except retired (deleted) items.
app.post("/debug/menu/restore-all", async (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    res.json(await deliveroo.restoreAll());
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
  if (!checkDeliverooSignature(req)) return res.status(401).send("Bad signature");
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
    await db.saveOrder(orderId, raw, status);
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

app.use("/linnworks", (req, res, next) => {
  const s = (lwCalls[req.path] = lwCalls[req.path] || { count: 0, lastAt: null, tokens: {} });
  const token = getAuthToken(req.body);
  const fp = token ? String(token).slice(0, 6) : "(none)";
  s.count++;
  s.lastAt = new Date().toISOString();
  s.tokens[fp] = (s.tokens[fp] || 0) + 1;
  next();
});

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
// Request: { AuthorizationToken, PageNumber }  Response: { Error, HasMorePages, Products }
app.post("/linnworks/products", (req, res) => {
  const page = Number((req.body && req.body.PageNumber) || 1);
  const Products =
    page > 1
      ? []
      : Object.keys(skuMap).map((sku) => ({
          SKU: sku,
          Title: skuTitles[sku] || sku,
          Quantity: lastQuantity.get(sku) ?? 0,
          Reference: skuMap[sku][0],
        }));
  res.json({ Error: null, HasMorePages: false, Products });
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

  // A SKU in sku-map.json can cover several Deliveroo listings. A Reference is
  // only trusted if it is one of the mapped item ids.
  const items = [];
  const perProduct = [];
  let unmapped = 0;
  for (const p of products) {
    const sku = p.SKU;
    const qty = Number(p.Quantity ?? 0);
    const ids = skuMap[sku] || (mappedItemIds.has(p.Reference) ? [p.Reference] : []);
    if (!ids.length) unmapped++;
    for (const itemId of ids) items.push({ itemId, sku, available: qty > 0, stockLevel: qty });
    perProduct.push({ SKU: sku, Error: null });
  }

  try {
    const result = await deliveroo.updateAvailability(items);
    for (const p of products) lastQuantity.set(p.SKU, Number(p.Quantity ?? 0));
    console.log(
      `[lw] InventoryUpdate: ${products.length} product(s), ${unmapped} unmapped, ` +
        (result.staged ? "STAGED" : `${result.sent} sent, ${result.skipped} not on menu`)
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

  if (keepAliveUrl) {
    setInterval(() => {
      fetch(`${keepAliveUrl}/`, { signal: AbortSignal.timeout(30000) }).catch((e) =>
        console.error("[keep-alive] ping failed:", e.message)
      );
    }, 10 * 60 * 1000);
    console.log(`[keep-alive] pinging ${keepAliveUrl}/ every 10 minutes`);
  }

  const purge = () =>
    db
      .purgeOrdersOlderThan(ORDER_RETENTION_HOURS)
      .then((n) => n && console.log(`[purge] deleted ${n} order(s) older than ${ORDER_RETENTION_HOURS}h`))
      .catch((e) => console.error("[purge] failed:", e.message));
  purge();
  setInterval(purge, 60 * 60 * 1000);

  const hideRetired = () =>
    deliveroo
      .hideRetired()
      .then((r) => r.hidden && console.log(`[stock] hid ${r.hidden} retired item(s)`))
      .catch((e) => console.error("[stock] hiding retired items failed:", e.message));
  hideRetired();

  setInterval(() => {
    deliveroo
      .reapplyUnavailable()
      .then((n) => n && console.log(`[stock] re-applied ${n} unavailable item(s) after reset`))
      .catch((e) => console.error("[stock] re-apply failed:", e.message));
    hideRetired();
  }, 60 * 60 * 1000);
}

start().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
