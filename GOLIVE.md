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

- [ ] 💰⚠️ **Upgrade Render web service to Starter (always-on, ~$7/mo).**
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
- [ ] 💰⚠️ **Persistent database** — either upgrade Render Postgres (~$7/mo) or create a
  free [Neon](https://neon.tech) Postgres (doesn't expire like Render's free tier).
  Then re-add `DATABASE_URL` in Render → Environment (External URL if Render DB).
  Verify logs show `[db] Connected to Postgres; tables ready.`
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
- [ ] Copy the production secret into Render as `DELIV_WEBHOOK_SECRET` (user: secrets
  aren't entered by Claude). Check `/debug/status` → `webhookSignatures.valid` rises on
  the next order event, then set `DELIV_WEBHOOK_ENFORCE=true`.
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
- [ ] 30 rows were approved without a Final SKU: type the SKUs in the mapping sheet,
  regenerate `sku-map.json`, deploy.
- [ ] Check coverage (read-only): `GET /debug/menu/check`.
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
- [ ] User approves the Link to Linnworks tab and the titles/categories.
- [ ] `python tools/apply_link_pack.py link-pack.json` on branch `catalogue-links-v4` → merge
  to main → deploy (stock sync then covers all 178 listings; Linnworks auto-links them).
- [ ] Partner Hub: Update items (`partner-hub-update-items.csv`: PLU on all 178, titles,
  prices, descriptions, age restricted / max quantity), Delete items (27), Update item
  category mapping (26 moves). **PLUs are needed before real orders** for the 65 newly linked
  listings, or their orders sync as failed.
- [ ] Images (1200 x 800; Deliveroo reviews photos for 2–3 days) and new products (Add
  products tab; the single SKUs replacing the options listings are at the top). Add the new
  item ids to `sku-map.json`.
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
- [ ] **Rotate `SYNC_SECRET`** (current value was used throughout testing) and consider
  gating `/debug/*` endpoints behind `NODE_ENV`/flag or removing them for production.
- [ ] **Re-test order persistence** once DB is live: send test order → restart service →
  order still present.
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
  integration confirms ingestion + handles records/stock automatically.

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
