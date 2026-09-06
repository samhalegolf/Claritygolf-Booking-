import assert from "node:assert/strict";
import test from "node:test";

import { appearsOnCurrentPublicBookingScreen, currentPublicBookingScreenId } from "./bookingScreen";

test("public booking screen resolution mirrors App's main-screen aliases", () => {
  assert.equal(currentPublicBookingScreenId("/"), "main");
  assert.equal(currentPublicBookingScreenId("/sam-hale-golf"), "main");
  assert.equal(currentPublicBookingScreenId("//sam-hale-golf//"), "main");
  assert.equal(currentPublicBookingScreenId("/group-lessons"), "group-lessons");
  assert.equal(currentPublicBookingScreenId("/unknown-screen"), "main");
});

test("public booking service fallback keeps legacy main services and excludes explicit empties", () => {
  assert.equal(appearsOnCurrentPublicBookingScreen({}, "/sam-hale-golf"), true);
  assert.equal(appearsOnCurrentPublicBookingScreen({ bookingScreenIds: [] }, "/sam-hale-golf"), false);
  assert.equal(appearsOnCurrentPublicBookingScreen({ bookingScreenIds: ["main"] }, "/sam-hale-golf"), true);
});
