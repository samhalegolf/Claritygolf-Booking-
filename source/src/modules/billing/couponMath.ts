// Coupon (gift voucher) rules that both the till and the backend have to agree
// on. Pure, so they can be tested without a browser or a database.
//
// A coupon is stored value: someone paid for it, and until it is spent the
// balance is money owed to whoever holds the code. That is why nothing here
// ever rounds a balance up, and why applying one is capped three ways.

export type CouponStatus = "active" | "redeemed" | "void";

export type CouponSummary = {
  status: CouponStatus;
  remainingValue: number;
  expiresAt?: string | null;
};

// Ambiguous characters are left out on purpose: a code gets read off a printed
// card, over a counter, and down a phone line. 0/O and 1/I/L are where that
// goes wrong.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/**
 * CG-XXXX-XXXX. Grouping makes it readable aloud; the prefix makes it obvious
 * what someone is holding when they find it in a drawer a year later.
 *
 * `random` is injectable so tests are deterministic. Collisions are handled by
 * the unique index on (account_id, lower(code)), not by hoping.
 */
export function generateCouponCode(random: () => number = Math.random) {
  const block = (length: number) =>
    Array.from({ length }, () => CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)]).join("");
  return `CG-${block(4)}-${block(4)}`;
}

// What someone types is rarely what is printed: spaces creep in, hyphens get
// dropped, caps lock is off. Normalise both sides before comparing.
export function normaliseCouponCode(value: string) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function couponCodesMatch(a: string, b: string) {
  const left = normaliseCouponCode(a);
  return Boolean(left) && left === normaliseCouponCode(b);
}

// Expiry is checked here as well as in SQL. The database is what actually
// enforces it; this is so the till can say why before a request is made.
export function isCouponExpired(coupon: Pick<CouponSummary, "expiresAt">, now = new Date()) {
  if (!coupon.expiresAt) return false;
  const expires = new Date(coupon.expiresAt);
  return Number.isFinite(expires.getTime()) && expires.getTime() <= now.getTime();
}

export function couponSpendable(coupon: CouponSummary, now = new Date()) {
  return coupon.status === "active" && coupon.remainingValue > 0 && !isCouponExpired(coupon, now);
}

/** Why a coupon can't be used, in words a customer can be told. */
export function couponBlockedReason(coupon: CouponSummary, now = new Date()) {
  if (coupon.status === "void") return "This coupon has been cancelled.";
  if (isCouponExpired(coupon, now)) return "This coupon has expired.";
  if (coupon.status === "redeemed" || coupon.remainingValue <= 0) return "This coupon has already been used up.";
  return "";
}

function round2(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/**
 * How much of a coupon to put against a sale.
 *
 * Capped three ways, and the order matters: never more than is left on the
 * coupon, never more than the sale is worth (a $100 voucher against a $40 sale
 * leaves $60 on the voucher, it does not hand out $60), and never more than was
 * asked for when a partial amount was requested.
 */
export function couponApplyAmount(coupon: CouponSummary, saleTotal: number, requested?: number) {
  if (!couponSpendable(coupon)) return 0;
  const total = Math.max(0, round2(saleTotal));
  const available = Math.max(0, round2(coupon.remainingValue));
  const ceiling = requested === undefined ? Infinity : Math.max(0, round2(requested));
  return round2(Math.min(available, total, ceiling));
}

/** What is still owed on another payment method after the coupon is applied. */
export function remainingAfterCoupon(saleTotal: number, couponAmount: number) {
  return round2(Math.max(0, round2(saleTotal) - round2(couponAmount)));
}
