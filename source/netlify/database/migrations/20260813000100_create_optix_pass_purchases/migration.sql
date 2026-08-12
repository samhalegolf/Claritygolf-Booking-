-- Pass purchases from Optix.
--
-- Optix booking webhooks carry no financial fields at all, so a purchase can
-- only come from one of the payment events: invoice_paid, new_sale, or
-- new_plan_subscription. Which of those a Pass actually fires is undocumented,
-- so all three are recorded here and classified (see classifyPassPurchase in
-- _shared/optix-passes.mts). classification is 'pass', 'not_pass' or 'unknown';
-- the Passes tab shows passes, with unknowns behind a toggle so a
-- misclassification is visible rather than silently dropped.
--
-- payload_json is kept on the row as well as in optix_webhook_events. The event
-- log is the audit trail; this is the working record, and having the raw
-- payload here is what lets the field-name guesses in optix-passes.mts be
-- corrected against a real purchase without a join.
CREATE TABLE IF NOT EXISTS public.optix_pass_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL DEFAULT 'optix',
  account_id TEXT NOT NULL DEFAULT 'sam-hale-golf',
  -- Ties back to optix_webhook_events, and makes a redelivered webhook update
  -- its existing row instead of adding a duplicate purchase.
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  external_purchase_id TEXT,
  member_email TEXT,
  member_name TEXT,
  -- Matched by email only, same rule as inbound bookings. NULL when the buyer
  -- matched no client or more than one; the email is still on the row.
  person_id TEXT,
  item_name TEXT,
  amount_cents INTEGER,
  currency TEXT,
  purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_pass BOOLEAN NOT NULL DEFAULT FALSE,
  classification TEXT NOT NULL DEFAULT 'unknown'
    CHECK (classification IN ('pass', 'not_pass', 'unknown')),
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS optix_pass_purchases_person_idx
  ON public.optix_pass_purchases (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS optix_pass_purchases_feed_idx
  ON public.optix_pass_purchases (is_pass, purchased_at DESC);
