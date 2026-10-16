import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { authSessionResponse } from "./auth-contract.mts";
import { isDeveloperEmail } from "./developer.mts";

afterEach(() => {
  delete process.env.CLARITY_DEVELOPER_EMAILS;
});

test("nobody is a developer when the env var is unset", () => {
  assert.equal(isDeveloperEmail("dev@example.com"), false);
});

test("matches listed emails, ignoring case and spacing", () => {
  process.env.CLARITY_DEVELOPER_EMAILS = " Dev@Example.com , other@example.com";
  assert.equal(isDeveloperEmail("dev@example.com"), true);
  assert.equal(isDeveloperEmail("OTHER@example.com"), true);
  assert.equal(isDeveloperEmail("owner@example.com"), false);
  assert.equal(isDeveloperEmail(""), false);
});

test("the session response decides isDeveloper itself", () => {
  process.env.CLARITY_DEVELOPER_EMAILS = "dev@example.com";
  assert.equal(authSessionResponse({ authenticated: true, role: "coach", email: "dev@example.com" }).isDeveloper, true);
  // A caller cannot set it for someone else...
  assert.equal(
    authSessionResponse({ authenticated: true, role: "coach", email: "owner@example.com", isDeveloper: true }).isDeveloper,
    undefined,
  );
  // ...and a signed-out answer never carries it.
  assert.equal(authSessionResponse({ authenticated: false, role: "guest", email: "dev@example.com" }).isDeveloper, undefined);
});
