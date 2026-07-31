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
