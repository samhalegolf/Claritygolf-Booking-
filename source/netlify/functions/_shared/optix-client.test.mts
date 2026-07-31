import assert from "node:assert/strict";
import test from "node:test";

import { classifyOptixFailure, OptixSyncError } from "./optix-client.mts";

test("classifies HTTP 401 as an expired or invalid personal token", () => {
  const error = classifyOptixFailure({ status: 401, responseText: "Unauthorized" });

  assert.ok(error instanceof OptixSyncError);
  assert.equal(error.code, "token_expired");
  assert.equal(error.retryable, true);
  assert.match(error.message, /OPTIX_PERSONAL_TOKEN/);
});

test("classifies GraphQL token expiry messages even when HTTP is 200", () => {
  const error = classifyOptixFailure({
    status: 200,
    graphQLErrors: [{ message: "Access token has expired" }],
  });

  assert.equal(error.code, "token_expired");
  assert.equal(error.retryable, true);
});

test("classifies unavailable resources as a booking conflict", () => {
  const error = classifyOptixFailure({
    status: 200,
    graphQLErrors: [{ message: "Resource is unavailable because it is already booked" }],
  });

  assert.equal(error.code, "resource_conflict");
  assert.equal(error.retryable, false);
});

test("keeps generic server failures retryable", () => {
  const error = classifyOptixFailure({ status: 503, responseText: "Upstream service failed" });

  assert.equal(error.code, "remote_error");
  assert.equal(error.retryable, true);
});
