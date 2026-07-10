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

Video Analysis keeps two separate browser-local persistence layers:

- Transient workspace slots are recovery data keyed by `playerId + lessonId + side`.
  They protect the active upload/recording, drawings, markers, and workspace state
  while the coach is editing. These records are not the Player Profile library.
- Durable saved videos are user-facing library records keyed by `savedVideoId`.
  Metadata lives in `savedVideoItems` and the source blob lives in
  `savedVideoBlobs`. The saved blob is keyed by `savedVideoId`, not by left/right
  workspace side.

Manual Save flushes the active analysis stores, copies each active side's
transient source blob into `savedVideoBlobs`, writes a versioned
`SavedVideoItem`, verifies metadata plus blob size, and only then reports
`Saved to Player Profile`.

Player Profile video cards are sourced from `savedVideoItems`. Opening a card
passes the exact `savedVideoId` to Video Analysis, restores its saved source blob,
analysis snapshot, and workspace snapshot, then rebuilds a transient slot copy for
recovery while editing.

Clear clip and Delete saved item are intentionally different:

- Clear clip removes only the active workspace slot and its transient recovery
  blob. It does not delete a saved-library item or saved blob.
- Delete saved item is an explicit Player Profile action with confirmation. It
  removes the saved metadata and saved blob, and leaves unrelated active workspace
  slots alone.

Existing slot-only browser videos are not silently converted or deleted. They
remain visible as recovery records with a `Move to Saved Videos` action, which
copies the old transient blob into the durable saved library and keeps the
original recovery record until validation succeeds.

Cloud transfer is disabled in this layer until the Google Drive upload adapter is
implemented. The future Drive integration should upload from
`savedVideoItems`/`savedVideoBlobs` using the `saveSavedVideoToCloud` and
`getSavedVideoCloudStatus` seams, not from transient workspace slots.
