# Smoke Test Report

## Source archive used

`clarity-booking-ongoing-anchor-v2-doc-patched(5).zip` was the usable ZIP.  
`clarity-booking-ongoing-anchor-v2-persistence-closeout(2).zip` was not a valid ZIP in this environment.

## Checks run

- ZIP integrity on `clarity-booking-ongoing-anchor-v2-doc-patched(5).zip`: passed.
- Required source files present: passed.
- `cd source && npm exec tsc -- --noEmit`: passed.
- `cd source && npm install`: passed.
- `cd source && npm run build`: passed.
- Built preview served `index.html` with HTTP 200 on local Vite preview: passed.
- Confirmed `calendar-state.mts` contains malformed PUT `items` guard: passed.
- Confirmed `auth-session.mts` is a thin wrapper into `booking-core.mts`: passed.
- Confirmed `notification-history.mts` is a thin wrapper into `booking-core.mts`: passed.
- Confirmed `source/netlify/functions/PERSISTENCE_MAP.md` exists: passed.

## Not tested here

These require live Netlify/Supabase environment variables and deployed functions:

- Admin login against live Supabase.
- Session refresh against live Supabase.
- Public booking write.
- Calendar save/load against live Supabase.
- People save/load against live Supabase.
- Email sending via Resend.

## Result

Ready for Netlify preview deploy after environment variables are set.

Production deploy should wait until the manual smoke checklist in `README_DEPLOY_HANDOFF.md` passes on the preview URL.

## Auth session hotfix — 23 June 2026

- Confirmed the previous package called full app seeding before every `/api/auth/*` request.
- Added auth-only startup for auth routes.
- Added an immediate `{ "authenticated": false }` response for `/api/auth/session` when no session cookie is present.
- Added an 8-second frontend timeout so the login form cannot remain stuck on “Checking session” indefinitely.
- `npm ci` passed against `https://registry.npmjs.org/`.
- `npm run build` passed.
- The bundled no-cookie `/api/auth/session` check returned `200` with `{ "authenticated": false }` in approximately 20 ms locally.
