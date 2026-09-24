-- A player can initiate account deletion from the iOS companion app without
-- giving a client permission to destroy bookings or financial history on the
-- spot. Operations reviews the request, removes data that is not subject to a
-- retention obligation, coordinates the shared Clarity Caddy identity, and
-- records completion back on this row.

CREATE TABLE IF NOT EXISTS public.player_account_deletion_requests (
  id UUID PRIMARY KEY,
  account_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  portal_player_id TEXT,
  auth_user_id UUID,
  email TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'cancelled', 'declined')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  resolution_note TEXT NOT NULL DEFAULT ''
);

-- Repeated taps and relaunches return the same open request rather than
-- creating several pieces of work for one person.
CREATE UNIQUE INDEX IF NOT EXISTS player_account_deletion_one_open_idx
  ON public.player_account_deletion_requests (account_id, person_id)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS player_account_deletion_queue_idx
  ON public.player_account_deletion_requests (status, requested_at ASC);

ALTER TABLE public.player_account_deletion_requests ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.player_account_deletion_requests IS
  'Player-initiated privacy deletion queue. Service-role only; requests are reviewed so shared identity and legally retained records are handled safely.';

NOTIFY pgrst, 'reload schema';
