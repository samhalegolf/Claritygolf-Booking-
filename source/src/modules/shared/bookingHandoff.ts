// Values the admin app and the player portal both have to agree on.
//
// These used to be declared twice -- once in App.tsx and once in
// PlayerPortal.tsx with a "must match src/App.tsx" comment above each. A
// comment is not a guarantee: change the anchor Monday in one file and every
// booking the portal shows silently shifts by a week. One declaration, two
// importers, nothing to keep in sync.

/** The booking embed is selected by ?embed=booking on any host. */
export const BOOKING_EMBED_PARAM = "embed";
export const BOOKING_EMBED_VALUE = "booking";

/** The public booking host serves the embed with no parameter at all. */
export const PUBLIC_BOOKING_HOST = "book.claritygolf.app";

/**
 * Where the portal leaves the player's details for the booking embed to read
 * on mount. Same-origin localStorage rather than a query string, so personal
 * data never appears in a URL, a browser history entry, or a server log.
 */
export const BOOKING_LOGIN_STORAGE_KEY = "clarity-booking-login";

/**
 * The anchor Monday. `calendar_items` store `week` as an absolute offset from
 * this date, so turning a booking's (week, day, start) back into a real date
 * requires the same anchor everywhere.
 */
export const BASE_WEEK_START = new Date(2026, 5, 1);

/**
 * True when this page load is the public booking widget rather than either
 * signed-in app. The entry point checks this before it checks for a session --
 * the widget is public, and a signed-in player handing off to book has to reach
 * it too.
 */
export function isBookingEmbedMode(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.location.hostname === PUBLIC_BOOKING_HOST ||
    new URLSearchParams(window.location.search).get(BOOKING_EMBED_PARAM) ===
      BOOKING_EMBED_VALUE
  );
}

/** Turns a stored (week, day, start-minute) triple into a local Date. */
export function slotDate(week: number, day: number, startMinutes: number): Date {
  const date = new Date(BASE_WEEK_START);
  date.setDate(BASE_WEEK_START.getDate() + week * 7 + day);
  date.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0);
  return date;
}

export type BookingHandoffDetails = {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
};

/** Writes the player's details where the booking embed will find them. */
export function storeBookingHandoff(details: BookingHandoffDetails) {
  try {
    window.localStorage.setItem(BOOKING_LOGIN_STORAGE_KEY, JSON.stringify(details));
  } catch {
    // If storage is unavailable the player can still fill the form manually.
  }
}

/** Sends the browser to the booking embed on this origin. */
export function openBookingEmbed() {
  const url = new URL(window.location.href);
  url.searchParams.delete("portal");
  url.searchParams.set(BOOKING_EMBED_PARAM, BOOKING_EMBED_VALUE);
  window.location.href = url.toString();
}
