-- How a purchase came to be attached to its client.
--
-- Optix product sales carry a display name and no email, so email matching —
-- the only auto-match Clarity allowed — could never reach them and every sale
-- stayed unlinked. Matching on a uniquely-held name closes that gap, but it is
-- a weaker claim than an email match and must never be mistaken for one.
--
--   email  the buyer's address matched exactly one client
--   name   no email in the payload; exactly one client carries that name
--   new    neither matched, so a fresh external booking client was filed
--
-- NULL means the row predates this column. The 13 rows already here are all
-- unlinked except OPTIX-00660, which was attached to Cindi Yu by hand on
-- 20 Aug 2026 — recorded as 'manual' so it is not read as an automatic match.
ALTER TABLE public.optix_pass_purchases
  ADD COLUMN IF NOT EXISTS person_link_source TEXT;

UPDATE public.optix_pass_purchases
SET person_link_source = 'manual'
WHERE person_id IS NOT NULL AND person_link_source IS NULL;
