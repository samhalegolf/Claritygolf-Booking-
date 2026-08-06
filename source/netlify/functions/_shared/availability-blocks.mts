/**
 * Turning a coach's availability into the time they cannot be booked.
 *
 * Two places publish this — the ICS feed and the Google Calendar API sync —
 * and they have to agree. Two implementations of "unavailable" would drift,
 * and a coach subscribing to the feed would see a different week from one
 * whose calendar is synced, with no way to tell which was right.
 */

export type AvailabilityWindow = { start: number; end: number; coachId?: string };
export type MinuteRange = { start: number; end: number };

/** How far ahead unavailable time is published. */
export const UNAVAILABLE_HORIZON_WEEKS = 12;

/**
 * The hours an unavailable block can span, taken from the earliest and latest
 * the coach ever works. Blocking the true 24-hour complement would put a
 * midnight-to-open and a close-to-midnight event on every single day, which
 * buries the calendar in events that say nothing anyone needed to know.
 *
 * Null when no availability is configured anywhere: the coach has not said
 * when they work, so there is nothing to say about when they do not.
 */
export function availabilityEnvelope(
  availability: AvailabilityWindow[][] | undefined | null,
): MinuteRange | null {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  (availability || []).forEach((dayWindows) => {
    (dayWindows || []).forEach((window) => {
      start = Math.min(start, Number(window.start));
      end = Math.max(end, Number(window.end));
    });
  });
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

/**
 * The stretches of a day the coach cannot be booked: the envelope minus that
 * weekday's availability windows, merged across coaches first — a workspace is
 * only unavailable when nobody is free.
 *
 * Returns whole-envelope coverage for a day with no availability at all, and
 * nothing when the day is open end to end.
 */
export function unavailableWindowsForDay(
  dayWindows: AvailabilityWindow[] | undefined | null,
  envelope: MinuteRange,
): MinuteRange[] {
  const open = (dayWindows || [])
    .map((window) => ({
      start: Math.max(envelope.start, Number(window.start)),
      end: Math.min(envelope.end, Number(window.end)),
    }))
    .filter((window) => window.end > window.start)
    .sort((a, b) => a.start - b.start);

  const merged: MinuteRange[] = [];
  open.forEach((window) => {
    const last = merged[merged.length - 1];
    if (last && window.start <= last.end) last.end = Math.max(last.end, window.end);
    else merged.push({ ...window });
  });

  const closed: MinuteRange[] = [];
  let cursor = envelope.start;
  merged.forEach((window) => {
    if (window.start > cursor) closed.push({ start: cursor, end: window.start });
    cursor = Math.max(cursor, window.end);
  });
  if (cursor < envelope.end) closed.push({ start: cursor, end: envelope.end });
  return closed;
}

export type UnavailableSlot = MinuteRange & { week: number; day: number; id: string };

/**
 * Every unavailable stretch across the horizon, each with a stable id derived
 * from when it is. The same slot keeps the same id run after run, so a
 * subscriber updates events in place instead of accumulating a fresh copy
 * every refresh, and the sync can tell an unchanged block from a new one.
 */
export function unavailableSlots(
  availability: AvailabilityWindow[][] | undefined | null,
  firstWeek: number,
  weeks = UNAVAILABLE_HORIZON_WEEKS,
): UnavailableSlot[] {
  const envelope = availabilityEnvelope(availability);
  if (!envelope) return [];

  const slots: UnavailableSlot[] = [];
  for (let week = firstWeek; week < firstWeek + weeks; week += 1) {
    for (let day = 0; day < 7; day += 1) {
      unavailableWindowsForDay((availability || [])[day], envelope).forEach((window) => {
        slots.push({
          ...window,
          week,
          day,
          id: `unavailable-${week}-${day}-${window.start}`,
        });
      });
    }
  }
  return slots;
}

/** True for the synthetic ids minted above, never for a real booking. */
export function isUnavailableSlotId(id: string) {
  return typeof id === "string" && id.startsWith("unavailable-");
}
