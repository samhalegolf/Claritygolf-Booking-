# Clarity Booking — Duplicate Client Merge UI: Pre-Change Audit

*Read-only audit. No files changed by this audit. Line references are to `source/`.*

*This file is documentation only. It does not change imports, routes, handlers, schema, environment variables, sessions, cookies, UI, packages, invoicing, or deployment behaviour. See `PROJECT_SOURCE_OF_TRUTH.md` and `netlify/functions/PERSISTENCE_MAP.md` before acting on any recommendation here.*

---

## Executive summary

There is no duplicate-client merge feature today, in any form. What exists is **preventive** dedup — a matching heuristic that runs on every write and tries to reuse an existing `people` row instead of creating a new one. There is nothing **corrective** — no way to find two `people` rows that already refer to the same person and combine them. The clients list UI has no selection state, no merge button, and no merge modal. The `/api/people` route supports create/update only; there is no delete and no merge endpoint.

Before building a merge UI, the two open questions are: (1) what does "duplicate" mean for the merge feature to *detect* (the existing `compatiblePersonMatch` heuristic is write-time and single-candidate; a merge UI needs a full-table duplicate scan, which doesn't exist), and (2) what has to be reassigned when two rows collapse into one (`calendar_items.person_id`, and anything else keyed by person id — see Part 3).

None of the observations below imply any code change. Per `PROJECT_SOURCE_OF_TRUTH.md`, a merge feature must be its own explicit, separately-scoped patch — and per `PERSISTENCE_MAP.md`, work that touches `people-migrate.mts` specifically needs its own focused audit before being patched.

---

## Part 1 — What dedup already exists (preventive, not corrective)

The app never intentionally creates two `people` rows for the same person going forward — the write path resolves against existing rows first:

- **`compatiblePersonMatch(candidate, rows)`** — `netlify/functions/booking-core.mts:2532`. The single matching heuristic used everywhere a person gets resolved. Priority order: exact `id` → `name + email` → `name + phone` → an *unambiguous* single `email` match → an *unambiguous* single `phone` match. A comment at 2606-2608 is explicit about the boundary: "Same-person merging is compatiblePersonMatch's job and happens on name plus a compatible phone or email — never on an email alone." (Shared-email households/clubs are expected; matching on email alone would wrongly merge them.)
- **`personFromAppointment`** — `booking-core.mts:2610`. Builds a person candidate from a calendar appointment, carrying forward `item.personId` if the appointment is already linked.
- **`stampResolvedPersonIds`** — `booking-core.mts:2633`. Writes the resolved person id back onto the appointment so the *next* save finds the same row by id instead of re-deriving the match.
- **`importPeople`** — `booking-core.mts:3057`. For each incoming person: try `knownById` (exact linked id), else `compatiblePersonMatch`; UPDATE the existing row if matched, INSERT otherwise. Each person runs in its own SAVEPOINT (3088-3096, 3172-3191) so one bad row doesn't roll back the whole calendar save.
- **`updatePerson`** — `booking-core.mts:3205`. Same `compatiblePersonMatch` resolution, used for manual edits via `PUT /api/people`.
- **`cleanPerson`** — `booking-core.mts:2447` (a near-duplicate implementation also exists in `netlify/functions/people-migrate.mts:51-79` — worth reusing rather than re-diverging if a merge feature needs person-shape cleaning).

Schema history backs this up — the `people` table has moved *away* from a hard uniqueness constraint, toward the app-level heuristic being the only thing preventing duplicates:

- `netlify/database/migrations/20260607000200_create_people/` — original table.
- `netlify/database/migrations/20260623000200_allow_shared_client_contacts/` and `netlify/database/migrations/20260714000200_allow_shared_client_emails/` — relaxed a unique-email constraint specifically because families/clubs legitimately share one email. Duplicates are no longer prevented at the database level, only by `compatiblePersonMatch` at write time.
- `netlify/database/migrations/20260715000100_add_calendar_item_person_id/` — added `calendar_items.person_id` as a stable FK, reducing (but not eliminating) duplicate spin-off from re-deriving the match on every save.

**Implication for a merge UI:** none of the above finds duplicates that *already* exist. `compatiblePersonMatch` only ever compares one incoming candidate against existing rows at write time. A merge feature needs a genuinely different operation: a full-table (or paginated) scan of `people` grouped by the same matching signals, surfaced as candidate pairs/groups for a human to confirm — `compatiblePersonMatch`'s matching *logic* is reusable for this, but the scan itself doesn't exist anywhere.

---

## Part 2 — What's missing: no merge endpoint, no merge UI

**Server side** — the only `/api/people` routes are:
- `GET /api/people` — `booking-core.mts:8208`
- `PUT /api/people` — `booking-core.mts:8263` (create-or-update one person)

There is no `DELETE /api/people`, and grepping the whole `source/` tree for "merge" turns up nothing relevant to people — only unrelated concepts that happen to share the word (`mergeEntitlementOverrides`, `mergeCalendarItemsAfterConflict`, `mergeSavedVideoItems`, Google OAuth scope merging, and Supabase's `Prefer: resolution=merge-duplicates` upsert header). None of these touch two existing `people` rows.

`netlify/functions/people-migrate.mts` (routed at `/api/people/migrate` per `PERSISTENCE_MAP.md:29`) does do bulk dedup — via `keyForPerson` (lines 92-104) and a `deduped` map (161-172) — but it's a one-time bulk-import admin tool, not reachable from any UI. Nothing in `src/App.tsx` calls `/api/people/migrate`.

**Client side** (`src/App.tsx`) — the clients list has no merge affordance at all:
- `type ClientSummary = Person & { … }` — `App.tsx:507`.
- The `clients` memo groups records by `personId` first, falling back to a `clientKey(name, email, phone)` for legacy rows without a stable link — `App.tsx:7286`. The comment there (7287-7293) notes this grouping *already* exists specifically because the old key-only grouping used to visually split one real client across multiple cards — i.e. today's list UI already papers over some duplicate-looking rows by *grouping*, without ever *merging* the underlying `people` records.
- Each row renders via a plain button, `onClick={() => openClientProfile(client)}` (around `App.tsx:17904-17921`) — no checkbox, no multi-select, no "merge" icon.
- `openClientProfile` (`App.tsx:13881`), `openNewClient` (`13889`), `closeClientModal` (`13897`), `startClientEdit` (`13905`) — the profile modal supports view/create/edit of exactly one client. No delete action, no "merge with…" action, no comparison view.
- `reassignSelectedAppointmentClient` (`App.tsx:11659`, touched in this session's calendar-persistence work) only relinks *one booking* to a different client — it does not touch the `people` table and is not a merge primitive.

---

## Part 3 — What a merge would actually have to move

If two `people` rows get collapsed into one (a "survivor" and a "loser"), everything keyed by the loser's id needs reassigning or it silently orphans:

- `calendar_items.person_id` — every booking linked to the loser needs to point at the survivor instead. This is exactly the column `stampResolvedPersonIds` (`booking-core.mts:2633`) and the `20260715000100_add_calendar_item_person_id` migration introduced to make person-linking stable; a merge is the other place that FK needs first-class handling.
- Anything else recorded against a person id (lesson notes, Caddy profile linkage, invoicing history if any references `personId`) — this audit did not exhaustively trace every table for a `person_id`/`personId` foreign key; that trace is the first concrete task before scoping a merge patch, not something to assume is limited to `calendar_items`.
- The loser row itself — delete, or soft-mark as merged-away (there's no "merged into" pointer or soft-delete column on `people` today; either approach is a schema decision the current schema doesn't already make for you).

---

## Guardrails that apply to this work

- `PROJECT_SOURCE_OF_TRUTH.md`: "Do not refactor persistence, database logic, Netlify functions, or storage paths unless that work is requested as a separate technical patch." A merge-people feature is exactly this kind of change — it should be scoped as its own explicit patch, confined to `source/`.
- `PERSISTENCE_MAP.md:29,48,88`: `people-migrate.mts` is flagged "Keep direct for now unless specifically auditing people migration behaviour" / "Leave … `people-migrate.mts` direct until each has its own focused audit." If a merge feature reuses or extends this file, that is itself the "focused audit" the doc asks for — don't fold it into a larger persistence patch silently.
- `PERSISTENCE_MAP.md:27,86`: the current appointment-derived people upsert (id → case-insensitive email → name+phone) is called out as intentional, recent behaviour. A merge feature should reuse `compatiblePersonMatch`/`importPeople`'s matching signals for duplicate *detection*, rather than inventing a second, possibly-inconsistent matching heuristic.

---

## Summary of gaps (what a merge-UI patch would need to add)

1. A duplicate-detection pass over the full `people` table (reusing `compatiblePersonMatch`'s signals), surfaced as candidate groups — does not exist.
2. A merge endpoint (e.g. `POST /api/people/merge` or similar) that reassigns `calendar_items.person_id` (and any other `person_id`-keyed data, once traced) from loser(s) to survivor, then removes or marks the loser(s) — does not exist. No `DELETE /api/people` exists either.
3. Clients-list UI: multi-select or a "possible duplicates" affordance, plus a merge confirmation view (side-by-side fields, pick survivor values) — does not exist; the current list/profile UI is single-record only.
4. A decision on whether merges are soft (loser marked merged-into-survivor, kept for audit trail) or hard-deleted — the schema makes no provision for either today.

*End of audit. All findings are read-only observations; nothing in the repository was modified by producing this document.*
