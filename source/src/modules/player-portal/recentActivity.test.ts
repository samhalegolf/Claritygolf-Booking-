/**
 * The one line the home screen leads with.
 *
 * It is derived, not stored, so the failure worth testing is not "does it
 * render" but "does it point at the right thing". A home screen that says
 * "nothing new" while the coach is waiting on a reply is worse than one with
 * no line at all -- the player stops looking.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { recentActivity } from "./recentActivity";

const empty = {
  unseenReturns: 0,
  newestReturnAt: "",
  practice: [] as Array<{ title: string; assignedAt: string; status: string }>,
  notes: [] as Array<{ title?: string; createdAt?: string; updatedAt?: string }>,
  passes: [] as Array<{ name: string; issuedAt: string; creditsAvailable: number }>,
};

test("an unopened coach return beats everything, whatever the dates say", () => {
  // It is the only one of the four waiting on the player rather than simply
  // having happened, so recency is the wrong question for it.
  const item = recentActivity({
    ...empty,
    unseenReturns: 1,
    newestReturnAt: "2026-01-01T00:00:00.000Z",
    practice: [{ title: "Tempo drill", assignedAt: "2026-09-14T00:00:00.000Z", status: "active" }],
  });
  assert.equal(item?.tab, "videos");
  assert.equal(item?.unseen, true);
  assert.equal(item?.label, "Your coach sent a video back");
});

test("more than one return is counted, not listed", () => {
  const item = recentActivity({ ...empty, unseenReturns: 3 });
  assert.equal(item?.label, "Your coach sent 3 videos back");
});

test("with nothing waiting, the most recent thing wins", () => {
  const item = recentActivity({
    ...empty,
    practice: [{ title: "Tempo drill", assignedAt: "2026-09-01T00:00:00.000Z", status: "active" }],
    notes: [{ title: "Grip", createdAt: "2026-09-14T00:00:00.000Z" }],
  });
  assert.equal(item?.tab, "notes");
  assert.equal(item?.label, "Note: Grip");
});

test("a completed practice block is not news", () => {
  const item = recentActivity({
    ...empty,
    practice: [{ title: "Old drill", assignedAt: "2026-09-14T00:00:00.000Z", status: "completed" }],
    notes: [{ title: "Grip", createdAt: "2026-01-01T00:00:00.000Z" }],
  });
  assert.equal(item?.tab, "notes", "the finished block must not outrank a real note");
});

test("a spent pass is not news either", () => {
  const item = recentActivity({
    ...empty,
    passes: [{ name: "5 Lessons", issuedAt: "2026-09-14T00:00:00.000Z", creditsAvailable: 0 }],
  });
  assert.equal(item, null);
});

test("a pass with credits points at the passes tab", () => {
  const item = recentActivity({
    ...empty,
    passes: [{ name: "5 Lessons", issuedAt: "2026-09-14T00:00:00.000Z", creditsAvailable: 3 }],
  });
  assert.equal(item?.tab, "passes");
  assert.equal(item?.label, "5 Lessons — 3 left");
});

test("a note's edit date counts, not only when it was written", () => {
  const item = recentActivity({
    ...empty,
    notes: [
      { title: "Older", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z" },
      { title: "Newer", createdAt: "2026-09-10T00:00:00.000Z" },
    ],
  });
  assert.equal(item?.label, "Note: Older");
});

test("something with no date does not get to claim it happened last", () => {
  const item = recentActivity({
    ...empty,
    practice: [{ title: "Undated", assignedAt: "", status: "active" }],
    notes: [{ title: "Dated", createdAt: "2026-01-01T00:00:00.000Z" }],
  });
  assert.equal(item?.label, "Note: Dated");
});

test("nothing at all is null, not an empty-looking item", () => {
  assert.equal(recentActivity(empty), null);
});
