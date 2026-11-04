import assert from "node:assert/strict";
import test from "node:test";

import {
  addClub,
  bagFingerprint,
  decideBagSync,
  generateBag,
  generateRest,
  normaliseBag,
  removeClub,
  totalForCarry,
  updateClub,
} from "./bag-model.mts";

test("a bag is cleaned, de-duplicated and ordered longest first", () => {
  const bag = normaliseBag([
    { club: "PW", baseCarry: 110 },
    { name: "Driver", carry: 225 },
    { club: "pw", baseCarry: 99 },
    { club: "", baseCarry: 100 },
    { club: "7i", baseCarry: 0 },
    { club: "Ghost", baseCarry: 150, ghost: true },
  ]);
  assert.deepEqual(bag.map((row) => [row.club, row.baseCarry]), [["Driver", 225], ["PW", 110]]);
});

test("totals use Caddy's normal-ground roll-out", () => {
  assert.equal(totalForCarry("Driver", 230), 255);
  assert.equal(totalForCarry("7i", 155), 167);
  assert.equal(totalForCarry("PW", 115), 120);
});

test("the generator holds the 7-iron and matches Caddy's stock ladder at 155", () => {
  const bag = generateBag(155);
  const byClub = Object.fromEntries(bag.map((row) => [row.club, row.baseCarry]));
  assert.deepEqual(byClub, {
    Driver: 230, "3W": 205, "4H": 180, "4i": 178, "5i": 170, "6i": 160, "7i": 155,
    "8i": 142, "9i": 130, PW: 115, GW: 98, SW: 82, LW: 66,
  });
  const slow = generateBag(120);
  assert.equal(slow.find((row) => row.club === "7i")?.baseCarry, 120);
  for (let i = 1; i < slow.length; i++) assert.ok(slow[i - 1].totalM >= slow[i].totalM);
});

test("filling the gaps never changes a club the player set", () => {
  const result = generateRest([{ club: "7i", baseCarry: 140, totalM: 0 }, { club: "Driver", baseCarry: 250, totalM: 0 }]);
  assert.equal(result.error, undefined);
  assert.equal(result.clubs.find((row) => row.club === "Driver")?.baseCarry, 250);
  assert.equal(result.clubs.find((row) => row.club === "7i")?.baseCarry, 140);
  assert.equal(result.added, 11);
  assert.equal(generateRest([{ club: "PW", baseCarry: 100, totalM: 0 }]).error, "sevenIronFirst");
});

test("edits refuse blanks and duplicates, and keep the order", () => {
  const bag = normaliseBag([{ club: "7i", baseCarry: 150 }]);
  assert.equal(addClub(bag, "", 100).error, "needsName");
  assert.equal(addClub(bag, "8i", "").error, "needsCarry");
  assert.equal(addClub(bag, "7I", 140).error, "duplicate");
  const added = addClub(bag, "Driver", 230).clubs;
  assert.deepEqual(added.map((row) => row.club), ["Driver", "7i"]);
  assert.equal(updateClub(added, "7i", { club: "driver" }).error, "duplicate");
  const renamed = updateClub(added, "7i", { club: "6i", carry: 160 }).clubs;
  assert.deepEqual(renamed.map((row) => [row.club, row.baseCarry]), [["Driver", 230], ["6i", 160]]);
  assert.deepEqual(removeClub(renamed, "DRIVER").map((row) => row.club), ["6i"]);
});

test("a fingerprint ignores totals and order, not carries", () => {
  const a = [{ club: "7i", baseCarry: 150, totalM: 160 }, { club: "PW", baseCarry: 110, totalM: 115 }];
  const b = [{ club: "pw", baseCarry: 110, totalM: 120 }, { club: "7I", baseCarry: 150, totalM: 170 }];
  assert.equal(bagFingerprint(a), bagFingerprint(b));
  assert.notEqual(bagFingerprint(a), bagFingerprint([{ club: "7i", baseCarry: 151 }, { club: "PW", baseCarry: 110 }]));
});

const base = normaliseBag([{ club: "7i", baseCarry: 150 }]);
const edited = normaliseBag([{ club: "7i", baseCarry: 155 }]);
const other = normaliseBag([{ club: "7i", baseCarry: 160 }]);
const early = "2026-11-01T00:00:00Z";
const late = "2026-11-02T00:00:00Z";

test("sync: whichever side changed since the last agreed bag wins", () => {
  const lastSynced = bagFingerprint(base);
  assert.equal(decideBagSync({ booking: base, bookingUpdatedAt: late, caddy: base, caddyUpdatedAt: early, lastSynced }), "in_sync");
  assert.equal(decideBagSync({ booking: base, bookingUpdatedAt: late, caddy: edited, caddyUpdatedAt: early, lastSynced }), "take_caddy");
  assert.equal(decideBagSync({ booking: edited, bookingUpdatedAt: early, caddy: base, caddyUpdatedAt: late, lastSynced }), "send_to_caddy");
  // A bag cleared on one side is an edit like any other.
  assert.equal(decideBagSync({ booking: base, bookingUpdatedAt: late, caddy: [], caddyUpdatedAt: early, lastSynced }), "take_caddy");
});

test("sync: both changed, or never synced, goes to the newer edit -- but never to an empty bag", () => {
  const lastSynced = bagFingerprint(base);
  assert.equal(decideBagSync({ booking: edited, bookingUpdatedAt: early, caddy: other, caddyUpdatedAt: late, lastSynced }), "take_caddy");
  assert.equal(decideBagSync({ booking: edited, bookingUpdatedAt: late, caddy: other, caddyUpdatedAt: early, lastSynced }), "send_to_caddy");
  assert.equal(decideBagSync({ booking: [], bookingUpdatedAt: late, caddy: other, caddyUpdatedAt: early, lastSynced: null }), "take_caddy");
  assert.equal(decideBagSync({ booking: edited, bookingUpdatedAt: early, caddy: [], caddyUpdatedAt: late, lastSynced: null }), "send_to_caddy");
});
