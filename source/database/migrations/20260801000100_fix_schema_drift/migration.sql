-- Bring the live booking schema up to what the direct Postgres code expects.
-- Additive and idempotent so it is safe to re-run.

ALTER TABLE calendar_items ADD COLUMN IF NOT EXISTS coach_id TEXT;
ALTER TABLE calendar_items ADD COLUMN IF NOT EXISTS location_id TEXT;
ALTER TABLE calendar_items ADD COLUMN IF NOT EXISTS coach JSONB;
ALTER TABLE calendar_items ADD COLUMN IF NOT EXISTS location JSONB;

CREATE TABLE IF NOT EXISTS player_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  person_id TEXT,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  account_id TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_player_sessions_token ON player_sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_player_sessions_expires ON player_sessions (expires_at);

CREATE TABLE IF NOT EXISTS optix_booking_sync (
  calendar_item_id TEXT PRIMARY KEY,
  optix_booking_id TEXT,
  optix_booking_session_id TEXT,
  resource_id TEXT,
  start_timestamp BIGINT,
  end_timestamp BIGINT,
  fingerprint TEXT,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  error_code TEXT,
  error_message TEXT,
  last_attempted_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_optix_booking_sync_status
  ON optix_booking_sync (sync_status, updated_at DESC);
