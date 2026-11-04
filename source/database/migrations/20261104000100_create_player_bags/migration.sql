-- A player's golf bag: the clubs they carry and each one's carry distance.
--
-- One bag per person per business. The coach edits it on the player profile,
-- the player edits it in the portal, and it is kept in step with the player's
-- Clarity Caddy bag when they have a Caddy account (netlify/functions/_shared/
-- player-bag.mts).
--
-- clubs: [{ club, baseCarry, totalM }], metres, longest first -- the same row
-- shape Caddy stores, so nothing is translated on the way across.
--
-- caddy_synced_fingerprint is the bag both sides last agreed on (clubs and
-- carries, see bagFingerprint in bag-model.mts). It is what lets a sync tell
-- "Caddy changed" from "Booking changed".
--
-- Service-role only, like every other table in this app.

CREATE TABLE IF NOT EXISTS public.player_bags (
  account_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  clubs JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_by TEXT NOT NULL DEFAULT 'coach',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  caddy_synced_fingerprint TEXT,
  caddy_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, person_id),
  CONSTRAINT player_bags_updated_by_check CHECK (updated_by IN ('coach', 'player', 'caddy')),
  CONSTRAINT player_bags_clubs_array_check CHECK (jsonb_typeof(clubs) = 'array')
);

CREATE INDEX IF NOT EXISTS player_bags_person_idx ON public.player_bags (person_id);

ALTER TABLE public.player_bags ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.player_bags IS
  'A player''s golf bag, synced with Clarity Caddy. Service-role only; RLS is enabled with no client policy by design.';

NOTIFY pgrst, 'reload schema';
