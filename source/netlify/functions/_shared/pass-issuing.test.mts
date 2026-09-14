/**
 * A package someone paid for turns into credits they hold.
 *
 * The failure this guards against is quiet: a coach rings up a five-lesson
 * package, the money lands, and nothing appears under the customer's name. The
 * two ways that happens are both pinned here -- the line not being recognised
 * as a package at all, and the same purchase issuing twice when a webhook is
 * redelivered or Mark paid is pressed again.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { setDatabaseForTests } from "./database.mts";
import { issuePassesForPurchase, passLinesFromPosItems } from "../billing-api.mts";

const ACCOUNT = "clarity-test-account";

const SERVICES = [
  { id: "package-5", name: "5 Lesson Package", lessonFormat: "package", packageAllowance: 5, packageCoversServiceId: "lesson-60" },
  { id: "lesson-60", name: "60 Minute Lesson", lessonFormat: "private", price: 30 },
  { id: "glove", name: "Glove" },
];

/** Enough PostgREST to answer the one read this path makes: servicesJson. */
function stubSupabase(services: unknown = SERVICES) {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-key";
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/settings")) {
      return new Response(JSON.stringify([{ value: JSON.stringify(services) }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** Records the writes grantPass issues, and can be told to reject one. */
function fakeDatabase(onInsert: (text: string, values: unknown[]) => void = () => {}) {
  const issued: { text: string; values: unknown[] }[] = [];
  const record = (text: string, values: unknown[]) => {
    const normalised = text.replace(/\s+/g, " ").trim();
    issued.push({ text: normalised, values });
    onInsert(normalised, values);
    return [];
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

// --- Recognising a package on a docket --------------------------------------

test("a POS line names its service through the lesson: prefix", () => {
  const lines = passLinesFromPosItems("txn-1", [
    { productId: "lesson:package-5", quantity: 1 },
    { productId: "glove-product-id", quantity: 2 },
  ]);
  assert.deepEqual(lines, [
    { serviceId: "package-5", quantity: 1, ref: "pos:txn-1:lesson:package-5" },
  ]);
});

test("two different packages on one docket get one reference each", () => {
  // Keyed on the sale alone, the second would collide with the first and the
  // customer would end up with one of the two packages they paid for.
  const lines = passLinesFromPosItems("txn-1", [
    { productId: "lesson:package-5", quantity: 1 },
    { productId: "lesson:package-10", quantity: 1 },
  ]);
  assert.equal(new Set(lines.map((line) => line.ref)).size, 2);
});

// --- Issuing ----------------------------------------------------------------

test("a paid package issues a pass for its allowance", async (t) => {
  const restore = stubSupabase();
  const issued = fakeDatabase();
  t.after(() => {
    restore();
    setDatabaseForTests(null);
  });

  const names = await issuePassesForPurchase(
    ACCOUNT,
    [{ serviceId: "package-5", quantity: 1, ref: "pos:txn-1:lesson:package-5" }],
    { personId: "person-1", name: "Sam" },
    "clarity_pos",
    "Sold on POS-0001",
  );

  assert.deepEqual(names, ["5 Lesson Package"]);
  const insert = issued.find((entry) => entry.text.includes("INSERT INTO public.pass_allocations"));
  assert.ok(insert, "credits arrive as an allocation");
  assert.ok(insert.values.includes(5), "the template's allowance");
  assert.ok(insert.values.includes("clarity_pos"), "traceable to the till");
  assert.ok(
    insert.values.includes("pos:txn-1:lesson:package-5"),
    "carries the reference that makes a replay a no-op",
  );
});

test("buying two of the same package is twice the credits, not two cards", async (t) => {
  const restore = stubSupabase();
  const issued = fakeDatabase();
  t.after(() => {
    restore();
    setDatabaseForTests(null);
  });

  await issuePassesForPurchase(
    ACCOUNT,
    [{ serviceId: "package-5", quantity: 2, ref: "pos:txn-1:lesson:package-5" }],
    { personId: "person-1", name: "Sam" },
    "clarity_pos",
    "",
  );

  const insert = issued.find((entry) => entry.text.includes("INSERT INTO public.pass_allocations"));
  assert.ok(insert.values.includes(10));
});

test("a lesson is not a package, and neither is a glove", async (t) => {
  const restore = stubSupabase();
  const issued = fakeDatabase();
  t.after(() => {
    restore();
    setDatabaseForTests(null);
  });

  const names = await issuePassesForPurchase(
    ACCOUNT,
    [
      { serviceId: "lesson-60", quantity: 1, ref: "pos:txn-1:lesson:lesson-60" },
      { serviceId: "glove", quantity: 1, ref: "pos:txn-1:glove" },
    ],
    { personId: "person-1", name: "Sam" },
    "clarity_pos",
    "",
  );

  assert.deepEqual(names, []);
  assert.equal(
    issued.filter((entry) => entry.text.includes("INSERT INTO public.pass_allocations")).length,
    0,
  );
});

test("a retried purchase issues nothing the second time", async (t) => {
  // The webhook redelivered, or Mark paid pressed twice. The unique index on
  // (account_id, pass_id, source, source_ref) is what refuses it; this pins that
  // the refusal reads as "already done" rather than surfacing as a failure.
  const restore = stubSupabase();
  fakeDatabase((text) => {
    if (text.includes("INSERT INTO public.pass_allocations")) {
      throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
    }
  });
  t.after(() => {
    restore();
    setDatabaseForTests(null);
  });

  const names = await issuePassesForPurchase(
    ACCOUNT,
    [{ serviceId: "package-5", quantity: 1, ref: "pos:txn-1:lesson:package-5" }],
    { personId: "person-1", name: "Sam" },
    "clarity_pos",
    "",
  );

  assert.deepEqual(names, [], "nothing newly issued, and nothing thrown");
});

test("a package sold to a walk-in is issued unassigned rather than lost", async (t) => {
  const restore = stubSupabase();
  const issued = fakeDatabase();
  t.after(() => {
    restore();
    setDatabaseForTests(null);
  });

  const names = await issuePassesForPurchase(
    ACCOUNT,
    [{ serviceId: "package-5", quantity: 1, ref: "pos:txn-2:lesson:package-5" }],
    { personId: "", name: "" },
    "clarity_pos",
    "",
  );

  assert.deepEqual(names, ["5 Lesson Package"]);
  const insert = issued.find((entry) => entry.text.includes("INSERT INTO public.passes"));
  assert.ok(insert, "the entitlement is recorded even with nobody to attach it to");
});

test("a failed pass write never undoes the purchase", async (t) => {
  // The money is already taken. A sale with no pass is fixable with a manual
  // grant; a refused payment is not.
  const restore = stubSupabase();
  fakeDatabase((text) => {
    if (text.includes("INSERT INTO public.passes")) throw new Error("database is on fire");
  });
  t.after(() => {
    restore();
    setDatabaseForTests(null);
  });

  const names = await issuePassesForPurchase(
    ACCOUNT,
    [{ serviceId: "package-5", quantity: 1, ref: "pos:txn-3:lesson:package-5" }],
    { personId: "person-1", name: "Sam" },
    "clarity_pos",
    "",
  );
  assert.deepEqual(names, []);
});

test("a package retired from the catalogue still issues what was paid for", async (t) => {
  // lessonTypeItems filters out inactive services; this path deliberately does
  // not, because a sale of a package that has since been withdrawn is still a
  // sale someone made.
  const restore = stubSupabase([{ ...SERVICES[0], active: false }]);
  const issued = fakeDatabase();
  t.after(() => {
    restore();
    setDatabaseForTests(null);
  });

  const names = await issuePassesForPurchase(
    ACCOUNT,
    [{ serviceId: "package-5", quantity: 1, ref: "pos:txn-4:lesson:package-5" }],
    { personId: "person-1", name: "Sam" },
    "clarity_pos",
    "",
  );
  assert.deepEqual(names, ["5 Lesson Package"]);
  assert.ok(issued.some((entry) => entry.text.includes("INSERT INTO public.pass_allocations")));
});
