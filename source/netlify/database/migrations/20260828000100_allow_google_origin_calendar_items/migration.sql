-- Let the Google busy import actually write its rows.
--
-- The import stamps origin = 'google' so the UI can make the block read-only
-- and the outbound sync knows never to push it back. But the origin check
-- constraint only ever listed 'clarity' and 'optix', so Postgres rejected every
-- imported block from the day the import was written.
--
-- The failure was invisible: the sync wraps the import in a try/catch to keep a
-- Golf HQ read failure from reporting the whole sync as broken, and the error
-- string it produced was returned to a caller that ignored it. Every sync said
-- "success" while the import wrote nothing at all. The sync now records a
-- failed debug entry when the import throws, so the next one this shape shows
-- up in the Sync debug window instead of hiding.

alter table calendar_items drop constraint if exists calendar_items_origin_check;

alter table calendar_items
  add constraint calendar_items_origin_check
  check (origin = any (array['clarity'::text, 'optix'::text, 'google'::text]));
