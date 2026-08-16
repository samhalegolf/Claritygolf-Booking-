import assert from "node:assert/strict";
import test from "node:test";

import { buildBookingSetInput, classifyOptixFailure, OptixSyncError } from "./optix-client.mts";

test("classifies HTTP 401 as an expired or invalid personal token", () => {
  const error = classifyOptixFailure({ status: 401, responseText: "Unauthorized" });

  assert.ok(error instanceof OptixSyncError);
  assert.equal(error.code, "token_expired");
  assert.equal(error.retryable, true);
  assert.match(error.message, /OPTIX_PERSONAL_TOKEN/);
});

test("an auth failure names the credential actually in use", () => {
  // The two tokens are configured separately, so a message that does not say
  // which one was used leaves the admin replacing the wrong secret.
  const organization = classifyOptixFailure({
    status: 401, responseText: "Unauthorized", tokenKind: "organization",
  });
  assert.match(organization.message, /OPTIX_ORGANIZATION_TOKEN/);
  assert.doesNotMatch(organization.message, /OPTIX_PERSONAL_TOKEN/);

  const personal = classifyOptixFailure({
    status: 401, responseText: "Unauthorized", tokenKind: "personal",
  });
  assert.match(personal.message, /OPTIX_PERSONAL_TOKEN/);
});

test("a permissions refusal is not a generic remote error", () => {
  // Optix's wording for a user that cannot book. It names neither
  // "unauthorized" nor "forbidden", so it used to classify as remote_error.
  const error = classifyOptixFailure({
    status: 200,
    graphQLErrors: [{ message: "Your user account is not allowed to make bookings" }],
    tokenKind: "organization",
  });
  assert.equal(error.code, "unauthorized");
  assert.equal(error.retryable, false);
});

const bookingInput = {
  memberId: "", ownerUserId: "", resourceIds: ["600007"],
  startTimestamp: 1_760_000_000, endTimestamp: 1_760_003_600,
  externalId: "clarity:appt-1", title: "Ada Lovelace",
};

test("exactly the configured identity is sent, and the other is withheld", () => {
  // Two identities exist in Optix -- a user record and an admin record -- and
  // only one is accepted through the organisation token route. Sending both, or
  // sending an empty one, is what has to be avoidable.
  const memberOnly: any = buildBookingSetInput({ ...bookingInput, memberId: "member-123" });
  assert.deepEqual(memberOnly.account, { member_id: "member-123" });
  assert.ok(!("owner_user_id" in memberOnly), "the withheld user id must not be sent");

  const ownerOnly: any = buildBookingSetInput({ ...bookingInput, ownerUserId: "user-456" });
  assert.equal(ownerOnly.owner_user_id, "user-456");
  assert.ok(!("account" in ownerOnly), "the withheld member id must not be sent");
});

test("the owning user is sent under an organisation token too", () => {
  // It used to go only with a personal token, so organisation token plus a user
  // id -- the combination that works -- could not be expressed.
  const withOrgToken: any = buildBookingSetInput({ ...bookingInput, ownerUserId: "user-456" }, "organization");
  assert.equal(withOrgToken.owner_user_id, "user-456");
});

test("Optix setup with neither identity fails before any request is made", () => {
  assert.throws(
    () => buildBookingSetInput(bookingInput),
    (error: any) => error instanceof OptixSyncError && error.code === "not_configured",
  );
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

// -- Cancelling an existing booking (delete-in-Clarity → cancel-in-Optix) ----

const cancelInput = {
  memberId: "", ownerUserId: "", resourceIds: [] as string[],
  startTimestamp: 1_760_000_000, endTimestamp: 1_760_003_600,
  externalId: "", bookingId: "optix-booking-99", isCanceled: true,
  title: "Ada Lovelace",
};

test("a cancel of an existing booking needs no resource, identity or external id", () => {
  // An imported lesson knows only the Optix booking_id — the webhook that
  // created it carries no resource id, and the booking belongs to the
  // customer, not to Clarity's configured identity. Requiring any of those
  // would make customer bookings uncancellable.
  const payload: any = buildBookingSetInput(cancelInput);
  assert.equal(payload.bookings[0].booking_id, "optix-booking-99");
  assert.equal(payload.bookings[0].is_canceled, true);
  assert.ok(!("resource_id" in payload.bookings[0]), "no resource id may be invented for a cancel");
  assert.ok(!("external_id" in payload.bookings[0]), "no external id may be rewritten by a cancel");
  assert.ok(!("account" in payload) && !("owner_user_id" in payload), "a cancel must not assert an identity");
});

test("a cancel never asserts Clarity's identity even when one is configured", () => {
  // Sending account/owner on someone else's booking is how a cancel could
  // turn into a reassignment.
  const payload: any = buildBookingSetInput({ ...cancelInput, memberId: "member-123", ownerUserId: "user-456" });
  assert.ok(!("account" in payload));
  assert.ok(!("owner_user_id" in payload));
});

test("a cancel without a booking id still validates like a creation", () => {
  // is_canceled alone is not a licence to skip validation — only a targeted
  // cancel of a known booking is exempt.
  assert.throws(
    () => buildBookingSetInput({ ...cancelInput, bookingId: "" }),
    (error: any) => error instanceof OptixSyncError && error.code === "validation_failed",
  );
});

test("creation validation is unchanged by the cancel exemption", () => {
  assert.throws(
    () => buildBookingSetInput({ ...cancelInput, isCanceled: false }),
    (error: any) => error instanceof OptixSyncError,
  );
});
