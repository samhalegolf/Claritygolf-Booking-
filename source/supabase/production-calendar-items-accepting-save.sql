-- Run this in the production Supabase SQL Editor when admin calendar saves
-- show `Not saved` after creating or moving a lesson.
-- It is safe to run more than once.

alter table public.calendar_items
  add column if not exists status text not null default 'booked';

alter table public.calendar_items
  drop constraint if exists calendar_items_status_check;

alter table public.calendar_items
  add constraint calendar_items_status_check
  check (status in ('booked', 'completed', 'cancelled', 'no_show'));

alter table public.calendar_items
  add column if not exists custom_group jsonb;

notify pgrst, 'reload schema';
