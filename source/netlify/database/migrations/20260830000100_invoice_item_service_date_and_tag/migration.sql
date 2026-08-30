-- Per-line service date and reporting tag on invoice lines.
--
-- service_date is when the work on a line actually happened, which is routinely
-- not the invoice's issue date: a block of lessons given across August, billed
-- once at the end of it. Display only - no total is figured from it, so it is
-- nullable and old rows stay correct without a backfill.
--
-- tag holds an id from the coach's own invoice_settings.lineTags list (see
-- source/src/modules/billing/types.ts). It is deliberately a free TEXT column
-- and not a foreign key: the list lives in the account's settings JSON, and a
-- retired tag must not rewrite or block the invoices that already used it.
ALTER TABLE public.billing_invoice_items
  ADD COLUMN IF NOT EXISTS service_date DATE,
  ADD COLUMN IF NOT EXISTS tag TEXT;

-- Reporting reads lines by tag within one account's invoices; the partial index
-- keeps the untagged majority out of it.
CREATE INDEX IF NOT EXISTS idx_billing_invoice_items_account_tag
  ON public.billing_invoice_items (account_id, tag)
  WHERE tag IS NOT NULL AND tag <> '';
