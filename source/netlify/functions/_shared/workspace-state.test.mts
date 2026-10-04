import assert from "node:assert/strict";
import test from "node:test";

import { filterCalendarStateForContext } from "./bookings.mts";
import { EXTERNAL_BOOKING_SERVICE_ID } from "./services.mts";
import { adminStateFromSettings, coachUserForMembership } from "./workspace-state.mts";

const OTHER_BUSINESS = "workspace-state-test-business";

test("a business that deleted every lesson type is not shown the original workspace's", () => {
  const state = adminStateFromSettings({ servicesJson: "[]" }, OTHER_BUSINESS);
  assert.deepEqual(
    state.services.map((service) => service.id),
    [EXTERNAL_BOOKING_SERVICE_ID],
    "only the reserved External Booking type, which inbound bookings need on first load",
  );
});

test("availability saved before accountId was stamped still reaches the calendar", () => {
  const settings = {
    availabilityJson: JSON.stringify([[{ start: 540, end: 720, coachId: "coach-a" }], [], [], [], [], [], []]),
    coachProfilesJson: JSON.stringify([{ id: "coach-a", name: "Coach A" }]),
  };
  const state = adminStateFromSettings(settings, OTHER_BUSINESS);
  assert.equal(state.availability[0][0].accountId, OTHER_BUSINESS);

  const visible = filterCalendarStateForContext(
    { ...state, items: [], people: [], notifications: [] },
    { accountId: OTHER_BUSINESS, isAdmin: false, coachId: "coach-a" },
  );
  assert.equal(visible.availability[0].length, 1);
});

test("the signed-in coach gets their own coach and only their own permissions", () => {
  const coaches = [
    { id: "coach-a", active: true, archived: false },
    { id: "coach-b", active: true, archived: false },
  ];
  const membership = {
    authUserId: "auth-b",
    accountId: OTHER_BUSINESS,
    role: "coach",
    coachId: "coach-b",
    isAdmin: false,
    isOwner: false,
  };
  const user = coachUserForMembership(membership as never, coaches, "Coach B");
  assert.equal(user.coachId, "coach-b");
  assert.equal(user.permissions.bookings, "own");
  assert.equal(user.permissions.settings, "none");
});
