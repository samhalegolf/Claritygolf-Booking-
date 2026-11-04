-- The website store, item by item, and a gift card and email per voucher.
--
-- 1. No more shop-wide switch. Each pass and bundle (sellOnline in
--    servicesJson) and each voucher and product (sell_online) says for itself
--    whether it shows on the website store. A shop that was switched on keeps
--    selling what it sold: its passes, bundles and vouchers are ticked here,
--    then the old onlineShopEnabled setting is removed. A shop that was off
--    has nothing ticked, so it stays closed.
--
-- 2. A voucher can have its own gift card (gift_card_design, the same JSON as
--    the giftCardDesignJson setting) and its own email wording (gift_email:
--    subject, heading, body, signoff). Null uses the standard ones under
--    Settings › Templates › Gift voucher. A voucher's options (variants) all
--    share them, and each option can now carry a description too (in the
--    variants JSON, no schema change).
--
-- Re-runnable.

ALTER TABLE public.billing_products_services
  ADD COLUMN IF NOT EXISTS gift_card_design JSONB,
  ADD COLUMN IF NOT EXISTS gift_email JSONB;

UPDATE public.billing_products_services AS product
SET sell_online = true, updated_at = NOW()
FROM public.settings AS switch
WHERE switch.account_id = product.account_id
  AND switch.key = 'onlineShopEnabled'
  AND trim(switch.value) = 'true'
  AND product.is_voucher = true
  AND product.sell_online = false;

-- Passes and bundles live in the servicesJson setting. A value that is not a
-- JSON list is left alone rather than failing the deploy.
DO $$
DECLARE
  row RECORD;
  services JSONB;
BEGIN
  FOR row IN
    SELECT catalogue.account_id, catalogue.value
    FROM public.settings AS catalogue
    JOIN public.settings AS switch
      ON switch.account_id = catalogue.account_id
     AND switch.key = 'onlineShopEnabled'
     AND trim(switch.value) = 'true'
    WHERE catalogue.key = 'servicesJson'
  LOOP
    BEGIN
      services := row.value::jsonb;
    EXCEPTION WHEN others THEN
      CONTINUE;
    END;
    IF jsonb_typeof(services) <> 'array' OR jsonb_array_length(services) = 0 THEN
      CONTINUE;
    END IF;
    UPDATE public.settings
    SET value = (
          SELECT jsonb_agg(
                   CASE
                     WHEN jsonb_typeof(entry) = 'object' AND entry->>'lessonFormat' = 'package'
                       THEN entry || '{"sellOnline": true}'::jsonb
                     ELSE entry
                   END
                   ORDER BY position
                 )::text
          FROM jsonb_array_elements(services) WITH ORDINALITY AS listed(entry, position)
        ),
        updated_at = NOW()
    WHERE account_id = row.account_id AND key = 'servicesJson';
  END LOOP;
END $$;

DELETE FROM public.settings WHERE key = 'onlineShopEnabled';

NOTIFY pgrst, 'reload schema';
