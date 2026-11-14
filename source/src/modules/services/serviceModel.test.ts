import assert from "node:assert/strict";
import test from "node:test";

import { canPricePerPerson, cleanService, hasLiveGroupSchedule, serviceNumberFieldsShown, servicePriceLabel } from "./serviceModel";

test("the per person toggle is offered on private and scheduled group lessons only", () => {
  assert.equal(canPricePerPerson({ lessonFormat: "private" }), true);
  assert.equal(canPricePerPerson({ lessonFormat: "group" }), true);
  assert.equal(canPricePerPerson({ lessonFormat: "group", customGroup: true }), false);
  assert.equal(canPricePerPerson({ lessonFormat: "video-review" }), false);
  assert.equal(canPricePerPerson({ lessonFormat: "package" }), false);
});

test("cleaning keeps per person on a private lesson and drops it on a review", () => {
  assert.equal(cleanService({ name: "Pair", lessonFormat: "private", capacity: 2, priceMode: "per-person" }).priceMode, "per-person");
  assert.equal(cleanService({ name: "Review", lessonFormat: "video-review", priceMode: "per-person" }).priceMode, "session");
});

test("a custom group's price follows its base price", () => {
  const clean = cleanService({ name: "Custom", lessonFormat: "group", customGroup: true, price: 100, basePrice: 240 });
  assert.equal(clean.price, 240);
});

test("a per person price reads as the price with per person after it", () => {
  const label = servicePriceLabel({ price: 40, priceMode: "per-person" });
  assert.match(label, /40/);
  assert.match(label, /per person$/);
  assert.doesNotMatch(servicePriceLabel({ price: 40, priceMode: "session" }), /per person/);
});

test("saving asks only for the number boxes the format shows", () => {
  assert.deepEqual(serviceNumberFieldsShown({ lessonFormat: "private" }), ["duration", "price"]);
  assert.deepEqual(serviceNumberFieldsShown({ lessonFormat: "group", customGroup: true }), ["duration", "basePrice", "baseParticipants", "extraPersonPrice"]);
  assert.ok(serviceNumberFieldsShown({ lessonFormat: "video-review" }).includes("reviewTurnaroundDays"));
});

test("an archived or switched-off group lesson stops putting sessions on the calendar", () => {
  const schedule = { active: true, dayOfWeek: 0, startMinutes: 1140, occurrenceCount: 8 };
  const live = { lessonFormat: "group" as const, active: true, groupSchedule: schedule };
  assert.equal(hasLiveGroupSchedule(live), true);
  assert.equal(hasLiveGroupSchedule({ ...live, archived: true }), false);
  assert.equal(hasLiveGroupSchedule({ ...live, active: false }), false);
  assert.equal(hasLiveGroupSchedule({ ...live, groupSchedule: { ...schedule, active: false } }), false);
  assert.equal(hasLiveGroupSchedule({ ...live, customGroup: true }), false);
  assert.equal(hasLiveGroupSchedule(undefined), false);
});
