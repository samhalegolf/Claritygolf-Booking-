/**
 * Rewards: the parts that decide how many credits somebody is owed.
 *
 * Progress is never stored, so these are the rules the sweep recomputes from
 * activity every time -- a wrong answer here pays out on every run.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { milestonesEarned, normaliseProgram, progressTowardsNext, rewardPassRef } from "./rewards.mts";

const NOW = new Date("2026-10-08T00:00:00.000Z");

function program(over: Record<string, unknown> = {}) {
  return normaliseProgram(
    {
      name: "Tenth lesson free",
      trigger: "lessons_completed",
      threshold: 10,
      rewardCredits: 1,
      rewardCoversServiceIds: ["lesson-60"],
      ...over,
    },
    { id: "reward-1", now: NOW },
  );
}

test("a programme counts every lesson unless told otherwise, from the day it starts", () => {
  const value = program();
  assert.equal(value.countsAllServices, true);
  assert.deepEqual(value.countsServiceIds, []);
  assert.equal(value.countsFrom, NOW.toISOString(), "history before the programme does not pay out");
  assert.equal(value.rewardExpiryMonths, null);
  assert.equal(value.maxRewardsPerPerson, null);
});

test("a reward has to be spendable on something", () => {
  assert.throws(() => program({ rewardCoversServiceIds: [] }), /spent on/);
  assert.equal(program({ rewardCoversServiceIds: [], rewardCoversAllServices: true }).rewardCoversAllServices, true);
});

test("counting only some lessons needs at least one of them named", () => {
  assert.throws(() => program({ countsAllServices: false }), /which lessons count/i);
  assert.deepEqual(program({ countsAllServices: false, countsServiceIds: ["lesson-60"] }).countsServiceIds, ["lesson-60"]);
});

test("a spend programme always counts every sale", () => {
  const value = program({ trigger: "amount_spent", threshold: 50_000, countsAllServices: false, countsServiceIds: ["lesson-60"] });
  assert.equal(value.countsAllServices, true);
  assert.deepEqual(value.countsServiceIds, []);
  assert.equal(value.threshold, 50_000);
});

test("services the catalogue does not have are refused", () => {
  assert.throws(
    () =>
      normaliseProgram(
        { name: "x", trigger: "lessons_completed", threshold: 5, rewardCredits: 1, rewardCoversServiceIds: ["gone"] },
        { id: "reward-1" },
        new Set(["lesson-60"]),
      ),
    /no longer exists/,
  );
});

test("one reward per whole threshold, never a partial one", () => {
  const value = program();
  assert.equal(milestonesEarned(0, value), 0);
  assert.equal(milestonesEarned(9, value), 0);
  assert.equal(milestonesEarned(10, value), 1);
  assert.equal(milestonesEarned(29, value), 2);
});

test("the per-person cap holds however much more they do", () => {
  const value = program({ maxRewardsPerPerson: 2 });
  assert.equal(milestonesEarned(100, value), 2);
  assert.deepEqual(progressTowardsNext(100, value), { earned: 2, capped: true, intoCurrent: 10, remaining: 0 });
});

test("progress says how far to the next reward", () => {
  assert.deepEqual(progressTowardsNext(13, program()), { earned: 1, capped: false, intoCurrent: 3, remaining: 7 });
});

test("one reward pass per programme and person", () => {
  assert.equal(rewardPassRef("reward-1", "person-1"), "reward:reward-1:person-1");
});
