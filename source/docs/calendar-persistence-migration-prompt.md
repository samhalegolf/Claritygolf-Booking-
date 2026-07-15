# Calendar Persistence — Claude Code Prompt + Next-Change Sketch

Companion to `calendar-persistence-over-refresh-audit.md`. Part A is a copy-paste prompt for Claude Code that implements the audit's O(1)-write plan (steps 1–4). Part B sketches the *next* project — flipping notifications from diff-inference to explicit signals — so you can see the shape before committing to it.

---

## Part A — Claude Code prompt (the audit's plan)

> Copy everything in the block below into Claude Code from the repo root.

```
Read these first and treat them as hard constraints:
- source/docs/calendar-persistence-over-refresh-audit.md   (the audit — the plan you are implementing)
- source/PROJECT_SOURCE_OF_TRUTH.md
- source/netlify/functions/PERSISTENCE_MAP.md

GOAL
Kill the "over-refreshing" by moving single-booking edits off the whole-calendar
blob path and onto the per-item pattern that already exists for "complete lesson"
(completeAppointmentSafely in src/App.tsx, completeCalendarItemById in
netlify/functions/booking-core.mts). Do NOT change the notification behaviour —
the notification diff must keep seeing the whole calendar (audit Part 5).

RULES
- Each step below is its own scoped commit. Do not batch them. Stop after each and
  let me review before starting the next.
- Additive only. The existing blob PUT (replaceItems:true) must keep working
  untouched as a fallback. No schema change, no migration, no new table.
- Mirror the existing complete_lesson code paths in shape and naming. Do not invent
  new abstractions.
- After each client step, prove the blob save did NOT fire: the
  ADMIN_CALENDAR_SHELL_RELOAD_STARTED diagnostic (src/App.tsx ~6574) must stay
  silent for the migrated action, and the network tab must show the targeted
  action call, not a PUT with replaceItems:true.

STEP 1 — SERVER (additive)
In the PUT /api/calendar-state handler in netlify/functions/booking-core.mts, add
an action:"upsert_item" branch modelled on the existing action:"complete_lesson"
branch (~line 7682). It must:
  1. read current state (readCalendarState — the handler already does this read),
  2. build nextItems IN MEMORY: if the id exists, map/replace it; else append it,
  3. write ONLY the one row via writeItems([item])  (single-row upsert — no DELETE,
     no stale-sweep, the primitive already used by public booking),
  4. call processAdminNotificationDebounce(current.items, nextItems, { timeZone })
     with the FULL reconstructed nextItems array (audit Part 5 — do not pass a
     one-item array or notifications for other bookings get dropped),
  5. return ONLY the saved row + updatedAt — NOT the whole blob.
Also add a single-item return to writeItems: today it ends with return readItems()
(~line 3389), re-reading all rows even for a one-row write. The single-item path
should return just the saved row, exactly like complete_lesson already does.
Add a delete_item path too (or extend the existing DELETE ?id= route) that builds
nextItems = current.items.filter(i => i.id !== id) before the notification diff, so
inferBookingAction(prev, undefined) still returns "cancelled" and fires immediately.

STEP 2 — CLIENT, one handler (proof of pattern)
Migrate updateAppointmentStatus (src/App.tsx ~11440/11479) to the completeAppointmentSafely
shape:
  a. keep the optimistic setItems(optimisticItems),
  b. call fetch(... action:"upsert_item", item ...) instead of relying on the
     debounced blob PUT,
  c. on success patch the one row back AND set both fingerprint refs —
     lastPersistedCalendarFingerprintRef.current and lastPersistedCalendarItemsRef.current
     — using calendarStateFingerprint(persistedItems, calendarSyncKey). THIS is the
     line Group A handlers are missing today and why they trip autosave.
  d. on failure setItems(previousItems) AND reset the fingerprint refs to the
     previous snapshot,
  e. keep calling scheduleAdminNotificationDebounceFlush() after success.
Verify per the RULES block.

STEP 3 — CLIENT, drag/dock (biggest felt win)
Apply the same conversion to endPointer (src/App.tsx ~9003/9041) and
dockAppointmentItem (~8231/8245). These are the highest-frequency interactions.

STEP 4 — GROUP D ROLLBACKS
Fix the undo/rollback sites (src/App.tsx 8961, 9272, 9309, 11450, 11496) to reconcile
the fingerprint refs the same way, so undo stops re-tripping the blob save.

OUT OF SCOPE for this pass (do not start): per-week syncKey, normalizing items into a
Record<id,item> map, breaking up src/App.tsx, and any change to the notification engine.
```

**Why the order:** server first is additive and risk-free (nothing calls it yet). `updateAppointmentStatus` is the smallest Group A handler and closest to the proven template, so it's the cheapest way to prove the pattern. Drag/dock is where users actually feel the fix. Group D last because rollbacks only matter once the happy paths are granular.

---

## Part B — Sketch of the next change (signal-based notifications)

This is the *destination*, not part of the prompt above. Land Part A first, confirm the refreshing is gone, then do this as a clean separate project.

### The core swap

The engine today **infers** intent by diffing two full calendars. The handler already knows the intent — so declare it instead of making the server re-derive it.

**Today (diff-inference — why the whole array is required):**

```js
// server: has to reconstruct the whole world just to guess what changed
const current  = await readCalendarState();
const nextItems = /* full array with the one edit applied */;
await processAdminNotificationDebounce(current.items, nextItems, { timeZone });
//        └─ diffs prev-vs-next over every id, runs inferBookingAction() to GUESS:
//           booking | cancelled | rescheduled | updated | null
```

**Proposed (signal — the caller states intent):**

```js
// client: the handler already knows what the user did
await fetch("/api/calendar-state", {
  method: "PUT",
  body: JSON.stringify({
    action: "upsert_item",
    item,
    notify: { type: "rescheduled", itemId: item.id }   // <-- explicit, never guessed
  }),
});

// server: no whole-world diff, no readCalendarState-for-notifications
if (body.notify) {
  await enqueueNotification(body.notify, { timeZone });  // O(1), acts on declared intent
}
await writeItems([item]);
```

### The ~5 signals

Only a handful of actions ever email. Map each handler to exactly one:

| User action (handler)                    | Signal            | Timing            |
|------------------------------------------|-------------------|-------------------|
| new booking (submitBooking / quick-add)  | `booking`         | 30s debounce      |
| reschedule (endPointer / reschedule)     | `rescheduled`     | 30s debounce      |
| edit details (updateAppointmentStatus)   | `updated`         | 30s debounce      |
| cancel / delete (delete_item)            | `cancelled`       | immediate         |
| complete lesson (already granular)       | (none / existing) | —                 |

`inferBookingAction` and the whole-world diff go away for these paths.

### The two things you must NOT lose

The diff was giving you two behaviours for free. An event system has to own them explicitly:

1. **Catch-all coverage.** The diff caught changes from *every* writer — public booking form, Google Calendar sync, admin UI — because it just compared states. With signals, **every one of those writers must emit.** Before starting, confirm the public-booking path and the Google-sync path are code you can add an `emit` to. Any writer that forgets → silent missing notification. If a source can't emit (e.g. Google sync writes rows out of band), keep the diff as a safety net *for that source only* — a hybrid, not a full replacement.

2. **Coalescing at flush.** Today the 30s flush re-checks current state and drops/merges stale entries automatically (book-then-cancel within the window quietly cancels itself). With signals you handle this in `enqueueNotification`:

```js
function enqueueNotification(sig, opts) {
  const q = readPendingAdminNotifications();
  if (sig.type === "cancelled") {
    // cancel supersedes a still-pending booking for the same id
    const pending = q.find(e => e.itemId === sig.itemId);
    if (pending?.type === "booking") { removeFromQueue(q, sig.itemId); return; }
    fireImmediately(sig); return;                      // matches today's cancel-now
  }
  upsertQueueEntry(q, { ...sig, fireAfter: now() + 30_000 });  // debounce window
  writePendingAdminNotifications(q);
}
```

### Net effect

The Part 5 "trap" disappears entirely — there's no whole-world array to reconstruct, so the write is O(1) *and* the notification path is O(1). You trade the engine's automatic-but-fragile inference for a handful of explicit, always-correct signals. The cost is discipline: every writer must emit, and you own the coalescing logic that the diff used to give you for free.

### Suggested sequencing for Part B (later)

1. Add `notify` payload support + `enqueueNotification` server-side, keeping the diff path alive in parallel.
2. Convert the admin-UI handlers one at a time to send signals; verify each still emails correctly.
3. Convert public booking + Google sync to emit — or, if either can't, formally keep the diff as a scoped safety net for it.
4. Only once every notifying writer emits: delete `inferBookingAction` and the whole-world diff.

---

*Companion doc. Read-only guidance; changes nothing until the prompt in Part A is run.*
