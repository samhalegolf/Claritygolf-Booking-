/**
 * "A payment of this much was this product."
 *
 * A stopgap with its eyes open. Squarespace tells Stripe nothing about what
 * was sold -- its metadata is four identifiers (`id`, `idempotencyKey`,
 * `orderId`, `websiteId`) and no product -- so until the order can be looked up
 * in Squarespace itself, the amount is the only signal there is.
 *
 * WHY THE RULES ARE THE COACH'S AND NOT THE CODE'S
 *
 * Because the data says plainly that a hard-coded amount would rot. This
 * account's gift voucher was $150 from October 2023 until 30 July 2025 and
 * $160 from 6 September 2025 onward -- not one day of overlap. A number
 * written into the source today is wrong the next time a price moves, and
 * wrong silently, which is the failure this whole area has already had once.
 *
 * A rule the coach writes can be corrected in the time it takes to notice. It
 * is also honest about what it is: the screen can say "matched on price",
 * which "Lesson Gift Voucher" appearing out of nowhere cannot.
 *
 * A price change needs no dates, because a new price is a new amount and
 * therefore a second rule with the same label. The date range exists for the
 * other case -- the same amount meaning something different later -- which is
 * rarer and much harder to spot.
 */

export type VoucherRule = {
  id: string;
  /** Matched against the amount charged, in minor units. */
  amountCents: number;
  currency: string;
  label: string;
  /** Inclusive ISO dates. Empty means unbounded on that side. */
  from: string;
  until: string;
};

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** An ISO date, or "" for anything that is not one. Never a silent today. */
function isoDate(value: unknown): string {
  const raw = text(value, 40);
  if (!raw) return "";
  const parsed = Date.parse(raw.length <= 10 ? `${raw}T00:00:00Z` : raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : "";
}

/**
 * Read a stored rule list, dropping anything unusable.
 *
 * Silently dropping is right here and wrong almost everywhere else: a rule
 * with no label or no amount cannot match anything, so keeping it would only
 * put a row on screen that does nothing. A rule that is merely *wrong* is kept
 * -- that is the coach's to fix.
 */
export function parseVoucherRules(raw: unknown): VoucherRule[] {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((entry, index) => {
      const row = (entry || {}) as Record<string, unknown>;
      const amountCents = Math.round(Number(row.amountCents) || 0);
      return {
        id: text(row.id, 60) || `rule-${index + 1}`,
        amountCents,
        currency: text(row.currency, 10).toUpperCase(),
        label: text(row.label, 120),
        from: isoDate(row.from),
        until: isoDate(row.until),
      };
    })
    .filter((rule) => rule.amountCents > 0 && rule.label);
}

/**
 * The label for this payment, or "" if no rule claims it.
 *
 * Matched on the amount *charged*, not on what is left after refunds: a
 * partly refunded $160 voucher was still a $160 purchase of that product, and
 * matching the net would quietly stop recognising exactly the sales most
 * likely to need looking at.
 *
 * Currency is compared only when the rule names one, so a rule written before
 * anybody thought about currency keeps working on a single-currency account.
 * The first matching rule wins, so the list is the coach's own precedence.
 */
export function matchVoucherRule(
  payment: { amountCents: number; currency?: string; when?: string },
  rules: VoucherRule[],
): VoucherRule | null {
  const day = isoDate(payment.when);
  for (const rule of rules) {
    if (rule.amountCents !== payment.amountCents) continue;
    if (rule.currency && payment.currency && rule.currency !== payment.currency.toUpperCase()) continue;
    // An undated payment is only ever claimed by an undated rule: guessing it
    // into a range is how a 2023 sale gets this year's product name.
    if ((rule.from || rule.until) && !day) continue;
    if (rule.from && day < rule.from) continue;
    if (rule.until && day > rule.until) continue;
    return rule;
  }
  return null;
}
