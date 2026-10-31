// How a page's theme becomes CSS, and where its booking links point.
//
// The stylesheet (site.css) reads --site-* custom properties and nothing
// else, so the whole look of a page is this one style object on its root.
// The same object drives the editor's preview and the public page.

import type { CSSProperties } from "react";
import { HOME_PAGE_SLUG, googleFontsUrl, siteFont, type SiteBookingScreen, type SiteTheme } from "../../../netlify/functions/_shared/site/document.mts";
import { BOOKING_EMBED_PARAM, BOOKING_EMBED_VALUE, PUBLIC_BOOKING_HOST } from "../shared/bookingHandoff";
import { publicBookingPath } from "../public-booking/bookingScreen";

const RADIUS = { sharp: "2px", soft: "12px", round: "24px" } as const;
const WIDTH = { narrow: "860px", regular: "1120px", wide: "1360px" } as const;
const SECTION_GAP = { compact: "40px", regular: "72px", airy: "112px" } as const;

/** sRGB luminance, enough to decide whether a surface is light or dark. */
function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
  const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The custom properties site.css reads, as an inline style for the page root. */
export function siteThemeStyle(theme: SiteTheme): CSSProperties {
  const dark = luminance(theme.colors.background) < 0.3;
  return {
    "--site-bg": theme.colors.background,
    "--site-surface": theme.colors.surface,
    "--site-text": theme.colors.text,
    "--site-muted": theme.colors.muted,
    "--site-primary": theme.colors.primary,
    "--site-on-primary": theme.colors.onPrimary,
    "--site-accent": theme.colors.accent,
    // A hairline that reads on the page's own background, light or dark.
    "--site-line": dark ? "rgba(255, 255, 255, 0.14)" : "rgba(0, 0, 0, 0.1)",
    "--site-heading-font": siteFont(theme.headingFont).family,
    "--site-body-font": siteFont(theme.bodyFont).family,
    "--site-radius": RADIUS[theme.corners],
    "--site-max-width": WIDTH[theme.width],
    "--site-section-gap": SECTION_GAP[theme.spacing],
    colorScheme: dark ? "dark" : "light",
  } as CSSProperties;
}

/** The classes the root wears for the theme's choices that are not plain values. */
export function siteThemeClassName(theme: SiteTheme): string {
  return `site-root site-buttons-${theme.buttons}`;
}

export { googleFontsUrl };

/**
 * The business's booking page, for every "Book" button and the booking
 * block's frame. Always the booking host: a page on the business's own domain
 * cannot serve the widget itself, and a page previewed inside the coach app
 * must not point at the coach app.
 */
export function bookingPageUrl(businessSlug: string, screen: SiteBookingScreen = "main"): string {
  const url = new URL(`https://${PUBLIC_BOOKING_HOST}${publicBookingPath(businessSlug, screen)}`);
  url.searchParams.set(BOOKING_EMBED_PARAM, BOOKING_EMBED_VALUE);
  return url.toString();
}

/** The business's shop page on Clarity's own address, for a shop block that frames it. */
export function shopPageUrl(businessSlug: string): string {
  const url = new URL(`https://${PUBLIC_BOOKING_HOST}/${businessSlug}/shop`);
  url.searchParams.set(BOOKING_EMBED_PARAM, BOOKING_EMBED_VALUE);
  return url.toString();
}

/** Where a published page can be seen on Clarity's own address. */
export function publicSitePath(businessSlug: string, pageSlug = HOME_PAGE_SLUG): string {
  return pageSlug === HOME_PAGE_SLUG ? `/${businessSlug}/site` : `/${businessSlug}/site/${pageSlug}`;
}

/** Where a page lives on the business's own domain: the root, or one segment. */
export function customDomainPagePath(pageSlug: string): string {
  return pageSlug === HOME_PAGE_SLUG ? "/" : `/${pageSlug}`;
}
