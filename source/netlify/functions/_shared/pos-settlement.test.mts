/**
 * Settling a POS sale.
 *
 * The failure that matters here is a payment counted twice: a second pass
 * issued, a voucher drained again, a second tender that makes the sale look
 * over-paid. Every processor path -- the QR poll, Tap to Pay, its reconcile
 * after a dropped connection -- can ask to settle the same payment more than
 * once, so the tests below do exactly that.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  posCardDueCents,
  posTenders,
  settlePosTransaction,
  type PosSaleRow,
  type PosTender,
  type SettlementStore,
} from "./pos-settlement.mts";

/**
 * A store that behaves like the real one where it counts: the paid claim is a
 * compare-and-swap, and the effects are guarded the way billing-api guards
 * them (stock and voucher flags, pass issuing keyed on the sale, tenders unique
 * per sale and kind). It counts what actually happened.
 */
function memoryStore(initial: PosSaleRow) {
  const row: PosSaleRow = { stock_applied: false, ...initial };
  const counts = { paidTransitions: 0, stockMoves: 0, passIssues: 0 };
  const issuedRefs = new Set<string>();
  const tenders = new Map<string, PosTender>();
  const store: SettlementStore = {
    async readTransaction(id) {
      return id === row.id ? { ...row } : null;
    },
    async claimPaid(id, patch) {
      if (id !== row.id || row.status !== "pending") return null;
      Object.assign(row, patch);
      counts.paidTransitions += 1;
      return { ...row };
    },
    async applyPaidEffects(current) {
      if (!row.stock_applied) {
        row.stock_applied = true;
        counts.stockMoves += 1;
      }
      const ref = `pos:${current.id}:lesson:pkg`;
      const issued: string[] = [];
      if (!issuedRefs.has(ref)) {
        issuedRefs.add(ref);
        counts.passIssues += 1;
        issued.push("5 lesson pack");
      }
      return { issuedPasses: issued };
    },
    async recordTenders(purchaseRef, list) {
      for (const tender of list) {
        const key = `${purchaseRef}|${tender.kind}`;
        if (!tenders.has(key)) tenders.set(key, tender);
      }
    },
  };
  return { store, row, counts, tenders };
}

const sale = (over: PosSaleRow = {}): PosSaleRow => ({
  id: "sale-1",
  receipt_number: "POS-1048",
  status: "pending",
  payment_method_kind: "clarity_pay",
  amount: 100,
  coupon_amount: 0,
  coupon_id: null,
  currency: "NZD",
  ...over,
});

const tap = (amountCents: number, paymentIntentId = "pi_tap") => ({
  channel: "terminal_tap_to_pay" as const,
  paymentIntentId,
  amountCents,
  cardBrand: "visa",
  cardLast4: "4242",
});

/* --- What the card owes ------------------------------------------------- */

test("the card owes the sale less the voucher, from the stored sale", () => {
  assert.equal(posCardDueCents(sale({ amount: 100, coupon_amount: 25 })), 7500);
  assert.equal(posCardDueCents(sale({ amount: 90 })), 9000);
});

test("a pass sale has nothing for a card to pay", () => {
  assert.equal(posCardDueCents(sale({ payment_method_kind: "pass", amount: 0, listed_amount: 90 })), 0);
});

test("a voucher that covers everything leaves nothing due", () => {
  assert.equal(posCardDueCents(sale({ amount: 50, coupon_amount: 50 })), 0);
});

test("cents are rounded from dollars without drift", () => {
  assert.equal(posCardDueCents(sale({ amount: 70.1, coupon_amount: 0.3 })), 6980);
});

/* --- Mixed tender -------------------------------------------------------- */

test("voucher plus card is two tenders that add up to the sale", () => {
  const tenders = posTenders(sale({ amount: 100, coupon_amount: 25, coupon_id: "cpn-1" }), tap(7500));
  assert.deepEqual(
    tenders.map((tender) => [tender.kind, tender.channel, tender.amountCents]),
    [
      ["gift_value", "coupon", 2500],
      ["card", "terminal_tap_to_pay", 7500],
    ],
  );
  assert.equal(tenders.reduce((sum, tender) => sum + tender.amountCents, 0), 10000);
  assert.equal(tenders[1].externalRef, "pi_tap");
});

/* --- Settling ------------------------------------------------------------ */

test("settling twice is one payment", async () => {
  const { store, row, counts, tenders } = memoryStore(sale({ amount: 100, coupon_amount: 25, coupon_id: "cpn-1" }));
  const first = await settlePosTransaction(store, "sale-1", tap(7500));
  const second = await settlePosTransaction(store, "sale-1", tap(7500));

  assert.equal(row.status, "paid");
  assert.equal(row.payment_channel, "terminal_tap_to_pay");
  assert.equal(first.alreadyPaid, false);
  assert.equal(second.alreadyPaid, true);
  assert.deepEqual(counts, { paidTransitions: 1, stockMoves: 1, passIssues: 1 });
  assert.deepEqual(first.issuedPasses, ["5 lesson pack"]);
  assert.deepEqual(second.issuedPasses, []);
  assert.equal(tenders.size, 2);
});

test("two settles racing still make one paid transition", async () => {
  const { store, counts, tenders } = memoryStore(sale());
  await Promise.all([
    settlePosTransaction(store, "sale-1", tap(10000)),
    settlePosTransaction(store, "sale-1", tap(10000)),
  ]);
  assert.equal(counts.paidTransitions, 1);
  assert.equal(counts.passIssues, 1);
  assert.equal(tenders.size, 1);
});

test("a settle that finds it already paid finishes the effects a crash left undone", async () => {
  // Paid by this same payment, but the process died before stock moved.
  const { store, counts } = memoryStore(sale({ status: "paid", stripe_payment_intent_id: "pi_tap" }));
  const result = await settlePosTransaction(store, "sale-1", tap(10000));
  assert.equal(result.alreadyPaid, true);
  assert.equal(counts.stockMoves, 1);
  assert.equal(counts.passIssues, 1);
});

test("a card amount that is not what was owed is refused, not settled", async () => {
  const { store, row, counts } = memoryStore(sale({ amount: 100, coupon_amount: 25 }));
  await assert.rejects(settlePosTransaction(store, "sale-1", tap(10000)), { code: "POS_AMOUNT_MISMATCH" });
  assert.equal(row.status, "pending");
  assert.equal(counts.paidTransitions, 0);
});

test("a payment on a voided sale is surfaced, not quietly settled", async () => {
  const { store, counts } = memoryStore(sale({ status: "void" }));
  await assert.rejects(settlePosTransaction(store, "sale-1", tap(10000)), { code: "POS_PAID_AFTER_CLOSE" });
  assert.equal(counts.stockMoves, 0);
});

test("a second card payment on a sale another one paid is flagged", async () => {
  const { store } = memoryStore(sale());
  await settlePosTransaction(store, "sale-1", { channel: "stripe_checkout", paymentIntentId: "pi_qr", amountCents: 10000 });
  await assert.rejects(settlePosTransaction(store, "sale-1", tap(10000, "pi_tap")), { code: "POS_DUPLICATE_PAYMENT" });
});

test("a card payment on a sale a coach marked paid by hand is flagged", async () => {
  const { store } = memoryStore(sale({ status: "paid", stripe_payment_intent_id: null }));
  await assert.rejects(settlePosTransaction(store, "sale-1", tap(10000)), { code: "POS_DUPLICATE_PAYMENT" });
});

test("an unknown sale is a 404", async () => {
  const { store } = memoryStore(sale());
  await assert.rejects(settlePosTransaction(store, "nope", tap(100)), { status: 404 });
});
