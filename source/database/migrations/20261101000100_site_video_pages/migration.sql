-- A page may be a video: a YouTube link played above its blocks, listed by a
-- Videos block. The kinds a page may have were fixed when articles arrived;
-- this lets the third kind through.
--
-- Re-runnable.

ALTER TABLE public.site_pages DROP CONSTRAINT IF EXISTS site_pages_kind_check;
ALTER TABLE public.site_pages
  ADD CONSTRAINT site_pages_kind_check CHECK (kind IN ('page', 'article', 'video'));

NOTIFY pgrst, 'reload schema';
