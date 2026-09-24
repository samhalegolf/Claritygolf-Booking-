import assert from "node:assert/strict";
import test from "node:test";

import { TILL_LESSON_FOLD_AT, tillLessonGroups } from "./tillLessons";
import type { TillLesson } from "./tillLessons";

function lesson(partial: Partial<TillLesson> & { bookingId: string }): TillLesson {
  return {
    personId: "p-jane",
    clientName: "Jane Smith",
    clientEmail: "jane@example.com",
    serviceName: "Private lesson",
    catalogItemId: "lesson:private",
    price: 90,
    startsAt: "2026-09-01T10:00:00.000Z",
    ownerLabel: "",
    ...partial,
  };
}

test("searching a client's name finds their unpaid lessons, oldest first", () => {
  const groups = tillLessonGroups(
    [
      lesson({ bookingId: "b2", startsAt: "2026-09-10T10:00:00.000Z" }),
      lesson({ bookingId: "b1", startsAt: "2026-08-10T10:00:00.000Z" }),
      lesson({ bookingId: "t1", personId: "p-tom", clientName: "Tom Brown", clientEmail: "" }),
    ],
    "jane",
  );
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].lessons.map((entry) => entry.bookingId), ["b1", "b2"]);
  assert.equal(groups[0].collapsed, false);
});

test("more than three lessons fold under the client's name", () => {
  const many = Array.from({ length: TILL_LESSON_FOLD_AT + 1 }, (_, index) => lesson({ bookingId: `b${index}` }));
  assert.equal(tillLessonGroups(many, "smith")[0].collapsed, true);
  assert.equal(tillLessonGroups(many.slice(0, TILL_LESSON_FOLD_AT), "smith")[0].collapsed, false);
});

test("a lesson already on the docket is not offered again", () => {
  const groups = tillLessonGroups([lesson({ bookingId: "b1" }), lesson({ bookingId: "b2" })], "jane", new Set(["b1"]));
  assert.deepEqual(groups[0].lessons.map((entry) => entry.bookingId), ["b2"]);
});

test("one letter is not a search, and a lesson type's name is not a client", () => {
  assert.deepEqual(tillLessonGroups([lesson({ bookingId: "b1" })], "j"), []);
  assert.deepEqual(tillLessonGroups([lesson({ bookingId: "b1" })], "private"), []);
});
