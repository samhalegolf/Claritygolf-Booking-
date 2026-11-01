// How much of a sale a gift voucher pays, and how much it takes off the
// voucher. The till shows it before Pay is pressed and the server decides it
// when the sale is recorded, from this one function, so they cannot disagree.
//
// A voucher is stored value: someone paid for it, and the balance is owed to
// whoever holds the code. Most vouchers are for an amount, and pay up to their
// balance. A voucher can instead be for a lesson type or a product (see the
// vouchers_for_items migration). Then, while nothing has been spent from it,
// it pays for that item at whatever the item costs on the day, and is used up
// doing so: a price rise is the business's to absorb, and a price drop leaves
// no change. Spent on anything else it is money, and once part of it has gone
// that way, it is an ordinary balance.
//
// A price drop leaves the voucher worth more than the item. That surplus is
// not lost: it goes to the account credit of the client the sale is for, or,
// when the sale names no client, stays on the voucher as money.
//
// Isomorphic: the till (src/modules/billing) and billing-api.mts both import it.

import { LESSON_ITEM_PREFIX } from "./online-shop.mts";

export type RedeemableVoucher = {
  status: string;
  remainingValue: number;
  originalValue: number;
  expiresAt?: string | null;
  /** What the voucher is for: a product id, or LESSON_ITEM_PREFIX + a lesson type id. Empty: an amount. */
  coversItemId?: string | null;
};

/** A line of a sale, as the voucher sees it. */
export type VoucherSaleLine = { productId: string; unitPrice: number };

export type VoucherRedemption = {
  /** The slice of the sale the voucher pays. */
  pays: number;
  /** What comes off the voucher's balance. */
  takes: number;
  /** What goes to the client's account credit: the surplus of a voucher worth more than its item. */
  credit: number;
  /** True when it paid for the item it is for, at that item's price. */
  coversItem: boolean;
};

const round2 = (value: number) => Math.round((Number(value) || 0) * 100) / 100;

export function isVoucherExpired(voucher: Pick<RedeemableVoucher, "expiresAt">, now = new Date()) {
  if (!voucher.expiresAt) return false;
  const expires = new Date(voucher.expiresAt);
  return Number.isFinite(expires.getTime()) && expires.getTime() <= now.getTime();
}

export function voucherSpendable(voucher: Pick<RedeemableVoucher, "status" | "remainingValue" | "expiresAt">, now = new Date()) {
  return voucher.status === "active" && voucher.remainingValue > 0 && !isVoucherExpired(voucher, now);
}

/**
 * Whether a sale's client can hold account credit. An "appointment-" id stands
 * in for someone on the calendar who is not a saved client yet, and credit
 * filed under it would belong to nobody.
 */
export function canHoldCredit(customerId: string | null | undefined) {
  const id = String(customerId || "").trim();
  return Boolean(id) && !id.startsWith("appointment-");
}

/** Still able to pay for its item at any price: for an item, and nothing spent from it. */
export function voucherHoldsItem(voucher: RedeemableVoucher) {
  return Boolean(voucher.coversItemId) && round2(voucher.remainingValue) >= round2(voucher.originalValue);
}

/**
 * The lines a sale is made of, for matching a voucher to its item. A lesson
 * settled at the till arrives as the lesson type and an amount rather than as
 * a basket line, so it is added here as one: what the sale charges beyond the
 * basket is what the lesson costs on this sale.
 */
export function voucherSaleLines(
  basket: Array<{ productId: string; unitPrice: number; quantity?: number }>,
  lesson?: { serviceId?: string; saleTotal: number },
): VoucherSaleLine[] {
  const lines = basket.map((line) => ({ productId: line.productId, unitPrice: round2(line.unitPrice) }));
  const serviceId = String(lesson?.serviceId || "").trim();
  if (serviceId) {
    const basketTotal = basket.reduce((sum, line) => sum + (Number(line.unitPrice) || 0) * (Number(line.quantity) || 1), 0);
    const lessonPrice = round2((Number(lesson?.saleTotal) || 0) - basketTotal);
    const productId = `${LESSON_ITEM_PREFIX}${serviceId}`;
    if (lessonPrice > 0 && !lines.some((line) => line.productId === productId)) lines.push({ productId, unitPrice: lessonPrice });
  }
  return lines;
}

/**
 * What a voucher does to a sale worth `saleTotal`. Nothing when it cannot be
 * spent. `requested` caps an amount voucher (part of its balance put towards
 * the sale); a voucher paying for its item pays for the item. `hasClient`:
 * the sale names a client, whose account credit can take a surplus.
 */
export function voucherRedemption(
  voucher: RedeemableVoucher,
  lines: VoucherSaleLine[],
  saleTotal: number,
  options: { requested?: number; hasClient?: boolean } = {},
  now = new Date(),
): VoucherRedemption {
  const none = { pays: 0, takes: 0, credit: 0, coversItem: false };
  if (!voucherSpendable(voucher, now)) return none;
  const total = Math.max(0, round2(saleTotal));
  const remaining = Math.max(0, round2(voucher.remainingValue));
  if (voucherHoldsItem(voucher)) {
    const line = lines.find((entry) => entry.productId === voucher.coversItemId && entry.unitPrice > 0);
    // One of the item, never more than the sale comes to.
    const pays = round2(Math.min(total, line?.unitPrice ?? 0));
    if (line && pays > 0) {
      const surplus = round2(Math.max(0, remaining - pays));
      // Used up either way: the surplus moves to the client's credit, or with
      // no client to give it to, is simply left on the voucher.
      return options.hasClient || surplus <= 0
        ? { pays, takes: remaining, credit: surplus, coversItem: true }
        : { pays, takes: pays, credit: 0, coversItem: true };
    }
  }
  const ceiling = options.requested === undefined ? Infinity : Math.max(0, round2(options.requested));
  const amount = round2(Math.min(remaining, total, ceiling));
  return { pays: amount, takes: amount, credit: 0, coversItem: false };
}
