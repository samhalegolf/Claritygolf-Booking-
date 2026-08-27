import assert from "node:assert/strict";
import test from "node:test";

import {
  busyBlockTitle,
  busyBlocksFromGoogleEvents,
  holdsTime,
  importedBlockId,
  isClarityOwnEvent,
  planBusyBlockImport,
} from "./google-calendar-import.mts";
import { calendarSlot, durationMinutes } from "./calendar-slot.mts";

const timezone = "Pacific/Auckland";

/** A foreign event: something in the coach's diary that Clarity did not write. */
function foreign(overrides: Record<string, unknown> = {}) {
  return {
    id: "golfhq-1",
    status: "confirmed",
    summary: "Golf HQ lesson - Ryan Haste",
    start: { dateTime: "2026-08-21T07:00:00+12:00" },
    end: { dateTime: "2026-08-21T08:00:00+12:00" },
    ...overrides,
  };
}

/** What Clarity writes: same shape, plus the stamp it puts on its own events. */
function clarityOwn(overrides: Record<string, unknown> = {}) {
  return foreign({
    id: "cg3eb889be137a459d94843ea7cf228a",
    summary: "Sam Wu - 1 Hour Golf Lesson",
    extendedProperties: { private: { clarityBooking: "true", clarityBookingId: "appt-1", clarityKind: "appointment" } },
    ...overrides,
  });
}

// The loop this whole module exists to prevent. Optix mirroring the same
// calendar produced it for real: 267 relayed events were Clarity's own
// "Unavailable - Sam Hale Golf" blocks coming home, plus Clarity appointments
// in Clarity's own "client - service" title format.
test("Clarity's own events are never imported back", () => {
  assert.equal(isClarityOwnEvent(clarityOwn()), true);
  assert.equal(isClarityOwnEvent(clarityOwn({ summary: "Unavailable - Sam Hale Golf" })), true);
  assert.equal(isClarityOwnEvent(foreign()), false);
  assert.deepEqual(busyBlocksFromGoogleEvents([clarityOwn(), clarityOwn({ id: "cg-other" })], timezone), []);
});

test("the stamp is what identifies Clarity's events, not the title", () => {
  // A Golf HQ lesson could be worded exactly like a Clarity one — and the
  // reverse trap: a coach's own event titled "Busy - Sam Hale Golf" that
  // Clarity did not write is genuinely foreign busy time and must import.
  const impostorTitle = foreign({ summary: "Sam Wu - 1 Hour Golf Lesson" });
  assert.equal(isClarityOwnEvent(impostorTitle), false);
  assert.equal(busyBlocksFromGoogleEvents([impostorTitle], timezone).length, 1);

  // And an unstamped event with Clarity's own id prefix is still foreign: the
  // prefix is a naming convention, the stamp is the contract.
  assert.equal(isClarityOwnEvent(foreign({ id: "cgdeadbeef" })), false);
});

test("only events that actually hold the coach's time are imported", () => {
  assert.equal(holdsTime(foreign()), true);
  // Marked free rather than busy.
  assert.equal(holdsTime(foreign({ transparency: "transparent" })), false);
  // Already cancelled.
  assert.equal(holdsTime(foreign({ status: "cancelled" })), false);
  // An invitation the coach declined — they are free, whatever the organiser thinks.
  assert.equal(holdsTime(foreign({ attendees: [{ self: true, responseStatus: "declined" }] })), false);
  // Accepted, or someone else declined, still holds.
  assert.equal(holdsTime(foreign({ attendees: [{ self: true, responseStatus: "accepted" }] })), true);
  assert.equal(holdsTime(foreign({ attendees: [{ self: false, responseStatus: "declined" }] })), true);
  // All-day: a date and no time. Importing it would block the whole day.
  assert.equal(holdsTime(foreign({ start: { date: "2026-08-21" }, end: { date: "2026-08-22" } })), false);
  assert.equal(holdsTime(foreign({ id: undefined })), false);
});

test("a foreign event becomes an inert block on the right slot", () => {
  const [block] = busyBlocksFromGoogleEvents([foreign()], timezone);
  // 7am Friday 21 Aug 2026 NZ. Anchor is Monday 1 June 2026.
  assert.deepEqual(calendarSlot("2026-08-21T07:00:00+12:00", timezone), { week: block.week, day: block.day, start: 420 });
  assert.equal(block.start, 420);
  assert.equal(block.duration, 60);
  assert.equal(block.title, "Golf HQ lesson - Ryan Haste");
  assert.equal(block.id, "gcal-primary-golfhq-1");
  assert.equal(block.sourceId, "primary");
  assert.equal(block.sourceName, "");
});

test("the timezone decides the day, not UTC", () => {
  // 09:00 Auckland on Monday is 21:00 Sunday UTC. Read in UTC this lands on
  // the wrong day, and the block would hold an hour the coach is free.
  const monday = busyBlocksFromGoogleEvents(
    [foreign({ start: { dateTime: "2026-08-17T09:00:00+12:00" }, end: { dateTime: "2026-08-17T10:00:00+12:00" } })],
    timezone,
  )[0];
  assert.equal(monday.day, 0);
  assert.equal(monday.start, 540);
});

test("the block shows what is filling the time, falling back to Busy", () => {
  assert.equal(busyBlockTitle(foreign()), "Golf HQ lesson - Ryan Haste");
  assert.equal(busyBlockTitle(foreign({ summary: "   " })), "Busy");
  assert.equal(busyBlockTitle(foreign({ summary: undefined })), "Busy");
  assert.equal(
    busyBlockTitle(foreign({ summary: "" }), { sourceId: "golf-hq", sourceName: "Golf HQ Lessons", showLabel: true }),
    "Golf HQ Lessons",
  );
  assert.equal(
    busyBlockTitle(foreign(), { sourceId: "golf-hq", sourceName: "Golf HQ Lessons", showLabel: false }),
    "Busy",
  );
});

test("a Google id is turned into a stable, safe Clarity id", () => {
  // Stable, so an event that moved is updated in place rather than deleted and
  // recreated — which would flicker it off the calendar between runs.
  assert.equal(importedBlockId("abc123"), importedBlockId("abc123"));
  assert.notEqual(importedBlockId("abc123"), importedBlockId("abc124"));
  // Google ids are alphanumeric, but nothing that reaches a row id should be
  // able to carry a slash or a quote.
  assert.equal(importedBlockId("a/b'c d"), "gcal-primary-abcd");
  assert.equal(importedBlockId("abc123", "Golf HQ / Lessons"), "gcal-GolfHQLessons-abc123");
});

test("a duplicate id in one page produces one block, not two fighting rows", () => {
  const blocks = busyBlocksFromGoogleEvents([foreign(), foreign()], timezone);
  assert.equal(blocks.length, 1);
});

test("source identity keeps matching event ids from different calendars separate", () => {
  const [lesson] = busyBlocksFromGoogleEvents([foreign()], timezone, {
    sourceId: "golf-hq-lessons",
    sourceName: "Golf HQ - Lessons",
    showLabel: true,
  });
  const [busy] = busyBlocksFromGoogleEvents([foreign()], timezone, {
    sourceId: "golf-hq-busy",
    sourceName: "Golf HQ - Busy",
    showLabel: false,
  });
  assert.notEqual(lesson.id, busy.id);
  assert.equal(lesson.title, "Golf HQ lesson - Ryan Haste");
  assert.equal(busy.title, "Busy");
});

test("a zero-length or backwards event still gets a real duration", () => {
  // A block with no height is invisible on the grid but still holds its slot.
  assert.equal(durationMinutes("2026-08-21T07:00:00+12:00", "2026-08-21T07:00:00+12:00"), 60);
  assert.equal(durationMinutes("2026-08-21T08:00:00+12:00", "2026-08-21T07:00:00+12:00"), 60);
  assert.equal(durationMinutes("2026-08-21T07:00:00+12:00", "not-a-time"), 60);
  assert.equal(durationMinutes("2026-08-21T07:00:00+12:00", "2026-08-21T07:45:00+12:00"), 45);
});

test("reconcile creates, updates and removes only what changed", () => {
  const wanted = busyBlocksFromGoogleEvents(
    [foreign(), foreign({ id: "golfhq-2", start: { dateTime: "2026-08-22T09:00:00+12:00" }, end: { dateTime: "2026-08-22T10:00:00+12:00" } })],
    timezone,
  );
  const plan = planBusyBlockImport(wanted, [
    // unchanged
    { id: "gcal-primary-golfhq-1", week: wanted[0].week, day: wanted[0].day, start: wanted[0].start, duration: 60, title: "Golf HQ lesson - Ryan Haste" },
    // no longer in Google — the lesson was cancelled there
    { id: "gcal-gone", week: 1, day: 1, start: 600, duration: 60, title: "Old" },
  ]);
  assert.deepEqual(plan.create.map((b) => b.id), ["gcal-primary-golfhq-2"]);
  assert.deepEqual(plan.deleteIds, ["gcal-gone"]);
  assert.equal(plan.unchanged, 1);
  assert.equal(plan.update.length, 0);
});

test("an event that moved is updated in place", () => {
  const wanted = busyBlocksFromGoogleEvents([foreign()], timezone);
  const plan = planBusyBlockImport(wanted, [
    { id: "gcal-primary-golfhq-1", week: wanted[0].week, day: wanted[0].day, start: 900, duration: 60, title: "Golf HQ lesson - Ryan Haste" },
  ]);
  assert.deepEqual(plan.update.map((b) => b.id), ["gcal-primary-golfhq-1"]);
  assert.equal(plan.create.length, 0);
  assert.equal(plan.deleteIds.length, 0);
});

test("a retitled event is an update, so the block does not go stale", () => {
  const wanted = busyBlocksFromGoogleEvents([foreign({ summary: "Moved to Bay 3" })], timezone);
  const plan = planBusyBlockImport(wanted, [
    { id: "gcal-primary-golfhq-1", week: wanted[0].week, day: wanted[0].day, start: wanted[0].start, duration: 60, title: "Golf HQ lesson - Ryan Haste" },
  ]);
  assert.deepEqual(plan.update.map((b) => b.title), ["Moved to Bay 3"]);
});

test("an empty calendar removes every block this import owns, and nothing else", () => {
  // The caller passes only rows this import owns, so a quiet week must not be
  // able to reach a lesson or a coach's own block.
  const plan = planBusyBlockImport([], [{ id: "gcal-a" }, { id: "gcal-b" }]);
  assert.deepEqual(plan.deleteIds.sort(), ["gcal-a", "gcal-b"]);
  assert.equal(plan.create.length, 0);
});
