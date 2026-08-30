-- ON DELETE RESTRICT made every Optix-origin lesson undeletable. Removing one
-- raised 23503 against external_booking_links and the calendar refused the
-- delete, which read as "no lesson can be deleted" on any week whose bookings
-- came from Optix. CASCADE drops the pointer row along with the lesson.
--
-- History is not lost. optix_webhook_events keeps every raw inbound payload and
-- is the audit trail; external_booking_links is only the live pointer from an
-- external booking id to a Clarity item. Losing that pointer does mean a
-- replayed new_member_booking for the same id would import the lesson again --
-- deliberate, since "remove from Clarity only" does not cancel anything in
-- Optix and the booking genuinely still exists there.
--
-- Guarded and re-runnable: to_regclass skips the whole block when the table is
-- absent, and DROP CONSTRAINT IF EXISTS makes reapplying it a no-op.
DO $$
BEGIN
  IF to_regclass('public.external_booking_links') IS NOT NULL THEN
    ALTER TABLE public.external_booking_links
      DROP CONSTRAINT IF EXISTS external_booking_links_clarity_item_id_fkey;
    ALTER TABLE public.external_booking_links
      ADD CONSTRAINT external_booking_links_clarity_item_id_fkey
      FOREIGN KEY (clarity_item_id) REFERENCES public.calendar_items(id) ON DELETE CASCADE;
  END IF;
END $$;
