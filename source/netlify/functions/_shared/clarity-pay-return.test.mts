import assert from "node:assert/strict";
import test from "node:test";

import { clarityPayOrigin, clarityPayReturnPath } from "./clarity-pay.mts";

test("the trip back from Stripe lands on the page it started from, signed in", () => {
  assert.equal(clarityPayReturnPath("profile", "on"), "/login?view=profile&clarityPay=on");
  assert.equal(clarityPayReturnPath("billing", "pending"), "/login?view=billing&billing=settings&clarityPay=pending");
  // Never the bare root: that is the public home page, which asks a signed-in coach to sign in.
  assert.ok(clarityPayReturnPath("billing").startsWith("/login?"));
});

test("an origin the app did not send falls back to Billing › Settings", () => {
  assert.equal(clarityPayOrigin("profile"), "profile");
  assert.equal(clarityPayOrigin("billing"), "billing");
  assert.equal(clarityPayOrigin("https://evil.example"), "billing");
  assert.equal(clarityPayOrigin(undefined), "billing");
});
