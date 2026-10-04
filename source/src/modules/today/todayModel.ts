import { type CalendarItem, itemWeek } from "../calendar/calendarModel";

/**
 * Where a booking stands against the clock: over (or marked done), on now,
 * the next one coming, or later today.
 */
export type TodayBookingState = "done" | "now" | "next" | "later";

export type TodayBooking = {
  item: CalendarItem;
  state: TodayBookingState;
};

export type TodayScope = {
  week: number;
  day: number;
  /** Minute of the day in the business's time zone. */
  nowMinutes: number;
  /** The same coach filter the calendar uses: an admin sees everyone, a coach sees their own. */
  inScope: (item: CalendarItem) => boolean;
};

function isTodaysAppointment(item: CalendarItem, scope: TodayScope) {
  return (
    item.kind === "appointment" &&
    !item.syntheticGroupSlot &&
    item.status !== "cancelled" &&
    itemWeek(item) === scope.week &&
    item.day === scope.day &&
    scope.inScope(item)
  );
}

/** Today's appointments in start order, each marked against the clock. */
export function todaysBookings(items: CalendarItem[], scope: TodayScope): TodayBooking[] {
  const appointments = items.filter((item) => isTodaysAppointment(item, scope)).sort((a, b) => a.start - b.start || a.duration - b.duration);
  let nextTaken = false;
  return appointments.map((item) => {
    const end = item.start + item.duration;
    if (item.status === "completed" || item.status === "no_show" || end <= scope.nowMinutes) return { item, state: "done" };
    if (item.start <= scope.nowMinutes) return { item, state: "now" };
    if (!nextTaken) {
      nextTaken = true;
      return { item, state: "next" };
    }
    return { item, state: "later" };
  });
}

/** The booking Today leads with: the one on now, otherwise the next one. */
export function featuredBooking(rows: TodayBooking[]): TodayBooking | undefined {
  return rows.find((row) => row.state === "now") ?? rows.find((row) => row.state === "next");
}

export function todaySummary(rows: TodayBooking[]) {
  const done = rows.filter((row) => row.state === "done").length;
  return { total: rows.length, done, remaining: rows.length - done };
}
