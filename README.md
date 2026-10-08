# Deliveroo ⇄ Linnworks Integration

Custom middleware connecting **Deliveroo** and **Linnworks** for Lava Wholesale Ltd.

- **Goal 1:** Sync Linnworks stock → Deliveroo availability (prevent overselling).
- **Goal 2:** Bring Deliveroo orders into Linnworks (records + fulfilment + stock decrement).
- **Goal 3 (future):** Package as a commercial Linnworks App Store connector.

```
Deliveroo  ⇄  Render middleware (this app)  ⇄  Linnworks (Channel Integration)
```

---

## Architecture: Linnworks "Channel Integration"

Linnworks **calls our endpoints** (we do not call Linnworks). This is the correct
mechanism for a sales-channel connector and the foundation for the App Store goal.

- **Stock (anti-oversell):** Linnworks pushes levels to `/linnworks/inventory-update`
  → we forward availability to Deliveroo.
- **Orders:** Linnworks polls `/linnworks/orders` (~every 10–15 min) → we return
  stored Deliveroo orders in Linnworks' schema.
- **Auth:** `/linnworks/add-new-user` issues an `AuthorizationToken` that Linnworks
  sends on every later call. (No permanent token needed — that's a different app type.)

Deliveroo sends new orders to `/deliveroo/order-webhook`, which we store in Postgres.

---

## Operating model (decided)

- **Order acceptance:** done on the **Deliveroo Order Manager tablet** for now (meets
  Deliveroo's acceptance SLA without certification). Move to **middleware auto-accept**
  later, once Deliveroo's TIM certifies the order lifecycle.
- **SKU mapping:** done **inside Linnworks** (link Linnworks SKU → Deliveroo item).
  Linnworks sends the Deliveroo item id as the `Reference` field on inventory updates.
- **Hosting:** Render. ⚠️ The **free plan sleeps after ~15 min idle**; upgrade to the
  **Starter plan (~$7/mo, always-on)** before relying on live orders, or webhooks/polls
  may be missed.

---

## Status

| Piece | State |
|---|---|
| Deliveroo OAuth (sandbox) | ✅ working (token cached) |
| Database (Postgres) | ✅ orders & config persist |
| Linnworks channel connected | ✅ AddNewUser/UserConfig/SaveConfig handshake verified |
| Order import to Linnworks | ✅ code ready (needs live Deliveroo orders) |
| **Catalogue API certification** | ✅ **7/7 scenarios passed** (Scenario 3 on 8 Oct 2026), portal shows Production: Live |
| **Orders API certification** | ✅ **all 12 sandbox scenarios passed** (receive order → POS sync status; PLU validation for missing/mismatched) |
| Orders production | ✅ **Live** — production order events delivered within seconds (test order #2387, 8 Oct 2026) |
| Live-shop stock sync | ✅ **live** since 8 Oct 2026 via **Menu API v2**, out of stock = hidden, limited to the 133 high-confidence mapped items until the SKU review is finished |
| Order → Linnworks mapping | ✅ real Deliveroo format mapped (nested body.order, pos_item_id→SKU, pence→pounds, modifiers as lines) |
| Order auto-accept | 🔜 future (tablet used for now) |

### Orders API: how it works (certified)
Deliveroo pushes `order.new` (placed) then `order.status_update` (accepted) to
`/deliveroo/order-webhook`. On the **accepted** event we POST a **sync status** to
`/order/v1/orders/{id}/sync_status`: `succeeded` if we can fulfil every PLU,
else `failed` with `pos_item_id_not_found` (missing PLU) or `pos_item_id_mismatched`
(unknown PLU, or a valid PLU on the wrong item). Valid PLUs come from
`DELIV_VALID_PLUS` (sandbox menu by default → your Linnworks SKUs in production);
`PLU_NAMES` in index.js maps PLU→expected title for mismatch detection.

Production order events, the live menu and live stock writes are all verified; what
remains is the SKU mapping review and switching stock sync on (see GOLIVE.md).

---

## Endpoints

Health/status: `GET /` and (protected) `GET /debug/status` (header `x-sync-secret`).
Logo: `GET /logo.png`.

Deliveroo webhook: `POST /deliveroo/order-webhook`.

Linnworks channel: `/linnworks/add-new-user`, `/user-config`, `/save-config`,
`/config-deleted`, `/config-test`, `/shipping-tags`, `/payment-tags`, `/orders`,
`/despatch`, `/cancel`, `/refund`, `/post-sale-options`, `/products`,
`/inventory-update`, `/price-update`.

Live menu (protected, header `x-sync-secret`): `GET /debug/menu/check` (SKU-map
coverage), `GET /debug/menu/retired` (deleted items and whether each is hidden now),
`POST /debug/menu/hide-retired` (hide them now; also runs at startup and hourly),
`POST /debug/menu/restore-all` (emergency undo; never un-hides retired items).

---

## Environment variables (set in Render)

See `.env.example`. Key ones:

- `DELIV_ENV` (`sandbox`/`production`), `DELIV_CLIENT_ID`, `DELIV_CLIENT_SECRET`
- `DELIV_BRAND_ID` / `DELIV_SITE_ID` — default to `lava-wholesale-gb` / `755952` in
  production
- `DELIV_STOCK_SYNC` — live by default in production; `off` stops live stock changes
- `DELIV_OUT_OF_STOCK_STATUS` = `hidden` (default) or `unavailable`
- `SKU_MAP_PATH` / `RETIRED_ITEMS_PATH` — alternative SKU map / retired list (tests)
- `KEEP_ALIVE=false` once on an always-on plan
- `DATABASE_URL` (Render Postgres)
- `SYNC_SECRET` (protects `/debug/*`)

> Linnworks credentials are NOT needed in this Channel Integration model (Linnworks
> calls us). They are only relevant for the alternative "direct API" app type.

---

## Code layout

- `index.js` — Express app + all endpoints + order/inventory mapping + logo.
- `src/config.js` — reads env vars, computes "ready" flags + Deliveroo hosts.
- `src/deliveroo.js` — cached OAuth token + (staged) availability update.
- `src/db.js` — Postgres (orders + per-account config), in-memory fallback.
- `sku-map.json` — approved SKU → Deliveroo item id(s); only these items are ever
  changed on Deliveroo. `sku-titles.json` — channel titles shown in Linnworks.
- `retired-items.json` — items deleted from the shop: kept hidden, dropped from the
  SKU map at startup, skipped by stock sync and restore-all.
- `tools/build-sku-map.js` — SKU matcher (writes into the repo; test in a copy).
- `tools/catalogue_apply.py` — local tool: catalogue review sheet → Deliveroo upload
  files (see below).

---

## Catalogue API — hard-won schema knowledge (undocumented)

Discovered empirically via the processing-error webhook (not in Deliveroo's docs):

- Catalogue items have a **`type` enum: `ITEM` | `CHOICE`** (case-sensitive).
  Modifier-option items must be `CHOICE`; anything else → processing
  `external_error: "type: must be a valid value"`.
- Items link to modifier groups via **`modifier_ids`**; groups live in the
  catalogue-level `modifiers` array: `{id, name:{en}, min_selection,
  max_selection, repeatable, item_ids}` (Menu API heritage).
- Names/descriptions are language objects `{"en": …}`; `operational_name` is a
  plain string; `tax_rate` is a string; barcodes must be valid EAN-13 (check
  digit enforced); media uses `media_type`/`media_url`; aisles experience
  requires two-tier `categories` (`item_categories` + `groups`, every category
  referenced by a group).
- The presigned `upload_url` accepts **unauthenticated PUT only** (S3 rejects an
  added Authorization header: "Only one auth mechanism allowed"); plain JSON
  only (gzip → "invalid json: \x1f").
- **Scenario 3** failed every run in Jun–Jul 2026 (sandbox presigned URLs point at a
  production-named bucket, and the validator never registered our uploads). It passed
  on 8 Oct 2026 with: Scenario 2 run → PUT the catalogue to its upload_url → start
  Scenario 3 with that catalogue id → while it polls, POST a **new** upload and PUT the
  same catalogue id again. The validator passed one second after that upload's
  `catalogue_upload: success` webhook. Sandbox credentials must be created with the
  Retail Platform suite ticked, or the scenarios show "API credentials: Missing".

## Stock sync on the live shop (Menu API v2)

The live shop's menu is built in Catalogue Manager, so it has no API catalogue id and
the Catalogue API's `item_unavailabilities` route can't address it. Menu API v2 works by
site instead, and Deliveroo documents it for menus built in their own tools:

- `GET /menu/v2/brands/{brand}/sites/{site}/menu` → the live menu (item ids = the
  `item_id` column of the Catalogue Manager export).
- `POST …/menu/item_unavailabilities` with
  `{"item_unavailabilities":[{"item_id","status":"available|unavailable|hidden"}]}`
  updates only the listed items; one unknown id fails the whole request (400).
- `unavailable` is cleared by Deliveroo's morning stock reset; `hidden` is not. The app
  defaults to `hidden` for zero stock and re-applies `unavailable` hourly if chosen.

## Catalogue changes: review sheet → Catalogue Manager

The shop's products live in Deliveroo **Catalogue Manager**. Changes go through one
Google Sheet, "Deliveroo catalogue review", built from the live menu, Linnworks and
lavastore.co.uk:

- **Products** tab — every item on the shop, with a Decision per row (Keep as is /
  Apply proposed changes / Delete from Deliveroo), proposed title, price and
  description, margin and price-cap checks, and Deliveroo rule flags.
- **Add products** tab — Linnworks items not on Deliveroo; mark Add = Yes.
- **Listing standard** tab — the fields and rules every new listing follows.

Apply the decisions:

1. Export the sheet as .xlsx (Drive export keeps the calculated values) and save the
   live menu (`GET /menu/v2/brands/lava-wholesale-gb/sites/755952/menu`).
2. `python tools/catalogue_apply.py review.xlsx menu.json --write-repo` writes
   `catalogue-update.csv` (Catalogue Manager bulk edit: approved changes, plus PLU =
   SKU, barcodes and 20% VAT for every kept item), `new-products.csv` (new-item upload),
   1200 x 800 images and `summary.md` (every warning) to
   `../deliveroo-uploads/<date>/`. `--write-repo` adds deleted items to
   `retired-items.json` and removes them from `sku-map.json`.
3. Commit and push: the deploy hides retired items for good.
4. Upload both CSVs and the images in Catalogue Manager (Partner Hub). After new
   items appear, add their ids to `sku-map.json` so stock sync covers them.

Facts the sheet and the tool rely on (sources in the sheet):

- Fee: 22.5% of the inc-VAT price on delivery orders (12% pick-up), plus VAT on the
  fee (cover sheet signed 28 Oct 2025; Core Service Pack 11.1).
- Price cap: Deliveroo may suspend the shop when a Deliveroo price is 35% or more
  above the same item on lavastore.co.uk (Core Service Pack 13.4; Value Programme
  "Action" threshold).
- Restricted items policy (8 Sep 2026): nothing 10kg+, 10L+ or over 40cm on any side;
  no gas cylinders, corrosives or blades; solvent glue, aerosols and anti-freeze need
  Age restricted + max quantity; 5–9.99kg items max quantity 2; over £275 needs
  permission; lithium batteries need V/Ah/Wh in the description.
- On 8 Oct 2026, 236 of the 241 live items were set to 0% VAT on Deliveroo; the update
  file sets 20% (customer prices are unchanged).

The Catalogue API is certified (7/7) and is the later route for images and fully
automatic listing from Linnworks, but the live shop isn't an API catalogue yet, so
Catalogue Manager uploads are the route today.

## Next steps

See [GOLIVE.md](GOLIVE.md) for the ordered checklist. In short: decisions in the
catalogue review sheet, then the Catalogue Manager upload (which also backfills PLUs,
needed before real orders), an accepted test order end to end with Ashley, and the
Render upgrade (always-on + database). Later: auto-accept, then commercial App Store
packaging.
