import assert from "node:assert/strict";
import test from "node:test";

import {
  availabilityForGoogleCoach,
  googleCoachesFromSettings,
  ownGoogleCoachId,
  firstGoogleCoachId,
  googleItemCoachId,
  itemBelongsOnCoachCalendar,
} from "./google-calendar-coach.mts";

const coaches = [
  { id: "sam", active: true },
  { id: "alex", active: true },
];
const services = [{ id: "junior", coachIds: ["alex"] }];

test("an item's own coach wins, then its snapshot, then its lesson type, then the first coach", () => {
  assert.equal(googleItemCoachId({ coachId: "alex" }, services, coaches), "alex");
  assert.equal(googleItemCoachId({ coach: { coachId: "alex" } }, services, coaches), "alex");
  assert.equal(googleItemCoachId({ serviceId: "junior" }, services, coaches), "alex");
  assert.equal(googleItemCoachId({ kind: "appointment" }, services, coaches), "sam");
});

test("the first coach skips archived ones", () => {
  assert.equal(firstGoogleCoachId([{ id: "old", archived: true }, { id: "new" }]), "new");
  assert.equal(firstGoogleCoachId([]), "");
});

test("a lesson goes on its coach's calendar and nobody else's", () => {
  const lesson = { kind: "appointment", coachId: "alex" };
  assert.equal(itemBelongsOnCoachCalendar(lesson, "alex", services, coaches), true);
  assert.equal(itemBelongsOnCoachCalendar(lesson, "sam", services, coaches), false);
  assert.equal(itemBelongsOnCoachCalendar(lesson, "", services, coaches), false);
});

test("a block that closes a location goes on every coach's calendar", () => {
  const closed = { kind: "block", locationId: "range" };
  assert.equal(itemBelongsOnCoachCalendar(closed, "sam", services, coaches), true);
  assert.equal(itemBelongsOnCoachCalendar(closed, "alex", services, coaches), true);
});

test("availability is split by coach, with unnamed windows belonging to the first coach", () => {
  const week = [[{ start: 540, end: 720, coachId: "alex" }, { start: 780, end: 1020 }], []];
  assert.deepEqual(availabilityForGoogleCoach(week, "alex", coaches), [[{ start: 540, end: 720, coachId: "alex" }], []]);
  assert.deepEqual(availabilityForGoogleCoach(week, "sam", coaches), [[{ start: 780, end: 1020 }], []]);
  assert.deepEqual(availabilityForGoogleCoach(null, "sam", coaches), []);
});

test("a person's own coach is the one their membership names, or for the owner the seeded coach", () => {
  const list = [{ id: "biz" }, { id: "alex" }];
  assert.equal(ownGoogleCoachId({ isOwner: true }, list, "biz"), "biz");
  assert.equal(ownGoogleCoachId({ isOwner: true, coachId: "alex" }, list, "biz"), "alex");
  assert.equal(ownGoogleCoachId({ isOwner: true }, [{ id: "alex" }], "biz"), "");
  assert.equal(ownGoogleCoachId({ coachId: "alex" }, list, "biz"), "alex");
  // No fallback to someone else's calendar for a coach without a live profile.
  assert.equal(ownGoogleCoachId({ coachId: "gone" }, list, "biz"), "");
  assert.equal(ownGoogleCoachId({}, list, "biz"), "");
});

test("an unsaved coach list is the seeded coach", () => {
  assert.deepEqual(googleCoachesFromSettings("biz", undefined), [{ id: "biz", active: true }]);
  assert.deepEqual(googleCoachesFromSettings("biz", "not json"), [{ id: "biz", active: true }]);
  assert.deepEqual(googleCoachesFromSettings("biz", '[{"id":"alex","archived":true}]'), [
    { id: "alex", active: true, archived: true },
  ]);
  assert.deepEqual(googleCoachesFromSettings("biz", "[]"), []);
});
