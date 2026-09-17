/**
 * The "absent means fallback" rule, which billing-api reads every optional
 * query parameter through.
 *
 * Worth its own file because the bug it fixes was invisible for as long as the
 * browser happened to send the parameter. `Number(null)` is 0 and 0 is finite,
 * so a missing `?limit=` became a limit of zero, which the `Math.max(1, …)`
 * around every call site then turned into a limit of one row. Five readers had
 * it; only the voucher scan, whose parameter is genuinely optional, ever
 * showed it -- as "Read 0 payments from the last 1 days".
 */

import assert from "node:assert/strict";
import test from "node:test";

import { cleanNumber } from "../billing-api.mts";

test("a missing query parameter takes the fallback, not zero", () => {
  // url.searchParams.get() returns null for a parameter that was not sent.
  assert.equal(cleanNumber(null, 730), 730);
  assert.equal(cleanNumber(undefined, 200), 200);
  assert.equal(cleanNumber("", 50), 50);
});

test("the fallback survives the clamp every caller wraps it in", () => {
  // The shape at every call site. Before the fix this was Math.max(1, 0) = 1.
  const days = Math.max(1, Math.min(1825, cleanNumber(null, 730)));
  assert.equal(days, 730);
});

test("a supplied number is still used, including an explicit zero", () => {
  assert.equal(cleanNumber("30", 730), 30);
  assert.equal(cleanNumber(0, 730), 0, "an explicit 0 is a value, not an absence");
  assert.equal(cleanNumber("0", 730), 0);
});

test("nonsense still falls back", () => {
  assert.equal(cleanNumber("abc", 730), 730);
  assert.equal(cleanNumber(Number.NaN, 730), 730);
});

test("the clamp is applied to supplied values", () => {
  assert.equal(cleanNumber("500", 0, { min: 0, max: 100 }), 100);
  assert.equal(cleanNumber("-5", 0, { min: 0, max: 100 }), 0);
});
