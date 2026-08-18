import assert from "node:assert/strict";
import test from "node:test";

import {
  initialInlineEdit,
  inlineEditReducer as reduce,
  isDirty,
  savedLabel,
} from "./inlineEditState.ts";

const start = () => initialInlineEdit("Clarity Golf");

test("a row at rest has nothing to save", () => {
  const state = start();
  assert.equal(state.status, "resting");
  assert.equal(isDirty(state), false);
  // Rule 06: a panel at rest never shows Save, disabled or otherwise. There is
  // nothing in the resting state for a button to bind to, by design.
  assert.equal(state.draft, state.value);
});

test("editing then cancelling puts the value back", () => {
  let state = reduce(start(), { type: "edit" });
  state = reduce(state, { type: "change", draft: "Half typed" });
  assert.equal(isDirty(state), true);
  state = reduce(state, { type: "cancel" });
  assert.equal(state.status, "resting");
  assert.equal(state.draft, "Clarity Golf");
});

test("saving an unchanged value is not a save", () => {
  // No network call, and no "Saved" flash. A confirmation for something that
  // did not happen teaches you to distrust the next one.
  const state = reduce(reduce(start(), { type: "edit" }), { type: "save" });
  assert.equal(state.status, "resting");
  assert.equal(state.savedAt, null);
});

test("a real change goes editing → saving → saved → resting", () => {
  let state = reduce(start(), { type: "edit" });
  state = reduce(state, { type: "change", draft: "Clarity Golf Academy" });
  state = reduce(state, { type: "save" });
  assert.equal(state.status, "saving");

  state = reduce(state, { type: "resolved", value: "Clarity Golf Academy", at: 1_700_000_000_000 });
  assert.equal(state.status, "saved");
  assert.equal(state.value, "Clarity Golf Academy");
  assert.equal(isDirty(state), false);

  state = reduce(state, { type: "settle" });
  assert.equal(state.status, "resting");
  assert.equal(state.value, "Clarity Golf Academy");
});

test("a failed save keeps what was typed", () => {
  let state = reduce(start(), { type: "edit" });
  state = reduce(state, { type: "change", draft: "Clarity Golf Academy" });
  state = reduce(state, { type: "save" });
  state = reduce(state, { type: "rejected", error: "Network unavailable." });

  assert.equal(state.status, "failed");
  assert.equal(state.draft, "Clarity Golf Academy", "the draft must survive");
  assert.equal(state.value, "Clarity Golf", "and the committed value must not move");
  assert.equal(state.error, "Network unavailable.");

  // Typing again clears the error but keeps the row open — the fix belongs
  // where the mistake is.
  state = reduce(state, { type: "change", draft: "Clarity Golf Ltd" });
  assert.equal(state.status, "editing");
  assert.equal(state.error, null);
});

test("settle never yanks a row out of an edit", () => {
  // The 2s timer can fire while somebody has started a second edit on the same
  // row. It must do nothing.
  const editing = reduce(start(), { type: "edit" });
  assert.equal(reduce(editing, { type: "settle" }).status, "editing");

  const failed = reduce(
    reduce(reduce(editing, { type: "change", draft: "x" }), { type: "save" }),
    { type: "rejected", error: "no" },
  );
  assert.equal(reduce(failed, { type: "settle" }).status, "failed");
});

test("an outside change cannot pull the ground from under someone typing", () => {
  let state = reduce(start(), { type: "edit" });
  state = reduce(state, { type: "change", draft: "Mine" });
  state = reduce(state, { type: "sync", value: "Theirs" });

  // The committed value moves so a cancel returns to the truth, but the draft
  // is left alone.
  assert.equal(state.value, "Theirs");
  assert.equal(state.draft, "Mine");
  assert.equal(state.status, "editing");

  // At rest, the same event simply updates the row.
  const resting = reduce(start(), { type: "sync", value: "Theirs" });
  assert.equal(resting.value, "Theirs");
  assert.equal(resting.draft, "Theirs");
});

test("a save in flight ignores everything except its own outcome", () => {
  let state = reduce(start(), { type: "edit" });
  state = reduce(state, { type: "change", draft: "Clarity Golf Academy" });
  state = reduce(state, { type: "save" });

  for (const event of [{ type: "edit" }, { type: "cancel" }, { type: "save" }] as const) {
    assert.equal(reduce(state, event).status, "saving", `${event.type} must not interrupt a save`);
  }
  assert.equal(reduce(state, { type: "change", draft: "no" }).draft, "Clarity Golf Academy");
});

test("dirty compares by value, not by reference", () => {
  const state = initialInlineEdit({ from: "09:00", to: "17:00" });
  const retyped = reduce(reduce(state, { type: "edit" }), {
    type: "change",
    draft: { from: "09:00", to: "17:00" },
  });
  // A fresh object holding the same thing is not a change. Without this, every
  // picker would report itself dirty the moment it was touched.
  assert.equal(isDirty(retyped), false);
});

test("the saved line is a clock time", () => {
  assert.equal(savedLabel(null), "");
  assert.match(savedLabel(Date.parse("2026-08-18T09:41:00")), /^Saved \d{1,2}:\d{2}/);
});
