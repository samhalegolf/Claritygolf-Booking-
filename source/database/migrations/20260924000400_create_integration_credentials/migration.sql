-- Per-business credentials for the integrations a coach connects themselves
-- (Optix, Akahu, Stripe's webhook secret). Until now these lived only in the
-- deployment's environment, which meant exactly one business -- the original
-- workspace -- could ever connect them, and every other business either saw
-- that business's connection or had none.
--
-- One row per (business, integration, field). Values are AES-256-GCM
-- ciphertext (see _shared/integration-credentials.mts); nothing here is
-- readable without the encryption key held in the function environment.
-- Re-runnable: see the two-ledger note in scripts/migrate.mjs.

CREATE TABLE IF NOT EXISTS public.integration_credentials (
  account_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  field_key TEXT NOT NULL,
  encrypted_value_json TEXT NOT NULL,
  value_length INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT NOT NULL DEFAULT '',
  -- A non-secret field (an endpoint, a member id) is stored encrypted like the
  -- rest, but may be shown back to the coach who saved it.
  is_secret BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, integration_id, field_key)
);

CREATE INDEX IF NOT EXISTS integration_credentials_by_integration_idx
  ON public.integration_credentials (integration_id, account_id);

ALTER TABLE public.integration_credentials ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.integration_credentials IS
  'Encrypted per-business integration credentials. Service-role only; values are AES-256-GCM ciphertext.';

NOTIFY pgrst, 'reload schema';
