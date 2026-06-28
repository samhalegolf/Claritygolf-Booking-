ALTER TABLE calendar_items
  ADD COLUMN IF NOT EXISTS coach_id TEXT;

ALTER TABLE calendar_items
  ADD COLUMN IF NOT EXISTS location JSONB;
