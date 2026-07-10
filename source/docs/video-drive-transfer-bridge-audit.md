# Video Drive Transfer Bridge Audit

## Shared Google Provider Baseline

- Calendar OAuth now stores its refresh token in the shared encrypted `google_provider_connections` provider record.
- The legacy plaintext `settings.googleCalendarRefreshToken` is treated only as a migration source and is cleared after migration.
- Provider records are resolved by Clarity account/workspace with `resolveGoogleAccountId`.
- Calendar access-token refresh uses `getGoogleAccessToken`, so the plaintext settings token is no longer part of the sync path.
- The Calendar scopes remain `https://www.googleapis.com/auth/calendar.events` and `https://www.googleapis.com/auth/userinfo.email`.
- `saveGoogleAuthorization` preserves the existing encrypted refresh token when Google omits a replacement refresh token.

## Drive Architecture Decision

Drive transfer must use the same encrypted Google provider connection as Calendar. This PR adds incremental authorization for `https://www.googleapis.com/auth/drive.file` by requesting the Calendar scopes plus `drive.file` with `include_granted_scopes=true` and `access_type=offline`.

There is no separate Drive refresh-token table, no plaintext Drive token setting, and no client-side Drive token store.

## Safe Bridge Added

- Adds `/api/google-drive/status`, `/connect`, `/callback`, `/test`, and `/disconnect` route handling.
- Authenticates admin users for status/connect/test/disconnect and keeps the Google callback server-side.
- Stores only short-lived OAuth state in settings; token material goes through the shared provider service.
- Saves the Drive grant with `saveGoogleAuthorization({ enableCalendar: true, enableDrive: true })`, preserving the existing encrypted refresh token if Google omits one.
- Uses `getGoogleAccessToken` for the Drive test path to prove provider refresh works without exposing token material.
- Keeps video upload/import disabled: `/test` returns a blocked implementation response after refresh succeeds, and `/disconnect` is blocked until ownership and lifecycle semantics are defined.
- Adds a Settings > Integrations Google Drive Transfer panel showing Not connected, Permission upgrade required, Reconnect required, Error, and Blocked states.

## Required Follow-Up Before Full Transfer

1. Add Drive folder provisioning and persist the owned root/inbox/imported/failed folder IDs.
2. Add resumable upload initiation, chunk/finalize handling, retry policy, and cancellation.
3. Validate Drive account ownership and folder ownership before accepting any upload/import state.
4. Validate Google API responses before writing transfer metadata.
5. Add transfer asset indexing and primary-device/import ownership rules.
6. Add import into the managed local video library after the managed-library PR lands.
7. Add the owner Google Cloud OAuth callback for `/api/google-drive/callback` and make sure the app verification consent screen includes Drive file access.

## Calendar Regression Checklist

- Calendar status still loads from `/api/google-calendar/status`.
- Calendar connect still uses `/api/google-calendar/connect`.
- Calendar sync still uses `/api/google-calendar/sync`.
- The Calendar provider record and scopes remain enabled when Drive permission is added.
- Google Drive routes never create or clear plaintext refresh-token settings.
