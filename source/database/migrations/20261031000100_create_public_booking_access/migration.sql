-- What lets the person who just booked act on their booking from the
-- confirmation screen: send each friend their invite, and pay online.
--
-- The page holds a random token returned with the booking; only its SHA-256 is
-- kept here. It reaches one booking and only the two things above -- it signs
-- nobody in, and it reads back nothing the booker did not just type. It lapses
-- on its own (see PUBLIC_BOOKING_ACCESS_DAYS in booking-core), so a screenshot
-- of the screen in a month's time does nothing.
--
-- Re-runnable.

CREATE TABLE IF NOT EXISTS public.public_booking_access (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  appointment_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS public_booking_access_appointment_idx
  ON public.public_booking_access (account_id, appointment_id);

ALTER TABLE public.public_booking_access ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.public_booking_access IS
  'Public booking confirmation-screen tokens (hashed). Service-role only.';

NOTIFY pgrst, 'reload schema';
