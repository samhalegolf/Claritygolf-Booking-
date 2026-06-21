# Clarity Booking emergency auth repair

Purpose: restore coach login/password reset/session behaviour after the live API unification patch moved auth onto the Netlify Database path.

Changes:
- Restores `/api/calendar-state` to the Supabase-backed function, matching the existing production auth/session tables.
- Replaces `/api/auth/login` with a Supabase-backed login that accepts either the current `CLARITY_ADMIN_PASSWORD` env password or a password set via reset.
- Restores `/api/auth/session` to the Supabase-backed session checker.
- Adds `/api/auth/logout` so the frontend logout call no longer 502s.
- Adds explicit `/api/auth/forgot-password` and `/api/auth/reset-password` functions backed by Supabase + Resend, so reset does not fall through to the Netlify Database booking-core path.
- Excludes auth routes from the catch-all booking API.

Build: `npm install && npm run build` passed before packaging.
