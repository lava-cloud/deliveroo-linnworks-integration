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

  const baseItem = (id, name, plu, barcode, price) => ({
    id,
    plu,
    barcodes: [barcode],
    name: L(name),
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
  });

  return {
    version: "catalogue-upload-v1",
    catalogue: {
      id: catalogueId,
      items: [
        baseItem("item_lava_1", "Lava Sample Product One", "1200206", "5060000000017", 199),
        baseItem("item_lava_2", "Lava Sample Product Two", "1200207", "5060000000024", 299),
        baseItem("mod_size_s", "Small", "MOD0001", "5060000000031", 0),
        baseItem("mod_size_l", "Large", "MOD0002", "5060000000048", 50),
        baseItem("mod_extra_1", "Extra A", "MOD0003", "5060000000055", 30),
        baseItem("mod_extra_2", "Extra B", "MOD0004", "5060000000062", 30),
      ],
      hero_image: { url: img },
      experience: "aisles",
      merchandise_collections: {
        item_categories: [
          {
            id: "coll_featured",
            name: L("Featured"),
            description: L("Featured items"),
            item_ids: ["item_lava_1", "item_lava_2"],
          },
          {
            id: "coll_all",
            name: L("All Products"),
            description: L("All items"),
            item_ids: ["item_lava_1", "item_lava_2"],
          },
        ],
      },
      // Best-effort modifier groups (single-select + multi-select) referencing
      // the modifier items above. Structure to be confirmed against validator.
      modifiers: [
        {
          id: "grp_size",
          name: L("Size"),
          min_selection: 1,
          max_selection: 1,
          item_ids: ["mod_size_s", "mod_size_l"],
        },
        {
          id: "grp_extras",
          name: L("Extras"),
          min_selection: 0,
          max_selection: 2,
          item_ids: ["mod_extra_1", "mod_extra_2"],
        },
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
