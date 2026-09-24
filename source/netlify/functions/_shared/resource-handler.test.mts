import assert from "node:assert/strict";
import test from "node:test";

import { cancellationFreesResource, EXTERNAL_RESOURCE_PROVIDER_IDS, resourceProviderById } from "./resource-handler.mts";

const options = { nowMs: Date.UTC(2026, 8, 25, 0, 0), defaultTimeZone: "Pacific/Auckland" };
// Week offsets are relative to the current week, so pick lessons far enough
// either side of "now" that the test does not depend on today's date.
const future = { id: "a", kind: "appointment", status: "booked", week: 400, day: 1, start: 600, duration: 60 };
const past = { ...future, week: -400 };

test("every provider can hold, move, release and sweep; an unknown id falls back to the webhook", () => {
  for (const id of EXTERNAL_RESOURCE_PROVIDER_IDS) {
    const provider = resourceProviderById(id);
    assert.equal(provider.id, id);
    for (const method of ["hold", "holdIfAutomatic", "queueHold", "move", "release", "sweepQueuedHolds"] as const) {
      assert.equal(typeof provider[method], "function", `${id}.${method}`);
    }
  }
  assert.equal(resourceProviderById("nope").id, "webhook");
});

test("cancelling a lesson that is still ahead frees its resource", () => {
  assert.equal(cancellationFreesResource(future, { ...future, status: "cancelled" }, options), true);
});

test("a no-show, a past lesson, or an already-cancelled one frees nothing", () => {
  assert.equal(cancellationFreesResource(future, { ...future, status: "no_show" }, options), false);
  assert.equal(cancellationFreesResource(past, { ...past, status: "cancelled" }, options), false);
  assert.equal(
    cancellationFreesResource({ ...future, status: "cancelled" }, { ...future, status: "cancelled" }, options),
    false,
  );
  assert.equal(cancellationFreesResource(null, { ...future, status: "cancelled" }, options), false);
  assert.equal(
    cancellationFreesResource({ ...future, kind: "block" }, { ...future, kind: "block", status: "cancelled" }, options),
    false,
  );
});
