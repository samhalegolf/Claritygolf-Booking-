-- Contact emails are not globally unique identities. Multiple clients may
-- legitimately share a family, school, club or organisation email address.
DROP INDEX IF EXISTS public.idx_people_email_unique;

CREATE INDEX IF NOT EXISTS idx_people_email_lookup
  ON public.people (LOWER(email))
  WHERE email IS NOT NULL AND email <> '';

CREATE INDEX IF NOT EXISTS idx_people_name_phone_lookup
  ON public.people (LOWER(name), phone)
  WHERE phone IS NOT NULL AND phone <> '';
