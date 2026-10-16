# Client Portal — Handover

Built 13 Aug 2026. One login screen for coach and player, portal videos with
local-first saving, and player-to-coach video submissions into the coach's
Google Drive.

## What changed, in one pass

**Auth is unified.** `/api/auth/login` tries `admin_users` first (your login is
untouched) and then Supabase Auth. The response carries a `role`, and
`src/main.tsx` routes on it: coach → `App`, player → `PlayerPortal`, nobody →
`LoginScreen`. The portal is no longer selected by hostname;
`players.claritygolf.app` still works, it just is not the mechanism.

**The login screen left App.tsx.** It is `src/modules/auth/LoginScreen.tsx` now,
and both shells are lazy-loaded. A player downloads 9 KB of portal instead of
707 KB of coach workspace.

**Players are promoted, not auto-created.** A client becomes a portal user when
you press *Give portal access* in their profile. That creates (or links) a
Supabase Auth user — the same `auth.users` Clarity Caddy uses, so a player with
a Caddy account signs in to both with one password — and emails them a
set-password link. `/api/player/login` (email + phone) is gone.

**The portal has videos.** Record, keep on device, send to coach. Local is the
default and nothing uploads until the player presses send.

**Submissions reuse the transfer engine.** Same resumable Drive uploads,
checksums and manifests as your own library sync, authorised by a player session
instead of an admin one, landing in a `Player Submissions` folder in your Drive.
They then appear in that player's Videos tab with an unseen marker until you
open one, and you get an email when one arrives.

## Environment variables

Two may need adding in Netlify — everything else was already set:

```text
SUPABASE_ANON_KEY     # the password grant expects it; falls back to the
                      # service key if absent, which works but is not ideal
CLARITY_ALERT_EMAIL   # where "a player sent you a video" goes
```

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `RESEND_API_KEY`
and `CLARITY_EMAIL_FROM` are all already in use elsewhere in the app.

## Migrations

Applied to the live project already, and recorded in
`database/migrations`:

- `20260813000200_create_portal_players`
- `20260813000300_add_player_session_auth_user`
- `20260813000400_add_video_transfer_player_submissions`

## Where things live

| Concern | File |
| --- | --- |
| Session type, fetch, sign out | `src/modules/auth/session.ts` |
| Login / forgot / reset / invite | `src/modules/auth/LoginScreen.tsx` |
| Role routing, lazy shells | `src/main.tsx` |
| Player app | `src/modules/player-portal/PlayerPortal.tsx` |
| Constants both apps need | `src/modules/shared/bookingHandoff.ts` |
| Upload scope (coach vs player) | `src/modules/video-analysis/utils/savedVideoLibrary.ts` |
| Auth, portal players, invites | `netlify/functions/booking-core.mts` |
| Player upload routes, caps, notification | `netlify/functions/video-transfer.mts` |

## Things worth knowing

**The unique index on `portal_players (account_id, person_id)`** means one
portal login per person per account. Revoking sets `status = 'disabled'` and
deletes their sessions rather than deleting the row, so re-granting reuses the
same auth user and the history survives.

**Session revocation is immediate.** `readPlayerSession` re-checks
`portal_players.status` on every request, so *Remove access* signs them out
everywhere within one request rather than in up to 30 days.

**Caps on submissions:** 750 MB per video, 20 per player per 24 hours. Resuming
an interrupted upload does not count again. Both are constants at the top of the
player-submission section in `video-transfer.mts`.

**Drive retention is not automated.** Player submissions accumulate in your
Workspace storage. There is no auto-archive rule yet — worth deciding one before
this gets heavy use.

## Not done, deliberately

- **Lesson notes are still a JSON blob** in `settings` under
  `lessonNotes.v1.<accountId>`, read and rewritten whole. It works, but it means
  no row-level security on the thing the portal shows players. Worth moving to a
  real table as its own patch.
- **`optix_pass_purchases` has RLS disabled** — unrelated to the portal, still
  the one table in the project open to the anon key. The app reads it with the
  service role, which bypasses RLS, so enabling it should be safe:
  `ALTER TABLE public.optix_pass_purchases ENABLE ROW LEVEL SECURITY;`
- **No end-to-end test of a real invite or a real upload.** Typecheck, the 256
  unit tests and a production build all pass, but the Supabase Auth round trip
  and a Drive upload from a player session have not been exercised against the
  live services.
