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
  const hero = "https://deliveroo-linnworks-integration.onrender.com/logo.png";
  const img = (n) => `https://deliveroo-linnworks-integration.onrender.com/logo.png?i=${n}`;

  const modifierItem = (id, name, plu, barcode) => ({
    id,
    name,
    operational_name: name,
    plu,
    barcodes: [barcode],
    description: `${name} modifier option`,
    type: "MODIFIER",
    media: [{ type: "main_image", url: img(id) }],
    price_info: { price: 50 },
    tax_rate: 0.0,
  });

  const sellableItem = (id, name, plu, barcode, price) => ({
    id,
    name,
    operational_name: name,
    plu,
    barcodes: [barcode],
    description: `${name} - sample sellable product for sandbox certification`,
    type: "ITEM",
    media: [{ type: "main_image", url: img(id) }],
    price_info: { price },
    tax_rate: 0.0,
    is_eligible_for_substitution: false,
    allergens: ["no_allergens"],
    modifier_groups: [
      {
        id: `${id}_size`,
        name: "Size (choose one)",
        min_selection: 1,
        max_selection: 1,
        item_ids: ["mod_size_s", "mod_size_l"],
      },
      {
        id: `${id}_extras`,
        name: "Extras (choose any)",
        min_selection: 0,
        max_selection: 2,
        item_ids: ["mod_extra_1", "mod_extra_2"],
      },
    ],
  });

  return {
    version: "catalogue-upload-v1",
    id: catalogueId,
    experience: "aisles",
    hero_image: { url: hero },
    items: [
      sellableItem("item_lava_1", "Lava Sample Product One", "1200206", "5060000000017", 199),
      sellableItem("item_lava_2", "Lava Sample Product Two", "1200207", "5060000000024", 299),
      modifierItem("mod_size_s", "Small", "MOD0001", "5060000000031"),
      modifierItem("mod_size_l", "Large", "MOD0002", "5060000000048"),
      modifierItem("mod_extra_1", "Extra A", "MOD0003", "5060000000055"),
      modifierItem("mod_extra_2", "Extra B", "MOD0004", "5060000000062"),
    ],
    merchandise_collections: [
      {
        id: "coll_featured",
        name: "Featured",
        description: "Featured sample items",
        item_ids: ["item_lava_1", "item_lava_2"],
      },
      {
        id: "coll_all",
        name: "All Products",
        description: "All sample items",
        item_ids: ["item_lava_1", "item_lava_2"],
      },
    ],
  };
}

module.exports = {
  getSiteBrandId,
  createUpload,
  getUploadStatus,
  uploadCatalogueJson,
  updateListings,
  updateUnavailabilities,
  sampleCatalogue,
};
