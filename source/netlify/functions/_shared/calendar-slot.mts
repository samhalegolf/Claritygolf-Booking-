/**
 * The one definition of where a moment sits on the Clarity calendar.
 *
 * Clarity stores a calendar item as week / day / start-minute rather than a
 * timestamp, all measured from one fixed anchor. Every place that converts
 * between a real instant and that grid has to use the same anchor and the same
 * timezone rules, or items land a week or a day out — and that drift is only
 * visible once something is already on the wrong date.
 *
 * This module exists because three copies of the anchor had appeared: the
 * inbound integration pipeline, the outbound Google sync, and (as of the
 * inbound Google import) a third. They agreed, but nothing made them agree.
 */

/** Monday 1 June 2026, UTC. Week 0, day 0. Never change this. */
export const BASE_WEEK_START = Date.UTC(2026, 5, 1);

export const MINUTES_IN_DAY = 24 * 60;

export type CalendarSlot = { week: number; day: number; start: number };

const DAY_INDEX: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/**
 * Where an instant falls on the grid, read in the given timezone.
 *
 * The timezone matters: 7am Auckland is the previous day in UTC for most of
 * the year, so reading the parts in UTC would file a Monday morning lesson
 * under Sunday.
 */
export function calendarSlot(startIso: string, timezone: string): CalendarSlot {
  const date = new Date(startIso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
  const localDate = Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")));
  return {
    week: Math.floor((localDate - BASE_WEEK_START) / (7 * 86_400_000)),
    day: DAY_INDEX[get("weekday")] ?? 0,
    start: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

/**
 * How long something runs, in whole minutes, floored at 1.
 *
 * A zero-length or backwards range would otherwise become a calendar item with
 * no height, invisible on the grid but still holding its slot against a
 * duplicate check.
 */
export function durationMinutes(startIso: string, endIso: string, fallback = 60) {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return fallback;
  const minutes = Math.round((end - start) / 60_000);
  return minutes > 0 ? minutes : fallback;
}
