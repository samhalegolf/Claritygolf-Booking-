/**
 * The Pass Inbox's two refusals.
 *
 * Both halves of the inbox exist because a payload cannot answer a question,
 * and the whole value of the screen is that it does not answer it either. So
 * the tests that matter are the ones where something plausible is on offer and
 * the right move is still to say "no answer, ask a human":
 *
 *   * a product name that nearly matches two packages
 *   * a pass that already belongs to somebody
 *
 * Getting either wrong is silent. A wrong template issues real spendable
 * credits for the wrong number of lessons; a wrong attach hands an entitlement
 * to the wrong person. Neither throws, and nobody finds out until the counter.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { setDatabaseForTests } from "./database.mts";
import { assignPass, suggestPassTemplate } from "./passes.mts";
import type { PassTemplate } from "./passes.mts";

const template = (serviceId: string, name: string): PassTemplate => ({
  serviceId,
  name,
  credits: 5,
  coversServiceIds: ["lesson-30"],
});

const TEMPLATES = [
  template("pkg-30", "30 Minute Golf Lesson Package"),
  template("pkg-60", "60 Minute Golf Lesson Package"),
];

test("the same product name matches its package", () => {
  const found = suggestPassTemplate("30 Minute Golf Lesson Package", TEMPLATES);
  assert.equal(found.template?.serviceId, "pkg-30");
  assert.equal(found.confidence, "exact");
});

test("case and punctuation are not a difference", () => {
  const found = suggestPassTemplate("30-MINUTE golf lesson package.", TEMPLATES);
  assert.equal(found.template?.serviceId, "pkg-30");
  assert.equal(found.confidence, "exact");
});

test("an external catalogue's prefix still resolves, but says it is only close", () => {
  const found = suggestPassTemplate("Sale: 30 Minute Golf Lesson Package", TEMPLATES);
  assert.equal(found.template?.serviceId, "pkg-30");
  assert.equal(
    found.confidence,
    "close",
    "a coach reading the queue must be able to see which ones were guessed",
  );
});

test("a name that fits two packages resolves to neither", () => {
  // The failure this exists to prevent: "Golf Lesson Package" contains neither
  // duration, and picking one issues the wrong number of credits with no
  // symptom until somebody runs out early.
  const ambiguous = [template("a", "Lesson Package"), template("b", "Lesson Package Plus")];
  const found = suggestPassTemplate("Lesson Package Plus Extra", ambiguous);
  assert.equal(found.template, null);
  assert.equal(found.confidence, "none");
});

test("two packages with the same name resolve to neither", () => {
  const duplicated = [template("a", "Lesson Package"), template("b", "Lesson Package")];
  const found = suggestPassTemplate("Lesson Package", duplicated);
  assert.equal(found.template, null);
  assert.equal(found.confidence, "none");
});

test("a product matching nothing is not forced onto the only package there is", () => {
  const found = suggestPassTemplate("1 x Extra Hour", [template("pkg-30", "30 Minute Lesson Package")]);
  assert.equal(found.template, null);
  assert.equal(found.confidence, "none");
});

test("an empty product name is not a match for an empty template name", () => {
  assert.equal(suggestPassTemplate("", TEMPLATES).confidence, "none");
  assert.equal(suggestPassTemplate("!!!", TEMPLATES).confidence, "none");
  assert.equal(suggestPassTemplate("Anything", [template("x", "")]).confidence, "none");
});

/* --- Attaching ---------------------------------------------------------- */

function fakeDatabase(pass: Record<string, unknown> | null) {
  const issued: string[] = [];
  setDatabaseForTests({
    async sql(strings: TemplateStringsArray, ...values: unknown[]) {
      const text = strings.join("?").replace(/\s+/g, " ").trim();
      issued.push(text);
      if (text.startsWith("SELECT id, person_id")) return pass ? [pass] : [];
      return [];
    },
  } as never);
  return issued;
}

const ACTOR = { accountId: "acct-1", actorId: "coach@example.com" };

test("an unassigned pass can be given an owner", async () => {
  const issued = fakeDatabase({ id: "pass-1", person_id: null, status: "active" });
  await assignPass("pass-1", "person-9", ACTOR);
  assert.ok(
    issued.some((text) => text.includes("UPDATE public.passes") && text.includes("person_id =")),
    "the attach has to actually write",
  );
});

test("the update re-checks that nobody owns it, not just the read", async () => {
  // Two coaches can be looking at the same queue. The read having said
  // "unassigned" a moment ago is not the same as it being unassigned now, so
  // the WHERE carries the condition too.
  const issued = fakeDatabase({ id: "pass-1", person_id: null, status: "active" });
  await assignPass("pass-1", "person-9", ACTOR);
  const update = issued.find((text) => text.includes("UPDATE public.passes"));
  assert.ok(update?.includes("person_id IS NULL"), "the guard belongs in the WHERE, not only in JS");
});

test("a pass that already belongs to somebody is refused, not reassigned", async () => {
  fakeDatabase({ id: "pass-1", person_id: "person-1", status: "active" });
  await assert.rejects(assignPass("pass-1", "person-9", ACTOR), (error: { code?: string }) => {
    assert.equal(error.code, "already_assigned");
    return true;
  });
});

test("a void pass cannot be attached to anyone", async () => {
  fakeDatabase({ id: "pass-1", person_id: null, status: "void" });
  await assert.rejects(assignPass("pass-1", "person-9", ACTOR), (error: { code?: string }) => {
    assert.equal(error.code, "void_pass");
    return true;
  });
});

test("a missing pass is a not-found, not a silent no-op", async () => {
  fakeDatabase(null);
  await assert.rejects(assignPass("pass-1", "person-9", ACTOR), (error: { status?: number }) => {
    assert.equal(error.status, 404);
    return true;
  });
});

test("attaching needs both a pass and a person", async () => {
  fakeDatabase({ id: "pass-1", person_id: null, status: "active" });
  await assert.rejects(assignPass("", "person-9", ACTOR), /which pass/i);
  await assert.rejects(assignPass("pass-1", "", ACTOR), /which person/i);
});

test("no account is a refusal before anything is read", async () => {
  const issued = fakeDatabase({ id: "pass-1", person_id: null, status: "active" });
  await assert.rejects(
    assignPass("pass-1", "person-9", { accountId: "", actorId: "x" }),
    (error: { status?: number }) => {
      assert.equal(error.status, 403);
      return true;
    },
  );
  assert.deepEqual(issued, [], "a request with no account must not reach the database at all");
});

/* --- Reading a Stripe line ------------------------------------------------
 *
 * The inbox now reads every synced Stripe sale, not just the handful an
 * integration pre-classified. Most of those sales are not entitlements, so the
 * classifier's job is mostly to say "not this one" -- and the tests that
 * matter are the ones where saying yes would cost real money.
 */

import { classifyInboxLine, inboxLineType, isDismissedLine } from "./pass-inbox-lines.mts";

test("a gift voucher for a package is a voucher, not a package", () => {
  // The ordering failure this exists to prevent. "5 lesson package" is in
  // there, so a pass-first classifier issues five lessons to whoever bought
  // the gift -- when the entire point is that somebody else redeems it later.
  assert.equal(classifyInboxLine("Gift voucher - 5 lesson package"), "voucher");
  assert.equal(classifyInboxLine("Gift Certificate"), "voucher");
});

test("the wording a real catalogue uses classifies as a pass", () => {
  assert.equal(classifyInboxLine("30 Minute Golf Lesson Package"), "pass");
  assert.equal(classifyInboxLine("10 Lesson Block"), "pass");
  assert.equal(classifyInboxLine("Coaching Pass"), "pass");
});

test("a sale that is just money stays unknown rather than becoming a pass", () => {
  // Each of these is a real line off a synced Stripe invoice. Classifying any
  // of them as a pass issues spendable credits for a coffee.
  for (const line of ["1 x Extra Hour", "Range balls", "Card payment", "Green fee", ""]) {
    assert.equal(classifyInboxLine(line), "unknown", `${line || "(blank)"} must not classify`);
  }
});

test('"Card payment" is not a gift card', () => {
  // The description every Stripe charge without one falls back to. If "card"
  // were a voucher keyword, every unlabelled card sale in the account would be
  // offered as a gift voucher to mint.
  assert.equal(classifyInboxLine("Card payment"), "unknown");
});

test("one product dismissed once stays dismissed however it is punctuated", () => {
  // The whole value of dismissing by product: next month's line is worded
  // slightly differently by whoever rang it up, and it must not come back.
  const dismissed = new Set([inboxLineType("1 x Extra Hour")]);
  assert.equal(isDismissedLine("1 X EXTRA HOUR", dismissed), true);
  assert.equal(isDismissedLine("1x Extra Hour.", dismissed), true);
  assert.equal(isDismissedLine("Extra Hour", dismissed), false, "a different product is not covered");
});

test("a blank description can never be dismissed into hiding everything", () => {
  // inboxLineType("") is "", and an empty dismissal entry matching every
  // blank-described line would silently swallow rows nobody waved away.
  assert.equal(isDismissedLine("", new Set([""])), false);
});
