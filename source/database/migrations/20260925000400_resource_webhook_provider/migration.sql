-- The generic webhook resource provider (see _shared/resource-webhook.mts).
--
-- Its holds live in the same ledger as Optix's, told apart by provider =
-- 'webhook'. Their system names the bay it held ("Bay 7"); Optix bays were
-- named from a fixed list in code, which a venue we have never seen cannot
-- use, so the name is stored with the hold.

ALTER TABLE public.optix_booking_sync
  ADD COLUMN IF NOT EXISTS resource_name TEXT;

NOTIFY pgrst, 'reload schema';
