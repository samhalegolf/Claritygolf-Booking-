// Invoice money math. Pure: given the editable draft and a tax rate, it returns
// every derived money figure the invoice UI and PDF need. No React, no network,
// no workspace state - so it can be unit-tested directly (see invoiceMath.test.ts).
//
// Extracted verbatim from the inline computation in App.tsx's invoice editor;
// the formulas are unchanged.

import type { InvoiceDraft, InvoiceLine } from "./types";

/** A line's gross amount before any discount: max(0, quantity) x max(0, unitPrice). */
export function invoiceLineGross(line: Pick<InvoiceLine, "quantity" | "unitPrice">): number {
  return Math.max(0, Number(line.quantity) || 0) * Math.max(0, Number(line.unitPrice) || 0);
}

/**
 * The resolved per-line discount in the invoice currency, derived from the
 * line's discountKind/discountValue (a percentage tracks the current gross), and
 * always capped at the line's gross. Falls back to a legacy fixed discountAmount
 * when kind/value aren't set (e.g. an invoice loaded before this field existed).
 * Single source of truth for the editor row, computeInvoiceTotals, and the save
 * payload so they never drift.
 */
export function lineDiscountAmount(
  line: Pick<InvoiceLine, "quantity" | "unitPrice" | "discountKind" | "discountValue" | "discountAmount">,
): number {
  const gross = invoiceLineGross(line);
  const value = Math.max(0, Number(line.discountValue) || 0);
  let raw: number;
  if (line.discountKind === "percent") raw = (gross * value) / 100;
  else if (line.discountKind === "amount") raw = value;
  else if (!line.discountKind) raw = Math.max(0, Number(line.discountAmount) || 0); // legacy rows
  else raw = 0; // "none"
  return Math.min(gross, Math.round(raw * 100) / 100);
}

/**
 * A single line's amount after its own per-line discount. Shared by the editor
 * row, the read-only line, and computeInvoiceTotals so they never drift.
 */
export function invoiceLineNet(
  line: Pick<InvoiceLine, "quantity" | "unitPrice" | "discountKind" | "discountValue" | "discountAmount">,
): number {
  return invoiceLineGross(line) - lineDiscountAmount(line);
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
    lineSubtotal += invoiceLineNet(line);
    lineDiscountTotal += lineDiscountAmount(line);
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
