-- Clarity Terminal pairing: no more long links to type.
--
-- The camera computer opens /terminal and shows a short code. The coach types
-- that code into Settings when adding the terminal, and the computer is handed
-- its real credential (camera_terminals.code), which it keeps in its own
-- storage from then on.
--
-- The short code is only ever accepted from a signed-in coach, so it cannot be
-- guessed from outside. The computer waits on pair_token, a long secret only it
-- holds, so nobody else can collect the credential. A pairing lives ten
-- minutes; the terminal asks for a new one when it runs out.
--
-- Service-role only, like every other table here: RLS on, no client policy.

CREATE TABLE IF NOT EXISTS public.camera_terminal_pairings (
  pair_code TEXT PRIMARY KEY,
  pair_token TEXT NOT NULL UNIQUE,
  -- Set once a coach claims the code: the credential to hand the computer.
  terminal_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS camera_terminal_pairings_expires_idx
  ON public.camera_terminal_pairings (expires_at);

ALTER TABLE public.camera_terminal_pairings ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.camera_terminal_pairings IS
  'Clarity Terminal pairing: a short code shown on the camera computer, claimed by a signed-in coach. Service-role only; RLS enabled with no client policy by design.';

NOTIFY pgrst, 'reload schema';
