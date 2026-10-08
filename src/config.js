// ---------------------------------------------------------------------------
// config.js
// Single place that reads all environment variables.
// Nothing secret is hard-coded here — real values live in Render's
// "Environment" settings. This file just gives them sensible names and
// defaults, and tells the rest of the app which features are "ready".
// ---------------------------------------------------------------------------

const isProduction = (process.env.DELIV_ENV || "sandbox") === "production";

const config = {
  // Which Deliveroo environment to talk to: "sandbox" (default) or "production".
  deliverooEnv: process.env.DELIV_ENV || "sandbox",

  // Deliveroo OAuth app credentials (set these in Render).
  deliveroo: {
    clientId: process.env.DELIV_CLIENT_ID || "",
    clientSecret: process.env.DELIV_CLIENT_SECRET || "",

    // Lava Wholesale's production brand and live site; env vars override.
    brandId: process.env.DELIV_BRAND_ID || (isProduction ? "lava-wholesale-gb" : ""),
    catalogueId: process.env.DELIV_CATALOGUE_ID || "",
    siteId: process.env.DELIV_SITE_ID || (isProduction ? "755952" : ""),

    // Optional extras you already have (not required for stock sync).
    adminId: process.env.DELIV_ADMIN_ID || "",
    companyId: process.env.DELIV_COMPANY_ID || "",

    // Webhook secret (Dev Portal -> Webhooks -> Webhook secrets -> production).
    // With it set, every webhook's signature is checked and counted; bad ones
    // are only rejected once DELIV_WEBHOOK_ENFORCE=true.
    webhookSecret: process.env.DELIV_WEBHOOK_SECRET || "",
    webhookEnforce: process.env.DELIV_WEBHOOK_ENFORCE === "true",
  },

  // Linnworks application credentials (set these in Render once maintenance ends).
  linnworks: {
    appId: process.env.LINNWORKS_APP_ID || "",
    appSecret: process.env.LINNWORKS_APP_SECRET || "",
    appToken: process.env.LINNWORKS_APP_TOKEN || "",
    // Name of the stock location in Linnworks to read levels from.
    locationName: process.env.LINNWORKS_LOCATION_NAME || "Default",
  },

  // Postgres connection string from Render (the database we add).
  databaseUrl: process.env.DATABASE_URL || "",

  // A simple shared secret so only YOU can trigger a manual stock sync.
  // Set SYNC_SECRET in Render to any random string.
  syncSecret: process.env.SYNC_SECRET || "",

  // How often (minutes) to auto-run stock sync. 0 = off (manual only).
  stockSyncIntervalMinutes: Number(process.env.STOCK_SYNC_INTERVAL_MINUTES || 0),

  port: process.env.PORT || 3000,
};

// Derived Deliveroo host names based on the chosen environment.
config.deliveroo.authUrl = isProduction
  ? "https://auth.developers.deliveroo.com/oauth2/token"
  : "https://auth-sandbox.developers.deliveroo.com/oauth2/token";
config.deliveroo.apiBase = isProduction
  ? "https://api.developers.deliveroo.com"
  : "https://api-sandbox.developers.deliveroo.com";

// Helper flags the rest of the app uses to decide what's "ready".
config.flags = {
  deliverooAuthReady: Boolean(
    config.deliveroo.clientId && config.deliveroo.clientSecret
  ),
  deliverooStockReady: Boolean(
    config.deliveroo.clientId &&
      config.deliveroo.clientSecret &&
      config.deliveroo.brandId &&
      config.deliveroo.siteId
  ),
  linnworksReady: Boolean(
    config.linnworks.appId &&
      config.linnworks.appSecret &&
      config.linnworks.appToken
  ),
  databaseReady: Boolean(config.databaseUrl),
};

// Stock changes touch the live shop. Production defaults to live; set
// DELIV_STOCK_SYNC=off to stop them (updates are then logged only).
const stockSync = process.env.DELIV_STOCK_SYNC || (isProduction ? "live" : "off");
config.flags.stockSyncLive = config.flags.deliverooStockReady && stockSync === "live";

// "hidden" survives Deliveroo's morning stock reset; "unavailable" (greyed
// out as sold out) is cleared by it and has to be re-applied.
config.outOfStockStatus =
  process.env.DELIV_OUT_OF_STOCK_STATUS === "unavailable" ? "unavailable" : "hidden";

module.exports = config;
