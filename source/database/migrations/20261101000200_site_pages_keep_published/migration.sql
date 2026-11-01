-- A page the coach removes from the draft keeps its row, without a draft,
-- for as long as the public site still shows its published copy; the row
-- goes at the next publish. Until now the row went at once, and with it the
-- published page and the pictures only it still used.
--
-- Re-runnable.

ALTER TABLE public.site_pages ALTER COLUMN document DROP NOT NULL;

NOTIFY pgrst, 'reload schema';
