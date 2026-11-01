import { test } from "node:test";
import assert from "node:assert/strict";
import { remainingAfterCoupon } from "./couponMath.ts";
import type { CouponSummary } from "./couponMath.ts";

function coupon(partial: Partial<CouponSummary> = {}): CouponSummary {
  return { status: "active", remainingValue: 100, expiresAt: null, ...partial };
}

test("what is left to pay on another method", () => {
  assert.equal(remainingAfterCoupon(40, 25), 15);
  assert.equal(remainingAfterCoupon(40, 40), 0);
  // Over-application can't produce a negative amount owing.
  assert.equal(remainingAfterCoupon(40, 60), 0);
  assert.equal(remainingAfterCoupon(19.99, 9.99), 10);
});

test("coupon search finds a voucher by code however it is typed", async () => {
  const { searchCoupons } = await import("./couponMath.ts");
  const book = [
    { ...coupon(), code: "CG-AB12-CD34", issuedToName: "Jane Smith" },
    { ...coupon(), code: "CG-ZZ99-YY88", issuedToName: "Tom Brown" },
  ];
  assert.deepEqual(searchCoupons(book, "cg ab12").map((entry) => entry.code), ["CG-AB12-CD34"]);
  assert.deepEqual(searchCoupons(book, "yy88").map((entry) => entry.code), ["CG-ZZ99-YY88"]);
});

test("coupon search finds a voucher by the holder's name or the client it is filed under", async () => {
  const { searchCoupons } = await import("./couponMath.ts");
  const book = [
    { ...coupon(), code: "CG-AAAA-BBBB", issuedToName: "Jane Smith" },
    { ...coupon(), code: "CG-CCCC-DDDD", issuedToName: "", customerName: "Tom Brown" },
  ];
  assert.deepEqual(searchCoupons(book, "jane").map((entry) => entry.code), ["CG-AAAA-BBBB"]);
  assert.deepEqual(searchCoupons(book, "brown").map((entry) => entry.code), ["CG-CCCC-DDDD"]);
});

test("coupon search never offers a voucher that cannot be spent", async () => {
  const { searchCoupons } = await import("./couponMath.ts");
  const book = [
    { ...coupon({ status: "void" }), code: "CG-VOID-0001", issuedToName: "Jane" },
    { ...coupon({ remainingValue: 0, status: "redeemed" }), code: "CG-USED-0002", issuedToName: "Jane" },
    { ...coupon({ expiresAt: "2000-01-01T00:00:00Z" }), code: "CG-OLDX-0003", issuedToName: "Jane" },
    { ...coupon(), code: "CG-GOOD-0004", issuedToName: "Jane" },
  ];
  assert.deepEqual(searchCoupons(book, "jane").map((entry) => entry.code), ["CG-GOOD-0004"]);
  assert.deepEqual(searchCoupons(book, "  "), []);
});
