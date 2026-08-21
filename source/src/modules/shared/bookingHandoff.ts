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

/**
 * Marks a booking page load as entered from the signed-in Player Terminal.
 *
 * The parameter is a request, not a grant. The entry point still asks the
 * server who is signed in, and anyone who is not a player gets the ordinary
 * public widget -- so a shared or edited URL can never turn into an identity.
 */
export const PLAYER_BOOKING_PARAM = "portal";
export const PLAYER_BOOKING_VALUE = "player";

/**
 * The coach's no-login view of a guest submission: ?videoShare=<token>.
 *
 * A query-param mode rather than a path, matching every other entry this app
 * has (?embed=booking, ?portal=player, ?portalInvite=, ?reset=). netlify.toml
 * already sends /* to index.html and there is no router, so a path would need
 * its own redirect and would still land in the same entry point.
 */
export const VIDEO_SHARE_PARAM = "videoShare";

export function videoShareToken(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get(VIDEO_SHARE_PARAM) ?? "";
}

export function isVideoShareMode(): boolean {
  return Boolean(videoShareToken());
}

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

/** Which of the two ways into the booking widget this page load is. */
export type BookingEntryMode = "public" | "player";

/**
 * True when the booking widget was opened from the Player Terminal. Same
 * widget, same booking flow -- it just already knows who is booking, so the
 * player is never asked to identify themselves a second time.
 */
export function isPlayerBookingMode(): boolean {
  if (!isBookingEmbedMode()) return false;
  return (
    new URLSearchParams(window.location.search).get(PLAYER_BOOKING_PARAM) ===
    PLAYER_BOOKING_VALUE
  );
}

/** True for the ordinary public widget: no session needed, none assumed. */
export function isPublicBookingEmbedMode(): boolean {
  return isBookingEmbedMode() && !isPlayerBookingMode();
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

/** Sends the browser to the public booking embed on this origin. */
export function openBookingEmbed() {
  const url = new URL(window.location.href);
  // Public booking must never inherit a player entry from the current URL.
  url.searchParams.delete(PLAYER_BOOKING_PARAM);
  url.searchParams.set(BOOKING_EMBED_PARAM, BOOKING_EMBED_VALUE);
  window.location.href = url.toString();
}

/** The address of booking-as-this-player, for linking and history entries. */
export function playerBookingUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set(BOOKING_EMBED_PARAM, BOOKING_EMBED_VALUE);
  url.searchParams.set(PLAYER_BOOKING_PARAM, PLAYER_BOOKING_VALUE);
  return url.toString();
}

/** The address of the Player Terminal proper, with booking left behind. */
export function playerTerminalUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete(BOOKING_EMBED_PARAM);
  url.searchParams.delete(PLAYER_BOOKING_PARAM);
  return url.toString();
}

/**
 * Opens booking as the signed-in player.
 *
 * A history entry rather than a page load: booking is a room in the terminal,
 * not a different building, so the navigation bar and the session stay put and
 * the browser's back button still works. Nothing personal travels in the URL --
 * the booking view asks the server who this session belongs to. The old
 * localStorage handoff stays available for public prefill, but it is no longer
 * how the portal identifies a player.
 */
export function openPlayerBooking() {
  window.history.pushState({}, "", playerBookingUrl());
}

/** Returns from booking to the rest of the Player Terminal. */
export function closePlayerBooking() {
  window.history.pushState({}, "", playerTerminalUrl());
}
