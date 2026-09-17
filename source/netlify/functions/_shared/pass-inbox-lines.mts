/**
 * Reading a sale's wording well enough to sort it into a queue.
 *
 * An external sale names a product and nothing else useful -- lesson packages,
 * gift vouchers, a coffee, a bay hire all arrive as a string and an amount.
 * Some of those are entitlements somebody is owed and most are just money that
 * has already changed hands. Nothing on the row says which, so the wording is
 * the only signal there is.
 *
 * This file is that signal and nothing else. It decides what a line probably
 * is and refuses to act on it -- the inbox shows the guess, a coach agrees.
 * The reason is the one the pass engine is built around: a pass issued for the
 * wrong product hands somebody the wrong number of lessons, found out at the
 * counter months later, by a customer.
 *
 * Used in two places now, for opposite purposes. The Pass Inbox uses it to
 * decide which Optix sales are worth showing at full size. The client's Passes
 * tab uses it on invoice lines, where nothing is issued at all and a match is
 * only ever evidence that two records are about the same thing.
 */

/** What a line looks like it is. Never what it is -- a coach decides that. */
export type InboxLineKind = "pass" | "voucher" | "unknown";

/*
 * The words, and why these words.
 *
 * Taken from the wording that already classifies Optix sales
 * (classifyPassPurchase), because the catalogue is the same catalogue: Sam's
 * packages are named "30 Minute Golf Lesson Package" -- "lesson", not "pass"
 * -- so both classify, and both have to.
 *
 * "credit" is here and "credits" is not a separate entry because the \b...s?
 * suffix covers it. "card" is deliberately absent from the voucher list: it
 * matches "Card payment", the description Stripe charges get when they carry
 * none, which would turn every unlabelled card sale into a gift voucher.
 */
const VOUCHER_WORDS = /\b(gift|giftcard|voucher(s)?|certificate(s)?)\b/i;
const PASS_WORDS = /\b(pass(es)?|lesson(s)?|package(s)?|credit(s)?|series|block(s)?)\b/i;

/**
 * What this line probably is.
 *
 * Voucher is tested first, and the order is load-bearing: "Gift voucher - 5
 * lesson package" is a voucher for a package, not a package. Issuing it as a
 * package would hand out five lessons to whoever bought it, when the whole
 * point of the gift is that somebody else redeems it later.
 *
 * Anything else is "unknown" rather than dropped. A line nobody can read is
 * still a line somebody paid for, and the one failure that looks exactly like
 * a working inbox is the one where the thing you are waiting for was silently
 * filtered out before you ever saw it. Unknown lines are folded away on screen
 * rather than hidden -- see the panel's "unlikely" disclosure.
 */
export function classifyInboxLine(description: string): InboxLineKind {
  const text = String(description || "");
  if (VOUCHER_WORDS.test(text)) return "voucher";
  if (PASS_WORDS.test(text)) return "pass";
  return "unknown";
}

/**
 * The key a "never show me this again" dismissal is filed under.
 *
 * A product, not a purchase. Waving away one month's bay-hire line only to
 * have next month's arrive is the thing that makes a queue not worth opening,
 * and the coach's actual intent -- "Extra Hour is not a pass" -- is a fact
 * about the product that stays true for every sale of it.
 *
 * Every non-alphanumeric character goes, spaces included, so "1 x Extra Hour",
 * "1x Extra Hour." and "1 X EXTRA HOUR" are one dismissal rather than three
 * that each have to be made. Whoever rings the sale up next month will not
 * reproduce the spacing, and a dismissal that survives only exact wording is
 * one the coach gets to make again.
 *
 * This is deliberately stricter than suggestPassTemplate's normaliser, which
 * keeps spaces as separators because it does substring matching and needs word
 * boundaries to mean something ("lesson" must not match "lessons10"). Nothing
 * here matches on substrings -- it is an equality check -- so a space carries
 * no information and only costs a missed dismissal.
 */
export function inboxLineType(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 160);
}

/**
 * Is this line one the coach has already said is not an entitlement?
 *
 * Takes the dismissed set rather than reading it, so the caller reads once for
 * a page of lines instead of once per line.
 */
export function isDismissedLine(description: string, dismissed: Set<string>): boolean {
  const type = inboxLineType(description);
  return Boolean(type) && dismissed.has(type);
}
