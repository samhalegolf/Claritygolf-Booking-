# Clarity Booking Supabase Persistence Fix

This patch moves the booking system off the failing `@netlify/database` runtime path and onto the Supabase project already configured in Netlify.

It also adds an admin-only client migration route:

```txt
POST /api/people/migrate
```

That route rebuilds the client list from saved appointments and can also accept a pasted/imported `people` array in the request body.

## Install

1. In Supabase, open the `clarity-caddie` project.
2. Go to SQL Editor.
3. Run `supabase/booking-schema.sql` once.
4. Copy `netlify/functions/supabase-storage.mts` into the repo at the same path.
5. Apply `booking-core.patch`.
6. Deploy to Netlify.

## Required Netlify environment variables

Production needs:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

`SUPABASE_SERVICE_ROLE_KEY` must be the real service role key, not the anon/public key.

## First test after deploy

1. Log into admin.
2. Create a block called `SAVE TEST 123`.
3. Hard refresh.
4. If it survives, persistence is fixed.
5. Run the client migration route if you need to rebuild the people/client list.
6. Then test a fresh public booking email.

## Video Analysis saved-video ownership

Video Analysis now separates primary local storage from browser recovery:

- The managed Clarity Video Library folder is the primary durable store when the
  browser supports the File System Access API and the coach has chosen a folder.
- IndexedDB remains the cache, recovery, and offline protection layer.
- Transient workspace slots are recovery data keyed by `playerId + lessonId + side`.
  They protect the active upload/recording, drawings, markers, and workspace state
  while the coach is editing. These records are not the Player Profile library.
- Durable saved videos are user-facing library records keyed by `savedVideoId`.
  Metadata lives in `savedVideoItems`; `savedVideoBlobs` keeps the cache/recovery
  source blob. The saved blob is keyed by `savedVideoId`, not by left/right
  workspace side.

Manual Save flushes the active analysis stores, copies each active side's
transient source blob into `Players/<playerId>/Videos/<savedVideoId>/video.mp4`
inside the managed folder, writes `analysis.json`, `manifest.json`,
`metadata.json`, and `snapshots/`, verifies the file size, writes the
`SavedVideoItem`, and then updates the IndexedDB cache. If the Finder write
fails, the IndexedDB copy is kept and the item is marked for reconnect/repair
rather than losing the coach's work.

The managed folder shape is:

```txt
Clarity Video Library/
  Players/<playerId>/Videos/<savedVideoId>/
    video.mp4
    analysis.json
    manifest.json
    metadata.json
    snapshots/
  System/
    imports/
    logs/
    cache/
```

Player Profile video cards are sourced from `savedVideoItems`. Opening a card
passes the exact `savedVideoId` to Video Analysis, tries the Finder library file
first, falls back to the IndexedDB cache if the file is missing or permission is
lost, restores its analysis snapshot and workspace snapshot, then rebuilds a
transient slot copy for recovery while editing.

Clear clip and Delete saved item are intentionally different:

- Clear clip removes only the active workspace slot and its transient recovery
  blob. It does not delete a saved-library item or saved blob.
- Delete saved item is an explicit Player Profile action with confirmation. It
  removes the saved metadata and saved blob, and leaves unrelated active workspace
  slots alone.

Existing slot-only browser videos are not silently converted or deleted. They
remain visible as recovery records with a `Move to Saved Videos` action, which
copies the old transient blob into the durable saved library, migrates verified
items into the Finder library when configured, and keeps the original recovery
record until validation succeeds. Existing durable saved videos can also be
migrated from cache to Finder through Settings.

Google Drive transfer is a temporary transport bridge, not the permanent video
library. `Send to primary computer` uploads from the durable
`savedVideoItems`/`savedVideoBlobs` records using `savedVideoId` as the ownership
key; it never uploads directly from transient left/right workspace slots and it
does not delete the local source copy after upload.

The upload lifecycle is:

1. The client loads the durable saved item and blob, calculates SHA-256, and asks
   `/api/video-transfer/upload-session` for a Drive resumable upload URL.
2. The server authenticates the Clarity admin session, resolves the account,
   refreshes Google through the shared encrypted provider connection, provisions
   `Clarity Golf/Video Transfer/Inbox/<savedVideoId>/`, and starts the resumable
   upload with `drive.file`.
3. The browser uploads the video bytes directly to Google Drive and reports
   progress locally.
4. `/api/video-transfer/:savedVideoId/finalize` verifies the uploaded file size
   and Clarity `appProperties`, writes `analysis.json` and `manifest.json`, and
   only then marks the local item `Ready on primary computer`.

Known limitations: resumable upload URLs are treated as temporary secrets and are
not persisted across reloads, so an interrupted browser upload becomes retryable
rather than resumable-continuable. Primary-device import, checksum download
verification, import receipts, and Drive cleanup policy remain the next sprint.
