/**
 * What a till counts as money.
 *
 * Three kinds of value cross a counter and only one of them is takings. Every
 * test here is a way of accidentally counting the same money twice -- which is
 * the failure that matters, because it does not look like a bug. It looks like
 * a good week.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { summarisePosTakings } from "../billing-api.mts";

const card = (over = {}) => ({
  paymentMethodName: "Eftpos",
  paymentMethodKind: "custom",
  amount: 30,
  couponAmount: 0,
  listedAmount: null,
  ...over,
});

const onPass = (over = {}) =>
  card({ paymentMethodName: "Pass", paymentMethodKind: "pass", amount: 0, listedAmount: 30, ...over });

test("a lesson on a pass adds nothing to the takings", () => {
  // The $90 for the package was banked when it sold. Counting the lesson as
  // well is how a $90 week reads as $180.
  const summary = summarisePosTakings([onPass(), onPass(), onPass()]);
  assert.equal(summary.paidTotal, 0);
  assert.equal(summary.passCount, 3);
  assert.equal(summary.passValue, 90);
});

test("the Pass row exists, is counted, and holds no money", () => {
  const summary = summarisePosTakings([onPass(), card()]);
  const pass = summary.byMethod.find((entry) => entry.kind === "pass");
  assert.ok(pass, "a pass sale still needs a row -- it happened");
  assert.equal(pass?.total, 0, "nothing was tendered on it");
  assert.equal(pass?.count, 1);
  assert.equal(summary.paidTotal, 30, "only the card sale is money");
});

test("the pass row is found by kind, not by the name a coach can edit", () => {
  const summary = summarisePosTakings([onPass({ paymentMethodName: "Passes" })]);
  assert.equal(summary.byMethod[0].kind, "pass");
  assert.equal(summary.passValue, 30, "renaming the method must not empty the report");
});

test("a voucher is netted off the method that took the rest", () => {
  // $100 sale, $60 on a voucher, $40 on the card. The drawer holds $40.
  const summary = summarisePosTakings([
    card({ paymentMethodName: "Eftpos", amount: 100, couponAmount: 60 }),
  ]);
  assert.equal(summary.byMethod.find((entry) => entry.paymentMethodName === "Eftpos")?.total, 40);
  assert.equal(summary.couponTotal, 60);
  assert.equal(summary.paidTotal, 100, "the headline is what went out the door");
});

test("coupons get their own row and pass value does not", () => {
  // Deliberately different treatments. A voucher is money that arrived
  // earlier, so it belongs in the method breakdown. A pass credit is not money
  // in either direction, so it stays out of it entirely.
  const summary = summarisePosTakings([card({ amount: 100, couponAmount: 60 }), onPass()]);
  assert.ok(summary.byMethod.some((entry) => entry.paymentMethodName === "Coupons redeemed"));
  assert.equal(
    summary.byMethod.reduce((sum, entry) => sum + entry.total, 0),
    100,
    "the rows add up to the money, with no pass value smuggled in",
  );
});

test("a pass sale with no listed amount is counted but valued at nothing", () => {
  // Better than guessing a price: the count is still true, and an imputed
  // value nobody recorded is a number that cannot be checked against anything.
  const summary = summarisePosTakings([onPass({ listedAmount: null })]);
  assert.equal(summary.passCount, 1);
  assert.equal(summary.passValue, 0);
});

test("two sales on the same method land in one row", () => {
  const summary = summarisePosTakings([card(), card()]);
  assert.equal(summary.byMethod.length, 1);
  assert.equal(summary.byMethod[0].count, 2);
  assert.equal(summary.byMethod[0].total, 60);
});

test("an empty till is zeroes, not an empty object", () => {
  const summary = summarisePosTakings([]);
  assert.deepEqual(summary, {
    couponTotal: 0,
    passCount: 0,
    passValue: 0,
    byMethod: [],
    paidTotal: 0,
  });
});

test("money rows sort above the pass row", () => {
  const summary = summarisePosTakings([onPass(), card({ amount: 30 })]);
  assert.equal(summary.byMethod[0].kind, "custom");
  assert.equal(summary.byMethod[1].kind, "pass");
});
