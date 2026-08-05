-- The booking type as the external source words it, e.g. Optix "Swing Analysis".
-- Clarity shows this instead of the mapped service name, so an external booking
-- keeps its own wording while still being filed under a Clarity service for
-- duration, pricing and reporting. An inbound event writes only this column and
-- never the Clarity service catalogue.
ALTER TABLE public.calendar_items
  ADD COLUMN IF NOT EXISTS external_booking_type_name TEXT;
