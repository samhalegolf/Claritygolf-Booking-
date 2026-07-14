-- calendar_items never received the account_id column that people got in
-- 20260704000100. Every read therefore attempted an account-scoped query, hit
-- "column calendar_items.account_id does not exist", logged an error and fell
-- back to an unscoped query — costing a failed round trip on every request.
--
-- The column must be added and backfilled in the same transaction: once it
-- exists, the scoped read stops falling back, so any row left with a NULL
-- account_id would silently disappear from the calendar.
ALTER TABLE public.calendar_items
  ADD COLUMN IF NOT EXISTS account_id TEXT;

UPDATE public.calendar_items
SET account_id = COALESCE(
  (SELECT value FROM public.settings WHERE key = 'peopleAccountId'),
  'sam-hale-golf'
)
WHERE account_id IS NULL OR BTRIM(account_id) = '';

-- Default guarantees future inserts from any code path stay visible to the
-- account-scoped reads even if the caller forgets to supply it.
ALTER TABLE public.calendar_items
  ALTER COLUMN account_id SET DEFAULT 'sam-hale-golf';

CREATE INDEX IF NOT EXISTS idx_calendar_items_account
  ON public.calendar_items (account_id);
