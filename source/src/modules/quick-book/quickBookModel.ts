import {
  type AvailabilityWindow,
  type CalendarItem,
  isCancelledGroupSessionItem,
  itemWeek,
} from "../calendar/calendarModel";

/** How far apart the times Book offers are. Matches the public booking page. */
export const QUICK_BOOK_STEP_MINUTES = 30;

export type QuickBookSlot = { week: number; day: number; start: number };

export type QuickBookWeek = {
  week: number;
  /** One list of windows per weekday, Monday first: whose hours count. */
  availability: AvailabilityWindow[][];
  items: CalendarItem[];
  /** Whether this booking or block takes up time in this window (same coach, or the whole place). */
  takesWindow: (item: CalendarItem, window: AvailabilityWindow) => boolean;
  isPast: (slot: QuickBookSlot) => boolean;
};

/**
 * Every half-hour in the week a booking could start: inside someone's hours,
 * with nothing of theirs on it, and not already gone. A time free for any one
 * coach is offered once; which coach and which lesson are the next step's job.
 */
export function quickBookSlots({ week, availability, items, takesWindow, isPast }: QuickBookWeek): QuickBookSlot[] {
  const live = items.filter(
    (item) =>
      itemWeek(item) === week &&
      !item.syntheticGroupSlot &&
      item.status !== "cancelled" &&
      !isCancelledGroupSessionItem(item),
  );
  const slots: QuickBookSlot[] = [];
  availability.forEach((windows, day) => {
    const starts = new Set<number>();
    const dayItems = live.filter((item) => item.day === day);
    windows.forEach((window) => {
      const taken = dayItems.filter((item) => takesWindow(item, window));
      for (let start = window.start; start + QUICK_BOOK_STEP_MINUTES <= window.end; start += QUICK_BOOK_STEP_MINUTES) {
        const end = start + QUICK_BOOK_STEP_MINUTES;
        if (starts.has(start) || isPast({ week, day, start })) continue;
        if (taken.some((item) => item.start < end && start < item.start + item.duration)) continue;
        starts.add(start);
      }
    });
    [...starts].sort((a, b) => a - b).forEach((start) => slots.push({ week, day, start }));
  });
  return slots;
}
