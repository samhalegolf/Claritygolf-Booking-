/**
 * What crosses the line into a player's hands.
 *
 * A PassView is the coach's object and carries three things a player must
 * never be handed: the note (which says things like "comped after he
 * complained"), the source, and a redeemed_by naming an admin user. The portal
 * therefore gets an allow-listed shape rather than a filtered copy -- and the
 * point of these tests is that the allow-list stays an allow-list. The failure
 * they exist to catch is somebody adding a field to PassView and it silently
 * appearing in a player's browser.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { playerPassView, playerPassViews } from "./passes.mts";
import type { PassView } from "./passes.mts";

const NAMES = new Map([
  ["lesson-60", "60 Minute Lesson"],
  ["lesson-30", "30 Minute Lesson"],
]);

function pass(over: Partial<PassView> = {}): PassView {
  return {
    id: "pass-1",
    personId: "person-1",
    name: "5 Lesson Package",
    templateServiceId: "package-5",
    coversServiceIds: ["lesson-60"],
    creditsAvailable: 3,
    creditsAllocated: 5,
    creditsRedeemed: 2,
    nextExpiry: "2027-08-17T00:00:00.000Z",
    expiresAt: "2027-12-01T00:00:00.000Z",
    status: "active",
    source: "clarity_pos",
    note: "Comped after the rained-out session",
    issuedAt: "2026-08-17T00:00:00.000Z",
    allocations: [],
    redemptions: [],
    ...over,
  };
}

test("the coach's private fields do not cross into the player's view", () => {
  const view = playerPassView(pass(), NAMES);
  const keys = Object.keys(view).sort();
  assert.deepEqual(keys, [
    "covers",
    "creditsAllocated",
    "creditsAvailable",
    "creditsRedeemed",
    "expiresAt",
    "history",
    "id",
    "issuedAt",
    "name",
    "status",
  ]);
  // Named individually as well as by the shape above, so a failure says which
  // one leaked rather than just "the keys changed".
  assert.equal("note" in view, false, "the coach's note is not the player's business");
  assert.equal("source" in view, false);
  assert.equal("personId" in view, false);
  assert.equal("allocations" in view, false);
  assert.equal("templateServiceId" in view, false);
});

test("coverage arrives as names, because a player has no catalogue", () => {
  const view = playerPassView(pass({ coversServiceIds: ["lesson-60", "lesson-30"] }), NAMES);
  assert.deepEqual(view.covers, ["60 Minute Lesson", "30 Minute Lesson"]);
});

test("a covered service that no longer exists is dropped, not shown as an id", () => {
  const view = playerPassView(pass({ coversServiceIds: ["lesson-60", "deleted-service"] }), NAMES);
  assert.deepEqual(view.covers, ["60 Minute Lesson"]);
});

test("the expiry shown is the soonest one, not the pass's own", () => {
  // nextExpiry is the first allocation to go off. That is the date that costs
  // the player a credit if they ignore it; the pass-level one is later.
  const view = playerPassView(pass(), NAMES);
  assert.equal(view.expiresAt, "2027-08-17T00:00:00.000Z");
});

test("a pass with no allocation expiry falls back to the pass's own", () => {
  const view = playerPassView(pass({ nextExpiry: null }), NAMES);
  assert.equal(view.expiresAt, "2027-12-01T00:00:00.000Z");
});

test("history carries dates and bookings, never who pressed the button", () => {
  const view = playerPassView(
    pass({
      redemptions: [
        {
          id: "r1",
          allocationId: "a1",
          bookingId: "booking-9",
          credits: 1,
          redeemedAt: "2026-09-03T00:00:00.000Z",
          redeemedBy: "admin-user-42",
          reversedAt: null,
          reversalReason: null,
        },
      ],
    }),
    NAMES,
  );
  assert.deepEqual(view.history, [
    { id: "r1", redeemedAt: "2026-09-03T00:00:00.000Z", bookingId: "booking-9" },
  ]);
  assert.equal(JSON.stringify(view).includes("admin-user-42"), false);
});

test("a reversed redemption is not history, because the credit came back", () => {
  // Showing it would say a credit was spent that the player still holds --
  // the balance and the history would contradict each other on screen.
  const view = playerPassView(
    pass({
      redemptions: [
        {
          id: "r1",
          allocationId: "a1",
          bookingId: "booking-9",
          credits: 1,
          redeemedAt: "2026-09-03T00:00:00.000Z",
          redeemedBy: "admin",
          reversedAt: "2026-09-04T00:00:00.000Z",
          reversalReason: "Lesson cancelled",
        },
      ],
    }),
    NAMES,
  );
  assert.deepEqual(view.history, []);
});

test("a voided pass is not shown to its holder at all", () => {
  const views = playerPassViews([pass({ id: "p1", status: "void" }), pass({ id: "p2" })], NAMES);
  assert.deepEqual(
    views.map((entry) => entry.id),
    ["p2"],
  );
});

test("spendable passes come first, finished ones last", () => {
  const views = playerPassViews(
    [
      pass({ id: "expired", status: "expired" }),
      pass({ id: "exhausted", status: "exhausted" }),
      pass({ id: "scheduled", status: "scheduled" }),
      pass({ id: "active", status: "active" }),
    ],
    NAMES,
  );
  assert.deepEqual(
    views.map((entry) => entry.id),
    ["active", "scheduled", "exhausted", "expired"],
  );
});

test("two passes in the same state fall back to newest issued first", () => {
  const views = playerPassViews(
    [
      pass({ id: "older", issuedAt: "2026-01-01T00:00:00.000Z" }),
      pass({ id: "newer", issuedAt: "2026-09-01T00:00:00.000Z" }),
    ],
    NAMES,
  );
  assert.deepEqual(
    views.map((entry) => entry.id),
    ["newer", "older"],
  );
});

test("no passes is not an error, it is an empty list", () => {
  assert.deepEqual(playerPassViews([], NAMES), []);
});
