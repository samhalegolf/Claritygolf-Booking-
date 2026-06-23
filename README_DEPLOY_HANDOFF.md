# Clarity Golf Booking — GitHub/Netlify Handover

This package is prepared for a GitHub repository and Netlify preview deploy.

## Active app

The active application is inside `source/`.

Root-level duplicate app copies from older archives have been intentionally omitted from this handover package.

## Netlify setup

This package includes a root `netlify.toml` that sets:

- Base directory: `source`
- Build command: `npm run build`
- Publish directory: `dist`
- Functions directory: `netlify/functions`
- Node version: `24`

## Required environment variables

Set these in Netlify before preview/production deploy:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_SERVICE_KEY`
- `CLARITY_ADMIN_EMAIL`
- `CLARITY_ADMIN_PASSWORD`

Optional for email sending:

- `RESEND_API_KEY`

## Local smoke commands

From the repository root:

```bash
cd source
npm install
npm run build
npm run preview
```

## Smoke test checklist after deploy

1. Open the public booking page.
2. Confirm services and available slots load.
3. Admin login works.
4. Refresh admin and confirm session remains valid.
5. Calendar loads.
6. Save a harmless calendar edit and reload.
7. People/client data still appears.
8. Notification history loads.
9. Logout invalidates the session.

## Current backend cleanup state

- `auth-session.mts` is a thin wrapper into `booking-core.mts`.
- `notification-history.mts` is a thin wrapper into `booking-core.mts`.
- `calendar-state.mts` remains direct intentionally and has a malformed PUT body guard.
- `system-smoke.mts`, `test-email.mts`, and `people-migrate.mts` remain direct intentionally.
- See `source/netlify/functions/PERSISTENCE_MAP.md` for details.

## Important auth-session fix — 23 June 2026

This package includes a fix for the login screen remaining on “Checking session”. Auth routes no longer run the full calendar/settings/people seed path. A browser with no `clarity_session` cookie receives an immediate unauthenticated response, and the frontend falls back to the login form after 8 seconds if the session request cannot complete.

## Calendar people-save fix — 23 June 2026

This package resolves appointment-derived people against existing `people` rows before upsert. An existing case-insensitive email match keeps the existing person id and profile metadata, preventing calendar saves from failing with `idx_people_email_unique` duplicate-key errors. It also includes the idempotent `calendar_items.status` migration/schema update.
