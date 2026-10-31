-- The online store: goods sold from the website, in a cart.
--
-- A product the coach already catalogues under Billing › Products can be put
-- on the website's shelf. How it reaches the buyer (collected, posted or
-- downloaded), its picture, its download and its options (sizes, packs) live
-- on the product row. A sale that is posted keeps the address Stripe collected
-- and what shipping was charged.
--
-- Re-runnable.

ALTER TABLE public.billing_products_services
  ADD COLUMN IF NOT EXISTS sell_online BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fulfilment TEXT NOT NULL DEFAULT 'collect',
  ADD COLUMN IF NOT EXISTS image_url TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS download_url TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS variants JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.billing_pos_transactions
  ADD COLUMN IF NOT EXISTS shipping_amount NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shipping_address TEXT NOT NULL DEFAULT '';

NOTIFY pgrst, 'reload schema';
