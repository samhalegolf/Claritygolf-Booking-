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
  passTemplatesFromServices,
  readPassesForPerson,
  spendOrder,
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

// --- The account boundary ---------------------------------------------------

test("reading a person's passes filters by account in the SQL, not afterwards", async (t) => {
  const issued = fakeDatabase(() => []);
  t.after(() => setDatabaseForTests(null));

  await readPassesForPerson(ACCOUNT, "person-1");

  assert.equal(issued.length, 1, "one round trip, not one per ledger table");
  const [query] = issued;
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
