import assert from "node:assert/strict";
import test from "node:test";

import type { AvailabilityWindow, CalendarItem } from "../calendar/calendarModel";
import { quickBookSlots, type QuickBookWeek } from "./quickBookModel";

const hour = (h: number) => h * 60;

function booking(id: string, day: number, start: number, duration: number, extra: Partial<CalendarItem> = {}): CalendarItem {
  return { id, kind: "appointment", week: 5, day, start, duration, title: id, coachId: "sam", ...extra };
}

function week(availability: AvailabilityWindow[][], items: CalendarItem[] = [], extra: Partial<QuickBookWeek> = {}): QuickBookWeek {
  return {
    week: 5,
    availability,
    items,
    takesWindow: (item, window) => item.coachId === window.coachId,
    isPast: () => false,
    ...extra,
  };
}

const days = (byDay: Record<number, AvailabilityWindow[]>) => Array.from({ length: 7 }, (_, day) => byDay[day] ?? []);
const starts = (slots: { day: number; start: number }[]) => slots.map((slot) => `${slot.day}@${slot.start / 60}`);

test("every half-hour inside the hours is offered, and nothing that would run past them", () => {
  const slots = quickBookSlots(week(days({ 1: [{ coachId: "sam", start: hour(9), end: hour(11) }] })));
  assert.deepEqual(starts(slots), ["1@9", "1@9.5", "1@10", "1@10.5"]);
});

test("a booking or block takes its time away; a cancelled one or another week's does not", () => {
  const slots = quickBookSlots(
    week(days({ 1: [{ coachId: "sam", start: hour(9), end: hour(12) }] }), [
      booking("lesson", 1, hour(9), 45),
      booking("block", 1, hour(11), 30, { kind: "block" }),
      booking("cancelled", 1, hour(10), 60, { status: "cancelled" }),
      booking("next-week", 1, hour(10), 60, { week: 6 }),
      booking("open-group-slot", 1, hour(10), 60, { syntheticGroupSlot: true }),
    ]),
  );
  assert.deepEqual(starts(slots), ["1@10", "1@10.5", "1@11.5"]);
});

test("one coach being busy does not hide a time another coach is free", () => {
  const slots = quickBookSlots(
    week(
      days({
        2: [
          { coachId: "sam", start: hour(9), end: hour(10) },
          { coachId: "alex", start: hour(9), end: hour(10) },
        ],
      }),
      [booking("sam-lesson", 2, hour(9), 60)],
    ),
  );
  assert.deepEqual(starts(slots), ["2@9", "2@9.5"]);
});

test("times already gone are left out", () => {
  const slots = quickBookSlots(
    week(days({ 0: [{ coachId: "sam", start: hour(9), end: hour(10) }], 3: [{ coachId: "sam", start: hour(9), end: hour(10) }] }), [], {
      isPast: (slot) => slot.day === 0,
    }),
  );
  assert.deepEqual(starts(slots), ["3@9", "3@9.5"]);
});
