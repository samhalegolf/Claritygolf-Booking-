/**
 * Clarity's internal records, as the public API shows them.
 *
 * Internally a booking is a row on a week/day/minute grid with snapshots of
 * its coach and location; outside, it is a booking with a start and an end.
 * Everything that crosses the API boundary is translated here and only here,
 * so the public shape stays the same when the internals move.
 *
 * Every serializer takes the raw database row (snake_case columns). That is
 * the one shape both the list endpoints and the change feed have: the feed's
 * rows come from a trigger's to_jsonb(NEW), which is the same columns.
 */
import { calendarSlot, BASE_WEEK_START } from "../calendar-slot.mts";
import { slotWallClock } from "../resource-webhook-provider.mts";
import { serviceCoachIds, serviceLocationIds, primaryServiceLocationId } from "../service-scope.mts";
import { readPublicCatalogState } from "../../booking-core.mts";

export type Catalog = {
  accountId: string;
  name: string;
  timezone: string;
  currency: string;
  country: string;
  livemode: boolean;
  services: any[];
  coaches: any[];
  locations: any[];
};

/** The business's names and settings, read once per request (or per feed batch). */
export async function loadCatalog(accountId: string, livemode: boolean): Promise<Catalog> {
  const state: any = await readPublicCatalogState(accountId);
  const account = state.account || {};
  return {
    accountId,
    name: String(account.businessName || ""),
    timezone: validTimeZone(account.timezone) || "UTC",
    currency: String(account.invoiceSettings?.currency || "").toLowerCase(),
    country: String(account.country || ""),
    livemode,
    services: (state.services || []).filter((entry: any) => entry?.archived !== true),
    coaches: (state.coaches || []).filter((entry: any) => entry?.archived !== true),
    locations: (state.locations || []).filter((entry: any) => entry?.archived !== true),
  };
}

export function validTimeZone(value: unknown): string {
  const zone = typeof value === "string" ? value.trim() : "";
  if (!zone) return "";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return "";
  }
}

function jsonField(value: unknown): any {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function iso(value: unknown): string | null {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// ---------------------------------------------------------------------------
// Time: grid <-> instant
// ---------------------------------------------------------------------------

/** The time zone a location's times are read in: its own, else the business's. */
export function zoneForLocation(catalog: Catalog, locationId: string, snapshotZone = ""): string {
  const location = catalog.locations.find((entry) => entry?.id === locationId);
  return validTimeZone(snapshotZone) || validTimeZone(location?.timezone) || catalog.timezone;
}

export function slotToIso(week: number, day: number, minutes: number, timeZone: string) {
  return slotWallClock(week, day, minutes, timeZone).iso;
}

/** An instant as a grid slot in the given zone. */
export function isoToSlot(startIso: string, timeZone: string) {
  return calendarSlot(startIso, timeZone);
}

/**
 * One sortable number per grid position -- minutes since the anchor Monday.
 * Lets a date filter or a cursor be a single SQL comparison.
 */
export function slotKey(week: number, day: number, start: number) {
  return week * 7 * 1440 + day * 1440 + start;
}

/** An instant as a slot key, read in the business's zone. For filters. */
export function isoToSlotKey(startIso: string, timeZone: string) {
  const slot = calendarSlot(startIso, timeZone);
  return slotKey(slot.week, slot.day, slot.start);
}

export { BASE_WEEK_START };

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

function ref(list: any[], id: string, name: (entry: any) => string) {
  if (!id) return null;
  const entry = list.find((candidate) => candidate?.id === id);
  return { id, name: entry ? name(entry) : "" };
}

const coachName = (coach: any) => String(coach?.displayName || coach?.name || "");

export type ApiBooking = Record<string, unknown> & { id: string };

export function bookingFromRow(row: any, catalog: Catalog, options: { deleted?: boolean } = {}): ApiBooking {
  const location = jsonField(row.location) || {};
  const coachSnapshot = jsonField(row.coach) || {};
  const service = catalog.services.find((entry) => entry?.id === row.service_id) || null;
  const locationId = String(row.location_id || location.locationId || primaryServiceLocationId(service) || "");
  const coachId = String(row.coach_id || coachSnapshot.coachId || "");
  const timeZone = zoneForLocation(catalog, locationId, location.timezone);
  const week = Number(row.week || 0);
  const day = Number(row.day || 0);
  const start = Number(row.start || 0);
  const duration = Number(row.duration || 0);
  const status = options.deleted ? "cancelled" : String(row.status || "booked");
  const locationEntry = catalog.locations.find((entry) => entry?.id === locationId);
  const coachEntry = catalog.coaches.find((entry) => entry?.id === coachId);
  return {
    id: String(row.id),
    object: "booking",
    status,
    start: slotToIso(week, day, start, timeZone),
    end: slotToIso(week, day, start + duration, timeZone),
    timezone: timeZone,
    duration_minutes: duration,
    service: row.service_id ? ref(catalog.services, String(row.service_id), (entry) => String(entry.name || "")) : null,
    coach: coachId ? { id: coachId, name: coachEntry ? coachName(coachEntry) : String(coachSnapshot.name || "") } : null,
    location: locationId
      ? { id: locationId, name: String(locationEntry?.name || location.name || "") }
      : null,
    client: {
      id: row.person_id ? String(row.person_id) : null,
      name: String(row.client || row.title || ""),
      email: String(row.email || ""),
      phone: String(row.phone || ""),
    },
    notes: String(row.note || ""),
    // Where it was made: in Clarity, or synced in from another system.
    origin: String(row.origin || "clarity"),
    external_id: row.external_booking_id ? String(row.external_booking_id) : null,
    ...(options.deleted ? { deleted: true } : {}),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export function clientFromRow(row: any, options: { deleted?: boolean } = {}) {
  return {
    id: String(row.id),
    object: "client",
    name: String(row.name || ""),
    email: String(row.email || ""),
    phone: String(row.phone || ""),
    notes: String(row.notes || ""),
    source: String(row.source || ""),
    ...(options.deleted ? { deleted: true } : {}),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export function isOnlineBookable(service: any) {
  return (
    service?.active !== false &&
    service?.archived !== true &&
    service?.visibility === "public" &&
    service?.lessonFormat !== "package"
  );
}

export function serviceObject(service: any, catalog: Catalog) {
  const price = Number(service?.price);
  return {
    id: String(service.id),
    object: "service",
    name: String(service.name || ""),
    description: String(service.description || ""),
    duration_minutes: Number(service.duration || 0),
    // Minor units (cents), like every money amount in this API.
    price: Number.isFinite(price) ? { amount: Math.round(price * 100), currency: catalog.currency } : null,
    price_mode: String(service.priceMode || "fixed"),
    format: String(service.lessonFormat || "private"),
    capacity: Number(service.capacity || 1),
    active: service.active !== false,
    bookable_online: isOnlineBookable(service),
    coach_ids: serviceCoachIds(service),
    location_ids: serviceLocationIds(service),
  };
}

export function coachObject(coach: any) {
  return {
    id: String(coach.id),
    object: "coach",
    name: coachName(coach),
    email: String(coach.email || ""),
    bio: String(coach.bio || ""),
    photo_url: String(coach.photoUrl || "") || null,
    active: coach.active !== false,
    bookable: coach.bookable !== false,
    location_ids: Array.isArray(coach.assignedLocationIds) ? coach.assignedLocationIds.map(String) : [],
  };
}

export function locationObject(location: any, catalog: Catalog) {
  return {
    id: String(location.id),
    object: "location",
    name: String(location.name || ""),
    address: String(location.address || ""),
    timezone: validTimeZone(location.timezone) || catalog.timezone,
    kind: String(location.kind || "physical"),
    active: location.active !== false,
    is_default: location.isDefault === true,
  };
}

/**
 * What changed, as the object used to read -- Stripe's `previous_attributes`.
 * Top-level keys only, and only the ones whose value differs.
 */
export function previousAttributes(before: Record<string, unknown>, after: Record<string, unknown>) {
  const changed: Record<string, unknown> = {};
  for (const key of Object.keys(before)) {
    if (key === "updated_at") continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changed[key] = before[key];
  }
  return changed;
}
