// "Remember me on this device" for the public booking page and widget.
//
// Only in this browser. On by default, with the box under the details there to
// untick on a shared computer, and never for a booking made for someone else.
// The details are kept here so the form can fill itself; the token is what
// the server uses to put the next booking on the same client record (see
// rememberedBookingPerson in booking-core). Nothing is remembered by IP: a
// club, office or household shares one, and that would hand one person's
// details to the next.
//
// Kept per business, because one browser can book with more than one.
import { publicBookingRoute } from "./bookingScreen";

export type RememberedBooker = {
  token: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  handedness: "right" | "left";
};

function storageKey() {
  return `clarity-booking-remembered:${publicBookingRoute().business}`;
}

export function readRememberedBooker(): RememberedBooker | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey()) || "null");
    if (!parsed?.token || !parsed.firstName || !parsed.lastName || !parsed.email) return null;
    return {
      token: String(parsed.token),
      firstName: String(parsed.firstName),
      lastName: String(parsed.lastName),
      phone: String(parsed.phone || ""),
      email: String(parsed.email),
      handedness: parsed.handedness === "left" ? "left" : "right",
    };
  } catch {
    return null;
  }
}

export function saveRememberedBooker(booker: RememberedBooker) {
  try {
    window.localStorage.setItem(storageKey(), JSON.stringify(booker));
  } catch {
    // Private windows and blocked storage: the player just types it next time.
  }
}

export function forgetRememberedBooker() {
  try {
    window.localStorage.removeItem(storageKey());
  } catch {
    // Nothing stored, nothing to forget.
  }
}
