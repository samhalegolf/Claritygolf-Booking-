# Clarity Booking Admin Settings / Lesson Persistence Fix

This bundle is for the **Clarity Booking** app/site, not Clarity Caddie.

It keeps the existing Supabase project approach. You do not need separate Supabase projects for Booking and Caddie as long as the Booking app has the tables in `supabase/booking-schema.sql` and the Netlify site points at the right Supabase URL/service role key.

## What Changed

- `/api/admin-settings` is handled by a dedicated Supabase-backed Netlify Function.
- `GET`, `PUT`, and `POST /api/admin-settings` return JSON instead of falling through to the old catch-all route.
- Admin/email/text settings saves are merge-safe, so partial payloads do not reset missing saved values.
- Calendar lesson writes are upsert-first.
- Missing/empty `items` payloads do not delete existing lessons.
- Full calendar replacement now requires an explicit `replaceItems: true` or `itemsOperation: "replace"` payload.
- Clearing every lesson still requires `clearItems: true`.
- Email sending respects `EMAIL_NOTIFICATIONS_ENABLED=0` as a hard production safety switch.

## Supabase

Run `supabase/booking-schema.sql` once in the Supabase project used by Clarity Booking if those tables do not already exist.

## Required Netlify environment variables

Production needs:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `EMAIL_NOTIFICATIONS_ENABLED=0` while migration/testing should not send email

`SUPABASE_SERVICE_ROLE_KEY` must be the real service role key, not the anon/public key.

Leave `CLARITY_ADMIN_EMAIL` alone unless you intend to change the admin login identity.

## First Checks After Deploy

1. `GET /api/public-booking-state?debug=ping` returns 200 JSON.
2. `GET /api/admin-settings` returns 200 JSON while logged in as admin.
3. `POST /api/admin-settings` persists the changed settings while logged in as admin.
4. Create a test lesson, refresh, and confirm it stays.
5. Save unrelated settings and confirm existing lessons are not removed.
6. Keep `EMAIL_NOTIFICATIONS_ENABLED=0` until real email sending is approved.
