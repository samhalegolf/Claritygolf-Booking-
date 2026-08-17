import { randomUUID } from "node:crypto";

import { matchPersonByEmail, optixOriginRequest, rowsOf } from "./optix-db.mts";
import { amountInCents, iso, pick, text } from "./optix-payload.mts";

/**
 * Purchase events, as opposed to the booking events optix-origin.mts handles.
 *
 * Only two Optix events describe what was actually bought:
 *
 *   new_sale               a one-off product sale — product, quantity,
 *                          unit_amount, tax, total
 *   new_plan_subscription  a recurring plan — plan_template_name, price,
 *                          deposit, set_up_fee, subscribers[]
 *
 * A Pass is a one-time purchase granting allowance, so it arrives as new_sale.
 * new_plan_subscription is recorded anyway, because a plan is the thing a Pass
 * is most easily confused with and seeing both side by side is what makes a
 * misclassification obvious.
 *
 * invoice_paid is NOT here. Its payload is six keys — event, client_id,
 * invoice_id, organization_id, created_timestamp, request_signature — and
 * carries nothing about the purchase. It is handled separately, as the signal
 * that a sale settled: see markOptixInvoicePaid().
 *
 * invoice_updated is ignored entirely: a modification, not a purchase.
 */
export const OPTIX_PURCHASE_EVENT_TYPES = ["new_sale", "new_plan_subscription"] as const;

export type OptixPurchaseEventType = (typeof OPTIX_PURCHASE_EVENT_TYPES)[number];

export function isOptixPurchaseEvent(eventType: string): eventType is OptixPurchaseEventType {
  return (OPTIX_PURCHASE_EVENT_TYPES as readonly string[]).includes(text(eventType));
}

export function isOptixInvoicePaidEvent(eventType: string) {
  return text(eventType) === "invoice_paid";
}

export type OptixPurchase = {
  eventType: string;
  purchaseId: string;
  /** The invoice this purchase sits on, which invoice_paid later settles. */
  invoiceId: string;
  memberEmail: string;
  memberName: string;
  itemName: string;
  /** Anything that describes what was bought, joined for classification. */
  descriptor: string;
  quantity: number | null;
  amountCents: number | null;
  currency: string;
  purchasedAt: string;
};

/**
 * Reads a purchase event into a common shape.
 *
 * Field names are the documented ones for each event, not guesses. The two
 * payloads share almost nothing, so each name is listed once against the event
 * that sends it and the reader takes the first that resolves.
 *
 * Worth knowing about new_sale: it carries no email and no currency. The buyer
 * is a display name only (user_name), so a sale cannot be auto-linked to a
 * Clarity client the way a booking is — see resolvePurchasePerson.
 */
export function normalizeOptixPurchaseEvent(payload: any): OptixPurchase {
  const itemName = text(pick(
    payload,
    // new_sale: the product itself, not invoice_item_name ("Sale of X (#123)").
    "product",
    // new_plan_subscription: the template is the product; "name" is this
    // subscriber's instance of it ("Plan A for Jean").
    "plan_template_name", "name",
  ));
  const descriptor = [
    itemName,
    text(pick(payload, "invoice_item_name")),
    text(pick(payload, "description")),
  ].filter(Boolean).join(" ");
  const subscriber = (payload?.subscribers as any[] | undefined)?.[0];
  return {
    eventType: text(pick(payload, "event")),
    purchaseId: text(pick(payload, "product_sale_id", "account_plan_id")),
    invoiceId: text(pick(payload, "invoice_id")),
    // Only new_plan_subscription identifies the buyer by email.
    memberEmail: text(pick(subscriber || {}, "email")).toLowerCase(),
    memberName: text(pick(payload, "user_name")) || text(pick(subscriber || {}, "user_fullname")),
    itemName,
    descriptor,
    quantity: quantityOf(pick(payload, "quantity")),
    // new_sale totals include tax; a plan's price does not, but Optix sends no
    // tax on a plan either, so total is the best each event has.
    amountCents: amountInCents(pick(payload, "total", "price")),
    currency: text(pick(payload, "currency")).toUpperCase(),
    purchasedAt: iso(pick(payload, "created_timestamp")),
  };
}

/** Optix sends quantity as "1.0000". Null when absent or unusable. */
function quantityOf(value: unknown) {
  const raw = text(value);
  if (!raw) return null;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : null;
}

export type PassClassification = "pass" | "not_pass" | "unknown";

/**
 * Is this purchase a Pass?
 *
 * A plan recurs by definition, and a Pass never does, so new_plan_subscription
 * is settled by its event type alone. That leaves product sales, where the only
 * signal is the wording of the product — so a sale whose name says nothing is
 * left "unknown" rather than discarded. Silently dropping the very purchase we
 * are trying to capture is the one failure that would look like nothing
 * arriving at all.
 *
 * If Passes turn out to be named without the word "pass", this is the one place
 * to widen.
 */
export function classifyPassPurchase(purchase: Pick<OptixPurchase, "eventType" | "descriptor">): PassClassification {
  if (purchase.eventType === "new_plan_subscription") return "not_pass";
  if (/\bpass(es)?\b/i.test(purchase.descriptor)) return "pass";
  return "unknown";
}

/**
 * Which Clarity account a purchase belongs to.
 *
 * A purchase event carries no workspace, so unlike a booking it cannot be
 * mapped. The Optix integration is configured for one account, so that
 * mapping's account_id is the answer; the fallback only matters before setup
 * has ever been saved.
 */
export async function optixPurchaseAccountId() {
  const rows = await optixOriginRequest(
    "external_booking_mappings?provider=eq.optix&select=account_id&order=updated_at.desc&limit=1",
  ).catch(() => []);
  return text(rowsOf(rows)[0]?.["account_id" as keyof object]) || "sam-hale-golf";
}

/**
 * The client this purchase belongs to, by email only — same rule as bookings.
 *
 * Only new_plan_subscription carries an email, so a product sale is always
 * left unlinked and shows its buyer name in the Passes tab instead. Matching a
 * sale on name was considered and rejected: two clients sharing a name would
 * silently attach a purchase to the wrong person, and there is no signal in the
 * payload that would let anyone notice.
 */
async function resolvePurchasePerson(purchase: OptixPurchase, accountId: string) {
  if (!purchase.memberEmail) return null;
  const rows = await optixOriginRequest(
    `people?account_id=eq.${encodeURIComponent(accountId)}&email=ilike.${encodeURIComponent(purchase.memberEmail)}&select=id,name,email,phone&limit=10`,
  ).catch(() => []);
  return matchPersonByEmail(rowsOf(rows), purchase.memberEmail);
}

/**
 * When this invoice was paid, if its invoice_paid already arrived.
 *
 * Optix does not guarantee the order of new_sale and invoice_paid, so the join
 * is made from both ends: this covers paid-arrived-first, and
 * markOptixInvoicePaid() covers sale-arrived-first.
 */
async function paidAtForInvoice(invoiceId: string) {
  if (!invoiceId) return null;
  const rows = await optixOriginRequest(
    `optix_webhook_events?event_type=eq.invoice_paid&payload_json->>invoice_id=eq.${encodeURIComponent(invoiceId)}&select=received_at&order=received_at.asc&limit=1`,
  ).catch(() => []);
  return text(rowsOf(rows)[0]?.["received_at" as keyof object]) || null;
}

/**
 * Stores a purchase event as a pass purchase record.
 *
 * Keyed on event_key so a redelivered webhook updates its row rather than
 * adding a second one. The raw payload is kept on the row as well as in
 * optix_webhook_events, so the Passes tab can show what actually arrived
 * without joining back to the event log.
 */
export async function recordOptixPassPurchase(eventKey: string, payload: unknown, accountId?: string) {
  const account = accountId || await optixPurchaseAccountId();
  const purchase = normalizeOptixPurchaseEvent(payload);
  const classification = classifyPassPurchase(purchase);
  const personId = await resolvePurchasePerson(purchase, account);
  const paidAt = await paidAtForInvoice(purchase.invoiceId);
  const now = new Date().toISOString();
  await optixOriginRequest("optix_pass_purchases?on_conflict=event_key", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([{
      id: randomUUID(),
      provider: "optix",
      account_id: account,
      event_key: eventKey,
      event_type: purchase.eventType,
      external_purchase_id: purchase.purchaseId || null,
      external_invoice_id: purchase.invoiceId || null,
      member_email: purchase.memberEmail || null,
      member_name: purchase.memberName || null,
      person_id: personId,
      item_name: purchase.itemName || null,
      quantity: purchase.quantity,
      amount_cents: purchase.amountCents,
      currency: purchase.currency || null,
      purchased_at: purchase.purchasedAt || now,
      paid_at: paidAt,
      is_pass: classification === "pass",
      classification,
      payload_json: payload,
      updated_at: now,
    }]),
  });
  return { classification, isPass: classification === "pass", personId, paidAt, purchase };
}

/**
 * invoice_paid: stamp the sale sitting on this invoice as settled.
 *
 * The payload has no purchase detail, so it creates nothing — it only confirms
 * that a sale we already know about was paid. An invoice_paid with no matching
 * sale is normal and not an error: it is either an invoice raised outside the
 * events we record, or the paid notice beating its own new_sale, which
 * paidAtForInvoice() then picks up from the event log.
 */
export async function markOptixInvoicePaid(payload: unknown) {
  const invoiceId = text(pick(payload, "invoice_id"));
  const paidAt = iso(pick(payload, "created_timestamp")) || new Date().toISOString();
  if (!invoiceId) return { matched: 0, invoiceId: "", paidAt };
  const rows = await optixOriginRequest(
    `optix_pass_purchases?external_invoice_id=eq.${encodeURIComponent(invoiceId)}&paid_at=is.null`,
    {
      method: "PATCH",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({ paid_at: paidAt, updated_at: new Date().toISOString() }),
    },
  );
  return { matched: rowsOf(rows).length, invoiceId, paidAt };
}
