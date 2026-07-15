# Clarity Booking — Player Login Portal: Pre-Build Audit

*Read-only audit. No files changed by this audit. Line references are to `source/`.*

*This file is documentation only. It does not change imports, routes, handlers, schema, environment variables, sessions, cookies, UI, packages, invoicing, or deployment behaviour. See `PROJECT_SOURCE_OF_TRUTH.md` and `netlify/functions/PERSISTENCE_MAP.md` before acting on any recommendation here.*

---

## Executive summary

The ask: a basic player-facing login, showing the player "all the stuff under their player profile," plus a booking route where they arrive pre-logged-in.

**The good news (why this can be efficient):** almost every ingredient already exists and is reusable.
- A complete, production auth stack (salted password hashing, sha256 token sessions, HttpOnly cookie, forgot/reset flow) lives in `booking-core.mts` — the crypto and session helpers are auth-scheme-agnostic and can back a *player* session with minimal new code.
- A **lightweight client-identity trust model is already in production**: public reschedule/cancel verifies a client purely by matching **email + phone** against their appointment (`lookupPublicReschedule`, `booking-core.mts:7025`). That is exactly the trust boundary a player login can mirror — no new password credentials required.
- The booking embed already pre-fills client identity and persists a "reschedule login" to `localStorage`, then hydrates the booking form from it (`initialRescheduleLoginRef`, `src/App.tsx:4749`). "Pre-logged-in booking" is mostly *re-pointing that same hydration at a player session*.
- Lesson notes are already server-side and **keyed by the exact `playerId` identity** a login would resolve to.

**The one hard constraint (must shape scope):** player **videos are mostly device-local**, stored in the coach's browser IndexedDB (`createIndexedDbSavedVideoLibrary`, `savedVideoLibrary.ts:1760`). Only videos that have been **uploaded to Clarity Cloud** have a server-side, player-keyed record (`video_transfer_sessions`, keyed by `player_id`) with bytes retrievable through the Drive transfer bridge. So a player logging in on *their own* device can see: their bookings, their lesson notes, and their cloud-uploaded videos — but **not** local-only clips still sitting in the coach's browser. This is an explainable boundary, but it must be a deliberate product decision, not a surprise.

**Recommended efficient path:** a **passwordless player session** (verify by email + phone, matching the existing reschedule trust model, optionally hardened later with an emailed code), a small set of **player-scoped read endpoints** that reuse existing readers filtered by the player's identity, and a **booking hand-off** that reuses the existing pre-fill hydration. No new password storage, no new video infrastructure, additive tables only.

Per `PROJECT_SOURCE_OF_TRUTH.md`, this is its own scoped feature patch, confined to `source/`.

---

## Part 1 — What "stuff under a player profile" actually is, and where it lives

This is the feasibility spine of the whole feature. Player-profile content today (see the Player Profiles view and `profileIdsForClient`, `src/App.tsx:2258`):

| Content | Storage | Player-keyed? | Visible to a logged-in player? |
|---|---|---|---|
| **Upcoming / past bookings** | `calendar_items` (SQL) | by email/phone/`person_id` | **Yes** — `readPublicAppointmentsForContact` already fetches a client's appointments by email+phone (`booking-core.mts:7044`) |
| **Lesson notes** | `settings` JSON blob, `lessonNotes.v1.<account>` (`booking-core.mts:2975`) | **Yes** — each note has a `playerId` | **Yes** — `readLessonNotes` + filter by the player's id set |
| **Cloud-uploaded videos** | catalogue in `video_transfer_sessions` (SQL, has `player_id`); bytes in coach's Google Drive | **Yes** — `player_id` column | **Yes, with work** — needs a player-scoped variant of the transfer download bridge (`/api/video-transfer/:id/download`) |
| **Local-only saved videos** | coach browser **IndexedDB** (`createIndexedDbSavedVideoLibrary`) | n/a (device-local) | **No** — not on any server the player can reach until uploaded |
| **Video analysis workspace** (drawings, markers) | local IndexedDB / bundled into the cloud transfer package | partial | **Only** for videos that were cloud-transferred |

**Implication:** the login portal's "profile" surface should be built around the three server-backed sources (bookings, lesson notes, cloud videos). Local-only video is out of reach by architecture — either scope it out of v1, or treat "upload to Clarity Cloud" as the prerequisite for a clip to appear in the player's portal.

---

## Part 2 — Reusable auth stack (inventory)

Everything here is in `booking-core.mts` and is not admin-specific in its mechanics:

- `hashPassword(password, salt?)` — salted hash, returns `{ passwordHash, salt }` (`:1423`).
- `hashToken(token)` — sha256, used for both session and reset token hashing (`:1419`).
- Session lifecycle: `createAdminSession` (`:5894`), `readAdminSession` (`:5913`), `destroyAdminSession` (`:5930`), `cleanupExpiredSessions` (`:5936`). All parameterised by a users/sessions table pair.
- Cookie plumbing: `cookieHeader(token, req, maxAge)` → `clarity_session`, `HttpOnly`, `SameSite=Lax` (`:1457`); `clearCookieHeader()` (`:1471`); `parseCookies` (`:1485`); `sessionTokenFromRequest` (`:1503`).
- Forgot/reset: `admin_password_resets` table + emailed token flow (`:5823`, routes at `:7519`/`:7554`).

Schema shape to mirror (from `20260607000100_create_booking_core`):
```
admin_users(id, email UNIQUE, password_hash, password_salt, ...)
admin_sessions(id, token_hash UNIQUE, user_id → admin_users, expires_at, ...)
```

**Reuse decision:** do **not** overload `admin_users`/`admin_sessions` with players — the `/api/` admin gate (Part 4) keys off admin sessions, and mixing roles there is a security footgun. Instead add parallel, additive `player_sessions` (and, only if passworded, `player_credentials`) tables and call the same `hashToken`/`hashPassword`/cookie helpers. A distinct cookie name (e.g. `clarity_player_session`) keeps the two session spaces from colliding when a coach is also a player on the same browser.

---

## Part 3 — The existing lightweight identity model (the trust boundary to mirror)

`lookupPublicReschedule` (`booking-core.mts:7025`) and `reschedulePublicBooking` (`:7064`) already treat **email + phone** as sufficient proof to *view and modify a client's bookings*, with no session at all — it is matched per-request via `matchesRescheduleContact`. The booking embed persists that email+phone as a "reschedule login" in `localStorage` and auto-hydrates it (`getInitialRescheduleLogin`, `initialRescheduleLoginRef`, `src/App.tsx:4749`; saved-reschedule effect around `:5730`).

**This is the key efficiency lever.** A player "login" can be the same email+phone check, but *upgraded to a real server session* (so the identity survives navigation and can gate read endpoints), rather than re-verified on every request. Optionally add an emailed 6-digit code for a stronger second factor later — the emailing infrastructure (`sendBookingNotifications`, Resend) already exists.

---

## Part 4 — The API gate chokepoint

Every `/api/*` route is admin-gated by a single block:
```js
if (pathname.startsWith("/api/")) {
  if (!(await requireAdmin(req))) return json({ error: "unauthorized" }, 401);   // booking-core.mts:7701
}
```
Routes exempted (checked *before* this block): `public-booking*`, `public-cancel`, `public-diagnostics`, `database-health`, `auth/*`, and the pre-login `auth/session` GET.

**Implication:** player-scoped endpoints must either (a) live under a `/api/public-*` or new `/api/player/*` prefix that is resolved *before* the admin gate, each doing its own player-session check, or (b) the gate is amended to also admit a valid player session **but only for an explicit allowlist of player-safe routes**. Option (a) is cleaner and lower-risk — it keeps the admin gate untouched and makes the player surface an explicit, auditable list.

---

## Part 5 — Front-end mode model

The app is a single SPA that switches personality by host/URL (`isPublicBookingMode`, `src/App.tsx:2053`):
- Admin: `claritygolf.app` (full workspace, admin auth, `authStatus` state machine).
- Public booking: `book.claritygolf.app` **or** `?embed=booking` → `isEmbedMode = true`, which short-circuits auth (`authStatus` starts `"authenticated"`) and renders only the booking screens.
- `View` type already includes `booking` and `players` (`:825`).

**Implication:** the player portal is a *third* personality. Cleanest fit: a new mode (e.g. host `players.claritygolf.app` or `?portal=player`) that renders a login screen → a read-only profile view → a "Book" button that jumps into the existing booking embed with identity pre-injected. It reuses the embed's booking UI wholesale; the only new UI is the login screen and the profile read-out.

---

## Part 6 — Proposed architecture (recommended: passwordless)

**Server (additive, in `booking-core.mts` + one migration):**
1. `player_sessions(id, token_hash UNIQUE, person_id → people, email, expires_at, created_at)` — additive table.
2. `POST /api/player/login` *(pre-gate)* — verify email+phone against `people`/appointments (reuse `readPublicAppointmentsForContact` / `compatiblePersonMatch`), mint a session via the existing `hashToken` + a `clarity_player_session` cookie. (Optional hardening: email a code first.)
3. `GET /api/player/session` *(pre-gate)* — resolve the player cookie → `{ person, playerIds }`.
4. `POST /api/player/logout` *(pre-gate)*.
5. `GET /api/player/profile` *(pre-gate, player-session-checked)* — returns the player's bookings (`readPublicAppointmentsForContact`), lesson notes (`readLessonNotes` filtered to the player's id set), and cloud video catalogue (`video_transfer_sessions` where `player_id` ∈ id set). All three readers already exist; this endpoint is mostly *composition + filtering*, not new persistence.
6. *(If video playback in-portal is in scope)* a player-scoped `GET /api/player/video/:savedVideoId/download` mirroring the admin transfer download, gated on the video's `player_id` matching the session.

**Client (new thin surface):**
- A player-mode detector alongside `isPublicBookingMode`.
- A login screen (email + phone, matching the reschedule form that already exists).
- A read-only profile view (bookings list, notes list, cloud videos list) — can lean heavily on existing card components.
- A "Book a lesson" action that enters the existing booking embed with the player's identity pre-filled — reuse the `initialRescheduleLoginRef` hydration path, sourced from the player session instead of `localStorage`.

**Booking pre-auth:** because the booking form already supports pre-fill and the reschedule flow already auto-hydrates identity, "pre-logged-in booking" is: on entering booking mode from the portal, seed `bookingForm`/`rescheduleForm` from `/api/player/session`. Minimal new code.

**Why passwordless first:** it (a) matches the trust model already shipped for reschedule, (b) stores no new secret credentials, (c) is dramatically less code (no password UI, no reset flow, no credential table), and (d) can be hardened with an emailed code using existing Resend infra without schema churn. Passworded accounts remain a clean later upgrade (add `player_credentials`, reuse `hashPassword` + the existing reset pattern).

---

## Part 7 — Suggested phasing

Each phase is its own scoped commit; stop for review between phases.

1. **Server auth core** — migration for `player_sessions`; `login`/`session`/`logout` endpoints (pre-gate); email+phone verification reusing existing readers. Additive; nothing else changes.
2. **Server profile read** — `GET /api/player/profile` composing bookings + notes + cloud-video catalogue filtered by the player's id set.
3. **Client portal shell** — player-mode detection, login screen, session state, logout.
4. **Client profile view** — render the three data sources read-only, reusing existing card UI.
5. **Booking hand-off** — pre-fill the booking embed from the player session.
6. *(Optional)* **In-portal video playback** — player-scoped transfer download; or defer and link out.
7. *(Optional, later)* **Passworded accounts** — if email+phone proves too weak for the use case.

---

## Part 8 — Guardrails & risks

- **`PROJECT_SOURCE_OF_TRUTH.md`**: persistence changes must be a scoped patch — the new tables are additive and this is that scoped patch. Confine everything to `source/`.
- **`PERSISTENCE_MAP.md`**: `booking-core.mts` owns persistence; player-auth handlers belong there (or thin wrappers), not in new direct-Supabase functions.
- **Admin gate integrity (highest risk):** the player surface must never widen the admin gate. Prefer pre-gate `/api/player/*` routes each doing their own session check over amending the shared `requireAdmin` block.
- **Session isolation:** distinct cookie name so a coach-who-is-also-a-player can't have one session masquerade as the other.
- **Identity strength:** email+phone is the *current* production bar for booking changes; reusing it is consistent, but if the portal exposes anything more sensitive than a client's own already-emailed data (notes, video), consider the emailed-code second factor before launch. This is a product/security call, flagged for explicit decision.
- **Video reachability:** local-only clips are invisible to the player by architecture (Part 1). Set expectations or gate "appears in portal" behind cloud upload.
- **Shared multi-tenant DB:** the production database is the shared `clarity-caddie` Supabase project (see the persistence work in this repo's history) — new tables land alongside another app's schema; name them unambiguously (`player_sessions`, not `sessions`).

---

## Part 9 — Open decisions (need answers before Phase 1)

1. **Auth model:** passwordless email+phone (recommended, mirrors reschedule) vs email+phone+emailed-code vs full passworded accounts?
2. **Video scope for v1:** bookings + notes only, or also cloud-uploaded video (with the extra transfer-download work), and is local-only video explicitly out?
3. **Entry point:** dedicated host (`players.claritygolf.app`) vs a URL flag on the existing app (`?portal=player`)?
4. **Booking hand-off depth:** just pre-fill identity on the existing booking form, or a fuller "one-tap rebook my usual" flow?

*End of audit. All findings are read-only observations; nothing in application behaviour was modified by producing this document.*
