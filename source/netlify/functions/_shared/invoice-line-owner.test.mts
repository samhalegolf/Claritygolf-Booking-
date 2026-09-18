/**
 * Whose lesson a line on a bulk invoice is.
 *
 * The case that made this necessary: one invoice for a club, fifteen lines,
 * one of them a client's own lesson. Every line matched her pass on the words
 * "1 Hour Golf Lesson" and her pass read "invoiced for 17 sessions" against
 * three actually billed. So the tests that matter are the ones where the
 * wording of two clients on one invoice is almost the same.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { descriptionNamesPerson, unlinkedLineBelongsToPerson } from "./invoice-line-owner.mts";

test("a line names the person it is about", () => {
  assert.equal(descriptionNamesPerson("1 Hour Golf Lesson - Cindi Yu (5)", "Cindi Yu"), true);
  assert.equal(descriptionNamesPerson("1 Hour Golf Lesson - Sam Wu", "Cindi Yu"), false);
});

test("a shared first name is not a match", () => {
  // Both of these were on the same invoice. A first name alone files each of
  // them under the other.
  assert.equal(descriptionNamesPerson("1 Hour Golf Lesson - Josh Bowe", "Josh little"), false);
  assert.equal(descriptionNamesPerson("1 Hour Golf Lesson - Josh little", "Josh little"), true);
});

test("case, punctuation and whatever else the line says are set aside", () => {
  assert.equal(descriptionNamesPerson("Lesson block: YU, CINDI - Aug", "Cindi Yu"), true);
  assert.equal(descriptionNamesPerson("1 Hour Golf Lesson - Mr Sam Wu", "Sam Wu"), true);
});

test("a nickname the invoice does not use is a miss", () => {
  // Fallible on purpose, and in the safe direction: it hides a line rather
  // than counting somebody else's against this client's credits.
  assert.equal(descriptionNamesPerson("1 Hour Golf Lesson - Cindy", "Cindi Yu"), false);
});

test("nothing to compare against never matches", () => {
  assert.equal(descriptionNamesPerson("1 Hour Golf Lesson - Cindi Yu", ""), false);
  assert.equal(descriptionNamesPerson("", "Cindi Yu"), false);
});

test("on their own invoice, every line stands", () => {
  // Their client id is on it, or their email address is. Nothing on it needs
  // to say their name again.
  assert.equal(unlinkedLineBelongsToPerson("billed", "Range balls", "Cindi Yu"), true);
  assert.equal(unlinkedLineBelongsToPerson("matched", "Bay hire", "Cindi Yu"), true);
});

test("on somebody else's invoice, a line has to name them", () => {
  assert.equal(
    unlinkedLineBelongsToPerson("included", "1 Hour Golf Lesson - Cindi Yu (5)", "Cindi Yu"),
    true,
  );
  assert.equal(
    unlinkedLineBelongsToPerson("included", "1 Hour Golf Lesson - Sam Wu", "Cindi Yu"),
    false,
  );
  assert.equal(unlinkedLineBelongsToPerson("included", "Range balls", "Cindi Yu"), false);
});

test("a client with no name on record loses nothing", () => {
  assert.equal(unlinkedLineBelongsToPerson("included", "1 Hour Golf Lesson - Sam Wu", ""), true);
});
