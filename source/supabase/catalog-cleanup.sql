-- Catalog cleanup: the products table holds products, nothing else.
-- Applied 2026-08-16 as migration `catalog_products_only`.
--
-- Why
-- ---
-- billing_products_services had 98 rows, 97 of them kind = 'service' and almost
-- all mirrored in from Stripe by syncAllProducts(), which backfilled every
-- Stripe product ever created. Stripe makes a product for every ad-hoc invoice
-- line, so the catalog filled up with "Golf Coaching" at nine different prices
-- and "1 Hour Lesson - Andrew Lane" twice. It stopped being a list of what is
-- for sale.
--
-- Nothing depended on those rows: billing_invoice_items stores a Stripe *price*
-- id in source_id plus its own description and amount, so every historical
-- invoice renders without them. Verified before deleting - zero invoice items
-- reference a product id.
--
-- The mirror is gone too (see netlify/functions/_shared/stripe-billing.mts).
-- Deleting these rows without removing it would only have bought time until the
-- next backfill.
--
-- What replaces the services
-- --------------------------
-- The coach's lesson types, read from settings.servicesJson by
-- lessonTypeItems() in billing-api.mts and merged into GET /api/billing/products
-- on the way out. A lesson price now exists in exactly one place: the lesson
-- type that the booking screen charges from.

begin;

-- Reversible for as long as this table is kept. Restore with:
--   insert into billing_products_services
--   select * from billing_products_services_backup_20260816;
create table if not exists billing_products_services_backup_20260816 as
select * from billing_products_services;

comment on table billing_products_services_backup_20260816 is
  'Pre-cleanup snapshot of billing_products_services (2026-08-16), before the Stripe-mirrored service rows were deleted. Restore: INSERT INTO billing_products_services SELECT * FROM billing_products_services_backup_20260816;';

-- The four rows that are real things on a shelf or a real gift voucher. Every
-- other row was a Stripe artefact of a past invoice.
--   prod_NR3gbmrRfosxN5  1 Hour Golf Lesson Voucher  - needed by the coupon import
--   prod_OSSqPf6u3VM6kN  SHG Website Voucher         - needed by the coupon import
--   prod_TQP11XloM99AyU  Midsize Grip
--   fb51deb4-…           Z Grip-Midsize              - the only hand-made row
update billing_products_services
   set kind = 'product',
       updated_at = now()
 where id in ('prod_NR3gbmrRfosxN5', 'prod_OSSqPf6u3VM6kN', 'prod_TQP11XloM99AyU')
   and kind <> 'product';

delete from billing_products_services
 where kind <> 'product';

-- Now that services live with the lesson types, a non-product row in here would
-- be a second copy of one - which is the thing that caused all of this. The
-- database says so as well as the API.
alter table billing_products_services
  drop constraint if exists billing_products_services_kind_check;

alter table billing_products_services
  add constraint billing_products_services_kind_check check (kind = 'product');

commit;
