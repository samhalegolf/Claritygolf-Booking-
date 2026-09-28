-- Clarity's public API: the way other software talks to a business in Clarity.
--
-- Four tables, modelled on how Stripe, Square and Cal.com do it:
--
--   api_keys                 a secret a business gives to another system.
--                            Only a SHA-256 hash is kept; the key itself is
--                            shown once, when it is made, and never again.
--   api_events               everything that happened, in order. One row per
--                            change (booking.created, client.updated...). It is
--                            both the feed behind GET /api/v1/events and the
--                            thing webhooks deliver.
--   api_webhook_endpoints    URLs a business wants events POSTed to. The
--                            signing secret is AES-256-GCM sealed like the
--                            other integration credentials.
--   api_webhook_deliveries   one row per (event, endpoint): the attempt log,
--                            and the retry queue a scheduled worker drains.
--
-- Plus two small working tables: idempotency (so a retried POST does not book
-- twice) and a per-key request counter for rate limiting.
--
-- Everything is server-only: RLS on, no grants to anon/authenticated. Every
-- read and write goes through the authenticated functions.
-- Re-runnable.

CREATE TABLE IF NOT EXISTS public.api_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  -- 'live' for a real business, 'test' for its sandbox. Part of the key's
  -- prefix too (ck_live_ / ck_test_), so a key says which one it is.
  mode TEXT NOT NULL DEFAULT 'live' CHECK (mode IN ('live', 'test')),
  key_hash TEXT NOT NULL UNIQUE,
  -- What can be shown again: the prefix and the last four characters.
  key_hint TEXT NOT NULL DEFAULT '',
  scopes TEXT[] NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS api_keys_account_idx ON public.api_keys (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.api_events (
  id TEXT PRIMARY KEY,
  -- Monotonic, so the events feed can page by "everything after this one"
  -- without two events in the same millisecond swapping places.
  seq BIGSERIAL UNIQUE,
  account_id TEXT NOT NULL,
  type TEXT NOT NULL,
  object_type TEXT NOT NULL DEFAULT '',
  object_id TEXT NOT NULL DEFAULT '',
  data JSONB NOT NULL,
  -- Where the change came from: 'api', 'app', 'booking_page', 'integration'.
  source TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS api_events_account_seq_idx ON public.api_events (account_id, seq);
CREATE INDEX IF NOT EXISTS api_events_account_type_idx ON public.api_events (account_id, type, seq);
CREATE INDEX IF NOT EXISTS api_events_object_idx ON public.api_events (account_id, object_type, object_id, seq);

CREATE TABLE IF NOT EXISTS public.api_webhook_endpoints (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- '*' means every event type, now and future.
  events TEXT[] NOT NULL DEFAULT '{*}',
  secret_sealed TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- Set when repeated failures switched it off, so the screen can say why.
  disabled_reason TEXT NOT NULL DEFAULT '',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  -- Which key created it through the API (REST hooks, e.g. Zapier), if any.
  created_by_key_id TEXT,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS api_webhook_endpoints_account_idx
  ON public.api_webhook_endpoints (account_id);

CREATE TABLE IF NOT EXISTS public.api_webhook_deliveries (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL REFERENCES public.api_webhook_endpoints(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES public.api_events(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'succeeded', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claim_expires_at TIMESTAMPTZ,
  last_status_code INTEGER,
  last_error TEXT NOT NULL DEFAULT '',
  last_response_excerpt TEXT NOT NULL DEFAULT '',
  last_attempt_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (endpoint_id, event_id)
);

CREATE INDEX IF NOT EXISTS api_webhook_deliveries_due_idx
  ON public.api_webhook_deliveries (next_attempt_at)
  WHERE status IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS api_webhook_deliveries_endpoint_idx
  ON public.api_webhook_deliveries (endpoint_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.api_idempotency_keys (
  key_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER,
  response_body TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (key_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS api_idempotency_keys_created_idx ON public.api_idempotency_keys (created_at);

CREATE TABLE IF NOT EXISTS public.api_rate_limits (
  key_id TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, window_start)
);

-- ---------------------------------------------------------------------------
-- Change capture: how events are born
-- ---------------------------------------------------------------------------
--
-- Bookings and clients are written from many places: the coach calendar, the
-- booking page, the public cancel page, the Google import, Optix, the API
-- itself. Asking each of them to remember to announce its change is how an
-- event gets missed. So the database announces it instead: a trigger on each
-- table writes one row here, inside the same transaction as the change. If the
-- change commits, so does its record; if it rolls back, there is nothing to
-- announce. (This is the "transactional outbox" pattern.)
--
-- A scheduled worker (api-webhook-worker) turns these raw rows into
-- api_events and queues their webhook deliveries.

CREATE TABLE IF NOT EXISTS public.api_change_log (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  op TEXT NOT NULL,
  row_id TEXT NOT NULL,
  old_row JSONB,
  new_row JSONB,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS api_change_log_pending_idx
  ON public.api_change_log (id) WHERE processed_at IS NULL;

ALTER TABLE public.api_change_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.api_change_log FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.api_capture_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  old_json JSONB;
  new_json JSONB;
  account TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_json := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN new_json := to_jsonb(NEW); END IF;

  -- Blocks and time off are not bookings.
  IF TG_TABLE_NAME = 'calendar_items'
     AND COALESCE(new_json->>'kind', old_json->>'kind') IS DISTINCT FROM 'appointment' THEN
    RETURN NULL;
  END IF;

  -- A save that rewrote a row without changing it (the calendar's whole-state
  -- save does this to every row) is not a change. Nor is sync bookkeeping.
  IF TG_OP = 'UPDATE'
     AND (old_json - 'updated_at' - 'external_sync_state')
       = (new_json - 'updated_at' - 'external_sync_state') THEN
    RETURN NULL;
  END IF;

  account := COALESCE(NULLIF(new_json->>'account_id', ''), NULLIF(old_json->>'account_id', ''));
  IF account IS NULL THEN RETURN NULL; END IF;

  BEGIN
    INSERT INTO public.api_change_log (account_id, table_name, op, row_id, old_row, new_row)
    VALUES (account, TG_TABLE_NAME, TG_OP, COALESCE(new_json->>'id', old_json->>'id'), old_json, new_json);
  EXCEPTION WHEN OTHERS THEN
    -- Never let the announcement break the booking. A missed event is a bug to
    -- fix; a booking that will not save is an outage.
    RAISE WARNING 'api_capture_change failed for %.%: %', TG_TABLE_NAME, TG_OP, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.api_capture_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS api_capture_calendar_items ON public.calendar_items;
CREATE TRIGGER api_capture_calendar_items
  AFTER INSERT OR UPDATE OR DELETE ON public.calendar_items
  FOR EACH ROW EXECUTE FUNCTION public.api_capture_change();

DROP TRIGGER IF EXISTS api_capture_people ON public.people;
CREATE TRIGGER api_capture_people
  AFTER INSERT OR UPDATE OR DELETE ON public.people
  FOR EACH ROW EXECUTE FUNCTION public.api_capture_change();

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.api_keys FROM anon, authenticated;
REVOKE ALL ON TABLE public.api_events FROM anon, authenticated;
REVOKE ALL ON TABLE public.api_webhook_endpoints FROM anon, authenticated;
REVOKE ALL ON TABLE public.api_webhook_deliveries FROM anon, authenticated;
REVOKE ALL ON TABLE public.api_idempotency_keys FROM anon, authenticated;
REVOKE ALL ON TABLE public.api_rate_limits FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';
