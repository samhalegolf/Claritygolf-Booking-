/**
 * Naming a Squarespace sale by what it cost.
 *
 * The cases are taken from the account's real history, because that history is
 * the argument for the feature's shape: the gift voucher was $150 until
 * 30 July 2025 and $160 from 6 September 2025, with no overlap, so anything
 * that treats a price as permanent is already wrong.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { matchVoucherRule, parseVoucherRules } from "./voucher-rules.mts";

const RULES = parseVoucherRules([
  { id: "a", amountCents: 16000, currency: "NZD", label: "Lesson Gift Voucher" },
  { id: "b", amountCents: 15000, currency: "NZD", label: "Lesson Gift Voucher" },
  { id: "c", amountCents: 9000, currency: "NZD", label: "30 Minute Gift Voucher" },
]);

test("a price rise is two rules with one label, not a dated range", () => {
  // $150 and $160 are different amounts, so both eras resolve with no dates
  // involved at all. This is why the date fields are the exception here.
  assert.equal(
    matchVoucherRule({ amountCents: 15000, currency: "NZD", when: "2024-03-01" }, RULES)?.label,
    "Lesson Gift Voucher",
  );
  assert.equal(
    matchVoucherRule({ amountCents: 16000, currency: "NZD", when: "2026-09-02" }, RULES)?.label,
    "Lesson Gift Voucher",
  );
});

test("an amount nobody wrote a rule for stays unclaimed", () => {
  assert.equal(matchVoucherRule({ amountCents: 50000, currency: "NZD", when: "2026-01-01" }, RULES), null);
  assert.equal(matchVoucherRule({ amountCents: 500, currency: "NZD", when: "2026-01-01" }, RULES), null);
});

test("the amount charged is what matches, not what is left after a refund", () => {
  // A partly refunded voucher is still a purchase of that product. Matching
  // the net would stop recognising exactly the sales worth a second look.
  assert.equal(
    matchVoucherRule({ amountCents: 16000, currency: "NZD", when: "2026-02-01" }, RULES)?.label,
    "Lesson Gift Voucher",
  );
  assert.equal(matchVoucherRule({ amountCents: 12000, currency: "NZD", when: "2026-02-01" }, RULES), null);
});

test("a rule in another currency does not claim the payment", () => {
  assert.equal(matchVoucherRule({ amountCents: 16000, currency: "AUD", when: "2026-01-01" }, RULES), null);
});

test("a rule with no currency still works on a single-currency account", () => {
  const loose = parseVoucherRules([{ id: "a", amountCents: 16000, label: "Lesson Gift Voucher" }]);
  assert.equal(
    matchVoucherRule({ amountCents: 16000, currency: "NZD", when: "2026-01-01" }, loose)?.label,
    "Lesson Gift Voucher",
  );
});

test("a dated rule only claims payments inside its range", () => {
  // The case dates exist for: one amount meaning different things over time.
  const dated = parseVoucherRules([
    { id: "old", amountCents: 16000, label: "Old Voucher", until: "2025-12-31" },
    { id: "new", amountCents: 16000, label: "New Voucher", from: "2026-01-01" },
  ]);
  assert.equal(matchVoucherRule({ amountCents: 16000, when: "2025-06-01" }, dated)?.label, "Old Voucher");
  assert.equal(matchVoucherRule({ amountCents: 16000, when: "2026-06-01" }, dated)?.label, "New Voucher");
  assert.equal(matchVoucherRule({ amountCents: 16000, when: "2025-12-31" }, dated)?.label, "Old Voucher");
  assert.equal(matchVoucherRule({ amountCents: 16000, when: "2026-01-01" }, dated)?.label, "New Voucher");
});

test("a payment with no date is never pulled into a dated rule", () => {
  // Guessing it into a range is how a 2023 sale gets this year's product name.
  const dated = parseVoucherRules([{ id: "a", amountCents: 16000, label: "Voucher", from: "2026-01-01" }]);
  assert.equal(matchVoucherRule({ amountCents: 16000, when: "" }, dated), null);
  const undated = parseVoucherRules([{ id: "a", amountCents: 16000, label: "Voucher" }]);
  assert.equal(matchVoucherRule({ amountCents: 16000, when: "" }, undated)?.label, "Voucher");
});

test("the first matching rule wins, so the list is the coach's precedence", () => {
  const twins = parseVoucherRules([
    { id: "a", amountCents: 16000, label: "First" },
    { id: "b", amountCents: 16000, label: "Second" },
  ]);
  assert.equal(matchVoucherRule({ amountCents: 16000, when: "2026-01-01" }, twins)?.label, "First");
});

test("a rule that cannot match anything is dropped on read", () => {
  // No label or no amount means it can never name a payment; keeping it would
  // only put a row on screen that does nothing.
  assert.deepEqual(parseVoucherRules([{ amountCents: 16000 }, { label: "No amount" }, { amountCents: 0, label: "Free" }]), []);
  assert.deepEqual(parseVoucherRules(null), []);
  assert.deepEqual(parseVoucherRules("nonsense"), []);
});

test("a nonsense date is dropped rather than read as today", () => {
  const [rule] = parseVoucherRules([{ id: "a", amountCents: 16000, label: "Voucher", from: "not a date" }]);
  assert.equal(rule.from, "", "an unparseable date must not become a live boundary");
  assert.equal(matchVoucherRule({ amountCents: 16000, when: "2023-01-01" }, [rule])?.label, "Voucher");
});
