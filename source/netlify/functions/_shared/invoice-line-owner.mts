/**
 * Whose lesson an invoice line is about.
 *
 * A bulk invoice is one invoice for many people: a club, a school, a parent
 * with three children. Every line on it is a different person's lesson, and
 * the invoice is tied to this client because ONE of those lines is theirs. So
 * "the invoice mentions them" is not the same question as "this line is
 * theirs", and answering the first for the second is what put fourteen other
 * people's lessons under one client's pass.
 *
 * There are two kinds of line and only one of them can be answered for
 * certain:
 *
 *   Pulled from a booking  The line carries the booking's id, the booking
 *                          carries a person, and that is the whole answer.
 *                          Settled in SQL, where it also keeps the row limit
 *                          honest -- a client on ten bulk invoices would
 *                          otherwise spend the limit on other people's rows.
 *
 *   Typed or off the shelf  Nothing links it to anybody. On the client's own
 *                          invoice that is fine: it is their invoice. On
 *                          somebody else's, the only thing left is whether the
 *                          line says their name -- which a coach billing a
 *                          club writes as a matter of course, because the
 *                          invoice is unreadable otherwise.
 *
 * This module answers the second kind. Wording again, so it is fallible, but
 * fallible in the safe direction: a line that names nobody on an invoice
 * addressed to somebody else is not evidence about this client.
 */

const FILLER = new Set(["mr", "mrs", "ms", "miss", "dr"]);

function tokenise(value: string): string[] {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((token) => token.length > 1 && !FILLER.has(token));
}

/**
 * Whether a line's wording names this person.
 *
 * Every part of the name has to be there, not just one: "Josh Bowe" and "Josh
 * little" are two clients on the same invoice, and a first name alone would
 * file each of them under the other. The description may say anything else it
 * likes around them -- "1 Hour Golf Lesson - Cindi Yu (5)" names Cindi Yu.
 */
export function descriptionNamesPerson(description: string, personName: string): boolean {
  const wanted = tokenise(personName);
  if (!wanted.length) return false;
  const said = new Set(tokenise(description));
  return wanted.every((token) => said.has(token));
}

/**
 * Whether a line with no booking behind it counts as this person's.
 *
 * `relation` is how the invoice was tied to them: "billed" their own client id
 * on it, "matched" their email address, "included" a line of theirs on an
 * invoice addressed to somebody else. Only the last one is a bulk invoice, and
 * only there does a line have to earn its place.
 *
 * A client with no name on record cannot be tested for, so nothing is hidden
 * from them -- that is the same view they got before any of this.
 */
export function unlinkedLineBelongsToPerson(
  relation: string,
  description: string,
  personName: string,
): boolean {
  if (relation !== "included") return true;
  if (!String(personName || "").trim()) return true;
  return descriptionNamesPerson(description, personName);
}
