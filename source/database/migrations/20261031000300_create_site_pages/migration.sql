-- The website builder: one public landing page per business, served at
-- /<business>/site on Clarity's own hosts and at the root of any domain the
-- business has verified and pointed at Clarity.
--
--   site_pages    the page itself. `document` is the draft the coach is
--                 editing; `published_document` is what strangers see, and
--                 stays as it was until the coach publishes again. Both are
--                 the same JSON shape (see _shared/site/document.mts), cleaned
--                 on every write.
--   site_domains  a hostname the business wants the page served from. It is
--                 claimed with a token, proven by a TXT record carrying that
--                 token plus a CNAME/A record pointing at Clarity, and only
--                 then attached to the Netlify site. One hostname belongs to
--                 one business: the unique index is the whole of that rule.
--   site-media    the storage bucket uploaded images land in, public to read,
--                 written only by the functions. One folder per business.
--
-- Re-runnable.

CREATE TABLE IF NOT EXISTS public.site_pages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  slug TEXT NOT NULL DEFAULT 'home',
  document JSONB NOT NULL DEFAULT '{}'::jsonb,
  published_document JSONB,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_site_pages_account_slug
  ON public.site_pages (account_id, slug);

CREATE TABLE IF NOT EXISTS public.site_domains (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  hostname TEXT NOT NULL,
  verification_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'active', 'failed')),
  last_checked_at TIMESTAMPTZ,
  last_error TEXT,
  attached_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One business per hostname, whoever asked first. Hostnames are stored
-- lower-cased and in punycode, so a plain unique index is enough.
CREATE UNIQUE INDEX IF NOT EXISTS idx_site_domains_hostname
  ON public.site_domains (hostname);

CREATE INDEX IF NOT EXISTS idx_site_domains_account
  ON public.site_domains (account_id);

-- Nothing in the browser talks to these tables directly: every read and write
-- goes through the functions with the service role. Row level security is on
-- so the anon and authenticated roles cannot reach them through PostgREST.
ALTER TABLE public.site_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_domains ENABLE ROW LEVEL SECURITY;

-- Where uploaded images live. Public to read (they are on a public web page),
-- and only the service role writes. The functions upload through the storage
-- API with the service key, so no storage policy grants anything to anyone.
--
-- Best effort: a role without rights on the storage schema must not stop the
-- deploy, so a refusal is a notice rather than a failure. The functions make
-- the bucket through the storage API on first use if it is still missing
-- (_shared/site/media.mts).
DO $$
BEGIN
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('site-media', 'site-media', true, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
  ON CONFLICT (id) DO UPDATE
    SET public = EXCLUDED.public,
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;
EXCEPTION
  WHEN insufficient_privilege OR undefined_table THEN
    RAISE NOTICE 'site-media bucket not created here (%); the functions create it on first use', SQLERRM;
END
$$;

NOTIFY pgrst, 'reload schema';
