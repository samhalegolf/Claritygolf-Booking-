import assert from "node:assert/strict";
import test from "node:test";

import {
  MINUTES_IN_DAY,
  MINUTES_IN_WEEK,
  isUnavailableSpanId,
  mergedAvailableSpans,
  unavailableSpans,
} from "./availability-blocks.mts";
import { feedItemIsBusy } from "../booking-core.mts";

const at = (hour: number, minute = 0) => hour * 60 + minute;
const window = (startHour: number, endHour: number, coachId = "coach-a") => ({
  start: at(startHour),
  end: at(endHour),
  coachId,
});
const emptyWeek = () => Array.from({ length: 7 }, () => [] as ReturnType<typeof window>[]);

const weekWith = (byDay: Record<number, ReturnType<typeof window>[]>) => {
  const week = emptyWeek();
  Object.entries(byDay).forEach(([day, windows]) => {
    week[Number(day)] = windows;
  });
  return week;
};

/** Total minutes the spans cover, for checking the week adds up. */
const totalMinutes = (spans: { durationMinutes: number }[]) =>
  spans.reduce((sum, span) => sum + span.durationMinutes, 0);

test("nothing available anywhere says nothing about when the coach is not", () => {
  assert.deepEqual(unavailableSpans(emptyWeek()), []);
  assert.deepEqual(unavailableSpans([]), []);
  assert.deepEqual(unavailableSpans(undefined), []);
});

test("a week open end to end leaves nothing unavailable", () => {
  const week = Array.from({ length: 7 }, () => [{ start: 0, end: MINUTES_IN_DAY }]);
  assert.deepEqual(unavailableSpans(week), []);
});

test("every minute the coach is not available is covered", () => {
  const week = weekWith({
    0: [window(9, 12), window(13, 17)],
    1: [window(8, 18)],
    2: [window(9, 17)],
    4: [window(9, 15)],
  });

  const open = mergedAvailableSpans(week);
  const closed = unavailableSpans(week);

  // The two together are the whole week, with nothing counted twice: this is
  // the property that makes "not available" mean "not free" in Google.
  const openMinutes = open.reduce((sum, span) => sum + (span.end - span.start), 0);
  assert.equal(openMinutes + totalMinutes(closed), MINUTES_IN_WEEK);
});

test("overnight is one span, not a pair either side of midnight", () => {
  // Open 9-5 Monday and 9-5 Tuesday: the gap between them is a single stretch
  // from Monday evening to Tuesday morning.
  const week = weekWith({ 0: [window(9, 17)], 1: [window(9, 17)] });
  const closed = unavailableSpans(week);

  const mondayEvening = closed.find((span) => span.day === 0 && span.start === at(17));
  assert.ok(mondayEvening, "Monday 5pm starts a span");
  assert.equal(mondayEvening.durationMinutes, at(16), "5pm Monday to 9am Tuesday is 16 hours");
  assert.equal(
    closed.some((span) => span.day === 1 && span.start === 0),
    false,
    "no separate Tuesday-morning span",
  );
});

test("whole days off fold into the span either side of them", () => {
  // Friday is day 4; Saturday and Sunday are closed entirely.
  const week = weekWith({ 4: [window(9, 15)], 0: [window(9, 17)] });
  const closed = unavailableSpans(week);

  const fridayAfternoon = closed.find((span) => span.day === 4 && span.start === at(15));
  assert.ok(fridayAfternoon, "Friday 3pm starts a span");
  // 3pm Friday to 9am Monday: 9h + 48h + 9h.
  assert.equal(fridayAfternoon.durationMinutes, at(9) + 2 * MINUTES_IN_DAY + at(9));
});

test("the week wraps: Sunday night and Monday morning are the same span", () => {
  const week = weekWith({ 0: [window(9, 17)], 6: [window(9, 17)] });
  const closed = unavailableSpans(week);

  // Nothing starts at Monday 00:00 — that time belongs to the span that began
  // on Sunday evening.
  assert.equal(closed.some((span) => span.day === 0 && span.start === 0), false);
  const sundayEvening = closed.find((span) => span.day === 6 && span.start === at(17));
  assert.ok(sundayEvening, "Sunday 5pm starts the wrapping span");
  assert.equal(sundayEvening.durationMinutes, at(7) + at(9), "7h Sunday night plus 9h Monday morning");
});

test("a workspace is only unavailable when no coach is free", () => {
  const covered = weekWith({ 0: [window(8, 13, "coach-a"), window(12, 18, "coach-b")] });
  const gap = weekWith({ 0: [window(8, 11, "coach-a"), window(15, 18, "coach-b")] });

  assert.equal(
    unavailableSpans(covered).some((span) => span.day === 0 && span.start > at(8) && span.start < at(18)),
    false,
    "overlapping cover leaves no hole",
  );
  assert.ok(
    unavailableSpans(gap).find((span) => span.day === 0 && span.start === at(11)),
    "a real hole between two coaches is unavailable",
  );
});

test("windows merge regardless of the order they arrive in", () => {
  const ordered = weekWith({ 0: [window(8, 11), window(10, 12), window(15, 18)] });
  const shuffled = weekWith({ 0: [window(15, 18), window(8, 11), window(10, 12)] });

  assert.deepEqual(unavailableSpans(shuffled), unavailableSpans(ordered));
});

test("ids are stable across runs and unique within a week", () => {
  const week = weekWith({ 0: [window(9, 17)], 2: [window(9, 17)], 4: [window(9, 17)] });

  const first = unavailableSpans(week).map((span) => span.id);
  const second = unavailableSpans(week).map((span) => span.id);
  assert.deepEqual(first, second, "the same pattern gives the same ids");
  assert.equal(new Set(first).size, first.length, "ids are unique");
  first.forEach((id) => assert.equal(isUnavailableSpanId(id), true));
});

test("a handful of recurring spans covers the week, not hundreds of events", () => {
  const week = weekWith({
    0: [window(9, 17)],
    1: [window(9, 17)],
    2: [window(9, 17)],
    3: [window(9, 17)],
    4: [window(9, 17)],
  });

  // Five working days: one overnight span after each, with the last wrapping
  // through the weekend into Monday. Six events would already be too many.
  assert.equal(unavailableSpans(week).length, 5);
});

test("synthetic span ids are distinguishable from booking ids", () => {
  assert.equal(isUnavailableSpanId("unavailable-0-1020"), true);
  assert.equal(isUnavailableSpanId("b1a2c3"), false);
  assert.equal(isUnavailableSpanId(""), false);
  assert.equal(isUnavailableSpanId(undefined as unknown as string), false);
});

test("a live booking or block holds its time", () => {
  assert.equal(feedItemIsBusy({ kind: "appointment", status: "booked" }), true);
  assert.equal(feedItemIsBusy({ kind: "appointment", status: "completed" }), true);
  assert.equal(feedItemIsBusy({ kind: "appointment" }), true);
  assert.equal(feedItemIsBusy({ kind: "block" }), true);
});

test("a cancelled or no-show booking releases its time", () => {
  assert.equal(feedItemIsBusy({ kind: "appointment", status: "cancelled" }), false);
  assert.equal(feedItemIsBusy({ kind: "appointment", status: "no_show" }), false);
});

test("the placeholder left by a cancelled group session is not busy time", () => {
  assert.equal(
    feedItemIsBusy({
      kind: "block",
      serviceId: "group-a",
      title: "Cancelled group session",
      note: "__cancelled_group_session__",
    }),
    false,
  );
  assert.equal(feedItemIsBusy({ kind: "block", note: "Dentist" }), true);
});
