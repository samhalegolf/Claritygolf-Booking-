// Invoice money math. Pure: given the editable draft and a tax rate, it returns
// every derived money figure the invoice UI and PDF need. No React, no network,
// no workspace state - so it can be unit-tested directly (see invoiceMath.test.ts).
//
// Extracted verbatim from the inline computation in App.tsx's invoice editor;
// the formulas are unchanged.

import type { InvoiceDraft } from "./types";

export type InvoiceTotals = {
  /** Sum of quantity x unitPrice across all lines (negatives floored to 0). */
  lineSubtotal: number;
  /** Discount actually applied - never more than the subtotal. */
  discountTotal: number;
  /** Subtotal after discount; the base the tax is figured on. */
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
  const lineSubtotal = draft.lines.reduce(
    (total, line) => total + Math.max(0, Number(line.quantity) || 0) * Math.max(0, Number(line.unitPrice) || 0),
    0,
  );
  const discountTotal = Math.min(lineSubtotal, Math.max(0, Number(draft.discountAmount) || 0));
  const taxableSubtotal = Math.max(0, lineSubtotal - discountTotal);
  const taxRatePct = Math.max(0, Number(taxRate) || 0);
  // Inclusive: prices already contain tax, so tax is the rate/(100+rate) fraction
  // of the taxable amount and the total equals it. Exclusive: tax is added on top.
  const taxTotal = draft.taxInclusive
    ? taxableSubtotal * (taxRatePct / (100 + taxRatePct))
    : taxableSubtotal * (taxRatePct / 100);
  const total = draft.taxInclusive ? taxableSubtotal : taxableSubtotal + taxTotal;
  return { lineSubtotal, discountTotal, taxableSubtotal, taxRatePct, taxTotal, total };
}
