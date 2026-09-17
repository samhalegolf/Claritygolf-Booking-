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
  // Was "Charge for mary@example.com" until 2026-09-17. Stripe's filler is no
  // longer written through as though it described a product.
  assert.equal(line.description, "Card payment");
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

/* --- Keeping the name of what was sold ------------------------------------
 *
 * Every Squarespace sale reaches Stripe with the description "Charge for
 * <email>" -- all 102 in this account -- and the sync used to write that
 * verbatim as the invoice line. The product name was discarded at the one
 * point it existed, which is why nothing reading billing_invoice_items could
 * tell a gift voucher from a lesson, and why a card sale can never match a
 * pass on a client's profile.
 */

test("a product name in charge metadata becomes the invoice line", () => {
  const row = mapChargeLine(
    charge({ metadata: { orderId: "268", itemName: "Lesson Gift Voucher" } }),
    "sam-hale-golf",
  );
  assert.equal(row.description, "Lesson Gift Voucher");
});

test("the metadata key is not assumed to be called anything in particular", () => {
  // Squarespace's schema is its business, and naming one key is exactly how
  // the old voucher importer ended up matching nothing.
  for (const key of ["product", "line_item_1", "sqsp_item"]) {
    const row = mapChargeLine(charge({ metadata: { orderId: "268", [key]: "Lesson Gift Voucher" } }), "shg");
    assert.equal(row.description, "Lesson Gift Voucher", `${key} should have been read`);
  }
});

test("an expanded payment intent's description is used when the charge has none", () => {
  const row = mapChargeLine(
    charge({ payment_intent: { id: "pi_123", description: "1 Hour Golf Lesson Voucher", metadata: {} } }),
    "sam-hale-golf",
  );
  assert.equal(row.description, "1 Hour Golf Lesson Voucher");
});

test("a real charge description still wins over metadata", () => {
  const row = mapChargeLine(
    charge({ description: "5 Lesson Package", metadata: { orderId: "268", itemName: "something else" } }),
    "sam-hale-golf",
  );
  assert.equal(row.description, "5 Lesson Package");
});

test("Stripe's filler description never survives as a line", () => {
  // The whole point. With nothing else to go on it falls back to the generic
  // label rather than stamping a customer's email address across the invoice
  // list as though it were a product.
  const row = mapChargeLine(charge(), "sam-hale-golf");
  assert.equal(row.description, "Card payment");
});

test("an order id alone is not a product name", () => {
  const row = mapChargeLine(charge({ metadata: { orderId: "268" } }), "sam-hale-golf");
  assert.equal(row.description, "Card payment", "a number is not what was sold");
});

test("the source id still points at the payment intent when it is expanded", () => {
  // cleanString returns "" for an object, so an expanded intent must not
  // silently blank the column that used to hold its id.
  const row = mapChargeLine(charge({ payment_intent: { id: "pi_123", metadata: {} } }), "shg");
  assert.equal(row.source_id, "pi_123");
});
