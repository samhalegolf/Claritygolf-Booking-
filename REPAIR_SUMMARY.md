# Repair summary

## Root causes

1. `calendar-state` had a second direct-Supabase implementation that diverged from `booking-core`.
2. Appointment-derived people were upserted on `id`, while production uniqueness is based on `LOWER(email)`.
3. Full replacement skipped deletion when the new item list was empty.
4. Successful save responses called `setItems`, which could retrigger autosave.
5. Rapid saves could run concurrently with stale calendar versions.
6. Quick-create fuzzy matching had no durable selected-client identity.
7. Environment bootstrap logic could overwrite a stored reset password.

## Main files changed

- `src/App.tsx`
- `netlify/functions/calendar-state.mts`
- `netlify/functions/booking-core.mts`
- `netlify/functions/booking-api.mts`
- `netlify/functions/supabase-storage.mts`
- `netlify/functions/local-db/supabase-storage.mjs`
- `netlify/functions/auth-login.mts`
- `netlify/functions/auth-reset-password.mts`
- `tests/production-reliability.test.mjs`
- `tests/calendar-state.integration.test.mjs`
- `tests/auth-flow.integration.test.mjs`
- `scripts/check-functions.mjs`


## Final validation

- 17 automated tests passed.
- Public booking generated client and admin email requests.
- Coach-created booking, reschedule and cancellation generated the correct email requests without duplicate sends on an unchanged autosave.
- Password recovery completed through forgot, reset, login, session and logout.
- 23 Netlify functions bundled and imported successfully.
- TypeScript and Vite production build passed.
- No credentials or environment files are included in the bundle.
