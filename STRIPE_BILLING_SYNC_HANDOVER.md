# Stripe → Booking App Billing Sync

Built: 2026-07-16

## What this does

Mirrors your Stripe account (SAMHALEGOLF) into the booking app's billing section, using the tables billing-api.mts already owns:

- `billing_invoices` + `billing_invoice_items` — Stripe invoices (SHG-04xx), keyed by Stripe ids (`in_...` / `il_...`), so they never collide with invoices created in-app (those use UUIDs) and every sync is idempotent
- `billing_products_services` — ALL Stripe products, active and archived, deliberately unfiltered; future products appear automatically the moment they're created in Stripe

Two entry points:

1. `POST /api/billing-stripe-sync` — admin backfill/catch-up (session-cookie auth, same as the rest of the admin app)
2. `POST /api/stripe-billing-webhook` — Stripe webhook for live updates

## Files added (source/netlify/functions/)

- `_shared/stripe-billing.mts` — shared mapping/sync logic
- `stripe-billing-sync.mts` — admin endpoint
- `stripe-billing-webhook.mts` — webhook endpoint

No existing files were modified. Type-checked with the repo's `typecheck:functions` settings.

## Mapping notes

- Amounts: Stripe cents → dollars; currency stored uppercase (NZD) to match formatMoney
- Status translation (billing_invoices has a CHECK constraint): Stripe `open` → `sent` (or `overdue` when past due), `uncollectible` → `overdue`, `void` → `void`, `draft`/`paid` pass through
- `invoice_number` = Stripe number, `reference` = Stripe invoice id, `internal_note` = "Synced from Stripe"
- `tax_inclusive` detected from Stripe's tax breakdown (inclusive GST → true)
- Product `kind` maps loosely (goods → `product`, else → `service`); set Stripe product metadata `clarity_kind` to `service` / `product` / `package` / `lesson-type` to choose explicitly
- Stripe product deleted → row kept, marked inactive
- Account id resolves the same way billing-api.mts does (settings → `CLARITY_COACH_ACCOUNT_ID` → `sam-hale-golf`)

## Setup after deploy

1. Push; Netlify auto-deploys. `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `STRIPE_SECRET_KEY` are already in this site's env (Clarity Pay uses them).
2. In the Stripe Dashboard (Developers → Webhooks) add an endpoint pointing at `https://YOUR-BOOKING-SITE/api/stripe-billing-webhook` with these events: `invoice.created`, `invoice.updated`, `invoice.finalized`, `invoice.sent`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `invoice.voided`, `invoice.marked_uncollectible`, `invoice.deleted`, `product.created`, `product.updated`, `product.deleted`.
3. Set `STRIPE_BILLING_WEBHOOK_SECRET` in the Netlify site env to that endpoint's signing secret (falls back to `STRIPE_WEBHOOK_SECRET` if you prefer one var).
4. Run the backfill while logged in as admin — from the browser console on the admin app:

```js
fetch("/api/billing-stripe-sync", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action: "syncAll" }),
}).then(r => r.json()).then(console.log);
```

Actions: `syncAll` (default), `syncInvoices`, `syncProducts`. Optional `since` (ISO date or epoch seconds) changes the invoice window from the 2026-01-01 default. Safe to re-run any time; the response lists counts and per-record failures.

5. Open Billing in the app — invoices and products should be populated.

## Behaviour notes

- Webhook failures return 500 so Stripe retries; unrecognised events are acknowledged and ignored
- Everything upserts, so webhook retries and repeated backfills are harmless
- Stripe-synced invoices are editable in-app like any other row, but a later Stripe update to the same invoice overwrites in-app edits (Stripe is the source of truth for `in_...` rows)
