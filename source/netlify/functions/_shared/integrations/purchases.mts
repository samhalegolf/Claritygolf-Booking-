import { randomUUID } from "node:crypto";

import { integrationRequest, matchPersonByEmail, rowsOf } from "./db.mts";
import { text } from "./payload.mts";
import type { ExternalProvider, NormalizedPurchaseEvent, ProviderAdapter } from "./types.mts";

/**
 * Recording an inbound purchase as a pass purchase.
 *
 * What a provider's purchase payload looks like is the adapter's problem — this
 * file only ever sees the normalized shape. What is left here is the part that
 * is genuinely Clarity's: deciding whether a purchase is a lesson Pass, working
 * out whose it is, and storing it.
 */

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
export function classifyPassPurchase(purchase: Pick<NormalizedPurchaseEvent, "kind" | "descriptor">): PassClassification {
  if (purchase.kind === "purchase.subscription") return "not_pass";
  if (/\b(pass(es)?|lesson(s)?)\b/i.test(purchase.descriptor)) return "pass";
  return "unknown";
}

/**
 * Which Clarity account a purchase belongs to.
 *
 * A purchase event carries no workspace, so unlike a booking it cannot be
 * mapped. A provider is configured for one account, so that mapping's
 * account_id is the answer; the fallback only matters before setup has ever
 * been saved.
 */
export async function purchaseAccountId(provider: ExternalProvider) {
  const rows = await integrationRequest(
    `external_booking_mappings?provider=eq.${provider}&select=account_id&order=updated_at.desc&limit=1`,
  ).catch(() => []);
  return text(rowsOf(rows)[0]?.["account_id" as keyof object]) || "sam-hale-golf";
}

/**
 * The client this purchase belongs to, by email only — same rule as bookings.
 *
 * A provider that omits the buyer's email on sales — Optix is one — leaves the
 * purchase unlinked, showing its buyer name instead. Matching a sale on name was
 * considered and rejected: two clients sharing a name would silently attach a
 * purchase to the wrong person, and there is no signal in the payload that
 * would let anyone notice.
 */
async function resolvePurchasePerson(purchase: NormalizedPurchaseEvent, accountId: string) {
  if (!purchase.memberEmail) return null;
  const rows = await integrationRequest(
    `people?account_id=eq.${encodeURIComponent(accountId)}&email=ilike.${encodeURIComponent(purchase.memberEmail)}&select=id,name,email,phone&limit=10`,
  ).catch(() => []);
  return matchPersonByEmail(rowsOf(rows), purchase.memberEmail);
}

/**
 * Stores a purchase event as a pass purchase record.
 *
 * Keyed on event_key so a redelivered webhook updates its row rather than
 * adding a second one. The raw payload is kept on the row as well as in the
 * event log, so the Passes tab can show what actually arrived without joining
 * back to it.
 *
 * paid_at is the purchase time: the money changes hands inside the provider
 * when the sale is made, and no provider seen so far offers a later settlement
 * signal that can be tied back to a specific sale.
 */
export async function recordPassPurchase(
  adapter: ProviderAdapter,
  eventKey: string,
  payload: unknown,
  accountId?: string,
) {
  if (!adapter.normalizePurchase) {
    throw Object.assign(new Error(`${adapter.label} does not send purchase events.`), { code: "purchases_unsupported" });
  }
  const account = accountId || await purchaseAccountId(adapter.id);
  const purchase = adapter.normalizePurchase(payload);
  const classification = classifyPassPurchase(purchase);
  const personId = await resolvePurchasePerson(purchase, account);
  const now = new Date().toISOString();
  await integrationRequest("optix_pass_purchases?on_conflict=event_key", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([{
      id: randomUUID(),
      provider: adapter.id,
      account_id: account,
      event_key: eventKey,
      event_type: purchase.rawEventType,
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
