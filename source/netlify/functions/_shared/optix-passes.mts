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
 * The real new_sale payload (first seen 18 Aug 2026, Sam's test purchase of
 * "30 Minute Golf Lesson Package") carries NO invoice_id, no email and no
 * currency — despite Optix's docs listing invoice_id. What it does carry:
 * product, quantity, unit_amount, tax, total, product_sale_id, number (the
 * Optix sale number, "00652"), account (the buyer's Optix account id) and
 * user_name. Money changes hands inside Optix at the moment this event fires,
 * so a sale is recorded as paid at its purchase time.
 *
 * invoice_paid is NOT handled here or anywhere any more: its six keys carry no
 * purchase detail, and with no invoice_id on the sale there is nothing to join
 * it to. It now falls through with the other unsupported events and is stored
 * as ignored.
 */
export const OPTIX_PURCHASE_EVENT_TYPES = ["new_sale", "new_plan_subscription"] as const;

export type OptixPurchaseEventType = (typeof OPTIX_PURCHASE_EVENT_TYPES)[number];

export function isOptixPurchaseEvent(eventType: string): eventType is OptixPurchaseEventType {
  return (OPTIX_PURCHASE_EVENT_TYPES as readonly string[]).includes(text(eventType));
}

export type OptixPurchase = {
  eventType: string;
  purchaseId: string;
  /** The Optix sale number ("00652") — the receipt reference a buyer sees. */
  saleNumber: string;
  memberEmail: string;
  memberName: string;
  itemName: string;
  /** Anything that describes what was bought, joined for classification. */
  descriptor: string;
  quantity: number | null;
  amountCents: number | null;
  unitAmountCents: number | null;
  currency: string;
  purchasedAt: string;
};

/**
 * Reads a purchase event into a common shape.
 *
 * Field names are the ones seen in real payloads (new_sale) or documented
 * (new_plan_subscription, still unseen in the wild). The two payloads share
 * almost nothing, so each name is listed once against the event that sends it
 * and the reader takes the first that resolves.
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
    saleNumber: text(pick(payload, "number")),
    // Only new_plan_subscription identifies the buyer by email.
    memberEmail: text(pick(subscriber || {}, "email")).toLowerCase(),
    memberName: text(pick(payload, "user_name")) || text(pick(subscriber || {}, "user_fullname")),
    itemName,
    descriptor,
    quantity: quantityOf(pick(payload, "quantity")),
    // new_sale totals include tax; a plan's price does not, but Optix sends no
    // tax on a plan either, so total is the best each event has.
    amountCents: amountInCents(pick(payload, "total", "price")),
    unitAmountCents: amountInCents(pick(payload, "unit_amount")),
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
 * Is this purchase a lesson Pass?
 *
 * A plan recurs by definition, and a Pass never does, so new_plan_subscription
 * is settled by its event type alone. That leaves product sales, where the only
 * signal is the wording of the product.
 *
 * The real catalogue settled the words: Sam's passes are named like
 * "30 Minute Golf Lesson Package" — "lesson", not "pass" — so both words
 * classify. "1 x Extra Hour" (a bay-time top-up) matches neither and stays
 * unknown, which is correct: it is a sale, just not a lesson. A sale whose
 * name says nothing is left "unknown" rather than discarded — silently
 * dropping the very purchase we are trying to capture is the one failure that
 * would look like nothing arriving at all.
 *
 * If a lesson product is ever named without "lesson" or "pass", this is the
 * one place to widen (or rename the product in Optix).
 */
export function classifyPassPurchase(purchase: Pick<OptixPurchase, "eventType" | "descriptor">): PassClassification {
  if (purchase.eventType === "new_plan_subscription") return "not_pass";
  if (/\b(pass(es)?|lesson(s)?)\b/i.test(purchase.descriptor)) return "pass";
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
 * left unlinked and shows its buyer name instead. Matching a sale on name was
 * considered and rejected: two clients sharing a name would silently attach a
 * purchase to the wrong person, and there is no signal in the payload that
 * would let anyone notice.
 */
async function resolvePurchasePerson(purchase: OptixPurchase, accountId: string) {
  if (!purchase.memberEmail) return null;
  const rows = await optixOriginRequest(
    `people?account_id=eq.${encodeURIComponent(accountId)}&email=ilike.${encodeURIComponent(purchase.memberEmail)}&select=id,name,email,phone&limit=10`,
  ).catch(() => []);
  return matchPersonByEmail(rowsOf(rows), purchase.memberEmail);
}

/**
 * Stores a purchase event as a pass purchase record.
 *
 * Keyed on event_key so a redelivered webhook updates its row rather than
 * adding a second one. The raw payload is kept on the row as well as in
 * optix_webhook_events, so the Passes tab can show what actually arrived
 * without joining back to the event log.
 *
 * paid_at is the purchase time: Optix takes the money when the sale is made,
 * and the payload offers no later settlement signal to wait for (no
 * invoice_id, so invoice_paid can never be tied back to a sale).
 */
export async function recordOptixPassPurchase(eventKey: string, payload: unknown, accountId?: string) {
  const account = accountId || await optixPurchaseAccountId();
  const purchase = normalizeOptixPurchaseEvent(payload);
  const classification = classifyPassPurchase(purchase);
  const personId = await resolvePurchasePerson(purchase, account);
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
      sale_number: purchase.saleNumber || null,
      member_email: purchase.memberEmail || null,
      member_name: purchase.memberName || null,
      person_id: personId,
      item_name: purchase.itemName || null,
      quantity: purchase.quantity,
      amount_cents: purchase.amountCents,
      currency: purchase.currency || null,
      purchased_at: purchase.purchasedAt || now,
      paid_at: purchase.purchasedAt || now,
      is_pass: classification === "pass",
      classification,
      payload_json: payload,
      updated_at: now,
    }]),
  });
  return { classification, isPass: classification === "pass", personId, purchase };
}
