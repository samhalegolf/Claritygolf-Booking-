CREATE TABLE IF NOT EXISTS public.google_provider_connections (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'google',
  provider_user_id TEXT,
  provider_email TEXT,
  encrypted_refresh_token_json TEXT NOT NULL,
  encrypted_refresh_token_version INTEGER NOT NULL DEFAULT 1,
  granted_scopes_json TEXT NOT NULL DEFAULT '[]',
  calendar_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  drive_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  connection_status TEXT NOT NULL DEFAULT 'connected',
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_token_refresh_at TIMESTAMPTZ,
  last_successful_use_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_at TIMESTAMPTZ,
  CONSTRAINT google_provider_connections_provider_check CHECK (provider = 'google'),
  CONSTRAINT google_provider_connections_status_check CHECK (
    connection_status IN ('connected', 'reconnect_required', 'disconnected', 'revoked', 'error')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_google_provider_connections_account_provider
  ON public.google_provider_connections (account_id, provider);

CREATE INDEX IF NOT EXISTS idx_google_provider_connections_status
  ON public.google_provider_connections (connection_status);

ALTER TABLE public.google_provider_connections ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
