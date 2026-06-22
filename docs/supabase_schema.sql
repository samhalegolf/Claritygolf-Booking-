CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS calendar_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  week INTEGER NOT NULL DEFAULT 0,
  day INTEGER NOT NULL,
  start INTEGER NOT NULL,
  duration INTEGER NOT NULL,
  service_id TEXT,
  client TEXT,
  title TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_calendar_items_slot ON calendar_items (week, day, start);

CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  notes TEXT,
  source TEXT,
  caddy_profile_id TEXT,
  caddy_profile_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_people_email_unique ON people (LOWER(email)) WHERE email IS NOT NULL AND email <> '';

CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_user ON admin_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions (expires_at);

CREATE TABLE IF NOT EXISTS admin_password_resets (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_password_resets_user ON admin_password_resets (user_id);
CREATE INDEX IF NOT EXISTS idx_admin_password_resets_expiry ON admin_password_resets (expires_at);

CREATE TABLE IF NOT EXISTS notification_history (
  id TEXT PRIMARY KEY,
  person_key TEXT,
  calendar_item_id TEXT,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT,
  provider_id TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notification_history_person ON notification_history (person_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_history_item ON notification_history (calendar_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_history_provider ON notification_history (provider_id) WHERE provider_id IS NOT NULL AND provider_id <> '';

CREATE TABLE IF NOT EXISTS notification_webhook_events (
  id TEXT PRIMARY KEY,
  provider_id TEXT,
  event_type TEXT NOT NULL,
  payload TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
