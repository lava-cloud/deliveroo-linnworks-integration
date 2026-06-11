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

// items = [{ itemId, available }] where itemId is the Deliveroo item id.
// Returns { staged: boolean, sent: number }.
async function updateAvailability(items) {
  if (!items.length) {
    return { staged: false, sent: 0 };
  }

  // If we don't yet have the Deliveroo IDs, stage the call (log only).
  if (!config.flags.deliverooStockReady) {
    console.log(
      "[deliveroo] STAGED (no Brand/Catalogue/Site IDs yet) — would update:",
      JSON.stringify(items, null, 2)
    );
    return { staged: true, sent: 0 };
  }

  const token = await getAccessToken();

  // Retail Catalogue API "unavailabilities" payload (unavailabilities-v1).
  // status is the string "available" / "unavailable" (NOT a boolean).
  // Items default to "available"; we only need to flag out-of-stock ones,
  // but we send both so availability is restored when stock returns.
  const payload = {
    version: "unavailabilities-v1",
    reset_all_item_availabilities: false,
    item_unavailabilities: items.map((it) => ({
      item_id: it.itemId,
      status: it.available === false ? "unavailable" : "available",
    })),
  };

  // Retail Catalogue API is PATCH /unavailabilities (synchronous), scoped by
  // brand/catalogue/site. Exact path to be confirmed with the Deliveroo TIM;
  // override via DELIV_UNAVAILABILITIES_URL if they give a different one.
  const url = config.deliverooUnavailabilitiesUrl
    ? config.deliverooUnavailabilitiesUrl
        .replace("{brand}", config.deliveroo.brandId)
        .replace("{catalogue}", config.deliveroo.catalogueId)
        .replace("{site}", config.deliveroo.siteId)
    : `${config.deliveroo.apiBase}/catalogue/v1/brands/${config.deliveroo.brandId}` +
      `/catalogues/${config.deliveroo.catalogueId}` +
      `/sites/${config.deliveroo.siteId}/unavailabilities`;

  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Deliveroo availability update failed (${response.status}): ${text}`
    );
  }

  console.log(`[deliveroo] Availability updated for ${items.length} item(s).`);
  return { staged: false, sent: items.length };
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
  sendOrderSyncStatus,
  listBrands,
  listSites,
  listMenus,
  setMenuItemUnavailability,
};
