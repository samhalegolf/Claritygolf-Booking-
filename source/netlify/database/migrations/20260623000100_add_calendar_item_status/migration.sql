ALTER TABLE public.calendar_items
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'booked';

ALTER TABLE public.calendar_items
  DROP CONSTRAINT IF EXISTS calendar_items_status_check;

ALTER TABLE public.calendar_items
  ADD CONSTRAINT calendar_items_status_check
  CHECK (status IN ('booked', 'completed', 'cancelled', 'no_show'));
