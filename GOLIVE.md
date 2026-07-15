# Go-Live Checklist — Deliveroo ⇄ Linnworks

Status at time of writing (15 Jul 2026):
- **Orders API:** 12/12 scenarios passed, **production approved** (4 go-live steps showing in portal).
- **Catalogue API:** 6/7 scenarios passed (1,2,4,5,6,7). Scenario 3 blocked by a faulty
  Deliveroo validator — escalated to Ashley (evidence: their success webhooks + passing
  scenarios 5–7 which repeat the same flow). Production for Catalogue unlocks when resolved.
- Full pipeline proven in sandbox: upload → process → webhook → listings → **stock
  unavailabilities** (`PATCH /brands/{b}/catalogue/{id}/item_unavailabilities/{site}`), plus
  order ingestion + POS sync status.

Work through the sections in order. Items marked 💰 cost money; ⚠️ are hard requirements.

---

## 1. Hosting (do FIRST — everything depends on it)

- [ ] 💰⚠️ **Upgrade Render web service to Starter (always-on, ~$7/mo).**
  Evidence this is mandatory: Deliveroo's sandbox log showed
  `CatalogueWebhook … Client.Timeout exceeded` against our sleeping free-tier service —
  in production, **order webhooks would be lost the same way**. Contract also requires
  99.8% uptime (Appendix 1).
- [ ] 💰⚠️ **Persistent database** — either upgrade Render Postgres (~$7/mo) or create a
  free [Neon](https://neon.tech) Postgres (doesn't expire like Render's free tier).
  Then re-add `DATABASE_URL` in Render → Environment (External URL if Render DB).
  Verify logs show `[db] Connected to Postgres; tables ready.`
- [ ] **Uptime monitoring** — free UptimeRobot (or similar) pinging `GET /` every 5 min
  with email alerts. Contract SLA: respond in 30 min / resolve in 2 h for critical
  (orders not flowing). Know who gets the alert out of hours.

## 2. Deliveroo portal — Orders API go-live (4 steps shown in portal)

- [ ] **Generate production API credentials** (portal step 1).
- [ ] In Render → Environment set:
  - `DELIV_CLIENT_ID` / `DELIV_CLIENT_SECRET` = production values
  - `DELIV_ENV` = `production`
- [ ] **Set production Order events webhook** (portal step 2):
  `https://deliveroo-linnworks-integration.onrender.com/deliveroo/order-webhook`
- [ ] **Generate production webhook secret** (portal step 3) → save as
  `DELIV_WEBHOOK_SECRET` in Render (code TODO below to verify signatures).
- [ ] **Confirm completion / connect** (portal step 4).
- [ ] Re-run brand/site discovery against production (`GET /debug/deliveroo-discover`)
  and record the **production brand_id** (sandbox one was `17b449e6-…`; production will
  differ). Site id = `755952` (Admin ID). Set `DELIV_BRAND_ID` / `DELIV_SITE_ID`.

## 3. Catalogue API production (when Scenario 3 is resolved)

- [ ] Confirm Scenario 3 marked complete → Catalogue API production unlocks.
- [ ] Set production **Catalogue events webhook**:
  `https://deliveroo-linnworks-integration.onrender.com/deliveroo/catalogue-webhook`
- [ ] Identify the **production catalogue_id** (the catalogue managed via Catalogue
  Manager — ask Ashley/TIM how to reference it, or list via API). Set
  `DELIV_CATALOGUE_ID` in Render.
- [ ] Verify stock sync against production: toggle one item unavailable/available and
  check it greys out on the live storefront.

## 4. Code hardening (build before switching real orders on)

- [ ] ⚠️ **48-hour data purge** — contract Clause 2.4 requires Deliveroo order data
  deleted within 48 h of receipt. Add a purge job (delete `deliveroo_orders` rows older
  than 48 h once pulled by Linnworks).
- [ ] **Webhook signature verification** using `DELIV_WEBHOOK_SECRET` (reject spoofed
  webhook calls).
- [ ] **Rotate `SYNC_SECRET`** (current value was used throughout testing) and consider
  gating `/debug/*` endpoints behind `NODE_ENV`/flag or removing them for production.
- [ ] **Re-test order persistence** once DB is live: send test order → restart service →
  order still present.
- [ ] `DELIV_VALID_PLUS`: leave strict PLU checks OFF in production (default) until real
  SKU list is loaded; then optionally set to the Linnworks SKU list to enable
  missing/mismatch rejection with real data.

## 5. Linnworks side

- [ ] **SKU mapping**: in the Linnworks channel mapping screen, map each Linnworks SKU to
  its Deliveroo item id (sent to us as `Reference` on inventory updates). Start with a
  pilot subset (e.g. 10 products).
- [ ] Confirm Linnworks polls `/linnworks/orders` and imports a test order end-to-end
  (order lines, prices, customer name; modifiers arrive as separate lines).
- [ ] Confirm Linnworks stock changes hit `/linnworks/inventory-update` and (once
  Catalogue production is live) flip availability on Deliveroo.
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
- [ ] Set one product to 0 stock in Linnworks → verify it shows unavailable on Deliveroo.
- [ ] Restore stock → verify it returns to available.
- [ ] Check `/debug/status` counters and Render logs for errors.

## 8. Open questions / waiting on Deliveroo

- Scenario 3 validator fix or manual completion (escalated 15 Jul).
- Production `catalogue_id` for the Catalogue-Manager-managed catalogue.
- Production site config change (tablet Yes / partner-fulfilled).

## 9. Phase 2 (post-launch, commercial)

- Multi-merchant support, config UI, Linnworks App Store packaging, billing, support
  docs (see README goals). Auto-accept via Update Order Status API (removes tablet
  dependency; needs Deliveroo certification of the order-status lifecycle).
