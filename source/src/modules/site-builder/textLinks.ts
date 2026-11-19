// Links inside a section's words.
//
// Text stays plain text: a link is written [the words](the address), and a
// bare web address (https://…) is a link as it stands. The address is passed
// through cleanSiteHref, the same rule as every button, so a page of the site
// (page:about), a #block, mailto:, tel: and http(s) work, and anything else
// (javascript:, data:) is left as the words it was written as.

import { cleanSiteHref } from "../../../netlify/functions/_shared/site/document.mts";

export type TextPart = string | { text: string; href: string };

// [words](address), or a bare http(s) address.
const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)|https?:\/\/[^\s<>()\[\]]+/g;

/** One line of words, split into plain runs and links. */
export function textParts(line: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of line.matchAll(LINK)) {
    let whole = match[0];
    let text: string;
    let href: string;
    if (match[1] !== undefined) {
      text = match[1];
      href = cleanSiteHref(match[2]);
    } else {
      // A full stop or comma after a bare address ends the sentence, not the address.
      whole = whole.replace(/[.,;:!?'"]+$/, "");
      text = whole;
      href = cleanSiteHref(whole);
    }
    if (!href) continue;
    const at = match.index ?? 0;
    if (at > last) parts.push(line.slice(last, at));
    parts.push({ text, href });
    last = at + whole.length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts;
}

/** The words with a link put round `[start, end)`: the chosen words, or the address itself when none were chosen. */
export function addTextLink(value: string, start: number, end: number, href: string): { value: string; caret: number } {
  const chosen = value.slice(start, end).trim();
  const link = chosen ? `[${chosen.replace(/[[\]]/g, "")}](${href})` : `[${href}](${href})`;
  const next = value.slice(0, start) + link + value.slice(end);
  return { value: next, caret: start + link.length };
}
