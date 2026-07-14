import assert from "node:assert/strict";
import test from "node:test";

import { normalizeServices, publicBookableServices } from "../booking-core.mts";

function lessonType(overrides = {}) {
  return {
    id: "lesson-a",
    accountId: "test-account",
    coachId: "coach-a",
    name: "Private lesson",
    duration: 60,
    price: 100,
    description: "",
    visibility: "public",
    active: true,
    capacity: 1,
    minParticipants: 1,
    lessonFormat: "private",
    priceMode: "session",
    bookingScreenIds: ["main"],
    ...overrides,
  };
}

test("a lesson name containing 'package' does not become a package", () => {
  const [service] = normalizeServices([
    lessonType({ id: "lesson-winter", name: "Winter Package", lessonFormat: "private" }),
  ]);

  assert.equal(service.lessonFormat, "private");
  assert.equal(service.visibility, "public");
  assert.equal(service.packageAllowance, undefined);
});

test("the chosen format is kept for group lesson types named like a package", () => {
  const [service] = normalizeServices([
    lessonType({ id: "group-package", name: "Package of group sessions", lessonFormat: "group", capacity: 6, minParticipants: 2 }),
  ]);

  assert.equal(service.lessonFormat, "group");
});

test("an explicitly empty lesson type list is not repopulated with the demo defaults", () => {
  assert.deepEqual(normalizeServices([]), []);
});

test("missing lesson type data still seeds the demo defaults", () => {
  assert.ok(normalizeServices(undefined).length > 0);
});

test("booking screens: an empty selection is preserved, a missing field defaults to main", () => {
  const [noScreens] = normalizeServices([lessonType({ bookingScreenIds: [] })]);
  assert.deepEqual(noScreens.bookingScreenIds, []);

  const [legacy] = normalizeServices([lessonType({ bookingScreenIds: undefined })]);
  assert.deepEqual(legacy.bookingScreenIds, ["main"]);
});

test("a public lesson type with no booking screens is not publicly bookable", () => {
  const services = normalizeServices([
    lessonType({ id: "on-screen", bookingScreenIds: ["main"] }),
    lessonType({ id: "off-screen", bookingScreenIds: [] }),
    lessonType({ id: "legacy", bookingScreenIds: undefined }),
  ]);

  const bookable = publicBookableServices(services).map((service) => service.id);
  assert.deepEqual(bookable.sort(), ["legacy", "on-screen"]);
});

test("private lesson capacity survives a save round trip", () => {
  const [service] = normalizeServices([lessonType({ capacity: 4 })]);
  assert.equal(service.capacity, 4);
});
