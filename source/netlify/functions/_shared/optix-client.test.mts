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

test("a busy bay is a conflict however Optix words it", () => {
  // Optix's actual wording, seen on 5 Aug 2026. It contains no "unavailable",
  // so it used to classify as remote_error -- which stopped the auto-select
  // loop at the first bay and left six configured bays untried.
  const error = classifyOptixFailure({
    status: 200,
    graphQLErrors: [{ message: "The resource is not available during the selected times" }],
  });

  assert.equal(error.code, "resource_conflict");
});

test("a server outage is not mistaken for a busy bay", () => {
  // Same words, different meaning: this must stay a remote error so the loop
  // reports an outage instead of claiming every bay is booked.
  const error = classifyOptixFailure({
    status: 503,
    responseText: "Service not available",
  });

  assert.equal(error.code, "remote_error");
  assert.equal(error.retryable, true);
});

test("keeps generic server failures retryable", () => {
  const error = classifyOptixFailure({ status: 503, responseText: "Upstream service failed" });

  assert.equal(error.code, "remote_error");
  assert.equal(error.retryable, true);
});
