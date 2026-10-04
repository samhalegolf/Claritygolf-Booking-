import { useEffect, useState } from "react";
import type { ThemeMode } from "../workspace/workspaceModel";

/** The booking flow's shapes, and the palette its cards wear. */

export type BookingForm = {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
};

export type PublicBookingSection = "appointment" | "datetime" | "information";

/**
 * Which palette the booking cards wear.
 *
 * This used to be a coach setting, which meant the cards were dark or light
 * according to a value saved on the coach's machine -- so changing it there did
 * nothing for a player on their own phone, and every visitor got one coach's
 * preference regardless of their own. The person looking at the page is the
 * only one who knows which they want, and their browser already says.
 */
export function useBookingCardScheme(): ThemeMode {
  const query = "(prefers-color-scheme: dark)";
  const read = (): ThemeMode =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(query).matches
      ? "dark"
      : "light";
  const [scheme, setScheme] = useState<ThemeMode>(read);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setScheme(media.matches ? "dark" : "light");
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, []);

  return scheme;
}
