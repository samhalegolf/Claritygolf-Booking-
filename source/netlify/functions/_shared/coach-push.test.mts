import assert from "node:assert/strict";
import test from "node:test";

import { composeCoachPushMessage } from "../notification-engine.mts";

const appointment = {
  id: "appt-123",
  accountId: "sam-hale-golf",
  client: "Jane Smith",
  serviceId: "private-lesson",
  week: 0,
  day: 1,
  start: 600,
  duration: 60,
};

test("a new client booking reads as a booking", () => {
  const message = composeCoachPushMessage({ action: "booking", appointment, serviceName: "Private Lesson" });
  assert.ok(message);
  assert.equal(message.title, "New booking · Jane Smith");
  assert.match(message.body, /^Private Lesson\n/);
  assert.match(message.body, /10:00 AM-11:00 AM/);
  assert.equal(message.tag, "clarity-booking-appt-123");
  assert.equal(message.url, "/");
});

test("an inbound Optix booking says so, so the coach knows where it came from", () => {
  const message = composeCoachPushMessage({
    action: "booking",
    appointment,
    serviceName: "External Booking",
    source: "optix:booking-created-42",
  });
  assert.equal(message?.title, "New Optix booking · Jane Smith");
});

test("a cancellation names the client and keeps the lesson's tag", () => {
  const message = composeCoachPushMessage({ action: "cancelled", appointment, serviceName: "Private Lesson" });
  assert.equal(message?.title, "Booking cancelled · Jane Smith");
  // Same tag as the booking pop-up: the cancellation replaces it in the tray
  // rather than leaving two contradictory notifications sitting together.
  assert.equal(message?.tag, "clarity-booking-appt-123");
});

test("a reschedule shows both the new time and the old one", () => {
  const message = composeCoachPushMessage({
    action: "rescheduled",
    appointment,
    previousAppointment: { ...appointment, day: 2, start: 840 },
    serviceName: "Private Lesson",
  });
  assert.equal(message?.title, "Booking moved · Jane Smith");
  assert.match(message!.body, /Now .*10:00 AM-11:00 AM/);
  assert.match(message!.body, /Was .*2:00 PM-3:00 PM/);
});

test("a reschedule with no previous booking still says when the lesson is", () => {
  const message = composeCoachPushMessage({ action: "rescheduled", appointment, serviceName: "Private Lesson" });
  assert.ok(message);
  assert.doesNotMatch(message.body, /Was /);
  assert.match(message.body, /10:00 AM-11:00 AM/);
});

test("actions the coach caused, or does not need a pop-up for, produce nothing", () => {
  for (const action of ["updated", "reminder", "test"] as const) {
    assert.equal(composeCoachPushMessage({ action, appointment, serviceName: "Private Lesson" }), null);
  }
});

test("a booking with no matching lesson type still has a readable body", () => {
  const message = composeCoachPushMessage({ action: "booking", appointment, serviceName: "" });
  assert.match(message!.body, /^Golf Lesson\n/);
});
