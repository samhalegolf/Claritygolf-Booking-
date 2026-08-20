/**
 * Reading the coach's Google Calendar back into Clarity as busy time.
 *
 * Clarity pushes its own lessons and blocks to Google. This is the other
 * direction, and it exists for one reason: the coach's diary contains
 * commitments Clarity does not know about — lessons booked through Golf HQ,
 * anything personal — and without them Clarity will happily offer a slot that
 * is already spoken for.
 *
 * What comes back is deliberately inert: a block with no client, no lesson
 * type and no price. Clarity is not being told about a booking it should
 * manage, only about an hour it cannot sell.
 *
 * ## The loop this must not create
 *
 * Clarity writes an event to Google, so a naive import would read its own
 * events straight back and stack a duplicate block on every lesson. Worse, it
 * would then push those blocks to Google and read *those* back, forever.
 *
 * This is not hypothetical. Optix mirrors the same Google calendar and relays
 * it to Clarity's webhook, and that produced exactly this loop: of 183 relayed
 * "bookings", 267 events were Clarity's own "Unavailable - Sam Hale Golf"
 * blocks and all but one of the rest were Clarity appointments in Clarity's
 * own `client - service` title format, coming home.
 *
 * Two rules keep it closed, and both matter:
 *
 *   1. **Never import an event Clarity wrote.** Every event Clarity creates
 *      carries `extendedProperties.private.clarityBooking = "true"`. That
 *      stamp is the test — not the title, not the id prefix, not a guess from
 *      the wording, all of which drift.
 *   2. **Never export a block Clarity imported.** Enforced at the other end by
 *      the sync payload, which skips items whose origin is this provider.
 *
 * Rule 1 without rule 2 still loops, one hop slower.
 */

import { calendarSlot, durationMinutes } from "./calendar-slot.mts";

/** The origin stamped on every item this import creates. Read by the outbound
 * sync to know what never to send back, and by the UI to make it read-only. */
export const GOOGLE_IMPORT_ORIGIN = "google";

export type GoogleEvent = {
  id?: string;
  status?: string;
  summary?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: Array<{ self?: boolean; responseStatus?: string }>;
  extendedProperties?: { private?: Record<string, string> };
};

export type ImportedBusyBlock = {
  id: string;
  googleEventId: string;
  title: string;
  week: number;
  day: number;
  start: number;
  duration: number;
};

/** Was this event put on the calendar by Clarity itself? */
export function isClarityOwnEvent(event: GoogleEvent) {
  return event?.extendedProperties?.private?.clarityBooking === "true";
}

/**
 * Whether a foreign event actually holds time.
 *
 * Everything rejected here is on the calendar without occupying the coach:
 * events marked free rather than busy, ones already cancelled, and invitations
 * that were declined. Importing any of them would block a slot the coach is
 * genuinely available for, which is the same harm as double-booking, reversed.
 *
 * All-day events are skipped too, but for a different reason: they carry a
 * date and no time, so "busy" would mean the whole day, and a birthday in the
 * calendar would wipe out a day of bookable hours. Treating them properly
 * needs a decision about which hours they cover, so they are left alone rather
 * than guessed at.
 */
export function holdsTime(event: GoogleEvent) {
  if (!event?.id) return false;
  if (event.status === "cancelled") return false;
  if (event.transparency === "transparent") return false;
  if (!event.start?.dateTime || !event.end?.dateTime) return false;
  const self = event.attendees?.find((attendee) => attendee?.self);
  if (self?.responseStatus === "declined") return false;
  return true;
}

/**
 * A stable Clarity id for a Google event.
 *
 * Derived from the Google id so the same event resolves to the same row on
 * every run: the import can then upsert rather than delete-and-recreate, and
 * an event that merely moved keeps its identity instead of flickering off and
 * back onto the calendar.
 */
export function importedBlockId(googleEventId: string) {
  const safe = googleEventId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return `gcal-${safe}`;
}

/**
 * What the coach should see on the block.
 *
 * The event's own summary, because a column of identical "Busy" blocks says
 * only that the day is full, not what is filling it — and this is the coach's
 * own calendar, so there is nothing here they cannot already read. "Busy" is
 * the fallback for an event with no summary at all.
 */
export function busyBlockTitle(event: GoogleEvent) {
  const summary = (event.summary || "").trim();
  return summary || "Busy";
}

/**
 * The busy blocks a calendar's events imply, in Clarity's grid coordinates.
 *
 * Pure: no network, no database. Give it what Google returned and it says what
 * Clarity should hold. Ordering is by slot so a diff against existing rows is
 * readable.
 */
export function busyBlocksFromGoogleEvents(events: GoogleEvent[], timezone: string): ImportedBusyBlock[] {
  const seen = new Set<string>();
  const blocks: ImportedBusyBlock[] = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (isClarityOwnEvent(event) || !holdsTime(event)) continue;
    const googleEventId = String(event.id);
    // A recurring event expands into instances that share an id root but each
    // carry their own; a duplicate id in one page would otherwise produce two
    // rows fighting over the same primary key.
    if (seen.has(googleEventId)) continue;
    seen.add(googleEventId);
    const startIso = String(event.start?.dateTime);
    const slot = calendarSlot(startIso, timezone);
    blocks.push({
      id: importedBlockId(googleEventId),
      googleEventId,
      title: busyBlockTitle(event),
      week: slot.week,
      day: slot.day,
      start: slot.start,
      duration: durationMinutes(startIso, String(event.end?.dateTime)),
    });
  }
  return blocks.sort((a, b) => a.week - b.week || a.day - b.day || a.start - b.start);
}

export type ExistingImportedRow = { id: string; week?: unknown; day?: unknown; start?: unknown; duration?: unknown; title?: unknown };

export type ImportReconcilePlan = {
  create: ImportedBusyBlock[];
  update: ImportedBusyBlock[];
  deleteIds: string[];
  unchanged: number;
};

/**
 * What to write, given what Google says and what Clarity already holds.
 *
 * Only rows this import owns are ever considered for deletion — the caller
 * passes exactly those. An event that vanished from Google, or moved out of
 * the window, takes its block with it; that is what stops a cancelled Golf HQ
 * lesson holding an hour forever.
 */
export function planBusyBlockImport(
  wanted: ImportedBusyBlock[],
  existing: ExistingImportedRow[],
): ImportReconcilePlan {
  const existingById = new Map<string, ExistingImportedRow>();
  for (const row of Array.isArray(existing) ? existing : []) {
    if (row?.id) existingById.set(String(row.id), row);
  }
  const plan: ImportReconcilePlan = { create: [], update: [], deleteIds: [], unchanged: 0 };
  const wantedIds = new Set<string>();
  for (const block of wanted) {
    wantedIds.add(block.id);
    const row = existingById.get(block.id);
    if (!row) {
      plan.create.push(block);
      continue;
    }
    const same =
      Number(row.week) === block.week &&
      Number(row.day) === block.day &&
      Number(row.start) === block.start &&
      Number(row.duration) === block.duration &&
      String(row.title ?? "") === block.title;
    if (same) plan.unchanged += 1;
    else plan.update.push(block);
  }
  for (const id of existingById.keys()) {
    if (!wantedIds.has(id)) plan.deleteIds.push(id);
  }
  return plan;
}
