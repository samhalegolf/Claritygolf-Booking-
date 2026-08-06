import assert from "node:assert/strict";
import test from "node:test";

import {
  availabilityEnvelope,
  isUnavailableSlotId,
  unavailableSlots,
  unavailableWindowsForDay,
} from "./availability-blocks.mts";
import { feedItemIsBusy } from "../booking-core.mts";

const at = (hour: number, minute = 0) => hour * 60 + minute;

const window = (startHour: number, endHour: number, coachId = "coach-a") => ({
  start: at(startHour),
  end: at(endHour),
  coachId,
});

test("the envelope spans the earliest and latest the coach ever works", () => {
  const availability = [
    [window(9, 17)],
    [window(7, 12)],
    [],
    [window(10, 20)],
    [],
    [],
    [],
  ];

  assert.deepEqual(availabilityEnvelope(availability), { start: at(7), end: at(20) });
});

test("no availability anywhere means nothing to say about unavailable time", () => {
  assert.equal(availabilityEnvelope([[], [], [], [], [], [], []]), null);
  assert.equal(availabilityEnvelope([]), null);
  assert.equal(availabilityEnvelope(undefined), null);
});

test("a day open end to end has no unavailable stretches", () => {
  const envelope = { start: at(9), end: at(17) };

  assert.deepEqual(unavailableWindowsForDay([window(9, 17)], envelope), []);
});

test("a day with no availability is blocked across the envelope", () => {
  const envelope = { start: at(7), end: at(20) };

  assert.deepEqual(unavailableWindowsForDay([], envelope), [{ start: at(7), end: at(20) }]);
  assert.deepEqual(unavailableWindowsForDay(undefined, envelope), [{ start: at(7), end: at(20) }]);
});

test("the edges of the envelope either side of a working day are blocked", () => {
  const envelope = { start: at(7), end: at(20) };

  assert.deepEqual(unavailableWindowsForDay([window(9, 17)], envelope), [
    { start: at(7), end: at(9) },
    { start: at(17), end: at(20) },
  ]);
});

test("a lunch break between two windows is blocked", () => {
  const envelope = { start: at(9), end: at(17) };

  assert.deepEqual(unavailableWindowsForDay([window(9, 12), window(13, 17)], envelope), [
    { start: at(12), end: at(13) },
  ]);
});

test("a workspace is only unavailable when no coach is free", () => {
  const envelope = { start: at(8), end: at(18) };
  // Two coaches covering 8-13 and 12-18 between them: overlapping, so the day
  // is continuously covered and nothing is blocked.
  const covered = unavailableWindowsForDay(
    [window(8, 13, "coach-a"), window(12, 18, "coach-b")],
    envelope,
  );
  assert.deepEqual(covered, []);

  // Same two coaches with a real hole between them.
  const withHole = unavailableWindowsForDay(
    [window(8, 11, "coach-a"), window(15, 18, "coach-b")],
    envelope,
  );
  assert.deepEqual(withHole, [{ start: at(11), end: at(15) }]);
});

test("windows are merged regardless of the order they arrive in", () => {
  const envelope = { start: at(8), end: at(18) };

  assert.deepEqual(
    unavailableWindowsForDay([window(15, 18), window(8, 11), window(10, 12)], envelope),
    [{ start: at(12), end: at(15) }],
  );
});

test("availability reaching outside the envelope is clipped, not overflowed", () => {
  const envelope = { start: at(9), end: at(17) };

  // A day that starts before and ends after the envelope covers all of it.
  assert.deepEqual(unavailableWindowsForDay([window(6, 22)], envelope), []);
  // One entirely outside leaves the envelope untouched.
  assert.deepEqual(unavailableWindowsForDay([window(20, 22)], envelope), [
    { start: at(9), end: at(17) },
  ]);
});

test("the unavailable stretches and the working windows tile the envelope exactly", () => {
  const envelope = { start: at(7), end: at(21) };
  const open = [window(8, 11), window(13, 16), window(18, 19)];
  const closed = unavailableWindowsForDay(open, envelope);

  const total = [...open, ...closed].reduce((sum, entry) => sum + (entry.end - entry.start), 0);
  assert.equal(total, envelope.end - envelope.start, "no minute is double-counted or dropped");

  const ordered = [...open, ...closed].sort((a, b) => a.start - b.start);
  assert.equal(ordered[0].start, envelope.start);
  assert.equal(ordered[ordered.length - 1].end, envelope.end);
  ordered.forEach((entry, index) => {
    if (index === 0) return;
    assert.equal(entry.start, ordered[index - 1].end, "the day is contiguous");
  });
});

test("slots are walked across the horizon with ids that say when they are", () => {
  const availability = [
    [window(9, 12), window(13, 17)], // Mon: 8-9, 12-13, 17-18 unavailable
    [window(8, 18)], // Tue: open across the envelope
    [window(9, 17)], // Wed: 8-9, 17-18
    [window(9, 17)], // Thu: 8-9, 17-18
    [window(9, 15)], // Fri: 8-9, 15-18
    [], // Sat: whole envelope
    [], // Sun: whole envelope
  ];

  const oneWeek = unavailableSlots(availability, 4, 1);
  assert.equal(oneWeek.length, 11, "3 + 0 + 2 + 2 + 2 + 1 + 1");
  assert.equal(oneWeek.filter((slot) => slot.day === 1).length, 0, "a day open end to end has none");
  assert.deepEqual(oneWeek[0], { week: 4, day: 0, start: at(8), end: at(9), id: "unavailable-4-0-480" });

  const twelveWeeks = unavailableSlots(availability, 4, 12);
  assert.equal(twelveWeeks.length, 11 * 12);
  assert.equal(new Set(twelveWeeks.map((slot) => slot.id)).size, twelveWeeks.length, "ids are unique");

  // Same inputs, same ids — this is what stops a refresh duplicating events.
  assert.deepEqual(unavailableSlots(availability, 4, 12).map((slot) => slot.id), twelveWeeks.map((slot) => slot.id));
});

test("no availability produces no slots at all", () => {
  assert.deepEqual(unavailableSlots([[], [], [], [], [], [], []], 0, 12), []);
  assert.deepEqual(unavailableSlots(undefined, 0, 12), []);
});

test("synthetic slot ids are distinguishable from booking ids", () => {
  assert.equal(isUnavailableSlotId("unavailable-4-0-480"), true);
  assert.equal(isUnavailableSlotId("b1a2c3"), false);
  assert.equal(isUnavailableSlotId(""), false);
  assert.equal(isUnavailableSlotId(undefined as unknown as string), false);
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
  // An ordinary block carrying an unrelated note still holds its time.
  assert.equal(feedItemIsBusy({ kind: "block", note: "Dentist" }), true);
});
