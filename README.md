# Clarity Golf Booking — production reliability repair

This is a clean, GitHub-ready source bundle for the **Clarity Golf Booking** Netlify project.

## Repairs included

- The coach calendar and public booking flow now use the same `booking-core` storage and notification pipeline.
- Existing people are resolved by normalized email before upsert, preventing Supabase `409 / 23505` duplicate-email failures.
- Saving a full empty calendar now deletes the final appointment, so **Cancel lesson** works when it removes the last item.
- Calendar writes are serialized in the browser and use the latest `updatedAt` version.
- Save responses no longer feed their item snapshot back into React and restart autosave.
- Interrupted/mobile responses are checked against live state before a false **SAVE FAILED** warning is shown.
- A genuine stale-state conflict blocks further writes until reload rather than overwriting a newer public booking.
- A deliberately selected quick-booking client stays selected; another fuzzy match such as Jo Booth is not shown again unless identifying fields are manually changed.
- Coach-created bookings, reschedules and cancellations use the notification engine.
- Login uses the stored password once an account exists, so an environment password cannot silently undo a password reset.
- Password reset revokes older sessions and creates one fresh session.
- The repository root is documented as the only deployable source.

## Validation

Run:

```bash
npm ci
npm test
npm run check:functions
npm run build
```

The included validation runs **17 automated tests** and bundles/imports **23 Netlify functions**. It exercises the real calendar and auth handlers against an in-memory Supabase REST mock, including public booking email delivery, coach booking/reschedule/cancellation email delivery, duplicate-email reuse, final-item cancellation, stale-write protection, login, password reset, session validation and logout.

## Required Netlify environment variables

Confirm these exist on the `clarity-golf-booking` site:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
CLARITY_ADMIN_EMAIL
CLARITY_ADMIN_PASSWORD
RESEND_API_KEY
CLARITY_EMAIL_FROM
CLARITY_NOTIFICATION_EMAIL
CLARITY_REPLY_TO_EMAIL
CLARITY_APP_URL=https://claritygolf.app
EMAIL_NOTIFICATIONS_ENABLED=1
```

Do not put secret values into GitHub.

## Deploy

Extract this ZIP and push its **contents** into the root of the existing GitHub repository. Do not commit the ZIP itself or place the project inside another folder.

Netlify settings should remain:

```text
Build command: npm run build
Publish directory: dist
Functions directory: netlify/functions
Node: 24
```

After Netlify publishes, verify `/clarity-release.json`, then test login, one existing-client save, one edit, and one cancellation.
