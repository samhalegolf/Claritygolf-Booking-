import assert from "node:assert/strict";
import test from "node:test";

import {
  clarityResourcesApply,
  cleanLocationResources,
  cleanServiceResourceIds,
  cleanServiceResourceTypes,
  eligibleResources,
  pickFreeResource,
  serviceResourceMode,
  type ResourceLocation,
} from "./resources.mts";

const range: ResourceLocation = {
  id: "range",
  kind: "physical",
  resourceSource: "clarity",
  resources: cleanLocationResources([
    { id: "bay-1", name: "Bay 1", handedness: "left" },
    { id: "bay-2", name: "Bay 2" },
    { id: "bay-3", name: "Bay 3", handedness: "right" },
  ]),
};
const lesson = { id: "lesson", needsResource: true };
const slot = { week: 3, day: 1, start: 600, duration: 60 };

test("resources only apply to a physical, Clarity-held location and a lesson that needs one", () => {
  assert.equal(clarityResourcesApply(range, lesson), true);
  assert.equal(clarityResourcesApply(range, { id: "x" }), false);
  assert.equal(clarityResourcesApply({ ...range, kind: "online" }, lesson), false);
  assert.equal(clarityResourcesApply({ ...range, resourceSource: "external" }, lesson), false);
  assert.equal(clarityResourcesApply({ ...range, resources: [] }, lesson), false);
});

test("lefties-only resources go last for everyone but a left-hander", () => {
  assert.deepEqual(eligibleResources(range, lesson).map((r) => r.id), ["bay-3", "bay-2", "bay-1"]);
  assert.deepEqual(eligibleResources(range, lesson, "left").map((r) => r.id), ["bay-1", "bay-2"]);
  assert.deepEqual(eligibleResources(range, lesson, "right").map((r) => r.id), ["bay-3", "bay-2"]);
});

test("a lesson type can narrow itself to some resources", () => {
  assert.deepEqual(eligibleResources(range, { ...lesson, resourceIds: ["bay-2"] }).map((r) => r.id), ["bay-2"]);
});

test("a held resource is skipped and a full location returns null", () => {
  const holders = [
    { id: "a", ...slot, resourceId: "bay-3" },
    { id: "b", ...slot, start: 630, resourceId: "bay-2" },
  ];
  assert.equal(pickFreeResource({ location: range, service: lesson, slot, holders })?.id, "bay-1");
  assert.equal(pickFreeResource({ location: range, service: lesson, slot, holders, handedness: "right" }), null);
  assert.equal(
    pickFreeResource({ location: range, service: lesson, slot, holders: [...holders, { id: "c", ...slot, resourceId: "bay-1" }] }),
    null,
  );
});

test("a holder with no resource recorded still uses one up", () => {
  const holders = [
    { id: "a", ...slot, resourceId: "bay-3" },
    { id: "b", ...slot, resourceId: "bay-2" },
    { id: "legacy", ...slot },
  ];
  assert.equal(pickFreeResource({ location: range, service: lesson, slot, holders }), null);
});

test("a lesson being moved keeps its own resource and does not collide with itself", () => {
  const holders = [{ id: "self", ...slot, resourceId: "bay-2" }];
  const picked = pickFreeResource({
    location: range,
    service: lesson,
    slot: { ...slot, start: 615 },
    holders,
    ignoreId: "self",
    preferResourceId: "bay-2",
  });
  assert.equal(picked?.id, "bay-2");
});

test("different days and non-overlapping times never collide", () => {
  const holders = ["bay-1", "bay-2", "bay-3"].map((resourceId, i) => ({ id: `h${i}`, ...slot, day: 2, resourceId }));
  assert.ok(pickFreeResource({ location: range, service: lesson, slot, holders }));
  const later = ["bay-1", "bay-2", "bay-3"].map((resourceId, i) => ({ id: `l${i}`, ...slot, start: 660, resourceId }));
  assert.ok(pickFreeResource({ location: range, service: lesson, slot, holders: later }));
});

test("a lesson type uses resources when usable or required, and reads the old flag as required", () => {
  assert.equal(serviceResourceMode({ needsResource: true }), "required");
  assert.equal(serviceResourceMode({ resourceMode: "usable" }), "usable");
  assert.equal(serviceResourceMode({ resourceMode: "none", needsResource: true }), "none");
  assert.equal(clarityResourcesApply(range, { resourceMode: "usable" }), true);
  assert.equal(clarityResourcesApply(range, { resourceMode: "none" }), false);
});

test("a whole type covers every resource of that type; single resources cover only themselves", () => {
  const club: ResourceLocation = {
    id: "club",
    kind: "physical",
    resourceSource: "clarity",
    resources: cleanLocationResources([
      { id: "bay-1", name: "Bay 1", type: "Hitting bay" },
      { id: "bay-2", name: "Bay 2", type: "hitting  BAY" },
      { id: "studio", name: "Studio", type: "Putting room" },
    ]),
  };
  const byType = { resourceMode: "required" as const, resourceTypes: ["Hitting Bay"] };
  assert.deepEqual(eligibleResources(club, byType).map((r) => r.id), ["bay-1", "bay-2"]);
  const single = { resourceMode: "required" as const, resourceIds: ["club/studio", "range/bay-1"] };
  assert.deepEqual(eligibleResources(club, single).map((r) => r.id), ["studio"]);
  assert.deepEqual(eligibleResources(range, single).map((r) => r.id), ["bay-1"]);
});

test("resource selections are qualified by location, and old unqualified ones by the old location", () => {
  assert.deepEqual(cleanServiceResourceIds(["Bay-1", "club/Studio", "bad/"], "range"), ["range/bay-1", "club/studio"]);
  assert.deepEqual(cleanServiceResourceIds(["bay-1"]), ["bay-1"]);
  assert.deepEqual(cleanServiceResourceTypes([" Hitting  bay ", "hitting bay", ""]), ["Hitting bay"]);
});
