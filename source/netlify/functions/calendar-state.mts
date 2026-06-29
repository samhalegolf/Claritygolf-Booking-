import type { Config } from "@netlify/functions";
import { createHash, randomUUID } from "node:crypto";

import { getGoogleCalendarSyncStatus, syncGoogleCalendarIfEnabled } from "./google-calendar-sync.mts";
import { inferBookingAction, notifyBookingEvent } from "./notification-engine.mts";

const sessionCookieName = "clarity_session";
const MAX_GROUP_OCCURRENCE_COUNT = 52;
const CUSTOM_GROUP_DEFAULTS = {
  baseParticipants: 3,
  basePrice: 200,
  extraPersonPrice: 20,
  minParticipants: 2,
  maxParticipants: 5,
};
const ADMIN_NOTIFICATION_DEBOUNCE_MS = 30_000;
const ADMIN_NOTIFICATION_DEBOUNCE_QUEUE_KEY = "adminNotificationDebounceQueueJson";
const CANCELLED_GROUP_SESSION_TITLE = "Cancelled group session";
const CANCELLED_GROUP_SESSION_NOTE = "__cancelled_group_session__";
const baseWeekStart = new Date(Date.UTC(2026, 5, 1));
const BOOKING_SCREEN_IDS = new Set([
  "main",
  "range-three-kings",
  "group-lessons",
  "private-lessons",
]);

type LessonFormat = "private" | "group" | "package";
type PriceMode = "session" | "per-person";
type PackageCoverageMode = "upfront" | "lesson-by-lesson";
type AdminDebounceAction = "booking" | "rescheduled" | "updated";
type PendingAdminNotification = {
  calendarItemId: string;
  action: AdminDebounceAction;
  queuedAt: string;
  fireAfter: string;
  originalPositionSignature: string;
  targetSignature: string;
  appointment: any;
  previousAppointment: any | null;
};
type GroupServiceSchedule = {
  dayOfWeek: number;
  startMinutes: number;
  occurrenceCount: number;
  active: boolean;
};

const defaultServices = [
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

const defaultInvoiceSettings = {
  enabled: true,
  showBillingWorkspace: true,
  prefix: "INV",
  nextNumber: 1001,
  currency: "NZD",
  taxName: "GST",
  taxNumber: "",
  taxRate: 15,
  bankAccount: "",
  paymentTermsDays: 7,
  businessAddress: "",
  headerText: "",
  footerText: "Thank you for training with Sam Hale Golf.",
  paymentInstructions:
    "Please pay by bank transfer and use the invoice number as reference.",
  customFields: [],
};

const DEFAULT_COACH_ID = "sam-hale-golf";

function timeToMinutes(hour: number, minute: number) {
  return hour * 60 + minute;
}

function cleanSlug(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || fallback;
}

function cleanGroupSchedule(value: unknown, fallback: GroupServiceSchedule = { dayOfWeek: 2, startMinutes: timeToMinutes(18, 0), occurrenceCount: 8, active: true }) {
  const source = typeof value === "object" && value !== null ? (value as Partial<GroupServiceSchedule>) : {};
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

function cleanBookingScreenIds(value: unknown) {
  if (!Array.isArray(value)) return ["main"];
  const cleaned = Array.from(
    new Set(
      value
        .map((candidate) => (typeof candidate === "string" ? candidate.trim() : ""))
        .filter((candidate) => BOOKING_SCREEN_IDS.has(candidate)),
    ),
  );
  return cleaned.length ? cleaned : ["main"];
}

function cleanEditableServiceText(value: unknown, fallback: string, maxLength: number) {
  if (typeof value === "string") return value.trim().slice(0, maxLength);
  return fallback;
}

function hasCustomGroupFlag(service?: Record<string, unknown> | null) {
  return service?.customGroup === true || service?.customGroupEnabled === true;
}

function cleanService(service?: Record<string, unknown>, index = 0) {
  const fallback = (defaultServices[index] ?? defaultServices[0]) as any;
  const descriptionFallback = service ? "" : fallback.description;
  const locationFallback = service ? "" : fallback.location;
  const lessonNoteFallback = service ? String(service?.location || "") : fallback.lessonNote || fallback.location || "";
  const name = cleanString(service?.name, fallback.name, 120);
  const duration = Number.isFinite(Number(service?.duration))
    ? Number(service?.duration)
    : fallback.duration;
  const price = Number.isFinite(Number(service?.price))
    ? Number(service?.price)
    : fallback.price;
  const capacity = Number.isFinite(Number(service?.capacity))
    ? Number(service?.capacity)
    : fallback.capacity || 1;
  const looksLikePackage =
    service?.lessonFormat === "package" ||
    String(service?.id || fallback.id || "").startsWith("package-") ||
    /package/i.test(name);
  const lessonFormat: LessonFormat = looksLikePackage
    ? "package"
    : service?.lessonFormat === "group"
      ? "group"
      : "private";
  const customGroup = lessonFormat === "group" && hasCustomGroupFlag(service);
  const cleanCapacity = customGroup
    ? Math.max(CUSTOM_GROUP_DEFAULTS.minParticipants, Math.min(CUSTOM_GROUP_DEFAULTS.maxParticipants, Math.round(capacity || CUSTOM_GROUP_DEFAULTS.maxParticipants)))
    : Math.max(lessonFormat === "group" ? 2 : 1, Math.min(24, Math.round(capacity)));
  const rawMinParticipants = Number.isFinite(Number(service?.minParticipants))
    ? Number(service?.minParticipants)
    : customGroup
      ? CUSTOM_GROUP_DEFAULTS.minParticipants
      : lessonFormat === "group"
      ? Math.min(2, cleanCapacity)
      : 1;
  const minParticipants = lessonFormat === "group"
    ? Math.max(2, Math.min(cleanCapacity, Math.round(rawMinParticipants)))
    : 1;
  const priceMode: PriceMode = lessonFormat === "group" && service?.priceMode === "per-person" && !customGroup ? "per-person" : "session";
  const packageAllowance = Number.isFinite(Number(service?.packageAllowance))
    ? Math.max(1, Math.min(100, Math.round(Number(service?.packageAllowance))))
    : Math.max(1, fallback.packageAllowance ?? 5);
  const packageCoverageMode: PackageCoverageMode = service?.packageCoverageMode === "lesson-by-lesson" ? "lesson-by-lesson" : "upfront";
  const groupSchedule = lessonFormat === "group" && !customGroup
    ? cleanGroupSchedule(service?.groupSchedule, (fallback.groupSchedule as GroupServiceSchedule) || { dayOfWeek: 2, startMinutes: timeToMinutes(18, 0), occurrenceCount: 8, active: true })
    : undefined;
  const bookingScreenIds = cleanBookingScreenIds(service?.bookingScreenIds);
  return {
    id: cleanSlug(service?.id as unknown, cleanSlug(name, `service-${Date.now()}-${index}`)),
    accountId: cleanSlug(service?.accountId as unknown, defaultWorkspaceAccountFromAccount({}).id),
    coachId: cleanSlug(service?.coachId as unknown, DEFAULT_COACH_ID),
    name,
    duration: Math.max(15, Math.min(240, Math.round(duration))),
    price: Math.max(0, Math.round(price)),
    description: cleanEditableServiceText(service?.description, descriptionFallback, 240),
    visibility: lessonFormat === "package" || service?.visibility === "private" ? "private" : "public",
    active: service?.active !== false,
    capacity: cleanCapacity,
    minParticipants,
    lessonFormat,
    priceMode,
    locationId: cleanSlug(service?.locationId as unknown, "") || undefined,
    lessonNote: cleanEditableServiceText(service?.lessonNote, lessonNoteFallback, 180),
    bookingScreenIds,
    archived: service?.archived === true,
    location: cleanEditableServiceText(service?.location, locationFallback, 160),
    packageAllowance: lessonFormat === "package" ? packageAllowance : undefined,
    packageCoverageMode: lessonFormat === "package" ? packageCoverageMode : undefined,
    packageCoversServiceId: lessonFormat === "package" ? cleanString(service?.packageCoversServiceId, "", 120) || undefined : undefined,
    customGroup: customGroup || undefined,
    customGroupEnabled: customGroup || undefined,
    baseParticipants: customGroup ? customGroupBaseParticipants({ ...service, capacity: cleanCapacity }) : undefined,
    basePrice: customGroup ? customGroupBasePrice(service) : undefined,
    extraPersonPrice: customGroup ? customGroupExtraPersonPrice(service) : undefined,
    groupSchedule,
  };
}

function normalizeServices(serviceList?: unknown[]): unknown[] {
  const source =
    Array.isArray(serviceList) && serviceList.length ? serviceList : defaultServices;
  const seen = new Set<string>();
  return source.map((service, index) => {
    const clean = cleanService(service as Record<string, unknown>, index);
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

const defaultAvailability = [
  [{ start: 990, end: 1200 }],
  [],
  [{ start: 840, end: 1200 }],
  [
    { start: 420, end: 660 },
    { start: 840, end: 990 },
  ],
  [{ start: 840, end: 960 }],
  [],
  [{ start: 900, end: 1080 }],
];

function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function nowIso() {
  return new Date().toISOString();
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function cleanString(value: unknown, fallback = "", max = 600) {
  return typeof value === "string"
    ? value.trim().slice(0, max) || fallback
    : fallback;
}

function cleanUrl(value: unknown, fallback = "") {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString().replace(/\/$/, "") : fallback;
  } catch {
    return fallback;
  }
}

function defaultWorkspaceAccountFromAccount(account: Record<string, unknown>) {
  const name = cleanString(account?.businessName, env("CLARITY_BUSINESS_NAME", "Sam Hale Golf"), 120);
  const slug = cleanSlug(account?.calendarSlug || account?.id || name, "sam-hale-golf");
  return {
    id: slug,
    name,
    slug,
    planKey: "founder",
    subscriptionStatus: "comped",
    billingProvider: "none",
    active: true,
  };
}

function cleanWorkspaceAccount(raw: any = {}, fallback = defaultWorkspaceAccountFromAccount({})) {
  const name = cleanString(raw?.name, fallback.name, 120);
  const slug = cleanSlug(raw?.slug || raw?.id || name, fallback.slug);
  const planKey = ["solo", "studio", "academy", "enterprise", "founder"].includes(raw?.planKey) ? raw.planKey : fallback.planKey;
  const subscriptionStatus = ["trialing", "active", "past_due", "paused", "cancelled", "comped", "internal"].includes(raw?.subscriptionStatus)
    ? raw.subscriptionStatus
    : fallback.subscriptionStatus;
  return {
    id: cleanSlug(raw?.id, slug),
    name,
    slug,
    planKey,
    subscriptionStatus,
    ownerUserId: cleanString(raw?.ownerUserId, fallback.ownerUserId || "", 120) || undefined,
    billingProvider: ["stripe", "manual", "none"].includes(raw?.billingProvider) ? raw.billingProvider : fallback.billingProvider,
    billingCustomerId: cleanString(raw?.billingCustomerId, "", 160) || undefined,
    billingSubscriptionId: cleanString(raw?.billingSubscriptionId, "", 160) || undefined,
    trialEndsAt: cleanString(raw?.trialEndsAt, "", 80) || undefined,
    currentPeriodEndsAt: cleanString(raw?.currentPeriodEndsAt, "", 80) || undefined,
    entitlementsOverride: raw?.entitlementsOverride && typeof raw.entitlementsOverride === "object" ? raw.entitlementsOverride : undefined,
    active: raw?.active !== false,
    createdAt: cleanString(raw?.createdAt, fallback.createdAt || "", 80) || undefined,
    updatedAt: cleanString(raw?.updatedAt, fallback.updatedAt || "", 80) || undefined,
  };
}

function normalizeWorkspaceAccounts(rawAccounts: any, account: Record<string, unknown>) {
  const fallback = defaultWorkspaceAccountFromAccount(account);
  const source = Array.isArray(rawAccounts) && rawAccounts.length ? rawAccounts : [fallback];
  const seen = new Set<string>();
  return source.map((raw, index) => {
    const clean = cleanWorkspaceAccount(raw, index === 0 ? fallback : defaultWorkspaceAccountFromAccount(account));
    let id = clean.id;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${clean.id}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    return { ...clean, id, active: clean.active || index === 0 };
  });
}

function defaultLocationFromAccount(account: Record<string, unknown>) {
  const workspaceAccount = defaultWorkspaceAccountFromAccount(account);
  const name = cleanString(account?.venueName, env("CLARITY_VENUE_NAME", "The Range 24/7 - Three Kings"), 140);
  const shortName = cleanString(account?.venueShortName, name, 80);
  return {
    id: "default-location",
    accountId: workspaceAccount.id,
    name,
    shortName,
    address: "",
    timezone: cleanString(account?.timezone, env("CLARITY_TIMEZONE", "Pacific/Auckland"), 80),
    active: true,
    archived: false,
    isDefault: true,
    sortOrder: 0,
  };
}

function cleanLocation(raw: any = {}, fallback = defaultLocationFromAccount({}), index = 0) {
  const name = cleanString(raw?.name, fallback.name, 140);
  const shortName = cleanString(raw?.shortName, name, 80);
  return {
    id: cleanSlug(raw?.id, cleanSlug(name, `location-${index + 1}`)),
    accountId: cleanSlug(raw?.accountId, fallback.accountId || defaultWorkspaceAccountFromAccount({}).id),
    name,
    shortName,
    address: cleanString(raw?.address, fallback.address || "", 240),
    mapUrl: cleanUrl(raw?.mapUrl, "") || undefined,
    arrivalInstructions: cleanString(raw?.arrivalInstructions, "", 500) || undefined,
    publicNotes: cleanString(raw?.publicNotes, "", 500) || undefined,
    timezone: cleanString(raw?.timezone, fallback.timezone, 80),
    active: raw?.active !== false,
    archived: raw?.archived === true,
    isDefault: raw?.isDefault === true || fallback.isDefault === true,
    sortOrder: Number.isFinite(Number(raw?.sortOrder)) ? Math.round(Number(raw.sortOrder)) : index,
  };
}

function normalizeLocations(rawLocations: any, account: Record<string, unknown>) {
  const fallback = defaultLocationFromAccount(account);
  const source = Array.isArray(rawLocations) && rawLocations.length ? rawLocations : [fallback];
  const seen = new Set<string>();
  const cleaned = source.map((raw, index) => {
    const location = cleanLocation(raw, index === 0 ? fallback : undefined, index);
    let id = location.id;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${location.id}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    return { ...location, id };
  });
  if (!cleaned.some((location) => location.active && !location.archived)) {
    cleaned[0] = { ...cleaned[0], active: true, archived: false };
  }
  const defaultIndex = cleaned.findIndex((location) => location.isDefault && location.active && !location.archived);
  const fallbackDefaultIndex = defaultIndex >= 0 ? defaultIndex : cleaned.findIndex((location) => location.active && !location.archived);
  return cleaned
    .map((location, index) => ({ ...location, isDefault: index === fallbackDefaultIndex }))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
}

function defaultCoachProfileFromAccount(account: Record<string, unknown>) {
  const workspaceAccount = defaultWorkspaceAccountFromAccount(account);
  return {
    id: cleanSlug(account?.id, DEFAULT_COACH_ID),
    accountId: workspaceAccount.id,
    name: cleanString(account?.coachName, "Sam Hale", 120),
    displayName: cleanString(account?.coachName, "Sam Hale", 120),
    shortName: "Sam",
    email: cleanString(account?.contactEmail, "", 180),
    active: true,
    archived: false,
    isDefault: true,
    bookable: true,
    assignedLocationIds: ["default-location"],
    defaultLocationId: "default-location",
    sortOrder: 0,
  };
}

function normalizeCoachProfiles(rawProfiles: any, account: Record<string, unknown>) {
  const fallback = defaultCoachProfileFromAccount(account);
  const source = Array.isArray(rawProfiles) && rawProfiles.length ? rawProfiles : [fallback];
  return source.map((raw, index) => ({
    ...fallback,
    ...raw,
    id: cleanSlug(raw?.id, index === 0 ? fallback.id : `coach-${index + 1}`),
    accountId: cleanSlug(raw?.accountId, fallback.accountId || defaultWorkspaceAccountFromAccount(account).id),
    name: cleanString(raw?.name, fallback.name, 120),
    displayName: cleanString(raw?.displayName, raw?.name || fallback.displayName, 120),
    shortName: cleanString(raw?.shortName, raw?.name || fallback.displayName, 60),
    email: cleanString(raw?.email, fallback.email, 180),
    phone: cleanString(raw?.phone, "", 80) || undefined,
    bio: cleanString(raw?.bio, "", 600) || undefined,
    photoUrl: cleanUrl(raw?.photoUrl, "") || undefined,
    active: raw?.active !== false,
    archived: raw?.archived === true,
    isDefault: index === 0 ? raw?.isDefault !== false : raw?.isDefault === true,
    bookable: raw?.bookable !== false,
    assignedLocationIds: Array.isArray(raw?.assignedLocationIds)
      ? raw.assignedLocationIds.map((id: unknown) => cleanSlug(id, "")).filter(Boolean)
      : fallback.assignedLocationIds,
    defaultLocationId: cleanSlug(raw?.defaultLocationId, raw?.assignedLocationIds?.[0] || fallback.assignedLocationIds?.[0] || "") || undefined,
    sortOrder: Number.isFinite(Number(raw?.sortOrder)) ? Math.round(Number(raw.sortOrder)) : index,
  }));
}

function defaultAppUserFromAccount(account: Record<string, unknown>) {
  const coach = defaultCoachProfileFromAccount(account);
  const workspaceAccount = defaultWorkspaceAccountFromAccount(account);
  return {
    id: `${coach.id}-admin`,
    accountId: workspaceAccount.id,
    email: coach.email,
    name: coach.displayName,
    role: "admin",
    coachId: coach.id,
    permissions: {
      bookings: "all",
      services: "all",
      availability: "all",
      locations: "all",
      clients: "all",
      settings: "all",
    },
  };
}

function normalizeAppUsers(rawUsers: any, account: Record<string, unknown>) {
  const fallback = defaultAppUserFromAccount(account);
  const source = Array.isArray(rawUsers) && rawUsers.length ? rawUsers : [fallback];
  return source.map((raw: any, index: number) => {
    const role = raw?.role === "coach" || raw?.role === "staff" ? raw.role : "admin";
    const permissions = typeof raw?.permissions === "object" && raw.permissions ? raw.permissions : fallback.permissions;
    return {
      id: cleanSlug(raw?.id, index === 0 ? fallback.id : `app-user-${index + 1}`),
      accountId: cleanSlug(raw?.accountId, fallback.accountId || defaultWorkspaceAccountFromAccount(account).id),
      email: cleanEmail(raw?.email, fallback.email),
      name: cleanString(raw?.name, fallback.name, 120),
      role,
      coachId: cleanSlug(raw?.coachId, fallback.coachId) || undefined,
      permissions: {
        bookings: permissions.bookings === "own" || permissions.bookings === "assigned" ? permissions.bookings : "all",
        services: permissions.services === "own" || permissions.services === "assigned" ? permissions.services : "all",
        availability: permissions.availability === "own" || permissions.availability === "assigned" ? permissions.availability : "all",
        locations: permissions.locations === "own" || permissions.locations === "assigned" ? permissions.locations : "all",
        clients: permissions.clients === "own" || permissions.clients === "assigned" ? permissions.clients : "all",
        settings: permissions.settings === "own" || permissions.settings === "assigned" ? permissions.settings : "all",
      },
    };
  });
}

function cleanBookingLocationSnapshot(raw: any) {
  let source = raw;
  if (typeof raw === "string") {
    try {
      source = JSON.parse(raw);
    } catch {
      source = null;
    }
  }
  if (!source?.name) return undefined;
  return {
    locationId: cleanString(source.locationId, "", 120) || undefined,
    name: cleanString(source.name, "", 140),
    shortName: cleanString(source.shortName, "", 80) || undefined,
    address: cleanString(source.address, "", 240) || undefined,
    mapUrl: cleanUrl(source.mapUrl, "") || undefined,
    arrivalInstructions: cleanString(source.arrivalInstructions, "", 500) || undefined,
    publicNotes: cleanString(source.publicNotes, "", 500) || undefined,
    timezone: cleanString(source.timezone, "", 80) || undefined,
  };
}

function cleanBookingCoachSnapshot(raw: any) {
  let source = raw;
  if (typeof raw === "string") {
    try {
      source = JSON.parse(raw);
    } catch {
      source = null;
    }
  }
  if (!source?.name) return undefined;
  return {
    coachId: cleanSlug(source.coachId, "") || undefined,
    name: cleanString(source.name, "", 120),
    displayName: cleanString(source.displayName, "", 120) || undefined,
    email: cleanEmail(source.email, "") || undefined,
    phone: cleanString(source.phone, "", 80) || undefined,
  };
}

const OPTIONAL_CALENDAR_ITEM_COLUMNS = new Set(["status", "custom_group", "location", "coach", "coach_id", "location_id", "account_id"]);

function omittedCalendarColumnWarning(column: string) {
  return `Calendar saved, but optional calendar item column "${column}" is not available in Supabase. Optional data for that field was not preserved.`;
}

function missingOptionalCalendarItemColumn(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (!/calendar_items/i.test(message)) return "";
  if (!/(schema cache|column|PGRST204|42703|Could not find)/i.test(message)) return "";
  for (const column of OPTIONAL_CALENDAR_ITEM_COLUMNS) {
    const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`['"\`]${escaped}['"\`]|\\b${escaped}\\b`, "i").test(message)) return column;
  }
  return "";
}

function omitCalendarItemColumn(rows: any[], column: string) {
  return rows.map((row) => {
    const { [column]: _omitted, ...rest } = row;
    return rest;
  });
}

async function upsertCalendarItemsAccepting(rows: any[]) {
  let nextRows = rows;
  const omittedColumns: string[] = [];

  while (true) {
    try {
      await supabase("calendar_items", {
        method: "POST",
        query: "on_conflict=id",
        body: nextRows,
        prefer: "resolution=merge-duplicates,return=minimal",
      });
      return omittedColumns.map(omittedCalendarColumnWarning);
    } catch (error) {
      const column = missingOptionalCalendarItemColumn(error);
      if (!column || omittedColumns.includes(column)) throw error;
      omittedColumns.push(column);
      nextRows = omitCalendarItemColumn(nextRows, column);
      console.warn("calendar_state:calendar_items_optional_column_omitted", {
        column,
        error: error instanceof Error ? error.message : String(error || ""),
      });
    }
  }
}

function modernClientEmailFooter(value: unknown) {
  const fallback = "We look forward to seeing you.";
  const footer = cleanString(value, fallback, 900);
  return /need to (move|change)|reply to this email.*(move|change|reschedul)|email.*(move|change|reschedul)/i.test(footer)
    ? fallback
    : footer;
}

function parseCookies(req: Request) {
  const cookieHeaderValue = req.headers.get("cookie") || "";
  return Object.fromEntries(
    cookieHeaderValue
      .split(";")
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const index = pair.indexOf("=");
        return index === -1
          ? [decodeURIComponent(pair), ""]
          : [
              decodeURIComponent(pair.slice(0, index)),
              decodeURIComponent(pair.slice(index + 1)),
            ];
      }),
  );
}

function supabaseConfig() {
  const url = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
  if (!url || !key) throw new Error("Supabase is not configured.");
  return { url, key };
}

async function supabase(
  table: string,
  options: {
    method?: string;
    query?: string;
    body?: unknown;
    prefer?: string;
  } = {},
) {
  const { url, key } = supabaseConfig();
  const response = await fetch(
    `${url}/rest/v1/${table}${options.query ? `?${options.query}` : ""}`,
    {
      method: options.method || "GET",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(options.prefer ? { Prefer: options.prefer } : {}),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    },
  );
  const text = await response.text();
  if (!response.ok)
    throw new Error(
      `Supabase ${options.method || "GET"} ${table} failed ${response.status}: ${text.slice(0, 500)}`,
    );
  return text ? JSON.parse(text) : [];
}

async function requireAdmin(req: Request) {
  const token = parseCookies(req)[sessionCookieName] || "";
  if (!token) return false;
  const rows = await supabase("admin_sessions", {
    query: `select=id&token_hash=eq.${encodeURIComponent(hashToken(token))}&expires_at=gt.${encodeURIComponent(nowIso())}&limit=1`,
  });
  return rows.length > 0;
}

function settingMap(rows: Array<{ key: string; value: string }>) {
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function parseJsonSetting<T>(
  settings: Record<string, string>,
  key: string,
  fallback: T,
): T {
  try {
    return settings[key] ? JSON.parse(settings[key]) : fallback;
  } catch {
    return fallback;
  }
}

function cleanPositiveInteger(value: unknown, fallback: number, min = 1, max = 100) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
}

function customGroupMaxParticipants(service?: Record<string, unknown> | null) {
  return cleanPositiveInteger(
    service?.capacity,
    CUSTOM_GROUP_DEFAULTS.maxParticipants,
    CUSTOM_GROUP_DEFAULTS.minParticipants,
    CUSTOM_GROUP_DEFAULTS.maxParticipants,
  );
}

function customGroupBaseParticipants(service?: Record<string, unknown> | null) {
  return cleanPositiveInteger(
    service?.baseParticipants,
    CUSTOM_GROUP_DEFAULTS.baseParticipants,
    CUSTOM_GROUP_DEFAULTS.minParticipants,
    customGroupMaxParticipants(service),
  );
}

function customGroupBasePrice(service?: Record<string, unknown> | null) {
  return cleanPositiveInteger(
    service?.basePrice ?? service?.price,
    CUSTOM_GROUP_DEFAULTS.basePrice,
    0,
    100000,
  );
}

function customGroupExtraPersonPrice(service?: Record<string, unknown> | null) {
  return cleanPositiveInteger(
    service?.extraPersonPrice,
    CUSTOM_GROUP_DEFAULTS.extraPersonPrice,
    0,
    100000,
  );
}

function cleanCustomGroupAttendee(raw: any, index = 0) {
  if (!raw || typeof raw !== "object") return null;
  const name = cleanString(raw.name, "", 120);
  const email = cleanString(raw.email, "", 180).toLowerCase();
  if (!name && !email) return null;
  const rawStatus = ["booker", "manual", "invited", "confirmed"].includes(raw.status)
    ? raw.status
    : "";
  const status = rawStatus
    ? rawStatus === "invited" && !email
      ? "manual"
      : rawStatus
    : email
      ? "invited"
      : "manual";
  return {
    id: cleanString(raw.id, `attendee-${index + 1}`, 120),
    name: name || email,
    ...(email ? { email } : {}),
    status,
    ...(raw.token ? { token: cleanString(raw.token, "", 180) } : {}),
  };
}

function cleanCustomGroupData(value: any) {
  let source = value;
  if (typeof value === "string") {
    try {
      source = JSON.parse(value);
    } catch {
      source = null;
    }
  }
  if (!source || typeof source !== "object") return null;
  const attendees = Array.isArray(source.attendees)
    ? source.attendees.map(cleanCustomGroupAttendee).filter(Boolean)
    : [];
  if (!source.customGroup && !attendees.length) return null;
  return {
    customGroup: true,
    attendees,
    calculatedPrice: cleanPositiveInteger(source.calculatedPrice, 0, 0, 100000),
  };
}

function isCancelledGroupSessionLike(item: any) {
  return (
    item?.kind === "block" &&
    Boolean(item?.service_id || item?.serviceId) &&
    (item?.note === CANCELLED_GROUP_SESSION_NOTE || item?.title === CANCELLED_GROUP_SESSION_TITLE)
  );
}

function rowToItem(row: any) {
  const status = ["completed", "cancelled", "no_show"].includes(row.status)
    ? row.status
    : "booked";
  const customGroup = cleanCustomGroupData(row.custom_group);
  const cancelledGroupSession = isCancelledGroupSessionLike(row);
  return {
    id: row.id,
    accountId: row.account_id || defaultWorkspaceAccountFromAccount({}).id,
    kind: row.kind,
    week: Number(row.week ?? 0),
    day: Number(row.day ?? 0),
    start: Number(row.start ?? 0),
    duration: Number(row.duration ?? 0),
    coachId: row.coach_id || DEFAULT_COACH_ID,
    locationId: row.location_id || cleanBookingLocationSnapshot(row.location)?.locationId || "",
    serviceId: row.service_id || "",
    client: row.client || "",
    title: row.title || row.client || "Booking",
    phone: row.phone || "",
    email: row.email || "",
    note: row.note || "",
    coach: cleanBookingCoachSnapshot(row.coach),
    location: cleanBookingLocationSnapshot(row.location),
    status: cancelledGroupSession ? "cancelled" : status,
    ...(cancelledGroupSession ? { readOnly: true, groupSlot: true } : {}),
    ...(customGroup || {}),
  };
}

function itemToRow(item: any) {
  const kind = item?.kind === "block" ? "block" : "appointment";
  const cancelledGroupSession = isCancelledGroupSessionLike({ ...item, kind });
  const customGroup = cleanCustomGroupData({
    customGroup: item?.customGroup,
    attendees: item?.attendees,
    calculatedPrice: item?.calculatedPrice,
  });
  return {
    id: cleanString(item?.id, `${kind}-${randomUUID()}`, 140),
    account_id: cleanSlug(item?.accountId, defaultWorkspaceAccountFromAccount({}).id),
    kind,
    week: Number.isInteger(Number(item?.week)) ? Number(item.week) : 0,
    day: Math.max(0, Math.min(6, Number(item?.day ?? 0))),
    start: Math.max(0, Math.min(1440, Number(item?.start ?? 0))),
    duration: Math.max(15, Math.min(720, Number(item?.duration ?? 30))),
    coach_id: cleanSlug(item?.coachId, DEFAULT_COACH_ID),
    location_id: cleanSlug(item?.locationId || item?.location?.locationId, "") || null,
    service_id: cleanString(item?.serviceId, "", 140) || null,
    client: cancelledGroupSession ? null : cleanString(item?.client, "", 160) || null,
    title: cancelledGroupSession
      ? CANCELLED_GROUP_SESSION_TITLE
      : cleanString(item?.title, item?.client || "Booking", 160),
    phone: cancelledGroupSession ? null : cleanString(item?.phone, "", 80) || null,
    email: cancelledGroupSession ? null : cleanString(item?.email, "", 180).toLowerCase() || null,
    note: cancelledGroupSession ? CANCELLED_GROUP_SESSION_NOTE : cleanString(item?.note, "", 1200) || null,
    status:
      cancelledGroupSession
        ? "cancelled"
        : item?.status === "completed" ||
            item?.status === "cancelled" ||
            item?.status === "no_show"
          ? item.status
          : "booked",
    custom_group: cancelledGroupSession ? null : customGroup,
    coach: cancelledGroupSession ? null : cleanBookingCoachSnapshot(item?.coach) || null,
    location: cancelledGroupSession ? null : cleanBookingLocationSnapshot(item?.location) || null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

function personFromItem(item: ReturnType<typeof itemToRow>) {
  if (item.kind !== "appointment") return null;
  const name = item.client || item.title;
  if (!name && !item.email && !item.phone) return null;

  // A contact's email is not their identity: families and organisations can
  // legitimately share one address. Use the full booking contact snapshot for
  // a stable candidate id, then resolve against existing people more carefully
  // below. The booking itself remains authoritative regardless of client sync.
  const identitySource = [
    cleanString(name, "", 180).toLowerCase().replace(/\s+/g, " ").trim(),
    cleanString(item.email, "", 180).toLowerCase(),
    cleanString(item.phone, "", 80).replace(/\D/g, ""),
  ].join("|");
  const identityHash = createHash("sha256")
    .update(identitySource || randomUUID())
    .digest("hex")
    .slice(0, 32);

  return {
    id: `person-${identityHash}`,
    name: name || item.email || item.phone || "Client",
    email: item.email,
    phone: item.phone,
    notes: item.note,
    source: "appointment",
    caddy_profile_id: null,
    caddy_profile_url: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

function uniqueById<T extends { id?: string | null }>(rows: T[]) {
  const byId = new Map<string, T>();
  for (const row of rows) {
    if (!row.id) continue;
    byId.set(row.id, row);
  }
  return [...byId.values()];
}

function normalizedEmail(value: unknown) {
  return cleanString(value, "", 180).toLowerCase();
}

function normalizedName(value: unknown) {
  return cleanString(value, "", 180).toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizedPhone(value: unknown) {
  return cleanString(value, "", 80).replace(/\D/g, "");
}

function normalizedNamePhoneKey(person: { name?: unknown; phone?: unknown }) {
  const name = normalizedName(person?.name);
  const phone = normalizedPhone(person?.phone);
  return name && phone ? `${name}|${phone}` : "";
}

function normalizedNameEmailKey(person: { name?: unknown; email?: unknown }) {
  const name = normalizedName(person?.name);
  const email = normalizedEmail(person?.email);
  return name && email ? `${name}|${email}` : "";
}

function namesAreCompatible(candidate: any, existing: any) {
  const candidateName = normalizedName(candidate?.name);
  const existingName = normalizedName(existing?.name);
  return !candidateName || !existingName || candidateName === existingName;
}

function phonesAreCompatible(candidate: any, existing: any) {
  const candidatePhone = normalizedPhone(candidate?.phone);
  const existingPhone = normalizedPhone(existing?.phone);
  return !candidatePhone || !existingPhone || candidatePhone === existingPhone;
}

function chooseCompatiblePerson(candidate: any, rows: any[]) {
  if (!Array.isArray(rows) || !rows.length) return null;

  const candidateId = cleanString(candidate?.id, "", 140);
  if (candidateId) {
    const exactId = rows.find((row) => String(row?.id || "") === candidateId);
    if (exactId) return exactId;
  }

  const nameEmailKey = normalizedNameEmailKey(candidate || {});
  if (nameEmailKey) {
    const exact = rows.find(
      (row) => normalizedNameEmailKey(row || {}) === nameEmailKey,
    );
    if (exact) return exact;
  }

  const namePhoneKey = normalizedNamePhoneKey(candidate || {});
  if (namePhoneKey) {
    const exact = rows.find(
      (row) => normalizedNamePhoneKey(row || {}) === namePhoneKey,
    );
    if (exact) return exact;
  }

  // Only use a single email match when the names and phones do not conflict.
  // This prevents two family members who share an address from being merged.
  const email = normalizedEmail(candidate?.email);
  if (email) {
    const emailMatches = rows.filter(
      (row) => normalizedEmail(row?.email) === email,
    );
    if (emailMatches.length === 1) {
      const only = emailMatches[0];
      if (
        namesAreCompatible(candidate, only) &&
        phonesAreCompatible(candidate, only)
      )
        return only;
    }
  }

  // The same conservative rule applies to phone-only matching.
  const phone = normalizedPhone(candidate?.phone);
  if (phone) {
    const phoneMatches = rows.filter(
      (row) => normalizedPhone(row?.phone) === phone,
    );
    if (phoneMatches.length === 1) {
      const only = phoneMatches[0];
      if (namesAreCompatible(candidate, only)) return only;
    }
  }

  return null;
}

function isDuplicatePersonEmailError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return (
    message.includes("Supabase POST people failed 409") &&
    (message.includes("idx_people_email_unique") ||
      message.includes('"23505"') ||
      message.includes("lower(email)"))
  );
}

async function findPeopleByEmail(value: unknown) {
  const email = normalizedEmail(value);
  if (!email) return [] as any[];
  const rows = await supabase("people", {
    query: `select=*&email=ilike.${encodeURIComponent(email)}&limit=50`,
  });
  return rows.filter((row: any) => normalizedEmail(row?.email) === email);
}

function mergePersonForUpsert(candidate: any, existing: any | null) {
  if (!existing) return candidate;
  return {
    id: existing.id,
    name: candidate.name || existing.name,
    email: existing.email || candidate.email || null,
    phone: candidate.phone || existing.phone || null,
    notes: candidate.notes || existing.notes || null,
    source: existing.source || candidate.source || "appointment",
    caddy_profile_id:
      existing.caddy_profile_id || candidate.caddy_profile_id || null,
    caddy_profile_url:
      existing.caddy_profile_url || candidate.caddy_profile_url || null,
    created_at: existing.created_at || candidate.created_at || nowIso(),
    updated_at: nowIso(),
  };
}

async function resolvePeopleForUpsert(candidates: any[]) {
  if (!candidates.length) return [];

  const existingRows = await supabase("people", {
    query: "select=*&limit=10000",
  });

  const workingRows = [...existingRows];
  const resolved: any[] = [];

  for (const candidate of candidates) {
    let existing = chooseCompatiblePerson(candidate, workingRows);

    // Supabase/PostgREST can cap broad collection reads. When a candidate was
    // not found, perform a targeted email lookup, but still require compatible
    // identity details before reusing a person row.
    if (!existing && normalizedEmail(candidate?.email)) {
      existing = chooseCompatiblePerson(
        candidate,
        await findPeopleByEmail(candidate.email),
      );
    }

    const person = mergePersonForUpsert(candidate, existing);
    resolved.push(person);

    const index = workingRows.findIndex(
      (row) => String(row?.id || "") === String(person?.id || ""),
    );
    if (index >= 0) workingRows[index] = person;
    else workingRows.push(person);
  }

  return uniqueById(resolved);
}

async function patchPersonById(person: any) {
  const id = cleanString(person?.id, "", 140);
  if (!id) throw new Error("Cannot update a client record without an id.");
  const { id: _id, ...patch } = person;
  await supabase("people", {
    method: "PATCH",
    query: `id=eq.${encodeURIComponent(id)}`,
    prefer: "return=minimal",
    body: patch,
  });
}

async function syncPersonByIdentity(candidate: any) {
  const email = normalizedEmail(candidate?.email);
  const emailMatches = email ? await findPeopleByEmail(email) : [];
  const existing = chooseCompatiblePerson(candidate, emailMatches);
  if (existing) {
    await patchPersonById(mergePersonForUpsert(candidate, existing));
    return true;
  }

  try {
    await supabase("people", {
      method: "POST",
      query: "on_conflict=id",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: [candidate],
    });
    return true;
  } catch (error) {
    // Before the shared-contact migration is applied, a legacy unique email
    // index may still reject a different person who shares an address. Reuse a
    // row only when identity details are compatible; otherwise leave the
    // booking saved and report a non-blocking client-directory warning.
    if (!email || !isDuplicatePersonEmailError(error)) throw error;
    const matched = chooseCompatiblePerson(
      candidate,
      await findPeopleByEmail(email),
    );
    if (!matched) return false;
    await patchPersonById(mergePersonForUpsert(candidate, matched));
    return true;
  }
}

async function syncPeopleBestEffort(candidates: any[]) {
  if (!candidates.length) return [] as string[];

  try {
    const people = await resolvePeopleForUpsert(candidates);
    if (people.length) {
      await supabase("people", {
        method: "POST",
        query: "on_conflict=id",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: people,
      });
    }
    return [] as string[];
  } catch (error) {
    if (isDuplicatePersonEmailError(error)) {
      console.warn("calendar_state:people_email_conflict_recovering", error);
      let needsReview = 0;
      for (const candidate of candidates) {
        try {
          if (!(await syncPersonByIdentity(candidate))) needsReview += 1;
        } catch (personError) {
          needsReview += 1;
          console.warn("calendar_state:person_sync_warning", personError);
        }
      }
      if (!needsReview) return [] as string[];
    } else {
      console.warn("calendar_state:people_sync_warning", error);
    }

    // Calendar items hold their own contact snapshot and are the authoritative
    // lesson record. Client-directory synchronisation is secondary and must not
    // turn a successfully stored booking change into a fatal save error.
    return ["Calendar saved. Some client profiles need review."];
  }
}

function postgrestQuotedList(values: string[]) {
  return values
    .map(
      (value) =>
        `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
    )
    .join(",");
}

async function setSetting(key: string, value: unknown) {
  await supabase("settings", {
    method: "POST",
    query: "on_conflict=key",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: [{ key, value: String(value ?? ""), updated_at: nowIso() }],
  });
}

function appointmentPositionSignature(item: any) {
  if (!item) return "";
  return JSON.stringify({
    week: Number(item.week ?? 0),
    day: Number(item.day ?? 0),
    start: Number(item.start ?? 0),
    duration: Number(item.duration ?? 0),
    serviceId: cleanString(item.serviceId || item.service_id, "", 140),
  });
}

function appointmentNotificationSignature(item: any) {
  if (!item) return "";
  return JSON.stringify({
    position: appointmentPositionSignature(item),
    client: cleanString(item.client || item.title, "", 160),
    title: cleanString(item.title, "", 160),
    phone: cleanString(item.phone, "", 80),
    email: normalizedEmail(item.email),
    status: cleanString(item.status, "booked", 40),
    customGroup: item.customGroup === true,
    calculatedPrice: Number(item.calculatedPrice ?? 0),
    attendees: Array.isArray(item.attendees)
      ? item.attendees.map((attendee: any) => ({
          id: cleanString(attendee?.id, "", 120),
          name: cleanString(attendee?.name, "", 120),
          email: normalizedEmail(attendee?.email),
          status: cleanString(attendee?.status, "", 40),
          token: cleanString(attendee?.token, "", 220),
        }))
      : [],
  });
}

function appointmentById(items: any[] = []) {
  return new Map(
    items
      .filter((item) => item?.kind === "appointment" && item?.id)
      .map((item) => [String(item.id), item]),
  );
}

function parseTimestamp(value: unknown) {
  const timestamp = Date.parse(typeof value === "string" ? value : "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function slotDateParts(week = 0, day = 0) {
  const date = new Date(baseWeekStart);
  date.setUTCDate(baseWeekStart.getUTCDate() + Number(week || 0) * 7 + Number(day || 0));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function nowInTimeZoneParts(timeZone = "Pacific/Auckland") {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-NZ", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
  } catch {
    parts = new Intl.DateTimeFormat("en-NZ", {
      timeZone: "Pacific/Auckland",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
  }
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    minutes: value("hour") * 60 + value("minute"),
  };
}

function dateSortValue(parts: { year: number; month: number; day: number }) {
  return parts.year * 10000 + parts.month * 100 + parts.day;
}

function isAppointmentInPast(item: any, timeZone = "Pacific/Auckland") {
  if (!item || item.kind !== "appointment") return false;
  const slotDate = slotDateParts(Number(item.week ?? 0), Number(item.day ?? 0));
  const now = nowInTimeZoneParts(timeZone);
  const slotValue = dateSortValue(slotDate);
  const nowValue = dateSortValue(now);
  if (slotValue !== nowValue) return slotValue < nowValue;
  return Number(item.start ?? 0) < now.minutes;
}

function cleanPendingAdminNotification(value: any): PendingAdminNotification | null {
  const calendarItemId = cleanString(value?.calendarItemId, "", 180);
  const action =
    value?.action === "rescheduled" || value?.action === "updated"
      ? value.action
      : value?.action === "booking"
        ? "booking"
        : "";
  if (!calendarItemId || !action || !value?.appointment) return null;
  return {
    calendarItemId,
    action,
    queuedAt: cleanString(value?.queuedAt, nowIso(), 80),
    fireAfter: cleanString(value?.fireAfter, nowIso(), 80),
    originalPositionSignature: cleanString(value?.originalPositionSignature, "", 800),
    targetSignature: cleanString(value?.targetSignature, "", 1600),
    appointment: value.appointment,
    previousAppointment: value.previousAppointment || null,
  };
}

async function readPendingAdminNotifications() {
  const rows = await supabase("settings", {
    query: `select=value&key=eq.${encodeURIComponent(ADMIN_NOTIFICATION_DEBOUNCE_QUEUE_KEY)}&limit=1`,
  });
  try {
    const parsed = rows[0]?.value ? JSON.parse(rows[0].value) : [];
    if (!Array.isArray(parsed)) return [] as PendingAdminNotification[];
    return parsed
      .map(cleanPendingAdminNotification)
      .filter((entry): entry is PendingAdminNotification => Boolean(entry));
  } catch {
    return [] as PendingAdminNotification[];
  }
}

async function writePendingAdminNotifications(queue: PendingAdminNotification[]) {
  await setSetting(ADMIN_NOTIFICATION_DEBOUNCE_QUEUE_KEY, JSON.stringify(queue));
}

async function processAdminNotificationDebounce(
  previousItems: any[] = [],
  nextItems: any[] = [],
  options: { queueDiffs?: boolean; timeZone?: string } = {},
) {
  const now = Date.now();
  const timeZone = cleanString(options.timeZone, "Pacific/Auckland", 80);
  const queueById = new Map(
    (await readPendingAdminNotifications()).map((entry) => [
      entry.calendarItemId,
      entry,
    ]),
  );
  const previousById = appointmentById(previousItems);
  const nextById = appointmentById(nextItems);
  const results: any[] = [];
  let queueChanged = false;

  if (options.queueDiffs !== false) {
    const ids = new Set([...previousById.keys(), ...nextById.keys()]);
    const queuedAt = nowIso();
    const fireAfter = new Date(now + ADMIN_NOTIFICATION_DEBOUNCE_MS).toISOString();

    for (const id of ids) {
      const previous = previousById.get(id);
      const next = nextById.get(id);
      const action = inferBookingAction(previous, next);
      if (!action) continue;

      const existing = queueById.get(id);
      if (next && isAppointmentInPast(next, timeZone)) {
        if (existing) {
          queueById.delete(id);
          queueChanged = true;
        }
        continue;
      }

      if (action === "booking" && next) {
        queueById.set(id, {
          calendarItemId: id,
          action: "booking",
          queuedAt,
          fireAfter,
          originalPositionSignature: "",
          targetSignature: appointmentNotificationSignature(next),
          appointment: next,
          previousAppointment: null,
        });
        queueChanged = true;
        continue;
      }

      if ((action === "rescheduled" || action === "updated") && next) {
        const isPendingInitialBooking = existing?.action === "booking";
        const originalPrevious = isPendingInitialBooking
          ? null
          : existing?.previousAppointment || previous || null;
        const originalPositionSignature =
          existing?.originalPositionSignature ||
          (previous ? appointmentPositionSignature(previous) : "");
        if (
          existing &&
          !isPendingInitialBooking &&
          originalPositionSignature &&
          appointmentPositionSignature(next) === originalPositionSignature
        ) {
          queueById.delete(id);
          queueChanged = true;
          continue;
        }

        queueById.set(id, {
          calendarItemId: id,
          action: isPendingInitialBooking ? "booking" : action,
          queuedAt,
          fireAfter,
          originalPositionSignature: isPendingInitialBooking ? "" : originalPositionSignature,
          targetSignature: appointmentNotificationSignature(next),
          appointment: next,
          previousAppointment: originalPrevious,
        });
        queueChanged = true;
        continue;
      }

      if (action === "cancelled" && previous) {
        if (isAppointmentInPast(previous, timeZone)) {
          if (existing) {
            queueById.delete(id);
            queueChanged = true;
          }
          continue;
        }
        if (existing?.action === "booking") {
          queueById.delete(id);
          queueChanged = true;
          continue;
        }
        if (existing) {
          queueById.delete(id);
          queueChanged = true;
        }
        results.push(
          ...(await notifyBookingEvent({
            action,
            appointment: previous,
            previousAppointment: previous,
            source: "calendar-state",
          })),
        );
      }
    }
  }

  for (const [id, pending] of [...queueById.entries()]) {
    if (parseTimestamp(pending.fireAfter) > now) continue;

    const current = nextById.get(id);
    queueById.delete(id);
    queueChanged = true;
    if (!current) continue;
    if (isAppointmentInPast(current, timeZone)) continue;
    if (appointmentNotificationSignature(current) !== pending.targetSignature) continue;
    if (
      pending.originalPositionSignature &&
      appointmentPositionSignature(current) === pending.originalPositionSignature
    ) {
      continue;
    }

    results.push(
      ...(await notifyBookingEvent({
        action: pending.action,
        appointment: current,
        previousAppointment: pending.previousAppointment,
        source: "calendar-state-admin-debounce",
      })),
    );
  }

  if (queueChanged) await writePendingAdminNotifications([...queueById.values()]);
  return results;
}

async function readState() {
  const [settingsRows, itemRows, peopleRows, notificationRows] =
    await Promise.all([
      supabase("settings", { query: "select=key,value" }),
      supabase("calendar_items", {
        query: "select=*&order=week.asc,day.asc,start.asc,id.asc",
      }),
      supabase("people", { query: "select=*&order=name.asc,email.asc,id.asc" }),
      supabase("notification_history", {
        query: "select=*&order=created_at.desc&limit=500",
      }),
    ]);
  const settings = settingMap(settingsRows);
  const updatedAt = settings.updatedAt || nowIso();
  if (!settings.updatedAt) await setSetting("updatedAt", updatedAt);
  if (!settings.syncKey)
    await setSetting(
      "syncKey",
      env("CLARITY_CALENDAR_SYNC_KEY") ||
        `cg_${randomUUID().replaceAll("-", "")}`,
    );
  const account = {
    id: settings.accountId || "sam-hale-golf",
    coachName: settings.accountCoachName || env("CLARITY_COACH_NAME", "Sam Hale"),
    businessName:
      settings.accountBusinessName || env("CLARITY_BUSINESS_NAME", "Sam Hale Golf"),
    venueName:
      settings.accountVenueName ||
      env("CLARITY_VENUE_NAME", "The Range 24/7 - Three Kings"),
    venueShortName:
      settings.accountVenueShortName || env("CLARITY_VENUE_SHORT_NAME", "The Range 24/7"),
    timezone: settings.accountTimezone || env("CLARITY_TIMEZONE", "Pacific/Auckland"),
    contactEmail: settings.accountContactEmail || env("CLARITY_CONTACT_EMAIL", ""),
    bookingUrl:
      settings.accountBookingUrl || env("CLARITY_BOOKING_URL", "https://book.claritygolf.app"),
    calendarSlug: settings.accountCalendarSlug || "sam-hale-golf",
    caddyWorkspaceUrl:
      settings.accountCaddyWorkspaceUrl ||
      env("CLARITY_CADDY_WORKSPACE_URL", "https://caddy.claritygolf.app"),
    invoiceSettings: parseJsonSetting(
      settings,
      "accountInvoiceSettingsJson",
      defaultInvoiceSettings,
    ),
  };

  const workspaceAccounts = normalizeWorkspaceAccounts(parseJsonSetting(settings, "workspaceAccountsJson", []), account);
  const workspaceAccount = workspaceAccounts.find((candidate: any) => candidate.active) || workspaceAccounts[0] || defaultWorkspaceAccountFromAccount(account);
  const items = itemRows
    .map(rowToItem)
    .filter((item: any) => (item.accountId || workspaceAccount.id) === workspaceAccount.id);

  return {
    syncKey: settings.syncKey || env("CLARITY_CALENDAR_SYNC_KEY") || "",
    updatedAt,
    items,
    workspaceAccounts,
    services: parseJsonSetting(settings, "servicesJson", defaultServices),
    coaches: normalizeCoachProfiles(parseJsonSetting(settings, "coachProfilesJson", []), account),
    currentUser: normalizeAppUsers(parseJsonSetting(settings, "appUsersJson", []), account)[0],
    locations: normalizeLocations(parseJsonSetting(settings, "locationsJson", []), account),
    availability: parseJsonSetting(
      settings,
      "availabilityJson",
      defaultAvailability,
    ),
    people: peopleRows,
    notifications: notificationRows.map((row: any) => ({
      id: row.id,
      personKey: row.person_key || "",
      calendarItemId: row.calendar_item_id || "",
      recipient: row.recipient || "",
      subject: row.subject || "",
      kind: row.kind || "",
      status: row.status || "",
      provider: row.provider || "",
      providerId: row.provider_id || "",
      error: row.error || "",
      createdAt: row.created_at || "",
    })),
    settings: {
      emailNotificationsEnabled: settings.emailNotificationsEnabled !== "false",
      notificationEmail: settings.notificationEmail || env("CLARITY_NOTIFICATION_EMAIL", ""),
      coachEmail: settings.coachEmail || env("CLARITY_COACH_EMAIL", ""),
      replyToEmail: settings.replyToEmail || env("CLARITY_REPLY_TO_EMAIL", ""),
      notificationDelaySeconds: Number(settings.notificationDelaySeconds || 30),
      sendClientEmail: settings.sendClientEmail !== "false",
      sendCoachEmail: settings.sendCoachEmail !== "false",
      sendAdminEmail: settings.sendAdminEmail !== "false",
      clientEmailSubject: settings.clientEmailSubject || "Your {{service}} is confirmed",
      clientEmailIntro:
        settings.clientEmailIntro ||
        "Thanks {{firstName}}, your booking with {{coach}} is confirmed.",
      clientEmailFooter: modernClientEmailFooter(settings.clientEmailFooter),
      adminEmailSubject: settings.adminEmailSubject || "New booking: {{client}}",
      adminEmailIntro:
        settings.adminEmailIntro ||
        "{{client}} booked {{service}} for {{date}} at {{time}}.",
      smsProviderName: settings.smsProviderName || "",
      smsWebhookUrl: settings.smsWebhookUrl || "",
      smsFromNumber: settings.smsFromNumber || "",
      sendClientSms: settings.sendClientSms === "true",
      sendAdminSms: settings.sendAdminSms === "true",
    },
    brand: {
      logoName: settings.brandLogoName || "",
      logoPreview: settings.brandLogoPreview || "",
      showLogo: settings.brandShowLogo === "true",
      neutral: settings.brandNeutral || "#ffffff",
      primary: settings.brandPrimary || "#1fd36d",
      secondary: settings.brandSecondary || "#d7b06b",
      accent: settings.brandAccent || "#07100a",
      bookingTheme: settings.brandBookingTheme || "dark",
    },
    account,
    googleCalendar: await getGoogleCalendarSyncStatus(),
  };
}

async function writeState(body: any) {
  const currentState = await readState();
  const workspaceAccount =
    (currentState.workspaceAccounts || []).find((account: any) => account.active) ||
    (currentState.workspaceAccounts || [])[0] ||
    defaultWorkspaceAccountFromAccount(currentState.account);
  const hasItemsPayload = Object.prototype.hasOwnProperty.call(body || {}, "items");
  const hasServicesPayload = Object.prototype.hasOwnProperty.call(body || {}, "services");
  const hasLocationsPayload = Object.prototype.hasOwnProperty.call(body || {}, "locations");
  const hasCoachesPayload = Object.prototype.hasOwnProperty.call(body || {}, "coaches");
  const hasAppUsersPayload = Object.prototype.hasOwnProperty.call(body || {}, "appUsers");
  const hasWorkspaceAccountsPayload = Object.prototype.hasOwnProperty.call(body || {}, "workspaceAccounts");
  const shouldReplaceItems = body?.replaceItems === true || body?.itemsOperation === "replace";
  const rows = uniqueById(Array.isArray(body?.items) ? body.items.map(itemToRow).map((row) => ({ ...row, account_id: workspaceAccount.id })) : []);
  const warnings: string[] = [];
  if (hasServicesPayload) {
    const normalizedServices = normalizeServices(body?.services);
    await setSetting("servicesJson", JSON.stringify(normalizedServices));
  }
  if (hasWorkspaceAccountsPayload) {
    await setSetting("workspaceAccountsJson", JSON.stringify(normalizeWorkspaceAccounts(body?.workspaceAccounts, currentState.account)));
  }
  if (hasLocationsPayload) {
    await setSetting("locationsJson", JSON.stringify(normalizeLocations(body?.locations, currentState.account)));
  }
  if (hasCoachesPayload) {
    await setSetting("coachProfilesJson", JSON.stringify(normalizeCoachProfiles(body?.coaches, currentState.account)));
  }
  if (hasAppUsersPayload) {
    await setSetting("appUsersJson", JSON.stringify(normalizeAppUsers(body?.appUsers, currentState.account)));
  }

  if (hasItemsPayload && rows.length) {
    // Calendar items are the authoritative lesson records. Store them before
    // attempting the secondary client-directory synchronisation.
    warnings.push(...(await upsertCalendarItemsAccepting(rows)));

    const keepIds = postgrestQuotedList(rows.map((row) => row.id));
    if (shouldReplaceItems && keepIds) {
      await supabase("calendar_items", {
        method: "DELETE",
        query: `account_id=eq.${encodeURIComponent(workspaceAccount.id)}&id=not.in.(${keepIds})`,
        prefer: "return=minimal",
      });
    }

    const peopleCandidates = uniqueById(
      rows
        .map(personFromItem)
        .filter(
          (person): person is NonNullable<ReturnType<typeof personFromItem>> =>
            Boolean(person),
        ),
    );
    warnings.push(...(await syncPeopleBestEffort(peopleCandidates)));
  } else if (
    hasItemsPayload &&
    (body?.clearItems === true || shouldReplaceItems)
  ) {
    // An empty replacement is an intentional clear-all operation. Malformed
    // requests cannot reach this branch because the handler requires an array.
    await supabase("calendar_items", {
      method: "DELETE",
      query: `account_id=eq.${encodeURIComponent(workspaceAccount.id)}`,
      prefer: "return=minimal",
    });
  }

  if (body?.settings && typeof body.settings === "object") {
    const nextSettings = body.settings as Record<string, unknown>;
    const settingKeys = [
      "emailNotificationsEnabled",
      "notificationEmail",
      "coachEmail",
      "replyToEmail",
      "notificationDelaySeconds",
      "sendClientEmail",
      "sendCoachEmail",
      "sendAdminEmail",
      "clientEmailSubject",
      "clientEmailIntro",
      "clientEmailFooter",
      "adminEmailSubject",
      "adminEmailIntro",
      "smsProviderName",
      "smsWebhookUrl",
      "smsFromNumber",
      "sendClientSms",
      "sendAdminSms",
    ];
    for (const key of settingKeys) {
      if (Object.prototype.hasOwnProperty.call(nextSettings, key)) {
        await setSetting(key, String(nextSettings[key] ?? ""));
      }
    }
  }

  if (typeof body?.syncKey === "string") await setSetting("syncKey", body.syncKey);
  await setSetting("updatedAt", nowIso());

  let googleCalendarSync = null;
  if (hasItemsPayload) {
    try {
      googleCalendarSync = await syncGoogleCalendarIfEnabled();
    } catch (error) {
      googleCalendarSync = {
        ...(await getGoogleCalendarSyncStatus()),
        ok: false,
        skipped: false,
        error: error instanceof Error ? error.message : "Google Calendar sync failed.",
      };
      warnings.push(
        `Calendar saved, but Google Calendar did not sync: ${googleCalendarSync.error}`,
      );
    }
  }

  const state = await readState();
  return {
    ...state,
    ...(googleCalendarSync ? { googleCalendarSync } : {}),
    ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}),
  };
}

export async function readPublicBookingState() {
  const state = await readState();
  return {
    updatedAt: state.updatedAt,
    services: state.services || [],
    availability: state.availability || [],
    brand: state.brand,
    account: state.account,
    items: state.items || [],
  };
}

async function parseBody(req: Request) {
  const raw = await req.text();
  return raw ? JSON.parse(raw) : {};
}

export default async function handler(req: Request) {
  try {
    if (!(await requireAdmin(req)))
      return json(
        { error: "unauthorized", message: "Admin login required." },
        401,
      );
    if (req.method === "GET") {
      const state = await readState();
      let notificationResults: any[] = [];
      try {
        notificationResults = await processAdminNotificationDebounce(
          state.items,
          state.items,
          { queueDiffs: false, timeZone: state.account?.timezone },
        );
      } catch (error) {
        console.error("calendar_state:notification_debounce_failed", error);
      }
      if (!notificationResults.length) return json(state);
      const refreshedState = await readState();
      return json({ ...refreshedState, notificationResults });
    }
    if (req.method === "PUT") {
      const body = await parseBody(req);
      const hasItemsPayload = Object.prototype.hasOwnProperty.call(body || {}, "items");
      const hasServicesPayload = Object.prototype.hasOwnProperty.call(body || {}, "services");
      const hasLocationsPayload = Object.prototype.hasOwnProperty.call(body || {}, "locations");
      if (!hasItemsPayload && !hasServicesPayload && !hasLocationsPayload) {
        return json(
          {
            error: "invalid_calendar_state",
            message: "PUT /api/calendar-state requires body.items, body.services, and/or body.locations.",
          },
          400,
        );
      }
      if (hasServicesPayload && !Array.isArray(body?.services)) {
        return json(
          {
            error: "invalid_calendar_state",
            message: "PUT /api/calendar-state requires body.services to be an array when present.",
          },
          400,
        );
      }
      if (hasLocationsPayload && !Array.isArray(body?.locations)) {
        return json(
          {
            error: "invalid_calendar_state",
            message: "PUT /api/calendar-state requires body.locations to be an array when present.",
          },
          400,
        );
      }
      if (hasItemsPayload && !Array.isArray(body?.items)) {
        return json(
          {
            error: "invalid_calendar_state",
            message:
              "PUT /api/calendar-state requires body.items to be an array.",
          },
          400,
        );
      }
      if (!hasItemsPayload) return json(await writeState(body));
      const previousState = await readState();
      const nextState = await writeState(body);
      let notificationResults: any[] = [];
      let notificationWarning = "";
      try {
        notificationResults = await processAdminNotificationDebounce(
          previousState.items,
          nextState.items,
          { timeZone: nextState.account?.timezone },
        );
      } catch (error) {
        notificationWarning =
          "Calendar saved, but booking alerts could not be processed.";
        console.error("calendar_state:notification_failed", error);
      }

      // Notification history is written after the calendar transaction. Read
      // it again so the UI immediately shows the Resend result without waiting
      // for the next polling cycle.
      const refreshedState = await readState();
      const existingWarnings = Array.isArray(nextState.warnings)
        ? nextState.warnings
        : [];
      return json({
        ...nextState,
        notifications: refreshedState.notifications,
        notificationResults,
        ...(notificationWarning
          ? { warnings: [...new Set([...existingWarnings, notificationWarning])] }
          : {}),
      });
    }
    return json({ error: "method_not_allowed" }, 405);
  } catch (error) {
    console.error("calendar_state:failed", error);
    return json(
      {
        error: "calendar_state_error",
        message:
          req.method === "PUT"
            ? "Your calendar change could not be saved. Please try again."
            : "Calendar data could not be loaded. Please refresh.",
      },
      500,
    );
  }
}

export const config: Config = {
  path: "/api/calendar-state",
};
