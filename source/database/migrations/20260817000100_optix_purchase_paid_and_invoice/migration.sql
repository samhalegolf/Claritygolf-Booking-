-- Optix purchases: the invoice they sit on, and whether it settled.
--
-- Optix splits a purchase across two webhooks. new_sale says what was bought
-- (product, quantity, total) but not whether it was paid; invoice_paid says an
-- invoice settled but carries no purchase detail at all — six keys, none of
-- them money or product. invoice_id is the only thing joining them, so it is
-- stored on the purchase and invoice_paid stamps paid_at against it.
--
-- Delivery order is not guaranteed, so the join is made from both ends:
-- markOptixInvoicePaid() handles the sale arriving first, and paidAtForInvoice()
-- handles the payment arriving first by reading back from optix_webhook_events.
ALTER TABLE public.optix_pass_purchases
  ADD COLUMN IF NOT EXISTS external_invoice_id TEXT,
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
  -- new_sale sends quantity as "1.0000"; a Pass sold as a 10-pack is one sale
  -- of quantity 10, not ten sales.
  ADD COLUMN IF NOT EXISTS quantity NUMERIC;

CREATE INDEX IF NOT EXISTS optix_pass_purchases_invoice_idx
  ON public.optix_pass_purchases (external_invoice_id)
  WHERE external_invoice_id IS NOT NULL;

-- The 27 rows already here are invoice_paid events recorded before this split:
-- every one is empty (no item, no email, no amount) because that payload never
-- had anything to record. They are noise in the Pass feed and the events
-- themselves remain in optix_webhook_events, so the purchase rows go.
DELETE FROM public.optix_pass_purchases WHERE event_type = 'invoice_paid';
