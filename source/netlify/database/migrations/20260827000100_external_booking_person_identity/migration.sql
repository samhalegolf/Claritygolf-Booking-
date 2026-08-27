-- Reuse a provider-issued customer identity across multiple imported bookings.
--
-- Booking ownership stays on provider + external_booking_id. These columns are
-- only about which person a provider-side customer was linked to, so later
-- Optix bookings for that same customer can reuse the same person_id without
-- guessing from the name again.
ALTER TABLE public.external_booking_links
  ADD COLUMN IF NOT EXISTS provider_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS person_link_source TEXT;

CREATE INDEX IF NOT EXISTS external_booking_links_provider_customer_idx
  ON public.external_booking_links (provider, purpose, provider_customer_id)
  WHERE provider_customer_id IS NOT NULL AND provider_customer_id <> '';
