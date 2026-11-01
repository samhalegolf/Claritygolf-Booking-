import assert from "node:assert/strict";
import test from "node:test";

import { COUPON_ALPHABET, generateCouponCode, normaliseCouponCode } from "./coupon-codes.mts";
import {
  canHoldCredit,
  isVoucherExpired,
  voucherHoldsItem,
  voucherRedemption,
  voucherSaleLines,
  voucherSpendable,
  type RedeemableVoucher,
} from "./voucher-redemption.mts";

const LESSON = "lesson:svc-1";

function voucher(partial: Partial<RedeemableVoucher> = {}): RedeemableVoucher {
  return { status: "active", remainingValue: 100, originalValue: 100, expiresAt: null, coversItemId: "", ...partial };
}

test("generated codes avoid characters that get misread, and compare without punctuation or case", () => {
  assert.equal(/[01IOL]/.test(COUPON_ALPHABET), false);
  assert.match(generateCouponCode(), /^CG-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(normaliseCouponCode(" cg-ab12-cd34 "), "CGAB12CD34");
  assert.equal(normaliseCouponCode(undefined), "");
});

test("expiry is exclusive of the moment it expires", () => {
  const now = new Date("2026-08-16T00:00:00Z");
  assert.equal(isVoucherExpired(voucher({ expiresAt: null }), now), false);
  assert.equal(isVoucherExpired(voucher({ expiresAt: "2026-08-17T00:00:00Z" }), now), false);
  assert.equal(isVoucherExpired(voucher({ expiresAt: "2026-08-16T00:00:00Z" }), now), true);
  // Garbage in the column must not lock someone out of money they paid for.
  assert.equal(isVoucherExpired(voucher({ expiresAt: "not a date" }), now), false);
});

test("spendable: active, something left, not expired", () => {
  assert.equal(voucherSpendable(voucher()), true);
  assert.equal(voucherSpendable(voucher({ status: "void" })), false);
  assert.equal(voucherSpendable(voucher({ remainingValue: 0 })), false);
  assert.equal(voucherSpendable(voucher({ expiresAt: "2020-01-01T00:00:00Z" })), false);
});

test("an amount voucher is capped by its balance, by the sale and by the request", () => {
  const lines = [{ productId: "glove", unitPrice: 40 }];
  // A $100 voucher against a $40 sale spends $40 and keeps $60 - no change.
  assert.deepEqual(voucherRedemption(voucher(), lines, 40), { pays: 40, takes: 40, credit: 0, coversItem: false });
  assert.equal(voucherRedemption(voucher({ remainingValue: 25 }), lines, 40).pays, 25);
  assert.equal(voucherRedemption(voucher(), lines, 40, { requested: 10 }).pays, 10);
  assert.equal(voucherRedemption(voucher(), lines, 40, { requested: 999 }).pays, 40);
  assert.equal(voucherRedemption(voucher(), lines, 0).pays, 0);
  // Nothing spendable means nothing applied, whatever was asked for.
  assert.equal(voucherRedemption(voucher({ status: "void" }), lines, 40).pays, 0);
  // A negative request cannot become a top-up.
  assert.equal(voucherRedemption(voucher(), lines, 40, { requested: -20 }).pays, 0);
});

test("a lesson voucher pays for its lesson when the price has gone up, and is used up", () => {
  const result = voucherRedemption(voucher({ coversItemId: LESSON }), [{ productId: LESSON, unitPrice: 120 }], 120);
  assert.deepEqual(result, { pays: 120, takes: 100, credit: 0, coversItem: true });
});

test("a price drop sends the surplus to the client's credit, or leaves it on the voucher with no client", () => {
  const lines = [{ productId: LESSON, unitPrice: 90 }];
  assert.deepEqual(voucherRedemption(voucher({ coversItemId: LESSON }), lines, 90, { hasClient: true }), {
    pays: 90,
    takes: 100,
    credit: 10,
    coversItem: true,
  });
  assert.deepEqual(voucherRedemption(voucher({ coversItemId: LESSON }), lines, 90), { pays: 90, takes: 90, credit: 0, coversItem: true });
});

test("a lesson voucher pays for one lesson, alongside whatever else is bought", () => {
  const lines = [
    { productId: "glove", unitPrice: 30 },
    { productId: LESSON, unitPrice: 110 },
  ];
  assert.deepEqual(voucherRedemption(voucher({ coversItemId: LESSON }), lines, 140, { hasClient: true }), {
    pays: 110,
    takes: 100,
    credit: 0,
    coversItem: true,
  });
});

test("without its lesson on the sale, or once part-spent, a lesson voucher is money", () => {
  const glove = [{ productId: "glove", unitPrice: 60 }];
  assert.deepEqual(voucherRedemption(voucher({ coversItemId: LESSON }), glove, 60), { pays: 60, takes: 60, credit: 0, coversItem: false });
  const partSpent = voucher({ coversItemId: LESSON, remainingValue: 40 });
  assert.equal(voucherHoldsItem(partSpent), false);
  assert.deepEqual(voucherRedemption(partSpent, [{ productId: LESSON, unitPrice: 120 }], 120), { pays: 40, takes: 40, credit: 0, coversItem: false });
});

test("an expired lesson voucher pays for nothing", () => {
  const expired = voucher({ coversItemId: LESSON, expiresAt: "2020-01-01T00:00:00Z" });
  assert.equal(voucherRedemption(expired, [{ productId: LESSON, unitPrice: 100 }], 100).pays, 0);
});

test("a lesson settled at the till counts as a line of the sale, at what the sale charges beyond the basket", () => {
  const lines = voucherSaleLines([{ productId: "glove", unitPrice: 30, quantity: 1 }], { serviceId: "svc-1", saleTotal: 150 });
  assert.deepEqual(lines, [
    { productId: "glove", unitPrice: 30 },
    { productId: LESSON, unitPrice: 120 },
  ]);
  // Already in the basket: not added twice. No lesson: nothing added.
  assert.equal(voucherSaleLines([{ productId: LESSON, unitPrice: 120 }], { serviceId: "svc-1", saleTotal: 120 }).length, 1);
  assert.equal(voucherSaleLines([], { serviceId: "", saleTotal: 50 }).length, 0);
});

test("only a saved client can hold account credit", () => {
  assert.equal(canHoldCredit("person-1"), true);
  assert.equal(canHoldCredit("appointment-42"), false);
  assert.equal(canHoldCredit(""), false);
  assert.equal(canHoldCredit(null), false);
});
