import assert from "node:assert/strict";
import test from "node:test";

import { internalNotificationDeliveryPlan, sameNotificationRecipient } from "../notification-engine.mts";
import {
  notificationRetryDelayMs,
  planBookingNotificationIntent,
  runNotificationOutboxWorker,
  type NotificationOutboxJob,
} from "./notification-outbox.mts";

const start = Date.parse("2026-09-27T10:00:00.000Z");

function appointment(id = "booking-a", overrides: any = {}) {
  return {
    id,
    accountId: "account-a",
    kind: "appointment",
    status: "booked",
    client: "Kasi",
    email: "kasi@example.test",
    serviceId: "lesson-30",
    week: 20,
    day: 1,
    start: 600,
    duration: 30,
    ...overrides,
  };
}

const positionSignature = (value: any) => [value.week, value.day, value.start, value.duration].join(":");

function newJob(id: string, appt: any, overrides: Partial<NotificationOutboxJob> = {}): NotificationOutboxJob {
  return {
    id,
    accountId: "account-a",
    calendarItemId: appt.id,
    action: "booking",
    status: "queued",
    source: "calendar-state",
    appointment: appt,
    previousAppointment: null,
    originalPositionSignature: "",
    targetSignature: JSON.stringify(appt),
    queuedAt: new Date(start).toISOString(),
    dueAt: new Date(start + 30_000).toISOString(),
    attemptCount: 0,
    ...overrides,
  };
}

class MemoryOutbox {
  now = start;
  jobs: NotificationOutboxJob[] = [];
  attempts: Array<{ id: string; at: string }> = [];
  sent: Array<{ id: string; at: string }> = [];
  failures: Array<{ id: string; at: string; error: string }> = [];

  claim = async () => {
    const due = this.jobs.filter((job) =>
      ["queued", "retry"].includes(job.status) &&
      Date.parse(job.nextAttemptAt || job.dueAt) <= this.now,
    );
    for (const job of due) {
      job.status = "processing";
      job.claimToken = `claim-${job.id}-${job.attemptCount + 1}`;
      job.attemptCount += 1;
      job.firstAttemptedAt ||= new Date(this.now).toISOString();
      job.attemptedAt = new Date(this.now).toISOString();
      this.attempts.push({ id: job.id, at: job.attemptedAt });
    }
    return due;
  };

  markSent = async (job: NotificationOutboxJob) => {
    job.status = "sent";
    job.sentAt = new Date(this.now).toISOString();
    this.sent.push({ id: job.id, at: job.sentAt });
  };

  markRetry = async (job: NotificationOutboxJob, error: string) => {
    job.status = "retry";
    job.lastError = error;
    job.nextAttemptAt = new Date(this.now + notificationRetryDelayMs(job.attemptCount)).toISOString();
    this.failures.push({ id: job.id, at: new Date(this.now).toISOString(), error });
  };

  worker(deliver: (job: NotificationOutboxJob) => Promise<any[]>) {
    return runNotificationOutboxWorker({
      claim: this.claim,
      deliver,
      markSent: this.markSent,
      markRetry: this.markRetry,
    });
  }
}

test("new booking becomes deliverable after debounce without another calendar action", async () => {
  const store = new MemoryOutbox();
  store.jobs.push(newJob("job-a", appointment()));
  store.now += 30_001;
  const result = await store.worker(async () => [{ status: "sent", channel: "client" }]);
  assert.equal(result.claimed, 1);
  assert.equal(store.jobs[0].status, "sent");
});

test("server worker sends even when no browser flush occurs", async () => {
  const store = new MemoryOutbox();
  store.jobs.push(newJob("job-a", appointment()));
  store.now += 120_000;
  await store.worker(async () => [{ status: "sent" }]);
  assert.equal(store.sent.length, 1);
});

test("an unrelated booking edit neither triggers nor changes another booking", async () => {
  const original = newJob("job-a", appointment("booking-a"));
  const unrelated = appointment("booking-b", { start: 700 });
  const plan = planBookingNotificationIntent({
    action: "updated",
    previous: unrelated,
    next: { ...unrelated, email: "new@example.test" },
    queuedAt: new Date(start + 10_000).toISOString(),
    dueAt: new Date(start + 40_000).toISOString(),
    positionSignature,
  });
  assert.equal(plan.operation, "upsert");
  assert.equal(original.dueAt, new Date(start + 30_000).toISOString());
  assert.equal(original.appointment.email, "kasi@example.test");
});

test("multiple edits during debounce settle into one final booking notification", () => {
  const initial = appointment();
  const existing = newJob("job-a", initial);
  const moved = { ...initial, start: 610 };
  const resized = { ...moved, duration: 60 };
  const plan = planBookingNotificationIntent({
    existing,
    action: "rescheduled",
    previous: moved,
    next: resized,
    queuedAt: new Date(start + 20_000).toISOString(),
    dueAt: new Date(start + 50_000).toISOString(),
    positionSignature,
  });
  assert.equal(plan.operation, "upsert");
  if (plan.operation !== "upsert") return;
  assert.equal(plan.intent.action, "booking");
  assert.equal(plan.intent.appointment.duration, 60);
  assert.equal(plan.intent.dueAt, new Date(start + 50_000).toISOString());
});

test("reschedule preserves the original time while settling the final time", () => {
  const original = appointment();
  const firstMove = { ...original, start: 630 };
  const existing = newJob("job-a", firstMove, {
    action: "rescheduled",
    previousAppointment: original,
    originalPositionSignature: positionSignature(original),
  });
  const finalMove = { ...firstMove, start: 660 };
  const plan = planBookingNotificationIntent({
    existing,
    action: "rescheduled",
    previous: firstMove,
    next: finalMove,
    queuedAt: new Date(start + 20_000).toISOString(),
    dueAt: new Date(start + 50_000).toISOString(),
    positionSignature,
  });
  assert.equal(plan.operation, "upsert");
  if (plan.operation !== "upsert") return;
  assert.equal(plan.intent.action, "rescheduled");
  assert.equal(plan.intent.previousAppointment.start, 600);
  assert.equal(plan.intent.appointment.start, 660);
});

test("create then cancel during debounce suppresses both noisy emails", () => {
  const created = appointment();
  const plan = planBookingNotificationIntent({
    existing: newJob("job-a", created),
    action: "cancelled",
    previous: created,
    queuedAt: new Date(start + 20_000).toISOString(),
    dueAt: new Date(start + 50_000).toISOString(),
    positionSignature,
  });
  assert.deepEqual(plan, { operation: "cancel", reason: "created_then_cancelled_during_debounce" });
});

test("failed provider delivery remains retryable", async () => {
  const store = new MemoryOutbox();
  store.jobs.push(newJob("job-a", appointment(), { dueAt: new Date(start).toISOString() }));
  await store.worker(async () => [{ status: "failed", channel: "client", reason: "resend_failed_503" }]);
  assert.equal(store.jobs[0].status, "retry");
  assert.match(store.jobs[0].lastError || "", /503/);
  assert.ok(Date.parse(store.jobs[0].nextAttemptAt || "") > store.now);
});

test("successful job cannot be sent again by a later worker run", async () => {
  const store = new MemoryOutbox();
  store.jobs.push(newJob("job-a", appointment(), { dueAt: new Date(start).toISOString() }));
  let deliveries = 0;
  const deliver = async () => (deliveries += 1, [{ status: "sent" }]);
  await store.worker(deliver);
  await store.worker(deliver);
  assert.equal(deliveries, 1);
});

test("two overlapping workers cannot claim the same due job", async () => {
  const store = new MemoryOutbox();
  store.jobs.push(newJob("job-a", appointment(), { dueAt: new Date(start).toISOString() }));
  let deliveries = 0;
  const deliver = async () => (deliveries += 1, [{ status: "sent" }]);
  const [left, right] = await Promise.all([store.worker(deliver), store.worker(deliver)]);
  assert.equal(left.claimed + right.claimed, 1);
  assert.equal(deliveries, 1);
});

test("the same normalised coach and admin address is one recipient", () => {
  assert.equal(sameNotificationRecipient(" Coach@Example.test ", "coach@example.test"), true);
  assert.deepEqual(internalNotificationDeliveryPlan({
    coachRecipient: " Coach@Example.test ",
    adminRecipient: "coach@example.test",
    coachEnabled: true,
    adminEnabled: true,
  }), [{ channel: "coach", recipient: "coach@example.test" }]);
});

test("different coach and admin addresses remain separate recipients", () => {
  assert.equal(sameNotificationRecipient("coach@example.test", "admin@example.test"), false);
  assert.deepEqual(internalNotificationDeliveryPlan({
    coachRecipient: "coach@example.test",
    adminRecipient: "admin@example.test",
    coachEnabled: true,
    adminEnabled: true,
  }), [
    { channel: "coach", recipient: "coach@example.test" },
    { channel: "admin", recipient: "admin@example.test" },
  ]);
});

test("a migrated legacy queued snapshot remains independently deliverable", async () => {
  const store = new MemoryOutbox();
  const legacySnapshot = appointment("legacy-booking", { start: 720 });
  store.jobs.push(newJob("legacy-job", legacySnapshot, {
    source: "legacy-admin-debounce-migration",
    queuedAt: new Date(start - 60_000).toISOString(),
    dueAt: new Date(start - 30_000).toISOString(),
  }));
  let deliveredStart = 0;
  await store.worker(async (job) => {
    deliveredStart = job.appointment.start;
    return [{ status: "sent" }];
  });
  assert.equal(deliveredStart, 720);
  assert.equal(store.jobs[0].status, "sent");
});

test("outbox records queued, eligible, first-attempt, sent and failure timing", async () => {
  const store = new MemoryOutbox();
  const job = newJob("job-a", appointment());
  store.jobs.push(job);
  store.now = Date.parse(job.dueAt);
  await store.worker(async () => [{ status: "failed", reason: "temporary" }]);
  assert.equal(job.queuedAt, new Date(start).toISOString());
  assert.equal(job.dueAt, new Date(start + 30_000).toISOString());
  assert.equal(job.firstAttemptedAt, new Date(start + 30_000).toISOString());
  assert.equal(store.failures.length, 1);
  store.now = Date.parse(job.nextAttemptAt || "");
  await store.worker(async () => [{ status: "sent", id: "provider-1" }]);
  assert.equal(job.sentAt, new Date(store.now).toISOString());
  assert.equal(job.attemptCount, 2);
});
