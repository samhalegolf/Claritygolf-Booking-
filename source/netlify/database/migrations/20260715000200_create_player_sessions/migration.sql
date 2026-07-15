-- Player portal sessions. Players authenticate with the same email+phone bar
-- already used by public reschedule (verifyPlayerContact in booking-core.mts),
-- upgraded to a real server session so their identity survives navigation and
-- can gate player-scoped read endpoints. This is a separate space from
-- admin_sessions (distinct cookie: clarity_player_session).
--
-- The application self-creates this table at runtime (ensurePlayerSessionsTable),
-- matching the notification-table pattern; this file is the schema record.

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

CREATE INDEX IF NOT EXISTS idx_player_sessions_token
  ON player_sessions (token_hash);

CREATE INDEX IF NOT EXISTS idx_player_sessions_expires
  ON player_sessions (expires_at);
