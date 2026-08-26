import assert from "node:assert/strict";
import test from "node:test";

import { cleanPracticeBlockType, practiceBlockType } from "../booking-core.mts";

/* Block types are the one part of Practice a coach can edit into any shape
 * they like, so the sanitiser is the only thing standing between a settings
 * form and every brick on every wall. It is deliberately permissive about
 * *content* and strict about *shape*: the id every assigned block points at,
 * and the colour that gets painted into a style attribute.
 */

test("a type id is a slug, whatever was typed", () => {
  assert.equal(practiceBlockType("Pressure Test"), "pressure-test");
  assert.equal(practiceBlockType("  On Course!!  "), "on-course");
  assert.equal(practiceBlockType("Drill"), "drill");
  // Nothing usable left is still a valid type rather than a crash: an
  // unrecognised id renders as itself, greyed, and the block survives.
  assert.equal(practiceBlockType("!!!"), "custom");
  assert.equal(practiceBlockType(""), "custom");
  assert.equal(practiceBlockType(null), "custom");
});

test("ids stay unique inside one save", () => {
  const taken = new Set<string>();
  assert.equal(cleanPracticeBlockType({ label: "Drill" }, taken)?.id, "drill");
  // Two types called the same thing must not collapse into one, or the second
  // would silently inherit every block assigned under the first.
  assert.equal(cleanPracticeBlockType({ label: "Drill" }, taken)?.id, "drill-2");
  assert.equal(cleanPracticeBlockType({ label: "drill" }, taken)?.id, "drill-3");
});

test("an explicit id is kept, so renaming a type never orphans its blocks", () => {
  const type = cleanPracticeBlockType({ id: "drill", label: "Range Work" }, new Set());
  assert.equal(type?.id, "drill");
  assert.equal(type?.label, "Range Work");
});

test("only a real hex colour is accepted", () => {
  const taken = new Set<string>();
  assert.equal(cleanPracticeBlockType({ label: "a", tone: "#2f5d3a" }, taken)?.tone, "#2f5d3a");
  assert.equal(cleanPracticeBlockType({ label: "b", tone: "#abc" }, taken)?.tone, "#abc");
  // The tone is painted straight into a style attribute, so anything that is
  // not plainly a colour is refused rather than sanitised into a guess.
  assert.equal(cleanPracticeBlockType({ label: "c", tone: "red; background:url(x)" }, taken)?.tone, "#57544d");
  assert.equal(cleanPracticeBlockType({ label: "d", tone: "javascript:alert(1)" }, taken)?.tone, "#57544d");
  assert.equal(cleanPracticeBlockType({ label: "e", tone: "" }, taken)?.tone, "#57544d");
});

test("fields default to on, and only an explicit false turns one off", () => {
  const taken = new Set<string>();
  assert.deepEqual(cleanPracticeBlockType({ label: "a" }, taken)?.fields, {
    steps: true,
    dose: true,
    expiry: true,
    video: true,
  });
  assert.deepEqual(cleanPracticeBlockType({ label: "b", fields: { steps: false, video: false } }, taken)?.fields, {
    steps: false,
    dose: true,
    expiry: true,
    video: false,
  });
});

test("a type with no name is dropped, not stored blank", () => {
  const taken = new Set<string>();
  assert.equal(cleanPracticeBlockType({ label: "   " }, taken), null);
  assert.equal(cleanPracticeBlockType({}, taken), null);
  assert.equal(taken.size, 0, "a dropped type must not claim an id");
});

test("retiring is opt-in and explicit", () => {
  const taken = new Set<string>();
  assert.equal(cleanPracticeBlockType({ label: "a" }, taken)?.archived, false);
  assert.equal(cleanPracticeBlockType({ label: "b", archived: "yes" }, taken)?.archived, false);
  assert.equal(cleanPracticeBlockType({ label: "c", archived: true }, taken)?.archived, true);
});
