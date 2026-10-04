import { primaryServiceCoachId, primaryServiceLocationId } from "../../../netlify/functions/_shared/service-scope.mts";
import { DAY_COUNT } from "../../calendar-axis";
import { activeLocale } from "../../lib/activeCountry";
import { t } from "../../lib/i18n";
import { clamp } from "../../lib/number";
import { defaultServices, Service } from "../services/serviceModel";
import { BASE_WEEK_START } from "../shared/bookingHandoff";
import {
  cleanCoachAccount,
  cleanEmail,
  cleanSlug,
  cleanUrl,
  CoachAccount,
  coachById,
  CoachProfile,
  defaultCoachProfileFromAccount,
  defaultLocationFromCoachAccount,
  defaultLocationId,
  defaultWorkspaceAccountFromCoachAccount,
  firstCoachId,
  Location,
  locationById,
} from "../workspace/workspaceModel";
import { timeToMinutes } from "../../lib/date";

/**
 * The calendar's data and rules, without any of its screen: what a calendar
 * item is, the week grid and business clock, which coach and location an
 * item belongs to, availability, and whether two items clash.
 *
 * Kept free of React so the web calendar and the coming phone calendar can
 * share it.
 */

export type BookingStatus = "booked" | "completed" | "cancelled" | "no_show";

type CustomGroupAttendeeStatus = "booker" | "manual" | "invited" | "confirmed";

export type CustomGroupAttendee = {
  id: string;
  name: string;
  email?: string;
  status: CustomGroupAttendeeStatus;
  token?: string;
};

export type CalendarItem = {
  id: string;
  kind: "appointment" | "block";
  accountId?: string;
  coachId?: string;
  locationId?: string;
  week?: number;
  day: number;
  start: number;
  duration: number;
  groupSlot?: boolean;
  syntheticGroupSlot?: boolean;
  serviceId?: string;
  readOnly?: boolean;
  client?: string;
  title: string;
  phone?: string;
  email?: string;
  // Stable link to a people/client row, set by the backend once a booking is
  // matched or created. Carry it through on every edit (it just needs to
  // survive object-spread updates) so a later correction to name/email/phone
  // never loses the connection to the client's real profile.
  personId?: string;
  note?: string;
  location?: BookingLocationSnapshot;
  coach?: BookingCoachSnapshot;
  status?: BookingStatus;
  // Booking ownership, supplied by the backend and never written back. "clarity"
  // means Clarity owns the lesson; anything else means an external system does
  // and Clarity is mirroring it.
  origin?: string;
  externalProvider?: string;
  externalBookingId?: string;
  /** The Clarity resource this lesson holds. Server-owned, never written back. */
  resourceId?: string;
  /** A live Optix bay is held for this lesson. Backend-supplied, never written back. */
  bayBooked?: boolean;
  bayResourceId?: string;
  updatedAt?: string;
  completedAt?: string;
  customGroup?: true;
  attendees?: CustomGroupAttendee[];
  calculatedPrice?: number;
};

/**
 * True when an outside system owns this booking and Clarity is only mirroring
 * it. Clarity must not move such a lesson on its own: the external system is
 * the source of truth for when it happens, and a change made only here would
 * leave the two silently disagreeing.
 */
export function isExternallyOwned(item: Pick<CalendarItem, "origin" | "externalProvider">) {
  const origin = (item.origin || "clarity").trim().toLowerCase();
  return origin !== "" && origin !== "clarity";
}

export function externalProviderLabel(item: Pick<CalendarItem, "origin" | "externalProvider">) {
  const provider = (item.externalProvider || item.origin || "").trim();
  if (!provider) return t("the booking system it came from");
  return provider.toLowerCase() === "optix" ? "Optix" : provider;
}

export function externalRescheduleMessage(item: Pick<CalendarItem, "origin" | "externalProvider">) {
  const provider = externalProviderLabel(item);
  return t("{provider} owns this lesson, so move it there — changing it only in Clarity would leave the two out of step. You can also remove it from Clarity from the booking card.", { provider });
}

type BookingLocationSnapshot = {
  locationId?: string;
  name: string;
  shortName?: string;
  address?: string;
  mapUrl?: string;
  arrivalInstructions?: string;
  publicNotes?: string;
  timezone?: string;
};

export type BookingCoachSnapshot = {
  coachId?: string;
  name: string;
  displayName?: string;
  email?: string;
  phone?: string;
};

export type PendingBooking = {
  id: string;
  accountId?: string;
  client: string;
  title: string;
  serviceId: string;
  coachId?: string;
  duration: number;
  phone?: string;
  email?: string;
  note?: string;
  sourceItemId?: string;
  customGroup?: true;
  attendees?: CustomGroupAttendee[];
  calculatedPrice?: number;
};

export type PlacementAnimation = {
  itemId: string;
  fromX: number;
  fromY: number;
};

export type CalendarViewMode = "full" | "am" | "pm";
export type CalendarPerspective = "all" | "coach" | "location";

export type DockFlight = PendingBooking & {
  fromX?: number;
  fromY?: number;
};

export type FloatingDrag = {
  itemId: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type CalendarHoverPreview = {
  itemId: string;
  x: number;
  y: number;
  kind: "group-session" | "appointment" | "blocked";
  client: string;
  service: string;
  time: string;
  venue: string;
  phone: string;
  email: string;
  clientEmailStatus: string;
  coachEmailStatus: string;
  adminEmailStatus: string;
};

export function customGroupStatusLabel(status: CustomGroupAttendeeStatus) {
  if (status === "booker") return t("Booked");
  if (status === "manual") return t("Manual");
  if (status === "confirmed") return t("Confirmed");
  return t("Invited");
}

// Calendar item ids must be globally unique: two items created in the same millisecond used
// to share an id, and a retried save could not tell its own landed write from someone else's row.
export function newCalendarItemId(prefix: "appt" | "block") {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function newCustomGroupAttendeeId(prefix = "attendee") {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function customGroupAttendeeToken() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function customGroupBookerAttendee(name: string, email = ""): CustomGroupAttendee {
  return {
    id: "booker",
    name: name.trim() || "Booker",
    email: email.trim() || undefined,
    status: "booker",
  };
}

export function adminCustomGroupAttendee(name: string, email = ""): CustomGroupAttendee | null {
  const cleanName = name.trim();
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanName) return null;
  return {
    id: newCustomGroupAttendeeId(),
    name: cleanName,
    email: cleanEmail || undefined,
    status: cleanEmail ? "invited" : "manual",
    token: cleanEmail ? customGroupAttendeeToken() : undefined,
  };
}

export type PointerSession =
  | {
      mode: "move";
      itemId: string;
      offsetMinutes: number;
      origin: CalendarItem;
    }
  | {
      mode: "resize";
      itemId: string;
      origin: CalendarItem;
    }
  | {
      mode: "block";
      day: number;
      start: number;
    }
  | {
      mode: "place";
      booking: PendingBooking;
    }
  | null;

export type AvailabilityWindow = {
  accountId?: string;
  coachId?: string;
  /** Where the coach works in this window. Empty covers every location (pre-location data). */
  locationId?: string;
  start: number;
  end: number;
};

export type SlotCandidate = {
  week: number;
  day: number;
  start: number;
  duration: number;
};

export type BookingSlot = {
  week: number;
  day: number;
  start: number;
  remainingSpots: number;
  coachId?: string;
  locationId?: string;
};

export type QuickCreateState = {
  week: number;
  day: number;
  start: number;
  x: number;
  y: number;
  coachId?: string;
  locationId?: string;
  serviceId: string;
  phone: string;
  email: string;
  note: string;
  attendees: CustomGroupAttendee[];
  attendeeName: string;
  attendeeEmail: string;
  error: string;
};

export type GroupSession = {
  serviceId: string;
  week: number;
  day: number;
  start: number;
  duration: number;
};

export type WeekDay = {
  short: string;
  label: string;
  date: number;
  isToday: boolean;
};

export const DAY_START_MINUTES = 0;
export const DAY_END_MINUTES = 24 * 60;
const DEFAULT_CALENDAR_START_HOUR = 7;
const DEFAULT_CALENDAR_END_HOUR = 20;
export const DEFAULT_CALENDAR_START_MINUTES = DEFAULT_CALENDAR_START_HOUR * 60;
export const DEFAULT_CALENDAR_END_MINUTES = DEFAULT_CALENDAR_END_HOUR * 60;
export const SNAP_MINUTES = 15;
export const LAST_TIME_SLOT_MINUTES = DAY_END_MINUTES - SNAP_MINUTES;
export const MOUSE_DRAG_THRESHOLD = 10;
export const TOUCH_DRAG_THRESHOLD = 16;
// A finger that lands on a lesson is usually scrolling the week, not
// rescheduling. Touch drags therefore arm on a deliberate hold instead of on
// contact: hold still for TOUCH_HOLD_MS and the card lifts; move more than
// TOUCH_HOLD_TOLERANCE before then and the hold is abandoned and the touch goes
// back to being an ordinary scroll. A distance threshold alone could not tell
// those two apart, which is why any swipe starting on a card used to pick it up.
export const TOUCH_HOLD_MS = 500;
export const TOUCH_HOLD_TOLERANCE = 10;
// Post-hold, intent is settled, so the card follows the finger almost at once
// rather than making the coach drag through the accident threshold twice.
export const ARMED_TOUCH_DRAG_THRESHOLD = 6;
export const EDGE_NAV_ZONE = 26;
export const CANCELLED_GROUP_SESSION_TITLE = "Cancelled group session";
export const CANCELLED_GROUP_SESSION_NOTE = "__cancelled_group_session__";
export const PAST_ADMIN_LESSON_WARNING =
  t("This lesson is in the past. It will be saved for records only and no emails will be sent.");
// A completed card is a record, and a click that drifts into a drag should not
// rewrite it. One completed lesson was nudged a row and back in September 2026
// and Optix received two booking changes for a bay used a week earlier.
export const COMPLETED_LESSON_MOVE_WARNING =
  t("This lesson is already marked completed. Move it anyway? Its bay booking will stay where it was.");

export const baseWeekDays = [t("Mon"), t("Tue"), t("Wed"), t("Thu"), t("Fri"), t("Sat"), t("Sun")];
export const fullDayNames = [t("Monday"), t("Tuesday"), t("Wednesday"), t("Thursday"), t("Friday"), t("Saturday"), t("Sunday")];
// Shared with the player portal -- see modules/shared/bookingHandoff.
export const baseWeekStart = BASE_WEEK_START;

export const defaultAvailability: AvailabilityWindow[][] = [
  [{ start: timeToMinutes(16, 30), end: timeToMinutes(20, 0) }],
  [],
  [{ start: timeToMinutes(14, 0), end: timeToMinutes(20, 0) }],
  [
    { start: timeToMinutes(7, 0), end: timeToMinutes(11, 0) },
    { start: timeToMinutes(14, 0), end: timeToMinutes(16, 30) },
  ],
  [{ start: timeToMinutes(14, 0), end: timeToMinutes(16, 0) }],
  [],
  [{ start: timeToMinutes(15, 0), end: timeToMinutes(18, 0) }],
];

export function snap(value: number) {
  return Math.round(value / SNAP_MINUTES) * SNAP_MINUTES;
}

export function formatTime(minutes: number) {
  const normalized = ((Math.round(minutes) % DAY_END_MINUTES) + DAY_END_MINUTES) % DAY_END_MINUTES;
  const hour24 = Math.floor(normalized / 60);
  const mins = normalized % 60;
  const period = hour24 >= 12 ? "PM" : "AM";
  const hour = hour24 % 12 || 12;
  return `${hour}:${String(mins).padStart(2, "0")} ${period}`;
}

export function minutesToInputTime(minutes: number) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function inputTimeToMinutes(value: string, fallback: number) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return fallback;
  }
  return hour * 60 + minute;
}

export function formatRange(start: number, duration: number) {
  return `${formatTime(start)}-${formatTime(start + duration)}`;
}


export function itemService(item: CalendarItem, serviceCatalog = defaultServices): Service | undefined {
  const service = serviceCatalog.find((candidate) => candidate.id === item.serviceId);
  if (service) return service;
  if (!item.serviceId) return undefined;
  const fallbackService: Service = {
    ...defaultServices[0],
    id: item.serviceId,
    name: item.title?.trim() || "Deleted lesson type",
    description: "",
    visibility: "private",
    active: false,
    archived: true,
    lessonFormat: "private",
    packageAllowance: undefined,
    packageCoverageMode: undefined,
    packageCoversServiceId: undefined,
    groupSchedule: undefined,
    bookingScreenIds: ["main"],
  };
  return fallbackService;
}

/**
 * The fill a booking's card gets: the colour set on its lesson type.
 *
 * It comes off the service rather than a fixed list of categories, because the
 * lesson types are whatever this coach actually sells — a workspace with six
 * kinds of lesson should be able to tell all six apart, not squeeze them into
 * four names someone else chose. A booking with no service left (deleted
 * lesson type) falls back to the neutral fill in styles.css.
 */
export function calendarLessonColor(service: Service | undefined) {
  return service?.color || undefined;
}

export function itemWeek(item: CalendarItem) {
  return item.week ?? 0;
}

export function sameSlot(a: CalendarItem, b: SlotCandidate) {
  return itemWeek(a) === b.week && a.day === b.day && a.start === b.start && a.duration === b.duration;
}

export function overlaps(a: SlotCandidate, b: SlotCandidate) {
  return a.week === b.week && a.day === b.day && a.start < b.start + b.duration && a.start + a.duration > b.start;
}

export function itemSlot(item: CalendarItem): SlotCandidate {
  return { week: itemWeek(item), day: item.day, start: item.start, duration: item.duration };
}

/**
 * The business's clock. Stored lessons are wall-clock times in the business's
 * time zone (the server reads them that way), so "today", the now line and
 * what counts as past have to come from that zone too, not from whichever
 * zone the browser happens to be in. Set from the account on every render.
 */
let businessTimeZone = "";

export function setBusinessTimeZone(timeZone: string | undefined) {
  businessTimeZone = timeZone || "";
}

/** Today (as a local-midnight Date, like the grid's) and the minute of the day, in the business's zone. */
export function businessNow(): { date: Date; minutes: number } {
  const now = new Date();
  if (businessTimeZone) {
    try {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: businessTimeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        })
          .formatToParts(now)
          .map((part) => [part.type, part.value]),
      );
      return {
        date: new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day)),
        minutes: Number(parts.hour) * 60 + Number(parts.minute),
      };
    } catch {
      // An unknown zone falls back to the browser's clock below.
    }
  }
  return {
    date: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
    minutes: now.getHours() * 60 + now.getMinutes(),
  };
}

export function startOfCalendarWeek(value = new Date()) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + mondayOffset);
  return date;
}

export function calendarDateUtcTime(date: Date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

function isSameCalendarDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function getCurrentWeekOffset() {
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const currentWeekStart = startOfCalendarWeek(businessNow().date);
  return Math.round((calendarDateUtcTime(currentWeekStart) - calendarDateUtcTime(baseWeekStart)) / weekMs);
}

export function buildWeekDays(week: number): WeekDay[] {
  const today = businessNow().date;
  return baseWeekDays.map((short, index) => {
    const date = new Date(baseWeekStart);
    date.setDate(baseWeekStart.getDate() + week * 7 + index);
    return {
      short,
      label: new Intl.DateTimeFormat(activeLocale(), { weekday: "long", month: "short", day: "numeric" }).format(date),
      date: date.getDate(),
      isToday: isSameCalendarDay(date, today),
    };
  });
}

export function dateForSlot(week: number, day: number) {
  const date = new Date(baseWeekStart);
  date.setDate(baseWeekStart.getDate() + week * 7 + day);
  return date;
}

export function isSlotInPast(slot: Pick<SlotCandidate, "week" | "day" | "start">) {
  const now = businessNow();
  const slotDay = calendarDateUtcTime(dateForSlot(slot.week, slot.day));
  const today = calendarDateUtcTime(now.date);
  return slotDay < today || (slotDay === today && slot.start < now.minutes);
}

export function formatWeekTitle(week: number) {
  const date = new Date(baseWeekStart);
  date.setDate(baseWeekStart.getDate() + week * 7);
  return t("Week of {date}", { date: new Intl.DateTimeFormat(activeLocale(), { month: "long", day: "numeric", year: "numeric" }).format(date) });
}

function coachSnapshot(profile: CoachProfile): BookingCoachSnapshot {
  return {
    coachId: profile.id,
    name: profile.name,
    displayName: profile.displayName,
    email: profile.email,
    phone: profile.phone,
  };
}

export function bookingCoachSnapshotFor(coachId: string | undefined, coaches: CoachProfile[]): BookingCoachSnapshot | undefined {
  const profile = coachById(coaches, coachId) ?? coachById(coaches, firstCoachId(coaches));
  return profile ? coachSnapshot(profile) : undefined;
}

function cleanBookingCoachSnapshot(
  raw?: Partial<BookingCoachSnapshot>,
  fallback?: BookingCoachSnapshot,
): BookingCoachSnapshot | undefined {
  const source = raw?.name ? raw : fallback;
  if (!source?.name) return undefined;
  return {
    coachId: typeof source.coachId === "string" ? cleanSlug(source.coachId, "") || undefined : undefined,
    name: String(source.name).trim().slice(0, 120),
    displayName:
      typeof source.displayName === "string" && source.displayName.trim()
        ? source.displayName.trim().slice(0, 120)
        : undefined,
    email: cleanEmail(source.email, "") || undefined,
    phone: typeof source.phone === "string" && source.phone.trim() ? source.phone.trim().slice(0, 80) : undefined,
  };
}

export function calendarItemCoach(
  item: Partial<CalendarItem> | undefined,
  coaches: CoachProfile[],
): BookingCoachSnapshot | undefined {
  return (
    cleanBookingCoachSnapshot(item?.coach) ??
    bookingCoachSnapshotFor(item?.coachId, coaches)
  );
}

export function resolvedCalendarItemCoachId(
  item: Partial<CalendarItem> | undefined,
  service: Partial<Service> | undefined,
  coaches: CoachProfile[],
) {
  return item?.coachId || item?.coach?.coachId || primaryServiceCoachId(service) || calendarItemCoach(item, coaches)?.coachId || firstCoachId(coaches);
}

export function calendarItemBelongsToCoach(
  item: Partial<CalendarItem> | undefined,
  coachId: string | undefined,
  service: Partial<Service> | undefined,
  coaches: CoachProfile[],
) {
  if (!coachId) return false;
  return resolvedCalendarItemCoachId(item, service, coaches) === coachId;
}

export function locationSnapshot(location: Location): BookingLocationSnapshot {
  return {
    locationId: location.id,
    name: location.name,
    shortName: location.shortName,
    address: location.address || undefined,
    mapUrl: location.mapUrl,
    arrivalInstructions: location.arrivalInstructions,
    publicNotes: location.publicNotes,
    timezone: location.timezone,
  };
}

export function serviceLocation(service: Partial<Service> | undefined, locations: Location[], account: Partial<CoachAccount>) {
  const cleanAccount = cleanCoachAccount(account);
  return (
    locationById(locations, primaryServiceLocationId(service)) ??
    locationById(locations, defaultLocationId(locations)) ??
    defaultLocationFromCoachAccount(cleanAccount)
  );
}

export function bookingLocationSnapshotFor(
  service: Partial<Service> | undefined,
  locations: Location[],
  account: Partial<CoachAccount>,
): BookingLocationSnapshot {
  return locationSnapshot(serviceLocation(service, locations, account));
}

export function cleanBookingLocationSnapshot(
  raw?: Partial<BookingLocationSnapshot>,
  fallback?: BookingLocationSnapshot,
): BookingLocationSnapshot | undefined {
  const source = raw?.name ? raw : fallback;
  if (!source?.name) return undefined;
  return {
    locationId: typeof source.locationId === "string" ? source.locationId.trim().slice(0, 120) : undefined,
    name: String(source.name).trim().slice(0, 140),
    shortName: typeof source.shortName === "string" && source.shortName.trim() ? source.shortName.trim().slice(0, 80) : undefined,
    address: typeof source.address === "string" && source.address.trim() ? source.address.trim().slice(0, 240) : undefined,
    mapUrl: cleanUrl(source.mapUrl, "") || undefined,
    arrivalInstructions:
      typeof source.arrivalInstructions === "string" && source.arrivalInstructions.trim()
        ? source.arrivalInstructions.trim().slice(0, 500)
        : undefined,
    publicNotes:
      typeof source.publicNotes === "string" && source.publicNotes.trim()
        ? source.publicNotes.trim().slice(0, 500)
        : undefined,
    timezone: typeof source.timezone === "string" && source.timezone.trim() ? source.timezone.trim().slice(0, 80) : undefined,
  };
}

export function calendarItemLocation(
  item: Partial<CalendarItem> | undefined,
  service: Partial<Service> | undefined,
  locations: Location[],
  account: Partial<CoachAccount>,
): BookingLocationSnapshot {
  return (
    cleanBookingLocationSnapshot(item?.location) ??
    cleanBookingLocationSnapshot(
      item?.locationId ? locationSnapshot(locationById(locations, item.locationId) ?? serviceLocation(service, locations, account)) : undefined,
    ) ??
    bookingLocationSnapshotFor(service, locations, account)
  );
}

export function resolvedCalendarItemLocationId(
  item: Partial<CalendarItem> | undefined,
  service: Partial<Service> | undefined,
  locations: Location[],
  account: Partial<CoachAccount>,
) {
  return item?.locationId || item?.location?.locationId || primaryServiceLocationId(service) || calendarItemLocation(item, service, locations, account).locationId || defaultLocationId(locations);
}

export function calendarItemCoachColumnId(
  item: Partial<CalendarItem> | undefined,
  service: Partial<Service> | undefined,
  coaches: CoachProfile[],
) {
  return resolvedCalendarItemCoachId(item, service, coaches);
}

export function isLocationOnlyBlock(item: Partial<CalendarItem> | undefined) {
  return item?.kind === "block" && Boolean(item.locationId || item.location?.locationId) && !item.coachId && !item.coach?.coachId;
}

export function isCoachOnlyBlock(item: Partial<CalendarItem> | undefined) {
  return item?.kind === "block" && Boolean(item.coachId || item.coach?.coachId) && !item.locationId && !item.location?.locationId;
}

export function isCoachLocationBlock(item: Partial<CalendarItem> | undefined) {
  return item?.kind === "block" && Boolean(item.coachId || item.coach?.coachId) && Boolean(item.locationId || item.location?.locationId);
}

export function isInactiveForConflict(item: Partial<CalendarItem> | undefined) {
  return item?.status === "cancelled" || item?.status === "no_show";
}

type SchedulingConflictContext = {
  candidateService?: Partial<Service>;
  existingService?: Partial<Service>;
  candidateCoachId?: string;
  candidateLocationId?: string;
  coaches: CoachProfile[];
  locations: Location[];
  account: Partial<CoachAccount>;
};

function isCoachConflict(
  candidate: Partial<CalendarItem>,
  existing: Partial<CalendarItem>,
  context: SchedulingConflictContext,
) {
  if (isInactiveForConflict(existing)) return false;
  const candidateCoachId =
    context.candidateCoachId ??
    resolvedCalendarItemCoachId(candidate, context.candidateService, context.coaches);
  const existingCoachId = resolvedCalendarItemCoachId(existing, context.existingService, context.coaches);
  if (!candidateCoachId || !existingCoachId || candidateCoachId !== existingCoachId) return false;
  if (isLocationOnlyBlock(existing)) return false;
  return existing.kind === "appointment" || existing.kind === "block";
}

function isLocationConflict(
  candidate: Partial<CalendarItem>,
  existing: Partial<CalendarItem>,
  context: SchedulingConflictContext,
) {
  if (isInactiveForConflict(existing)) return false;
  const candidateLocationId =
    context.candidateLocationId ??
    resolvedCalendarItemLocationId(candidate, context.candidateService, context.locations, context.account);
  const existingLocationId = resolvedCalendarItemLocationId(existing, context.existingService, context.locations, context.account);
  if (!candidateLocationId || !existingLocationId || candidateLocationId !== existingLocationId) return false;
  if (isLocationOnlyBlock(existing)) return true;
  if (isCoachOnlyBlock(existing)) return false;
  if (isCoachLocationBlock(existing)) {
    return isCoachConflict(candidate, existing, context);
  }
  return candidate.kind === "block" && isLocationOnlyBlock(candidate);
}

export function isAppointmentConflict(
  candidate: Partial<CalendarItem>,
  existing: Partial<CalendarItem>,
  context: SchedulingConflictContext,
) {
  if (isInactiveForConflict(existing)) return false;
  return isCoachConflict(candidate, existing, context) || isLocationConflict(candidate, existing, context);
}

export function bookingLocationDisplay(location: Partial<BookingLocationSnapshot> | undefined) {
  return [location?.name, location?.address].filter(Boolean).join(" · ");
}

export function bookingLocationShortDisplay(location: Partial<BookingLocationSnapshot> | undefined) {
  return location?.shortName || location?.name || "";
}

function calendarItemsFingerprint(itemList?: Partial<CalendarItem>[]) {
  if (!Array.isArray(itemList)) return "";
  return JSON.stringify(
    itemList
      .map((item) => ({
        id: item.id || "",
        kind: item.kind || "",
        week: Number(item.week ?? 0),
        day: Number(item.day ?? 0),
        start: Number(item.start ?? 0),
        duration: Number(item.duration ?? 0),
        coachId: item.coachId || "",
        locationId: item.locationId || "",
        serviceId: item.serviceId || "",
        client: item.client || "",
        title: item.title || "",
        phone: item.phone || "",
        email: (item.email || "").toLowerCase(),
        note: item.note || "",
        location: item.location || null,
        coach: item.coach || null,
        status: item.status || "booked",
        customGroup: item.customGroup === true,
        attendees: Array.isArray(item.attendees) ? item.attendees : [],
        calculatedPrice: Number(item.calculatedPrice ?? 0),
      }))
      .sort((first, second) => first.id.localeCompare(second.id)),
  );
}

export function calendarStateFingerprint(itemList: Partial<CalendarItem>[] | undefined, syncKey: string) {
  return JSON.stringify({ items: calendarItemsFingerprint(itemList), syncKey });
}

export function calendarItemsEquivalent(first?: Partial<CalendarItem>[], second?: Partial<CalendarItem>[]) {
  return calendarItemsFingerprint(first) === calendarItemsFingerprint(second);
}

function calendarItemEquivalent(first?: Partial<CalendarItem>, second?: Partial<CalendarItem>) {
  if (!first && !second) return true;
  if (!first || !second) return false;
  return calendarItemsEquivalent([first], [second]);
}

function calendarItemsById(itemList: CalendarItem[] = []) {
  return new Map(itemList.filter((item) => item.id).map((item) => [item.id, item]));
}

export function mergeCalendarItemsAfterConflict(
  latestItems: CalendarItem[],
  baselineItems: CalendarItem[],
  desiredItems: CalendarItem[],
) {
  const latestById = calendarItemsById(latestItems);
  const baselineById = calendarItemsById(baselineItems);
  const desiredById = calendarItemsById(desiredItems);
  const candidateIds = new Set([...baselineById.keys(), ...desiredById.keys()]);
  const changedIds = new Set<string>();

  candidateIds.forEach((id) => {
    if (!calendarItemEquivalent(baselineById.get(id), desiredById.get(id))) changedIds.add(id);
  });
  if (!changedIds.size) return latestItems;

  for (const id of changedIds) {
    const baselineItem = baselineById.get(id);
    const latestItem = latestById.get(id);
    const desiredItem = desiredById.get(id);
    // The live row already matches what we want (our earlier attempt landed, or the response
    // was lost to a timeout and we retried). Not a conflict — nothing to resolve.
    if (calendarItemEquivalent(latestItem, desiredItem)) continue;
    // We are creating this id and it already exists live. Calendar item ids are client-generated
    // UUIDs, so this can only be our own write landing before its response reached us — the
    // server just echoes it back normalised (coach/location snapshots, default status). Keep our
    // version rather than failing the save and telling the coach nothing was saved.
    if (!baselineItem && latestItem && desiredItem) continue;
    if (!baselineItem && latestItem) return null;
    if (baselineItem && latestItem && !calendarItemEquivalent(latestItem, baselineItem)) return null;
    if (baselineItem && !latestItem && desiredItem) return null;
  }

  const merged = latestItems.filter((item) => !changedIds.has(item.id));
  desiredItems.forEach((item) => {
    if (changedIds.has(item.id)) merged.push(item);
  });
  return merged;
}

export function cleanAvailability(availability?: AvailabilityWindow[][], fallbackCoachId = defaultCoachProfileFromAccount().id): AvailabilityWindow[][] {
  const source = Array.isArray(availability) ? availability : defaultAvailability;
  return Array.from({ length: DAY_COUNT }, (_, day) => {
    const windows = Array.isArray(source[day]) ? source[day] : [];
    return windows
      .map<AvailabilityWindow | null>((window) => {
        const rawStart = Number.isFinite(Number(window?.start)) ? Number(window?.start) : DEFAULT_CALENDAR_START_MINUTES;
        const rawEnd = Number.isFinite(Number(window?.end)) ? Number(window?.end) : rawStart + 60;
        const start = snap(clamp(rawStart, DAY_START_MINUTES, LAST_TIME_SLOT_MINUTES));
        const end = snap(clamp(rawEnd, start + SNAP_MINUTES, LAST_TIME_SLOT_MINUTES));
        const coachId = cleanSlug(window?.coachId, fallbackCoachId);
        const accountId = cleanSlug(window?.accountId, defaultWorkspaceAccountFromCoachAccount().id);
        const locationId = cleanSlug(window?.locationId, "");
        return end > start ? { start, end, coachId, accountId, ...(locationId ? { locationId } : {}) } : null;
      })
      .filter((window): window is AvailabilityWindow => Boolean(window))
      .sort(
        (a, b) =>
          (a.coachId || "").localeCompare(b.coachId || "") ||
          (a.locationId || "").localeCompare(b.locationId || "") ||
          a.start - b.start,
      )
      .reduce<AvailabilityWindow[]>((merged, window) => {
        const previous = merged.at(-1);
        if (
          previous &&
          previous.coachId === window.coachId &&
          (previous.locationId || "") === (window.locationId || "") &&
          window.start < previous.end
        ) {
          previous.end = Math.max(previous.end, window.end);
        } else {
          merged.push({ ...window });
        }
        return merged;
      }, []);
  });
}

/**
 * A window pinned to a location only opens the coach there. A window with no
 * location predates locations and still covers every one. Same rule as the
 * server's availabilityWindowCoversLocation.
 */
export function availabilityWindowCoversLocation(window: AvailabilityWindow, locationId = "") {
  return !window.locationId || !locationId || window.locationId === locationId;
}

// Band tint per location, as a hue. hsl() rather than hex so it sits on top of
// --available in either theme, and the hex ratchet stays where it is.
export const LOCATION_BAND_HUES = [150, 212, 32, 282, 352, 52, 188, 320];

export function availabilityForCoach(availability: AvailabilityWindow[][], coachId: string, fallbackCoachId: string) {
  return availability.map((dayWindows) =>
    dayWindows.filter((window) => (window.coachId || fallbackCoachId) === coachId),
  );
}

export function isCancelledGroupSessionItem(item: CalendarItem) {
  return (
    item.kind === "block" &&
    Boolean(item.serviceId) &&
    (item.note === CANCELLED_GROUP_SESSION_NOTE || item.title === CANCELLED_GROUP_SESSION_TITLE)
  );
}

export function isCancelledGroupSessionMatch(item: CalendarItem, serviceId: string, week: number, day: number, start: number) {
  return (
    isCancelledGroupSessionItem(item) &&
    item.serviceId === serviceId &&
    itemWeek(item) === week &&
    item.day === day &&
    item.start === start
  );
}

export type Draft =
  | {
      mode: "move";
      itemId: string;
      week: number;
      day: number;
      start: number;
      duration: number;
      valid: boolean;
    }
  | {
      mode: "resize";
      itemId: string;
      week: number;
      day: number;
      start: number;
      duration: number;
      valid: boolean;
    }
  | {
      mode: "block";
      week: number;
      day: number;
      start: number;
      duration: number;
      valid: boolean;
    }
  | {
      mode: "place";
      week: number;
      day: number;
      start: number;
      duration: number;
      valid: boolean;
    };

export type CalendarFeedStatus = "checking" | "connected" | "offline";

export type CalendarSaveStatus = "idle" | "saving" | "saved" | "failed";
