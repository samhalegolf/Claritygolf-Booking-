import { randomUUID } from "node:crypto";

import { matchPersonByEmail, optixOriginRequest, rowsOf } from "./optix-db.mts";
import { amountInCents, iso, pick, text } from "./optix-payload.mts";

/**
 * Purchase events, as opposed to the booking events optix-origin.mts handles.
 *
 * Optix does not document which of these a Pass fires. A Pass is a one-time
 * purchase that grants allowance (unlike a Plan, which recurs), so depending on
 * how Optix models it internally the purchase may surface as a product sale, a
 * non-recurring plan subscription, or only as the invoice that settles it. All
 * three are recorded and then classified, rather than guessing one and finding
 * out later that Passes never appear.
 *
 * invoice_updated is deliberately absent: it is a modification, not a purchase.
 */
export const OPTIX_PURCHASE_EVENT_TYPES = ["invoice_paid", "new_sale", "new_plan_subscription"] as const;

export type OptixPurchaseEventType = (typeof OPTIX_PURCHASE_EVENT_TYPES)[number];

export function isOptixPurchaseEvent(eventType: string): eventType is OptixPurchaseEventType {
  return (OPTIX_PURCHASE_EVENT_TYPES as readonly string[]).includes(text(eventType));
}

export type OptixPurchase = {
  eventType: string;
  purchaseId: string;
  memberEmail: string;
  memberName: string;
  itemName: string;
  /** Anything that describes what was bought, joined for classification. */
  descriptor: string;
  amountCents: number | null;
  currency: string;
  purchasedAt: string;
  /** Set when the payload says the charge repeats, e.g. "monthly". */
  recurrence: string;
};

/**
 * Optix has not sent us a purchase event yet, so every field is read through a
 * list of plausible names rather than one known key. When the first real Pass
 * lands, the Passes tab shows its raw payload — add the true field names to the
 * front of these lists then, and delete the guesses that never matched.
 */
export function normalizeOptixPurchaseEvent(payload: any): OptixPurchase {
  const firstName = text(pick(payload, "member.first_name", "member_name", "member_first_name", "user.first_name", "first_name"));
  const lastName = text(pick(payload, "member.last_name", "member_last_name", "user.last_name", "last_name"));
  const itemName = text(pick(
    payload,
    "pass_name", "pass.name", "product_name", "product.name", "plan_name", "plan.name",
    "item_name", "item.name", "subscription_name", "title", "name", "description",
  ));
  const descriptor = [
    itemName,
    text(pick(payload, "pass_type", "product_type", "plan_type", "item_type", "type", "category")),
    text(pick(payload, "description", "line_item_description", "invoice_description")),
  ].filter(Boolean).join(" ");
  return {
    eventType: text(pick(payload, "event", "event_type")),
    purchaseId: text(pick(
      payload,
      "pass_id", "sale_id", "invoice_id", "subscription_id", "plan_subscription_id", "transaction_id", "order_id", "id",
    )),
    memberEmail: text(pick(payload, "member.email", "member_email", "user.email", "user_email", "email")).toLowerCase(),
    memberName: [firstName, lastName].filter(Boolean).join(" ").trim(),
    itemName,
    descriptor,
    // A *_cents/minor field is already in minor units; a plain "amount" is not.
    amountCents:
      amountInCents(pick(payload, "amount_cents", "total_cents", "price_cents"), true) ??
      amountInCents(pick(payload, "amount", "total", "price", "amount_paid", "subtotal")),
    currency: text(pick(payload, "currency", "currency_code")).toUpperCase(),
    purchasedAt:
      iso(pick(payload, "paid_timestamp", "sale_timestamp", "purchase_timestamp", "created_timestamp", "start_timestamp")) ||
      iso(pick(payload, "paid_datetime", "sale_datetime", "purchase_datetime", "created_datetime")),
    recurrence: text(pick(payload, "recurrence", "interval", "billing_interval", "billing_period", "frequency")),
  };
}

export type PassClassification = "pass" | "not_pass" | "unknown";

/**
 * Is this purchase a Pass?
 *
 * THIS IS THE ONE PLACE TO ADJUST once a real Pass purchase has been seen.
 *
 * Until then it is deliberately cautious in both directions. "Pass" appearing
 * in what was bought is the only positive signal available, and an explicit
 * recurrence means Optix is billing this repeatedly, which a Pass never is. A
 * purchase matching neither is left "unknown" rather than discarded, because
 * silently dropping the very event we are trying to capture is the one failure
 * that would look like nothing arriving at all.
 */
export function classifyPassPurchase(purchase: Pick<OptixPurchase, "descriptor" | "recurrence">): PassClassification {
  if (/\bpass(es)?\b/i.test(purchase.descriptor)) return "pass";
  const recurrence = purchase.recurrence.toLowerCase();
  if (recurrence && !/^(none|once|one[-_ ]?time|single)$/.test(recurrence)) return "not_pass";
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

/** The client this purchase belongs to, by email only — same rule as bookings. */
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
      member_email: purchase.memberEmail || null,
      member_name: purchase.memberName || null,
      person_id: personId,
      item_name: purchase.itemName || null,
      amount_cents: purchase.amountCents,
      currency: purchase.currency || null,
      purchased_at: purchase.purchasedAt || now,
      is_pass: classification === "pass",
      classification,
      payload_json: payload,
      updated_at: now,
    }]),
  });
  return { classification, isPass: classification === "pass", personId, purchase };
}
