import assert from "node:assert/strict";
import test from "node:test";

import {
  optixWebhookSignature,
  parseOptixWebhookForm,
  validateOptixWebhook,
} from "./optix-webhook-auth.mts";

const clientId = "clarity-client";
const appSecret = "super-secret";
const createdTimestamp = "1785624360";

function signedBody(overrides: Record<string, string> = {}) {
  const values = {
    client_id: clientId,
    created_timestamp: createdTimestamp,
    organization_id: "1234",
    event: "new_member_booking",
    booking_id: "39553",
    member_name: "Samuel",
    member_last_name: "Hale",
    ...overrides,
  };
  const signature = optixWebhookSignature(
    values.client_id,
    appSecret,
    values.created_timestamp,
  );
  return new URLSearchParams({ ...values, request_signature: signature }).toString();
}

test("computes the documented Optix SHA-1 signature", () => {
  assert.equal(
    optixWebhookSignature("123", "secret", "123456"),
    "b849f501f7302f748245503b0101d7d2a1b45a10",
  );
});

test("parses Optix form payloads", () => {
  const payload = parseOptixWebhookForm("event=new_member_booking&member_name=Sam+Hale");
  assert.deepEqual(payload, { event: "new_member_booking", member_name: "Sam Hale" });
});

test("accepts a correctly signed form webhook", () => {
  const result = validateOptixWebhook({
    rawBody: signedBody(),
    contentType: "application/x-www-form-urlencoded; charset=UTF-8",
    expectedClientId: clientId,
    appSecret,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.payload.event, "new_member_booking");
    assert.equal(result.payload.booking_id, "39553");
  }
});

test("rejects JSON requests", () => {
  const result = validateOptixWebhook({
    rawBody: JSON.stringify({ event: "new_member_booking" }),
    contentType: "application/json",
    expectedClientId: clientId,
    appSecret,
  });
  assert.deepEqual(result, {
    ok: false,
    error: "unsupported_media_type",
    message: "Optix webhooks must use form encoding.",
  });
});

test("rejects a different Optix app client ID", () => {
  const result = validateOptixWebhook({
    rawBody: signedBody({ client_id: "another-client" }),
    contentType: "application/x-www-form-urlencoded",
    expectedClientId: clientId,
    appSecret,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "client_id_mismatch");
});

test("rejects a modified signature", () => {
  const params = new URLSearchParams(signedBody());
  params.set("request_signature", "0".repeat(40));
  const result = validateOptixWebhook({
    rawBody: params.toString(),
    contentType: "application/x-www-form-urlencoded",
    expectedClientId: clientId,
    appSecret,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "invalid_signature");
});

test("requires configured credentials and mandatory fields", () => {
  const unconfigured = validateOptixWebhook({
    rawBody: signedBody(),
    contentType: "application/x-www-form-urlencoded",
    expectedClientId: "",
    appSecret: "",
  });
  assert.equal(unconfigured.ok, false);
  if (!unconfigured.ok) assert.equal(unconfigured.error, "webhook_not_configured");

  const incomplete = validateOptixWebhook({
    rawBody: "client_id=clarity-client",
    contentType: "application/x-www-form-urlencoded",
    expectedClientId: clientId,
    appSecret,
  });
  assert.equal(incomplete.ok, false);
  if (!incomplete.ok) assert.equal(incomplete.error, "invalid_payload");
});
