-- Supersedes the unique index added in 20260704000100_add_people_account_scope.
--
-- An email address is a contact method, not an identity. A parent books lessons
-- for two children on one address; a club or school books for its players; a
-- couple shares an inbox. Enforcing one-person-per-email made all of those
-- impossible, and because contact rows are written in the same transaction as a
-- calendar save, a collision failed the coach's lesson save outright.
--
-- Same-person merging still happens in the application (compatiblePersonMatch),
-- which merges on a matching name plus a compatible phone or email. It never
-- merges on an email alone.
DROP INDEX IF EXISTS public.idx_people_account_email_unique;

CREATE INDEX IF NOT EXISTS idx_people_account_email_lookup
  ON public.people (account_id, lower(email))
  WHERE email IS NOT NULL AND btrim(email) <> '';
