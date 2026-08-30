ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS account_id TEXT;

UPDATE public.people
SET account_id = COALESCE(
  NULLIF((SELECT value FROM public.settings WHERE key = 'accountCalendarSlug' LIMIT 1), ''),
  NULLIF((SELECT value FROM public.settings WHERE key = 'accountId' LIMIT 1), ''),
  'sam-hale-golf'
)
WHERE account_id IS NULL OR BTRIM(account_id) = '';

DROP INDEX IF EXISTS public.idx_people_email_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_people_account_email_unique
  ON public.people (account_id, LOWER(email))
  WHERE email IS NOT NULL AND BTRIM(email) <> '';

CREATE INDEX IF NOT EXISTS idx_people_email_lookup
  ON public.people (LOWER(email))
  WHERE email IS NOT NULL AND BTRIM(email) <> '';

CREATE INDEX IF NOT EXISTS idx_people_account_name_lookup
  ON public.people (account_id, LOWER(name), LOWER(email), id);

NOTIFY pgrst, 'reload schema';
