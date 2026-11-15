-- A voucher keeps the message that went with it.
--
-- A gift bought in the online shop has always carried a message, but on the
-- sale, not the voucher; a voucher issued by hand had nowhere to put one at
-- all (its note is the coach's own, "why it was issued"). Kept on the voucher
-- now, so its details can show it whichever way it was issued.
--
--   billing_coupons.gift_message   the words for the person it is for. Null:
--                                  none was given.
--
-- Vouchers already issued from an online order take the order's message.
--
-- Re-runnable.

ALTER TABLE public.billing_coupons
  ADD COLUMN IF NOT EXISTS gift_message TEXT;

UPDATE public.billing_coupons AS coupon
SET gift_message = sale.gift_message
FROM public.billing_pos_transactions AS sale
WHERE coupon.gift_message IS NULL
  AND coupon.source_line_id LIKE 'pos:%'
  AND sale.account_id = coupon.account_id
  AND sale.id = split_part(coupon.source_line_id, ':', 2)
  AND coalesce(trim(sale.gift_message), '') <> '';
