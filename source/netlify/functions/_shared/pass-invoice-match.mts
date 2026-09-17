/**
 * Deciding that an invoice line and a pass are about the same thing.
 *
 * A pass says what somebody is entitled to. An invoice line says what they
 * were billed for. Nothing joins the two -- the pass was created by hand under
 * a person's name, the line arrived from Stripe or was typed onto an invoice,
 * and neither carries the other's id. The only thing they share is wording,
 * written twice by people who were not trying to make them match.
 *
 * So this is a similarity score, and it is deliberately generous. It is not
 * deciding anything: nothing is issued, spent or reconciled on the strength of
 * a match. It puts two records side by side so a coach can see whether they
 * agree. A miss costs a line that should have been shown; there is no
 * equivalent of issuing the wrong number of credits here, which is why the bar
 * is far lower than suggestPassTemplate's and why "loose" is a result rather
 * than a refusal.
 *
 * WHAT IS NOT GENEROUS
 *
 * Numbers. "30 Minute Golf Lesson" and "60 Minute Golf Lesson" share every
 * word that matters and are not the same product -- they are the exact pair a
 * coach opens this screen to tell apart. So a disagreement in digits is a
 * refusal, not a lower score, however well the words line up. That is the one
 * place being lenient would make the evidence worse than no evidence.
 */

export type InvoiceMatchStrength = "exact" | "close" | "loose";

/**
 * Words that say nothing about which product this is.
 *
 * Kept short on purpose. Every entry here is a word that, if it were counted,
 * would let two unrelated lines agree on filler -- but a list that grows past
 * the obvious starts deciding that real product words are noise.
 */
const FILLER = new Set(["the", "a", "an", "of", "for", "and", "x", "with", "to", "on", "in"]);

/** Crude but symmetric: both sides get the same treatment, which is all that
 *  matters when the two strings were written by different people. */
function stem(token: string) {
  return token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token;
}

function tokenise(value: string): string[] {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((token) => token && !FILLER.has(token))
    .map(stem);
}

function digits(tokens: string[]): string[] {
  return tokens.filter((token) => /^\d+$/.test(token));
}

/** Dice coefficient over the two token sets: twice the overlap, over the total
 *  size. Chosen over plain overlap because it does not reward a line simply
 *  for being long -- "60 Minute Golf Lesson Package with Club Fitting and Video
 *  Review" should not out-score the package it actually is. */
function dice(left: string[], right: string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

/**
 * How strongly this invoice line looks like this pass, or null for not at all.
 *
 *   exact  the same words, once case, punctuation and plurals are set aside.
 *   close  one name contains the other, or four words in five agree -- an
 *          invoice line with a prefix, a suffix, or a slightly different name
 *          for the same package.
 *   loose  enough in common to be worth a look, and not enough to assume.
 *
 * The caller shows all three and labels which is which. A coach reconciling
 * wants the loose ones visible: a line worded nothing like the pass is exactly
 * where a mis-billing hides.
 */
export function invoiceMatchStrength(
  lineDescription: string,
  passName: string,
): InvoiceMatchStrength | null {
  const line = tokenise(lineDescription);
  const pass = tokenise(passName);
  if (!line.length || !pass.length) return null;

  // A 30 and a 60 are different products however well the words agree. Only
  // applied when both sides name a number -- a pass called "Lesson Pack" and a
  // line called "5 Lesson Pack" should still meet.
  const lineDigits = digits(line);
  const passDigits = digits(pass);
  if (lineDigits.length && passDigits.length) {
    if (!lineDigits.some((digit) => passDigits.includes(digit))) return null;
  }

  const lineKey = line.join(" ");
  const passKey = pass.join(" ");
  if (lineKey === passKey) return "exact";
  if (lineKey.includes(passKey) || passKey.includes(lineKey)) return "close";

  const score = dice(line, pass);
  if (score >= 0.8) return "close";
  if (score >= 0.45) return "loose";
  return null;
}

/**
 * The best match among several passes, so one line is filed under one pass.
 *
 * A line landing under every pass whose name it half-resembles would turn the
 * evidence into noise -- and a coach reading "billed 6 times" under a 5-credit
 * pass needs that count to mean something. Ties break towards the pass named
 * first, which the caller orders newest-first, because a repeat purchase of
 * the same package should show against the one still being used.
 */
const RANK: Record<InvoiceMatchStrength, number> = { exact: 3, close: 2, loose: 1 };

export function bestPassForLine<T extends { id: string; name: string }>(
  lineDescription: string,
  passes: T[],
): { pass: T; strength: InvoiceMatchStrength } | null {
  let best: { pass: T; strength: InvoiceMatchStrength } | null = null;
  for (const pass of passes) {
    const strength = invoiceMatchStrength(lineDescription, pass.name);
    if (!strength) continue;
    if (!best || RANK[strength] > RANK[best.strength]) best = { pass, strength };
  }
  return best;
}
