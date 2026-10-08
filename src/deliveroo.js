// ---------------------------------------------------------------------------
// deliveroo.js
// Everything that talks to Deliveroo:
//   1. getAccessToken()  - OAuth token, CACHED so we don't re-auth every call
//                          (Deliveroo tokens expire after ~300s).
//   2. updateAvailability() - pushes stock availability to Deliveroo.
//                          This is "staged": until you have Brand/Catalogue/
//                          Site IDs from Deliveroo, it logs what it WOULD send
//                          instead of calling the real endpoint.
// ---------------------------------------------------------------------------

const config = require("./config");

// --- Token cache ---
let cachedToken = null;
let cachedTokenExpiresAt = 0; // epoch ms

async function getAccessToken() {
  if (!config.flags.deliverooAuthReady) {
    throw new Error("Deliveroo credentials not configured (DELIV_CLIENT_ID/SECRET)");
  }

  // Reuse the cached token if it still has > 30 seconds of life left.
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt - 30_000) {
    return cachedToken;
  }

  const params = new URLSearchParams();
  params.append("grant_type", "client_credentials");
  params.append("client_id", config.deliveroo.clientId);
  params.append("client_secret", config.deliveroo.clientSecret);

  const response = await fetch(config.deliveroo.authUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Deliveroo auth failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  cachedTokenExpiresAt = now + (data.expires_in || 300) * 1000;
  console.log(
    `[deliveroo] Got access token (expires in ${data.expires_in}s, env=${config.deliverooEnv})`
  );
  return cachedToken;
}

// --- Stock: Menu API v2, addressed by site --------------------------------
// The live shop's menu is built in Catalogue Manager, which the v2 site
// endpoints serve without needing a catalogue id. Deliveroo rejects a whole
// request if any item id is not on the menu, so ids are checked first.
const MENU_CACHE_MS = 15 * 60 * 1000;
const MENU_FORCE_REFRESH_MS = 5 * 60 * 1000;
let menuCache = { at: 0, ids: null };
const desiredStatus = new Map(); // itemId -> last status we set

const siteMenuPath = (brandId = config.deliveroo.brandId, siteId = config.deliveroo.siteId) =>
  `/menu/v2/brands/${brandId}/sites/${siteId}/menu`;

async function getSiteMenu(brandId, siteId) {
  return apiGet(siteMenuPath(brandId, siteId));
}

async function getSiteUnavailabilities(brandId, siteId) {
  return apiGet(`${siteMenuPath(brandId, siteId)}/item_unavailabilities`);
}

async function menuItemIds(force = false) {
  const age = Date.now() - menuCache.at;
  if (menuCache.ids && (age < MENU_FORCE_REFRESH_MS || (!force && age < MENU_CACHE_MS))) {
    return menuCache.ids;
  }
  const { status, body } = await getSiteMenu();
  if (status !== 200) {
    throw new Error(`Menu fetch failed (${status}): ${JSON.stringify(body).slice(0, 200)}`);
  }
  menuCache = { at: Date.now(), ids: new Set(((body.menu && body.menu.items) || []).map((i) => i.id)) };
  return menuCache.ids;
}

async function postUnavailabilities(entries) {
  const token = await getAccessToken();
  const res = await fetch(`${config.deliveroo.apiBase}${siteMenuPath()}/item_unavailabilities`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ item_unavailabilities: entries }),
  });
  if (!res.ok) {
    throw new Error(`Deliveroo availability update failed (${res.status}): ${await res.text()}`);
  }
}

// items = [{ itemId, available }] where itemId is the Deliveroo item id.
// Returns { staged, sent, skipped }.
async function updateAvailability(items) {
  if (!items.length) {
    return { staged: false, sent: 0, skipped: 0 };
  }
  const entries = items.map((it) => ({
    item_id: it.itemId,
    status: it.available === false ? config.outOfStockStatus : "available",
  }));

  if (!config.flags.stockSyncLive) {
    console.log("[deliveroo] STAGED (stock sync not live) — would update:", JSON.stringify(entries));
    return { staged: true, sent: 0, skipped: 0 };
  }

  let known = await menuItemIds();
  if (entries.some((e) => !known.has(e.item_id))) known = await menuItemIds(true);
  const valid = entries.filter((e) => known.has(e.item_id));
  const skipped = entries.length - valid.length;
  if (skipped) console.log(`[deliveroo] Skipping ${skipped} item id(s) not on the live menu`);
  if (!valid.length) return { staged: false, sent: 0, skipped };

  await postUnavailabilities(valid);
  for (const e of valid) desiredStatus.set(e.item_id, e.status);
  console.log(`[deliveroo] Availability updated for ${valid.length} item(s).`);
  return { staged: false, sent: valid.length, skipped };
}

// Deliveroo's morning stock reset makes "unavailable" items orderable again,
// so re-send any we marked unavailable that are no longer flagged.
async function reapplyUnavailable() {
  if (!config.flags.stockSyncLive) return 0;
  const want = [...desiredStatus].filter(([, s]) => s === "unavailable").map(([id]) => id);
  if (!want.length) return 0;
  const { status, body } = await getSiteUnavailabilities();
  if (status !== 200) throw new Error(`Unavailabilities fetch failed (${status})`);
  const current = new Set(body.unavailable_ids || []);
  const missing = want.filter((id) => !current.has(id));
  if (missing.length) {
    await postUnavailabilities(missing.map((id) => ({ item_id: id, status: "unavailable" })));
  }
  return missing.length;
}

// Send POS "sync status" to confirm we ingested an order (Orders API).
// POST /order/v1/orders/{id}/sync_status  { occurred_at, status, reason, notes }
async function sendOrderSyncStatus(orderId, status = "succeeded", reason = "", notes = "") {
  const token = await getAccessToken();
  const url = `${config.deliveroo.apiBase}/order/v1/orders/${encodeURIComponent(
    orderId
  )}/sync_status`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      occurred_at: new Date().toISOString(),
      status,
      reason,
      notes,
    }),
  });
  const text = await res.text();
  console.log(`[orders] sync_status ${status} for ${orderId} -> ${res.status} ${text}`);
  return { status: res.status, body: text };
}

// --- Discovery helpers -----------------------------------------------------
// Once the API is connected, these let us read your brand_id and sites
// straight from Deliveroo (so we don't need them handed over manually).
async function apiGet(path) {
  const token = await getAccessToken();
  const res = await fetch(`${config.deliveroo.apiBase}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (_) {
    body = text;
  }
  return { status: res.status, body };
}

// GET /site/v1/brands → your brand(s), including brand_id
async function listBrands() {
  return apiGet("/site/v1/brands");
}

// GET /site/v1/brands/{brandId}/sites → sites under a brand (confirms site_id)
async function listSites(brandId) {
  return apiGet(`/site/v1/brands/${brandId}/sites`);
}

// GET /menu/v1/brands/{brandId}/menus → menus (sandbox restaurant sites)
async function listMenus(brandId) {
  return apiGet(`/menu/v1/brands/${brandId}/menus`);
}

// Toggle one menu item's availability via the restaurant Menu API (sandbox test).
// POST /menu/v1/brands/{brandId}/menus/{menuId}/item_unavailabilities/{siteId}
async function setMenuItemUnavailability(brandId, menuId, siteId, itemId, unavailable) {
  const token = await getAccessToken();
  const url = `${config.deliveroo.apiBase}/menu/v1/brands/${brandId}/menus/${menuId}/item_unavailabilities/${siteId}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ unavailable_ids: unavailable ? [itemId] : [] }),
  });
  const text = await res.text();
  return { status: res.status, body: text };
}

module.exports = {
  getAccessToken,
  updateAvailability,
  reapplyUnavailable,
  getSiteMenu,
  getSiteUnavailabilities,
  sendOrderSyncStatus,
  listBrands,
  listSites,
  listMenus,
  setMenuItemUnavailability,
};
