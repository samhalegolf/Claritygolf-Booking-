import { isOriginalWorkspace } from "./coach-account.mts";
import { recordBelongsToAccountStrict } from "./coach-auth.mts";
import { hasPermission, permissionDenied } from "./permissions.mts";
import {
  cleanResourceMode,
  cleanServiceResourceIds,
  cleanServiceResourceTypes,
  serviceResourceMode,
} from "./resources.mts";
import {
  cleanScopeIds,
  primaryServiceLocationId,
  serviceCoachIds,
  serviceIncludesCoach,
  serviceLocationIds,
} from "./service-scope.mts";
import { parseSettingJson, settingValue } from "./settings-store.mts";
import { cleanPositiveInteger, cleanSlug, cleanString, timeToMinutes } from "./values.mts";
import {
  defaultLocationFromCoachAccount,
  defaultLocationId,
  firstCoachId,
  locationById,
} from "./workspace.mts";

/**
 * Lesson types (services): cleaning what the settings screen saves, the
 * built-in defaults, group and video review rules, and which coach may edit
 * which lesson type.
 *
 * A lesson type is the template. A booking is one lesson on the calendar and
 * lives in bookings.mts.
 */

export const MAX_GROUP_OCCURRENCE_COUNT = 52;
const CUSTOM_GROUP_DEFAULTS = {
  baseParticipants: 3,
  basePrice: 200,
  extraPersonPrice: 20,
  minParticipants: 2,
  maxParticipants: 5,
};

export const defaultServices = [
  {
    id: "lesson-30",
    name: "30min Lesson",
    duration: 30,
    price: 100,
    description: "Price Includes Bay Hire",
    visibility: "public",
    active: true,
    capacity: 1,
    minParticipants: 1,
    lessonFormat: "private",
    priceMode: "session",
    lessonNote: "Bay hire included",
    location: "Bay hire included",
  },
  {
    id: "lesson-60",
    name: "1 Hour Golf Lesson",
    duration: 60,
    price: 180,
    description: "Price Includes Bay Hire",
    visibility: "public",
    active: true,
    capacity: 1,
    minParticipants: 1,
    lessonFormat: "private",
    priceMode: "session",
    lessonNote: "Bay hire included",
    location: "Bay hire included",
  },
  {
    id: "lesson-pair",
    name: "2 Person Golf Lesson",
    duration: 60,
    price: 200,
    description: "Two-player coaching session",
    visibility: "public",
    active: true,
    capacity: 2,
    minParticipants: 1,
    lessonFormat: "private",
    priceMode: "session",
    lessonNote: "Bay hire included",
    location: "Bay hire included",
  },
  {
    id: "group-clinic",
    name: "Group Golf Clinic",
    duration: 90,
    price: 55,
    description: "Small-group coaching session with shared practice goals",
    visibility: "public",
    active: true,
    capacity: 6,
    minParticipants: 3,
    lessonFormat: "group",
    priceMode: "per-person",
    lessonNote: "Group coaching bay",
    location: "Group coaching bay",
    groupSchedule: {
      dayOfWeek: 2,
      startMinutes: timeToMinutes(18, 0),
      occurrenceCount: 8,
      active: true,
    },
  },
  {
    id: "member-30",
    name: "30min Golf Lesson (Range 24/7 Member)",
    duration: 30,
    price: 90,
    description: "Bay hire is deducted from membership account",
    visibility: "public",
    active: true,
    capacity: 1,
    minParticipants: 1,
    lessonFormat: "private",
    priceMode: "session",
    lessonNote: "Bay hire deducted from membership account",
    location: "Range 24/7 member bay",
  },
  {
    id: "member-60",
    name: "1 Hour Golf Lesson (Range 24/7 Member)",
    duration: 60,
    price: 160,
    description: "Bay hire is deducted from membership account",
    visibility: "public",
    active: true,
    capacity: 1,
    minParticipants: 1,
    lessonFormat: "private",
    priceMode: "session",
    lessonNote: "Bay hire deducted from membership account",
    location: "Range 24/7 member bay",
  },
  {
    id: "package-60",
    name: "1 hour Lesson - 5 Lesson Package",
    duration: 60,
    price: 650,
    description: "Five one-hour lessons tracked as a package.",
    visibility: "private",
    active: true,
    capacity: 1,
    minParticipants: 1,
    lessonFormat: "package",
    priceMode: "session",
    lessonNote: "Package allowance",
    location: "Package allowance",
    packageAllowance: 5,
    packageCoverageMode: "upfront",
    packageCoversServiceId: "lesson-60",
  },
];

function hasCustomGroupFlag(service) {
  return service?.customGroup === true || service?.customGroupEnabled === true;
}

export function isCustomGroupService(service) {
  return Boolean(hasCustomGroupFlag(service));
}

export function isScheduledGroupService(service) {
  return Boolean(service?.lessonFormat === "group" && !isCustomGroupService(service));
}

/**
 * An asynchronous video review: the player books it, sends a swing, and the
 * coach returns an annotated clip within the turnaround.
 *
 * It is a lesson format rather than a flag on a normal lesson because the one
 * thing it does not have is a time. Everything else a lesson has -- a price, a
 * duration of the coach's work, notes, a pass that can pay for it, a place in
 * the client's history -- it has unchanged, and that is exactly why it still
 * gets a calendar item. The slot it lands on is the deadline, not an
 * appointment.
 */
export function isVideoReviewService(service) {
  return Boolean(service?.lessonFormat === "video-review");
}

/** Default working days between booking a review and owing it back. */
const VIDEO_REVIEW_DEFAULT_TURNAROUND_DAYS = 3;
const VIDEO_REVIEW_MAX_TURNAROUND_DAYS = 30;

export function cleanReviewTurnaroundDays(value, fallback = VIDEO_REVIEW_DEFAULT_TURNAROUND_DAYS) {
  const days = Number(value);
  if (!Number.isFinite(days)) return fallback;
  return Math.max(1, Math.min(VIDEO_REVIEW_MAX_TURNAROUND_DAYS, Math.round(days)));
}

function customGroupBaseParticipants(service) {
  return cleanPositiveInteger(
    service?.baseParticipants,
    CUSTOM_GROUP_DEFAULTS.baseParticipants,
    CUSTOM_GROUP_DEFAULTS.minParticipants,
    customGroupMaxParticipants(service),
  );
}

function customGroupBasePrice(service) {
  return cleanPositiveInteger(
    service?.basePrice ?? service?.price,
    CUSTOM_GROUP_DEFAULTS.basePrice,
    0,
    100000,
  );
}

function customGroupExtraPersonPrice(service) {
  return cleanPositiveInteger(
    service?.extraPersonPrice,
    CUSTOM_GROUP_DEFAULTS.extraPersonPrice,
    0,
    100000,
  );
}

export function customGroupMinParticipants(service) {
  return cleanPositiveInteger(
    service?.minParticipants,
    CUSTOM_GROUP_DEFAULTS.minParticipants,
    CUSTOM_GROUP_DEFAULTS.minParticipants,
    CUSTOM_GROUP_DEFAULTS.maxParticipants,
  );
}

export function customGroupMaxParticipants(service) {
  return cleanPositiveInteger(
    service?.capacity,
    CUSTOM_GROUP_DEFAULTS.maxParticipants,
    CUSTOM_GROUP_DEFAULTS.minParticipants,
    CUSTOM_GROUP_DEFAULTS.maxParticipants,
  );
}

export function calculateCustomGroupPrice(service, participantCount) {
  const baseParticipants = customGroupBaseParticipants(service);
  const extraPeople = Math.max(0, cleanPositiveInteger(participantCount, 1, 1, CUSTOM_GROUP_DEFAULTS.maxParticipants) - baseParticipants);
  return customGroupBasePrice(service) + extraPeople * customGroupExtraPersonPrice(service);
}

/**
 * Starting fills for lesson types, handed out by position. Kept in step with
 * serviceColorPalette in src/App.tsx so a service that has never had a colour
 * picked reads the same on the server as it does in the browser.
 */
const serviceColorPalette = [
  "#2b2233",
  "#1c3348",
  "#14342a",
  "#3f3320",
  "#2f2438",
  "#123043",
  "#1a3b2f",
  "#402b28",
];

function defaultServiceColor(index) {
  return serviceColorPalette[Math.abs(index) % serviceColorPalette.length];
}

export function cleanHexColor(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed : fallback;
}

function cleanGroupSchedule(value, fallback = {}) {
  const source = typeof value === "object" && value !== null ? value : {};
  const dayOfWeek = Number.isFinite(Number(source.dayOfWeek))
    ? Number(source.dayOfWeek)
    : Number.isFinite(Number(fallback.dayOfWeek))
      ? Number(fallback.dayOfWeek)
      : 2;
  const startMinutes = Number.isFinite(Number(source.startMinutes))
    ? Number(source.startMinutes)
    : Number.isFinite(Number(fallback.startMinutes))
      ? Number(fallback.startMinutes)
      : timeToMinutes(18, 0);
  const occurrenceCount = Number.isFinite(Number(source.occurrenceCount))
    ? Number(source.occurrenceCount)
    : Number.isFinite(Number(fallback.occurrenceCount))
      ? Number(fallback.occurrenceCount)
      : 8;
  return {
    dayOfWeek: Math.max(0, Math.min(6, Math.round(dayOfWeek))),
    startMinutes: Math.round(startMinutes),
    occurrenceCount: Math.max(1, Math.min(MAX_GROUP_OCCURRENCE_COUNT, Math.round(occurrenceCount))),
    active: source.active !== false,
  };
}

/**
 * The booking screens a lesson type appears on.
 *
 * Unrecognised ids are KEPT, not dropped. This used to filter against
 * a hardcoded list of known screens, and the filtered result is what gets
 * written back -- so a
 * plain load-and-save, with nobody touching the screens at all, silently pruned
 * any id this build did not know about and persisted the loss. A lesson type
 * would just stop appearing on the public booking page, with no error anywhere.
 *
 * That is fatal once screens become per-business: a service belonging to one
 * workspace would be pruned by a request serving another. Deciding what to
 * *show* is a render-time question (the public page matches on the screen it is
 * currently rendering, so an unknown id simply never matches); deciding what to
 * *store* is not the same question, and this function only stores.
 *
 * A missing field means legacy data, which defaults to the main screen. An
 * explicit empty list means "show on no booking screens" and is preserved.
 */
function cleanBookingScreenIds(value) {
  if (!Array.isArray(value)) return ["main"];
  return Array.from(
    new Set(
      value
        .map((candidate) => (typeof candidate === "string" ? candidate.trim().slice(0, 80) : ""))
        .filter(Boolean),
    ),
  ).slice(0, 24);
}

function cleanEditableServiceText(value, fallback = "", max = 600) {
  if (typeof value === "string") return value.trim().slice(0, max);
  return fallback;
}

// The per-field fallback for a service. Mirrors the frontend's
// neutralServiceFallback in src/App.tsx.
//
// This used to be defaultServices[index] -- the original coach's real lesson
// list -- so a service arriving with a missing name, price or note had that
// coach's name, price and "Bay hire included" written into it. Structural
// defaults (a duration, a capacity of one) are product-level and stay; anything
// a coach would recognise as *theirs* does not.
const neutralServiceFallback = {
  ...defaultServices[0],
  id: "",
  name: "",
  description: "",
  lessonNote: "",
  location: "",
  price: 0,
};

function cleanServiceResourceUse(service, canUseResources) {
  const resourceMode = canUseResources ? serviceResourceMode(service) : "none";
  if (resourceMode === "none") return {};
  return {
    resourceMode: cleanResourceMode(resourceMode),
    resourceTypes: cleanServiceResourceTypes(service?.resourceTypes),
    // Unqualified ids are from when a lesson type had one location.
    resourceIds: cleanServiceResourceIds(service?.resourceIds, primaryServiceLocationId(service)),
  };
}

function cleanService(service, index = 0, accountId = "") {
  const fallback = neutralServiceFallback;
  const descriptionFallback = service ? "" : fallback.description;
  const locationFallback = service ? "" : fallback.location;
  const lessonNoteFallback = service ? service.location || "" : fallback.lessonNote || fallback.location || "";
  const name = cleanString(service?.name, fallback.name, 120);
  const duration = Number.isFinite(Number(service?.duration)) ? Number(service.duration) : fallback.duration;
  const price = Number.isFinite(Number(service?.price)) ? Number(service.price) : fallback.price;
  const capacity = Number.isFinite(Number(service?.capacity)) ? Number(service.capacity) : fallback.capacity || 1;
  // The chosen lesson format is authoritative. Legacy rows that predate the
  // lessonFormat field are still detected by their "package-" id prefix, but a
  // service name is never used to infer the format.
  const looksLikePackage =
    service?.lessonFormat === "package" ||
    (!service?.lessonFormat && String(service?.id || "").startsWith("package-"));
  const lessonFormat =
    looksLikePackage
      ? "package"
      : service?.lessonFormat === "group"
        ? "group"
        : service?.lessonFormat === "video-review"
          ? "video-review"
          : "private";
  const videoReview = lessonFormat === "video-review";
  const customGroup = lessonFormat === "group" && hasCustomGroupFlag(service);
  const cleanCapacity = videoReview
    ? 1
    : customGroup
      ? Math.max(CUSTOM_GROUP_DEFAULTS.minParticipants, Math.min(CUSTOM_GROUP_DEFAULTS.maxParticipants, Math.round(capacity || CUSTOM_GROUP_DEFAULTS.maxParticipants)))
      : Math.max(lessonFormat === "group" ? 2 : 1, Math.min(24, Math.round(capacity)));
  const rawMinParticipants = Number.isFinite(Number(service?.minParticipants))
    ? Number(service.minParticipants)
    : customGroup
      ? CUSTOM_GROUP_DEFAULTS.minParticipants
      : lessonFormat === "group"
      ? Math.min(2, cleanCapacity)
      : 1;
  const minParticipants =
    lessonFormat === "group"
      ? Math.max(2, Math.min(cleanCapacity, Math.round(rawMinParticipants)))
      : 1;
  const priceMode =
    lessonFormat === "group" && service?.priceMode === "per-person" && !customGroup
      ? "per-person"
      : "session";
  const packageAllowance = Number.isFinite(Number(service?.packageAllowance))
    ? Math.max(1, Math.min(100, Math.round(Number(service.packageAllowance))))
    : Math.max(1, fallback.packageAllowance ?? 5);
  const packageCoverageMode = service?.packageCoverageMode === "lesson-by-lesson" ? "lesson-by-lesson" : "upfront";
  const groupSchedule = lessonFormat === "group" && !customGroup
    ? cleanGroupSchedule(service?.groupSchedule, fallback.groupSchedule || {})
    : undefined;
  const bookingScreenIds = cleanBookingScreenIds(service?.bookingScreenIds);
  return {
    id: cleanSlug(
      service?.id,
      cleanSlug(name, `service-${Date.now()}-${index}`),
    ),
    // The owning business is supplied by the caller. A stored service that
    // names no account used to adopt the original workspace's id, which made
    // it visible to that business and nobody else -- fail-open in the same
    // shape the calendar rows had.
    accountId: cleanSlug(service?.accountId, accountId),
    // Every coach who teaches it and every place it runs, in the order a
    // booking tries them. Older rows held one of each; see service-scope.mts.
    coachIds: cleanScopeIds(serviceCoachIds(service)),
    name,
    duration: Math.max(15, Math.min(240, Math.round(duration))),
    price: Math.max(0, Math.round(price)),
    description: cleanEditableServiceText(service?.description, descriptionFallback, 240),
    visibility:
      lessonFormat === "package" || service?.visibility === "private"
        ? "private"
        : "public",
    active: service?.active !== false,
    capacity: cleanCapacity,
    minParticipants,
    lessonFormat,
    priceMode,
    color: cleanHexColor(service?.color, defaultServiceColor(index)),
    locationIds: cleanScopeIds(serviceLocationIds(service)),
    // Whether a booking must hold, or only takes when free, one of the
    // location's resources, and which types or single resources it may take
    // (none chosen = any). A review is not at a location at all.
    ...cleanServiceResourceUse(service, !videoReview && lessonFormat !== "package"),
    lessonNote: cleanEditableServiceText(service?.lessonNote, lessonNoteFallback, 180),
    location: cleanEditableServiceText(service?.location, locationFallback, 160),
    packageAllowance: lessonFormat === "package" ? packageAllowance : undefined,
    packageCoverageMode: lessonFormat === "package" ? packageCoverageMode : undefined,
    packageCoversServiceId:
      lessonFormat === "package" ? cleanString(service?.packageCoversServiceId, "", 120) || undefined : undefined,
    crossRedeemable: lessonFormat === "package" ? service?.crossRedeemable === true : undefined,
    acceptsCrossRedemption:
      lessonFormat !== "package" ? service?.acceptsCrossRedemption !== false : undefined,
    // A review is one player's swing, reviewed once. Carrying a turnaround on
    // any other format would be a number nothing reads.
    reviewTurnaroundDays: videoReview
      ? cleanReviewTurnaroundDays(service?.reviewTurnaroundDays, fallback.reviewTurnaroundDays)
      : undefined,
    bookingScreenIds,
    customGroup: customGroup || undefined,
    customGroupEnabled: customGroup || undefined,
    baseParticipants: customGroup ? customGroupBaseParticipants({ ...service, capacity: cleanCapacity }) : undefined,
    basePrice: customGroup ? customGroupBasePrice(service) : undefined,
    extraPersonPrice: customGroup ? customGroupExtraPersonPrice(service) : undefined,
    archived: service?.archived === true,
    groupSchedule,
  };
}

// Every inbound external booking (Optix) files under this reserved lesson
// type. The id must match EXTERNAL_BOOKING_SERVICE_ID in _shared/integrations/ingest.mts.
export const EXTERNAL_BOOKING_SERVICE_ID = "external-booking";

export function isReservedExternalBookingService(service) {
  return cleanSlug(service?.id, "") === EXTERNAL_BOOKING_SERVICE_ID;
}

export function countManagedActiveServices(services) {
  return Array.isArray(services)
    ? services.filter((service) => service?.archived !== true && !isReservedExternalBookingService(service)).length
    : 0;
}

export function managedServicesForStorage(services) {
  return Array.isArray(services) ? services.filter((service) => !isReservedExternalBookingService(service)) : [];
}

const externalBookingServiceTemplate = {
  id: EXTERNAL_BOOKING_SERVICE_ID,
  name: "External Booking",
  duration: 60,
  price: 0,
  description: "Booking imported from an external system. Its time comes from the source; the source's own label is in the lesson note.",
  visibility: "private",
  active: true,
  capacity: 1,
  minParticipants: 1,
  lessonFormat: "private",
  priceMode: "session",
  lessonNote: "",
  location: "",
};

export function normalizeServices(serviceList, accountId = "") {
  // Only seed the demo lesson types when there is no services data at all.
  // An explicit empty list means the coach deleted them and must stay empty.
  const source = Array.isArray(serviceList) ? serviceList : defaultServices;
  const seen = new Set();
  const services = source.map((service, index) => {
    const clean = cleanService(service, index, accountId);
    let id = clean.id;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${clean.id}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    return { ...clean, id };
  });
  // The reserved External Booking type always exists in memory, so an inbound
  // external booking can never reference a missing lesson type. Legacy stored
  // copies are accepted, but new saves omit it because it is not part of the
  // business's lesson-type catalogue.
  if (!seen.has(EXTERNAL_BOOKING_SERVICE_ID)) {
    services.push(cleanService(externalBookingServiceTemplate, services.length, accountId));
  }
  return services;
}

export function serviceLocation(service, locations, account) {
  return (
    locationById(locations, primaryServiceLocationId(service)) ||
    locationById(locations, defaultLocationId(locations)) ||
    defaultLocationFromCoachAccount(account)
  );
}

export function serviceBelongsToContext(service, context, coaches = []) {
  if (!recordBelongsToAccountStrict(service, context.accountId)) return false;
  if (context.isAdmin) return true;
  return serviceIncludesCoach(service, context.coachId, firstCoachId(coaches));
}

function assertCanWriteService(context, service, previousService, coaches = []) {
  if (!recordBelongsToAccountStrict(service, context.accountId)) {
    throw permissionDenied("This service does not belong to your workspace.");
  }
  if (context.isAdmin) return;
  if (!hasPermission(context.user, "services", "own")) {
    throw permissionDenied("You do not have permission to edit lesson services.");
  }
  if (previousService && !serviceBelongsToContext(previousService, context, coaches)) {
    throw permissionDenied("You do not have permission to edit another coach's service.");
  }
  if (!serviceBelongsToContext(service, context, coaches)) {
    throw permissionDenied("You do not have permission to assign services to another coach.");
  }
}

export function mergeServicesForContext(incomingServices, currentServices, context, coaches = []) {
  if (context.isAdmin) return incomingServices.map((service) => ({ ...service, accountId: context.accountId }));
  const previousById = new Map((currentServices || []).map((service) => [service.id, service]));
  // Which coaches teach a lesson type is the admin's call. A coach keeps the
  // list an existing lesson type already has, and a new one is theirs alone.
  const ownedIncoming = incomingServices.map((service) => {
    const previous = previousById.get(service.id);
    const { coachId: _legacyCoachId, ...rest } = service;
    return {
      ...rest,
      accountId: context.accountId,
      coachIds: previous ? serviceCoachIds(previous) : [context.coachId],
    };
  });
  ownedIncoming.forEach((service) => assertCanWriteService(context, service, previousById.get(service.id), coaches));
  const ownedIds = new Set(ownedIncoming.map((service) => service.id));
  const preserved = (currentServices || []).filter(
    (service) => !ownedIds.has(service.id) && !serviceBelongsToContext(service, context, coaches),
  );
  return [...preserved, ...ownedIncoming];
}

/**
 * A business's lesson types.
 *
 * defaultServices is the original coach's actual list -- their lesson names,
 * their prices, their "Price Includes Bay Hire" note -- so it is the seed for
 * the original workspace only. A new business starts with no lesson types and
 * creates its own; inheriting somebody else's price list is worse than an
 * empty screen.
 */
export function servicesFromSettings(settings, accountId = "") {
  const scopedAccountId = cleanSlug(settingValue(settings, "accountId") || accountId, "");
  const seed = !scopedAccountId || isOriginalWorkspace(scopedAccountId) ? defaultServices : [];
  return normalizeServices(parseSettingJson(settings, "servicesJson", seed), scopedAccountId);
}
