import { test } from "node:test";
import assert from "node:assert/strict";
import {
  couponApplyAmount,
  couponBlockedReason,
  couponCodesMatch,
  couponSpendable,
  generateCouponCode,
  isCouponExpired,
  normaliseCouponCode,
  remainingAfterCoupon,
} from "./couponMath.ts";
import type { CouponSummary } from "./couponMath.ts";

function coupon(partial: Partial<CouponSummary> = {}): CouponSummary {
  return { status: "active", remainingValue: 100, expiresAt: null, ...partial };
}

test("generated codes avoid characters that get misread", () => {
  // Deterministic: always picks the first letter of the alphabet.
  assert.equal(generateCouponCode(() => 0), "CG-AAAA-AAAA");
  const code = generateCouponCode(() => 0.999999);
  assert.match(code, /^CG-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  // No 0, O, 1, I or L anywhere in the alphabet.
  for (let step = 0; step < 31; step += 1) {
    const sample = generateCouponCode(() => step / 31);
    assert.equal(/[01IOL]/.test(sample.slice(3)), false, sample);
  }
});

test("codes compare with the punctuation and case stripped", () => {
  assert.equal(normaliseCouponCode(" cg-ab12-cd34 "), "CGAB12CD34");
  assert.equal(couponCodesMatch("cg ab12 cd34", "CG-AB12-CD34"), true);
  assert.equal(couponCodesMatch("CG-AB12-CD34", "CG-AB12-CD35"), false);
  // An empty entry must never match an empty stored code.
  assert.equal(couponCodesMatch("", ""), false);
});

test("expiry is exclusive of the moment it expires", () => {
  const now = new Date("2026-08-16T00:00:00Z");
  assert.equal(isCouponExpired(coupon({ expiresAt: null }), now), false);
  assert.equal(isCouponExpired(coupon({ expiresAt: "2026-08-17T00:00:00Z" }), now), false);
  assert.equal(isCouponExpired(coupon({ expiresAt: "2026-08-16T00:00:00Z" }), now), true);
  assert.equal(isCouponExpired(coupon({ expiresAt: "2026-08-15T00:00:00Z" }), now), true);
  // Garbage in the column must not read as expired and lock someone out of
  // money they have paid for.
  assert.equal(isCouponExpired(coupon({ expiresAt: "not a date" }), now), false);
});

test("spendable and the reason it is not", () => {
  assert.equal(couponSpendable(coupon()), true);
  assert.equal(couponSpendable(coupon({ status: "void" })), false);
  assert.equal(couponSpendable(coupon({ remainingValue: 0 })), false);

  assert.equal(couponBlockedReason(coupon()), "");
  assert.equal(couponBlockedReason(coupon({ status: "void" })), "This coupon has been cancelled.");
  assert.equal(couponBlockedReason(coupon({ status: "redeemed" })), "This coupon has already been used up.");
  assert.equal(couponBlockedReason(coupon({ remainingValue: 0 })), "This coupon has already been used up.");
  // Cancelled beats expired: it is the more accurate thing to tell someone.
  assert.equal(
    couponBlockedReason(coupon({ status: "void", expiresAt: "2020-01-01T00:00:00Z" })),
    "This coupon has been cancelled.",
  );
});

test("applying a coupon is capped by balance, by the sale, and by the request", () => {
  // A $100 voucher against a $40 sale spends $40 and keeps $60 - it does not
  // hand out change.
  assert.equal(couponApplyAmount(coupon({ remainingValue: 100 }), 40), 40);
  assert.equal(couponApplyAmount(coupon({ remainingValue: 25 }), 40), 25);
  assert.equal(couponApplyAmount(coupon({ remainingValue: 100 }), 40, 10), 10);
  assert.equal(couponApplyAmount(coupon({ remainingValue: 100 }), 40, 999), 40);
  assert.equal(couponApplyAmount(coupon({ remainingValue: 100 }), 0), 0);
  // Nothing spendable means nothing applied, whatever was asked for.
  assert.equal(couponApplyAmount(coupon({ status: "void" }), 40), 0);
  assert.equal(couponApplyAmount(coupon({ expiresAt: "2020-01-01T00:00:00Z" }), 40), 0);
  // Negative requests can't turn into a top-up.
  assert.equal(couponApplyAmount(coupon(), 40, -20), 0);
});

test("what is left to pay on another method", () => {
  assert.equal(remainingAfterCoupon(40, 25), 15);
  assert.equal(remainingAfterCoupon(40, 40), 0);
  // Over-application can't produce a negative amount owing.
  assert.equal(remainingAfterCoupon(40, 60), 0);
  assert.equal(remainingAfterCoupon(19.99, 9.99), 10);
});
