import { t } from "../../lib/i18n";
import { BOOKING_EMBED_PARAM, BOOKING_EMBED_VALUE, PUBLIC_BOOKING_HOST } from "../shared/bookingHandoff";
import { currentPublicBookingScreenId, publicBookingPath } from "./bookingScreen";

/**
 * The public booking screens a business can publish (lessons, groups, video
 * review and so on): their paths, public links and embed code.
 */

const BOOKING_LOGO_PARAM = "logo";
const CLARITY_BOOKING_HOSTS = new Set(["claritygolf.app", "booking.claritygolf.app", PUBLIC_BOOKING_HOST]);
type BookingScreenDefinition = {
  id: string;
  label: string;
  path: string;
};
export const BOOKING_SCREENS = [
  { id: "main", label: t("Main booking screen") },
  { id: "group-lessons", label: t("Group Lessons") },
  { id: "private-lessons", label: t("Private Lessons") },
] as const;
// A screen's public path is /<business>/<screen>, so it is worked out per
// account -- see publicBookingPath. It used to be a constant, which is how the
// original workspace's slug ended up in every tenant's embed code.
export function bookingScreenPathsFor(business: string): BookingScreenDefinition[] {
  return BOOKING_SCREENS.map((screen) => ({ ...screen, path: publicBookingPath(business, screen.id) }));
}

export function getBookingScreenPublicUrl(path: string, showLogo: boolean) {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  if (CLARITY_BOOKING_HOSTS.has(url.hostname)) {
    url.protocol = "https:";
    url.hostname = PUBLIC_BOOKING_HOST;
    url.pathname = normalizeBookingPath(path);
  } else {
    url.pathname = normalizeBookingPath(path);
  }
  url.searchParams.set(BOOKING_EMBED_PARAM, BOOKING_EMBED_VALUE);
  if (showLogo) {
    url.searchParams.delete(BOOKING_LOGO_PARAM);
  } else {
    url.searchParams.set(BOOKING_LOGO_PARAM, "0");
  }
  return url.toString();
}

export function getBookingScreenIframeCode(path: string, businessName: string, screenName: string, showLogo: boolean) {
  const bookingScreenUrl = getBookingScreenPublicUrl(path, showLogo);
  return `<iframe src="${bookingScreenUrl}" title="${businessName} ${screenName} booking" width="100%" height="760" style="border:0;max-width:100%;border-radius:18px;overflow:hidden;background:transparent;" loading="lazy"></iframe>`;
}

export function isBookingLogoHiddenByUrl() {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get(BOOKING_LOGO_PARAM) === "0";
}

function normalizeBookingPath(pathname = "") {
  const cleaned = pathname.trim().toLowerCase();
  if (!cleaned || cleaned === "/") return "/";
  return `/${cleaned.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\/+/g, "/")}`;
}

export function getBookingScreenId(pathname = "") {
  return currentPublicBookingScreenId(pathname);
}

/**
 * The booking screens a lesson type appears on.
 *
 * Unrecognised ids are KEPT. Mirrors cleanBookingScreenIds in booking-core.mts,
 * and for the same reason: this runs on load as well as save, so filtering
 * against the known-screen list meant a load-and-save round trip quietly
 * deleted any id this build did not recognise -- and the lesson type dropped
 * off the public booking page with nothing reported.
 *
 * Filtering belongs at render, where the page already matches on the screen it
 * is showing and an unknown id simply never matches.
 *
 * A missing field means legacy data, which defaults to the main screen. An
 * explicit empty list means "show on no booking screens" and is preserved.
 */
export function normalizeBookingScreenIds(value: unknown): string[] {
  if (!Array.isArray(value)) return ["main"];
  const cleaned = value
    .map((candidate) => (typeof candidate === "string" ? candidate.trim().slice(0, 80) : ""))
    .filter((candidate) => candidate.length > 0);
  return Array.from(new Set(cleaned)).slice(0, 24);
}

export function formatBookingScreenLabels(screenIds: string[] = []) {
  return screenIds
    .map((screenId) => BOOKING_SCREENS.find((screen) => screen.id === screenId)?.label || screenId)
    .filter(Boolean);
}
