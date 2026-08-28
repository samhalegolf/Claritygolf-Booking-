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
  // Only the reserved External Booking type comes back: inbound external
  // bookings always file under it, so it can never be missing. The demo
  // defaults stay gone.
  assert.deepEqual(normalizeServices([]).map((service) => service.id), ["external-booking"]);
});

test("the reserved External Booking type always exists and stays private", () => {
  const services = normalizeServices([lessonType({ id: "lesson-a" })]);
  const external = services.find((service) => service.id === "external-booking");
  assert.ok(external, "external-booking must be appended when missing");
  assert.equal(external?.visibility, "private");
  // A stored copy wins, so the coach can rename or recolour it.
  const [stored] = normalizeServices([lessonType({ id: "external-booking", name: "Optix bookings", visibility: "private" })]);
  assert.equal(stored.name, "Optix bookings");
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

// --- Booking screens survive a round trip -----------------------------------
//
// normalizeServices runs on load AND on save. It used to filter bookingScreenIds
// against a hardcoded list of known screens, so loading a service and saving it
// back -- with nobody touching its screens -- silently dropped any id this build
// did not recognise, and persisted the loss. The lesson type then stopped
// appearing on the public booking page with no error raised anywhere.
//
// This becomes actively dangerous once screens are per-business: a request
// serving one workspace would prune ids belonging to another.

test("an unrecognised booking screen id survives being loaded and saved", () => {
  const [service] = normalizeServices([
    lessonType({ bookingScreenIds: ["main", "a-screen-this-build-has-never-heard-of"] }),
  ], "test-account");

  assert.deepEqual(service.bookingScreenIds, ["main", "a-screen-this-build-has-never-heard-of"]);
});

test("repeated save cycles never erode the screen list", () => {
  // The failure mode was cumulative: each round trip pruned a little more.
  let services = [lessonType({ bookingScreenIds: ["main", "group-lessons", "another-workspaces-screen"] })];
  for (let pass = 0; pass < 3; pass += 1) services = normalizeServices(services, "test-account");

  const [service] = services;
  assert.deepEqual(service.bookingScreenIds, ["main", "group-lessons", "another-workspaces-screen"]);
});

test("the screen list is still cleaned, just not filtered by an allowlist", () => {
  const [service] = normalizeServices([
    lessonType({ bookingScreenIds: ["  main  ", "main", "", 42, null, "group-lessons"] as never }),
  ], "test-account");

  // Trimmed, de-duplicated and stripped of non-strings -- but nothing dropped
  // for being unfamiliar.
  assert.deepEqual(service.bookingScreenIds, ["main", "group-lessons"]);
});

test("a missing screen list still means the main screen, an empty one still means none", () => {
  const [legacy] = normalizeServices([lessonType({ bookingScreenIds: undefined })], "test-account");
  assert.deepEqual(legacy.bookingScreenIds, ["main"], "legacy rows default to the main screen");

  const [hidden] = normalizeServices([lessonType({ bookingScreenIds: [] })], "test-account");
  assert.deepEqual(hidden.bookingScreenIds, [], "an explicit empty list is a real choice and is kept");
});
