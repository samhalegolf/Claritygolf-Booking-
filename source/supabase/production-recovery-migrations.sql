-- Clarity Golf Booking production schema alignment
-- Safe to run more than once in the Supabase SQL editor.

ALTER TABLE public.calendar_items
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'booked';

ALTER TABLE public.calendar_items
  DROP CONSTRAINT IF EXISTS calendar_items_status_check;

ALTER TABLE public.calendar_items
  ADD CONSTRAINT calendar_items_status_check
  CHECK (status IN ('booked', 'completed', 'cancelled', 'no_show'));

-- Email is a shared contact channel, not a globally unique person identity.
DROP INDEX IF EXISTS public.idx_people_email_unique;

CREATE INDEX IF NOT EXISTS idx_people_email_lookup
  ON public.people (LOWER(email))
  WHERE email IS NOT NULL AND email <> '';

CREATE INDEX IF NOT EXISTS idx_people_name_phone_lookup
  ON public.people (LOWER(name), phone)
  WHERE phone IS NOT NULL AND phone <> '';
