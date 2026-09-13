import assert from "node:assert/strict";
import test from "node:test";

import { creditPostdatesInvoice, isNonCustomerCredit, mapAkahuTransaction } from "./akahu.mts";

function txn(overrides: Record<string, any> = {}) {
  return {
    _id: "trans_abc",
    _account: "acc_123",
    _connection: "conn_9",
    date: "2026-07-15T00:00:00.000Z",
    created_at: "2026-07-15T02:10:00.000Z",
    amount: -42.5,
    description: "COUNTDOWN THREE KINGS",
    type: "EFTPOS",
    merchant: { name: "Countdown" },
    category: { name: "Groceries" },
    meta: { particulars: "GROCERIES", code: "3KINGS", reference: "WK28", other_account: "12-3456-7890123-00" },
    ...overrides,
  };
}

test("negative amount maps to an outgoing (expense) row", () => {
  const row = mapAkahuTransaction(txn(), "sam-hale-golf");
  assert.equal(row.id, "trans_abc");
  assert.equal(row.account_id, "sam-hale-golf");
  assert.equal(row.akahu_account_id, "acc_123");
  assert.equal(row.amount, -42.5);
  assert.equal(row.direction, "out");
  assert.equal(row.date, "2026-07-15");
  assert.equal(row.merchant_name, "Countdown");
  assert.equal(row.category_name, "Groceries");
  assert.equal(row.type, "EFTPOS");
});

test("positive amount maps to an incoming (reconcile) row and carries NZ payment refs", () => {
  const row = mapAkahuTransaction(txn({ amount: 480, description: "TRANSFER FROM J HEATH" }), "sam-hale-golf");
  assert.equal(row.direction, "in");
  assert.equal(row.amount, 480);
  assert.equal(row.meta_particulars, "GROCERIES");
  assert.equal(row.meta_code, "3KINGS");
  assert.equal(row.meta_reference, "WK28");
  assert.equal(row.meta_other_account, "12-3456-7890123-00");
});

test("zero amount is treated as incoming, and missing fields are null not undefined", () => {
  const row = mapAkahuTransaction({ _id: "trans_z", date: "2026-01-02", amount: 0 }, "sam-hale-golf");
  assert.equal(row.direction, "in");
  assert.equal(row.merchant_name, null);
  assert.equal(row.meta_reference, null);
  assert.equal(row.akahu_account_id, null);
});

// --- auto-reconcile guards ---------------------------------------------------
// Regression cover for four credits that auto-applied to the wrong invoice on
// amount alone: a Stripe payout booked as Tony Shaw's $1,200 invoice, and three
// own-account transfers booked as customer payments.

function credit(overrides: Record<string, any> = {}) {
  return {
    id: "trans_credit",
    date: "2026-09-11",
    amount: 1200,
    direction: "in",
    type: "CREDIT",
    description: "Direct Credit SHG-0424 The Range Indoo",
    meta_particulars: "SHG-0424",
    meta_code: null,
    meta_reference: null,
    ...overrides,
  };
}

function invoice(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: "inv-1",
    invoice_number: "SHG-0424",
    customer_name: "Tony Shaw",
    total: 1200,
    amount_paid: 0,
    status: "sent",
    issue_date: "2026-09-10",
    ...overrides,
  } as any;
}

test("a Stripe payout is not a customer credit", () => {
  const payout = credit({
    description: "Direct Credit STRIPE TRF 6BOJMSVD Stripe Payments",
    meta_particulars: null,
    meta_reference: "STRIPE",
  });
  assert.equal(isNonCustomerCredit(payout), true);
});

test("an own-account transfer is not a customer credit", () => {
  const transfer = credit({
    description: "TRANSFER FROM S J HALE - 06",
    type: "TRANSFER",
    meta_particulars: null,
  });
  assert.equal(isNonCustomerCredit(transfer), true);
});

test("Akahu's TRANSFER type alone marks a credit as internal", () => {
  assert.equal(isNonCustomerCredit(credit({ type: "TRANSFER", description: "Payment" })), true);
});

test("an ordinary customer credit is not filtered", () => {
  assert.equal(isNonCustomerCredit(credit()), false);
  assert.equal(isNonCustomerCredit(credit({ description: "Bill Payment Coaching Golf HQ" })), false);
});

test("a credit dated before the invoice was issued cannot pay it", () => {
  assert.equal(creditPostdatesInvoice(credit({ date: "2026-03-04" }), invoice()), false);
});

test("same-day and later credits can pay an invoice", () => {
  assert.equal(creditPostdatesInvoice(credit({ date: "2026-09-10" }), invoice()), true);
  assert.equal(creditPostdatesInvoice(credit({ date: "2026-09-11" }), invoice()), true);
});

test("a missing date on either side is not treated as payable", () => {
  assert.equal(creditPostdatesInvoice(credit({ date: null }), invoice()), false);
  assert.equal(creditPostdatesInvoice(credit(), invoice({ issue_date: "" })), false);
});
