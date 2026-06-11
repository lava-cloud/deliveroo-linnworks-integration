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
| Stock sync to Deliveroo | ⏳ blocked — Retail **Catalogue API** cert rejects our upload with no error feedback (webhook never delivers); chasing Deliveroo for the reason |
| **Orders API certification** | ✅ **all 12 sandbox scenarios passed** (receive order → POS sync status; PLU validation for missing/mismatched) |
| Orders production access | ⏳ blocked only on **activation contract review** (not technical) — chase Deliveroo |
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

**The one remaining blocker is Deliveroo onboarding** (TIM assignment + Brand/Catalogue/
Site IDs). When those arrive, paste them into Render env vars and stock sync goes live
with no code change.

---

## Endpoints

Health/status: `GET /` and (protected) `GET /debug/status` (header `x-sync-secret`).
Logo: `GET /logo.png`.

Deliveroo webhook: `POST /deliveroo/order-webhook`.

Linnworks channel: `/linnworks/add-new-user`, `/user-config`, `/save-config`,
`/config-deleted`, `/config-test`, `/shipping-tags`, `/payment-tags`, `/orders`,
`/despatch`, `/cancel`, `/refund`, `/post-sale-options`, `/products`,
`/inventory-update`, `/price-update`.

---

## Environment variables (set in Render)

See `.env.example`. Key ones:

- `DELIV_ENV` (`sandbox`/`production`), `DELIV_CLIENT_ID`, `DELIV_CLIENT_SECRET`
- `DELIV_BRAND_ID`, `DELIV_CATALOGUE_ID`, `DELIV_SITE_ID` ← **from Deliveroo TIM (pending)**
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
- `sku-map.json` — optional fallback SKU→Deliveroo-item map (mapping is normally
  done in Linnworks now).

---

## Catalogue / listings (decided: defer)

Products are created/edited in Deliveroo **Catalogue Manager** for now; Linnworks
only maps SKUs and syncs stock + orders. Listing creation from Linnworks is **not**
enabled (`IsListingSupported: False`).

If we later want to drive the catalogue from Linnworks, the preferred route is
**Option B**: middleware builds the Deliveroo master-catalogue JSON from product
data and uploads via the Catalogue API (`POST /catalogue/uploads` →
`PATCH /update-listings`). This needs the full **Catalogue API** scope (not just
the Stock API). The full Linnworks Generic Listing Tool route (Option C) is
heavier and not recommended unless a Linnworks-native listing UI is required.

## Next steps

1. **Deliveroo:** chase TIM via developer portal; obtain Brand/Catalogue/Site IDs;
   set site to tablet-accept + partner-fulfilled.
2. When IDs arrive: add `DELIV_BRAND_ID` / `DELIV_CATALOGUE_ID` / `DELIV_SITE_ID` in
   Render. Verify stock sync via a Linnworks inventory change.
3. Point Deliveroo's order webhook at `/deliveroo/order-webhook`.
4. Map a few SKUs in Linnworks; confirm orders import and stock decrements.
5. Upgrade Render to Starter (always-on) before go-live.
6. Later: build & certify middleware auto-accept; then commercial App Store packaging.
