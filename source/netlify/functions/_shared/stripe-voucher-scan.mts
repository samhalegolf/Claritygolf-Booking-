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
export function chargeProductName(charge: Record<string, unknown>): string {
  return chargeWording(charge)[0]?.text || "";
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
export function voucherVerdict(charge: Record<string, unknown>): VoucherVerdict {
  const wording = chargeWording(charge);
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
