ALTER TABLE calendar_items
  ADD COLUMN IF NOT EXISTS account_id TEXT;

CREATE INDEX IF NOT EXISTS idx_calendar_items_account_slot
  ON calendar_items (account_id, week, day, start);

NOTIFY pgrst, 'reload schema';
