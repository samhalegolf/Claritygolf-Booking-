ALTER TABLE calendar_items
  ADD COLUMN IF NOT EXISTS custom_group JSONB;
