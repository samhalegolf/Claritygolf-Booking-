# Value-backed pass exchange audit

## Existing source-of-truth paths

- Templates are services in `servicesJson`. `lessonFormat: "package"`,
  `packageAllowance`, `packageCoversServiceId`, and the widened
  `coversServiceIds` shape are normalised by `cleanService` in `src/App.tsx`
  and `netlify/functions/booking-core.mts`, then interpreted by
  `passTemplatesFromServices` in `_shared/passes.mts`.
- Issued identities live in `passes`; append-only incoming units live in
  `pass_allocations`; append-only usage lives in `pass_redemptions`. The
  `pass_allocation_balances` and `pass_balances` views derive every displayed
  unit balance.
- `PassesPanel.tsx` is the coach grant/history surface. Player-safe pass shapes
  are allow-listed by `playerPassViews` and rendered in `PlayerPortal.tsx`.
- Manual grants and the Optix inbox call `grantPass` from `booking-core.mts`.
  Player Shop confirmation calls it after Stripe confirms payment.
- POS and invoice package issuance run through `issuePassesForPurchase` in
  `billing-api.mts`. POS prices are re-read server-side and snapshotted into
  transaction items; invoice items snapshot quantity, unit price, discounts,
  and line total; Optix stores `amount_cents` and `currency` on the purchase.
- Native pass checkout calls `reservePassCredit`, which locks the pass and
  chooses the earliest-expiring allocation. It writes a zero-dollar POS sale
  with the listed service value. Failed sale creation reverses the redemption.
- Booking cancellation/deletion calls `reverseRedemptionsForBooking`; the
  balance read also sweeps orphaned/cancelled bookings. History is retained by
  setting reversal metadata, never deleting a redemption.
- POS payments currently have one primary payment-method shape plus optional
  coupon value. Invoice payments store aggregate paid value. Neither currently
  has a general multi-tender child ledger.

## Extension decisions

- Preserve the existing three-table unit ledger and add immutable value/currency
  metadata to each new allocation lot.
- Existing allocations with no reliable source value remain native-only.
- Use integer minor units. A non-divisible lot assigns the remainder one cent at
  a time to its earliest unit ordinals, so unit values always sum to the exact
  purchase value.
- Keep residual money inside the pass domain in append-only
  `pass_value_movements`, grouped by auditable `pass_value_transactions`.
- Record credit/card (and future cash, bank, invoice-credit, or gift-value)
  components independently in `billing_payment_tenders`, so a mixed purchase
  can be refunded to its original tenders rather than treated as one payment.
- Currency comes from the paid transaction. For new account-priced sales this
  is the currency selected in invoice/account settings, which itself defaults
  from the selected workspace country. Currency is snapshotted and no FX is
  attempted after settings change.
- Cross redemption requires both the issued pass snapshot and the target
  service setting. Native coverage does not depend on cross-redemption flags.

## Backward compatibility and rollout

- New flags default off in storage. Old passes and allocations continue native
  redemption unchanged.
- No historical value is inferred from today's service price. Reliable source
  transaction backfill can be added as a separately reviewed data operation.
- New tables have RLS enabled and no browser policy, matching the existing
  service-role-only ledger. Views use `security_invoker`.
- This migration is not applied by this work. Deployment remains a separate,
  explicitly approved operation.
