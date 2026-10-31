// Where a public booking URL points: which business, and which of its screens.
//
// Kept as a small shared public-booking concern rather than importing App.
// Legacy rows without bookingScreenIds default to main; an explicit empty list
// means the service is not shown anywhere.
//
// The URL is /<business>/<screen>. The business used to be absent: the path
// only picked a screen, and the server answered every public call with "the
// only live business". That made the original workspace's slug the one every
// tenant's embed code carried, and gave no other tenant a booking page at all.
// Bare legacy links (/, /group-lessons, /private-lessons) still mean "no
// business named", which the server resolves exactly as before.
import { isBookingEmbedMode } from "../shared/bookingHandoff";

const SCREEN_SEGMENTS = new Set<string>(["group-lessons", "private-lessons"]);

function pathSegments(pathname = "") {
  return pathname
    .trim()
    .toLowerCase()
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/** The business and screen a public booking path names. */
export function publicBookingRoute(pathname = window.location.pathname): { business: string; screenId: string } {
  const [first = "", second = ""] = pathSegments(pathname);
  if (!first) return { business: "", screenId: "main" };
  if (SCREEN_SEGMENTS.has(first)) return { business: "", screenId: first };
  return { business: first, screenId: SCREEN_SEGMENTS.has(second) ? second : "main" };
}

/**
 * The business whose shop this path is, or "". The shop sits beside the
 * booking page at /<business>/shop. It needs the business named: it takes
 * money, and there is no "the only business" guess for that.
 */
export function publicShopBusiness(pathname = window.location.pathname) {
  const [first = "", second = "", third = ""] = pathSegments(pathname);
  return first && !SCREEN_SEGMENTS.has(first) && second === "shop" && !third ? first : "";
}

/**
 * The business whose website page this path is, or "". The page sits beside
 * the booking page and the shop at /<business>/site, on any of Clarity's own
 * hosts. A business's own domain serves the same page at its root instead.
 */
export function publicSiteBusiness(pathname = window.location.pathname) {
  const [first = "", second = "", third = ""] = pathSegments(pathname);
  return first && !SCREEN_SEGMENTS.has(first) && second === "site" && !third ? first : "";
}

/** The shop's path, keeping whatever query the page was opened with (?embed=booking). */
export function publicShopHref(business: string, search = typeof window === "undefined" ? "" : window.location.search) {
  return `/${business}/shop${search}`;
}

/** The path a business's booking screen lives at. */
export function publicBookingPath(business: string, screenId: string) {
  const base = business ? `/${business}` : "";
  return screenId === "main" ? base || "/" : `${base}/${screenId}`;
}

export function currentPublicBookingScreenId(pathname = window.location.pathname) {
  return publicBookingRoute(pathname).screenId;
}

export function appearsOnCurrentPublicBookingScreen(service: { bookingScreenIds?: string[] }, pathname = window.location.pathname) {
  return (service.bookingScreenIds ?? ["main"]).includes(currentPublicBookingScreenId(pathname));
}

/**
 * A public API path, carrying the business this booking page belongs to.
 *
 * Only on the booking page itself: the coach app has its own routes (/settings
 * and so on) that are not business slugs, and it resolves its account from the
 * session anyway.
 */
export function publicApi(path: string, pathname = typeof window === "undefined" ? "/" : window.location.pathname) {
  if (typeof window === "undefined" || !isBookingEmbedMode()) return path;
  const { business } = publicBookingRoute(pathname);
  return business ? withBusiness(path, business) : path;
}

/**
 * A public API path naming its business outright. The Player Portal uses this:
 * it is not on a business's booking URL, but its session already knows which
 * business the player belongs to.
 */
export function withBusiness(path: string, business: string) {
  const [base, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  params.set("business", business);
  return `${base}?${params.toString()}`;
}
