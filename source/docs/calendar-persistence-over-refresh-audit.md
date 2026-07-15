# Clarity Booking — Persistence & Over-Refreshing Audit

*Read-only audit. No files changed by this audit. Line references are to `source/`.*

*This file is documentation only. It does not change imports, routes, handlers, schema, environment variables, sessions, cookies, UI, packages, invoicing, or deployment behaviour. See `PROJECT_SOURCE_OF_TRUTH.md` and `netlify/functions/PERSISTENCE_MAP.md` before acting on any recommendation here.*

---

## Executive summary

"Over refreshing" is not a UI-polish problem — it's structural. The app treats **the entire calendar as a single blob**: every edit to any one booking rewrites and re-reads *all* bookings, on both the client and the database. That drives full re-render cascades, O(n) database writes per one-item change, and frequent 409 conflict loops that visibly reload the calendar.

The fix is not speculative. **The correct per-item model already exists in the codebase** — it's built and in production for exactly one operation ("complete lesson"). The work is to generalize that one proven pattern to the rest of the edit paths. The only non-mechanical piece is feeding the notification engine correctly, which this document specifies exactly.

None of the recommendations below have been applied. Per `PROJECT_SOURCE_OF_TRUTH.md`, each is its own scoped persistence patch.

---

## Part 1 — The architecture, and why it refreshes

### The whole-calendar-as-one-array model

`items` (`src/App.tsx:6065`) is a single array holding *every* booking. The autosave effect depends on the whole array:

```js
}, [authStatus, calendarSyncKey, isEmbedMode, items]);   // src/App.tsx:6263
```

So editing one booking changes the whole `items` reference → autosave fires → 650ms debounce → `PUT /api/calendar-state` with **`replaceItems: true`**, sending the *entire* array.

On the server, `writeItems` (`netlify/functions/booking-core.mts:3303`) then, inside one transaction:
1. `INSERT … ON CONFLICT DO UPDATE`s **every row** in the array,
2. `SELECT`s all rows and `DELETE`s stale ones one at a time,
3. returns `readItems()` — the whole blob again (`booking-core.mts:3389`).

A one-field edit performs O(all bookings) database writes and returns N rows. The client then re-sets `items` from that response, re-rendering everything derived from it.

### Optimistic-concurrency thrash

Saves carry `syncKey` + `updatedAt`. Because **multiple writers share the same blob** — public booking, Google Calendar sync, the notification engine, and the admin UI all write `calendar_items` — a 409 is routine, not exceptional (the code comment at `src/App.tsx:6151` admits it recurs). Each 409 triggers: reload full live state → merge → re-save full blob → `setItems` again. That reload-merge-resave loop is the most visible refresh, and it's a direct consequence of the shared blob.

### Polling and post-save fan-out on top

- A 15s `setInterval` re-fetches notification history and replaces `notifications` state (`src/App.tsx:6264`).
- Every calendar save schedules **two more** `refreshNotificationHistory` calls at 1.5s and 8s (`src/App.tsx:6223`).
- Boot fans out four refreshes (`src/App.tsx:6914`).

### Render amplification

`src/App.tsx` is **22,680 lines in one component** — ~209 `useState`, ~41 `useEffect`. Several effects depend on whole objects (`coachAccount`, `brandSettings`) or freshly-derived arrays (`visibleWeekItems`), so identity churn re-runs them. With no component boundaries, any state replacement re-renders the entire tree.

---

## Part 2 — The pattern that already solves this

The "complete lesson" flow (`completeAppointmentSafely`, `src/App.tsx:11619–11830`) is **exactly the per-item model** — fully built and working:

1. Optimistically patches one item: `optimisticItems = items.map(i => i.id === itemId ? {…} : i)` → `setItems(optimisticItems)`.
2. Calls a **targeted** endpoint: `PUT /api/calendar-state` with `{ action: "complete_lesson", itemId }` — not the blob.
3. On success, patches just that row back: `persistedItems = optimisticItems.map(i => i.id === itemId ? persistedItem : i)`.
4. **Critically**, updates the fingerprint refs so the blob autosave does *not* fire:
   ```js
   lastPersistedCalendarFingerprintRef.current = calendarStateFingerprint(persistedItems, calendarSyncKey);
   lastPersistedCalendarItemsRef.current = persistedItems;
   ```
   (The autosave guard is `if (requestedFingerprint === lastPersistedCalendarFingerprintRef.current) return;`)
5. On failure: `setItems(previousItems)` — clean rollback.

Server side, `completeCalendarItemById` (`booking-core.mts:2144`) touches one row and returns just `{ item, updatedAt, stageTimings }` — no blob.

**The architecture is already half-migrated.** One operation is granular; every other edit falls through to the blob path.

Supporting primitives that already exist:
- `writeItems([oneItem])` — single-row upsert, no DELETE, no stale-sweep — already used for public booking (`booking-core.mts:4599, 4612`).
- `DELETE /api/calendar-state?id=` — targeted single-item delete (`booking-core.mts:7775`).

---

## Part 3 — Blast radius: the ~30 `setItems` call sites

| Group | Behavior | Sites | Effect |
|---|---|---|---|
| **A — Local optimistic edits** | mutate `items`, do **not** touch fingerprint refs | `dockAppointmentItem` (8231/8245), `endPointer` drag (9003/9041), `createBlockFromQuick` (9226/9267/9305/9399), quick-add block (8956), custom-group attendee (10043/10064), `updateAppointmentStatus` (11440/11479), cancellation record (7846), 14118 | Each trips the **blob autosave** → `PUT replaceItems:true` → full DELETE + re-INSERT |
| **B — Whole-array server echoes** | replace entire `items` from a response | `loadAdminCalendarState` (6752, legit), reschedule flows (10325/10331/10395), `submitBooking` (14032), conflict recovery (6202), post-verify (14322) | Full re-render cascade; the reschedule ones reset local edits |
| **C — Targeted pattern (the good one)** | patch one item + set fingerprint refs | `completeAppointmentSafely` (11674/11766) | No autosave, no cascade — the template |
| **D — Undo/rollback** | restore a snapshot | 8961, 9272, 9309, 11450, 11496 | Fine, but each re-trips autosave since the fingerprint isn't reset |

Group A is the bulk of everyday coach interaction (drag a booking, add a block, change status) — every one currently rewrites the whole calendar. Group D rollbacks *also* re-trip the blob save because they don't reconcile the fingerprint the way Group C does.

*(All line numbers above are within `src/App.tsx`.)*

---

## Part 4 — The migration

### Server (small — mostly reuse)

Add an `upsert_item` action to the existing PUT handler, mirroring the `complete_lesson` branch. The write can be O(1); **the notification diff must stay whole-world** (see Part 5 for why):

```js
// upsert_item branch in PUT /api/calendar-state
const current = await readCalendarState();                 // read already done in this handler
const idx = current.items.findIndex(i => i.id === item.id);
const nextItems = idx === -1
  ? [...current.items, item]                                // new booking
  : current.items.map(i => i.id === item.id ? item : i);    // edit

await writeItems([item]);                                   // O(1) — no DELETE, no stale-sweep
await processAdminNotificationDebounce(current.items, nextItems, { timeZone });

return json({ item: writtenRow, updatedAt });               // NOT the blob
```

Also fix one wasteful line while you're there: `writeItems` ends with `return readItems()` (`booking-core.mts:3389`) — it re-reads *all* rows even for a one-item write. The single-item path should return only the saved row (the `complete_lesson` path already does).

No schema change, no migration, no new table. The blob PUT keeps working — `upsert_item` is purely additive.

### Client (mechanical, per handler)

For each Group A handler, convert to the Group C shape:
1. `setItems(optimisticItems)` — already done.
2. `await fetch(… action:"upsert_item", item …)` instead of relying on the debounced blob PUT.
3. On success: patch the one row **and** set `lastPersistedCalendarFingerprintRef` / `lastPersistedCalendarItemsRef` — *this is the line Group A is missing, and it's why they trip autosave*.
4. On failure: `setItems(previousItems)` + reset the fingerprint to the previous snapshot.
5. Keep calling `scheduleAdminNotificationDebounceFlush()` after success (Part 5).

Apply the same fingerprint reconciliation to Group D rollbacks so undo stops re-saving.

### Why this dissolves the symptom

- No more full DELETE + re-INSERT per edit → server write drops from O(all bookings) to O(1).
- No blob echo on the response → the client stops replacing the whole `items` array, so `visibleWeekItems` and the render tree stop recomputing on every save.
- 409 storms shrink → per-item `expectedUpdatedAt` means writers only collide when editing the *same* booking. The reload-merge-resave loop largely disappears.
- Polling is then the only remaining periodic refresh, independently tunable.

---

## Part 5 — The notification contract (the one real unknown)

`processAdminNotificationDebounce(previousItems, nextItems, opts)` (`booking-core.mts:4854`) does **two jobs in one function**:

**Job 1 — Queue diffs** (gated by `opts.queueDiffs !== false`): diffs `previousById` vs `nextById` (appointments by id) over the union of ids, runs `inferBookingAction` (`netlify/functions/notification-engine.mts:775`) → `booking | cancelled | rescheduled | updated | null`. Bookings/reschedules/updates get a 30s debounce; cancellations fire immediately. The queue is a single JSON blob in the `settings` table.

**Job 2 — Flush matured entries** (always runs, **not** gated): iterates the persisted queue and fires entries past `fireAfter`, re-validating against `nextById`.

### The trap

Job 2's flush loop drops any queued id it can't find in `nextById`:

```js
const current = nextById.get(id);
queueById.delete(id);      // removed no matter what
queueChanged = true;
if (!current) continue;    // ...and the notification is silently discarded
```

If `upsert_item` passed a **single-item** `nextItems`, the flush would run against a world of one — every *other* pending notification (a booking made 25s ago on a different lesson) resolves to `undefined`, gets dequeued, and **never sends**. This is why the blob path always passes the full array, and why `complete_lesson` skips the function entirely.

### The contract

`upsert_item` must **reconstruct the full `nextItems` array in memory** (the map/push in Part 4) and pass it to the diff, even though it writes only one row. This needs **zero change** to `processAdminNotificationDebounce`: the diff and the flush both behave exactly as today, while the write and the client response stay O(1). The `readCalendarState()` is a read the PUT handler already performs (`booking-core.mts:7680`) — you're only removing the expensive part (the full DELETE+re-INSERT and the whole-array echo), not the read.

Three details to preserve:
- **Delete/cancel**: a `delete_item` path must build `nextItems = current.items.filter(i => i.id !== id)` so `inferBookingAction(prev, undefined)` returns `cancelled` and fires immediately — same as a blob delete. The existing `DELETE ?id=` route already reads `current` and can do this.
- **Keep the flush firing**: migrated handlers must still call `scheduleAdminNotificationDebounceFlush()` after success (`src/App.tsx:11804` already does), which triggers `POST /api/admin-notification-debounce` — the whole-world, `queueDiffs:false` flush (`booking-core.mts:7890`) — 32s later.
- **Re-cancel is safe**: `inferBookingAction` returns `null` when `prev.status === "cancelled"` and next is absent, so re-deleting won't double-fire — provided you reconstruct `nextItems` accurately rather than passing a stale `prev`.

### One advisory beyond correctness

The debounce queue is a **shared read-modify-write JSON setting** (`readPendingAdminNotifications` / `writePendingAdminNotifications`, `booking-core.mts:4840`). The blob PUT is debounced one-at-a-time, so races are rare today. Per-item writes can be more concurrent — two `upsert_item` calls landing together could clobber each other's queue write. It won't corrupt the calendar (separate rows now), only occasionally drop/duplicate a *notification*. Negligible for a single-admin workspace; if multiple admins edit simultaneously later, serialize notification processing or give the queue its own table (one row per pending entry) instead of one JSON blob.

---

## Part 6 — Suggested sequence

Each step is its own scoped patch.

1. **Server**: add `action:"upsert_item"` (whole-world diff, single-row write, non-blob return) + single-item return from `writeItems`. Additive; the blob PUT still works.
2. **Client, one handler**: migrate `updateAppointmentStatus` — smallest Group A, closest to `complete_lesson`. Verify no blob save fires (watch the `ADMIN_CALENDAR_SHELL_RELOAD_STARTED` diagnostic).
3. **Client, drag/dock**: migrate `endPointer` + `dockAppointmentItem` — highest-frequency interaction, biggest felt improvement.
4. **Fix Group D rollbacks** to reconcile the fingerprint so undo stops re-saving.
5. Only after 1–4 are stable: per-week `syncKey`, then normalize `items` into a `Record<id, item>` map, then begin breaking up `src/App.tsx` so re-renders can actually be contained.

---

*End of audit. All findings are read-only observations; nothing in the repository was modified by producing this document.*
