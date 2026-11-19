// Words drawn with their links (see textLinks): every paragraph of a section,
// in the renderer and the free layout alike, goes through LinkedLine.

import type { AnchorHTMLAttributes } from "react";
import { createContext, useContext } from "react";
import { textParts } from "./textLinks";

/** How the page draws a link: a page of the site, or somewhere else. Set by SiteRenderer. */
export const TextLinks = createContext<((href: string) => AnchorHTMLAttributes<HTMLAnchorElement>) | null>(null);

export function LinkedLine({ text }: { text: string }) {
  const linkProps = useContext(TextLinks);
  return (
    <>
      {textParts(text).map((part, index) =>
        typeof part === "string" ? (
          part
        ) : (
          <a key={index} className="site-text-link" {...(linkProps ? linkProps(part.href) : { href: part.href })}>
            {part.text}
          </a>
        ),
      )}
    </>
  );
}
