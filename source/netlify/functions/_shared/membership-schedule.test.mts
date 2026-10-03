import assert from "node:assert/strict";
import test from "node:test";

import {
  addMonths,
  creditsForPeriod,
  firstCharge,
  memberMayCancel,
  monthlyValueCents,
  nextCharge,
  nextRetryAt,
  normalisePlan,
  periodAmountCents,
  periodFrom,
  planSnapshot,
  planStep,
  type PlanSnapshot,
  type StepInput,
} from "./membership-schedule.mts";

const at = (iso: string) => new Date(iso);

function plan(overrides: Record<string, unknown> = {}): PlanSnapshot {
  return planSnapshot(
    normalisePlan(
      {
        name: "Gold",
        priceCents: 9900,
        interval: "month",
        entitlements: [{ serviceIds: ["lesson-30"], credits: 2 }],
        ...overrides,
      },
      { id: "plan-1", currency: "NZD" },
    ),
  );
}

test("monthly billing keeps the day a member joined, even through February", () => {
  const joined = at("2026-01-31T10:14:00Z");
  const feb = addMonths(joined, 1, 31);
  const mar = addMonths(feb, 1, 31);
  assert.equal(feb.toISOString(), "2026-02-28T10:14:00.000Z");
  assert.equal(mar.toISOString(), "2026-03-31T10:14:00.000Z");
});

test("a year is twelve months, and a leap day lands on the 28th", () => {
  const joined = at("2028-02-29T00:00:00Z");
  const p = periodFrom(joined, plan({ interval: "year" }), 29);
  assert.equal(p.end.toISOString(), "2029-02-28T00:00:00.000Z");
});

test("weekly periods are exact", () => {
  const p = periodFrom(at("2026-10-01T09:00:00Z"), plan({ interval: "week", intervalCount: 2 }), 1);
  assert.equal(p.end.toISOString(), "2026-10-15T09:00:00.000Z");
});

test("a first charge with no trial is the price plus the joining fee", () => {
  const charge = firstCharge(plan({ signupFeeCents: 2500 }), at("2026-10-03T08:00:00Z"));
  assert.equal(charge.cycleNumber, 1);
  assert.equal(charge.amountCents, 12400);
  assert.equal(charge.signupFeeCents, 2500);
  assert.equal(charge.period.end.toISOString(), "2026-11-03T08:00:00.000Z");
});

test("a trial is cycle 0, costs only the joining fee, and is followed by cycle 1", () => {
  const p = plan({ trialDays: 14, signupFeeCents: 1000 });
  const trial = firstCharge(p, at("2026-10-01T00:00:00Z"));
  assert.equal(trial.cycleNumber, 0);
  assert.equal(trial.amountCents, 1000);
  assert.equal(trial.period.end.toISOString(), "2026-10-15T00:00:00.000Z");
  const next = nextCharge(p, 0, trial.period.end, 1);
  assert.equal(next.cycleNumber, 1);
  assert.equal(next.amountCents, 9900);
  assert.equal(next.signupFeeCents, 0);
});

test("anchored billing runs a short, pro-rated first period up to the billing day", () => {
  const p = plan({ anchor: "day_of_month", anchorDay: 1, priceCents: 3000 });
  const first = firstCharge(p, at("2026-09-16T00:00:00Z"));
  assert.equal(first.period.end.toISOString(), "2026-10-01T00:00:00.000Z");
  // 15 of September's 30 days.
  assert.equal(first.amountCents, 1500);
  const second = nextCharge(p, 1, first.period.end, 1);
  assert.equal(second.period.end.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(second.amountCents, 3000);
});

test("a plan that does not prorate charges a short period in full", () => {
  const p = plan({ anchor: "day_of_month", anchorDay: 1, prorateFirst: false });
  const first = firstCharge(p, at("2026-09-16T00:00:00Z"));
  assert.equal(first.amountCents, 9900);
});

test("a part-period is never charged more than a whole one", () => {
  const p = plan();
  const period = { start: at("2026-01-01"), end: at("2026-03-01"), fullLengthMs: 1 };
  assert.equal(periodAmountCents(p, period), 9900);
});

test("anchoring only applies to monthly plans", () => {
  const p = plan({ interval: "week", anchor: "day_of_month", anchorDay: 5 });
  assert.equal(p.anchor, "signup");
  assert.equal(p.anchorDay, null);
});

test("failed cards are retried after 1, 3 and 5 days, then given up on", () => {
  const failed = at("2026-10-01T00:00:00Z");
  assert.equal(nextRetryAt(1, failed)?.toISOString(), "2026-10-02T00:00:00.000Z");
  assert.equal(nextRetryAt(2, failed)?.toISOString(), "2026-10-04T00:00:00.000Z");
  assert.equal(nextRetryAt(3, failed)?.toISOString(), "2026-10-06T00:00:00.000Z");
  assert.equal(nextRetryAt(4, failed), null);
});

function step(overrides: Partial<StepInput> = {}): StepInput {
  return {
    status: "active",
    collection: "card",
    currentPeriodEnd: at("2026-11-01T00:00:00Z"),
    cyclesRaised: 1,
    cancelAtPeriodEnd: false,
    termCycles: null,
    hasCard: true,
    openCardCharge: null,
    ...overrides,
  };
}

test("the job waits until the period ends, then raises the next one", () => {
  assert.deepEqual(planStep(step(), at("2026-10-20T00:00:00Z")), {
    kind: "wait",
    until: at("2026-11-01T00:00:00Z"),
  });
  assert.deepEqual(planStep(step(), at("2026-11-01T00:00:00Z")), { kind: "raise" });
});

test("a cancellation or a finished term ends the membership instead of billing it", () => {
  const now = at("2026-11-02T00:00:00Z");
  assert.deepEqual(planStep(step({ cancelAtPeriodEnd: true }), now), { kind: "finish", reason: "cancelled" });
  assert.deepEqual(planStep(step({ termCycles: 1 }), now), { kind: "finish", reason: "term_complete" });
  assert.deepEqual(planStep(step({ termCycles: 2 }), now), { kind: "raise" });
});

test("an unpaid card charge is retried before anything new is raised", () => {
  const now = at("2026-12-05T00:00:00Z");
  const due = step({
    status: "past_due",
    openCardCharge: { status: "failed", nextRetryAt: at("2026-12-04T00:00:00Z") },
  });
  assert.deepEqual(planStep(due, now), { kind: "retry" });
  const later = step({
    status: "past_due",
    openCardCharge: { status: "failed", nextRetryAt: at("2026-12-09T00:00:00Z") },
  });
  assert.deepEqual(planStep(later, now), { kind: "wait", until: at("2026-12-09T00:00:00Z") });
  const noCard = step({ status: "past_due", hasCard: false, openCardCharge: { status: "failed", nextRetryAt: null } });
  assert.deepEqual(planStep(noCard, now), { kind: "wait", until: null });
});

test("paused, cancelled and unfinished memberships are never billed", () => {
  const now = at("2027-01-01T00:00:00Z");
  for (const status of ["paused", "cancelled", "ended", "incomplete"] as const) {
    assert.deepEqual(planStep(step({ status }), now), { kind: "wait", until: null });
  }
});

test("a capped rollover tops up only to the cap", () => {
  const ent = { id: "a", name: "", serviceIds: ["x"], credits: 4, rollover: "rollover_capped" as const, maxBalance: 6 };
  assert.equal(creditsForPeriod(ent, 0), 4);
  assert.equal(creditsForPeriod(ent, 5), 1);
  assert.equal(creditsForPeriod(ent, 9), 0);
  assert.equal(creditsForPeriod({ ...ent, rollover: "rollover" }, 9), 4);
});

test("the minimum commitment counts paid periods", () => {
  assert.equal(memberMayCancel(3, 2), false);
  assert.equal(memberMayCancel(3, 3), true);
  assert.equal(memberMayCancel(0, 0), true);
});

test("plans refuse what cannot be billed or spent", () => {
  const known = new Set(["lesson-30"]);
  assert.throws(() => normalisePlan({ priceCents: 100 }, { id: "p", currency: "NZD" }), /name/);
  assert.throws(
    () => normalisePlan({ name: "x", entitlements: [{ serviceIds: ["gone"], credits: 1 }] }, { id: "p", currency: "NZD" }, known),
    /no longer exists/,
  );
  assert.throws(
    () => normalisePlan({ name: "x", entitlements: [{ serviceIds: [], credits: 1 }] }, { id: "p", currency: "NZD" }),
    /at least one lesson type/,
  );
  assert.throws(
    () => normalisePlan({ name: "x", priceCents: -1 }, { id: "p", currency: "NZD" }),
    /zero or more/,
  );
  assert.throws(
    () => normalisePlan({ name: "x", termCycles: 3, minCycles: 6 }, { id: "p", currency: "NZD" }),
    /minimum commitment/,
  );
});

test("entitlement ids stay unique so each maps to its own pass", () => {
  const p = plan({
    entitlements: [
      { id: "a", serviceIds: ["x"], credits: 1 },
      { id: "a", serviceIds: ["y"], credits: 1 },
    ],
  });
  assert.deepEqual(p.entitlements.map((e) => e.id), ["a", "ax"]);
});

test("monthly value normalises every interval", () => {
  assert.equal(monthlyValueCents({ priceCents: 1200, interval: "year", intervalCount: 1 }), 100);
  assert.equal(monthlyValueCents({ priceCents: 1200, interval: "week", intervalCount: 1 }), 5200);
  assert.equal(monthlyValueCents({ priceCents: 3000, interval: "month", intervalCount: 3 }), 1000);
});
