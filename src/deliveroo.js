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

  // Deliveroo "item unavailabilities" payload.
  // NOTE: confirm exact shape with your TIM before production; this matches
  // the documented unavailabilities-v1 format.
  const payload = {
    version: "unavailabilities-v1",
    reset_all_item_availabilities: false,
    item_unavailabilities: items.map((it) => ({
      item_id: it.itemId,
      unavailable: it.available === false,
    })),
  };

  const url =
    `${config.deliveroo.apiBase}/brands/${config.deliveroo.brandId}` +
    `/catalogue/${config.deliveroo.catalogueId}` +
    `/item_unavailabilities/${config.deliveroo.siteId}`;

  const response = await fetch(url, {
    method: "PUT",
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

module.exports = { getAccessToken, updateAvailability };
