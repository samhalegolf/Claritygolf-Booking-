// Which coach's Google Calendar a piece of Clarity's calendar belongs on.
//
// Google Calendar is connected per coach: each coach links their own Google
// account from their coach profile, and their calendar carries their lessons,
// their blocks and the hours they cannot be booked — nobody else's. These are
// the ownership rules the sync uses to decide that, kept pure so they can be
// tested without Google or a database.
//
// They mirror resolvedCalendarItemCoachId in booking-core.mts (and the same
// rule in App.tsx), so the Google calendar agrees with the coach calendar in
// Clarity about whose lesson is whose.

import type { AvailabilityWindow } from "./availability-blocks.mts";
import { primaryServiceCoachId, type ServiceScope } from "./service-scope.mts";

export type GoogleCoachProfile = { id: string; active?: boolean; archived?: boolean };

export type GoogleCoachItem = {
  kind?: string;
  coachId?: string;
  locationId?: string;
  serviceId?: string;
  coach?: { coachId?: string } | null;
  location?: { locationId?: string } | null;
};

/** As booking-core's firstCoachId: where a record that names no coach is shown. */
export function firstGoogleCoachId(coaches: GoogleCoachProfile[]) {
  return coaches.find((coach) => coach.active !== false && coach.archived !== true)?.id || coaches[0]?.id || "";
}

/**
 * A block that closes a location rather than a coach — the venue shut for a
 * morning. Every coach who works there is unavailable, so it goes on every
 * connected coach's calendar.
 */
export function isLocationOnlyBlock(item: GoogleCoachItem) {
  return (
    item?.kind === "block" &&
    Boolean(item.locationId || item.location?.locationId) &&
    !item.coachId &&
    !item.coach?.coachId
  );
}

/** The coach an item belongs to. "" only when the business has no coaches at all. */
export function googleItemCoachId(
  item: GoogleCoachItem,
  services: Array<ServiceScope & { id?: unknown }>,
  coaches: GoogleCoachProfile[],
) {
  const service = services.find((candidate) => candidate?.id && candidate.id === item?.serviceId);
  return item?.coachId || item?.coach?.coachId || primaryServiceCoachId(service) || firstGoogleCoachId(coaches);
}

export function itemBelongsOnCoachCalendar(
  item: GoogleCoachItem,
  coachId: string,
  services: Array<ServiceScope & { id?: unknown }>,
  coaches: GoogleCoachProfile[],
) {
  if (!coachId) return false;
  if (isLocationOnlyBlock(item)) return true;
  return googleItemCoachId(item, services, coaches) === coachId;
}

/**
 * One coach's weekly availability, for working out the hours they cannot be
 * booked. A window that names no coach belongs to the first coach, as it does
 * everywhere else in Clarity.
 */
export function availabilityForGoogleCoach(
  availability: AvailabilityWindow[][] | null | undefined,
  coachId: string,
  coaches: GoogleCoachProfile[],
): AvailabilityWindow[][] {
  const fallback = firstGoogleCoachId(coaches);
  return (Array.isArray(availability) ? availability : []).map((dayWindows) =>
    (Array.isArray(dayWindows) ? dayWindows : []).filter((window) => (window?.coachId || fallback) === coachId),
  );
}

/**
 * The signed-in person's own coach id, or "" when they have none: the coach
 * their membership names, or for the owner, the coach seeded with the business
 * (its id is the account id). Stricter than booking-core's ownCoachIdFor on
 * purpose — there is no first-coach fallback, because this decides whose
 * Google account a person may connect and disconnect, and a coach without a
 * linked profile must never be handed the owner's.
 */
export function ownGoogleCoachId(
  actor: { coachId?: string; isOwner?: boolean },
  coaches: GoogleCoachProfile[],
  accountId: string,
) {
  const live = (id: string | undefined) => (id && coaches.some((coach) => coach.id === id) ? id : "");
  return live(actor.coachId) || (actor.isOwner ? live(accountId) : "");
}

/**
 * The coaches a business has, read from its settings the way booking-core
 * reads them: a list that was never saved is the one coach seeded with the
 * business, whose id is the account id.
 */
export function googleCoachesFromSettings(accountId: string, coachProfilesJson: string | undefined): GoogleCoachProfile[] {
  if (!coachProfilesJson) return [{ id: accountId, active: true }];
  try {
    const parsed = JSON.parse(coachProfilesJson);
    if (!Array.isArray(parsed)) return [{ id: accountId, active: true }];
    return parsed
      .filter((coach) => coach && typeof coach.id === "string" && coach.id)
      .map((coach) => ({ id: coach.id, active: coach.active !== false, archived: coach.archived === true }));
  } catch {
    return [{ id: accountId, active: true }];
  }
}
