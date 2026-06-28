Use this prompt in Codex to apply the remaining defensive code patch.

---

Use repo `samhalegolf/Claritygolf-Booking-` on branch `codex/supabase-accepting-calendar-save`.

Goal: make Supabase calendar saves as accepting as possible without hiding data loss.

Patch only these files:

- `source/netlify/functions/calendar-state.mts`
- `source/netlify/functions/supabase-storage.mts`
- `source/netlify/functions/local-db/supabase-storage.mjs`

Do not change UI.
Do not touch invoicing.
Do not change public booking copy.
Do not remove Google Calendar sync or notification behaviour.

Problem:

Admin lesson saves can fail if the app sends optional `calendar_items` columns that are missing from Supabase or not yet visible in the PostgREST schema cache. Known optional columns are `status` and `custom_group`.

Requirements:

1. Add a helper around `calendar_items` upserts.
2. Always try the full row payload first.
3. If Supabase reports a missing optional calendar item column, retry after omitting only that optional column.
4. Continue saving core lesson fields: `id`, `kind`, `week`, `day`, `start`, `duration`, `service_id`, `client`, `title`, `phone`, `email`, `note`, `created_at`, `updated_at`.
5. Do not swallow unrelated database errors.
6. Return/push a warning when fallback omission was used, so the admin can see that optional data was not fully preserved.
7. Mirror the fallback in both Supabase adapter files so public booking / booking-core writes do not fail for the same reason.
8. Keep the existing idempotent migration and production SQL file in the branch.

Implementation notes:

- In `calendar-state.mts`, replace the direct `supabase("calendar_items", { method: "POST", ... })` call inside `writeState` with `await upsertCalendarItemRows(rows, warnings)`.
- In `supabase-storage.mts` and `local-db/supabase-storage.mjs`, replace the direct `this.upsert("calendar_items", [calendarItemFromParams(values)], "id")` path with `this.upsertCalendarItemRows(...)`.
- Use missing-column detection based on the Supabase error message and only for `status` and `custom_group`.
- Run `npm run build` from `source/` after patching.

Expected manual smoke test:

1. Sign into admin.
2. Create one normal private lesson.
3. Confirm `Not saved` clears.
4. Refresh and confirm the lesson persists.
5. Move the lesson once and confirm it persists again.
6. Test a custom group booking if available.
