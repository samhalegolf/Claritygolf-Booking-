import { randomUUID } from "node:crypto";

import { createExternalPerson, integrationRequest, matchPersonByEmail, matchPersonByExactName, rowsOf } from "./db.mts";
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
    `external_booking_mappings?provider=eq.${provider}&select=account_id`,
  ).catch(() => []);
  const accounts = new Set(
    rowsOf(rows)
      .map((row) => text(row["account_id" as keyof object]))
      .filter(Boolean),
  );
  // Exactly one business has this provider mapped: unambiguous, so use it.
  // Two or more and there is no way to tell whose purchase this is from the
  // payload alone -- this used to take the most recently updated mapping and,
  // failing that, the literal "sam-hale-golf", so a second business's pass
  // purchases would have been filed against the first.
  if (accounts.size === 1) return [...accounts][0];
  return "";
}

/** How a purchase came to be attached to the client it is attached to. */
export type PersonLinkSource = "email" | "name" | "new" | "";

/**
 * The client this purchase belongs to, and how confidently.
 *
 * Three answers, in descending order of certainty, and the caller records
 * which one was used so the weakest is never mistaken for the strongest:
 *
 *   email  the buyer's address matched exactly one client. Certain.
 *   name   no email in the payload at all — true of every Optix product sale —
 *          and exactly one client carries that name. Good, not certain.
 *   new    neither matched, so a fresh external booking client is filed for an
 *          admin to merge or promote.
 *
 * The name step is the deliberate exception to "names are never matched",
 * added because Optix sales carry a display name and nothing else, so without
 * it a purchase from a client Clarity already knows would sit unlinked forever
 * and every repeat buyer would breed another duplicate to merge. It keeps the
 * discipline that makes email matching safe — exactly one candidate or no
 * answer — so an account holding two clients of the same name gets "new"
 * rather than a coin flip.
 */
async function resolvePurchasePerson(
  purchase: NormalizedPurchaseEvent,
  accountId: string,
  provider: string,
): Promise<{ personId: string | null; linkSource: PersonLinkSource }> {
  const account = encodeURIComponent(accountId);
  if (purchase.memberEmail) {
    const rows = await integrationRequest(
      `people?account_id=eq.${account}&email=ilike.${encodeURIComponent(purchase.memberEmail)}&select=id,name,email,phone&limit=10`,
    ).catch(() => []);
    const matched = matchPersonByEmail(rowsOf(rows), purchase.memberEmail);
    if (matched) return { personId: matched, linkSource: "email" };
  }
  // Nothing to file an external person under — the descriptor never resolved
  // a name (seen on plan subscriptions with no subscriber on the payload).
  // The purchase itself is still recorded; it just has no client link.
  if (!purchase.memberName) return { personId: null, linkSource: "" };

  const byName = await integrationRequest(
    `people?account_id=eq.${account}&name=ilike.${encodeURIComponent(purchase.memberName)}&select=id,name,email,phone&limit=10`,
  ).catch(() => []);
  const named = matchPersonByExactName(rowsOf(byName), purchase.memberName);
  if (named) return { personId: named, linkSource: "name" };

  const created = await createExternalPerson(accountId, provider, {
    name: purchase.memberName,
    email: purchase.memberEmail || null,
  });
  return { personId: created, linkSource: "new" };
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
  const account = accountId || (await purchaseAccountId(adapter.id));
  if (!account) {
    throw Object.assign(
      new Error(
        `${adapter.label} purchase events cannot be attributed to a business: ` +
          "either no workspace mapping exists, or more than one business has one.",
      ),
      { code: "purchase_account_ambiguous" },
    );
  }
  const purchase = adapter.normalizePurchase(payload);
  const classification = classifyPassPurchase(purchase);
  const { personId, linkSource } = await resolvePurchasePerson(purchase, account, adapter.id);
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
      person_link_source: linkSource || null,
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
  return { classification, isPass: classification === "pass", personId, linkSource, purchase };
}
