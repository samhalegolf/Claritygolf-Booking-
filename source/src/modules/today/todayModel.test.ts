import assert from "node:assert/strict";
import test from "node:test";

import type { CalendarItem } from "../calendar/calendarModel";
import { featuredBooking, nextFreeStart, todaySummary, todaysBookings, type TodayScope } from "./todayModel";

function booking(id: string, start: number, duration: number, extra: Partial<CalendarItem> = {}): CalendarItem {
  return { id, kind: "appointment", week: 3, day: 2, start, duration, title: id, ...extra };
}

const scope = (nowMinutes: number, inScope: TodayScope["inScope"] = () => true): TodayScope => ({ week: 3, day: 2, nowMinutes, inScope });

test("today's bookings are this week and weekday only, in start order, without cancelled ones or blocks", () => {
  const rows = todaysBookings(
    [
      booking("late", 15 * 60, 60),
      booking("early", 9 * 60, 60),
      booking("other-day", 10 * 60, 60, { day: 3 }),
      booking("other-week", 10 * 60, 60, { week: 4 }),
      booking("cancelled", 11 * 60, 60, { status: "cancelled" }),
      booking("block", 12 * 60, 60, { kind: "block" }),
      booking("open-group-slot", 13 * 60, 60, { syntheticGroupSlot: true }),
    ],
    scope(8 * 60),
  );
  assert.deepEqual(rows.map((row) => row.item.id), ["early", "late"]);
});

test("each booking is marked done, now, next or later against the clock", () => {
  const rows = todaysBookings(
    [
      booking("over", 9 * 60, 60),
      booking("marked-done-early", 10 * 60, 60, { status: "completed" }),
      booking("on-now", 10 * 60 + 30, 60),
      booking("coming", 13 * 60, 60),
      booking("after", 15 * 60, 60),
    ],
    scope(11 * 60),
  );
  assert.deepEqual(
    rows.map((row) => [row.item.id, row.state]),
    [
      ["over", "done"],
      ["marked-done-early", "done"],
      ["on-now", "now"],
      ["coming", "next"],
      ["after", "later"],
    ],
  );
  assert.equal(featuredBooking(rows)?.item.id, "on-now");
  assert.deepEqual(todaySummary(rows), { total: 5, done: 2, remaining: 3 });
});

test("with nothing on now, the next booking leads; at the end of the day nothing does", () => {
  const items = [booking("a", 9 * 60, 60), booking("b", 14 * 60, 60)];
  assert.equal(featuredBooking(todaysBookings(items, scope(11 * 60)))?.item.id, "b");
  assert.equal(featuredBooking(todaysBookings(items, scope(18 * 60))), undefined);
});

test("only bookings in the coach's scope are listed", () => {
  const rows = todaysBookings(
    [booking("mine", 9 * 60, 60, { coachId: "me" }), booking("theirs", 10 * 60, 60, { coachId: "them" })],
    scope(8 * 60, (item) => item.coachId === "me"),
  );
  assert.deepEqual(rows.map((row) => row.item.id), ["mine"]);
});

test("the next free time is the next quarter-hour no booking or block covers", () => {
  const items = [booking("a", 9 * 60, 60), booking("held", 10 * 60, 30, { kind: "block" })];
  // 08:50 rounds up to 09:00, which is taken until 10:00, then blocked until 10:30.
  assert.equal(nextFreeStart(items, scope(8 * 60 + 50), 7 * 60, 21 * 60), 10 * 60 + 30);
  // Before the day opens, the first free time is the opening time.
  assert.equal(nextFreeStart([], scope(5 * 60), 7 * 60, 21 * 60), 7 * 60);
  // A cancelled booking leaves its time free.
  assert.equal(nextFreeStart([booking("gone", 9 * 60, 60, { status: "cancelled" })], scope(9 * 60), 7 * 60, 21 * 60), 9 * 60);
});

test("no free time is offered once the day has no room left", () => {
  assert.equal(nextFreeStart([], scope(20 * 60 + 50), 7 * 60, 21 * 60), null);
  assert.equal(nextFreeStart([booking("last", 20 * 60, 60)], scope(19 * 60 + 50), 7 * 60, 21 * 60), null);
});
