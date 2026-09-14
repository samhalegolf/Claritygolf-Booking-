import assert from "node:assert/strict";
import test from "node:test";

import { OptixSyncError } from "./optix-client.mts";
import { moveOptixBookingInPlace } from "./optix-auto-select.mts";
import {
  buildOptixAppointmentInput,
  optixAppointmentFingerprint,
  type ClarityOptixAppointment,
  type OptixSyncRecord,
} from "./optix-reconcile.mts";

const config = {
  memberId: "member-1",
  ownerUserId: "user-1",
  defaultResourceId: "600004",
  resourceMap: {},
  defaultTimeZone: "Pacific/Auckland",
};

function appointment(overrides: Partial<ClarityOptixAppointment> = {}): ClarityOptixAppointment {
  return {
    id: "appt-1",
    kind: "appointment",
    week: 8,
    day: 2,
    start: 14 * 60,
    duration: 60,
    title: "Golf lesson",
    client: "Sam",
    serviceId: "lesson-60",
    locationId: "three-kings",
    location: { timezone: "Pacific/Auckland", locationId: "three-kings" },
    status: "booked",
    ...overrides,
  };
}

function syncRecord(overrides: Partial<OptixSyncRecord> = {}): OptixSyncRecord {
  return {
    calendarItemId: "appt-1",
    optixBookingId: "booking-44",
    optixBookingSessionId: "session-9",
    resourceId: "600006",
    startTimestamp: 1,
    endTimestamp: 2,
    fingerprint: "stale",
    syncStatus: "synced",
    errorCode: "",
    errorMessage: "",
    ...overrides,
  };
}

const enabledType = { enabled: true, preferredResourceIds: ["600006", "600007"] };

function recordingSync(result = { bookingId: "booking-44", bookingSessionId: "session-9", raw: null }) {
  const calls: any[] = [];
  return {
    calls,
    sync: async (input: any) => {
      calls.push(input);
      return result;
    },
  };
}

test("amends the booking Optix already holds, keeping the same bay and ids", async () => {
  const { calls, sync } = recordingSync();
  const outcome = await moveOptixBookingInPlace({
    appointment: appointment(),
    existing: syncRecord(),
    config,
    bookingType: enabledType,
    sync: sync as any,
  });

  assert.equal(outcome.moved, true);
  assert.equal(outcome.moved === true && outcome.unchanged, false);
  assert.equal(calls.length, 1);
  // The amend has to carry the existing booking, or Optix creates a second one.
  assert.equal(calls[0].bookingId, "booking-44");
  assert.equal(calls[0].bookingSessionId, "session-9");
  // ...and the bay it already holds, not whatever the resource map would pick.
  assert.deepEqual(calls[0].resourceIds, ["600006"]);
  assert.equal(calls[0].isCanceled, false);
  assert.equal(outcome.moved === true && outcome.record.resourceId, "600006");
  // The stored timestamp is what paints the calendar's bay ring; it must be
  // the new slot, not the one the sync row was carrying.
  assert.equal(
    outcome.moved === true && outcome.record.startTimestamp,
    buildOptixAppointmentInput(appointment(), syncRecord(), config).startTimestamp,
  );
});

test("a busy bay is refused rather than thrown, so the caller can rebook elsewhere", async () => {
  const outcome = await moveOptixBookingInPlace({
    appointment: appointment(),
    existing: syncRecord(),
    config,
    bookingType: enabledType,
    sync: (async () => {
      throw new OptixSyncError("resource_conflict", "The resource is not available during the selected times.");
    }) as any,
  });

  assert.equal(outcome.moved, false);
  assert.equal(outcome.moved === false && outcome.code, "resource_conflict");
});

test("a lesson that did not move costs no Optix round trip", async () => {
  const existing = syncRecord();
  const fingerprint = optixAppointmentFingerprint({
    ...buildOptixAppointmentInput(appointment(), existing, config),
    resourceIds: [existing.resourceId],
  });
  const { calls, sync } = recordingSync();

  const outcome = await moveOptixBookingInPlace({
    appointment: appointment(),
    existing: { ...existing, fingerprint },
    config,
    bookingType: enabledType,
    sync: sync as any,
  });

  assert.equal(outcome.moved, true);
  assert.equal(outcome.moved === true && outcome.unchanged, true);
  assert.equal(calls.length, 0);
});

test("a lesson with no live bay booking has nothing to move", async () => {
  for (const existing of [
    null,
    syncRecord({ optixBookingId: "" }),
    syncRecord({ syncStatus: "failed" }),
    syncRecord({ syncStatus: "cancelled" }),
  ]) {
    const outcome = await moveOptixBookingInPlace({
      appointment: appointment(),
      existing,
      config,
      bookingType: enabledType,
      sync: (async () => assert.fail("Optix must not be called")) as any,
    });
    assert.equal(outcome.moved, false);
    assert.equal(outcome.moved === false && outcome.code, "no_synced_bay");
  }
});

test("a synced row that does not name its bay falls through to rebooking", async () => {
  const outcome = await moveOptixBookingInPlace({
    appointment: appointment(),
    existing: syncRecord({ resourceId: "" }),
    config,
    bookingType: enabledType,
    sync: (async () => assert.fail("Optix must not be called")) as any,
  });
  assert.equal(outcome.moved, false);
  assert.equal(outcome.moved === false && outcome.code, "no_resource_id");
});

test("a cancelled lesson releases its bay instead of moving it", async () => {
  for (const status of ["cancelled", "no_show"]) {
    const outcome = await moveOptixBookingInPlace({
      appointment: appointment({ status }),
      existing: syncRecord(),
      config,
      bookingType: enabledType,
      sync: (async () => assert.fail("Optix must not be called")) as any,
    });
    assert.equal(outcome.moved, false);
    assert.equal(outcome.moved === false && outcome.code, "appointment_cancelled");
  }
});

test("bays turned off for the lesson type are released, never moved", async () => {
  const outcome = await moveOptixBookingInPlace({
    appointment: appointment(),
    existing: syncRecord(),
    config,
    bookingType: { enabled: false },
    sync: (async () => assert.fail("Optix must not be called")) as any,
  });
  assert.equal(outcome.moved, false);
  assert.equal(outcome.moved === false && outcome.code, "optix_disabled");
});

test("an unusable Optix configuration is reported, not thrown", async () => {
  const outcome = await moveOptixBookingInPlace({
    appointment: appointment(),
    existing: syncRecord(),
    config: { ...config, memberId: "", ownerUserId: "" },
    bookingType: enabledType,
    sync: (async () => assert.fail("Optix must not be called")) as any,
  });
  assert.equal(outcome.moved, false);
  assert.equal(outcome.moved === false && outcome.code, "not_configured");
});
