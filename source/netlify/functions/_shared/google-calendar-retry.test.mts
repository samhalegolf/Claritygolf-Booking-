import assert from "node:assert/strict";
import test from "node:test";

import { isBusyGoogleItem, isRetryableGoogleFailure } from "../google-calendar-sync.mts";

test("retries the 403 rate limit Google returns for calendar write bursts", () => {
  // Google answers a throttled burst with 403 + usageLimits/rateLimitExceeded
  // rather than 429, which is what took down the full "Sync now" rebuild.
  assert.equal(isRetryableGoogleFailure(403, { googleReason: "rateLimitExceeded" }), true);
  assert.equal(isRetryableGoogleFailure(403, { googleReason: "userRateLimitExceeded" }), true);
});

test("does not retry a 403 that means the account cannot write to the calendar", () => {
  assert.equal(isRetryableGoogleFailure(403, { googleReason: "forbiddenForServiceAccounts" }), false);
  assert.equal(isRetryableGoogleFailure(403, { googleReason: "" }), false);
});

test("does not retry a spent daily quota", () => {
  // Backing off milliseconds cannot clear a 24h quota.
  assert.equal(isRetryableGoogleFailure(403, { googleReason: "quotaExceeded" }), false);
});

test("retries 429 and server errors", () => {
  assert.equal(isRetryableGoogleFailure(429, { googleReason: "" }), true);
  assert.equal(isRetryableGoogleFailure(500, { googleReason: "" }), true);
  assert.equal(isRetryableGoogleFailure(503, { googleReason: "" }), true);
});

test("does not retry client errors that will fail again identically", () => {
  assert.equal(isRetryableGoogleFailure(400, { googleReason: "" }), false);
  assert.equal(isRetryableGoogleFailure(401, { googleReason: "" }), false);
  assert.equal(isRetryableGoogleFailure(404, { googleReason: "" }), false);
  assert.equal(isRetryableGoogleFailure(409, { googleReason: "duplicate" }), false);
});

// The other half of the import loop guard. google-calendar-import.mts refuses
// to read Clarity's own events back in; this refuses to write imported blocks
// back out. Either half alone still loops, one hop slower — an imported block
// would be pushed to Google as a new event, read back as a foreign event on
// the next run, and blocks would breed on every sync.
test("a block imported from Google is never pushed back to Google", () => {
  const imported = { kind: "block", status: "booked", origin: "google" };
  assert.equal(isBusyGoogleItem(imported), false);
});

test("the coach's own blocks and lessons still sync out", () => {
  assert.equal(isBusyGoogleItem({ kind: "block", status: "booked", origin: "clarity" }), true);
  assert.equal(isBusyGoogleItem({ kind: "appointment", status: "booked", origin: "clarity" }), true);
  // An Optix-owned lesson is Clarity's to display and Google's to know about;
  // only the google origin is the loop risk.
  assert.equal(isBusyGoogleItem({ kind: "appointment", status: "booked", origin: "optix" }), true);
});

test("cancelled and no-show time is released in Google", () => {
  assert.equal(isBusyGoogleItem({ kind: "appointment", status: "cancelled", origin: "clarity" }), false);
  assert.equal(isBusyGoogleItem({ kind: "appointment", status: "no_show", origin: "clarity" }), false);
  assert.equal(isBusyGoogleItem(null), false);
});
