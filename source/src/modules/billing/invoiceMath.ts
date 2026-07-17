// Invoice money math. Pure: given the editable draft and a tax rate, it returns
// every derived money figure the invoice UI and PDF need. No React, no network,
// no workspace state - so it can be unit-tested directly (see invoiceMath.test.ts).
//
// Extracted verbatim from the inline computation in App.tsx's invoice editor;
// the formulas are unchanged.

import type { InvoiceDraft, InvoiceLine } from "./types";

/**
 * A single line's amount after its own per-line discount:
 * max(0, quantity x unitPrice - discountAmount). Shared by the editor row, the
 * read-only line, and computeInvoiceTotals so they never drift.
 */
export function invoiceLineNet(
  line: Pick<InvoiceLine, "quantity" | "unitPrice" | "discountAmount">,
): number {
  const gross = Math.max(0, Number(line.quantity) || 0) * Math.max(0, Number(line.unitPrice) || 0);
  const discount = Math.min(gross, Math.max(0, Number(line.discountAmount) || 0));
  return gross - discount;
}

export type InvoiceTotals = {
  /**
   * Sum of each line's amount after its own per-line discount
   * (quantity x unitPrice - line discount), negatives floored to 0. This is the
   * "Subtotal" shown to the customer, so it already reflects per-line discounts.
   */
  lineSubtotal: number;
  /** Sum of the per-line discounts (each capped at its line's gross amount). */
  lineDiscountTotal: number;
  /** Invoice-level discount actually applied - never more than the subtotal. */
  discountTotal: number;
  /** Subtotal after the invoice-level discount; the base the tax is figured on. */
  taxableSubtotal: number;
  /** Sanitised tax rate as a percentage. */
  taxRatePct: number;
  /** Tax amount. */
  taxTotal: number;
  /** Amount payable. */
  total: number;
};

export function computeInvoiceTotals(
  draft: Pick<InvoiceDraft, "lines" | "discountAmount" | "taxInclusive">,
  taxRate: number,
): InvoiceTotals {
  let lineSubtotal = 0;
  let lineDiscountTotal = 0;
  for (const line of draft.lines) {
    const gross = Math.max(0, Number(line.quantity) || 0) * Math.max(0, Number(line.unitPrice) || 0);
    const net = invoiceLineNet(line);
    lineSubtotal += net;
    lineDiscountTotal += gross - net;
  }
  const discountTotal = Math.min(lineSubtotal, Math.max(0, Number(draft.discountAmount) || 0));
  const taxableSubtotal = Math.max(0, lineSubtotal - discountTotal);
  const taxRatePct = Math.max(0, Number(taxRate) || 0);
  // Inclusive: prices already contain tax, so tax is the rate/(100+rate) fraction
  // of the taxable amount and the total equals it. Exclusive: tax is added on top.
  const taxTotal = draft.taxInclusive
    ? taxableSubtotal * (taxRatePct / (100 + taxRatePct))
    : taxableSubtotal * (taxRatePct / 100);
  const total = draft.taxInclusive ? taxableSubtotal : taxableSubtotal + taxTotal;
  return { lineSubtotal, lineDiscountTotal, discountTotal, taxableSubtotal, taxRatePct, taxTotal, total };
}
