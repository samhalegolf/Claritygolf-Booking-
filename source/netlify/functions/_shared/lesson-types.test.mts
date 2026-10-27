import assert from "node:assert/strict";
import test from "node:test";

import { publicBookableServices } from "../booking-core.mts";
import {
  countManagedActiveServices,
  isReservedExternalBookingService,
  managedServicesForStorage,
  normalizeServices,
} from "./services.mts";

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

test("the reserved External Booking type always exists in memory and stays private", () => {
  const services = normalizeServices([lessonType({ id: "lesson-a" })]);
  const external = services.find((service) => service.id === "external-booking");
  assert.ok(external, "external-booking must be appended when missing");
  assert.equal(external?.visibility, "private");
  // A legacy stored copy still normalizes safely.
  const [stored] = normalizeServices([lessonType({ id: "external-booking", name: "Optix bookings", visibility: "private" })]);
  assert.equal(stored.name, "Optix bookings");
});

test("the reserved External Booking type is internal and does not consume a lesson-type plan slot", () => {
  const services = normalizeServices([
    lessonType({ id: "lesson-a" }),
    lessonType({ id: "lesson-archived", archived: true }),
  ]);

  assert.equal(isReservedExternalBookingService(services.find((service) => service.id === "external-booking")), true);
  assert.equal(isReservedExternalBookingService(services.find((service) => service.id === "lesson-a")), false);
  assert.equal(countManagedActiveServices(services), 1);
});

test("the virtual External Booking bucket is never saved as a business lesson type", () => {
  const normalized = normalizeServices([lessonType({ id: "lesson-a" })]);

  assert.deepEqual(managedServicesForStorage(normalized).map((service) => service.id), ["lesson-a"]);
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

test("per person pricing is kept for private and scheduled group lessons", () => {
  const [privateLesson, groupLesson] = normalizeServices([
    lessonType({ id: "pair", capacity: 2, priceMode: "per-person" }),
    lessonType({ id: "clinic", lessonFormat: "group", capacity: 6, minParticipants: 2, priceMode: "per-person" }),
  ], "test-account");

  // The editor offers the toggle on both, so dropping it here would be the
  // toggle doing nothing on a private lesson again.
  assert.equal(privateLesson.priceMode, "per-person");
  assert.equal(groupLesson.priceMode, "per-person");
});

test("per person pricing is dropped where the editor does not offer it", () => {
  const [review, pass, customGroup] = normalizeServices([
    lessonType({ id: "review", lessonFormat: "video-review", priceMode: "per-person" }),
    lessonType({ id: "pass", lessonFormat: "package", priceMode: "per-person" }),
    lessonType({ id: "custom", lessonFormat: "group", customGroup: true, priceMode: "per-person" }),
  ], "test-account");

  assert.equal(review.priceMode, "session");
  assert.equal(pass.priceMode, "session");
  assert.equal(customGroup.priceMode, "session", "a custom group prices by head through its own fields");
});

test("a custom group's price follows its base price", () => {
  const [service] = normalizeServices([
    lessonType({ lessonFormat: "group", customGroup: true, price: 100, basePrice: 240, extraPersonPrice: 30 }),
  ], "test-account");

  assert.equal(service.basePrice, 240);
  assert.equal(service.price, 240, "one price box, so no second price drifting beside it");
});
