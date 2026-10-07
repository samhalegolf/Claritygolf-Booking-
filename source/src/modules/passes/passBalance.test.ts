import assert from "node:assert/strict";
import { test } from "node:test";
import { passBalanceSummary } from "./passBalance.ts";

test("passBalanceSummary counts only live passes and finds the soonest expiry", () => {
  const summary = passBalanceSummary([
    { status: "active", creditsAvailable: 3, nextExpiry: "2027-03-01T00:00:00Z" },
    { status: "active", creditsAvailable: 2, nextExpiry: "2026-12-01T00:00:00Z" },
    { status: "exhausted", creditsAvailable: 0, nextExpiry: null },
    { status: "expired", creditsAvailable: 4, nextExpiry: "2026-01-01T00:00:00Z" },
    { status: "void", creditsAvailable: 6, nextExpiry: null },
  ]);
  assert.deepEqual(summary, { credits: 5, livePasses: 2, nextExpiry: "2026-12-01T00:00:00Z" });
});

test("passBalanceSummary of nobody's passes is an empty balance, not an error", () => {
  assert.deepEqual(passBalanceSummary([]), { credits: 0, livePasses: 0, nextExpiry: null });
});
