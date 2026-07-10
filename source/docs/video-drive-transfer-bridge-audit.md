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
- Adds a Settings > Integrations Google Drive Transfer panel showing Not connected, Permission upgrade required, Reconnect required, Error, and Blocked states.

## Upload Transfer Added

- Adds `/api/video-transfer/upload-session`, `/api/video-transfer/:savedVideoId/finalize`, `/status`, `/retry`, and `DELETE /api/video-transfer/:savedVideoId`.
- Starts Google Drive resumable uploads server-side, then lets the browser PUT the durable saved video blob directly to Google.
- Provisions `Clarity Golf/Video Transfer/Inbox/<savedVideoId>/` plus `Imported` and `Failed` folders under the connected Google account.
- Uses Drive `appProperties` for Clarity-created folders/files: `clarityType`, `claritySavedVideoId`, `clarityPlayerId`, `clarityAccountId`, and `clarityVersion`.
- Writes editable `analysis.json` and a versioned `manifest.json`; drawings are not flattened into the video.
- Marks `SavedVideoItem.cloud.status` ready only after finalize verifies Drive file size and ownership properties.
- Keeps the local saved item and blob intact after upload.

## Required Follow-Up Before Full Import

1. Add primary-device download/import into the managed local video library.
2. Verify download checksum against the manifest before writing the local import.
3. Write import receipts and define the Drive cleanup/retention policy.
4. Add resumable continuation across browser reloads if upload URLs can be stored safely.
5. Add the owner Google Cloud OAuth callback for `/api/google-drive/callback` and make sure the app verification consent screen includes Drive file access.

## Calendar Regression Checklist

- Calendar status still loads from `/api/google-calendar/status`.
- Calendar connect still uses `/api/google-calendar/connect`.
- Calendar sync still uses `/api/google-calendar/sync`.
- The Calendar provider record and scopes remain enabled when Drive permission is added.
- Google Drive routes never create or clear plaintext refresh-token settings.
