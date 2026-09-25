-- The Clarity resource (bay, room) a lesson holds, when its location keeps its
-- own resources. Written only by the server's resource assignment, never by a
-- calendar save, so a stale client cannot hand a bay back to itself.
ALTER TABLE calendar_items
  ADD COLUMN IF NOT EXISTS resource_id TEXT;

NOTIFY pgrst, 'reload schema';
