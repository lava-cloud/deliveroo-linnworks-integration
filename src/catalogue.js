// ---------------------------------------------------------------------------
// catalogue.js
// Retail Catalogue API calls used for the sandbox certification scenarios and,
// later, production catalogue/stock sync.
//
// Exact endpoint paths can be overridden by env vars (see config) because the
// sandbox validator is the source of truth — we iterate against it. All calls
// log full responses so we can debug each scenario.
// ---------------------------------------------------------------------------

const config = require("./config");
const deliveroo = require("./deliveroo");

function apiBase() {
  return config.deliveroo.apiBase;
}

async function authedFetch(method, path, body) {
  const token = await deliveroo.getAccessToken();
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

// Scenario 1: GET Site Brand ID using site location id.
async function getSiteBrandId(siteLocationId) {
  const path =
    (process.env.DELIV_SITE_BRAND_PATH || "/site/v1/restaurant_locations/{site}").replace(
      "{site}",
      siteLocationId
    );
  return authedFetch("GET", path);
}

// Scenario 2: POST catalogue upload → { upload_url, upload_id }
async function createUpload(brandId) {
  const path = `/brands/${brandId}/catalogue/uploads`;
  return authedFetch("POST", path, {});
}

// GET the processed catalogue — confirms whether the upload was accepted.
async function getCatalogue(brandId, catalogueId) {
  return authedFetch("GET", `/brands/${brandId}/catalogue/${catalogueId}`);
}

// Track upload progress / get processing result + errors by upload_id.
async function getUploadStatus(brandId, uploadId) {
  const path = `/brands/${brandId}/catalogue/uploads/${uploadId}`;
  return authedFetch("GET", path);
}

// Scenario 3: PUT the catalogue JSON to the presigned upload_url (NO auth).
async function uploadCatalogueJson(uploadUrl, catalogueJson) {
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(catalogueJson),
  });
  const text = await res.text();
  return { status: res.status, body: text };
}

// Scenario 4: PATCH update listings for a site.
async function updateListings(brandId, catalogueId, siteId, itemIds) {
  const path = `/brands/${brandId}/catalogue/${catalogueId}/listings`;
  return authedFetch("PATCH", path, {
    version: "catalogue-listing-v1",
    site_ids: [String(siteId)],
    listed_items: itemIds.map((id) => ({ id })),
  });
}

// Scenario 6 / production stock: PATCH unavailabilities.
async function updateUnavailabilities(brandId, catalogueId, siteId, items) {
  const path = `/brands/${brandId}/catalogue/${catalogueId}/sites/${siteId}/unavailabilities`;
  return authedFetch("PATCH", path, {
    version: "unavailabilities-v1",
    reset_all_item_availabilities: false,
    item_unavailabilities: items.map((it) => ({
      item_id: it.itemId,
      status: it.available === false ? "unavailable" : "available",
    })),
  });
}

// Build a sample master catalogue that satisfies the sandbox test spec:
// ≥6 items (2 sellable + 2 single-select modifiers + 2 multi-select modifiers),
// barcodes on all, items in 2 merchandise_collections, a hero_image,
// experience "aisles", version "catalogue-upload-v1".
function sampleCatalogue(catalogueId) {
  const img = "https://deliveroo-linnworks-integration.onrender.com/img1920.png";
  const L = (en) => ({ en }); // Deliveroo uses language-keyed objects

  // Namespace all IDs/barcodes by the catalogue id so each upload is UNIQUE
  // (rules out "file already uploaded" duplicate rejection).
  const token = (catalogueId.replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "x");
  let seed = 0;
  for (const ch of token) seed = (seed * 31 + ch.charCodeAt(0)) % 100000;
  const iid = (n) => `it_${token}_${n}`;
  const gid = (n) => `grp_${token}_${n}`;
  const barcode = (n) => ("50" + String(seed).padStart(5, "0") + String(n).padStart(6, "0")).slice(0, 13);

  const item = (id, name, plu, bc, price, extra = {}) => ({
    id,
    plu,
    barcodes: [bc],
    name: L(name),
    operational_name: L(name),
    description: L(`${name} - sample product for sandbox certification`),
    media: [{ media_type: "main_image", media_url: img }],
    price_info: { price },
    tax_rate: "20.0",
    is_eligible_as_replacement: true,
    is_eligible_for_substitution: true,
    is_returnable: false,
    age_restricted: false,
    allergies: ["no_allergens"],
    diets: [],
    country_of_origin: ["Great Britain"],
    temperature_zone: "ambient",
    ...extra,
  });

  const i1 = iid(1), i2 = iid(2);
  const ms = iid("ms"), ml = iid("ml"), e1 = iid("e1"), e2 = iid("e2");
  const gSize = gid("size"), gExtras = gid("extras");
  const withMods = { modifier_ids: [gSize, gExtras] };

  return {
    version: "catalogue-upload-v1",
    catalogue: {
      id: catalogueId,
      items: [
        item(i1, "Lava Sample Product One", `${token}-1`, barcode(1), 199, withMods),
        item(i2, "Lava Sample Product Two", `${token}-2`, barcode(2), 299, withMods),
        item(ms, "Small", `${token}-ms`, barcode(3), 0),
        item(ml, "Large", `${token}-ml`, barcode(4), 50),
        item(e1, "Extra A", `${token}-e1`, barcode(5), 30),
        item(e2, "Extra B", `${token}-e2`, barcode(6), 30),
      ],
      hero_image: { url: img },
      experience: "aisles",
      merchandise_collections: {
        item_categories: [
          { id: gid("featured"), name: L("Featured"), description: L("Featured items"), item_ids: [i1, i2] },
          { id: gid("all"), name: L("All Products"), description: L("All items"), item_ids: [i1, i2] },
        ],
      },
      modifiers: [
        { id: gSize, name: L("Size"), min_selection: 1, max_selection: 1, item_ids: [ms, ml] },
        { id: gExtras, name: L("Extras"), min_selection: 0, max_selection: 2, item_ids: [e1, e2] },
      ],
    },
  };
}

module.exports = {
  getSiteBrandId,
  createUpload,
  getCatalogue,
  getUploadStatus,
  uploadCatalogueJson,
  updateListings,
  updateUnavailabilities,
  sampleCatalogue,
};
