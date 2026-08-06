/**
 * Turning a coach's availability into the time they cannot be booked.
 *
 * Two places publish this — the ICS feed and the Google Calendar API sync —
 * and they have to agree. Two implementations of "unavailable" would drift,
 * and a coach subscribing to the feed would see a different week from one
 * whose calendar is synced, with no way to tell which was right.
 *
 * The point of publishing it is free/busy: any hour Clarity does not offer must
 * not read as free to anyone looking at the coach's calendar. That means the
 * whole 24 hours, not just the hours around the working day — an 8pm-to-8am
 * hole that shows as free is exactly the hole something else will book into.
 *
 * Availability is a weekly pattern with no dates in it, so the time it leaves
 * over is a weekly pattern too. That is published as weekly recurring events
 * rather than one event per day: a handful of events that cover every hour
 * forever, instead of a few hundred that cover a fixed horizon and go stale the
 * moment it rolls. It is also why unavailable stretches merge across midnight —
 * Friday evening through Monday morning is one span, not four.
 */

export type AvailabilityWindow = { start: number; end: number; coachId?: string };
export type MinuteRange = { start: number; end: number };

export const MINUTES_IN_DAY = 24 * 60;
export const DAYS_IN_WEEK = 7;
export const MINUTES_IN_WEEK = MINUTES_IN_DAY * DAYS_IN_WEEK;

/**
 * A stretch of unavailable time, anchored at a weekday and a time of day and
 * repeating weekly. Longer than a day whenever it runs through one or more
 * whole days the coach does not work.
 */
export type UnavailableSpan = {
  /** 0 = Monday, matching the availability array. */
  day: number;
  /** Minutes past midnight on that day. */
  start: number;
  /** How long the span runs. May exceed a day. */
  durationMinutes: number;
  /** Stable across runs, so a refresh updates in place instead of duplicating. */
  id: string;
};

/**
 * Every availability window in the week as one timeline of minutes from Monday
 * 00:00, merged. Merged across coaches as well as across days: a workspace is
 * only unavailable when nobody is free, and a window that runs to midnight
 * joins the next day's rather than leaving a seam at 00:00.
 */
export function mergedAvailableSpans(
  availability: AvailabilityWindow[][] | undefined | null,
): MinuteRange[] {
  const spans: MinuteRange[] = [];
  (availability || []).forEach((dayWindows, day) => {
    if (day >= DAYS_IN_WEEK) return;
    (dayWindows || []).forEach((window) => {
      const start = Math.max(0, Math.min(MINUTES_IN_DAY, Number(window.start)));
      const end = Math.max(0, Math.min(MINUTES_IN_DAY, Number(window.end)));
      if (!(end > start)) return;
      spans.push({ start: day * MINUTES_IN_DAY + start, end: day * MINUTES_IN_DAY + end });
    });
  });

  spans.sort((a, b) => a.start - b.start);
  const merged: MinuteRange[] = [];
  spans.forEach((span) => {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  });
  return merged;
}

/**
 * The complement: every stretch of the week the coach cannot be booked.
 *
 * Empty when no availability is configured anywhere — the coach has not said
 * when they work, so there is nothing to say about when they do not — and empty
 * again when the week is open end to end.
 *
 * The last stretch wraps: if the week ends unavailable and begins unavailable,
 * those are the same span seen from either side of Sunday midnight, so they are
 * published as one event starting late in the week and running past its end.
 */
export function unavailableSpans(
  availability: AvailabilityWindow[][] | undefined | null,
): UnavailableSpan[] {
  const open = mergedAvailableSpans(availability);
  if (!open.length) return [];

  const closed: MinuteRange[] = [];
  let cursor = 0;
  open.forEach((span) => {
    if (span.start > cursor) closed.push({ start: cursor, end: span.start });
    cursor = Math.max(cursor, span.end);
  });
  if (cursor < MINUTES_IN_WEEK) closed.push({ start: cursor, end: MINUTES_IN_WEEK });
  if (!closed.length) return [];

  // Sunday night and Monday morning are one stretch, not two. Fold the leading
  // one onto the trailing one so it publishes as a single event.
  if (closed.length > 1 && closed[0].start === 0 && closed[closed.length - 1].end === MINUTES_IN_WEEK) {
    const leading = closed.shift() as MinuteRange;
    closed[closed.length - 1].end += leading.end;
  }

  return closed.map((span) => {
    const day = Math.floor(span.start / MINUTES_IN_DAY);
    const start = span.start - day * MINUTES_IN_DAY;
    return {
      day,
      start,
      durationMinutes: span.end - span.start,
      id: `unavailable-${day}-${start}`,
    };
  });
}

/** True for the synthetic ids minted above, never for a real booking. */
export function isUnavailableSpanId(id: string) {
  return typeof id === "string" && id.startsWith("unavailable-");
}
