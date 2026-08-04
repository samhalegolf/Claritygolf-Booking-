import assert from "node:assert/strict";
import test from "node:test";

import { isRetryableGoogleFailure } from "../google-calendar-sync.mts";

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
