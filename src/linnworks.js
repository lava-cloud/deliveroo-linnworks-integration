// ---------------------------------------------------------------------------
// linnworks.js
// Everything that talks to Linnworks via its own API:
//   1. getSession()           - logs in with your app credentials, CACHED.
//   2. getStockLevelsBySkus() - reads current stock for a list of SKUs.
//   3. createOrder()          - pushes a Deliveroo order into Linnworks.
//
// IMPORTANT: Linnworks is in maintenance as we build this, so the stock and
// order calls cannot be live-tested yet. They are written against Linnworks'
// documented endpoints and isolated here so they are easy to adjust the
// moment we can run a real test. Sections that need a live confirmation are
// marked with  >>> VERIFY WHEN LIVE.
// ---------------------------------------------------------------------------

const config = require("./config");

const AUTH_URL = "https://api.linnworks.net/api/Auth/AuthorizeByApplication";

// --- Session cache ---
// AuthorizeByApplication returns a session Token plus the Server base URL we
// must use for all later calls. We cache both and re-auth if a call gets 401.
let session = { token: null, server: null, obtainedAt: 0 };

async function getSession(force = false) {
  if (!config.flags.linnworksReady) {
    throw new Error(
      "Linnworks credentials not configured (LINNWORKS_APP_ID/SECRET/TOKEN)"
    );
  }

  // Reuse a session for up to ~50 minutes.
  const now = Date.now();
  if (!force && session.token && now - session.obtainedAt < 50 * 60_000) {
    return session;
  }

  const body = new URLSearchParams();
  body.append("ApplicationId", config.linnworks.appId);
  body.append("ApplicationSecret", config.linnworks.appSecret);
  body.append("Token", config.linnworks.appToken);

  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Linnworks auth failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  session = {
    token: data.Token,
    server: data.Server, // e.g. https://eu-ext.linnworks.net
    obtainedAt: now,
  };
  console.log(`[linnworks] Authorized. Server=${session.server}`);
  return session;
}

// Small helper: call a Linnworks endpoint, auto-retry once after re-auth on 401.
async function call(path, formParams) {
  let s = await getSession();
  const doFetch = async (sess) =>
    fetch(`${sess.server}${path}`, {
      method: "POST",
      headers: {
        Authorization: sess.token,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formParams,
    });

  let res = await doFetch(s);
  if (res.status === 401) {
    s = await getSession(true); // force re-auth
    res = await doFetch(s);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Linnworks ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// Returns a map { SKU: stockLevelNumber } for the given SKUs.
// >>> VERIFY WHEN LIVE: endpoint names/response shape confirmed against your
//     Linnworks account once maintenance ends.
async function getStockLevelsBySkus(skus) {
  if (!skus.length) return {};

  // Step 1: turn SKUs into Linnworks StockItemIds.
  const idParams = new URLSearchParams();
  idParams.append("request", JSON.stringify({ SKUS: skus }));
  const idResult = await call("/api/Inventory/GetStockItemIdsBySKU", idParams);
  // idResult expected like: [{ SKU: "ABC", StockItemId: "guid" }, ...]

  const result = {};
  for (const row of idResult || []) {
    // Step 2: read the stock level for each item.
    const lvlParams = new URLSearchParams();
    lvlParams.append("stockItemId", row.StockItemId);
    const levels = await call("/api/Stock/GetStockLevel", lvlParams);
    // levels expected like: [{ Location, StockLevel, Available, ... }]

    let available = 0;
    if (Array.isArray(levels)) {
      const match =
        levels.find(
          (l) => l.Location && l.Location.LocationName === config.linnworks.locationName
        ) || levels[0];
      if (match) {
        available = match.Available ?? match.StockLevel ?? 0;
      }
    }
    result[row.SKU] = available;
  }
  return result;
}

// Pushes one Deliveroo order into Linnworks as an order.
// >>> VERIFY WHEN LIVE: the exact create-order flow depends on your Linnworks
//     setup (Open Orders vs direct). This implements the documented
//     CreateNewOrder flow; we will finalise field mapping during the first
//     live test. Returns the Linnworks order id on success.
async function createOrder(structuredOrder) {
  // Placeholder for the live build. Kept isolated so wiring it up later does
  // not touch the rest of the app. For now it throws so callers record the
  // order as "pending" (safely stored in the DB) instead of losing it.
  throw new Error(
    "createOrder not yet finalised — awaiting live Linnworks access to confirm order schema"
  );
}

module.exports = { getSession, getStockLevelsBySkus, createOrder };
