// Invoices raised from the till: the Sell screen's Invoice button, and an
// "On account" sale from either checkout. Money that is owed belongs on the
// invoice list, where it is numbered, chased and aged, so an On account sale
// is never written as a POS transaction - it becomes a draft invoice, and
// emailing it from the done screen moves it to sent.

import type { PosPaymentMethod } from "./types";
import { t } from "../../lib/i18n";

// What /api/billing/invoices hands back, as far as the till cares.
export type TillInvoice = { id: string; invoiceNumber: string; total: number; currency: string };

export type TillInvoiceLine = {
  // "booking" links the lesson to the invoice (it leaves the unpaid list);
  // "product" with a lesson-type id issues the package credits once paid.
  sourceType: "booking" | "product" | "manual";
  sourceId: string;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
};

/** A method whose money is owed rather than taken: the sale becomes an invoice. */
export function isOnAccount(method: Pick<PosPaymentMethod, "kind" | "settlesImmediately">) {
  return method.kind === "custom" && !method.settlesImmediately;
}

export async function invoiceRequest(path: string, method: string, body?: unknown) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new Error(typeof data?.message === "string" ? data.message : t("Could not save the invoice."));
  }
  return data || {};
}

// Today and the due date as YYYY-MM-DD in the coach's own time zone, the way
// the invoice editor fills them in.
export function localDateValue(daysFromToday = 0) {
  const date = new Date();
  date.setDate(date.getDate() + daysFromToday);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Create the invoice as a draft. It only becomes "sent" when the email
 * endpoint actually sends it, so an invoice nobody received never counts as
 * sent. Till prices already include tax, so the invoice adds up to the same
 * total the till showed.
 */
export async function createTillInvoice(input: {
  customerId: string;
  customerName: string;
  customerEmail: string;
  dueDate: string;
  currency: string;
  items: TillInvoiceLine[];
  // A counter discount the lines do not carry, so the total still matches.
  discountAmount?: number;
}): Promise<TillInvoice> {
  const saved = (await invoiceRequest("/api/billing/invoices", "POST", {
    autoNumber: true,
    status: "draft",
    // A walk-in typed from a booking is not a client record.
    customerId: input.customerId.startsWith("appointment-") ? "" : input.customerId,
    customerName: input.customerName.trim(),
    customerEmail: input.customerEmail.trim(),
    issueDate: localDateValue(),
    dueDate: input.dueDate,
    currency: input.currency,
    taxInclusive: true,
    discountAmount: input.discountAmount || 0,
    items: input.items,
  })) as Partial<TillInvoice>;
  if (!saved.id) throw new Error(t("Could not save the invoice."));
  return {
    id: String(saved.id),
    invoiceNumber: String(saved.invoiceNumber || ""),
    total: Number(saved.total) || 0,
    currency: String(saved.currency || input.currency),
  };
}

/** Email the invoice. The server moves a draft to sent once it has gone. */
export async function sendTillInvoice(id: string, email: string, includePaymentLink: boolean) {
  return (await invoiceRequest(`/api/billing/invoices/${encodeURIComponent(id)}/send`, "POST", {
    email,
    includePaymentLink,
  })) as { recipient?: string; paymentLinkUrl?: string };
}
