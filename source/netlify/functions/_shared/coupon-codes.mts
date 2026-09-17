/**
 * Voucher codes: generating one, and deciding when two typed codes are the same.
 *
 * Extracted here because three places now mint or compare codes -- the till
 * (billing-api), the Pass Inbox (booking-core) and the browser's own preview
 * (src/modules/billing/couponMath.ts) -- and a code minted by one of them has
 * to be findable by the others. Two copies of an alphabet is a bug waiting for
 * the day somebody widens one of them.
 */

/**
 * No 0/O and no 1/I/L.
 *
 * A voucher code is read off a printed card over a counter, or down a phone
 * line, by somebody who did not choose it. Every character that has a
 * look-alike is a support call, and the alphabet is the only place that can be
 * fixed -- a lookup that "helpfully" treats O as 0 would make two different
 * vouchers the same voucher.
 */
export const COUPON_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateCouponCode(): string {
  const block = (length: number) =>
    Array.from(
      { length },
      () => COUPON_ALPHABET[Math.floor(Math.random() * COUPON_ALPHABET.length)],
    ).join("");
  return `CG-${block(4)}-${block(4)}`;
}

/**
 * The form two codes are compared in.
 *
 * Codes are stored with hyphens because that is how they print and how they
 * are read aloud, and compared without them because nobody typing one in
 * remembers where they go.
 */
export function normaliseCouponCode(value: unknown): string {
  return typeof value === "string" ? value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 40) : "";
}
