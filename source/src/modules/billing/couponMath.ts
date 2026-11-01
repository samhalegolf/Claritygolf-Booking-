// The till's coupon (gift voucher) helpers. Pure, so they can be tested
// without a browser or a database.
//
// A coupon is stored value: someone paid for it, and until it is spent the
// balance is money owed to whoever holds the code. How much of one a sale uses
// is decided in netlify/functions/_shared/voucher-redemption.mts, which the
// server reads too; codes are minted and compared in _shared/coupon-codes.mts.

import { normaliseCouponCode } from "../../../netlify/functions/_shared/coupon-codes.mts";
import { voucherSpendable } from "../../../netlify/functions/_shared/voucher-redemption.mts";

export type CouponStatus = "active" | "redeemed" | "void";

export type CouponSummary = {
  status: CouponStatus;
  remainingValue: number;
  expiresAt?: string | null;
};

function round2(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/** What is still owed on another payment method after the coupon is applied. */
export function remainingAfterCoupon(saleTotal: number, couponAmount: number) {
  return round2(Math.max(0, round2(saleTotal) - round2(couponAmount)));
}

export type CouponSearchEntry = CouponSummary & {
  code: string;
  issuedToName?: string;
  issuedToEmail?: string;
  // The client the voucher is filed under, when the till knows their name.
  customerName?: string;
};

/**
 * The till's coupon search: by code or by whose voucher it is.
 *
 * A code is matched with the same normalising as a lookup, so "cg ab12" finds
 * CG-AB12-XXXX; a name is matched as typed, against the name the voucher was
 * issued to and the client it is filed under. Only vouchers that can be spent
 * are offered -- one that is used up or cancelled is not something to pick.
 */
export function searchCoupons<T extends CouponSearchEntry>(coupons: T[], query: string, limit = 8, now = new Date()) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return [] as T[];
  const codeNeedle = normaliseCouponCode(needle);
  return coupons
    .filter((coupon) => voucherSpendable(coupon, now))
    .filter((coupon) => {
      if (codeNeedle && normaliseCouponCode(coupon.code).includes(codeNeedle)) return true;
      return [coupon.issuedToName, coupon.customerName, coupon.issuedToEmail]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle));
    })
    .slice(0, limit);
}
