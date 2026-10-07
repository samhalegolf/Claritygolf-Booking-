import {
  cleanServiceResourceIds,
  cleanServiceResourceTypes,
  type ResourceMode,
  serviceResourceMode,
} from "../../../netlify/functions/_shared/resources.mts";
import {
  cleanScopeIds,
  primaryServiceLocationId,
  serviceCoachIds,
  serviceLocationIds,
} from "../../../netlify/functions/_shared/service-scope.mts";
import { t } from "../../lib/i18n";
import { formatMoney } from "../../lib/money";
import { clamp } from "../../lib/number";
import { timeToMinutes } from "../../lib/date";
import { normalizeBookingScreenIds } from "../public-booking/bookingScreens";
import { cleanHexColor, cleanSlug, defaultWorkspaceAccountFromCoachAccount } from "../workspace/workspaceModel";

/**
 * Lesson types (services) in the coach app: their shape, the built-in
 * defaults, group pricing, and cleaning what the settings screen edits.
 *
 * The browser-side twin of netlify/functions/_shared/services.mts.
 */

type LessonFormat = "private" | "group" | "package" | "video-review";
export type GroupServiceSchedule = {
  dayOfWeek: number;
  startMinutes: number;
  occurrenceCount: number;
  active: boolean;
};
export type PriceMode = "session" | "per-person";
type PackageCoverageMode = "upfront" | "lesson-by-lesson";
export type ServiceEditorFormat = "private" | "group" | "custom-group" | "package" | "video-review";

export type Service = {
  id: string;
  accountId?: string;
  /** Every coach who teaches it, in the order a booking tries them. */
  coachIds: string[];
  name: string;
  duration: number;
  price: number;
  description: string;
  visibility: "public" | "private";
  active: boolean;
  capacity: number;
  minParticipants: number;
  lessonFormat: LessonFormat;
  priceMode: PriceMode;
  /** Fill for this lesson type's cards on the calendar. Hex, from settings. */
  color?: string;
  /** Every place it runs, in the order a booking tries them. */
  locationIds: string[];
  /** Whether a booking must hold one of the location's resources, or takes one only when free. */
  resourceMode?: ResourceMode;
  /** Whole resource types it may take, by name. With resourceIds empty too, any resource. */
  resourceTypes?: string[];
  /** Single resources it may take, as "locationId/resourceId". */
  resourceIds?: string[];
  lessonNote?: string;
  location: string;
  groupSchedule?: GroupServiceSchedule;
  packageAllowance?: number;
  packageCoverageMode?: PackageCoverageMode;
  packageCoversServiceId?: string;
  /** Pass types only: the services a pass of this type pays for. */
  coversServiceIds?: string[];
  /** Pass types only: pays for any service; coversServiceIds is then ignored. */
  coversAllServices?: boolean;
  /** Pass types only: months a pass stays spendable; 0 = never. Unset = 12. */
  passExpiryMonths?: number;
  /** Packages only: purchased units may fund other eligible services by value. */
  crossRedeemable?: boolean;
  /** Services only: may be funded by value from a cross-redeemable pass. */
  acceptsCrossRedemption?: boolean;
  /** Video reviews only: days between booking and the clip being owed back. */
  reviewTurnaroundDays?: number;
  bookingScreenIds?: string[];
  customGroup?: boolean;
  customGroupEnabled?: boolean;
  baseParticipants?: number;
  basePrice?: number;
  extraPersonPrice?: number;
  archived?: boolean;
};

export type ServiceListTab = "active" | "archived";
export type PendingServiceAction =
  | { serviceId: string; mode: "archive" }
  | { serviceId: string; mode: "delete" }
  | null;

/**
 * What a pass type covers, as a list. Older pass types hold one id in
 * packageCoversServiceId; newer ones a list in coversServiceIds.
 */
export function passCoverageList(service?: Partial<Service> | null): string[] {
  const raw =
    Array.isArray(service?.coversServiceIds) && service.coversServiceIds.length
      ? service.coversServiceIds
      : [service?.packageCoversServiceId];
  const seen = new Set<string>();
  for (const entry of raw) {
    const id = typeof entry === "string" ? entry.trim().slice(0, 120) : "";
    if (id) seen.add(id);
    if (seen.size >= 12) break;
  }
  return [...seen];
}

export function hasCustomGroupFlag(service?: Partial<Service> | null) {
  return service?.customGroup === true || service?.customGroupEnabled === true;
}

export function isCustomGroupService(service?: Partial<Service> | null) {
  return Boolean(hasCustomGroupFlag(service));
}

export function isScheduledGroupService(service?: Partial<Service> | null) {
  return Boolean(service?.lessonFormat === "group" && !isCustomGroupService(service));
}

export const DEFAULT_REVIEW_TURNAROUND_DAYS = 3;
export const MAX_REVIEW_TURNAROUND_DAYS = 30;

export function isAppointmentStyleService(service?: Partial<Service> | null) {
  return Boolean(service && service.lessonFormat !== "package" && !isScheduledGroupService(service));
}

export function serviceEditorFormat(service?: Partial<Service> | null): ServiceEditorFormat {
  if (service?.lessonFormat === "package") return "package";
  if (service?.lessonFormat === "video-review") return "video-review";
  if (isCustomGroupService(service)) return "custom-group";
  if (service?.lessonFormat === "group") return "group";
  return "private";
}

export function serviceFormatLabel(service?: Partial<Service> | null) {
  const format = serviceEditorFormat(service);
  if (format === "package") return t("Package");
  if (format === "video-review") return t("Video review");
  if (format === "custom-group") return t("Custom group");
  if (format === "group") return t("Group");
  return t("Private");
}

export function customGroupBaseParticipants(service?: Partial<Service> | null) {
  const raw = Number(service?.baseParticipants ?? DEFAULT_CUSTOM_GROUP_BASE_PARTICIPANTS);
  return Number.isFinite(raw)
    ? clamp(Math.round(raw), customGroupMinParticipants(service), customGroupMaxParticipants(service))
    : DEFAULT_CUSTOM_GROUP_BASE_PARTICIPANTS;
}

export function customGroupBasePrice(service?: Partial<Service> | null) {
  const raw = Number(service?.basePrice ?? service?.price ?? DEFAULT_CUSTOM_GROUP_BASE_PRICE);
  return Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : DEFAULT_CUSTOM_GROUP_BASE_PRICE;
}

export function customGroupExtraPersonPrice(service?: Partial<Service> | null) {
  const raw = Number(service?.extraPersonPrice ?? DEFAULT_CUSTOM_GROUP_EXTRA_PERSON_PRICE);
  return Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : DEFAULT_CUSTOM_GROUP_EXTRA_PERSON_PRICE;
}

export function customGroupMinParticipants(service?: Partial<Service> | null) {
  const raw = Number(service?.minParticipants ?? DEFAULT_CUSTOM_GROUP_MIN_PARTICIPANTS);
  return Number.isFinite(raw) ? clamp(Math.round(raw), 2, DEFAULT_CUSTOM_GROUP_MAX_PARTICIPANTS) : DEFAULT_CUSTOM_GROUP_MIN_PARTICIPANTS;
}

export function customGroupMaxParticipants(service?: Partial<Service> | null) {
  const raw = Number(service?.capacity ?? DEFAULT_CUSTOM_GROUP_MAX_PARTICIPANTS);
  return Number.isFinite(raw) ? clamp(Math.round(raw), customGroupMinParticipants(service), DEFAULT_CUSTOM_GROUP_MAX_PARTICIPANTS) : DEFAULT_CUSTOM_GROUP_MAX_PARTICIPANTS;
}

export function calculateCustomGroupPrice(service: Partial<Service> | null | undefined, participantCount: number) {
  const baseParticipants = customGroupBaseParticipants(service);
  const basePrice = customGroupBasePrice(service);
  const extraPersonPrice = customGroupExtraPersonPrice(service);
  const extraPeople = Math.max(0, Math.round(participantCount) - baseParticipants);
  return basePrice + extraPeople * extraPersonPrice;
}

export type ServiceEditor = Omit<Service, "id"> & {
  id?: string;
};
export const MAX_GROUP_OCCURRENCE_COUNT = 52;

export const defaultServices: Service[] = [
  {
    id: "lesson-30",
    coachIds: [],
    locationIds: [],
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
    coachIds: [],
    locationIds: [],
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
    coachIds: [],
    locationIds: [],
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
    coachIds: [],
    locationIds: [],
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
    groupSchedule: {
      dayOfWeek: 2,
      startMinutes: timeToMinutes(18, 0),
      occurrenceCount: 8,
      active: true,
    },
    lessonNote: "Group coaching bay",
    location: "Group coaching bay",
  },
  {
    id: "member-30",
    coachIds: [],
    locationIds: [],
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
    coachIds: [],
    locationIds: [],
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
    coachIds: [],
    locationIds: [],
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
export const DEFAULT_CUSTOM_GROUP_BASE_PARTICIPANTS = 3;
const DEFAULT_CUSTOM_GROUP_BASE_PRICE = 200;
const DEFAULT_CUSTOM_GROUP_EXTRA_PERSON_PRICE = 20;
export const DEFAULT_CUSTOM_GROUP_MIN_PARTICIPANTS = 2;
export const DEFAULT_CUSTOM_GROUP_MAX_PARTICIPANTS = 5;

export function defaultGroupSchedule(): GroupServiceSchedule {
  return {
    dayOfWeek: 2,
    startMinutes: timeToMinutes(18, 0),
    occurrenceCount: 8,
    active: true,
  };
}

export function cleanGroupSchedule(
  value: unknown,
  fallback: GroupServiceSchedule = defaultGroupSchedule(),
): GroupServiceSchedule {
  const source = typeof value === "object" && value !== null ? value : {};
  const rawDay = Number.isFinite(Number((source as Partial<GroupServiceSchedule>).dayOfWeek))
    ? Number((source as Partial<GroupServiceSchedule>).dayOfWeek)
    : fallback.dayOfWeek;
  const rawStart = Number.isFinite(Number((source as Partial<GroupServiceSchedule>).startMinutes))
    ? Number((source as Partial<GroupServiceSchedule>).startMinutes)
    : fallback.startMinutes;
  const rawOccurrence = Number.isFinite(Number((source as Partial<GroupServiceSchedule>).occurrenceCount))
    ? Number((source as Partial<GroupServiceSchedule>).occurrenceCount)
    : fallback.occurrenceCount;
  return {
    dayOfWeek: clamp(Math.round(rawDay), 0, 6),
    startMinutes: Math.round(rawStart),
    occurrenceCount: clamp(Math.round(rawOccurrence), 1, MAX_GROUP_OCCURRENCE_COUNT),
    active: (source as Partial<GroupServiceSchedule>).active !== false,
  };
}

/**
 * Starting fills for lesson types, handed out by position so a workspace that
 * has never opened the colour picker still reads as several kinds of lesson
 * rather than one wall of the same colour. Dark enough to carry white text at
 * the size a calendar card actually gets.
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

export function defaultServiceColor(index: number) {
  return serviceColorPalette[Math.abs(index) % serviceColorPalette.length];
}

function cleanEditableServiceText(value: unknown, fallback: string, maxLength: number) {
  if (typeof value === "string") return value.trim().slice(0, maxLength);
  return fallback;
}

// The per-field fallback for a service.
//
// This used to be defaultServices[index] -- the original coach's real lesson
// list -- so a service arriving with a missing name, price or note had that
// coach's name, price and "Bay hire included" written into it. Structural
// defaults (a duration, a capacity of one) are product-level and stay; anything
// a coach would recognise as *theirs* does not.
const neutralServiceFallback: Service = {
  ...defaultServices[0],
  id: "",
  name: "",
  description: "",
  lessonNote: "",
  location: "",
  price: 0,
};

// Whether a booking takes one of the location's resources, and which types or
// single resources it may take. A review is not at a location at all.
function cleanServiceResourceUse(service: Partial<Service> | undefined, canUseResources: boolean) {
  const resourceMode = canUseResources ? serviceResourceMode(service) : "none";
  if (resourceMode === "none") return {};
  return {
    resourceMode,
    resourceTypes: cleanServiceResourceTypes(service?.resourceTypes),
    // Unqualified ids are from when a lesson type had one location.
    resourceIds: cleanServiceResourceIds(service?.resourceIds, primaryServiceLocationId(service)),
  };
}

export function cleanService(service?: Partial<Service>, index = 0): Service {
  const fallback = neutralServiceFallback;
  const descriptionFallback = service ? "" : fallback.description;
  const locationFallback = service ? "" : fallback.location;
  const lessonNoteFallback = service ? service.location || "" : fallback.lessonNote || fallback.location || "";
  const name =
    typeof service?.name === "string" && service.name.trim()
      ? service.name.trim().slice(0, 120)
      : fallback.name;
  const duration = Number.isFinite(Number(service?.duration)) ? Number(service?.duration) : fallback.duration;
  const price = Number.isFinite(Number(service?.price)) ? Number(service?.price) : fallback.price;
  const capacity = Number.isFinite(Number(service?.capacity)) ? Number(service?.capacity) : fallback.capacity || 1;
  // The chosen lesson format is authoritative. Legacy rows that predate the
  // lessonFormat field are still detected by their "package-" id prefix, but a
  // service name is never used to infer the format.
  const looksLikePackage =
    service?.lessonFormat === "package" ||
    (!service?.lessonFormat && String(service?.id || "").startsWith("package-"));
  const lessonFormat: LessonFormat =
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
      ? clamp(Math.round(capacity || DEFAULT_CUSTOM_GROUP_MAX_PARTICIPANTS), DEFAULT_CUSTOM_GROUP_MIN_PARTICIPANTS, DEFAULT_CUSTOM_GROUP_MAX_PARTICIPANTS)
      : clamp(Math.round(capacity), lessonFormat === "group" ? 2 : 1, 24);
  const rawMinParticipants = Number.isFinite(Number(service?.minParticipants))
    ? Number(service?.minParticipants)
    : customGroup
      ? DEFAULT_CUSTOM_GROUP_MIN_PARTICIPANTS
      : lessonFormat === "group"
      ? Math.min(2, cleanCapacity)
      : 1;
  const minParticipants =
    lessonFormat === "group" ? clamp(Math.round(rawMinParticipants), 2, cleanCapacity) : 1;
  const baseParticipants = customGroupBaseParticipants({ ...service, capacity: cleanCapacity });
  const basePrice = customGroupBasePrice(service);
  const extraPersonPrice = customGroupExtraPersonPrice(service);
  const priceMode: PriceMode =
    lessonFormat === "group" && service?.priceMode === "per-person" && !customGroup ? "per-person" : "session";
  const packageAllowance = Number.isFinite(Number(service?.packageAllowance))
    ? clamp(Math.round(Number(service?.packageAllowance)), 1, 100)
    : Math.max(1, fallback.packageAllowance ?? 5);
  const packageCoverageMode: PackageCoverageMode =
    service?.packageCoverageMode === "lesson-by-lesson" ? "lesson-by-lesson" : "upfront";
  const groupSchedule = lessonFormat === "group" && !customGroup ? cleanGroupSchedule(service?.groupSchedule, fallback.groupSchedule) : undefined;
  const bookingScreenIds = normalizeBookingScreenIds(service?.bookingScreenIds);
  return {
    id: cleanSlug(service?.id, cleanSlug(name, `service-${Date.now()}-${index}`)),
    accountId: cleanSlug(service?.accountId, fallback.accountId || defaultWorkspaceAccountFromCoachAccount().id),
    coachIds: cleanScopeIds(serviceCoachIds(service)),
    name,
    duration: clamp(Math.round(duration), 15, 240),
    price: Math.max(0, Math.round(price)),
    description: cleanEditableServiceText(service?.description, descriptionFallback, 240),
    visibility: lessonFormat === "package" || service?.visibility === "private" ? "private" : "public",
    active: service?.active !== false,
    capacity: cleanCapacity,
    minParticipants,
    lessonFormat,
    priceMode,
    color: cleanHexColor(service?.color, defaultServiceColor(index)),
    locationIds: cleanScopeIds(serviceLocationIds(service)),
    ...cleanServiceResourceUse(service, !videoReview && lessonFormat !== "package"),
    lessonNote: cleanEditableServiceText(service?.lessonNote, lessonNoteFallback, 180),
    location: cleanEditableServiceText(service?.location, locationFallback, 160),
    packageAllowance: lessonFormat === "package" ? packageAllowance : undefined,
    packageCoverageMode: lessonFormat === "package" ? packageCoverageMode : undefined,
    packageCoversServiceId: lessonFormat === "package" ? passCoverageList(service)[0] || undefined : undefined,
    coversServiceIds: lessonFormat === "package" ? passCoverageList(service) : undefined,
    coversAllServices: lessonFormat === "package" && service?.coversAllServices === true ? true : undefined,
    passExpiryMonths:
      lessonFormat === "package" && service?.passExpiryMonths !== undefined && Number.isFinite(Number(service.passExpiryMonths))
        ? clamp(Math.round(Number(service.passExpiryMonths)), 0, 120)
        : undefined,
    crossRedeemable: lessonFormat === "package" ? service?.crossRedeemable === true : undefined,
    acceptsCrossRedemption:
      lessonFormat !== "package" ? service?.acceptsCrossRedemption !== false : undefined,
    reviewTurnaroundDays: videoReview
      ? clamp(
          Math.round(
            Number(service?.reviewTurnaroundDays ?? fallback.reviewTurnaroundDays ?? DEFAULT_REVIEW_TURNAROUND_DAYS) ||
              DEFAULT_REVIEW_TURNAROUND_DAYS,
          ),
          1,
          MAX_REVIEW_TURNAROUND_DAYS,
        )
      : undefined,
    groupSchedule,
    bookingScreenIds,
    customGroup: customGroup || undefined,
    customGroupEnabled: customGroup || undefined,
    baseParticipants: customGroup ? baseParticipants : undefined,
    basePrice: customGroup ? basePrice : undefined,
    extraPersonPrice: customGroup ? extraPersonPrice : undefined,
    archived: service?.archived === true,
  };
}

export function cleanServices(serviceList?: Partial<Service>[]): Service[] {
  // Only seed the demo lesson types when there is no services data at all.
  // An explicit empty list means the coach deleted them and must stay empty.
  const source = Array.isArray(serviceList) ? serviceList : defaultServices;
  const seen = new Set<string>();
  return source.map((service, index) => {
    const clean = cleanService(service, index);
    let id = clean.id;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${clean.id}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    return { ...clean, id };
  });
}

export function servicePriceLabel(service?: (Pick<Service, "price" | "priceMode"> & Partial<Service>) | null) {
  if (!service) return t("No charge");
  if (isCustomGroupService(service)) {
    return t("{price} up to {count}", { price: formatMoney(customGroupBasePrice(service)), count: customGroupBaseParticipants(service) });
  }
  return service.priceMode === "per-person" ? t("{price} pp", { price: formatMoney(service.price) }) : formatMoney(service.price);
}

export type ServiceNumberField =
  | "duration"
  | "price"
  | "packageAllowance"
  | "reviewTurnaroundDays"
  | "baseParticipants"
  | "basePrice"
  | "extraPersonPrice";

export const SERVICE_NUMBER_LIMITS: Record<ServiceNumberField, { min: number; max: number; fallback: number }> = {
  duration: { min: 15, max: 240, fallback: 60 },
  price: { min: 0, max: 100000, fallback: 0 },
  packageAllowance: { min: 1, max: 100, fallback: 5 },
  reviewTurnaroundDays: {
    min: 1,
    max: MAX_REVIEW_TURNAROUND_DAYS,
    fallback: DEFAULT_REVIEW_TURNAROUND_DAYS,
  },
  baseParticipants: {
    min: DEFAULT_CUSTOM_GROUP_MIN_PARTICIPANTS,
    max: DEFAULT_CUSTOM_GROUP_MAX_PARTICIPANTS,
    fallback: DEFAULT_CUSTOM_GROUP_BASE_PARTICIPANTS,
  },
  basePrice: { min: 0, max: 100000, fallback: DEFAULT_CUSTOM_GROUP_BASE_PRICE },
  extraPersonPrice: { min: 0, max: 100000, fallback: DEFAULT_CUSTOM_GROUP_EXTRA_PERSON_PRICE },
};

export function generateServiceDraftId() {
  return `service-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function emptyServiceEditor(): ServiceEditor {
  return {
    name: "",
    duration: 60,
    price: 0,
    description: "",
    visibility: "public",
    active: true,
    capacity: 1,
    minParticipants: 1,
    lessonFormat: "private",
    priceMode: "session",
    color: defaultServiceColor(0),
    coachIds: [],
    locationIds: [],
    lessonNote: "",
    location: "",
    groupSchedule: defaultGroupSchedule(),
    packageAllowance: 5,
    packageCoverageMode: "upfront",
    packageCoversServiceId: "",
    bookingScreenIds: ["main"],
    customGroup: false,
    customGroupEnabled: false,
    baseParticipants: DEFAULT_CUSTOM_GROUP_BASE_PARTICIPANTS,
    basePrice: DEFAULT_CUSTOM_GROUP_BASE_PRICE,
    extraPersonPrice: DEFAULT_CUSTOM_GROUP_EXTRA_PERSON_PRICE,
  };
}
