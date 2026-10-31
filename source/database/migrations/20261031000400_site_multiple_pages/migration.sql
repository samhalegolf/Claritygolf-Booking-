-- A website is more than one page.
--
-- The first version kept everything in one site_pages row per business: the
-- theme, header and footer alongside the home page's blocks. Now:
--
--   sites        one row per business: the parts every page shares (theme,
--                header, footer), as a draft and a published copy.
--   site_pages   one row per page, with the address, title, kind, whether it
--                sits in the menu, and its order. `document` holds only the
--                page's own content from here on.
--
-- The existing home page is carried across: its theme, header and footer
-- move into the business's sites row, and the page keeps its blocks.
--
-- Re-runnable.

CREATE TABLE IF NOT EXISTS public.sites (
  account_id TEXT PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  document JSONB NOT NULL DEFAULT '{}'::jsonb,
  published_document JSONB,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.sites ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.site_pages ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';
ALTER TABLE public.site_pages ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'page';
ALTER TABLE public.site_pages ADD COLUMN IF NOT EXISTS in_nav BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE public.site_pages ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.site_pages DROP CONSTRAINT IF EXISTS site_pages_kind_check;
ALTER TABLE public.site_pages
  ADD CONSTRAINT site_pages_kind_check CHECK (kind IN ('page', 'article'));

-- The home page's site-wide parts become the business's sites row. Only a
-- home page from the single-page version carries them (document ? 'theme').
INSERT INTO public.sites (account_id, document, published_document, published_at, created_at, updated_at)
SELECT
  account_id,
  jsonb_build_object('theme', document -> 'theme', 'header', document -> 'header', 'footer', document -> 'footer'),
  CASE
    WHEN published_document IS NULL THEN NULL
    ELSE jsonb_build_object('theme', published_document -> 'theme', 'header', published_document -> 'header', 'footer', published_document -> 'footer')
  END,
  published_at,
  created_at,
  updated_at
FROM public.site_pages
WHERE slug = 'home' AND document ? 'theme'
ON CONFLICT (account_id) DO NOTHING;

UPDATE public.site_pages
SET title = 'Home'
WHERE slug = 'home' AND title = '';

-- And the page keeps only what is its own.
UPDATE public.site_pages
SET document = document - 'theme' - 'header' - 'footer' - 'template' - 'title',
    published_document = CASE
      WHEN published_document IS NULL THEN NULL
      ELSE published_document - 'theme' - 'header' - 'footer' - 'template' - 'title'
    END
WHERE slug = 'home' AND document ? 'theme';

NOTIFY pgrst, 'reload schema';
