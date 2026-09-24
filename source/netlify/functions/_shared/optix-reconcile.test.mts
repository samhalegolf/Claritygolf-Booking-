import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOptixAppointmentInput,
  optixAppointmentFingerprint,
  readOptixReconcileConfig,
  resolveOptixResourceId,
  wallClockToUnixSeconds,
} from "./optix-reconcile.mts";

const appointment = {
  id: "appt-1",
  kind: "appointment",
  week: 8,
  day: 2,
  start: 14 * 60,
  duration: 60,
  title: "Golf lesson",
  serviceId: "lesson-60",
  locationId: "three-kings",
  location: { timezone: "Pacific/Auckland", locationId: "three-kings" },
  status: "booked",
};

function config(overrides = {}) {
  return {
    memberId: "member-1",
    ownerUserId: "user-1",
    defaultResourceId: "resource-default",
    resourceMap: {},
    defaultTimeZone: "Pacific/Auckland",
    ...overrides,
  };
}

test("resolves location mapping before service and default mappings", () => {
  const resolved = resolveOptixResourceId(
    appointment,
    config({
      resourceMap: {
        "location:three-kings": "resource-location",
        "service:lesson-60": "resource-service",
      },
    }),
  );
  assert.equal(resolved, "resource-location");
});

test("converts Auckland wall clock to the correct unix timestamp", () => {
  const timestamp = wallClockToUnixSeconds({
    year: 2026,
    month: 7,
    day: 29,
    minutes: 14 * 60,
    timeZone: "Pacific/Auckland",
  });
  assert.equal(new Date(timestamp * 1000).toISOString(), "2026-07-29T02:00:00.000Z");
});

test("builds an Optix create input owned by the configured member", () => {
  const input = buildOptixAppointmentInput(appointment, null, config());
  assert.equal(input.memberId, "member-1");
  assert.equal(input.ownerUserId, "user-1");
  assert.deepEqual(input.resourceIds, ["resource-default"]);
  assert.equal(input.externalId, "clarity:appt-1");
  assert.equal(input.isCanceled, false);
  assert.equal(input.endTimestamp - input.startTimestamp, 3600);
});

test("preserves the existing Optix IDs for reschedule and cancellation", () => {
  const input = buildOptixAppointmentInput(
    { ...appointment, status: "cancelled" },
    {
      calendarItemId: "appt-1",
      optixBookingId: "booking-44",
      optixBookingSessionId: "session-9",
      resourceId: "resource-default",
      startTimestamp: 1,
      endTimestamp: 2,
      fingerprint: "old",
      syncStatus: "synced",
      errorCode: "",
      errorMessage: "",
    },
    config(),
  );
  assert.equal(input.bookingId, "booking-44");
  assert.equal(input.bookingSessionId, "session-9");
  assert.equal(input.isCanceled, true);
});

test("a sync row with cleared IDs produces a create, not an amend", () => {
  // rebookResourceAfterReschedule blanks optix_booking_id after cancelling the
  // old bay booking so the rebook creates a fresh booking. If empty IDs ever
  // pass through as booking IDs again, the rebook would try to resurrect the
  // cancelled booking instead.
  const input = buildOptixAppointmentInput(
    appointment,
    {
      calendarItemId: "appt-1",
      optixBookingId: "",
      optixBookingSessionId: "",
      resourceId: "resource-default",
      startTimestamp: 1,
      endTimestamp: 2,
      fingerprint: "old",
      syncStatus: "cancelled",
      errorCode: "",
      errorMessage: "",
    },
    config(),
  );
  assert.equal(input.bookingId, null);
  assert.equal(input.bookingSessionId, null);
  assert.equal(input.isCanceled, false);
});

test("fingerprint changes when the appointment moves", () => {
  const first = buildOptixAppointmentInput(appointment, null, config());
  const moved = buildOptixAppointmentInput(
    { ...appointment, start: appointment.start + 30 },
    null,
    config(),
  );
  assert.notEqual(
    optixAppointmentFingerprint(first),
    optixAppointmentFingerprint(moved),
  );
});

test("reads resource map JSON from environment", () => {
  const values = {
    OPTIX_MEMBER_ID: "member-1",
    OPTIX_OWNER_USER_ID: "user-1",
    OPTIX_RESOURCE_ID: "resource-default",
    OPTIX_RESOURCE_MAP_JSON: JSON.stringify({
      "location:three-kings": "resource-33",
    }),
    CLARITY_TIMEZONE: "Pacific/Auckland",
  };
  const parsed = readOptixReconcileConfig(
    (name) => values[name as keyof typeof values] || "",
  );
  assert.equal(parsed.resourceMap["location:three-kings"], "resource-33");
});

// ---------------------------------------------------------------------------
// bayFollowsReschedule: which slot changes are allowed to reach Optix.
//
// The incident: a completed lesson from the previous week was nudged one row
// on the calendar and back, and Optix received two booking amendments for a
// bay that had been used and released days earlier.
// ---------------------------------------------------------------------------

import { bayFollowsReschedule } from "./optix-reconcile.mts";

// Week 8 day 2 = Wednesday 29 July 2026 (base is Monday 1 June 2026). 14:00
// Auckland in July is NZST, UTC+12, so the lesson ends at 03:00Z.
const LESSON_END_MS = Date.parse("2026-07-29T03:00:00Z");
const followOptions = (nowMs: number) => ({ nowMs, defaultTimeZone: "Pacific/Auckland" });

test("a booked lesson that has not happened yet takes its bay with it", () => {
  assert.equal(bayFollowsReschedule(appointment, followOptions(LESSON_END_MS - 24 * 3600_000)), true);
});

test("a completed lesson never moves its bay, even to a future slot", () => {
  assert.equal(
    bayFollowsReschedule({ ...appointment, status: "completed" }, followOptions(LESSON_END_MS - 24 * 3600_000)),
    false,
  );
});

test("cancelled and no-show lessons do not move a bay", () => {
  for (const status of ["cancelled", "no_show"]) {
    assert.equal(bayFollowsReschedule({ ...appointment, status }, followOptions(LESSON_END_MS - 3600_000)), false, status);
  }
});

test("a booked lesson whose new slot has already ended does not reach Optix", () => {
  assert.equal(bayFollowsReschedule(appointment, followOptions(LESSON_END_MS + 60_000)), false);
});

test("a lesson still in progress keeps following its bay", () => {
  assert.equal(bayFollowsReschedule(appointment, followOptions(LESSON_END_MS - 60_000)), true);
});

test("a lesson with no location timezone is judged in the deployment default", () => {
  const noLocation = { ...appointment, location: null };
  assert.equal(bayFollowsReschedule(noLocation, followOptions(LESSON_END_MS - 60_000)), true);
  assert.equal(bayFollowsReschedule(noLocation, followOptions(LESSON_END_MS + 60_000)), false);
});

test("blocks are not lessons and never move a bay", () => {
  assert.equal(bayFollowsReschedule({ ...appointment, kind: "block" }, followOptions(0)), false);
});
