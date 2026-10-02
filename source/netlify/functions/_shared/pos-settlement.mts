/**
 * Settling a POS sale once a processor says the money is in.
 *
 * Every way Clarity Pay collects a card -- the QR Checkout page, Tap to Pay on
 * an iPhone, a card reader later -- ends here, so there is exactly one place
 * that decides what "paid" does to a sale: the status flip, the stock, the
 * voucher, the passes and the tender records.
 *
 * It has to survive being called more than once for the same payment. The QR
 * poll runs every few seconds and keeps running after the sale clears; a phone
 * that loses signal mid-tap asks again when it comes back; two tills can look at
 * the same sale. So:
 *
 *   - the paid transition is a compare-and-swap on status=pending, and only one
 *     caller wins it;
 *   - every effect after it is idempotent on its own (stock and voucher flags,
 *     pass issuing keyed on the sale line, tenders unique per sale and kind), so
 *     a caller that lost the swap -- or a retry after a crash half way through --
 *     can safely run them again and finish anything left undone.
 *
 * The store is passed in rather than imported. billing-api.mts owns the tables;
 * this module owns the order of operations, and tests can drive it without a
 * database.
 */

/** How a tender was collected. See billing_payment_tenders.channel. */
export type PaymentChannel =
  | "stripe_checkout"
  | "terminal_tap_to_pay"
  | "terminal_reader"
  | "manual_cash"
  | "bank"
  | "coupon"
  | "clarity_credit"
  | "pass";

export type CardChannel = Extract<PaymentChannel, "stripe_checkout" | "terminal_tap_to_pay" | "terminal_reader">;

export type PosSaleRow = Record<string, unknown>;

export type PosTender = {
  kind: "card" | "gift_value";
  channel: PaymentChannel;
  amountCents: number;
  currency: string;
  externalRef: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
};

export type CardPayment = {
  channel: CardChannel;
  paymentIntentId: string;
  /** What Stripe actually took, in cents. Checked against what was owed. */
  amountCents: number;
  cardBrand?: string;
  cardLast4?: string;
};

export type SettlementStore = {
  readTransaction(transactionId: string): Promise<PosSaleRow | null>;
  /** status pending -> paid, only if still pending. Null when someone else got there first. */
  claimPaid(transactionId: string, patch: Record<string, unknown>): Promise<PosSaleRow | null>;
  /** Stock, voucher and passes. Each must be safe to run twice. */
  applyPaidEffects(row: PosSaleRow): Promise<{ issuedPasses: string[] }>;
  /** Insert-if-absent, keyed on (purchaseRef, kind). */
  recordTenders(purchaseRef: string, tenders: PosTender[]): Promise<void>;
};

const cents = (value: unknown) => Math.round((Number(value) || 0) * 100);

/** The tender records key on this, so the sale and its tenders find each other. */
export function posPurchaseRef(transactionId: string) {
  return `pos:${transactionId}`;
}

/**
 * What is left for a card to pay on this sale, in cents.
 *
 * Decided here from the stored sale, never from anything a till or a phone
 * sends. A voucher already took its slice when the sale was created, so the
 * card owes the rest -- charging `amount` itself would take the voucher's part
 * twice. A pass sale is $0 and has nothing for a card to do.
 */
export function posCardDueCents(row: PosSaleRow) {
  if (row.payment_method_kind === "pass") return 0;
  return Math.max(0, cents(row.amount) - cents(row.coupon_amount));
}

/**
 * The tenders a card-settled sale is made of.
 *
 * A voucher-plus-card sale is two tenders, never one "card" row for the full
 * total: a refund has to go back to where each part came from.
 */
export function posTenders(row: PosSaleRow, card: CardPayment | null): PosTender[] {
  const currency = String(row.currency || "").toUpperCase();
  const tenders: PosTender[] = [];
  const couponCents = cents(row.coupon_amount);
  if (couponCents > 0) {
    tenders.push({
      kind: "gift_value",
      channel: "coupon",
      amountCents: couponCents,
      currency,
      externalRef: String(row.coupon_id || "") || null,
      cardBrand: null,
      cardLast4: null,
    });
  }
  if (card && card.amountCents > 0) {
    tenders.push({
      kind: "card",
      channel: card.channel,
      amountCents: card.amountCents,
      currency,
      externalRef: card.paymentIntentId || null,
      cardBrand: card.cardBrand || null,
      cardLast4: card.cardLast4 || null,
    });
  }
  return tenders;
}

function conflict(message: string, code: string): never {
  throw Object.assign(new Error(message), { status: 409, code });
}

export type SettlementResult = {
  transaction: PosSaleRow;
  issuedPasses: string[];
  tenders: PosTender[];
  /** True when an earlier call had already marked it paid. */
  alreadyPaid: boolean;
};

/**
 * Settle a sale a card has paid for.
 *
 * Refuses, rather than settles, anything that does not add up: a card amount
 * that is not what was owed, a payment on a sale somebody voided, or a second
 * card payment on a sale another one already paid. In each of those the money
 * has moved and a person has to decide what happens to it -- quietly marking
 * the sale paid would hide exactly the thing they need to see.
 */
export async function settlePosTransaction(
  store: SettlementStore,
  transactionId: string,
  card: CardPayment,
): Promise<SettlementResult> {
  let row = await store.readTransaction(transactionId);
  if (!row) throw Object.assign(new Error("Transaction not found."), { status: 404 });

  let alreadyPaid = true;
  if (row.status === "pending") {
    const due = posCardDueCents(row);
    if (card.amountCents !== due) {
      conflict(
        `The card payment (${card.amountCents} cents) does not match what ${row.receipt_number} owes (${due} cents). Check it in Stripe before marking it paid.`,
        "POS_AMOUNT_MISMATCH",
      );
    }
    const claimed = await store.claimPaid(transactionId, {
      status: "paid",
      paid_at: new Date().toISOString(),
      stripe_payment_intent_id: card.paymentIntentId || null,
      payment_channel: card.channel,
    });
    if (claimed) {
      row = claimed;
      alreadyPaid = false;
    } else {
      row = (await store.readTransaction(transactionId)) || row;
    }
  }

  if (row.status !== "paid") {
    conflict(
      `${row.receipt_number} is ${row.status}, but a card payment went through for it. Refund it in Stripe or reopen the sale.`,
      "POS_PAID_AFTER_CLOSE",
    );
  }
  // Paid earlier by something other than this payment -- another card, or a
  // coach marking it paid by hand -- means this card payment is a second one.
  if (alreadyPaid && String(row.stripe_payment_intent_id || "") !== card.paymentIntentId) {
    conflict(
      `${row.receipt_number} was already paid by another card payment. Refund the second one in Stripe.`,
      "POS_DUPLICATE_PAYMENT",
    );
  }

  const { issuedPasses } = await store.applyPaidEffects(row);
  const tenders = posTenders(row, card);
  if (tenders.length) await store.recordTenders(posPurchaseRef(transactionId), tenders);
  return { transaction: row, issuedPasses, tenders, alreadyPaid };
}

/**
 * What changing a sale's status means for money a card already paid.
 *
 * A sale Clarity Pay took a card for (QR or tap) carries its PaymentIntent.
 * Refunding it from Clarity sends the money back through Stripe, so the screen
 * and the bank agree. Every other way out of "paid" would leave the money taken
 * against a sale that says otherwise, so it is refused:
 *
 *   - voiding or reopening a card-paid sale (refund it instead);
 *   - marking a sale paid again once its card money has gone back (the
 *     customer would have the goods and the money; start a new sale).
 *
 * Sales paid any other way (cash, bank, a pass) keep the status flip they have
 * always had: there is nothing for Clarity to send back.
 */
export type PosStatusPlan = { refundPaymentIntentId: string | null };

export function posStatusChangePlan(row: PosSaleRow, nextStatus: string): PosStatusPlan {
  const paymentIntentId = String(row.stripe_payment_intent_id || "");
  const refundedByCard = Boolean(String(row.stripe_refund_id || ""));
  if (refundedByCard && nextStatus !== "refunded") {
    conflict(
      `The card payment for ${row.receipt_number} has already been refunded. Start a new sale instead.`,
      "POS_CARD_REFUNDED",
    );
  }
  if (row.status !== "paid" || !paymentIntentId) return { refundPaymentIntentId: null };
  if (nextStatus === "refunded") return { refundPaymentIntentId: refundedByCard ? null : paymentIntentId };
  if (nextStatus === "paid") return { refundPaymentIntentId: null };
  conflict(
    `${row.receipt_number} was paid by card. Refund it so the money goes back to the customer.`,
    "POS_CARD_PAID",
  );
}

/**
 * A card payment refunded outside Clarity -- in the business's Stripe
 * dashboard -- and what it means for the sale it paid for.
 *
 * Only a full refund changes the sale: a part refund (a goodwill $10 back) is
 * not the sale being undone, and Clarity has no "partly refunded" status to
 * show it with, so the sale stays paid and Stripe keeps the detail.
 *
 *   mark_refunded     paid, and the whole card part has gone back
 *   record_refund_id  already marked refunded by hand, without the card side
 *   already           Clarity already sent this refund (or saw it before)
 *   partial           only part of the card payment went back
 *   needs_attention   the sale is not paid (pending, void): a person decides
 */
export type PosChargeRefundAction =
  | "mark_refunded"
  | "record_refund_id"
  | "already"
  | "partial"
  | "needs_attention";

export function posChargeRefundAction(
  row: PosSaleRow,
  charge: { amount: number; amountRefunded: number },
): PosChargeRefundAction {
  if (String(row.stripe_refund_id || "")) return "already";
  if (!(charge.amount > 0) || charge.amountRefunded < charge.amount) return "partial";
  if (row.status === "refunded") return "record_refund_id";
  if (row.status === "paid") return "mark_refunded";
  return "needs_attention";
}
