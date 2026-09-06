# Book bay — refinement plan

**Project:** Clarity Booking
**Surface:** the Optix resource panel inside the calendar booking modal
**Goal:** a spinner that tells the truth, an error that names what actually went wrong, and Resources as its own section on the card — separate from Emails.

---

## 1. Where the code is today

| Piece | File |
| --- | --- |
| The panel + Book bay button | `source/src/optix-booking-feedback.ts` (274 lines, plain DOM, injected outside React) |
| Installed at boot | `source/src/main.tsx:91` |
| Booking modal it injects into | `source/src/App.tsx:29853` (`data-calendar-item-id` on the `<aside>`) |
| The "Booking records" (emails) section | `source/src/App.tsx:20903` |
| Status read | `GET /api/optix-booking-status` → `source/netlify/functions/optix-booking-status.mts` |
| Book action | `POST /api/optix-booking-reconcile` → `optix-booking-reconcile.mts` → `_shared/optix-book-resource.mts` |
| Where error codes are born | `_shared/optix-client.mts` (`classifyOptixFailure`), `_shared/optix-auto-select.mts` |

---

## 2. Why it currently lies

These are the specific reasons the spinner and the errors can't be trusted. Every one of them traces back to the same root: the panel is raw DOM driven by a `MutationObserver`, not React state.

**a. The in-flight state gets wiped.**
`bookResource()` sets `Booking…` and disables the button, then its `finally` block calls `refreshPanels()`, which rewrites the panel's `innerHTML` from the server. The "Booking…" state is destroyed the instant the request settles — and often before that, because any DOM change in the modal fires the observer and re-renders too.

**b. There is a re-render loop.**
`installOptixBookingFeedback()` observes `document.body` with `subtree: true`, and `renderPanel()` writes `innerHTML`. That write is itself a mutation, so while a booking card is open the panel refetches `/api/optix-booking-status` over and over. Each of those fetches pulls up to 100 of the account's appointments.

**c. The error shown is not the error that happened.**
- `catch` writes the real message into `button.textContent` — then `finally` re-renders and throws it away. Network failures, 500s and auth failures show **nothing**.
- A **207** (the attempt ran, Optix said no) doesn't throw at all. No message, just a silent re-render.
- `loadRecords()` returns `[]` on any non-ok response, so a **401 expired session** looks identical to "this lesson has no sync row" — `clearPanel()` removes the panel entirely and the coach sees nothing at all.
- If `loadRecords()` throws (offline), `void refreshPanels()` is an unhandled rejection and the panel silently freezes on stale data.

**d. The status can be stale or absent for the wrong reason.**
`optix-booking-status.mts` returns the newest 100 appointments for the whole account. An older booking simply isn't in the list → panel cleared → reads as "no bay ever attempted".

**e. Some states have no action and no explanation.**
`canBook` is false when `isCancelled`, so a lesson whose bay was cancelled — including `errorCode: "optix_disabled"`, which is a *setting*, not a failure — shows no button and no reason.

**f. Bay names are hardcoded.**
`BAY_NAMES` in `optix-booking-status.mts` maps seven literal Optix resource ids to "Bay #1…#7". Any other business's resource returns `""` and the panel falls back to "Resource booked".

---

## 3. The approach

**Move the panel into React and delete the injected DOM layer.**

Not a rewrite for its own sake — b, c and d above are all caused by the observer/`innerHTML` pattern, and patching around them means keeping a second rendering system alive inside a React modal. React already holds everything the panel needs: `selected.id`, `item.bayBooked`, `item.bayResourceId`.

What that deletes outright:

- `source/src/optix-booking-feedback.ts` — the whole file. With it goes `installStyles()` and its runtime `<style>` block, `esc()`, `findBookingRecordsAnchor()` (which finds its insertion point by matching the text "Booking records"), `findOpenBookingCards()`, and the `MutationObserver`.
- The `OPTIX_RECONCILE_EVENT` custom-event bridge: `App.tsx:228-229` (imports) and the listener effect at `App.tsx:8875-8888`. A React panel calls `setItems` directly; it doesn't need to shout across `window`.
- `source/src/optix-booking-mutation-sync.ts` — an 8-line function whose entire body is a comment saying it does nothing, plus its import and call in `main.tsx`.

Keep `data-calendar-item-id` on the modal `<aside>` — `optix-origin-feedback.ts:60` still reads it. That file is out of scope here.

---

## 4. The work

### Step 1 — Server: let the panel ask about one booking

`optix-booking-status.mts`

- Accept `?calendarItemId=`. Return `{ found: boolean, record: {...} | null }` for that one row, scoped to the caller's account as it already is.
- Keep the existing list mode — `watchBayRebook` in `App.tsx:9912` uses it.
- The distinction that matters: **found with no sync row** (never attempted) vs **not found** (not this account / not an appointment) vs **request failed**. Today all three collapse to an empty array.
- Decide separately what to do about `BAY_NAMES` (see Open questions). Minimum for this step: always return `resourceId`, so the panel can say "Resource 600011" rather than nothing.

### Step 2 — One pure function for the outcome

`source/src/bookingResourceOutcome.ts` — no DOM, no React, unit-testable. Takes `{ status, payload, threw }` from the POST, or a status record, and returns:

```ts
{
  tone: "ok" | "pending" | "warn" | "error",
  title: string,        // short — this is the red line
  line: string,         // one sentence: what it means / what to do
  details?: string,     // only when there is genuinely more to say
  canRetry: boolean,
  needsOptixCheckFirst: boolean,   // timeout only — see below
}
```

The full mapping, from what the server can actually return:

| Outcome | Title | Line |
| --- | --- | --- |
| `ok: true` | Bay held | *Bay name* is booked in Optix. |
| `ok: true, alreadyBooked` | Already booked | This lesson already holds *bay name*. |
| fetch rejected | Could not reach Clarity | Check your connection and press Book bay again. |
| 401 | Signed out | Your admin session expired. Sign in and try again. |
| 403 | Not allowed | This login can't book bays for this business. |
| 400 `manual_booking_required` / `invalid_json` | Clarity sent a bad request | This is a Clarity bug, not an Optix one. Details below. |
| 503 `not_configured` | Optix isn't set up | *(server message names the missing env var)* |
| 500 other | Optix booking failed | The attempt didn't complete. Details below. |
| 207 `resource_conflict` | No bay free | Every bay configured for this lesson type is busy at this time. |
| 207 `token_expired` | Optix login expired | *(server message already names `OPTIX_ORGANIZATION_TOKEN` / `OPTIX_PERSONAL_TOKEN`)* |
| 207 `unauthorized` | Optix refused access | The Optix account isn't allowed to make bookings. |
| 207 `validation_failed` | Optix rejected the details | Optix wouldn't accept this booking's times or fields. |
| 207 `timeout` | Optix didn't answer | Optix may still have taken the bay. Check Optix before booking again. |
| 207 `not_configured` | No bays for this lesson type | Set a resource on this lesson type in Settings. |
| 207 `remote_error` | Optix returned an error | Details below. |
| record `optix_disabled` | *(not an error)* | Bays are turned off for this lesson type. |

Anything unmapped falls through to title "Optix booking failed" with the raw code in the details — never a blank box.

`details` is built from `errorMessage` (which `classifyOptixFailure` already stamps with the HTTP status and Optix request id), plus booking id, session id, attempted resource, and last-attempt time. **If there's nothing beyond the title and line, no disclosure renders** — no "Details" that opens onto an empty box.

### Step 3 — `source/src/BookingResourcesPanel.tsx`

One component, one state machine: `idle | booking | settled`.

Truthful spinner rules:

- The spinner appears on click and disappears when the request settles. Never on a timer, never optimistic, never left spinning after the answer arrives.
- Nothing else may clear it — no observer, no background refetch. While `booking`, the panel does not re-read status.
- The reconcile call is synchronous server-side with a real 25-second ceiling (`OVERALL_TIMEOUT_MS`, `optix-book-resource.mts:12`). After ~8 seconds add a second line under the spinner: *"Still waiting on Optix — this can take up to 25 seconds."* No fake progress bar, no percentage.
- Button says **Booking bay…**, carries `aria-busy="true"`, and is disabled.
- It only flips to booked when `payload.ok === true`, which the server sets only when `syncStatus === "synced"`. Not on 207, not on a 200 whose body says otherwise.
- On success, call `setItems` directly to set `bayBooked` / `bayResourceId` — same effect the custom event had, one less hop.

Error display:

- Short red title (`tone: "error"`), one line underneath, then `<details><summary>Details</summary>` only when `details` is non-empty.
- Keep the stale-failure rule that exists today (`optix-booking-feedback.ts:132-136`): a failure older than an hour is history, not the current state — no red, worded "Earlier attempt on *date* — *reason*". That instinct is right and should survive the move.
- The error stays on screen until the coach acts. It is not wiped by a refetch.

### Step 4 — Resources gets its own space on the card

In `App.tsx`, the modal's sections become:

1. Notes / recording — unchanged
2. **Resources** — new
3. **Emails** — the current "Booking records" section, renamed

Resources is a `<details className="booking-records-tab">` matching the others: icon, `<span>Resources</span>`, and an `<em>` carrying the live one-line state so it can be read without opening — *"Bay #3 held"*, *"No bay booked"*, *"Booking…"*, *"No bay free"*.

Open by default when there's a failure or no bay yet; collapsed when a bay is held.

Emails: rename the summary "Booking records" → "Emails". Nothing inside it moves — resend button and the receipt list stay as they are. This is the whole of the "emails can have its own thing" change; the split happens by Resources leaving, not by Emails changing.

### Step 5 — Styles

Move the panel's CSS from the injected `<style>` into `source/src/styles.css` beside `.booking-records-tab` (line 6767) and reuse those classes. New rules only for the spinner and the error block.

### Step 6 — Tests and check

- `source/src/bookingResourceOutcome.test.ts` — one case per row of the table above, plus the unmapped fallback and the "no details → no disclosure" rule. Runs under the existing `npm test` (`tsx --test`, see `package.json:10`).
- Grep for stragglers: `OPTIX_RECONCILE_EVENT`, `optix-booking-feedback`, `optix-booking-mutation-sync`, `optix-booking-feedback-styles`.
- Confirm `optix-origin-feedback.ts` still finds `data-calendar-item-id`.

---

## 5. Order of work

Each step compiles and ships on its own:

1. Server: single-record status (Step 1)
2. Outcome function + tests (Step 2)
3. React panel (Step 3)
4. Wire into the modal, Resources + Emails sections (Step 4, 5)
5. Delete `optix-booking-feedback.ts`, `optix-booking-mutation-sync.ts`, the event bridge, the `main.tsx` installs (Step 6)

Deletion goes last so the new panel is proven working before the old one goes.

---

## 6. Decisions

**1. Timeout double-booking — confirm-press now, external-id adoption when Optix allows it.**

On a timeout the Optix booking ids were never saved, so pressing Book bay again sends a fresh create. If the first one landed, that's two bays held.

The real fix is server-side: every booking Clarity creates carries `external_id: clarity:<appointment.id>` (`optix-reconcile.mts:266`), unique per lesson. A retry after a timeout should first ask Optix whether a booking with that external id exists, and adopt its ids into the sync row if so. That needs a read query Optix's API may or may not offer — `optix-client.mts` today has only draft and commit, no read. **Check that before building it**; it is not a blocker for this piece of work.

Ships now, either way: after a timeout the button becomes **"I've checked Optix — book anyway"** and needs a second, deliberate press. It is UI-only, and it says the state is unknown instead of pretending a retry is safe. Keep it after the lookup exists, as the fallback when the lookup itself fails.

**2. Bay names — resolve them from the inbound Optix log; delete `BAY_NAMES`.**

The names already exist. Optix webhooks carry `workspace_id` and `workspace_name` in `payload_json`, and the Integrations screen already builds its bay list from them (`observedWorkspaces`, `external-bookings.mts:67`). Confirmed against the live database: the seven hardcoded ids resolve to exactly the names the constant claims, plus bays and rooms the constant doesn't have.

`optix_webhook_events` and `optix_booking_sync` are in the same Postgres, so this is one CTE in the existing query — newest sighting per `workspace_id` wins, since a workspace gets renamed (id `637949` has carried three names). Falls back to the raw resource id when there is no sighting.

One note: `optix_webhook_events` has no `account_id` — it is a shared inbound log. The resource id being named always comes from the account's own sync row, so nothing leaks beyond a bay label the Integrations screen already shows.

**3. Cancelled and `optix_disabled` are two different things and stop sharing a state.**

- `optix_disabled` is a *setting*, not a failure. Read-only, no button, no red. One line: "Bays are off for this lesson type", pointing at Integrations → resource profiles.
- `cancelled` — the bay was released, typically by a reschedule. **Show Book bay.** That is the documented recovery path; the comment in `optix-book-resource.mts` says "Book resource on the card retries as usual", but `canBook` blocks it because it lumps both under `isCancelled`. That is a bug, not a decision.
