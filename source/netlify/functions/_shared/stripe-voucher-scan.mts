/**
 * Finding the gift vouchers in a pile of Stripe charges.
 *
 * WHY THIS CANNOT READ THE DATABASE
 *
 * Squarespace sells the voucher, Stripe takes the money, and the billing sync
 * mirrors that charge into billing_invoices. But it mirrors it through
 * mapChargeLine, which writes `charge.description` as the line -- and Stripe's
 * own description for these is the literal "Charge for <email>". Every one of
 * the account's 102 synced charges says that and nothing else. The product
 * name never reaches the database at all.
 *
 * That is why the old importer could not work and why no amount of cleverness
 * over billing_invoice_items would have fixed it: the wording it needed had
 * already been thrown away upstream. So this goes back to Stripe and reads the
 * charge itself.
 *
 * WHERE THE WORDING ACTUALLY IS
 *
 * Not known for certain, and deliberately not guessed at. Squarespace clearly
 * writes metadata -- the sync already pulls an order number out of
 * `metadata.orderId` -- but which key carries the item name is its business and
 * could change. So rather than naming a key, this reads every string on the
 * charge and its payment intent: descriptions, statement descriptors, and every
 * metadata value whatever it is called.
 *
 * The cost of that breadth is false positives, and they are paid for by never
 * acting alone: a candidate is shown with the exact text it matched on, and a
 * coach presses the button. The alternative -- naming `metadata.itemName` and
 * being wrong -- is a screen that silently finds nothing, which is precisely
 * the failure this replaces.
 */

import { classifyInboxLine } from "./pass-inbox-lines.mts";

/** One string found on a charge, and where it came from. */
export type ChargeWording = { text: string; source: string };

function push(into: ChargeWording[], text: unknown, source: string) {
  const clean = typeof text === "string" ? text.trim().slice(0, 300) : "";
  // "Charge for someone@example.com" is Stripe's own filler when a charge
  // carries no description of its own. It is on every one of these and says
  // nothing, so it is dropped here rather than offered as a name -- a
  // candidate list where every row reads "Charge for ..." is unreadable.
  if (!clean || /^charge for \S+@\S+$/i.test(clean)) return;
  if (into.some((entry) => entry.text.toLowerCase() === clean.toLowerCase())) return;
  into.push({ text: clean, source });
}

function pushMetadata(into: ChargeWording[], metadata: unknown, prefix: string) {
  if (!metadata || typeof metadata !== "object") return;
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
    // The order number is already used as the receipt number and is a number,
    // not a name; including it would make every charge look like it has
    // wording when it has none.
    if (/^order_?id$/i.test(key)) continue;
    push(into, value, `${prefix}.${key}`);
  }
}

/**
 * Every string on this charge that could be a product name, best first.
 *
 * Ordered by how likely it is to be what a human would call the thing sold:
 * the charge's own description beats the payment intent's, and both beat
 * metadata, which is machine-written and may hold anything.
 */
export function chargeWording(charge: Record<string, unknown>): ChargeWording[] {
  const found: ChargeWording[] = [];
  const intent =
    charge.payment_intent && typeof charge.payment_intent === "object"
      ? (charge.payment_intent as Record<string, unknown>)
      : null;

  push(found, charge.description, "description");
  if (intent) push(found, intent.description, "payment intent");
  push(found, charge.statement_descriptor, "statement descriptor");
  pushMetadata(found, charge.metadata, "charge");
  if (intent) pushMetadata(found, intent.metadata, "payment intent");
  return found;
}

/**
 * The best name this charge has for what was sold, or "" if it has none.
 *
 * Used by the billing sync as well as the voucher scan, so a card payment
 * stops being mirrored into billing_invoice_items as "Charge for <email>" --
 * which is what every one of them said, and why nothing downstream could ever
 * tell a gift voucher from a lesson.
 *
 * Returns "" rather than a placeholder so the caller decides what to show when
 * a charge genuinely carries nothing. A helpful-sounding default invented here
 * would be indistinguishable from a real product name one row later.
 */
export function chargeProductName(
  charge: Record<string, unknown>,
  extra: ChargeWording[] = [],
): string {
  // The charge's own wording first: a description somebody wrote about this
  // sale beats a basket line, which is the catalogue's wording for the product
  // in general.
  return (chargeWording(charge)[0] || extra[0])?.text || "";
}

/**
 * A GET against Stripe, supplied by the caller.
 *
 * Injected rather than imported because the two callers hold different keys.
 * The billing sync runs on the deployment's STRIPE_SECRET_KEY; billing-api
 * resolves the business's own key through stripeFor(accountId), which is the
 * whole point of that function -- a second business's charges must never be
 * read with the first one's credential. A module that reached for one of them
 * would quietly be wrong for the other.
 */
export type StripeGet = (path: string, params: URLSearchParams) => Promise<any>;

/** The id of a Stripe reference that may or may not have been expanded. */
function idOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const id = (value as Record<string, unknown>).id;
    return typeof id === "string" ? id : "";
  }
  return "";
}

/**
 * What a Checkout Session says was in the basket.
 *
 * The last place a product name can be, and the only one that survives when
 * the charge itself carries nothing -- which is every Squarespace sale in this
 * account, all of which read "Charge for <email>" and hold no useful metadata.
 *
 * Two requests, and only for charges that needed them: sessions are found by
 * the payment intent they settled, then their line items read. The line items
 * are asked for separately rather than expanded on the list, because `expand`
 * on a list endpoint is silently dropped by Stripe when the field is not
 * expandable there, and a silent drop here would look exactly like "this sale
 * had no line items" -- the failure mode this whole feature exists to stop
 * repeating.
 *
 * Any Stripe failure returns nothing rather than throwing. A charge whose
 * session cannot be read is a charge with no name, which is a state the
 * callers already handle; it is not a reason to abandon a sync of three
 * hundred others.
 */
export async function checkoutLineItemWording(
  charge: Record<string, unknown>,
  get: StripeGet,
): Promise<ChargeWording[]> {
  const intentId = idOf(charge.payment_intent);
  if (!intentId) return [];
  try {
    const sessions = (await get(
      "checkout/sessions",
      new URLSearchParams({ payment_intent: intentId, limit: "1" }),
    )) as { data?: Array<Record<string, unknown>> };
    const session = Array.isArray(sessions?.data) ? sessions.data[0] : undefined;
    const sessionId = idOf(session);
    if (!sessionId) return [];

    const items = (await get(
      `checkout/sessions/${encodeURIComponent(sessionId)}/line_items`,
      new URLSearchParams({ limit: "10" }),
    )) as { data?: Array<Record<string, unknown>> };

    const found: ChargeWording[] = [];
    for (const item of Array.isArray(items?.data) ? items.data : []) {
      push(found, item?.description, "basket");
    }
    return found;
  } catch {
    return [];
  }
}

/** Run an async job over a list a few at a time.
 *
 * Sequential is too slow to fit a function timeout once there are a hundred
 * charges to look up, and unbounded parallelism is how an account gets rate
 * limited by Stripe halfway through a sync. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  job: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await job(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export type VoucherVerdict = {
  /** The wording this was judged on, or "" when the charge carried none. */
  label: string;
  /** Which field it came from, so a coach can see why it matched. */
  labelSource: string;
  /** The classifier recognised a voucher in it. */
  likely: boolean;
};

/**
 * Does this charge look like somebody bought a gift voucher?
 *
 * Runs the same wording classifier the Pass Inbox uses, over every string the
 * charge carries rather than one nominated field. The first string that reads
 * as a voucher wins and is reported; failing that, the best available wording
 * is still returned with likely = false, because a charge whose name nothing
 * recognised is exactly the one a coach may need to look at by hand.
 */
export function voucherVerdict(
  charge: Record<string, unknown>,
  extra: ChargeWording[] = [],
): VoucherVerdict {
  const wording = [...chargeWording(charge), ...extra];
  for (const entry of wording) {
    if (classifyInboxLine(entry.text) === "voucher") {
      return { label: entry.text, labelSource: entry.source, likely: true };
    }
  }
  const first = wording[0];
  return { label: first?.text || "", labelSource: first?.source || "", likely: false };
}

/**
 * Is this charge worth offering at all?
 *
 * Succeeded and not refunded to nothing. A fully refunded voucher purchase is
 * money that went back; minting a code for it hands out value that was
 * returned, and no amount of confirming makes that a thing a coach meant.
 */
export function chargeIsClaimable(charge: Record<string, unknown>): boolean {
  if (String(charge?.status) !== "succeeded") return false;
  const amount = Number(charge?.amount) || 0;
  const refunded = Number(charge?.amount_refunded) || 0;
  return amount > 0 && refunded < amount;
}

/** What the voucher is worth: what was paid, less anything already given back. */
export function chargeValueCents(charge: Record<string, unknown>): number {
  const captured = Number(charge?.amount_captured);
  const base = Number.isFinite(captured) && captured > 0 ? captured : Number(charge?.amount) || 0;
  return Math.max(0, base - (Number(charge?.amount_refunded) || 0));
}
