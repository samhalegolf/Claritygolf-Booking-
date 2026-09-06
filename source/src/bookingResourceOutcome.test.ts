import assert from "node:assert/strict";
import test from "node:test";

import {
  bayLabel,
  buildDetails,
  describeBookAttempt,
  describeStatusRecord,
  type ResourceStatusRecord,
} from "./bookingResourceOutcome.ts";

const NOW = Date.parse("2026-09-06T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const record = (over: Partial<ResourceStatusRecord> = {}): ResourceStatusRecord => ({
  calendarItemId: "item-1",
  hasSyncRow: true,
  syncStatus: "failed",
  errorCode: "remote_error",
  errorMessage: "Optix said no (HTTP 500, request abc123)",
  resourceId: "600005",
  bayName: "Bay #3",
  lastAttemptedAt: minutesAgo(2),
  ...over,
});

test("a lesson with no sync row has never had a bay attempted", () => {
  for (const value of [null, undefined, { hasSyncRow: false }, { syncStatus: "none" }]) {
    const outcome = describeStatusRecord(value as ResourceStatusRecord, NOW);
    assert.equal(outcome.tone, "idle");
    assert.equal(outcome.title, "No bay booked");
    assert.equal(outcome.canRetry, true);
    assert.equal(outcome.details, "");
  }
});

test("a synced row names the bay and offers no retry", () => {
  const outcome = describeStatusRecord(record({ syncStatus: "synced", errorCode: "", errorMessage: "" }), NOW);
  assert.equal(outcome.tone, "ok");
  assert.equal(outcome.title, "Bay #3");
  assert.equal(outcome.canRetry, false);
});

test("bays switched off for a lesson type is a setting, not a failure", () => {
  const outcome = describeStatusRecord(
    record({ syncStatus: "cancelled", errorCode: "optix_disabled", errorMessage: "" }),
    NOW,
  );
  assert.equal(outcome.tone, "idle");
  assert.match(outcome.title, /off for this lesson type/i);
  assert.equal(outcome.canRetry, false);
});

test("a released bay offers Book bay again — this is the reschedule recovery path", () => {
  const outcome = describeStatusRecord(record({ syncStatus: "cancelled", errorCode: "", errorMessage: "" }), NOW);
  assert.equal(outcome.canRetry, true);
  assert.equal(outcome.tone, "idle");
});

test("a recent failure is red; the same failure an hour later is history", () => {
  const fresh = describeStatusRecord(record({ errorCode: "resource_conflict" }), NOW);
  assert.equal(fresh.tone, "error");
  assert.equal(fresh.title, "No bay free");
  assert.equal(fresh.staleAttemptAt, null);

  const old = describeStatusRecord(
    record({ errorCode: "resource_conflict", lastAttemptedAt: minutesAgo(90) }),
    NOW,
  );
  assert.equal(old.tone, "warn");
  assert.equal(old.title, "No bay free");
  assert.equal(old.staleAttemptAt, minutesAgo(90));
});

test("every failure code has a title, and an unknown one still says something", () => {
  const codes = [
    ["resource_conflict", "No bay free"],
    ["token_expired", "Optix login expired"],
    ["unauthorized", "Optix refused access"],
    ["validation_failed", "Optix rejected the details"],
    ["timeout", "Optix did not answer"],
    ["not_configured", "No bays for this lesson type"],
    ["remote_error", "Optix returned an error"],
    ["something_new_from_optix", "Optix booking failed"],
    ["", "Optix booking failed"],
  ];
  for (const [code, title] of codes) {
    const outcome = describeStatusRecord(record({ errorCode: code }), NOW);
    assert.equal(outcome.title, title, `code ${code || "(empty)"}`);
    assert.ok(outcome.line.length > 0);
  }
});

test("only a timeout asks the coach to check Optix before booking again", () => {
  assert.equal(describeStatusRecord(record({ errorCode: "timeout" }), NOW).needsOptixCheckFirst, true);
  assert.equal(describeStatusRecord(record({ errorCode: "resource_conflict" }), NOW).needsOptixCheckFirst, false);
});

test("an unreachable server is not silence", () => {
  const outcome = describeBookAttempt({ kind: "unreachable", error: new Error("Failed to fetch") });
  assert.equal(outcome.tone, "error");
  assert.equal(outcome.title, "Could not reach Clarity");
  assert.equal(outcome.canRetry, true);
});

test("401 says signed out rather than showing an empty card", () => {
  const outcome = describeBookAttempt({ kind: "response", status: 401, payload: { error: "unauthorized" } });
  assert.equal(outcome.title, "Signed out");
  assert.equal(outcome.canRetry, false);
});

test("403 and 400 are told apart", () => {
  assert.equal(describeBookAttempt({ kind: "response", status: 403, payload: {} }).title, "Not allowed");
  assert.equal(
    describeBookAttempt({ kind: "response", status: 400, payload: { error: "manual_booking_required" } }).title,
    "Clarity sent a bad request",
  );
});

test("503 is Clarity's Optix credentials, and repeats what the server named", () => {
  const outcome = describeBookAttempt({
    kind: "response",
    status: 503,
    payload: { error: "not_configured", message: "Set OPTIX_ORGANIZATION_TOKEN." },
  });
  assert.equal(outcome.title, "Optix isn't set up");
  assert.equal(outcome.line, "Set OPTIX_ORGANIZATION_TOKEN.");
});

test("207 is a real answer: the attempt ran and Optix refused", () => {
  const outcome = describeBookAttempt({
    kind: "response",
    status: 207,
    payload: { ok: false, result: record({ errorCode: "resource_conflict" }) },
  });
  assert.equal(outcome.tone, "error");
  assert.equal(outcome.title, "No bay free");
  assert.match(outcome.details, /resource_conflict/);
});

test("success is only ok:true, and it names the bay", () => {
  const booked = describeBookAttempt({
    kind: "response",
    status: 200,
    payload: { ok: true, result: record({ syncStatus: "synced", errorCode: "" }) },
  });
  assert.equal(booked.tone, "ok");
  assert.equal(booked.title, "Bay #3");

  const already = describeBookAttempt({
    kind: "response",
    status: 200,
    payload: { ok: true, alreadyBooked: true, result: record({ syncStatus: "synced", errorCode: "" }) },
  });
  assert.equal(already.title, "Already booked");

  const notOk = describeBookAttempt({ kind: "response", status: 200, payload: { ok: false, result: record() } });
  assert.equal(notOk.tone, "error");
});

test("a 500 with nothing useful still lands on a title", () => {
  const outcome = describeBookAttempt({ kind: "response", status: 500, payload: {} });
  assert.equal(outcome.title, "Optix booking failed");
  assert.ok(outcome.line.length > 0);
});

test("details are empty when there is nothing more to say, so no empty disclosure renders", () => {
  assert.equal(buildDetails(null), "");
  assert.equal(buildDetails({ errorCode: "", errorMessage: "", resourceId: "" }), "");
  assert.equal(describeStatusRecord(record({ syncStatus: "synced", errorCode: "" }), NOW).details, "");
  assert.match(buildDetails(record()), /Error code: remote_error/);
});

test("an unnamed bay shows its resource id rather than nothing", () => {
  assert.equal(bayLabel({ resourceId: "600011", bayName: "" }), "Resource 600011");
  assert.equal(bayLabel({ resourceId: "", bayName: "" }), "");
});
