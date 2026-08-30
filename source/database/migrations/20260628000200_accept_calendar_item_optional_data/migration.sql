-- Keep calendar saves tolerant of newer booking data shapes.
-- This migration is intentionally idempotent so it can be run safely against
-- older Supabase projects, restored projects, and projects that have already
-- received part of the booking schema.

ALTER TABLE calendar_items
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'booked';

ALTER TABLE calendar_items
  DROP CONSTRAINT IF EXISTS calendar_items_status_check;

ALTER TABLE calendar_items
  ADD CONSTRAINT calendar_items_status_check
  CHECK (status IN ('booked', 'completed', 'cancelled', 'no_show'));

ALTER TABLE calendar_items
  ADD COLUMN IF NOT EXISTS custom_group JSONB;

-- Make PostgREST refresh its schema cache immediately when this SQL is run
-- directly in Supabase SQL Editor.
NOTIFY pgrst, 'reload schema';
