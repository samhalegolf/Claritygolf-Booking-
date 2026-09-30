-- "Remember me on this device" for the public booking page and widget.
--
-- The browser keeps a random token; only its SHA-256 is stored here. The token
-- does not sign anyone in or reveal anything -- the page keeps its own copy of
-- the details it prefills. All it does is let the next booking from that
-- browser land on the same client record, even if an email or phone changed.
--
-- The token points at the latest booking it made rather than straight at a
-- person, because the person is resolved after the booking is saved and
-- because a client merge moves calendar_items.person_id to the survivor: the
-- link follows the merge without this table being touched. person_id is a
-- fallback for when that booking has since been deleted. Re-runnable.

CREATE TABLE IF NOT EXISTS public.public_booking_remembered (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  appointment_id TEXT NOT NULL,
  person_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS public_booking_remembered_person_idx
  ON public.public_booking_remembered (account_id, person_id);

ALTER TABLE public.public_booking_remembered ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.public_booking_remembered IS
  'Public booking "remember me" tokens (hashed). Service-role only.';

NOTIFY pgrst, 'reload schema';
