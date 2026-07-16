import assert from "node:assert/strict";
import test from "node:test";

import { chargeInvoiceNumber, chargeStatus, mapCharge, mapChargeLine, shouldSyncCharge } from "./stripe-billing.mts";

// A succeeded, unlinked card charge like the ones the booking site creates.
function charge(overrides: Record<string, any> = {}) {
  return {
    id: "ch_123",
    object: "charge",
    status: "succeeded",
    amount: 16000,
    amount_captured: 16000,
    amount_refunded: 0,
    currency: "nzd",
    created: 1780796777, // 2026-06-07T…Z
    customer: null,
    invoice: null,
    payment_intent: "pi_123",
    receipt_number: null,
    description: "Charge for mary@example.com",
    billing_details: { name: "Mary Wallace", email: "mary@example.com", phone: null },
    metadata: { orderId: "268" },
    ...overrides,
  };
}

test("succeeded charge maps to a paid invoice row in dollars", () => {
  const row = mapCharge(charge(), "sam-hale-golf");
  assert.equal(row.id, "ch_123");
  assert.equal(row.invoice_number, "ORD-268"); // booking order number, not the ch_ id
  assert.equal(row.tax_inclusive, true); // NZ charge amount is GST-inclusive
  assert.equal(row.account_id, "sam-hale-golf");
  assert.equal(row.status, "paid");
  assert.equal(row.total, 160);
  assert.equal(row.subtotal, 160);
  assert.equal(row.amount_paid, 160);
  assert.equal(row.currency, "NZD"); // upper-cased
  assert.equal(row.customer_name, "Mary Wallace");
  assert.equal(row.customer_email, "mary@example.com");
  assert.equal(row.issue_date, "2026-06-07");
  assert.equal(row.internal_note, "Synced from Stripe charge");
  assert.equal(row.reference, "ch_123");
  assert.ok(row.paid_at); // set for a paid row
});

test("missing billing name falls back to a placeholder, not blank", () => {
  const row = mapCharge(charge({ billing_details: {} }), "sam-hale-golf");
  assert.equal(row.customer_name, "Stripe customer");
  assert.equal(row.customer_email, null);
});

test("fully refunded charge is voided and drops its paid amount", () => {
  const c = charge({ amount_refunded: 16000 });
  assert.equal(chargeStatus(c), "void");
  const row = mapCharge(c, "sam-hale-golf");
  assert.equal(row.status, "void");
  assert.equal(row.total, 160); // gross unchanged
  assert.equal(row.amount_paid, 0); // net of the refund
});

test("partial refund stays paid with net amount_paid", () => {
  const row = mapCharge(charge({ amount_refunded: 4000 }), "sam-hale-golf");
  assert.equal(row.status, "paid");
  assert.equal(row.amount_paid, 120); // 160 - 40
});

test("charge line is a single stripe-source row summing to the charge total", () => {
  const line = mapChargeLine(charge(), "sam-hale-golf");
  assert.equal(line.id, "ch_123:line");
  assert.equal(line.invoice_id, "ch_123");
  assert.equal(line.source_type, "stripe");
  assert.equal(line.source_id, "pi_123");
  assert.equal(line.description, "Charge for mary@example.com");
  assert.equal(line.quantity, 1);
  assert.equal(line.unit_price, 160);
  assert.equal(line.line_total, 160);
  assert.equal(line.tax_rate, 0); // never null — column is NOT NULL
});

test("blank description falls back to 'Card payment'", () => {
  const line = mapChargeLine(charge({ description: null }), "sam-hale-golf");
  assert.equal(line.description, "Card payment");
});

test("dedup + status gating: only succeeded, unlinked charges sync", () => {
  assert.equal(shouldSyncCharge(charge()), true);
  assert.equal(shouldSyncCharge(charge({ status: "failed" })), false);
  assert.equal(shouldSyncCharge(charge({ invoice: "in_456" })), false); // already an invoice
  assert.equal(shouldSyncCharge({}), false);
});

test("invoice number: order id > receipt number > short card code", () => {
  assert.equal(chargeInvoiceNumber(charge()), "ORD-268");
  assert.equal(chargeInvoiceNumber(charge({ metadata: {}, receipt_number: "2043-1191" })), "2043-1191");
  assert.equal(
    chargeInvoiceNumber(charge({ id: "ch_3Ttll2HT7TJ4nhHW0KEuYoTx", metadata: {}, receipt_number: null })),
    "CARD-0KEUYOTX",
  );
});
