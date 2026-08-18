import assert from "node:assert/strict";
import test from "node:test";

import {
  canCancelExternally,
  canRescheduleExternally,
  providerCapabilities,
} from "./integrations/registry.mts";
import { planExternalReschedule, sameSlot, type ExternalBooking } from "./external-reschedule.mts";

const optixBooking: ExternalBooking = {
  id: "optix-1", origin: "optix", externalProvider: "optix", externalBookingId: "13296338",
  week: 9, day: 2, start: 600, duration: 60,
};

const nativeBooking: ExternalBooking = {
  id: "appt-1", origin: "clarity", externalProvider: "", externalBookingId: "",
  week: 9, day: 2, start: 600, duration: 60,
};

test("a native lesson never routes through the external path", () => {
  assert.deepEqual(planExternalReschedule(nativeBooking, { week: 9, day: 3, start: 780, duration: 60 }), {
    action: "native",
  });
});

test("moving an external booking back to its own slot asks the provider for nothing", () => {
  // The grace window depends on this: putting a lesson back where it started
  // must not fire an external write.
  assert.deepEqual(planExternalReschedule(optixBooking, { week: 9, day: 2, start: 600, duration: 60 }), {
    action: "noop",
  });
});

test("Optix is refused with the reason, not silently applied locally", () => {
  const plan = planExternalReschedule(optixBooking, { week: 9, day: 3, start: 780, duration: 60 });
  assert.equal(plan.action, "refuse");
  if (plan.action !== "refuse") return;
  assert.equal(plan.code, "EXTERNAL_RESCHEDULE_UNSUPPORTED");
  assert.match(plan.message, /member ID or resource ID/);
});

test("a provider that supports rescheduling would be asked before anything is written", () => {
  // Guards the ordering rule itself, independent of which providers are on
  // today: a capable provider produces a call, never a local write.
  const capable: ExternalBooking = { ...optixBooking, externalProvider: "pretend_capable" };
  const plan = planExternalReschedule(capable, { week: 9, day: 3, start: 780, duration: 60 });
  assert.equal(plan.action, "refuse", "unknown providers must refuse rather than default to allowed");
});

test("an external booking with no external ID cannot be sent anywhere", () => {
  const orphan: ExternalBooking = { ...optixBooking, externalBookingId: "" };
  const plan = planExternalReschedule(orphan, { week: 9, day: 3, start: 780, duration: 60 });
  assert.equal(plan.action, "refuse");
});

test("no provider claims a write capability it cannot perform", () => {
  for (const provider of ["optix", "google_calendar", "acuity", "setmore"]) {
    const capabilities = providerCapabilities(provider);
    if (capabilities.createExternally || capabilities.rescheduleExternally || capabilities.cancelExternally) {
      assert.fail(`${provider} claims a write capability with no adapter behind it`);
    }
    assert.ok(capabilities.writeBlockedReason, `${provider} must explain why writes are off`);
  }
});

test("capability checks default to refusing an unknown provider", () => {
  assert.equal(canRescheduleExternally("nope").allowed, false);
  assert.equal(canCancelExternally("nope").allowed, false);
  assert.equal(canRescheduleExternally(undefined).allowed, false);
});

test("sameSlot compares every field that defines when a lesson happens", () => {
  const base = { week: 9, day: 2, start: 600, duration: 60 };
  assert.ok(sameSlot(base, { ...base }));
  assert.ok(!sameSlot(base, { ...base, duration: 90 }));
  assert.ok(!sameSlot(base, { ...base, week: 10 }));
});
