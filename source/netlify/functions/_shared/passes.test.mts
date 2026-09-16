/**
 * The Pass engine's rules, written as the mistakes they exist to prevent.
 *
 * The interesting ones are not "does it insert a row". They are the decisions
 * that are cheap to get wrong and expensive to discover: spending newer credits
 * while older ones expire, folding a top-up into a pass whose coverage has
 * since changed, and reading somebody else's passes because the account filter
 * was applied in JavaScript rather than in the SQL.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { setDatabaseForTests } from "./database.mts";
import {
  cleanCredits,
  grantPass,
  isCompatiblePass,
  normaliseGrant,
  allocationUnitValueCents,
  planCrossRedemption,
  planTenderRefund,
  passOptionsForService,
  passTemplatesFromServices,
  readPassesForPerson,
  resolveInboxPassValue,
  reservePassCredit,
  reserveCrossRedemption,
  reverseRedemptionsForBooking,
  reversePassRedemption,
  spendOrder,
  sweepReturnableCredits,
} from "./passes.mts";

type Issued = { text: string; values: unknown[] };

function fakeDatabase(rows: (text: string, values: unknown[]) => unknown[] = () => []) {
  const issued: Issued[] = [];
  const record = (text: string, values: unknown[]) => {
    const normalised = text.replace(/\s+/g, " ").trim();
    issued.push({ text: normalised, values });
    return rows(normalised, values);
  };
  setDatabaseForTests({
    async sql(strings: TemplateStringsArray, ...values: unknown[]) {
      let text = "";
      strings.forEach((part, index) => {
        text += part;
        if (index < values.length) text += `$${index + 1}`;
      });
      return record(text, values);
    },
    pool: {
      async query(text: string, values: unknown[] = []) {
        return { rows: record(text, values) };
      },
      async connect() {
        return {
          async query(text: string, values: unknown[] = []) {
            return { rows: record(text, values) };
          },
          release() {},
        };
      },
    },
  });
  return issued;
}

const ACCOUNT = "clarity-test-account";
const ACTOR = { accountId: ACCOUNT, actorId: "coach@example.test" };

const FIVE_LESSON_PACKAGE = {
  id: "package-5",
  name: "5 Lesson Package",
  lessonFormat: "package",
  packageAllowance: 5,
  packageCoversServiceId: "lesson-60",
};

// --- The existing package model is already a pass template -----------------

test("a package service is read as a pass template, coverage widened to a list", () => {
  const templates = passTemplatesFromServices([
    FIVE_LESSON_PACKAGE,
    { id: "lesson-60", name: "60 Minute Lesson", lessonFormat: "private" },
    { id: "review-1", name: "Swing Review", lessonFormat: "video-review" },
  ]);

  assert.deepEqual(templates, [
    {
      serviceId: "package-5",
      name: "5 Lesson Package",
      credits: 5,
      coversServiceIds: ["lesson-60"],
      crossRedeemable: false,
      priceCents: null,
    },
  ]);
});

test("a legacy package is still recognised by its id prefix", () => {
  // booking-core.mts:722 keeps this fallback for services saved before
  // lessonFormat existed. A pass template that stopped being recognised would
  // silently drop out of the grant form.
  const templates = passTemplatesFromServices([{ id: "package-old", name: "Old Package" }]);
  assert.equal(templates.length, 1);
  assert.equal(templates[0].credits, 5, "falls back to the same default as the editor");
});

test("credits are clamped to the range the package editor already enforces", () => {
  assert.equal(cleanCredits(5), 5);
  assert.equal(cleanCredits(0, 3), 1, "zero is not a pass");
  assert.equal(cleanCredits(9999), 100);
  assert.equal(cleanCredits("not a number", 4), 4);
  assert.equal(cleanCredits(2.6), 3);
});

// --- Grants -----------------------------------------------------------------

test("a grant from a template inherits its name, allowance and coverage", () => {
  const grant = normaliseGrant(
    { personId: "person-1", templateServiceId: "package-5" },
    passTemplatesFromServices([FIVE_LESSON_PACKAGE]),
  );
  assert.equal(grant.name, "5 Lesson Package");
  assert.equal(grant.credits, 5);
  assert.deepEqual(grant.coversServiceIds, ["lesson-60"]);
  assert.ok(grant.expiresAt, "defaults to an expiry rather than an unbounded liability");
});

test("a paid grant snapshots exact value, currency and cross-redemption policy", () => {
  const [template] = passTemplatesFromServices([
    { ...FIVE_LESSON_PACKAGE, price: 599.99, crossRedeemable: true },
  ]);
  const grant = normaliseGrant(
    {
      personId: "person-1",
      templateServiceId: template.serviceId,
      totalValueCents: 59_999,
      currency: "nzd",
    },
    [template],
  );
  assert.equal(grant.totalValueCents, 59_999);
  assert.equal(grant.currency, "NZD");
  assert.equal(grant.crossRedeemable, true);
  assert.equal(grant.entitlementServiceId, "lesson-60");
  assert.equal(grant.merge, false, "paid lots stay distinct internally");
});

test("a grant with no reliable acquisition value stays native-only", () => {
  const [template] = passTemplatesFromServices([
    { ...FIVE_LESSON_PACKAGE, price: 599.99, crossRedeemable: true },
  ]);
  const grant = normaliseGrant(
    { personId: "person-1", templateServiceId: template.serviceId },
    [template],
  );
  assert.equal(grant.totalValueCents, null);
  assert.equal(grant.crossRedeemable, false);
});

test("a free-form grant still has to say what it is and what it is worth", () => {
  assert.throws(() => normaliseGrant({ personId: "person-1", credits: 2 }, []), /name/i);
  assert.throws(() => normaliseGrant({ personId: "person-1", name: "Goodwill" }, []), /credits/i);
  assert.throws(() => normaliseGrant({ name: "Goodwill", credits: 1 }, []), /belong/i);
});

test("expiryMonths 0 means never, and a missing one means twelve months", () => {
  const never = normaliseGrant({ personId: "p", name: "Comp", credits: 1, expiryMonths: 0 }, []);
  assert.equal(never.expiresAt, null);

  const defaulted = normaliseGrant({ personId: "p", name: "Comp", credits: 1 }, []);
  const months =
    (new Date(defaulted.expiresAt as string).getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 30);
  assert.ok(months > 11 && months < 13, `expected about 12 months, got ${months}`);
});

test("a grant naming a template that has been deleted is refused, not silently freed", () => {
  assert.throws(
    () => normaliseGrant({ personId: "p", templateServiceId: "package-gone" }, []),
    /no longer exists/i,
  );
});

// --- Topping up rather than stacking cards ---------------------------------

test("a second purchase tops up the pass already held", () => {
  const pass = { templateServiceId: "package-5", coversServiceIds: ["lesson-60"] };
  assert.equal(isCompatiblePass(pass, pass), true);
});

test("coverage that has drifted since issue makes a pass incompatible", () => {
  // The template was edited to cover 45-minute lessons too. Folding new credits
  // into the old pass would re-scope credits the player already holds, which is
  // the exact thing the coverage snapshot exists to prevent.
  const held = { templateServiceId: "package-5", coversServiceIds: ["lesson-60"] };
  const widened = { templateServiceId: "package-5", coversServiceIds: ["lesson-60", "lesson-45"] };
  assert.equal(isCompatiblePass(held, widened), false);
});

test("a free-form pass never merges, because there is no template to match on", () => {
  const held = { templateServiceId: null, coversServiceIds: [] };
  assert.equal(isCompatiblePass(held, held), false);
});

// --- Spend order ------------------------------------------------------------

test("credits that expire first are spent first, and never-expiring credits last", () => {
  const ordered = spendOrder([
    { id: "never", expiresAt: null, availableFrom: "2026-01-01" },
    { id: "december", expiresAt: "2026-12-01", availableFrom: "2026-06-01" },
    { id: "october", expiresAt: "2026-10-01", availableFrom: "2026-09-01" },
  ]);
  assert.deepEqual(
    ordered.map((entry) => entry.id),
    ["october", "december", "never"],
  );
});

test("allocations expiring together are spent oldest first", () => {
  const ordered = spendOrder([
    { id: "newer", expiresAt: "2026-10-01", availableFrom: "2026-09-10" },
    { id: "older", expiresAt: "2026-10-01", availableFrom: "2026-09-01" },
  ]);
  assert.deepEqual(
    ordered.map((entry) => entry.id),
    ["older", "newer"],
  );
});

test("non-divisible acquisition value is exact and deterministic", () => {
  assert.deepEqual(
    [1, 2, 3].map((ordinal) => allocationUnitValueCents(100, 3, ordinal)),
    [34, 33, 33],
  );
});

test("basic cross redemption preserves whole entitlements and creates residual value", () => {
  const plan = planCrossRedemption(6_000, 0, [
    {
      allocationId: "lot-a",
      passId: "pass-a",
      unitsAllocated: 5,
      unitsRedeemed: 0,
      unitsAvailable: 5,
      totalValueCents: 50_000,
      expiresAt: null,
      availableFrom: "2026-01-01",
    },
  ]);
  assert.equal(plan?.entitlements.length, 1);
  assert.equal(plan?.residualCents, 4_000);
});

test("existing residual is spent before the minimum number of whole entitlements", () => {
  const plan = planCrossRedemption(6_000, 4_000, [
    {
      allocationId: "lot-a",
      passId: "pass-a",
      unitsAllocated: 4,
      unitsRedeemed: 0,
      unitsAvailable: 4,
      totalValueCents: 40_000,
      expiresAt: null,
      availableFrom: "2026-01-01",
    },
  ]);
  assert.equal(plan?.flexibleUsedCents, 4_000);
  assert.equal(plan?.entitlements.length, 1);
  assert.equal(plan?.residualCents, 8_000);
});

test("a service fully covered by flexible value creates no duplicate change", () => {
  const plan = planCrossRedemption(6_000, 10_000, []);
  assert.deepEqual(plan, {
    flexibleUsedCents: 6_000,
    entitlements: [],
    residualCents: 0,
  });
});

test("different-value lots remain distinct and spend earliest expiry first", () => {
  const plan = planCrossRedemption(15_000, 0, [
    {
      allocationId: "ninety-dollar-lot",
      passId: "pass-b",
      unitsAllocated: 10,
      unitsRedeemed: 0,
      unitsAvailable: 10,
      totalValueCents: 90_000,
      expiresAt: "2027-01-01",
      availableFrom: "2026-02-01",
    },
    {
      allocationId: "hundred-dollar-lot",
      passId: "pass-a",
      unitsAllocated: 2,
      unitsRedeemed: 0,
      unitsAvailable: 2,
      totalValueCents: 20_000,
      expiresAt: "2026-12-01",
      availableFrom: "2026-01-01",
    },
  ]);
  assert.deepEqual(plan?.entitlements.map((entry) => entry.allocationId), [
    "hundred-dollar-lot",
    "hundred-dollar-lot",
  ]);
  assert.equal(plan?.residualCents, 5_000);
});

test("cross redemption refuses an insufficient value instead of going negative", () => {
  assert.equal(
    planCrossRedemption(20_000, 500, [
      {
        allocationId: "lot-a",
        passId: "pass-a",
        unitsAllocated: 1,
        unitsRedeemed: 0,
        unitsAvailable: 1,
        totalValueCents: 10_000,
        expiresAt: null,
        availableFrom: "2026-01-01",
      },
    ]),
    null,
  );
});

test("a mixed-tender full refund restores credit and card to their original amounts", () => {
  assert.deepEqual(
    planTenderRefund([
      { kind: "clarity_credit", amountCents: 6_500 },
      { kind: "card", amountCents: 83_500 },
    ]),
    [
      { kind: "clarity_credit", amountCents: 6_500 },
      { kind: "card", amountCents: 83_500 },
    ],
  );
});

test("partial mixed-tender refunds are proportional and exact to the cent", () => {
  const refund = planTenderRefund(
    [
      { kind: "clarity_credit", amountCents: 6_500 },
      { kind: "card", amountCents: 83_500 },
    ],
    10_001,
  );
  assert.equal(refund.reduce((sum, tender) => sum + tender.amountCents, 0), 10_001);
});

// --- The account boundary ---------------------------------------------------

test("reading a person's passes filters by account in the SQL, not afterwards", async (t) => {
  const issued = fakeDatabase(() => []);
  t.after(() => setDatabaseForTests(null));

  await readPassesForPerson(ACCOUNT, "person-1");

  // The sweep, then the read. The read itself stays a single statement: the
  // allocations and redemptions come back aggregated beside their pass rather
  // than as a follow-up query per ledger table.
  const reads = issued.filter((entry) => entry.text.includes("FROM public.pass_balances"));
  assert.equal(reads.length, 1, "one round trip, not one per ledger table");
  const [query] = reads;
  assert.match(query.text, /FROM public\.pass_balances/);
  assert.match(query.text, /b\.account_id = \$\d/, "the account filter is in the statement");
  assert.ok(query.values.includes(ACCOUNT));
  assert.ok(query.values.includes("person-1"));
});

test("a read with no person does not fall through to every pass in the account", async (t) => {
  const issued = fakeDatabase(() => []);
  t.after(() => setDatabaseForTests(null));

  assert.deepEqual(await readPassesForPerson(ACCOUNT, ""), []);
  assert.equal(issued.length, 0, "no query at all, rather than an unfiltered one");
});

// --- Writing ----------------------------------------------------------------

test("issuing a pass writes the pass and its first allocation in one transaction", async (t) => {
  const issued = fakeDatabase(() => []);
  t.after(() => setDatabaseForTests(null));

  await grantPass(
    { personId: "person-1", templateServiceId: "package-5" },
    passTemplatesFromServices([FIVE_LESSON_PACKAGE]),
    ACTOR,
  );

  const statements = issued.map((entry) => entry.text);
  assert.ok(statements.some((text) => text === "BEGIN"));
  assert.ok(statements.some((text) => text === "COMMIT"));

  const insertPass = issued.find((entry) => entry.text.includes("INSERT INTO public.passes"));
  assert.ok(insertPass, "a pass row is written");
  assert.ok(insertPass.values.includes(ACCOUNT), "stamped with the account");
  assert.match(insertPass.text, /'one_off'/, "manual grants are never recurring");

  const insertAllocation = issued.find((entry) =>
    entry.text.includes("INSERT INTO public.pass_allocations"),
  );
  assert.ok(insertAllocation, "credits arrive as an allocation");
  assert.ok(insertAllocation.values.includes(5), "five credits, from the template allowance");

  assert.equal(
    statements.filter((text) => text.includes("UPDATE public.passes")).length,
    0,
    "nothing updates a stored balance, because there is not one",
  );
});

test("a top-up appends an allocation and does not write a second pass", async (t) => {
  // The person already holds the same pass, so the grant should fold into it.
  const existing = {
    pass_id: "pass-1",
    person_id: "person-1",
    name: "5 Lesson Package",
    template_service_id: "package-5",
    covers_service_ids: ["lesson-60"],
    credits_available: 2,
    credits_allocated_all_time: 5,
    credits_redeemed_all_time: 3,
    effective_status: "active",
    expires_at: "2027-08-18T00:00:00.000Z",
    issued_at: "2026-08-18T00:00:00.000Z",
    source: "manual",
    allocations: [],
    redemptions: [],
  };
  const issued = fakeDatabase((text) =>
    text.includes("FROM public.pass_balances") ? [existing] : [],
  );
  t.after(() => setDatabaseForTests(null));

  const result = await grantPass(
    { personId: "person-1", templateServiceId: "package-5" },
    passTemplatesFromServices([FIVE_LESSON_PACKAGE]),
    ACTOR,
  );

  assert.equal(result.merged, true);
  assert.equal(
    issued.filter((entry) => entry.text.includes("INSERT INTO public.passes")).length,
    0,
    "no second card for the same entitlement",
  );

  const allocation = issued.find((entry) => entry.text.includes("INSERT INTO public.pass_allocations"));
  assert.ok(allocation);
  assert.ok(
    allocation.values.includes("2027-08-18T00:00:00.000Z"),
    "a top-up inherits the pass's expiry rather than restarting the clock",
  );
});

test("merge:false issues a separate pass even when a compatible one exists", async (t) => {
  const issued = fakeDatabase((text) =>
    text.includes("FROM public.pass_balances")
      ? [
          {
            pass_id: "pass-1",
            person_id: "person-1",
            template_service_id: "package-5",
            covers_service_ids: ["lesson-60"],
            effective_status: "active",
            allocations: [],
            redemptions: [],
          },
        ]
      : [],
  );
  t.after(() => setDatabaseForTests(null));

  const result = await grantPass(
    { personId: "person-1", templateServiceId: "package-5", merge: false },
    passTemplatesFromServices([FIVE_LESSON_PACKAGE]),
    ACTOR,
  );

  assert.equal(result.merged, false);
  assert.equal(
    issued.filter((entry) => entry.text.includes("INSERT INTO public.passes")).length,
    1,
  );
});

test("a grant rolls back rather than leaving a pass with no credits", async (t) => {
  const issued = fakeDatabase((text) => {
    if (text.includes("INSERT INTO public.pass_allocations")) throw new Error("allocation failed");
    return [];
  });
  t.after(() => setDatabaseForTests(null));

  await assert.rejects(
    grantPass(
      { personId: "person-1", templateServiceId: "package-5" },
      passTemplatesFromServices([FIVE_LESSON_PACKAGE]),
      ACTOR,
    ),
    /allocation failed/,
  );
  assert.ok(
    issued.some((entry) => entry.text === "ROLLBACK"),
    "a pass that could not be funded is not left behind",
  );
});

// --- Spending: what the checkout is allowed to offer ------------------------

function pass(overrides: Record<string, unknown> = {}) {
  return {
    id: "pass-1",
    personId: "person-1",
    name: "5 Lesson Package",
    templateServiceId: "package-5",
    coversServiceIds: ["lesson-60"],
    creditsAvailable: 3,
    creditsAllocated: 5,
    creditsRedeemed: 2,
    nextExpiry: null,
    expiresAt: null,
    status: "active",
    source: "manual",
    note: "",
    issuedAt: "2026-09-01T00:00:00.000Z",
    allocations: [],
    redemptions: [],
    ...overrides,
  } as Parameters<typeof passOptionsForService>[0][number];
}

test("a pass that covers the service and has credits can pay", () => {
  const [option] = passOptionsForService([pass()], "lesson-60", "60 Minute Lesson");
  assert.equal(option.covered, true);
  assert.equal(option.creditsAvailable, 3);
});

test("a pass for something else is offered but refused, with the reason on it", () => {
  // Shown rather than hidden: "why isn't his pass showing up" is a support
  // question you otherwise ask yourself with nothing on screen to answer it.
  const [option] = passOptionsForService([pass()], "lesson-45", "45 Minute Lesson");
  assert.equal(option.covered, false);
  assert.equal(option.reason, "Covers something else");
});

test("a pass with coverage but no credits left cannot pay", () => {
  const [option] = passOptionsForService([pass({ creditsAvailable: 0, status: "exhausted" })], "lesson-60");
  assert.equal(option.covered, false);
  assert.equal(option.reason, "No credits left");
});

test("a pass covering nothing covers nothing, rather than everything", () => {
  // The dangerous reading of an empty list is "unrestricted", which would let a
  // swing-review credit pay for a 60-minute lesson.
  const [option] = passOptionsForService([pass({ coversServiceIds: [] })], "lesson-60");
  assert.equal(option.covered, false);
  assert.equal(option.reason, "No covered service set");
});

test("void and expired passes are not offered at all", () => {
  const options = passOptionsForService(
    [pass({ id: "a", status: "void" }), pass({ id: "b", status: "expired" })],
    "lesson-60",
  );
  assert.deepEqual(options, []);
});

// --- Spending: taking the credit -------------------------------------------

const RESERVE = { accountId: ACCOUNT, passId: "pass-1", bookingId: "booking-1", actorId: "coach@example.test" };

const CROSS_RESERVE = {
  ...RESERVE,
  serviceId: "review-1",
  serviceValueCents: 6_000,
  currency: "NZD",
  acceptsCrossRedemption: true,
};

test("a pass cannot settle anything that is not a booking", async (t) => {
  const issued = fakeDatabase(() => []);
  t.after(() => setDatabaseForTests(null));
  await assert.rejects(reservePassCredit({ ...RESERVE, bookingId: "" }), /booking/i);
  assert.equal(issued.length, 0, "refused before touching the database");
});

test("taking a credit locks the pass and lets the database pick the allocation", async (t) => {
  const issued = fakeDatabase((text) => {
    if (text.includes("FOR UPDATE")) return [{ id: "pass-1" }];
    if (text.includes("INSERT INTO public.pass_redemptions")) return [{ id: "red-1", allocation_id: "alloc-aug" }];
    return [];
  });
  t.after(() => setDatabaseForTests(null));

  const reserved = await reservePassCredit(RESERVE);
  assert.deepEqual(reserved, { redemptionId: "red-1", allocationId: "alloc-aug" });

  const lock = issued.find((entry) => entry.text.includes("FOR UPDATE"));
  assert.ok(lock, "the pass row is locked first -- two tills must not both read '1 left'");
  assert.ok(lock.values.includes(ACCOUNT));

  const insert = issued.find((entry) => entry.text.includes("INSERT INTO public.pass_redemptions"));
  assert.ok(insert);
  assert.match(
    insert.text,
    /ORDER BY a\.expires_at NULLS LAST, a\.available_from/,
    "oldest-expiring credit first, so fresh credits are not spent while old ones expire",
  );
  assert.match(insert.text, /a\.is_live/, "expired allocations cannot pay");
  assert.match(insert.text, /p\.status = 'active'/, "a voided pass cannot pay");
  assert.ok(issued.some((entry) => entry.text === "COMMIT"));
});

test("no spendable credit is a refusal, not a redemption of nothing", async (t) => {
  const issued = fakeDatabase((text) => (text.includes("FOR UPDATE") ? [{ id: "pass-1" }] : []));
  t.after(() => setDatabaseForTests(null));

  await assert.rejects(reservePassCredit(RESERVE), (error: { status?: number; code?: string }) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, "no_credits");
    return true;
  });
  assert.ok(issued.some((entry) => entry.text === "ROLLBACK"));
});

test("a booking already settled on a pass cannot take a second credit", async (t) => {
  // The partial unique index firing. Two coaches on two devices settling the
  // same lesson is the case; the second one gets told, rather than the pass
  // quietly going down by two.
  fakeDatabase((text) => {
    if (text.includes("FOR UPDATE")) return [{ id: "pass-1" }];
    if (text.includes("INSERT INTO public.pass_redemptions")) {
      throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
    }
    return [];
  });
  t.after(() => setDatabaseForTests(null));

  await assert.rejects(reservePassCredit(RESERVE), (error: { status?: number; code?: string }) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, "already_redeemed");
    return true;
  });
});

test("cross redemption locks person currency and records one transaction for all movements", async (t) => {
  const issued = fakeDatabase((text) => {
    if (text.includes("SELECT id, person_id, cross_redeemable")) {
      return [{ id: "pass-1", person_id: "person-1", cross_redeemable: true }];
    }
    if (text.includes("FROM public.pass_balances b")) return [];
    if (text.includes("SUM(amount_cents)")) return [{ value_cents: 0 }];
    if (text.includes("FROM public.pass_allocation_balances a")) {
      return [{
        allocation_id: "alloc-1",
        pass_id: "pass-1",
        credits_allocated: 5,
        credits_redeemed: 0,
        credits_available: 5,
        total_value_cents: 50_000,
        expires_at: null,
        available_from: "2026-01-01",
      }];
    }
    return [];
  });
  t.after(() => setDatabaseForTests(null));

  const result = await reserveCrossRedemption(CROSS_RESERVE);
  assert.equal(result.redemptionIds.length, 1);
  assert.equal(result.residualCents, 4_000);
  assert.ok(issued.some((entry) => entry.text.includes("pg_advisory_xact_lock")));
  assert.ok(issued.some((entry) => entry.text.includes("ORDER BY id FOR UPDATE")));
  assert.ok(issued.some((entry) => entry.text.includes("INSERT INTO public.pass_value_transactions")));
  assert.ok(issued.some((entry) => entry.text.includes("'residual_created'")));
  assert.ok(issued.some((entry) => entry.text === "COMMIT"));
});

test("a service that refuses exchange is rejected before any value is touched", async (t) => {
  const issued = fakeDatabase(() => []);
  t.after(() => setDatabaseForTests(null));
  await assert.rejects(
    reserveCrossRedemption({ ...CROSS_RESERVE, acceptsCrossRedemption: false }),
    (error: { code?: string }) => error.code === "cross_redemption_disabled",
  );
  assert.equal(issued.length, 0);
});

test("native entitlement availability blocks cross redemption", async (t) => {
  const issued = fakeDatabase((text) => {
    if (text.includes("SELECT id, person_id, cross_redeemable")) {
      return [{ id: "pass-1", person_id: "person-1", cross_redeemable: true }];
    }
    if (text.includes("FROM public.pass_balances b")) return [{ pass_id: "native-pass" }];
    return [];
  });
  t.after(() => setDatabaseForTests(null));
  await assert.rejects(
    reserveCrossRedemption(CROSS_RESERVE),
    (error: { code?: string }) => error.code === "native_entitlement_available",
  );
  assert.ok(issued.some((entry) => entry.text === "ROLLBACK"));
  assert.ok(!issued.some((entry) => entry.text.includes("INSERT INTO public.pass_redemptions")));
});

test("a reversal never deletes the line it reverses", async (t) => {
  const issued = fakeDatabase(() => [{ id: "red-1" }]);
  t.after(() => setDatabaseForTests(null));

  assert.equal(await reversePassRedemption(ACCOUNT, "red-1", "Lesson cancelled", "coach@example.test"), true);
  const [update] = issued;
  assert.match(update.text, /UPDATE public\.pass_redemptions/);
  assert.match(update.text, /reversed_at = NOW\(\)/);
  assert.match(update.text, /reversed_at IS NULL/, "reversing twice must not overwrite the first reason");
  assert.ok(!issued.some((entry) => /DELETE/i.test(entry.text)));
});

// --- Giving credits back ----------------------------------------------------

test("the sweep returns credits whose booking is gone, cancelled, or no longer a lesson", async (t) => {
  const issued = fakeDatabase((text) =>
    text.startsWith("UPDATE public.pass_redemptions") ? [{ id: "red-1" }] : [],
  );
  t.after(() => setDatabaseForTests(null));

  assert.equal(await sweepReturnableCredits(ACCOUNT), 1);
  const sweep = issued.find((entry) => entry.text.startsWith("UPDATE public.pass_redemptions"));
  assert.ok(sweep);
  assert.match(sweep.text, /UPDATE public\.pass_redemptions/);
  assert.match(sweep.text, /c\.id IS NULL/, "deleted booking");
  assert.match(sweep.text, /c\.status = 'cancelled'/, "cancelled lesson");
  assert.match(sweep.text, /c\.kind <> 'appointment'/, "a cancelled group session becomes a block");
  assert.match(sweep.text, /r\.reversed_at IS NULL/, "an already-reversed line is left alone");
  assert.ok(sweep.values.includes(ACCOUNT), "scoped to one account, in the SQL");
});

test("a no-show keeps the credit spent", async (t) => {
  const issued = fakeDatabase(() => []);
  t.after(() => setDatabaseForTests(null));

  await sweepReturnableCredits(ACCOUNT);
  assert.ok(
    !issued[0].text.includes("no_show"),
    "charging for a no-show is standard; returning the credit quietly costs the coach money",
  );
});

test("a completed lesson keeps the credit spent", async (t) => {
  const issued = fakeDatabase(() => []);
  t.after(() => setDatabaseForTests(null));

  await sweepReturnableCredits(ACCOUNT);
  assert.ok(!issued[0].text.includes("'completed'"), "a delivered lesson was paid for");
});

test("reading a balance sweeps first, so a cancelled lesson's credit is never shown as spent", async (t) => {
  const issued = fakeDatabase(() => []);
  t.after(() => setDatabaseForTests(null));

  await readPassesForPerson(ACCOUNT, "person-1");

  assert.equal(issued.length, 3, "value sweep, native sweep, then the read");
  assert.match(issued[1].text, /UPDATE public\.pass_redemptions/, "sweep runs before the read");
  assert.match(issued[2].text, /FROM public\.pass_balances/);
});

test("deleting a booking returns its credit in the caller's own transaction", async (t) => {
  // Given the open client, not a fresh one: a delete that commits while the
  // reversal fails strands a credit against a booking that no longer exists.
  const calls: { text: string; values: unknown[] }[] = [];
  const client = {
    async query(text: string, values: unknown[] = []) {
      calls.push({ text: text.replace(/\s+/g, " ").trim(), values });
      return {
        rows: text.includes("UPDATE public.pass_redemptions") ? [{ id: "red-1" }] : [],
      };
    },
  };
  t.after(() => setDatabaseForTests(null));

  const returned = await reverseRedemptionsForBooking(client, ACCOUNT, "booking-1", "Booking deleted", "coach");
  assert.equal(returned, 1);
  assert.equal(calls.length, 2);
  assert.match(calls[1].text, /reversed_at = NOW\(\)/);
  assert.match(calls[1].text, /reversed_at IS NULL/, "a credit already returned is not returned twice");
  assert.ok(calls[1].values.includes(ACCOUNT) && calls[1].values.includes("booking-1"));
});

test("a booking that never used a pass is not a special case", async (t) => {
  const client = { async query() { return { rows: [] }; } };
  t.after(() => setDatabaseForTests(null));
  assert.equal(await reverseRedemptionsForBooking(client, ACCOUNT, "booking-9", "Booking deleted"), 0);
});

test("a reversal with no booking id touches nothing at all", async (t) => {
  let called = false;
  const client = { async query() { called = true; return { rows: [] }; } };
  t.after(() => setDatabaseForTests(null));
  assert.equal(await reverseRedemptionsForBooking(client, ACCOUNT, "", "Booking deleted"), 0);
  assert.equal(called, false, "an empty id must never become an unfiltered update");
});

// --- What an externally-sold pass is worth ---------------------------------

test("a sale that charged something is worth what it charged", () => {
  assert.deepEqual(
    resolveInboxPassValue({
      purchaseCents: 65_000,
      purchaseCurrency: "nzd",
      templatePriceCents: 65_000,
      accountCurrency: "NZD",
    }),
    { cents: 65_000, currency: "NZD" },
  );
});

test("a sale that came through at zero falls back to the package's price", () => {
  // The real one: Optix had the package at 0.00 with no currency, which paired
  // a number with nothing and refused the issue outright.
  assert.deepEqual(
    resolveInboxPassValue({
      purchaseCents: 0,
      purchaseCurrency: "",
      templatePriceCents: 65_000,
      accountCurrency: "NZD",
    }),
    { cents: 65_000, currency: "NZD" },
  );
});

test("buying two of a package at zero is worth two of its price", () => {
  const value = resolveInboxPassValue({
    purchaseCents: 0,
    templatePriceCents: 65_000,
    quantity: 2,
    accountCurrency: "NZD",
  });
  assert.equal(value?.cents, 130_000);
});

test("what the coach typed beats both", () => {
  // A comped or discounted pass is a real thing, and the catalogue price would
  // misstate it.
  const value = resolveInboxPassValue({
    typed: 30_000,
    purchaseCents: 65_000,
    purchaseCurrency: "NZD",
    templatePriceCents: 65_000,
    accountCurrency: "NZD",
  });
  assert.equal(value?.cents, 30_000);
});

test("a coach who really means free types zero, and it is kept", () => {
  const value = resolveInboxPassValue({
    typed: 0,
    purchaseCents: 0,
    templatePriceCents: 65_000,
    accountCurrency: "NZD",
  });
  assert.equal(value?.cents, 0, "an explicit zero is a decision, unlike the sale's");
});

test("an untouched field sends nothing and lets the fallback stand", () => {
  const value = resolveInboxPassValue({
    typed: "",
    purchaseCents: 0,
    templatePriceCents: 65_000,
    accountCurrency: "NZD",
  });
  assert.equal(value?.cents, 65_000);
});

test("the sale's own currency wins when the sale charged something", () => {
  const value = resolveInboxPassValue({
    purchaseCents: 5_000,
    purchaseCurrency: "AUD",
    templatePriceCents: 65_000,
    accountCurrency: "NZD",
  });
  assert.equal(value?.currency, "AUD");
});

test("a price taken from this account's catalogue is in this account's currency", () => {
  // The sale said nothing, so its blank currency must not be inherited by a
  // number that came from somewhere else entirely.
  const value = resolveInboxPassValue({
    purchaseCents: 0,
    purchaseCurrency: "AUD",
    templatePriceCents: 65_000,
    accountCurrency: "NZD",
  });
  assert.deepEqual(value, { cents: 65_000, currency: "NZD" });
});

test("no price anywhere issues the pass without one rather than refusing it", () => {
  assert.equal(
    resolveInboxPassValue({ purchaseCents: 0, templatePriceCents: null, accountCurrency: "NZD" }),
    undefined,
  );
});

test("a price with no currency to put it in is not half-sent", () => {
  // Sending one half is exactly what produced "needs both an exact amount and a
  // three-letter currency", so the two can only ever leave here together.
  assert.equal(
    resolveInboxPassValue({ purchaseCents: 0, templatePriceCents: 65_000, accountCurrency: "" }),
    undefined,
  );
});
