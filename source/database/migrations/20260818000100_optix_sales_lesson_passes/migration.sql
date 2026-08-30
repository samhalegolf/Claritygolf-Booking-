-- The first real new_sale payloads (18 Aug 2026, starting with Sam's test
-- purchase of "30 Minute Golf Lesson Package") settled three things:
--
-- 1. new_sale carries NO invoice_id — despite Optix's docs. invoice_paid can
--    therefore never be joined to a sale, so the join column goes and sales
--    are recorded as paid at purchase instead (Optix takes the money when the
--    sale is made).
-- 2. It DOES carry "number" — the Optix sale number ("00652"), the receipt
--    reference a buyer sees. Stored so the POS list can show it.
-- 3. The lesson passes are named with "Lesson" ("… Lesson Package"), not
--    "Pass", so classification matches both words. Bay top-ups like
--    "1 x Extra Hour" match neither and stay unknown, which is correct.

ALTER TABLE public.optix_pass_purchases
  DROP COLUMN IF EXISTS external_invoice_id,
  ADD COLUMN IF NOT EXISTS sale_number TEXT;

-- Backfill the sale number from the raw payload already on each row.
UPDATE public.optix_pass_purchases
SET sale_number = NULLIF(payload_json->>'number', '')
WHERE sale_number IS NULL;

-- Reclassify existing sales with the widened wording (lesson OR pass).
UPDATE public.optix_pass_purchases
SET classification = 'pass', is_pass = TRUE, updated_at = NOW()
WHERE event_type = 'new_sale'
  AND classification <> 'pass'
  AND (COALESCE(item_name, '') || ' ' || COALESCE(payload_json->>'invoice_item_name', ''))
      ~* '\y(pass|passes|lesson|lessons)\y';

-- A sale is paid at purchase; stamp the rows recorded before this rule.
UPDATE public.optix_pass_purchases
SET paid_at = purchased_at, updated_at = NOW()
WHERE event_type = 'new_sale' AND paid_at IS NULL;
