import assert from "node:assert/strict";
import test from "node:test";

import { cleanLessonNotes } from "./lessonNotesModel";

test("notes without a player or a body are dropped, and the rest come newest first", () => {
  const notes = cleanLessonNotes([
    { id: "a", playerId: "p1", body: "older", updatedAt: "2026-09-01T00:00:00.000Z" },
    { id: "b", playerId: "p1", body: "newer", updatedAt: "2026-09-08T00:00:00.000Z" },
    { id: "c", playerId: "", body: "orphan" },
    { id: "d", playerId: "p2", body: "" },
    null,
  ]);
  assert.deepEqual(
    notes.map((note) => note.id),
    ["b", "a"],
  );
  assert.equal(notes[0]?.title, "Lesson note");
  assert.equal(notes[0]?.source, "typed");
});
