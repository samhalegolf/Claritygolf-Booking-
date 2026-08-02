-- Optix-origin foundation. Apply through the existing Supabase migration process.

ALTER TABLE calendar_items
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'clarity',
  ADD COLUMN IF NOT EXISTS external_provider TEXT,
  ADD COLUMN IF NOT EXISTS external_booking_id TEXT,
  ADD COLUMN IF NOT EXISTS external_booking_session_id TEXT,
  ADD COLUMN IF NOT EXISTS external_resource_id TEXT,
  ADD COLUMN IF NOT EXISTS external_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS external_sync_state TEXT,
  ADD COLUMN IF NOT EXISTS external_payload_version TEXT;

ALTER TABLE calendar_items
  DROP CONSTRAINT IF EXISTS calendar_items_origin_check;
ALTER TABLE calendar_items
  ADD CONSTRAINT calendar_items_origin_check
  CHECK (origin IN ('clarity', 'optix'));

CREATE UNIQUE INDEX IF NOT EXISTS calendar_items_external_booking_unique
  ON calendar_items (external_provider, external_booking_id)
  WHERE external_provider IS NOT NULL AND external_booking_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS external_booking_links (
  provider TEXT NOT NULL,
  external_booking_id TEXT NOT NULL,
  clarity_item_id TEXT NOT NULL REFERENCES calendar_items(id) ON DELETE RESTRICT,
  origin TEXT NOT NULL CHECK (origin IN ('clarity', 'optix')),
  external_booking_session_id TEXT,
  external_resource_id TEXT,
  external_updated_at TIMESTAMPTZ,
  external_payload_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, external_booking_id),
  UNIQUE (provider, clarity_item_id)
);

CREATE INDEX IF NOT EXISTS external_booking_links_clarity_item_idx
  ON external_booking_links (clarity_item_id);

CREATE TABLE IF NOT EXISTS optix_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT,
  external_booking_id TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload_json JSONB NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'stored'
    CHECK (processing_status IN ('stored', 'processing', 'processed', 'failed', 'ignored')),
  processed_at TIMESTAMPTZ,
  error_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS optix_webhook_events_status_received_idx
  ON optix_webhook_events (processing_status, received_at);
CREATE INDEX IF NOT EXISTS optix_webhook_events_booking_idx
  ON optix_webhook_events (external_booking_id);

-- Optix-origin Swing Analysis appointments intentionally remain eligible for
-- the existing manual Book resource flow. Their inbound lesson booking ID is
-- held by external_booking_links; the separate outbound bay booking ID is held
-- by optix_booking_sync.
DO $$ BEGIN
  IF to_regclass('public.optix_booking_sync') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS guard_optix_origin_resource_booking ON optix_booking_sync;
  END IF;
END $$;
DROP FUNCTION IF EXISTS reject_optix_origin_resource_booking();
