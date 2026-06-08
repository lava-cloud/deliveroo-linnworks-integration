// ---------------------------------------------------------------------------
// config.js
// Single place that reads all environment variables.
// Nothing secret is hard-coded here — real values live in Render's
// "Environment" settings. This file just gives them sensible names and
// defaults, and tells the rest of the app which features are "ready".
// ---------------------------------------------------------------------------

const config = {
  // Which Deliveroo environment to talk to: "sandbox" (default) or "production".
  deliverooEnv: process.env.DELIV_ENV || "sandbox",

  // Deliveroo OAuth app credentials (set these in Render).
  deliveroo: {
    clientId: process.env.DELIV_CLIENT_ID || "",
    clientSecret: process.env.DELIV_CLIENT_SECRET || "",

    // These three come from Deliveroo's POS/Integrator onboarding (TIM).
    // Until they exist, stock-sync is "staged" — it logs what it WOULD do
    // instead of making a real call. The moment you paste them into Render,
    // real stock updates start working with no code change.
    brandId: process.env.DELIV_BRAND_ID || "",
    catalogueId: process.env.DELIV_CATALOGUE_ID || "",
    siteId: process.env.DELIV_SITE_ID || "",

    // Optional extras you already have (not required for stock sync).
    adminId: process.env.DELIV_ADMIN_ID || "",
    companyId: process.env.DELIV_COMPANY_ID || "",
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

  // Optional: full override for the Retail Catalogue "unavailabilities" URL.
  // Use {brand}, {catalogue}, {site} placeholders. If blank we build a
  // sensible default — confirm the exact path with your Deliveroo TIM.
  deliverooUnavailabilitiesUrl: process.env.DELIV_UNAVAILABILITIES_URL || "",

  // How often (minutes) to auto-run stock sync. 0 = off (manual only).
  stockSyncIntervalMinutes: Number(process.env.STOCK_SYNC_INTERVAL_MINUTES || 0),

  port: process.env.PORT || 3000,
};

// Derived Deliveroo host names based on the chosen environment.
const isProd = config.deliverooEnv === "production";
config.deliveroo.authUrl = isProd
  ? "https://auth.developers.deliveroo.com/oauth2/token"
  : "https://auth-sandbox.developers.deliveroo.com/oauth2/token";
config.deliveroo.apiBase = isProd
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
      config.deliveroo.catalogueId &&
      config.deliveroo.siteId
  ),
  linnworksReady: Boolean(
    config.linnworks.appId &&
      config.linnworks.appSecret &&
      config.linnworks.appToken
  ),
  databaseReady: Boolean(config.databaseUrl),
};

module.exports = config;
