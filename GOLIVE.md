# Go-Live Checklist — Deliveroo ⇄ Linnworks

Status (8 Oct 2026):
- **Orders API:** 12/12 scenarios passed, portal shows **Production: Live**. Production
  order events reach `/deliveroo/order-webhook` within seconds (test order #2387: placed
  → 200, rejected → 200).
- **Catalogue API:** **7/7 scenarios passed** (Scenario 3 passed 8 Oct 2026), portal shows
  **Production: Live**.
- **Live-shop stock control proven:** production credentials read the live menu of site
  755952 (273 items; ids match the Catalogue Manager export) and can write item
  availability through Menu API v2. The portals' "0 / 4 go live steps" checklists never
  update and can be ignored.

Work through the sections in order. Items marked 💰 cost money; ⚠️ are hard requirements.

---

## 1. Hosting (do FIRST — everything depends on it)

- [x] 💰⚠️ **Upgrade Render web service to Starter (always-on, ~$7/mo).** Done 18 Oct
  2026: compute plan 0.5c-512mb ($7/mo), and `KEEP_ALIVE=false` is set, so the self-ping
  is off (no `[keep-alive]` line at startup).
  Evidence this is mandatory: Deliveroo's sandbox log showed
  `CatalogueWebhook … Client.Timeout exceeded` against our sleeping free-tier service,
  and in Oct 2026 Ashley's production test order hit the same timeout on
  `/deliveroo/order-webhook` (cold start measured at ~22s). Contract also requires
  99.8% uptime (Appendix 1).
  *Stopgap in place:* the app pings its own public URL every 10 min
  (`RENDER_EXTERNAL_URL`, or `KEEP_ALIVE_URL`) so the free instance never idles. That
  stops the cold-start timeouts but not Render's free-tier restarts, which wipe the
  in-memory order store, and the free plan's 750 h/month only covers one always-on
  service. Set `KEEP_ALIVE=false` after upgrading. `/debug/status` shows
  `startedAt` / `uptimeMinutes` / `keepAlive` to confirm it's working.
- [x] 💰⚠️ **Persistent database.** Done 18 Oct 2026: Render Postgres
  `deliveroo-linnworks-db` (Oregon like the service, PostgreSQL 18, 0.1c-256mb, 1 GB,
  $6.30/mo), with `DATABASE_URL` set in Render → Environment. The 11:25 BST deploy logged
  `[db] Connected to Postgres; tables ready.` and `databaseReady: true`, so orders and
  channel config now survive restarts and deploys.
- [ ] **Uptime monitoring** — free UptimeRobot (or similar) pinging `GET /` every 5 min
  with email alerts. Contract SLA: respond in 30 min / resolve in 2 h for critical
  (orders not flowing). Know who gets the alert out of hours.

## 2. Deliveroo portal — production setup

- [x] Production API credentials (Linnworks_Integration / Linnworks_Integrationv2,
  retail_platform, expire 31/07/2029) in Render with `DELIV_ENV=production`.
- [x] Production webhooks: Order events → `/deliveroo/order-webhook`, Catalogue →
  `/deliveroo/catalogue-webhook`.
- [x] Production discovery: brand `lava-wholesale-gb`, live site `755952`, test site
  `TIM-Test-22`.
- [x] Production webhook secret exists (Webhooks → Webhook secrets → production;
  checked 8 Oct 2026). Orders API: sandbox testing complete, eligible, Production Live.
  The dashboard's "Testing guidance 0 / 4" page 404s on Deliveroo's side; nothing to do.
- [x] Production logs (30 Sep – 8 Oct 2026): no failures since the keep-alive fix; the
  only failures were the 7 Oct cold-start timeout and our own 8 Oct API tests.
- [x] Copy the production secret into Render as `DELIV_WEBHOOK_SECRET` (done by the user,
  18 Oct 2026; secrets aren't entered by Claude).
- [ ] On the first real order event, check the logs show the `[webhook] <event> <order>`
  line with no `[webhook] invalid signature` warning before it (or `/debug/status` →
  `webhookSignatures.valid` rises). Then the user sets `DELIV_WEBHOOK_ENFORCE=true`:
  Render env-var saves are blocked for Claude.
- [ ] Sandbox credential `Lava_Catalogue_Scenario_Test` (created 8 Oct 2026 for
  Scenario 3) can be deleted; nothing in production uses it.

## 3. Stock sync to the live shop (Menu API v2)

The live menu is built in Catalogue Manager, so it has no API catalogue id. Menu API v2
addresses it by site instead:
`GET/POST /menu/v2/brands/lava-wholesale-gb/sites/755952/menu/item_unavailabilities`
(`{"item_unavailabilities":[{"item_id","status":"available|unavailable|hidden"}]}`).
Any unknown item id fails the whole request, so the app checks ids against the live
menu first.

- [x] Catalogue API certified (Scenario 3 passed 8 Oct 2026).
- [x] Read access and a no-op write verified on the live shop; full toggles verified on
  TIM-Test-22 (unavailable and hidden).
- [x] **Switched on 8 Oct 2026.** Production now defaults to brand `lava-wholesale-gb`,
  site `755952` and stock sync live, so no Render env vars are needed.
  `DELIV_STOCK_SYNC=off` stops it.
- [x] Out of stock = `hidden` (user's choice). It survives Deliveroo's morning stock
  reset and our restarts.
- [x] `sku-map.json` = the approved/amended rows of the "Deliveroo SKU mapping review"
  sheet (130 SKUs, 137 Deliveroo items; a SKU can cover duplicate listings). Nothing
  else on the menu is ever touched, and a Linnworks `Reference` is only trusted if it
  is a mapped item id. NO (customer returns) SKUs are never mapped.
- [x] Linnworks Deliveroo channel enabled with inventory sync (8 Oct 2026); all 130 SKUs
  linked and stock flowing (`/debug/status` → `linnworksCalls`, token fingerprint 057302).
- [x] 30 rows were approved without a Final SKU: superseded by the catalogue reviews (v4–v6)
  and batch 2, which mapped every listing.
- [x] Check coverage (read-only): `GET /debug/menu/check`. 17 Oct 2026: 417 listings, all
  417 mapped and on the menu, 417 with a PLU.
- [ ] Emergency undo if anything is hidden wrongly: `POST /debug/menu/restore-all`
  (makes every hidden/unavailable item orderable, except retired items).
- [ ] Reject other tokens on the `/linnworks/*` endpoints now Linnworks' token is known.

## 3b. Catalogue: titles, prices, PLUs, deletes, new products

- [x] Catalogue review sheet "Deliveroo catalogue review" built (8 Oct 2026): fee
  22.5% + VAT, 30% target, 35% webstore price cap, Deliveroo rule flags, titles and
  descriptions from lavastore.co.uk, listing standard.
- [x] Deletes: `retired-items.json` keeps deleted items hidden for good (startup and
  hourly), out of the SKU map, and safe from restore-all.
- [x] PLU/VAT fix confirmed in Partner Hub (8 Oct 2026): all 205 items at 20% VAT, PLUs on
  the 113 linked items. 36 listings deleted (241 → 205).
- [x] Review v4 (8 Oct 2026): every listing has a decision. 92 had no SKU: 57 linked, 8
  pointed at the newer model (the listed V2/Gen 2 is archived), 27 to delete (duplicates,
  options listings, archived or not in Linnworks, not allowed). Prices follow the rules (30%
  aim under the 35% cap, never below the webstore, 22% minimum even over the cap).
- [x] Review v6 (14 Oct 2026): the user's decisions and edits (66 cells), fresh data, and
  hand-written descriptions for the 74 listings whose generated text was broken or thin.
  Final files in `deliveroo-uploads/2026-10-14 Product upload/`: 177 updates, 28 deletes,
  21 new listings, 25 category moves (#35 → white E20i 600264, #31 → 1900070 on the user's answers).
- [x] `catalogue-links-v6` merged and deployed (cf5040a, 15 Oct 2026): stock sync covers the
  177 kept listings; the 28 deletes were hidden until Partner Hub removed them.
- [x] Partner Hub, 15 Oct 2026: Update items (PLU on all 177, titles, prices, descriptions,
  age restricted / max quantity), Delete items (28) and Add items (21), all published. The
  live menu was checked against the files: 198 listings, every field matches.
  Publish refuses while a category is empty, so "Barrier Pipe" was deleted with its coils.
- [x] The 21 new listings are in `sku-map.json` (198 SKUs = every listing on the live menu).
  Menu Manager gives new items 12-character ids, not UUIDs.
- [x] PLU Update file for the 21 new listings, uploaded and published (16 Oct 2026).
- [x] Batch 2 (16 Oct 2026): the category moves (36, including the new fitting-type
  categories) and 219 new listings, published; the emptied "Clearance" category was deleted.
  Live menu: 417 listings, 26 categories. All 219 are in `sku-map.json` (417 SKUs = every
  listing on the live menu); Linnworks links them on its next nightly products read.
- [x] PLUs on the 219 batch 2 listings, entered in Menu Manager's "Add Point of Sale IDs
  (PLUs)" screen (no CSV needed) and published (17 Oct 2026). The live menu was checked:
  417/417 PLUs, each equal to the SKU that `sku-map.json` links to that item.
- [ ] Images: all 500 photos were replaced with 1200×675 versions that keep the product
  inside the central square (the customer menu crops every tile to a square), and
  published on 17 Oct 2026 at 23:37. They are pending Deliveroo's review; customers see
  the old approved photos until then. Check the public tiles around 20 Oct. No photo:
  1000020 (washers), 1200148 (its only photo shows the wrong fitting), 1200040 (no
  official photo).
- [x] Batch 3 (17 Oct 2026): 86 new listings added through Bulk management → Add items
  (`deliveroo-uploads/2026-10-17 Upload batch 3/`), plus 3 new categories (MDPE Fittings,
  Solder Ring Fittings, Basins). The draft was checked against the file (every field
  matches), PLUs entered (503/503, PLU = SKU) and 85 photos uploaded (1200040 has none).
  All 86 are in `sku-map.json` (503 SKUs = every listing in the draft); ids not yet on the
  live menu are skipped by stock sync until the draft is published.
- [x] Batch 3 published (17 Oct 2026, evening): Menu Manager shows "All changes are
  published" for the checked draft (503 listings, 29 categories, 503/503 PLUs equal to
  `sku-map.json`), and the public page lists the 3 new categories. Linnworks linked all
  503 SKUs to the right item ids overnight (18 Oct). The API cross-check
  (`/debug/menu/check`) still needs `SYNC_SECRET`.
- [ ] Batch 4 (18 Oct 2026): 15 low-cost listings Will approved on the "Low-cost products (18 Oct)" tab
  (the 15mm press fit singles and others the old cost rule had dropped), added one at a time with Menu
  Manager's Add item form: photo, name, description, price, category, 20% VAT, substitution off. They are
  in `sku-map.json` (518). The form and the PLU dialog drop scripted barcodes and PLUs, so those go in
  with an Update items file (Bulk management -> Update items); then check the draft and publish.
- [ ] Batch 5 (18 Oct 2026): the other 21 approved low-cost listings, which needed barcodes, photos and
  some new titles and descriptions first, added the same way. A fresh read of the draft matched every
  field for all 36 batch 4 and 5 listings (539 in the draft, 539 in `sku-map.json`). One file sets the
  PLUs and barcodes for all 36: `deliveroo-uploads/2026-10-18 Upload batch 4/update-items-plu-barcodes-36.csv`
  (it replaces the 15-row `update-items-plu-barcodes.csv`). 1200150 (isolation valve) is held until
  the bin shows whether it is straight or angled.
- [ ] Email the Deliveroo account manager 3 days before changes or withdrawals
  (Core Service Pack 7.1.6).

## 4. Code hardening (build before switching real orders on)

- [x] ⚠️ **48-hour data purge** — contract Clause 2.4 requires Deliveroo order data
  deleted within 48 h of receipt. Done: an hourly job deletes orders received more than
  48 h ago (Linnworks collects them within ~15 min).
- [x] **Only accepted orders go to Linnworks** — orders are stored from `order.new` but
  released to `/linnworks/orders` only once accepted, filtered on `accepted_at`; any
  order later rejected/cancelled before collection is withheld.
- [x] **Webhook signature verification** using `DELIV_WEBHOOK_SECRET`: hex HMAC-SHA256
  of "<sequence guid> <raw body>", checked on the order and catalogue webhooks, counted
  in `/debug/status`; log-only until `DELIV_WEBHOOK_ENFORCE=true`.
- [x] **Rotate `SYNC_SECRET`** (the old value was used throughout testing). The user
  generated a new one in Render on 18 Oct 2026; it is stored only there.
- [ ] Consider gating `/debug/*` endpoints behind `NODE_ENV`/flag or removing them for
  production.
- [ ] **Re-test order persistence** now the DB is live (18 Oct 2026): with the first real
  order, check it reaches Linnworks after a restart or deploy in between.
- [ ] `DELIV_VALID_PLUS`: leave strict PLU checks OFF in production (default) until real
  SKU list is loaded; then optionally set to the Linnworks SKU list to enable
  missing/mismatch rejection with real data.

## 5. Linnworks side

- [x] **SKU mapping**: Linnworks auto-linked all 130 SKUs from our Products endpoint
  (Reference = Deliveroo item id), 8 Oct 2026.
- [ ] Confirm Linnworks polls `/linnworks/orders` and imports a test order end-to-end
  (order lines, prices, customer name; modifiers arrive as separate lines).
- [x] Linnworks stock changes hit `/linnworks/inventory-update` and flip availability on
  Deliveroo (21 zero-stock items hidden on 8 Oct 2026).
- [ ] Confirm despatch flow: dispatching in Linnworks calls `/linnworks/despatch` (we
  acknowledge; no Deliveroo action needed under tablet model).

## 6. Site / operating model (with Deliveroo)

- [ ] Confirm production site settings for the **tablet acceptance** model:
  tablet = **Yes**, orders fulfilled by **partner** (raise with Ashley/TIM — sandbox site
  was created with tablet No / fulfilled by Deliveroo).
- [ ] Staff briefed: accept orders on the tablet (SLA ~10 min or auto-reject); the
  integration confirms ingestion + handles records/stock automatically. The team SOP
  (picking, packing, riders, Linnworks, cancellations, refunds, accounting) is the Claude
  Doc "Deliveroo Orders SOP", written 18 Oct 2026.

## 7. Go-live smoke test (first live day)

- [ ] Place a small real order → accept on tablet → verify: webhook received, sync
  status `succeeded` sent, order imported to Linnworks, stock decremented.
- [ ] Set one product to 0 stock in Linnworks → verify it is hidden (or greyed out) on
  Deliveroo.
- [ ] Restore stock → verify it returns to available.
- [ ] Check `/debug/status` counters and Render logs for errors.

## 8. Open questions / waiting on Deliveroo

- Ashley to let one TIM-Test-22 order be accepted, to test acceptance → sync status →
  Linnworks import (asked 8 Oct 2026, TIS-30247).
- Production site config change (tablet Yes / partner-fulfilled).

## 9. Phase 2 (post-launch, commercial)

- Multi-merchant support, config UI, Linnworks App Store packaging, billing, support
  docs (see README goals). Auto-accept via Update Order Status API (removes tablet
  dependency; needs Deliveroo certification of the order-status lifecycle).
