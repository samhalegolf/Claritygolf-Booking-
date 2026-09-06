// Kept as a small shared public-booking concern rather than importing App.
// This mirrors App.tsx: legacy rows without bookingScreenIds default to main;
// an explicit empty list means the service is not shown anywhere.
const BOOKING_SCREENS = [
  { id: "main", slugs: ["/", "/sam-hale-golf"] },
  { id: "group-lessons", slugs: ["/group-lessons"] },
  { id: "private-lessons", slugs: ["/private-lessons"] },
] as const;

function normalizeBookingPath(pathname = "") {
  const cleaned = pathname.trim().toLowerCase();
  if (!cleaned || cleaned === "/") return "/";
  return `/${cleaned.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\/+/g, "/")}`;
}

export function currentPublicBookingScreenId(pathname = window.location.pathname) {
  const normalizedPath = normalizeBookingPath(pathname);
  return BOOKING_SCREENS.find((screen) => screen.slugs.includes(normalizedPath))?.id ?? "main";
}

export function appearsOnCurrentPublicBookingScreen(service: { bookingScreenIds?: string[] }, pathname = window.location.pathname) {
  return (service.bookingScreenIds ?? ["main"]).includes(currentPublicBookingScreenId(pathname));
}
