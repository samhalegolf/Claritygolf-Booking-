/**
 * Which coaches and locations a lesson type is offered with.
 *
 * A lesson type lists every coach who teaches it and every location it runs
 * at. A booking is always one coach at one location: the booking page offers
 * each free time once and takes the first coach and location, in the order
 * listed here, who are free for it.
 *
 * Lesson types saved before these lists existed held a single coachId and
 * locationId. Those are read as one-item lists, so nothing stored needs
 * rewriting before it can be read. The next save writes the lists instead.
 *
 * Pure: no database. Safe to import from the browser.
 */

export type ServiceScope = {
  coachIds?: unknown;
  locationIds?: unknown;
  /** Before the lists: the one coach. Read, never written. */
  coachId?: unknown;
  /** Before the lists: the one location. Read, never written. */
  locationId?: unknown;
};

const MAX_IDS = 60;

// Same shape as cleanSlug in booking-core and App, so an id cleaned here
// matches one cleaned there.
function slug(value: unknown) {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function cleanScopeIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(slug).filter(Boolean))].slice(0, MAX_IDS);
}

/** The coaches this lesson type is offered with, in the order they are tried. */
export function serviceCoachIds(service: ServiceScope | null | undefined): string[] {
  if (Array.isArray(service?.coachIds)) return cleanScopeIds(service.coachIds);
  const legacy = slug(service?.coachId);
  return legacy ? [legacy] : [];
}

/** The locations this lesson type runs at, in the order they are tried. */
export function serviceLocationIds(service: ServiceScope | null | undefined): string[] {
  if (Array.isArray(service?.locationIds)) return cleanScopeIds(service.locationIds);
  const legacy = slug(service?.locationId);
  return legacy ? [legacy] : [];
}

/**
 * The coach a booking of this lesson type falls to when nothing more specific
 * says: the first one listed, else the business's fallback.
 */
export function primaryServiceCoachId(service: ServiceScope | null | undefined, fallback = ""): string {
  return serviceCoachIds(service)[0] || fallback;
}

export function primaryServiceLocationId(service: ServiceScope | null | undefined, fallback = ""): string {
  return serviceLocationIds(service)[0] || fallback;
}

/** True when this coach teaches this lesson type. No coaches listed falls to the fallback coach. */
export function serviceIncludesCoach(service: ServiceScope | null | undefined, coachId: string, fallback = ""): boolean {
  if (!coachId) return false;
  const ids = serviceCoachIds(service);
  return ids.length ? ids.includes(coachId) : coachId === fallback;
}
