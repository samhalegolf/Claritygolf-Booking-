/**
 * Matching an invoice line to a pass.
 *
 * This matcher exists to be generous -- it is evidence for a coach to read,
 * not a decision anything acts on -- so most of what is worth testing is that
 * it stays generous in the cases real wording produces, and stops dead in the
 * one case where being generous makes the screen lie: two products that differ
 * only by a number.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { bestPassForLine, invoiceMatchStrength } from "./pass-invoice-match.mts";

test("the same words, written twice, match exactly", () => {
  assert.equal(invoiceMatchStrength("30 Minute Golf Lesson Package", "30 Minute Golf Lesson Package"), "exact");
  assert.equal(invoiceMatchStrength("30-minute golf lesson package.", "30 Minute Golf Lesson Package"), "exact");
});

test("plurals and filler words are not a difference", () => {
  assert.equal(invoiceMatchStrength("5 x Golf Lessons", "5 Golf Lesson"), "exact");
});

test("an invoice line with a prefix still finds its pass", () => {
  // What a real invoice line looks like: somebody typed a little more than the
  // catalogue name, or the sync prepended where it came from.
  assert.equal(invoiceMatchStrength("Sept coaching: 30 Minute Golf Lesson Package", "30 Minute Golf Lesson Package"), "close");
  assert.equal(invoiceMatchStrength("30 Minute Golf Lesson Package (paid in advance)", "30 Minute Golf Lesson Package"), "close");
});

test("a differently-worded name for the same thing still turns up", () => {
  // The whole reason for a loose tier. A coach reconciling wants this on
  // screen with a caveat, not filtered out for being imperfect.
  assert.equal(invoiceMatchStrength("Golf coaching block", "Golf Coaching Block Booking"), "close");
  assert.notEqual(invoiceMatchStrength("Junior golf lesson", "Junior Golf Coaching Lesson Pack"), null);
});

test("a 30 and a 60 never match, however well the words agree", () => {
  // The failure this exists to prevent. Every word but one is shared, so any
  // similarity score alone calls these the same product -- and a coach reading
  // six 60-minute lessons under a 30-minute pass has been told something false
  // by the screen that was supposed to help them check.
  assert.equal(invoiceMatchStrength("60 Minute Golf Lesson Package", "30 Minute Golf Lesson Package"), null);
  assert.equal(invoiceMatchStrength("10 Lesson Block", "5 Lesson Block"), null);
});

test("a number on one side only is not a disagreement", () => {
  // "Lesson Pack" and "5 Lesson Pack" are the same product named two ways.
  // Refusing here would throw away the commonest match there is.
  assert.equal(invoiceMatchStrength("5 Lesson Pack", "Lesson Pack"), "close");
});

test("two unrelated products do not match", () => {
  assert.equal(invoiceMatchStrength("Range balls", "30 Minute Golf Lesson Package"), null);
  assert.equal(invoiceMatchStrength("Card payment", "30 Minute Golf Lesson Package"), null);
  assert.equal(invoiceMatchStrength("Titleist Pro V1 dozen", "Junior Coaching Block"), null);
});

test("a blank on either side is not a match", () => {
  assert.equal(invoiceMatchStrength("", "30 Minute Golf Lesson Package"), null);
  assert.equal(invoiceMatchStrength("30 Minute Golf Lesson Package", ""), null);
});

test("one line is filed under its best pass, not every pass it resembles", () => {
  // Without this, a line lands under both packages and the count of lessons
  // billed against each becomes meaningless -- which is the one number a coach
  // opens this screen to read.
  const passes = [
    { id: "p60", name: "60 Minute Golf Lesson Package" },
    { id: "p30", name: "30 Minute Golf Lesson Package" },
  ];
  assert.equal(bestPassForLine("30 Minute Golf Lesson Package", passes)?.pass.id, "p30");
  assert.equal(bestPassForLine("Autumn block: 60 Minute Golf Lesson Package", passes)?.pass.id, "p60");
  assert.equal(bestPassForLine("Range balls", passes), null);
});

test("an exact match beats a merely close one", () => {
  const passes = [
    { id: "long", name: "Golf Lesson Package Premium" },
    { id: "plain", name: "Golf Lesson Package" },
  ];
  assert.equal(bestPassForLine("Golf Lesson Package", passes)?.strength, "exact");
  assert.equal(bestPassForLine("Golf Lesson Package", passes)?.pass.id, "plain");
});
