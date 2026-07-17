import { test } from "node:test";
import assert from "node:assert/strict";
import { computeInvoiceTotals } from "./invoiceMath.ts";
import type { InvoiceDraft } from "./types.ts";

function draft(partial: Partial<Pick<InvoiceDraft, "lines" | "discountAmount" | "taxInclusive">>) {
  return {
    lines: [],
    discountAmount: 0,
    taxInclusive: false,
    ...partial,
  } as Pick<InvoiceDraft, "lines" | "discountAmount" | "taxInclusive">;
}

function line(quantity: number, unitPrice: number, discountAmount = 0): InvoiceDraft["lines"][number] {
  return { id: "l", source: "manual", description: "", quantity, unitPrice, taxRate: 0, discountAmount };
}

test("empty invoice is all zeros", () => {
  const t = computeInvoiceTotals(draft({}), 15);
  assert.deepEqual(t, {
    lineSubtotal: 0,
    lineDiscountTotal: 0,
    discountTotal: 0,
    taxableSubtotal: 0,
    taxRatePct: 15,
    taxTotal: 0,
    total: 0,
  });
});

test("tax-exclusive adds tax on top", () => {
  const t = computeInvoiceTotals(draft({ lines: [line(2, 50)] }), 15);
  assert.equal(t.lineSubtotal, 100);
  assert.equal(t.taxableSubtotal, 100);
  assert.equal(t.taxTotal, 15);
  assert.equal(t.total, 115);
});

test("tax-inclusive extracts tax from the total", () => {
  const t = computeInvoiceTotals(draft({ lines: [line(1, 115)], taxInclusive: true }), 15);
  assert.equal(t.lineSubtotal, 115);
  assert.equal(t.total, 115); // total equals the taxable amount when inclusive
  assert.ok(Math.abs(t.taxTotal - 15) < 1e-9); // 115 * 15/115 = 15
});

test("discount is clamped to the subtotal and reduces the taxable base", () => {
  const t = computeInvoiceTotals(draft({ lines: [line(1, 100)], discountAmount: 250 }), 10);
  assert.equal(t.discountTotal, 100); // never more than subtotal
  assert.equal(t.taxableSubtotal, 0);
  assert.equal(t.total, 0);
});

test("per-line discount reduces the subtotal and the tax base", () => {
  // Two lines: 2x50 = 100 with a 20 line discount -> 80; plus 1x30 -> 30.
  const t = computeInvoiceTotals(draft({ lines: [line(2, 50, 20), line(1, 30)] }), 10);
  assert.equal(t.lineDiscountTotal, 20);
  assert.equal(t.lineSubtotal, 110); // 80 + 30
  assert.equal(t.taxableSubtotal, 110);
  assert.equal(t.taxTotal, 11); // 10% of 110
  assert.equal(t.total, 121);
});

test("a line discount is capped at that line's gross amount", () => {
  const t = computeInvoiceTotals(draft({ lines: [line(1, 40, 100)] }), 0);
  assert.equal(t.lineDiscountTotal, 40); // not 100
  assert.equal(t.lineSubtotal, 0);
  assert.equal(t.total, 0);
});

test("per-line and invoice-level discounts stack", () => {
  // 1x100 with 10 line discount -> 90 subtotal; then 15 invoice discount -> 75.
  const t = computeInvoiceTotals(draft({ lines: [line(1, 100, 10)], discountAmount: 15 }), 0);
  assert.equal(t.lineSubtotal, 90);
  assert.equal(t.discountTotal, 15);
  assert.equal(t.taxableSubtotal, 75);
  assert.equal(t.total, 75);
});

test("negative quantities/prices and bad tax rate are floored to zero", () => {
  const t = computeInvoiceTotals(draft({ lines: [line(-3, 40), line(1, -5)] }), Number.NaN);
  assert.equal(t.lineSubtotal, 0);
  assert.equal(t.taxRatePct, 0);
  assert.equal(t.total, 0);
});
