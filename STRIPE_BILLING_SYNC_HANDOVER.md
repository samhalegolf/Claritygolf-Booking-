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

## Setup status (2026-10-02)

Done:
- Live Connect webhook created on the Clarity Golf Systems platform account (`we_1UKSLNH9oVv8OMHYExJ4fIcF` → `https://claritygolf.app/api/stripe-billing-webhook`, all 17 events below; `payment_intent.succeeded` added 2026-10-02 for Tap to Pay).
- `STRIPE_CONNECT_WEBHOOK_SECRET` set in Netlify (clarity-golf-booking) to that endpoint's signing secret.
- Unused `STRIPE_PRICE_DAY_PASS` and `STRIPE_PRICE_ROUND_PASS` removed from Netlify.

Still to do by hand:
- Netlify: set `STRIPE_PLATFORM_SECRET_KEY` (platform account's live secret key) and `STRIPE_CONNECT_CLIENT_ID` (`ca_…` from Connect › Settings › OAuth). Neither can be read through the API.
- Netlify: delete `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` (the old SAMHALEGOLF paste-your-keys setup; nothing reads them).
- Old SAMHALEGOLF Stripe account: remove any webhook pointing at `/api/stripe-billing-webhook`. It is signed with the old secret, so it will now fail and Stripe will email about it.
- Test mode: repeat the webhook (all 17 events) in the platform's test mode and set `STRIPE_CONNECT_TEST_CLIENT_ID`, `STRIPE_PLATFORM_TEST_SECRET_KEY`, `STRIPE_CONNECT_TEST_WEBHOOK_SECRET`.
- Stripe dashboard: complete the Connect platform profile and onboarding branding.
- Redeploy, connect Sam Hale Golf from Settings › Billing › Card payments, then run the backfill (step 4).

## Setup after deploy

1. Each business connects its own Stripe from Settings › Billing › Card payments (Stripe Connect sign-in). Requests use Clarity's platform key on that connected account.
2. Once, on Clarity's platform Stripe account (Connect › Webhooks, "events on connected accounts"), add an endpoint at `https://YOUR-BOOKING-SITE/api/stripe-billing-webhook` with: `invoice.created`, `invoice.updated`, `invoice.finalized`, `invoice.sent`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `invoice.voided`, `invoice.marked_uncollectible`, `invoice.deleted`, `charge.succeeded`, `charge.updated`, `charge.captured`, `charge.refunded`, `account.application.deauthorized`, `account.updated`, `payment_intent.succeeded` (settles a Tap to Pay sale whose phone never heard the answer). Do the same in test mode.
3. Set `STRIPE_CONNECT_WEBHOOK_SECRET` (and `STRIPE_CONNECT_TEST_WEBHOOK_SECRET`) in Netlify to those endpoints' signing secrets.
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

## Two ways to take cards

Billing settings › Card payments offers both.

**Clarity Pay** (the easy route). Clarity creates the business's Stripe account on the platform and Stripe runs a short hosted signup (identity and bank details). Once Stripe approves it, Clarity Pay switches on by itself, from the return page, the settings screen or the `account.updated` webhook, whichever sees it first.
- Works everywhere: till, invoices (Pay button and emailed links) and player portal purchases. In-person payments will build on this route.
- Clarity takes an application fee on every payment: `CLARITY_PAY_FEE_PERCENT` (default `0.5`) plus `CLARITY_PAY_FEE_FIXED_CENTS` (default `0`), capped one cent under the charge.
- The account is Standard-like: Stripe charges the business its card fees directly and carries fraud and chargeback risk, and the business gets a full Stripe dashboard for payouts.
- Turning Clarity Pay off and back on reuses the same account (kept in the `clarityPayAccount` setting).
- A business moving from its own Stripe keeps taking invoice payments there until Clarity Pay is approved. Then Clarity switches over and disconnects the old sign-in.

**Own Stripe.** The business signs in to a Stripe account it already has (Connect OAuth, as before).
- Invoice payments only (Pay button and emailed links). The till and player portal ask for Clarity Pay.
- No Clarity fee.
- Connections made before this change are treated as own Stripe.

Setup on Clarity's platform Stripe account:
- Complete the Connect platform profile and the Connect onboarding branding (name, colour, icon), which Stripe's hosted signup requires.

Notes:
- Invoices a business creates directly in Stripe carry no fee; only payments started from Clarity do.
- Payment links emailed before this change carry no fee.
- **Refund** on a Clarity Pay card sale (Billing › Transactions) sends the whole card payment back through Stripe and returns Clarity's fee with it. The sale can't then be marked paid again. A card-paid sale can't be voided or reopened either; it has to be refunded.
- A **full** refund made in the business's Stripe dashboard marks the till sale it paid for as refunded in Clarity (stock and voucher value go back), through the `charge.refunded` webhook. A part refund leaves the sale paid. Dashboard refunds don't return Clarity's fee automatically; refund it from Connect › Collected fees if you want to.
