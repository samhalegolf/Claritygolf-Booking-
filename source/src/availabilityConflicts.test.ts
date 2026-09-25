import assert from "node:assert/strict";
import test from "node:test";

import { availabilityConflicts } from "./availabilityConflicts.ts";

const week = (monday: Array<{ coachId?: string; locationId?: string; start: number; end: number }>) => [
  monday, [], [], [], [], [], [],
];

test("the same coach at two locations at once is a clash, with the overlap", () => {
  const conflicts = availabilityConflicts(
    week([
      { coachId: "bob", locationId: "range", start: 540, end: 720 },
      { coachId: "bob", locationId: "club", start: 660, end: 780 },
    ]),
    "bob",
  );
  assert.deepEqual(conflicts, [{ coachId: "bob", day: 0, start: 660, end: 720, locationIds: ["range", "club"] }]);
});

test("back-to-back, other coaches, same location and unpinned hours are not clashes", () => {
  assert.deepEqual(
    availabilityConflicts(
      week([
        { coachId: "bob", locationId: "range", start: 540, end: 600 },
        { coachId: "bob", locationId: "club", start: 600, end: 660 },
        { coachId: "cal", locationId: "club", start: 540, end: 600 },
        { coachId: "bob", start: 540, end: 700 },
        { coachId: "bob", locationId: "range", start: 540, end: 560 },
      ]),
      "bob",
    ),
    [],
  );
});
