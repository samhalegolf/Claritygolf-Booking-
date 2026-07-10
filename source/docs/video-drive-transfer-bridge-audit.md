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

## Chunked Upload Transfer Added

- Adds server-owned transfer sessions in `public.video_transfer_sessions`, keyed by `transfer_id` and account-scoped by `account_id`.
- Adds `/api/video-transfer/:savedVideoId/session`, `/chunk`, `/pause`, `/resume`, `/finalize`, and `DELETE /session`, while keeping `/upload-session`, `/status`, and `/retry` aliases for compatibility.
- Starts Google Drive resumable uploads server-side and stores the resumable URL only in the service-role table.
- Keeps the browser on same-origin Clarity endpoints. The browser never receives OAuth tokens, Google upload URLs, or Drive ids it can choose for itself.
- Reads from the managed local Finder library when available, then falls back to the IndexedDB saved-video blob. The local source is retained after transfer.
- Sends one `Blob.slice(start, end)` chunk at a time. The configured chunk size is 8 MiB, aligned to Google's resumable-upload granularity.
- The server validates `transferId`, `savedVideoId`, account ownership, expected size, accepted offset, chunk range, and max chunk size before forwarding to Google with `Content-Range`.
- Handles Google `308 Resume Incomplete` by persisting the accepted byte offset, `200/201` by moving to `verifying`, `401/403` as reconnect/permission states, and `404/410` as an expired session.
- Provisions `Clarity Golf/Video Transfer/Inbox/<savedVideoId>/` plus `Imported` and `Failed` folders under the connected Google account.
- Uses Drive `appProperties` for Clarity-created folders/files: `clarityType`, `claritySavedVideoId`, `clarityPlayerId`, `clarityAccountId`, and `clarityVersion`.
- Writes editable `analysis.json` and a versioned `manifest.json`; drawings are not flattened into the video.
- Marks `SavedVideoItem.cloud.status` ready only after all bytes are accepted and finalize verifies Drive file size and ownership properties.
- Keeps the local saved item, managed Finder file, and IndexedDB recovery blob intact after upload.

## Resume And Retry Model

- Client-visible state stores only `transferId`, status, accepted offset, expected size, chunk size, progress, and safe error code/message.
- Reload recovery starts by calling `GET /api/video-transfer/:savedVideoId/session`, reopening the managed local file or IndexedDB blob, verifying the local size/checksum metadata, and resuming from `acceptedOffsetBytes`.
- Pause stops new chunks and preserves the server session. Resume continues from the persisted accepted offset.
- Transient Google `429`/`5xx` responses preserve the accepted offset and let the client retry the same chunk.
- Expired Google resumable sessions are marked `expired`; v1 does not silently restart from byte zero after partial progress.

## Checksum Semantics

- `SavedVideoItem.source.checksumSha256` is sent in the transfer session and written to `manifest.json`.
- Finalize verifies Drive file size and Clarity ownership properties. Google Drive exposes `md5Checksum` for binary files, not SHA-256, so SHA-256 remains the import-side verification requirement.
- If a saved item lacks SHA-256, the current client still computes it before transfer; future work should move that calculation to a worker-backed incremental helper for very large legacy items.

## Cleanup Strategy

- Cancel marks the server transfer `cancelled` and keeps the local source. Ready transfers are not deleted by cancel.
- Failed, expired, and cancelled rows remain diagnosable without exposing resumable URLs to the browser.
- Safe orphan cleanup should only delete Clarity-created Drive files/folders after verifying `appProperties.clarityAccountId` and `appProperties.claritySavedVideoId`.
- A scheduled cleanup job is still a follow-up; v1 provides the durable state needed for a manual or scheduled service-role cleanup helper.

## Tested Limits

- Automated tests cover compact session payloads, same-origin chunk uploads, `Blob.slice` chunking, no browser Google calls, no resumable URL in public session JSON, out-of-order chunk rejection, chunk size enforcement, failed chunk handling, finalize gating, and local source retention.
- Manual large-file QA was not run in this coding pass. Do not claim 2 GB+ support until Netlify function limits and real browser memory have been measured with large lesson videos.
- Reasoned memory bound: browser and function hold one configured chunk plus protocol overhead, not the complete video file.

## Required Follow-Up Before Full Import

1. Add inbound Drive import into the managed local video library.
2. Verify download size and SHA-256 against `manifest.json` before writing the local import.
3. Write import receipts into the managed library and update player-profile cloud/local state.
4. Add service-role orphan cleanup for expired/cancelled transfer sessions and verified Clarity-created Drive files.
5. Run manual QA with small clips, 50-100 MB clips, and several-hundred-MB clips before claiming broad platform support.

## Calendar Regression Checklist

- Calendar status still loads from `/api/google-calendar/status`.
- Calendar connect still uses `/api/google-calendar/connect`.
- Calendar sync still uses `/api/google-calendar/sync`.
- The Calendar provider record and scopes remain enabled when Drive permission is added.
- Google Drive routes never create or clear plaintext refresh-token settings.
