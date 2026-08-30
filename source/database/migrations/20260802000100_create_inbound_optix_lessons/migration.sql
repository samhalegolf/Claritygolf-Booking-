-- Inbound Optix lessons. Disabled until an admin selects a service/location.
ALTER TABLE public.calendar_items
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'clarity',
  ADD COLUMN IF NOT EXISTS external_provider TEXT,
  ADD COLUMN IF NOT EXISTS external_booking_id TEXT,
  ADD COLUMN IF NOT EXISTS external_workspace_id TEXT,
  ADD COLUMN IF NOT EXISTS external_organisation_id TEXT,
  ADD COLUMN IF NOT EXISTS external_event_type TEXT,
  ADD COLUMN IF NOT EXISTS external_source TEXT,
  ADD COLUMN IF NOT EXISTS external_sync_state TEXT,
  ADD COLUMN IF NOT EXISTS external_updated_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS calendar_items_inbound_external_unique
  ON public.calendar_items (external_provider, external_booking_id)
  WHERE external_provider IS NOT NULL AND external_booking_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.external_booking_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), provider TEXT NOT NULL,
  organisation_id TEXT NOT NULL DEFAULT '', workspace_id TEXT NOT NULL,
  workspace_name TEXT NOT NULL DEFAULT '', account_id TEXT NOT NULL DEFAULT 'sam-hale-golf',
  service_id TEXT NOT NULL DEFAULT '', service_name TEXT NOT NULL DEFAULT '',
  location_id TEXT NOT NULL DEFAULT '', default_coach_id TEXT, enabled BOOLEAN NOT NULL DEFAULT FALSE,
  expected_duration INTEGER, bay_profile_id TEXT,
  email_behaviour TEXT NOT NULL DEFAULT 'none' CHECK (email_behaviour IN ('none', 'immediate', 'after_bay')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, organisation_id, workspace_id)
);

INSERT INTO public.external_booking_mappings (provider, organisation_id, workspace_id, workspace_name, enabled, email_behaviour)
VALUES ('optix', '', '637949', 'Swing Analysis', FALSE, 'none')
ON CONFLICT (provider, organisation_id, workspace_id) DO UPDATE SET workspace_name = EXCLUDED.workspace_name;

CREATE TABLE IF NOT EXISTS public.external_booking_links (
  provider TEXT NOT NULL, external_booking_id TEXT NOT NULL,
  clarity_item_id TEXT NOT NULL REFERENCES public.calendar_items(id) ON DELETE RESTRICT,
  origin TEXT NOT NULL DEFAULT 'optix', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.external_booking_links
  ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'lesson',
  ADD COLUMN IF NOT EXISTS person_id TEXT, ADD COLUMN IF NOT EXISTS workspace_id TEXT,
  ADD COLUMN IF NOT EXISTS organisation_id TEXT, ADD COLUMN IF NOT EXISTS processing_status TEXT,
  ADD COLUMN IF NOT EXISTS email_status TEXT NOT NULL DEFAULT 'suppressed',
  ADD COLUMN IF NOT EXISTS confirmation_sent_at TIMESTAMPTZ;
ALTER TABLE public.external_booking_links DROP CONSTRAINT IF EXISTS external_booking_links_pkey;
ALTER TABLE public.external_booking_links ADD CONSTRAINT external_booking_links_pkey PRIMARY KEY (provider, purpose, external_booking_id);
CREATE INDEX IF NOT EXISTS external_booking_links_item_idx ON public.external_booking_links (clarity_item_id);

CREATE TABLE IF NOT EXISTS public.optix_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_key TEXT NOT NULL UNIQUE, event_type TEXT,
  external_booking_id TEXT, received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), payload_json JSONB NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'received', processed_at TIMESTAMPTZ, failure_code TEXT,
  error_message TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, clarity_item_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.optix_webhook_events ADD COLUMN IF NOT EXISTS failure_code TEXT, ADD COLUMN IF NOT EXISTS clarity_item_id TEXT;
ALTER TABLE public.optix_webhook_events DROP CONSTRAINT IF EXISTS optix_webhook_events_processing_status_check;
ALTER TABLE public.optix_webhook_events ADD CONSTRAINT optix_webhook_events_processing_status_check
  CHECK (processing_status IN ('received', 'stored', 'processing', 'processed', 'failed', 'ignored'));

-- The inbound lesson ID stays in external_booking_links; the outbound bay ID
-- stays in optix_booking_sync. Optix-origin lessons must use the manual flow.
DROP TRIGGER IF EXISTS guard_optix_origin_resource_booking ON public.optix_booking_sync;
DROP FUNCTION IF EXISTS reject_optix_origin_resource_booking();
