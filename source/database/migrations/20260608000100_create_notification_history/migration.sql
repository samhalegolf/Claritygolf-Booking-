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

CREATE INDEX IF NOT EXISTS idx_notification_history_person
  ON notification_history (person_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_history_item
  ON notification_history (calendar_item_id, created_at DESC);
