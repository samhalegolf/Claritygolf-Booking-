# Netlify Function Persistence Map

This document records the current persistence shape of the active Clarity Golf booking app.

`source/` is the only active application. Root-level duplicates are legacy unless a future migration explicitly says otherwise. Follow the repository-level `PROJECT_SOURCE_OF_TRUTH.md` before editing any function.

## Current persistence ownership

`booking-core.mts` is the main persistence owner for the booking app. Most route files under `source/netlify/functions/` should remain thin wrappers that delegate to exported handlers in `booking-core.mts`.

Auth routes should stay thin. In the current state, `auth-session.mts` is a thin wrapper into `booking-core.mts`, matching `auth-login.mts`, `auth-change-password.mts`, `auth-forgot-password.mts`, and `auth-reset-password.mts`. `notification-history.mts` is also now a thin wrapper into `booking-core.mts`.

`@netlify/database` is intentionally used as a compatibility shim. In `source/package.json`, `@netlify/database` resolves to `file:netlify/functions/local-db`, and that local adapter is backed by Supabase REST. Do not read names like `@netlify/database` or `local-db` as evidence that production persistence is Netlify Database or SQLite.

## Function table

| Function | Route | Persistence Path | Tables Touched | Risk Level | Notes |
| --- | --- | --- | --- | --- | --- |
| `auth-change-password.mts` | `/api/auth/change-password` | Thin wrapper to `handleBookingApiRoute` in `booking-core.mts` | Owned by `booking-core.mts`: `admin_users`, `admin_sessions` | Low | Keep thin. Do not add direct Supabase code here. |
| `auth-forgot-password.mts` | `/api/auth/forgot-password` | Thin wrapper to `handleBookingApiRoute` in `booking-core.mts` | Owned by `booking-core.mts`: `admin_users`, `admin_password_resets` | Low | Keep thin. Do not add direct Supabase code here. |
| `auth-login.mts` | `/api/auth/login` | Thin wrapper to `handleBookingApiRoute` in `booking-core.mts` | Owned by `booking-core.mts`: `admin_users`, `admin_sessions` | Low | Login and session creation are owned by `booking-core.mts`. |
| `auth-reset-password.mts` | `/api/auth/reset-password` | Thin wrapper to `handleBookingApiRoute` in `booking-core.mts` | Owned by `booking-core.mts`: `admin_users`, `admin_password_resets`, `admin_sessions` | Low | Keep thin. Do not add direct Supabase code here. |
| `auth-session.mts` | `/api/auth/session` | Thin wrapper to `handleBookingApiRoute` in `booking-core.mts` | Owned by `booking-core.mts`: `admin_users`, `admin_sessions` | Low | Current patched state: this now matches login/session persistence ownership. |
| `booking-api.mts` | `/api/*` except excluded routes | Thin catch-all wrapper to `handleBookingApiRoute` in `booking-core.mts` | Owned by `booking-core.mts` | Low | Catch-all route. Specific function routes are excluded where separate handlers exist. |
| `booking-core.mts` | Shared handler module, not a direct route file | Main persistence owner through `@netlify/database` compatibility shim backed by Supabase REST | `settings`, `calendar_items`, `people`, `admin_users`, `admin_sessions`, `admin_password_resets`, `notification_history`, `notification_webhook_events` | High | Central source of truth for booking, auth, public booking, reschedule, notifications, and webhook persistence. Changes here affect most app behaviour. |
| `calendar-feed.mts` | `/calendar/*` | Thin wrapper to `handleCalendarFeedRequest` in `booking-core.mts` | Owned by `booking-core.mts`: primarily `settings`, `calendar_items` | Low | Keep thin. Calendar feed persistence should remain centralised in `booking-core.mts`. |
| `calendar-state.mts` | `/api/calendar-state` | Own direct Supabase REST helper | `admin_sessions`, `settings`, `calendar_items`, `people`, `notification_history` | High | Remaining direct Supabase function. Intentionally not converted to a thin wrapper yet. Current patched state: malformed PUT bodies where `items` is missing or not an array now return 400 before any write/delete. Valid `items: []` still intentionally preserves the existing clear-all behaviour. People upsert behaviour, settings behaviour, and notification behaviour were not changed. Further calendar consolidation must be a separate explicit audit/patch. |
| `notification-history.mts` | `/api/notification-history` | Thin wrapper to `handleBookingApiRoute` in `booking-core.mts` | Owned by `booking-core.mts`: `notification_history`, `admin_sessions`, `admin_users` | Low | Current patched state: this no longer owns a separate direct Supabase notification-history helper. |
| `people-migrate.mts` | `/api/people/migrate` | Uses `getSupabaseDatabase` from `./supabase-storage.mts` directly | `admin_sessions`, `admin_users`, `calendar_items`, `people` | Medium | Migration/admin tooling. Keep direct for now unless specifically auditing people migration behaviour. |
| `public-booking-state.mts` | `/api/public-booking-state` | Thin wrapper into `booking-core.mts` | Owned by `booking-core.mts`: primarily `settings`, `calendar_items` | Low | Keep thin. Public booking state shape is centralised in `booking-core.mts`. |
| `public-booking.mts` | `/api/public-booking` | Thin wrapper into `booking-core.mts` | Owned by `booking-core.mts`: `settings`, `calendar_items`, `people`, `notification_history` | Low | Keep thin. Do not duplicate public booking writes here. |
| `public-notification-status.mts` | `/api/public-notification-status` | Thin wrapper into `booking-core.mts` | Owned by `booking-core.mts`: `notification_history` | Low | Keep thin. |
| `public-reschedule-lookup-api.mts` | `/api/public-reschedule-lookup` | Thin wrapper into `booking-core.mts` | Owned by `booking-core.mts`: `calendar_items`, `settings` | Low | Compatibility route for public reschedule lookup. |
| `public-reschedule-lookup.mts` | `/api/public-reschedule/lookup` | Thin wrapper into `booking-core.mts` | Owned by `booking-core.mts`: `calendar_items`, `settings` | Low | Alternate public reschedule lookup route. |
| `public-reschedule.mts` | `/api/public-reschedule` | Thin wrapper into `booking-core.mts` | Owned by `booking-core.mts`: `calendar_items`, `settings`, `notification_history` | Low | Keep thin. Do not duplicate reschedule writes here. |
| `resend-webhook.mts` | `/api/resend-webhook` | Thin wrapper into `booking-core.mts` | Owned by `booking-core.mts`: `notification_history`, `notification_webhook_events` | Low | Keep thin. Webhook idempotency and notification updates are centralised in `booking-core.mts`. |
| `supabase-storage.mts` | Shared support module, not a direct route file | Supabase REST adapter used by direct helper paths | Shared adapter for app tables | Medium | Adapter/support module. Keep behaviour aligned with `source/netlify/functions/local-db/supabase-storage.mjs` and `booking-core.mts` expectations. |
| `system-smoke.mts` | `/api/system-smoke` | Own direct Supabase REST helper | `admin_sessions`, `settings`, `calendar_items`, `people`, `notification_history` | Medium | Remaining direct Supabase diagnostic function. Keep in sync with `booking-core.mts` auth/session rules and table expectations. |
| `test-email.mts` | `/api/test-email` | Own direct Supabase REST helper plus email provider call | `admin_sessions`, `notification_history` | Medium | Remaining direct Supabase function. Patch only after confirming the equivalent `booking-core.mts` behaviour and email side effects. |

## Direct Supabase functions to keep in sync

These files still have their own Supabase-backed persistence path and should be reviewed whenever `booking-core.mts`, session validation, or table schemas change:

- `calendar-state.mts`
- `system-smoke.mts`
- `test-email.mts`
- `people-migrate.mts`

Do not patch all of them at once. Patch one function at a time after confirming the equivalent route is already supported by `booking-core.mts`.

## Thin wrappers to leave thin

These route files should not grow their own persistence logic:

- `auth-change-password.mts`
- `auth-forgot-password.mts`
- `auth-login.mts`
- `auth-reset-password.mts`
- `auth-session.mts`
- `booking-api.mts`
- `calendar-feed.mts`
- `notification-history.mts`
- `public-booking-state.mts`
- `public-booking.mts`
- `public-notification-status.mts`
- `public-reschedule-lookup-api.mts`
- `public-reschedule-lookup.mts`
- `public-reschedule.mts`
- `resend-webhook.mts`

## Practical guardrails

- Do not move persistence out of `booking-core.mts` unless a future task explicitly asks for a persistence refactor.
- Do not create new direct Supabase REST helpers.
- Do not consolidate adapters as part of unrelated fixes.
- Do not edit invoicing or package behaviour while working on persistence cleanup.
- When changing admin auth/session behaviour, check every direct Supabase function listed above.
- When changing table shape, check both `booking-core.mts` and the Supabase REST compatibility adapter paths.

## Next safe cleanup order

1. Audit `calendar-state.mts` against the equivalent `booking-core.mts` calendar-state route before any consolidation.
2. Do not convert `calendar-state.mts` to a wrapper yet unless response shape, PUT behaviour, people upsert rules, settings save/load behaviour, conflict handling, and notification side effects are confirmed safe.
3. The malformed PUT body guard has already been patched in `calendar-state.mts`: missing or non-array `items` must return 400, while valid `items: []` still preserves the existing intentional clear-all behaviour.
4. Any further calendar consolidation must be requested as a separate explicit audit/patch.
5. Leave `system-smoke.mts`, `test-email.mts`, and `people-migrate.mts` direct until each has its own focused audit.

## Runtime note

This file is documentation only. It does not change imports, routes, handlers, schema, environment variables, sessions, cookies, UI, packages, invoicing, or deployment behaviour.
