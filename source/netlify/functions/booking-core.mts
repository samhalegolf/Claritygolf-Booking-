import { getDatabase } from "@netlify/database";
import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

import { getGoogleCalendarSyncStatus, syncGoogleCalendarIfEnabled } from "./google-calendar-sync.mts";
import { inferBookingAction, notifyBookingEvent } from "./notification-engine.mts";

const sessionCookieName = "clarity_session";
const sessionDays = 7;
const passwordResetMinutes = 30;
const baseWeekStart = new Date(Date.UTC(2026, 5, 1));
const MAX_GROUP_OCCURRENCE_COUNT = 52;
const PUBLIC_SLOT_STEP_MINUTES = 30;
const CANCELLED_GROUP_SESSION_TITLE = "Cancelled group session";
const CANCELLED_GROUP_SESSION_NOTE = "__cancelled_group_session__";
const CUSTOM_GROUP_DEFAULTS = {
  baseParticipants: 3,
  basePrice: 200,
  extraPersonPrice: 20,
  minParticipants: 2,
  maxParticipants: 5,
};
const ADMIN_NOTIFICATION_DEBOUNCE_MS = 30_000;
const ADMIN_NOTIFICATION_DEBOUNCE_QUEUE_KEY = "adminNotificationDebounceQueueJson";
const BOOKING_SCREEN_IDS = new Set([
  "main",
  "range-three-kings",
  "group-lessons",
  "private-lessons",
]);
let authReadyPromise = null;
let authReady = false;
let authReadyConfigSignature = "";
let seedReadyPromise = null;
const defaultEmailTemplates = {
  clientEmailSubject: "Your {{service}} is confirmed",
  clientEmailIntro:
    "Thanks {{firstName}}, your booking with {{coach}} is confirmed.",
  clientEmailFooter: "We look forward to seeing you.",
  adminEmailSubject: "New booking: {{client}}",
  adminEmailIntro: "{{client}} booked {{service}} for {{date}} at {{time}}.",
};

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
  defaultCustomerNote: "Thanks for your work on the lesson programme. Invoice attached below.",
  paymentInstructions:
    "Please pay by bank transfer and use the invoice number as reference.",
  customFields: [],
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

const defaultAvailability = [
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

const initialItems = [];

function timeToMinutes(hour, minute) {
  return hour * 60 + minute;
}

function env(name, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source || {}, key);
}

function emailNotificationsGloballyDisabled() {
  return ["0", "false", "off", "disabled", "no"].includes(env("EMAIL_NOTIFICATIONS_ENABLED", "").trim().toLowerCase());
}

function nowIso() {
  return new Date().toISOString();
}

function safeJsonStringify(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, current) => {
    if (typeof current === "bigint") {
      const asNumber = Number(current);
      return Number.isSafeInteger(asNumber) ? asNumber : String(current);
    }
    if (current && typeof current === "object") {
      if (seen.has(current)) return "[Circular]";
      seen.add(current);
    }
    return current;
  });
}

function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function cleanPositiveInteger(value, fallback, min = 1, max = 100) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, Math.round(parsed)))
    : fallback;
}

function hasCustomGroupFlag(service) {
  return service?.customGroup === true || service?.customGroupEnabled === true;
}

function isCustomGroupService(service) {
  return Boolean(hasCustomGroupFlag(service));
}

function isScheduledGroupService(service) {
  return Boolean(service?.lessonFormat === "group" && !isCustomGroupService(service));
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

function customGroupMinParticipants(service) {
  return cleanPositiveInteger(
    service?.minParticipants,
    CUSTOM_GROUP_DEFAULTS.minParticipants,
    CUSTOM_GROUP_DEFAULTS.minParticipants,
    CUSTOM_GROUP_DEFAULTS.maxParticipants,
  );
}

function customGroupMaxParticipants(service) {
  return cleanPositiveInteger(
    service?.capacity,
    CUSTOM_GROUP_DEFAULTS.maxParticipants,
    CUSTOM_GROUP_DEFAULTS.minParticipants,
    CUSTOM_GROUP_DEFAULTS.maxParticipants,
  );
}

function calculateCustomGroupPrice(service, participantCount) {
  const baseParticipants = customGroupBaseParticipants(service);
  const extraPeople = Math.max(0, cleanPositiveInteger(participantCount, 1, 1, CUSTOM_GROUP_DEFAULTS.maxParticipants) - baseParticipants);
  return customGroupBasePrice(service) + extraPeople * customGroupExtraPersonPrice(service);
}

function cleanCustomGroupAttendee(raw, index = 0) {
  if (!raw || typeof raw !== "object") return null;
  const name = cleanString(raw.name, "", 120);
  const email = cleanEmail(raw.email, "");
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

function cleanCustomGroupData(value) {
  const source = typeof value === "string" ? safeJsonParse(value, null) : value;
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

function json(value, status = 200, extraHeaders = {}) {
  return new Response(safeJsonStringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function text(value, status = 200, contentType = "text/plain; charset=utf-8") {
  return new Response(value, {
    status,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    },
  });
}

function cleanString(value, fallback = "", max = 600) {
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, max);
}

function cleanSlug(value, fallback = "sam-hale-golf") {
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

function formatTime(minutes) {
  const hour24 = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const period = hour24 >= 12 ? "PM" : "AM";
  const hour = hour24 % 12 || 12;
  return `${hour}:${String(mins).padStart(2, "0")} ${period}`;
}

function formatRange(start, duration) {
  return `${formatTime(start)}-${formatTime(start + duration)}`;
}

function formatBookingDate(week, day) {
  const date = dateForSlot(week, day);
  return new Date(
    Date.UTC(date.year, date.month - 1, date.day),
  ).toLocaleDateString("en-NZ", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

function renderTemplate(template, variables) {
  return String(template || "").replace(
    /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
    (_match, key) => variables[key] ?? "",
  );
}

function servicePriceLabel(service) {
  if (!service) return "No charge";
  return `NZ$${service.price}.00${service.priceMode === "per-person" ? " pp" : ""}`;
}

function cleanEmail(value, fallback = "") {
  const email = cleanString(value, "", 180).toLowerCase();
  return email.includes("@") ? email : fallback;
}

function cleanUrl(value, fallback) {
  const raw = cleanString(value, "", 600);
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return fallback;
    return url.toString().replace(/\/$/, "");
  } catch {
    return fallback;
  }
}

function cleanHexColor(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed : fallback;
}

function cleanLogoPreview(value) {
  if (typeof value !== "string" || !value.startsWith("data:image/")) return "";
  return value.slice(0, 180_000);
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

function cleanBookingScreenIds(value) {
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

function cleanEditableServiceText(value, fallback = "", max = 600) {
  if (typeof value === "string") return value.trim().slice(0, max);
  return fallback;
}

function cleanService(service, index = 0) {
  const fallback = defaultServices[index] ?? defaultServices[0];
  const descriptionFallback = service ? "" : fallback.description;
  const locationFallback = service ? "" : fallback.location;
  const lessonNoteFallback = service ? service.location || "" : fallback.lessonNote || fallback.location || "";
  const name = cleanString(service?.name, fallback.name, 120);
  const duration = Number.isFinite(Number(service?.duration)) ? Number(service.duration) : fallback.duration;
  const price = Number.isFinite(Number(service?.price)) ? Number(service.price) : fallback.price;
  const capacity = Number.isFinite(Number(service?.capacity)) ? Number(service.capacity) : fallback.capacity || 1;
  const looksLikePackage =
    service?.lessonFormat === "package" ||
    String(service?.id || fallback.id || "").startsWith("package-") ||
    /package/i.test(name);
  const lessonFormat =
    looksLikePackage ? "package" : service?.lessonFormat === "group" ? "group" : "private";
  const customGroup = lessonFormat === "group" && hasCustomGroupFlag(service);
  const cleanCapacity = customGroup
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
    accountId: cleanSlug(service?.accountId, defaultWorkspaceAccountFromCoachAccount().id),
    coachId: cleanSlug(service?.coachId, defaultCoachProfileFromAccount().id),
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
    locationId: cleanSlug(service?.locationId, "") || undefined,
    lessonNote: cleanEditableServiceText(service?.lessonNote, lessonNoteFallback, 180),
    location: cleanEditableServiceText(service?.location, locationFallback, 160),
    packageAllowance: lessonFormat === "package" ? packageAllowance : undefined,
    packageCoverageMode: lessonFormat === "package" ? packageCoverageMode : undefined,
    packageCoversServiceId:
      lessonFormat === "package" ? cleanString(service?.packageCoversServiceId, "", 120) || undefined : undefined,
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

function normalizeServices(serviceList) {
  const source =
    Array.isArray(serviceList) && serviceList.length
      ? serviceList
      : defaultServices;
  const seen = new Set();
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

function normalizeAvailability(availability) {
  const source = Array.isArray(availability)
    ? availability
    : defaultAvailability;
  const dayStartMinutes = 0;
  const dayEndMinutes = (24 * 60) - 15;
  return Array.from({ length: 7 }, (_, day) => {
    const windows = Array.isArray(source[day]) ? source[day] : [];
    return windows
      .map((window) => {
        const rawStart = Number.isFinite(Number(window?.start))
          ? Number(window.start)
          : timeToMinutes(7, 0);
        const rawEnd = Number.isFinite(Number(window?.end))
          ? Number(window.end)
          : rawStart + 60;
        const start = Math.max(
          dayStartMinutes,
          Math.min(dayEndMinutes, Math.round(rawStart / 15) * 15),
        );
        const end = Math.max(
          start + 15,
          Math.min(dayEndMinutes, Math.round(rawEnd / 15) * 15),
        );
        const coachId = cleanSlug(window?.coachId, defaultCoachProfileFromAccount().id);
        return end > start ? { start, end, coachId } : null;
      })
      .filter(Boolean)
      .sort((a, b) => (a.coachId || "").localeCompare(b.coachId || "") || a.start - b.start)
      .reduce((merged, window) => {
        const previous = merged.at(-1);
        if (previous && previous.coachId === window.coachId && window.start < previous.end) {
          previous.end = Math.max(previous.end, window.end);
        } else {
          merged.push({ ...window });
        }
        return merged;
      }, []);
  });
}

function defaultCoachAccount() {
  return {
    id: env("CLARITY_COACH_ACCOUNT_ID", "sam-hale-golf"),
    coachName: env("CLARITY_COACH_NAME", "Sam Hale"),
    businessName: env("CLARITY_BUSINESS_NAME", "Sam Hale Golf"),
    venueName: env("CLARITY_VENUE_NAME", "The Range 24/7 - Three Kings"),
    venueShortName: env("CLARITY_VENUE_SHORT_NAME", "The Range 24/7"),
    timezone: env("CLARITY_TIMEZONE", "Pacific/Auckland"),
    contactEmail: env("CLARITY_CONTACT_EMAIL", ""),
    bookingUrl: env("CLARITY_BOOKING_URL", "https://book.claritygolf.app"),
    calendarSlug: env("CLARITY_CALENDAR_SLUG", "sam-hale-golf"),
    caddyWorkspaceUrl: env("CLARITY_CADDY_WORKSPACE_URL", "https://caddy.claritygolf.app"),
    invoiceSettings: defaultInvoiceSettings,
	  };
	}

function cleanInvoiceCustomField(field, index = 0) {
  const label = cleanString(field?.label, "", 80);
  const value = cleanString(field?.value, "", 180);
  if (!label && !value) return null;
  const placement = ["bill-to", "payment", "footer"].includes(field?.placement)
    ? field.placement
    : "header";
  return {
    id: cleanString(field?.id, `field-${index + 1}`, 80),
    label: label || "Custom field",
    value,
    placement,
  };
}

function cleanInvoiceSettings(settings = {}) {
  const nextNumber = Number(
    settings?.nextNumber ?? defaultInvoiceSettings.nextNumber,
  );
  const taxRate = Number(settings?.taxRate ?? defaultInvoiceSettings.taxRate);
  const paymentTermsDays = Number(
    settings?.paymentTermsDays ?? defaultInvoiceSettings.paymentTermsDays,
  );
  const customFields = Array.isArray(settings?.customFields)
    ? settings.customFields
        .map(cleanInvoiceCustomField)
        .filter(Boolean)
        .slice(0, 12)
    : [];
  return {
    enabled: settings?.enabled !== false,
    showBillingWorkspace: settings?.showBillingWorkspace !== false,
    prefix:
      cleanString(settings?.prefix, defaultInvoiceSettings.prefix, 12)
        .toUpperCase()
        .replace(/[^A-Z0-9-]/g, "") || defaultInvoiceSettings.prefix,
    nextNumber: Number.isFinite(nextNumber)
      ? Math.max(1, Math.min(999999, Math.round(nextNumber)))
      : defaultInvoiceSettings.nextNumber,
    currency: cleanString(
      settings?.currency,
      defaultInvoiceSettings.currency,
      8,
    ).toUpperCase(),
    taxName: cleanString(settings?.taxName, defaultInvoiceSettings.taxName, 24),
    taxNumber: cleanString(settings?.taxNumber, "", 80),
    taxRate: Number.isFinite(taxRate)
      ? Math.max(0, Math.min(30, taxRate))
      : defaultInvoiceSettings.taxRate,
    bankAccount: cleanString(settings?.bankAccount, "", 120),
    paymentTermsDays: Number.isFinite(paymentTermsDays)
      ? Math.max(0, Math.min(120, Math.round(paymentTermsDays)))
      : defaultInvoiceSettings.paymentTermsDays,
    businessAddress: cleanString(settings?.businessAddress, "", 400),
    headerText: cleanString(settings?.headerText, "", 280),
    footerText: cleanString(
      settings?.footerText,
      defaultInvoiceSettings.footerText,
      400,
    ),
    defaultCustomerNote: cleanString(
      settings?.defaultCustomerNote,
      defaultInvoiceSettings.defaultCustomerNote,
      400,
    ),
    paymentInstructions: cleanString(
      settings?.paymentInstructions,
      defaultInvoiceSettings.paymentInstructions,
      400,
    ),
    customFields,
  };
}

function cleanCoachAccount(account) {
  const defaults = defaultCoachAccount();
  const businessName = cleanString(
    account?.businessName,
    defaults.businessName,
    100,
  );
  const venueName = cleanString(account?.venueName, defaults.venueName, 140);
  return {
    id: cleanSlug(account?.id, defaults.id),
    coachName: cleanString(account?.coachName, defaults.coachName, 100),
    businessName,
    venueName,
    venueShortName: cleanString(
      account?.venueShortName,
      defaults.venueShortName || venueName,
      80,
    ),
    timezone: cleanString(account?.timezone, defaults.timezone, 80),
    contactEmail: cleanEmail(account?.contactEmail, defaults.contactEmail),
    bookingUrl: cleanUrl(account?.bookingUrl, defaults.bookingUrl),
    calendarSlug: cleanSlug(
      account?.calendarSlug,
      cleanSlug(businessName, defaults.calendarSlug),
    ),
    caddyWorkspaceUrl: cleanUrl(
      account?.caddyWorkspaceUrl,
      defaults.caddyWorkspaceUrl,
    ),
    invoiceSettings: cleanInvoiceSettings(account?.invoiceSettings),
	  };
	}

const accountFeatureKeys = [
  "publicBooking",
  "coachCalendar",
  "locationCalendar",
  "multiCoach",
  "multiLocation",
  "services",
  "groupLessons",
  "packages",
  "clients",
  "notifications",
  "googleCalendarSync",
  "invoicing",
  "checkout",
  "customBranding",
  "customDomains",
  "staffUsers",
  "advancedPermissions",
];

function accountFeatures(enabled) {
  return Object.fromEntries(accountFeatureKeys.map((feature) => [feature, enabled.includes(feature)]));
}

const allAccountFeatures = accountFeatures(accountFeatureKeys);
const accountPlanCatalog = {
  solo: {
    features: accountFeatures(["publicBooking", "coachCalendar", "services", "groupLessons", "packages", "clients", "notifications", "googleCalendarSync"]),
    limits: { maxCoaches: 1, maxLocations: 1, maxUsers: 1, maxServices: 10, maxBookingScreens: 1 },
  },
  studio: {
    features: accountFeatures(["publicBooking", "coachCalendar", "locationCalendar", "multiCoach", "multiLocation", "services", "groupLessons", "packages", "clients", "notifications", "googleCalendarSync", "invoicing", "customBranding", "staffUsers"]),
    limits: { maxCoaches: 5, maxLocations: 3, maxUsers: 8, maxServices: 40, maxBookingScreens: 4 },
  },
  academy: { features: allAccountFeatures, limits: { maxCoaches: 20, maxLocations: 10, maxUsers: 30, maxServices: 120, maxBookingScreens: 12 } },
  enterprise: { features: allAccountFeatures, limits: { maxCoaches: 999, maxLocations: 999, maxUsers: 999, maxServices: 999, maxBookingScreens: 999 } },
  founder: { features: allAccountFeatures, limits: { maxCoaches: 999, maxLocations: 999, maxUsers: 999, maxServices: 999, maxBookingScreens: 999 } },
};

function mergeEntitlementOverrides(base, override) {
  return {
    features: { ...base.features, ...(override?.features || {}) },
    limits: { ...base.limits, ...(override?.limits || {}) },
  };
}

function accountEntitlements(account) {
  return mergeEntitlementOverrides(accountPlanCatalog[account?.planKey] || accountPlanCatalog.solo, account?.entitlementsOverride);
}

function accountHasFeature(account, feature) {
  return accountEntitlements(account).features[feature] === true;
}

function accountLimit(account, limit) {
  return accountEntitlements(account).limits[limit];
}

function isAccountActive(account) {
  return account?.active !== false && ["trialing", "active", "comped", "internal"].includes(account?.subscriptionStatus);
}

function entitlementError(message, status = 403) {
  return Object.assign(new Error(message), { status });
}

function assertAccountActive(account) {
  if (!isAccountActive(account)) {
    throw entitlementError("This workspace subscription is not active.");
  }
}

function assertAccountFeature(account, feature) {
  assertAccountActive(account);
  if (!accountHasFeature(account, feature)) {
    throw entitlementError(`${feature} is not included in this workspace plan.`);
  }
}

function assertAccountLimit(account, currentUsage, limitName) {
  const limit = accountLimit(account, limitName);
  if (Number.isFinite(limit) && currentUsage > limit) {
    throw entitlementError(`This workspace plan allows ${limit} ${String(limitName).replace(/^max/, "").toLowerCase()}.`, 409);
  }
}

function forbidden(message = "Permission denied.", code = "permission_denied") {
  const error = Object.assign(new Error(message), { status: 403, code });
  return error;
}

function permissionDenied(message = "You do not have permission to perform this action.") {
  return forbidden(message, "permission_denied");
}

function defaultWorkspaceAccountFromCoachAccount(account = defaultCoachAccount()) {
  const clean = cleanCoachAccount(account);
  const slug = cleanSlug(clean.calendarSlug || clean.businessName, "sam-hale-golf");
  return {
    id: slug,
    name: clean.businessName || "Sam Hale Golf",
    slug,
    planKey: "founder",
    subscriptionStatus: "comped",
    billingProvider: "none",
    active: true,
  };
}

function cleanWorkspaceAccount(raw = {}, fallback = defaultWorkspaceAccountFromCoachAccount()) {
  const name = cleanString(raw?.name, fallback.name, 120);
  const slug = cleanSlug(raw?.slug || raw?.id || name, fallback.slug);
  const planKey = accountPlanCatalog[raw?.planKey] ? raw.planKey : fallback.planKey;
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

function normalizeWorkspaceAccounts(rawAccounts, account = defaultCoachAccount()) {
  const fallback = defaultWorkspaceAccountFromCoachAccount(account);
  const source = Array.isArray(rawAccounts) && rawAccounts.length ? rawAccounts : [fallback];
  const seen = new Set();
  return source.map((raw, index) => {
    const clean = cleanWorkspaceAccount(raw, index === 0 ? fallback : defaultWorkspaceAccountFromCoachAccount(account));
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

function defaultAccountId(accounts) {
  return (accounts || []).find((account) => account.active)?.id || accounts?.[0]?.id || defaultWorkspaceAccountFromCoachAccount().id;
}

function defaultLocationFromCoachAccount(account = defaultCoachAccount()) {
  const clean = cleanCoachAccount(account);
  const workspaceAccount = defaultWorkspaceAccountFromCoachAccount(clean);
  return {
    id: "default-location",
    accountId: workspaceAccount.id,
    name: clean.venueName,
    shortName: clean.venueShortName || clean.venueName,
    address: "",
    timezone: clean.timezone,
    active: true,
    archived: false,
    isDefault: true,
    sortOrder: 0,
  };
}

function defaultCoachProfileFromAccount(account = defaultCoachAccount()) {
  const clean = cleanCoachAccount(account);
  const workspaceAccount = defaultWorkspaceAccountFromCoachAccount(clean);
  return {
    id: clean.id || "sam-hale-golf",
    accountId: workspaceAccount.id,
    name: clean.coachName,
    displayName: clean.coachName || clean.businessName,
    shortName: "Sam",
    email: clean.contactEmail,
    active: true,
    archived: false,
    isDefault: true,
    bookable: true,
    assignedLocationIds: ["default-location"],
    defaultLocationId: "default-location",
    sortOrder: 0,
  };
}

function defaultAppUserFromAccount(account = defaultCoachAccount()) {
  const coach = defaultCoachProfileFromAccount(account);
  const workspaceAccount = defaultWorkspaceAccountFromCoachAccount(account);
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

function cleanCoachProfile(raw = {}, fallback = defaultCoachProfileFromAccount(), index = 0) {
  const name = cleanString(raw?.name, fallback.name, 120);
  return {
    id: cleanSlug(raw?.id, cleanSlug(name, `coach-${index + 1}`)),
    accountId: cleanSlug(raw?.accountId, fallback.accountId || defaultWorkspaceAccountFromCoachAccount().id),
    name,
    displayName: cleanString(raw?.displayName, name, 120),
    shortName: cleanString(raw?.shortName, name.split(/\s+/).map((part) => part[0]).join("").slice(0, 4).toUpperCase(), 60),
    email: cleanEmail(raw?.email, fallback.email),
    phone: cleanString(raw?.phone, "", 80) || undefined,
    bio: cleanString(raw?.bio, "", 600) || undefined,
    photoUrl: cleanUrl(raw?.photoUrl, "", 300) || undefined,
    active: raw?.active !== false,
    archived: raw?.archived === true,
    isDefault: raw?.isDefault === true || fallback.isDefault === true,
    bookable: raw?.bookable !== false,
    assignedLocationIds: Array.isArray(raw?.assignedLocationIds)
      ? raw.assignedLocationIds.map((id) => cleanSlug(id, "")).filter(Boolean)
      : fallback.assignedLocationIds,
    defaultLocationId: cleanSlug(raw?.defaultLocationId, raw?.assignedLocationIds?.[0] || fallback.assignedLocationIds?.[0] || "") || undefined,
    sortOrder: Number.isFinite(Number(raw?.sortOrder)) ? Math.round(Number(raw.sortOrder)) : index,
  };
}

function normalizeCoachProfiles(rawProfiles, account = defaultCoachAccount()) {
  const fallback = defaultCoachProfileFromAccount(account);
  const source = Array.isArray(rawProfiles) && rawProfiles.length ? rawProfiles : [fallback];
  const seen = new Set();
  const cleaned = source.map((raw, index) => {
    const coach = cleanCoachProfile(raw, index === 0 ? fallback : undefined, index);
    let id = coach.id;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${coach.id}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    return { ...coach, id };
  });
  if (!cleaned.some((coach) => coach.active && !coach.archived && coach.bookable)) {
    cleaned[0] = { ...cleaned[0], active: true, archived: false, bookable: true };
  }
  const defaultIndex = cleaned.findIndex((coach) => coach.isDefault && coach.active && !coach.archived);
  const fallbackDefaultIndex = defaultIndex >= 0 ? defaultIndex : cleaned.findIndex((coach) => coach.active && !coach.archived);
  return cleaned
    .map((coach, index) => ({ ...coach, isDefault: index === fallbackDefaultIndex }))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.displayName.localeCompare(b.displayName));
}

function defaultCoachId(coaches) {
  return coaches.find((coach) => coach.isDefault && coach.active && !coach.archived)?.id || coaches[0]?.id || defaultCoachProfileFromAccount().id;
}

function coachById(coaches, id) {
  if (!id) return null;
  return (coaches || []).find((coach) => coach.id === id) || null;
}

function coachSnapshot(coach) {
  return {
    coachId: coach.id,
    name: coach.name,
    displayName: coach.displayName,
    email: coach.email || undefined,
    phone: coach.phone || undefined,
  };
}

function bookingCoachSnapshotFor(coachId, coaches, account) {
  const profile =
    coachById(coaches, coachId) ||
    coachById(coaches, defaultCoachId(coaches)) ||
    defaultCoachProfileFromAccount(account);
  return coachSnapshot(profile);
}

function cleanBookingCoachSnapshot(raw, fallback) {
  const source = raw?.name ? raw : fallback;
  if (!source?.name) return undefined;
  return {
    coachId: cleanSlug(source.coachId, "") || undefined,
    name: cleanString(source.name, "", 120),
    displayName: cleanString(source.displayName, "", 120) || undefined,
    email: cleanEmail(source.email, "") || undefined,
    phone: cleanString(source.phone, "", 80) || undefined,
  };
}

function cleanLocation(raw = {}, fallback = defaultLocationFromCoachAccount(), index = 0) {
  const name = cleanString(raw?.name, fallback.name, 140);
  const shortName = cleanString(raw?.shortName, name, 80);
  return {
    id: cleanSlug(raw?.id, cleanSlug(name, `location-${index + 1}`)),
    accountId: cleanSlug(raw?.accountId, fallback.accountId || defaultWorkspaceAccountFromCoachAccount().id),
    name,
    shortName,
    address: cleanString(raw?.address, fallback.address || "", 240),
    mapUrl: cleanUrl(raw?.mapUrl, "", 300) || undefined,
    arrivalInstructions: cleanString(raw?.arrivalInstructions, "", 500) || undefined,
    publicNotes: cleanString(raw?.publicNotes, "", 500) || undefined,
    timezone: cleanString(raw?.timezone, fallback.timezone, 80),
    active: raw?.active !== false,
    archived: raw?.archived === true,
    isDefault: raw?.isDefault === true || fallback.isDefault === true,
    sortOrder: Number.isFinite(Number(raw?.sortOrder)) ? Math.round(Number(raw.sortOrder)) : index,
  };
}

function normalizeLocations(rawLocations, account = defaultCoachAccount()) {
  const fallback = defaultLocationFromCoachAccount(account);
  const source = Array.isArray(rawLocations) && rawLocations.length ? rawLocations : [fallback];
  const seen = new Set();
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

function activeLocations(locations) {
  return (locations || []).filter((location) => location.active && !location.archived);
}

function defaultLocationId(locations) {
  return activeLocations(locations).find((location) => location.isDefault)?.id || activeLocations(locations)[0]?.id || locations?.[0]?.id || "";
}

function locationById(locations, id) {
  if (!id) return null;
  return (locations || []).find((location) => location.id === id) || null;
}

function locationSnapshot(location) {
  return {
    locationId: location.id,
    name: location.name,
    shortName: location.shortName,
    address: location.address || undefined,
    mapUrl: location.mapUrl || undefined,
    arrivalInstructions: location.arrivalInstructions || undefined,
    publicNotes: location.publicNotes || undefined,
    timezone: location.timezone || undefined,
  };
}

function serviceLocation(service, locations, account) {
  return (
    locationById(locations, service?.locationId) ||
    locationById(locations, defaultLocationId(locations)) ||
    defaultLocationFromCoachAccount(account)
  );
}

function cleanBookingLocationSnapshot(raw, fallback) {
  const source = raw?.name ? raw : fallback;
  if (!source?.name) return undefined;
  return {
    locationId: cleanString(source.locationId, "", 120) || undefined,
    name: cleanString(source.name, "", 140),
    shortName: cleanString(source.shortName, "", 80) || undefined,
    address: cleanString(source.address, "", 240) || undefined,
    mapUrl: cleanUrl(source.mapUrl, "", 300) || undefined,
    arrivalInstructions: cleanString(source.arrivalInstructions, "", 500) || undefined,
    publicNotes: cleanString(source.publicNotes, "", 500) || undefined,
    timezone: cleanString(source.timezone, "", 80) || undefined,
  };
}

function bookingLocationSnapshotFor(service, locations, account) {
  return locationSnapshot(serviceLocation(service, locations, account));
}

function calendarItemLocation(item, service, locations, account) {
  return (
    cleanBookingLocationSnapshot(item?.location) ||
    cleanBookingLocationSnapshot(
      item?.locationId
        ? locationSnapshot(locationById(locations, item.locationId) || serviceLocation(service, locations, account))
        : undefined,
    ) ||
    bookingLocationSnapshotFor(service, locations, account)
  );
}

function calendarItemCoach(item, coaches, account) {
  return (
    cleanBookingCoachSnapshot(item?.coach) ||
    bookingCoachSnapshotFor(item?.coachId, coaches, account)
  );
}

function resolvedCalendarItemCoachId(item, service, coaches, account) {
  return item?.coachId || item?.coach?.coachId || service?.coachId || calendarItemCoach(item, coaches, account).coachId || defaultCoachId(coaches);
}

function resolvedCalendarItemLocationId(item, service, locations, account) {
  return item?.locationId || item?.location?.locationId || service?.locationId || calendarItemLocation(item, service, locations, account).locationId || defaultLocationId(locations);
}

function serviceForCalendarItem(item, services = []) {
  return (services || []).find((service) => service.id && service.id === item?.serviceId) || null;
}

function recordAccountId(record, fallbackAccountId = defaultWorkspaceAccountFromCoachAccount().id) {
  return record?.accountId || fallbackAccountId;
}

function recordBelongsToAccount(record, accountId) {
  return recordAccountId(record, accountId) === accountId;
}

function peopleAccountIdFromSettings(settings, account = coachAccountFromSettings(settings)) {
  return defaultAccountId(workspaceAccountsFromSettings(settings, account));
}

function calendarItemBelongsToAccount(item, accountId) {
  return recordBelongsToAccount(item, accountId);
}

function calendarItemBelongsToCoach(item, coachId, services = [], coaches = [], account = defaultCoachAccount()) {
  if (!coachId) return false;
  if (isLocationOnlyBlock(item)) return true;
  return resolvedCalendarItemCoachId(item, serviceForCalendarItem(item, services), coaches, account) === coachId;
}

function canReadCalendarItem(context, item, state) {
  if (!calendarItemBelongsToAccount(item, context.accountId)) return false;
  if (context.isAdmin) return true;
  return calendarItemBelongsToCoach(item, context.coachId, state.services, state.coaches, state.account);
}

function assertCanWriteCalendarItem(context, item, previousItem, state) {
  if (!calendarItemBelongsToAccount(item, context.accountId)) {
    throw permissionDenied("This booking does not belong to your workspace.");
  }
  if (context.isAdmin) return;
  if (!hasPermission(context.user, "bookings", "own")) {
    throw permissionDenied("You do not have permission to edit bookings.");
  }
  if (isLocationOnlyBlock(item)) {
    throw permissionDenied("You do not have permission to block an entire location.");
  }
  if (previousItem && !calendarItemBelongsToCoach(previousItem, context.coachId, state.services, state.coaches, state.account)) {
    throw permissionDenied("You do not have permission to edit another coach's calendar.");
  }
  if (!calendarItemBelongsToCoach(item, context.coachId, state.services, state.coaches, state.account)) {
    throw permissionDenied("You do not have permission to move bookings to another coach.");
  }
}

function normalizeCalendarItemsForContext(items, context) {
  return normalizeItems(items).map((item) => ({ ...item, accountId: context.accountId }));
}

function filterCalendarStateForContext(state, context) {
  const filteredItems = (state.items || []).filter((item) => canReadCalendarItem(context, item, state));
  const visibleItemIds = new Set(filteredItems.map((item) => item.id));
  return {
    ...state,
    items: filteredItems,
    services: context.isAdmin
      ? (state.services || []).filter((service) => recordBelongsToAccount(service, context.accountId))
      : (state.services || []).filter((service) => recordBelongsToAccount(service, context.accountId) && (service.coachId || defaultCoachId(state.coaches)) === context.coachId),
    availability: context.isAdmin
      ? (state.availability || []).map((day) => day.filter((window) => recordBelongsToAccount(window, context.accountId)))
      : (state.availability || []).map((day) => day.filter((window) => recordBelongsToAccount(window, context.accountId) && (window.coachId || defaultCoachId(state.coaches)) === context.coachId)),
    notifications: context.isAdmin
      ? state.notifications
      : (state.notifications || []).filter((notification) => visibleItemIds.has(notification.calendarItemId)),
    people: context.isAdmin
      ? state.people
      : (state.people || []).filter((person) => filteredItems.some((item) => item.email && person.email && item.email === person.email)),
  };
}

function serviceBelongsToContext(service, context, coaches = []) {
  if (!recordBelongsToAccount(service, context.accountId)) return false;
  if (context.isAdmin) return true;
  return (service?.coachId || defaultCoachId(coaches)) === context.coachId;
}

function assertCanWriteService(context, service, previousService, coaches = []) {
  if (!recordBelongsToAccount(service, context.accountId)) {
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

function mergeServicesForContext(incomingServices, currentServices, context, coaches = []) {
  if (context.isAdmin) return incomingServices.map((service) => ({ ...service, accountId: context.accountId }));
  const previousById = new Map((currentServices || []).map((service) => [service.id, service]));
  const ownedIncoming = incomingServices.map((service) => ({
    ...service,
    accountId: context.accountId,
    coachId: service.coachId || context.coachId,
  }));
  ownedIncoming.forEach((service) => assertCanWriteService(context, service, previousById.get(service.id), coaches));
  const ownedIds = new Set(ownedIncoming.map((service) => service.id));
  const preserved = (currentServices || []).filter(
    (service) => !ownedIds.has(service.id) && !serviceBelongsToContext(service, context, coaches),
  );
  return [...preserved, ...ownedIncoming];
}

function availabilityWindowBelongsToContext(window, context, fallbackCoachId) {
  if (!recordBelongsToAccount(window, context.accountId)) return false;
  if (context.isAdmin) return true;
  return (window?.coachId || fallbackCoachId) === context.coachId;
}

function mergeAvailabilityForContext(incomingAvailability, currentAvailability, context, fallbackCoachId) {
  const incoming = normalizeAvailability(incomingAvailability).map((dayWindows) =>
    dayWindows.map((window) => ({
      ...window,
      accountId: context.accountId,
      coachId: window.coachId || (context.isAdmin ? fallbackCoachId : context.coachId),
    })),
  );
  if (context.isAdmin) return incoming;
  if (!hasPermission(context.user, "availability", "own")) {
    throw permissionDenied("You do not have permission to edit availability.");
  }
  return incoming.map((dayWindows, index) => {
    dayWindows.forEach((window) => {
      if (!availabilityWindowBelongsToContext(window, context, fallbackCoachId)) {
        throw permissionDenied("You do not have permission to edit another coach's availability.");
      }
    });
    const preserved = (currentAvailability[index] || []).filter(
      (window) => !availabilityWindowBelongsToContext(window, context, fallbackCoachId),
    );
    return [...preserved, ...dayWindows];
  });
}

function personMatchesCalendarItem(person, item) {
  const email = cleanString(person?.email, "", 180).toLowerCase();
  const phone = cleanString(person?.phone, "", 80).replace(/\D/g, "");
  const itemEmail = cleanString(item?.email, "", 180).toLowerCase();
  const itemPhone = cleanString(item?.phone, "", 80).replace(/\D/g, "");
  if (email && itemEmail && email === itemEmail) return true;
  if (phone && itemPhone && phone === itemPhone) return true;
  return false;
}

function filterPeopleForContext(people, context, state) {
  const accountPeople = (people || []).filter((person) => recordBelongsToAccount(person, context.accountId));
  if (context.isAdmin) return accountPeople;
  const visibleItems = (state.items || []).filter((item) => canReadCalendarItem(context, item, state));
  return accountPeople.filter((person) => visibleItems.some((item) => personMatchesCalendarItem(person, item)));
}

function filterNotificationsForContext(notifications, context, state) {
  if (context.isAdmin) return notifications || [];
  const visibleItemIds = new Set((state.items || []).filter((item) => canReadCalendarItem(context, item, state)).map((item) => item.id));
  return (notifications || []).filter((notification) => visibleItemIds.has(notification.calendarItemId));
}

function filterCoachesForContext(coaches, context) {
  if (context.isAdmin) return (coaches || []).filter((coach) => recordBelongsToAccount(coach, context.accountId));
  return (coaches || []).filter((coach) => recordBelongsToAccount(coach, context.accountId) && coach.id === context.coachId);
}

function filterLocationsForContext(locations, context, coaches = []) {
  const accountLocations = (locations || []).filter((location) => recordBelongsToAccount(location, context.accountId));
  if (context.isAdmin) return accountLocations;
  const coach = (coaches || []).find((candidate) => candidate.id === context.coachId);
  const assigned = new Set([...(coach?.assignedLocationIds || []), coach?.defaultLocationId].filter(Boolean));
  return accountLocations.filter((location) => assigned.has(location.id) || location.isDefault);
}

function assertCanManagePerson(context, person, state) {
  assertAccountFeature(context.account, "clients");
  if (context.isAdmin) return;
  if (!hasPermission(context.user, "clients", "own")) {
    throw permissionDenied("You do not have permission to edit clients.");
  }
  if (!filterPeopleForContext([person], context, state).length) {
    throw permissionDenied("You do not have permission to edit this client.");
  }
}

function isLocationOnlyBlock(item) {
  return item?.kind === "block" && Boolean(item.locationId || item.location?.locationId) && !item.coachId && !item.coach?.coachId;
}

function isCoachOnlyBlock(item) {
  return item?.kind === "block" && Boolean(item.coachId || item.coach?.coachId) && !item.locationId && !item.location?.locationId;
}

function isCoachLocationBlock(item) {
  return item?.kind === "block" && Boolean(item.coachId || item.coach?.coachId) && Boolean(item.locationId || item.location?.locationId);
}

function isInactiveForConflict(item) {
  return item?.status === "cancelled" || item?.status === "no_show";
}

function bookingLocationDisplay(location) {
  return [location?.name, location?.address].filter(Boolean).join(" · ");
}

function generateSyncKey() {
  return `cg_${randomUUID().replaceAll("-", "")}`;
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const passwordHash = scryptSync(password, salt, 64).toString("hex");
  return { passwordHash, salt };
}

function logAuthTiming(step, startedAt, details = {}) {
  console.log("auth_timing", {
    step,
    ms: Date.now() - startedAt,
    ...details,
  });
}

function authBootstrapSignature() {
  const email = cleanEmail(env("CLARITY_ADMIN_EMAIL"), "");
  const password = env("CLARITY_ADMIN_PASSWORD");
  return hashToken(
    JSON.stringify({
      email,
      passwordSeed: email && password ? hashToken(`${email}:${password}`) : "",
      passwordConfigured: Boolean(password),
    }),
  );
}

function hasValidStoredPasswordHash(user) {
  return (
    typeof user?.password_hash === "string" &&
    /^[a-f0-9]{128}$/i.test(user.password_hash) &&
    typeof user?.password_salt === "string" &&
    user.password_salt.length >= 16
  );
}

function cookieHeader(token, req, maxAgeSeconds) {
  const secure = new URL(req.url).protocol === "https:";
  return [
    `${sessionCookieName}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function clearCookieHeader() {
  return `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function parseCookies(req) {
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

function sessionTokenFromRequest(req) {
  return parseCookies(req)[sessionCookieName] || "";
}

function db() {
  return getDatabase();
}

async function setSetting(key, value) {
  await db().sql`
    INSERT INTO settings (key, value, updated_at)
    VALUES (${key}, ${String(value ?? "")}, NOW())
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value,
          updated_at = EXCLUDED.updated_at
  `;
}

async function getSetting(key) {
  const rows = await db().sql`SELECT value FROM settings WHERE key = ${key}`;
  return rows[0]?.value || "";
}

async function readSettingsMap() {
  const rows = await db().sql`SELECT key, value FROM settings`;
  return Object.fromEntries(rows.map((row) => [row.key, row.value || ""]));
}

function settingValue(settings, key) {
  return settings?.[key] || "";
}

function parseSettingJson(settings, key, fallback) {
  return safeJsonParse(settingValue(settings, key), fallback);
}

async function ensureCoreTables() {
  await db().sql`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
  await db().sql`
    CREATE TABLE IF NOT EXISTS calendar_items (
      id TEXT PRIMARY KEY,
      account_id TEXT,
      kind TEXT NOT NULL,
      week INTEGER NOT NULL DEFAULT 0,
      day INTEGER NOT NULL,
      start INTEGER NOT NULL,
      duration INTEGER NOT NULL,
      coach_id TEXT,
      location_id TEXT,
      service_id TEXT,
      client TEXT,
      title TEXT NOT NULL,
	      phone TEXT,
	      email TEXT,
      note TEXT,
      coach JSONB,
      location JSONB,
      custom_group JSONB,
      status TEXT NOT NULL DEFAULT 'booked',
	      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
	    )
	  `;
  await db().sql`ALTER TABLE calendar_items ADD COLUMN IF NOT EXISTS account_id TEXT`;
  await db().sql`ALTER TABLE calendar_items ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'booked'`;
  await db().sql`ALTER TABLE calendar_items ADD COLUMN IF NOT EXISTS coach_id TEXT`;
  await db().sql`ALTER TABLE calendar_items ADD COLUMN IF NOT EXISTS location_id TEXT`;
  await db().sql`ALTER TABLE calendar_items ADD COLUMN IF NOT EXISTS coach JSONB`;
  await db().sql`ALTER TABLE calendar_items ADD COLUMN IF NOT EXISTS location JSONB`;
  await db().sql`ALTER TABLE calendar_items ADD COLUMN IF NOT EXISTS custom_group JSONB`;
  await db().sql`ALTER TABLE calendar_items ADD COLUMN IF NOT EXISTS completed_at TEXT`;
  await db().sql`
    CREATE INDEX IF NOT EXISTS idx_calendar_items_slot
    ON calendar_items (week, day, start)
  `;
	  await db().sql`
	    CREATE TABLE IF NOT EXISTS people (
	      id TEXT PRIMARY KEY,
	      account_id TEXT,
	      name TEXT NOT NULL,
	      email TEXT,
	      phone TEXT,
	      notes TEXT,
	      source TEXT,
      caddy_profile_id TEXT,
      caddy_profile_url TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
	    )
	  `;
  await db().sql`ALTER TABLE people ADD COLUMN IF NOT EXISTS account_id TEXT`;
	  await db().sql`DROP INDEX IF EXISTS idx_people_email_unique`;
	  await db().sql`
	    CREATE INDEX IF NOT EXISTS idx_people_email_lookup
	    ON people (LOWER(email))
	    WHERE email IS NOT NULL AND email <> ''
	  `;
	  await db().sql`
	    CREATE INDEX IF NOT EXISTS idx_people_name_phone_lookup
	    ON people (LOWER(name), phone)
	    WHERE phone IS NOT NULL AND phone <> ''
	  `;
  await db().sql`
    CREATE INDEX IF NOT EXISTS idx_people_account_name_lookup
    ON people (account_id, LOWER(name), LOWER(email), id)
  `;
  await db().sql`
    CREATE TABLE IF NOT EXISTS admin_users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
  await db().sql`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
  await db().sql`
    CREATE TABLE IF NOT EXISTS admin_password_resets (
      id TEXT PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
}

async function ensureAuthTables() {
  await db().sql`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
  await db().sql`
    CREATE TABLE IF NOT EXISTS admin_users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
  await db().sql`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
  await db().sql`
    CREATE TABLE IF NOT EXISTS admin_password_resets (
      id TEXT PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
}

async function ensureAuthReady() {
  const startedAt = Date.now();
  const configSignature = authBootstrapSignature();
  if (authReady && authReadyConfigSignature === configSignature) {
    logAuthTiming("ensureAuthReady", startedAt, { cache: "hit" });
    return;
  }
  if (authReady && authReadyConfigSignature !== configSignature) {
    authReady = false;
    authReadyPromise = null;
    authReadyConfigSignature = "";
    console.warn("auth_bootstrap_config_changed");
  }
  const cacheState = authReadyPromise ? "wait" : "miss";
  if (!authReadyPromise) {
    const setupStartedAt = Date.now();
    authReadyPromise = (async () => {
      await ensureAuthTables();
      await ensureAdminUser();
      authReady = true;
      authReadyConfigSignature = configSignature;
      logAuthTiming("ensureAuthReady.setup", setupStartedAt, { ok: true });
    })().catch((error) => {
      authReadyPromise = null;
      authReady = false;
      authReadyConfigSignature = "";
      logAuthTiming("ensureAuthReady.setup", setupStartedAt, { ok: false });
      throw error;
    });
  }
  await authReadyPromise;
  logAuthTiming("ensureAuthReady", startedAt, { cache: cacheState });
}

async function defaultSettings() {
  const account = defaultCoachAccount();
  return {
    syncKey: env("CLARITY_CALENDAR_SYNC_KEY") || generateSyncKey(),
    notificationEmail: env("CLARITY_NOTIFICATION_EMAIL", ""),
    coachEmail: env("CLARITY_COACH_EMAIL", ""),
    replyToEmail: env("CLARITY_REPLY_TO_EMAIL", ""),
    notificationDelaySeconds: "30",
    sendClientEmail: "true",
    sendCoachEmail: "true",
    sendAdminEmail: "true",
    clientEmailSubject: defaultEmailTemplates.clientEmailSubject,
    clientEmailIntro: defaultEmailTemplates.clientEmailIntro,
    clientEmailFooter: defaultEmailTemplates.clientEmailFooter,
    adminEmailSubject: defaultEmailTemplates.adminEmailSubject,
    adminEmailIntro: defaultEmailTemplates.adminEmailIntro,
    smsProviderName: env("CLARITY_SMS_PROVIDER"),
    smsWebhookUrl: env("CLARITY_SMS_WEBHOOK_URL"),
    smsFromNumber: env("CLARITY_SMS_FROM_NUMBER"),
    sendClientSms: "false",
    sendAdminSms: "false",
    accountId: account.id,
    accountCoachName: account.coachName,
    accountBusinessName: account.businessName,
    accountVenueName: account.venueName,
    accountVenueShortName: account.venueShortName,
    accountTimezone: account.timezone,
    accountContactEmail: account.contactEmail,
    accountBookingUrl: account.bookingUrl,
    accountCalendarSlug: account.calendarSlug,
    accountCaddyWorkspaceUrl: account.caddyWorkspaceUrl,
    accountInvoiceSettingsJson: JSON.stringify(account.invoiceSettings),
    coachName: account.businessName,
    workspaceAccountsJson: JSON.stringify(normalizeWorkspaceAccounts([], account)),
    coachProfilesJson: JSON.stringify(normalizeCoachProfiles([], account)),
    appUsersJson: JSON.stringify([defaultAppUserFromAccount(account)]),
    locationsJson: JSON.stringify(normalizeLocations([], account)),
    servicesJson: JSON.stringify(defaultServices),
    availabilityJson: JSON.stringify(defaultAvailability),
    brandLogoName: "",
    brandLogoPreview: "",
    brandShowLogo: "false",
    brandNeutral: "#ffffff",
    brandPrimary: "#1fd36d",
    brandSecondary: "#d7b06b",
    brandAccent: "#07100a",
    brandBookingTheme: "dark",
    updatedAt: nowIso(),
  };
}

async function seedSettings() {
  const defaults = await defaultSettings();
  for (const [key, value] of Object.entries(defaults)) {
    await db().sql`
      INSERT INTO settings (key, value, updated_at)
      VALUES (${key}, ${String(value ?? "")}, NOW())
      ON CONFLICT (key) DO NOTHING
    `;
  }
}

async function seedItems() {
  const countRows = await db()
    .sql`SELECT COUNT(*) AS count FROM calendar_items`;
  if ((countRows[0]?.count ?? 0) > 0) return;

  const client = await db().pool.connect();
  try {
    await client.query("BEGIN");
    for (const item of initialItems) {
      await client.query(
        `INSERT INTO calendar_items (
          id, account_id, kind, week, day, start, duration, service_id, client, title, phone, email, note, status, created_at, updated_at
	        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW())
	        ON CONFLICT (id) DO NOTHING`,
        [
          item.id,
          item.accountId || defaultWorkspaceAccountFromCoachAccount(account).id,
          item.kind,
          item.week,
          item.day,
          item.start,
          item.duration,
          item.serviceId,
          item.client,
          item.title,
          item.phone,
          item.email,
          item.note,
          item.status || "booked",
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function ensureAdminUser() {
  const startedAt = Date.now();
  let outcome = "unknown";
  let wrote = false;
  let hashed = false;
  const email = cleanEmail(env("CLARITY_ADMIN_EMAIL"), "");
  const password = env("CLARITY_ADMIN_PASSWORD");

  try {
    if (!email || !password) {
      outcome = "missing_seed_env";
      console.warn(
        "Admin user not seeded because CLARITY_ADMIN_EMAIL or CLARITY_ADMIN_PASSWORD is not set.",
      );
      return;
    }

    const seedKey = hashToken(`${email}:${password}`);
    const existing = await db()
      .sql`SELECT id, password_hash, password_salt FROM admin_users WHERE email = ${email}`;

    if (existing.length) {
      const currentSeedKey = await getSetting("adminPasswordSeedKey");
      if (currentSeedKey === seedKey && hasValidStoredPasswordHash(existing[0])) {
        outcome = "ready";
        return;
      }
      hashed = true;
      const { passwordHash, salt } = hashPassword(password);
      await db().sql`
        UPDATE admin_users
        SET password_hash = ${passwordHash},
            password_salt = ${salt},
            updated_at = NOW()
        WHERE email = ${email}
      `;
      await setSetting("adminPasswordSeedKey", seedKey);
      wrote = true;
      outcome = "updated_seed";
      return;
    }

    hashed = true;
    const { passwordHash, salt } = hashPassword(password);
    await db().sql`
      INSERT INTO admin_users (id, email, password_hash, password_salt, created_at, updated_at)
      VALUES (${randomUUID()}, ${email}, ${passwordHash}, ${salt}, NOW(), NOW())
      ON CONFLICT (email) DO NOTHING
    `;
    await setSetting("adminPasswordSeedKey", seedKey);
    wrote = true;
    outcome = "inserted_seed";
  } finally {
    logAuthTiming("ensureAdminUser", startedAt, { outcome, wrote, hashed });
  }
}

async function ensureNotificationHistoryTable() {
  await db().sql`
    CREATE TABLE IF NOT EXISTS notification_history (
      id TEXT PRIMARY KEY,
      person_key TEXT,
      calendar_item_id TEXT,
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      provider TEXT,
      provider_id TEXT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await db().sql`
    CREATE INDEX IF NOT EXISTS idx_notification_history_person
    ON notification_history (person_key, created_at DESC)
  `;
  await db().sql`
    CREATE INDEX IF NOT EXISTS idx_notification_history_item
    ON notification_history (calendar_item_id, created_at DESC)
  `;
  await db().sql`
    CREATE INDEX IF NOT EXISTS idx_notification_history_provider
    ON notification_history (provider_id)
    WHERE provider_id IS NOT NULL AND provider_id <> ''
  `;
  await db().sql`
    CREATE TABLE IF NOT EXISTS notification_webhook_events (
      id TEXT PRIMARY KEY,
      provider_id TEXT,
      event_type TEXT NOT NULL,
      payload TEXT,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

async function backfillLegacyPeopleAccountIds(accountId) {
  const cleanAccountId = cleanSlug(accountId, defaultWorkspaceAccountFromCoachAccount().id);
  try {
    await db().sql`
      UPDATE people
      SET account_id = ${cleanAccountId}
      WHERE account_id IS NULL OR BTRIM(account_id) = ''
    `;
  } catch (error) {
    const code = cleanString(error?.code, "", 120);
    const message = error instanceof Error ? error.message : String(error || "");
    if (code === "DUPLICATE_PERSON_EMAIL" || /Another person already uses that email address|duplicate key|idx_people_.*email/i.test(message)) {
      console.warn("people_account_backfill_duplicate_email_skipped", {
        accountId: cleanAccountId,
        message: message.slice(0, 300),
      });
      return;
    }
    throw error;
  }
}

async function ensureSeeded() {
  if (!seedReadyPromise) {
    seedReadyPromise = (async () => {
      await ensureCoreTables();
      await seedSettings();
      await backfillLegacyPeopleAccountIds(peopleAccountIdFromSettings(await readSettingsMap()));
      await ensureNotificationHistoryTable();
      await seedItems();
      await seedPeopleFromAppointments();
      await ensureAdminUser();
    })().catch((error) => {
      seedReadyPromise = null;
      throw error;
    });
  }
  await seedReadyPromise;
}

function rowToItem(row) {
  const updatedAt = cleanString(typeof row?.updated_at === "string" ? row.updated_at : String(row?.updated_at || ""), "", 120);
  const completedAt = cleanString(typeof row?.completed_at === "string" ? row.completed_at : String(row?.completed_at || ""), "", 120);
  const status = ["completed", "cancelled", "no_show"].includes(row.status)
    ? row.status
    : "booked";
  const customGroup = cleanCustomGroupData(row.custom_group);
  const cancelledGroupSession = isCancelledGroupSessionLike(row);
  return {
    id: row.id,
    accountId: row.accountId || row.account_id || defaultWorkspaceAccountFromCoachAccount().id,
    kind: row.kind,
    week: Number(row.week ?? 0),
    day: Number(row.day ?? 0),
    start: Number(row.start ?? 0),
    duration: Number(row.duration ?? 0),
    coachId: row.coach_id || defaultCoachProfileFromAccount().id,
    locationId: row.location_id || cleanBookingLocationSnapshot(row.location)?.locationId || "",
    serviceId: row.service_id || "",
    client: row.client || "",
    title: row.title,
    phone: row.phone || "",
    email: row.email || "",
    note: row.note || "",
    coach: cleanBookingCoachSnapshot(row.coach),
    location: cleanBookingLocationSnapshot(row.location),
    status: cancelledGroupSession ? "cancelled" : status,
    updatedAt,
    completedAt,
    ...(cancelledGroupSession ? { readOnly: true, groupSlot: true } : {}),
    ...(customGroup || {}),
	  };
	}

function lessonCompleteActionFailure(error, baseDetails, durationMs) {
  const status = Number.isFinite(Number(error?.status)) ? Number(error.status) : 500;
  const code = cleanString(error?.code, "BOOKING_COMPLETE_FAILED", 120);
  const details = cleanString(error?.details, "", 1200);
  const hint = cleanString(error?.hint, "", 1200);
  const backendMessage = error instanceof Error ? error.message : String(error?.message || error || "Lesson completion failed.");
  return {
    ...baseDetails,
    httpStatus: status,
    durationMs,
    errorCode: code,
    backendDetails: details || hint || undefined,
    backendHint: hint || undefined,
    backendMessage,
  };
}

function supabaseStorageConfig() {
  const url = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
  if (!url || !key) throw new Error("Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY in Netlify.");
  return { url, key };
}

async function requestSupabaseRows(table, options = {}) {
  const { url, key } = supabaseStorageConfig();
  const {
    method = "GET",
    query = "",
    body,
    prefer = "",
  } = options;
  const response = await fetch(`${url}/rest/v1/${table}${query ? `?${query}` : ""}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const payloadObject = payload && typeof payload === "object" ? payload : {};
    const payloadCode = cleanString(payloadObject.code, "", 120);
    const payloadMessage = cleanString(payloadObject.message, "", 400);
    const payloadDetails = cleanString(payloadObject.details, "", 1200);
    const payloadHint = cleanString(payloadObject.hint, "", 1200);
    const fallbackMessage = `${method} ${table} failed ${response.status}: ${String(text || "").slice(0, 500)}`;
    throw Object.assign(new Error(payloadMessage || fallbackMessage), {
      status: response.status,
      code: payloadCode,
      details: payloadDetails,
      hint: payloadHint,
    });
  }
  return payload || [];
}

function isSupabaseColumnMissingError(error, column) {
  const code = cleanString(error?.code, "", 120).toUpperCase();
  const message = error instanceof Error ? error.message : "";
  const details = cleanString(error?.details, "", 1200);
  const hint = cleanString(error?.hint, "", 1200);
  const combined = [
    message,
    details,
    hint,
  ].join(" ");
  const missingSignal = /does not exist|unknown column|could not find|not found|no such column/i.test(combined);
  const hasColumnMention = new RegExp(`\\b${column}\\b`, "i").test(combined);
  return hasColumnMention && (
    (code === "PGRST204" || code === "PGRST116" || code === "42703") ||
    missingSignal ||
    !code
  );
}

function isSupabaseAccountScopeMissingError(error) {
  return isSupabaseColumnMissingError(error, "account_id");
}

function isSupabaseCompletedAtMissingError(error) {
  return isSupabaseColumnMissingError(error, "completed_at");
}

function lessonCompletePatchFilter(itemId, accountId, useAccountScope) {
  return useAccountScope
    ? `id=eq.${encodeURIComponent(itemId)}&account_id=eq.${encodeURIComponent(accountId)}&select=*`
    : `id=eq.${encodeURIComponent(itemId)}&select=*`;
}

function lessonCompleteReadFilter(itemId, accountId, useAccountScope) {
  return useAccountScope
    ? `select=*&id=eq.${encodeURIComponent(itemId)}&account_id=eq.${encodeURIComponent(accountId)}&limit=1`
    : `select=*&id=eq.${encodeURIComponent(itemId)}&limit=1`;
}

async function readLessonItemForCompletion(itemId, accountId, useAccountScope = true) {
  const rows = await requestSupabaseRows("calendar_items", {
    query: lessonCompleteReadFilter(itemId, accountId, useAccountScope),
    method: "GET",
  });
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function patchLessonItemComplete(itemId, accountId, completedAt, includeCompletedAt, useAccountScope = true) {
  const patch = includeCompletedAt
    ? {
      status: "completed",
      completed_at: completedAt,
      updated_at: completedAt,
    }
    : {
      status: "completed",
      updated_at: completedAt,
    };

  return requestSupabaseRows("calendar_items", {
    method: "PATCH",
    query: lessonCompletePatchFilter(itemId, accountId, useAccountScope),
    body: patch,
    prefer: "return=representation",
  });
}

async function completeCalendarItemById(currentState, itemId, requestContext) {
  const startedAt = Date.now();
  const requestTimed = { startedAt, dbLookupMs: 0, writeMs: 0, settingsUpdateMs: 0 };
  const cleanItemId = cleanString(itemId, "", 140);
  const baseDetails = {
    action: "lesson_complete",
    route: "PUT /api/calendar-state",
    operationOwner: "lesson_complete",
    calendarItemId: cleanItemId,
    accountId: requestContext?.accountId || "",
  };

  if (!cleanItemId) {
    throw Object.assign(new Error("Lesson completion requires a booking id."), {
      status: 400,
      code: "BOOKING_COMPLETE_INVALID_ID",
      ...baseDetails,
    });
  }

  const lookupStart = Date.now();
  const target = currentState.items.find((item) => item.id === cleanItemId);
  requestTimed.dbLookupMs = Date.now() - lookupStart;

  if (!target) {
    throw Object.assign(new Error("Lesson was not found in this workspace."), {
      status: 404,
      code: "BOOKING_COMPLETE_NOT_FOUND",
      ...baseDetails,
    });
  }

  if (target.kind !== "appointment") {
    throw Object.assign(new Error("Only appointments can be marked completed."), {
      status: 400,
      code: "BOOKING_COMPLETE_INVALID_ITEM",
      ...baseDetails,
    });
  }

  assertCanWriteCalendarItem(requestContext, target, target, currentState);

  if (target.status === "completed") {
    const alreadyCompletedTimings = {
      ...requestTimed,
      writeMs: 0,
      totalMs: Date.now() - startedAt,
    };
    console.info("lesson_complete_saved", {
      ...baseDetails,
      httpStatus: 200,
      itemId: cleanItemId,
      calendarId: target.accountId || "",
      message: "lesson already completed",
      durationMs: alreadyCompletedTimings.totalMs,
      stageTimings: alreadyCompletedTimings,
      idempotent: true,
    });
    return {
      ok: true,
      action: "lesson_complete",
      itemId: cleanItemId,
      item: target,
      status: "completed",
      calendarId: target.accountId || "",
      updatedAt: currentState.updatedAt,
      stageTimings: alreadyCompletedTimings,
      idempotent: true,
    };
  }

  const completionAt = nowIso();
  const accountId = cleanString(
    target.accountId || requestContext.accountId || defaultWorkspaceAccountFromCoachAccount().id,
    "",
    140,
  );
  const updateStarted = Date.now();
  let rows = [];
  let usedCompletedAtColumn = true;
  let usedAccountScope = true;
  console.info("lesson_complete_update_attempted", {
    ...baseDetails,
    itemId: cleanItemId,
    calendarId: accountId || target.accountId || "",
    httpStatus: 0,
    action: "lesson_complete",
    durationMs: 0,
  });

  try {
    while (!rows.length) {
      try {
        rows = queryRows(
          await patchLessonItemComplete(
            cleanItemId,
            accountId,
            completionAt,
            usedCompletedAtColumn,
            usedAccountScope,
          ),
        );
        break;
      } catch (error) {
        if (isSupabaseAccountScopeMissingError(error) && usedAccountScope) {
          usedAccountScope = false;
          continue;
        }
        if (isSupabaseCompletedAtMissingError(error) && usedCompletedAtColumn) {
          usedCompletedAtColumn = false;
          continue;
        }
        throw error;
      }
    }
    requestTimed.writeMs = Date.now() - updateStarted;

    if (!rows.length) {
      let existing = null;
      try {
        existing = await readLessonItemForCompletion(cleanItemId, accountId, usedAccountScope);
      } catch (error) {
        if (isSupabaseAccountScopeMissingError(error) && usedAccountScope) {
          usedAccountScope = false;
          existing = await readLessonItemForCompletion(cleanItemId, accountId, false);
        } else {
          throw error;
        }
      }
      if (existing && existing.status === "completed") {
        const idempotentItem = rowToItem(existing);
        const idempotentTimings = {
          ...requestTimed,
          totalMs: Date.now() - startedAt,
        };
        console.info("lesson_complete_saved", {
          ...baseDetails,
          itemId: cleanItemId,
          calendarId: idempotentItem.accountId || accountId || "",
          httpStatus: 200,
          durationMs: idempotentTimings.totalMs,
          stageTimings: idempotentTimings,
          idempotent: true,
          updatedAt: idempotentItem.updatedAt || currentState.updatedAt,
          usedAccountScope,
          usedCompletedAtColumn,
        });
        return {
          ok: true,
          action: "lesson_complete",
          itemId: cleanItemId,
          item: idempotentItem,
          status: "completed",
          calendarId: idempotentItem.accountId || accountId || "",
          updatedAt: idempotentItem.updatedAt || currentState.updatedAt,
          stageTimings: idempotentTimings,
          usedAccountScope,
          idempotent: true,
        };
      }

      throw Object.assign(new Error("Lesson was not found in your workspace."), {
        status: 404,
        code: "BOOKING_COMPLETE_NOT_FOUND",
        ...baseDetails,
      });
    }

    const row = rows[0];
    const item = rowToItem(row);
    const updateSettingStarted = Date.now();
    await setSetting("updatedAt", row.updated_at || nowIso());
    requestTimed.settingsUpdateMs = Date.now() - updateSettingStarted;
    const stageTimings = {
      ...requestTimed,
      totalMs: Date.now() - startedAt,
    };
    console.info("lesson_complete_saved", {
      ...baseDetails,
      itemId: cleanItemId,
      calendarId: item.accountId || accountId || "",
      httpStatus: 200,
      durationMs: stageTimings.totalMs,
      stageTimings,
      idempotent: false,
      updatedAt: item.updatedAt || currentState.updatedAt,
      usedAccountScope,
      usedCompletedAtColumn,
    });
    return {
      ok: true,
      action: "lesson_complete",
      itemId: cleanItemId,
      item,
      status: "completed",
      calendarId: item.accountId || accountId || "",
      updatedAt: item.updatedAt || currentState.updatedAt,
      stageTimings,
      idempotent: false,
      usedAccountScope,
      usedCompletedAtColumn,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const errorStatus = Number.isFinite(Number(error?.status)) ? Number(error.status) : 500;
    const errorCode = cleanString(error?.code, "BOOKING_COMPLETE_FAILED", 120);
    const backendMessage = error instanceof Error ? error.message : String(error || "Lesson completion failed.");
    const errorDetails = cleanString(error?.details, "", 1200);
    const errorHint = cleanString(error?.hint, "", 1200);
    console.error("lesson_complete_failed", {
      ...baseDetails,
      httpStatus: errorStatus,
      durationMs,
      message: backendMessage,
      backendMessage,
      backendDetails: errorDetails || errorHint || undefined,
      backendHint: errorHint || undefined,
      itemId: cleanItemId,
      calendarId: accountId || "",
      errorCode,
      usedAccountScope,
      usedCompletedAtColumn,
      stageTimings: {
        ...requestTimed,
        writeMs: Math.max(1, Date.now() - updateStarted),
        totalMs: durationMs,
      },
    });
    throw error;
  }
}

function isCancelledGroupSessionLike(item) {
  return (
    item?.kind === "block" &&
    Boolean(item?.service_id || item?.serviceId) &&
    (item?.note === CANCELLED_GROUP_SESSION_NOTE || item?.title === CANCELLED_GROUP_SESSION_TITLE)
  );
}

function cleanCalendarItem(item) {
  if (!item || typeof item !== "object") return null;
  const kind =
    item.kind === "block"
      ? "block"
      : item.kind === "appointment"
        ? "appointment"
        : null;
  if (!kind) return null;

  const day = Number(item.day);
  const start = Number(item.start);
  const duration = Number(item.duration);
  if (!Number.isInteger(day) || day < 0 || day > 6) return null;
  if (!Number.isInteger(start) || start < 0 || start > 24 * 60) return null;
  if (!Number.isInteger(duration) || duration <= 0 || duration > 12 * 60)
    return null;

  const customGroup = cleanCustomGroupData({
    customGroup: item.customGroup,
    attendees: item.attendees,
    calculatedPrice: item.calculatedPrice,
  });
  const cancelledGroupSession = isCancelledGroupSessionLike({ ...item, kind });
  return {
    id: cleanString(item.id, `${kind}-${Date.now()}`),
    accountId: cleanSlug(item.accountId, defaultWorkspaceAccountFromCoachAccount().id),
    kind,
    week: Number.isInteger(Number(item.week)) ? Number(item.week) : 0,
    day,
    start,
    duration,
    coachId: cleanSlug(item.coachId || item.coach?.coachId, kind === "appointment" ? defaultCoachProfileFromAccount().id : "") || undefined,
    locationId: cleanSlug(item.locationId || item.location?.locationId, ""),
    serviceId: cleanString(item.serviceId),
    client: cancelledGroupSession ? "" : cleanString(item.client),
    title: cancelledGroupSession
      ? CANCELLED_GROUP_SESSION_TITLE
      : cleanString(item.title, kind === "block" ? "Busy" : "Appointment"),
    phone: cancelledGroupSession ? "" : cleanString(item.phone),
    email: cancelledGroupSession ? "" : cleanString(item.email),
    note: cancelledGroupSession ? CANCELLED_GROUP_SESSION_NOTE : cleanString(item.note),
    coach: cancelledGroupSession ? undefined : cleanBookingCoachSnapshot(item.coach),
    location: cancelledGroupSession ? undefined : cleanBookingLocationSnapshot(item.location),
    status:
      cancelledGroupSession
        ? "cancelled"
        : item.status === "completed" ||
            item.status === "cancelled" ||
            item.status === "no_show"
          ? item.status
          : "booked",
    ...(cancelledGroupSession ? {} : customGroup || {}),
  };
}

function normalizeItems(items) {
  return Array.isArray(items)
    ? items.map(cleanCalendarItem).filter(Boolean)
    : initialItems;
}

function cleanPerson(person, source = "import", accountId = defaultWorkspaceAccountFromCoachAccount().id) {
  if (!person || typeof person !== "object") return null;
  const joinedName = [person.firstName, person.lastName]
    .filter(Boolean)
    .join(" ");
  const name = cleanString(
    person.name || joinedName || person.client || person.title,
    "",
    180,
  );
  const email = cleanString(person.email, "", 180).toLowerCase();
  if (!name && !email) return null;

  return {
    id: cleanString(person.id, "", 120),
    accountId: cleanSlug(person.accountId || person.account_id, accountId),
    name: name || email,
    email,
    phone: cleanString(person.phone, "", 80),
    notes: cleanString(person.notes || person.note, "", 1200),
    source: cleanString(person.source, source, 80),
    caddyProfileId: cleanString(
      person.caddyProfileId || person.caddyId,
      "",
      120,
    ),
    caddyProfileUrl: cleanString(
      person.caddyProfileUrl || person.caddyUrl,
      "",
      600,
    ),
  };
}

function normalizedPersonName(value) {
  return cleanString(value, "", 180).toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizedPersonEmail(value) {
  return cleanString(value, "", 180).toLowerCase();
}

function normalizedPersonPhone(value) {
  return cleanString(value, "", 80).replace(/\D/g, "");
}

function compatiblePersonMatch(candidate, rows = []) {
  if (!candidate || !Array.isArray(rows) || !rows.length) return null;
  const accountId = cleanSlug(candidate.accountId, defaultWorkspaceAccountFromCoachAccount().id);
  const scopedRows = rows.filter((row) => recordBelongsToAccount(row, accountId));

  const candidateId = cleanString(candidate.id, "", 120);
  if (candidateId && !candidateId.startsWith("appointment-")) {
    const exactId = scopedRows.find((row) => String(row?.id || "") === candidateId);
    if (exactId) return exactId;
  }

  const name = normalizedPersonName(candidate.name);
  const email = normalizedPersonEmail(candidate.email);
  const phone = normalizedPersonPhone(candidate.phone);

  if (name && email) {
    const matches = scopedRows.filter(
      (row) =>
        normalizedPersonName(row?.name) === name &&
        normalizedPersonEmail(row?.email) === email,
    );
    const exact = matches.find((row) => {
      const existingPhone = normalizedPersonPhone(row?.phone);
      return !phone || !existingPhone || phone === existingPhone;
    });
    if (exact) return exact;
  }

  if (name && phone) {
    const exact = scopedRows.find(
      (row) =>
        normalizedPersonName(row?.name) === name &&
        normalizedPersonPhone(row?.phone) === phone,
    );
    if (exact) return exact;
  }

  // Use a lone contact-method match only when it is unambiguous and names do
  // not conflict. Shared family or organisation details must remain separate.
  if (email) {
    const matches = scopedRows.filter(
      (row) => normalizedPersonEmail(row?.email) === email,
    );
    if (matches.length === 1) {
      const only = matches[0];
      const existingName = normalizedPersonName(only?.name);
      const existingPhone = normalizedPersonPhone(only?.phone);
      if (
        (!name || !existingName || name === existingName) &&
        (!phone || !existingPhone || phone === existingPhone)
      ) {
        return only;
      }
    }
  }

  if (phone) {
    const matches = scopedRows.filter(
      (row) => normalizedPersonPhone(row?.phone) === phone,
    );
    if (matches.length === 1) {
      const only = matches[0];
      const existingName = normalizedPersonName(only?.name);
      if (!name || !existingName || name === existingName) return only;
    }
  }

  return null;
}

function personByEmail(rows = [], email = "", accountId = defaultWorkspaceAccountFromCoachAccount().id) {
  const normalizedEmail = normalizedPersonEmail(email);
  if (!normalizedEmail || !Array.isArray(rows)) return null;
  const cleanAccountId = cleanSlug(accountId, defaultWorkspaceAccountFromCoachAccount().id);
  return (
    rows.find(
      (row) =>
        recordBelongsToAccount(row, cleanAccountId) &&
        normalizedPersonEmail(row?.email) === normalizedEmail,
    ) || null
  );
}

function duplicatePersonEmailError(person, existing, route = "PUT /api/people") {
  const email = normalizedPersonEmail(person?.email);
  const personId = cleanString(person?.id, "", 120);
  const duplicatePersonId = cleanString(existing?.id, "", 120);
  return Object.assign(
    new Error("Another person already uses that email address."),
    {
      status: 409,
      code: "DUPLICATE_PERSON_EMAIL",
      operationOwner: "people_patch",
      route,
      personId,
      email,
      details: {
        operationOwner: "people_patch",
        route,
        httpStatus: 409,
        personId,
        duplicatePersonId,
        email,
      },
    },
  );
}

function personFromAppointment(item) {
  if (!item || item.kind !== "appointment") return null;
  return cleanPerson(
    {
      name: item.client || item.title,
      email: item.email,
      phone: item.phone,
      source: "appointment",
    },
    "appointment",
  );
}

async function readItems() {
  const rows = await db().sql`
    SELECT * FROM calendar_items
    ORDER BY week, day, start, id
  `;
  return rows.map(rowToItem);
}

function publicBookingSlotsWeek(value) {
  const rawWeek = Number(value ?? currentWeekOffset());
  return Number.isInteger(rawWeek) ? rawWeek : currentWeekOffset();
}

export function publicSlotCalendarItemsQuery({ accountId, week, useAccountScope = true } = {}) {
  const safeWeek = publicBookingSlotsWeek(week);
  const query = ["select=*"];
  if (useAccountScope) {
    query.push(`account_id=eq.${encodeURIComponent(cleanSlug(accountId, defaultWorkspaceAccountFromCoachAccount().id))}`);
  }
  query.push(
    `week=eq.${encodeURIComponent(String(safeWeek))}`,
    "order=day.asc,start.asc,id.asc",
  );
  return query.join("&");
}

export async function readPublicSlotItemsForWeek({ accountId, week } = {}) {
  const safeWeek = publicBookingSlotsWeek(week);
  const primaryQuery = publicSlotCalendarItemsQuery({ accountId, week: safeWeek, useAccountScope: true });
  try {
    const rows = await requestSupabaseRows("calendar_items", { query: primaryQuery });
    return {
      items: rows.map(rowToItem),
      rowsFetched: rows.length,
      query: primaryQuery,
      queryMode: "account_week",
      usedLegacySchemaFallback: false,
    };
  } catch (error) {
    if (!isSupabaseAccountScopeMissingError(error)) throw error;
    const fallbackQuery = publicSlotCalendarItemsQuery({ accountId, week: safeWeek, useAccountScope: false });
    console.warn("public_booking_slots:calendar_items_account_scope_fallback", {
      week: safeWeek,
      accountId: cleanSlug(accountId, defaultWorkspaceAccountFromCoachAccount().id),
      error: error instanceof Error ? error.message.slice(0, 300) : String(error || "").slice(0, 300),
    });
    const rows = await requestSupabaseRows("calendar_items", { query: fallbackQuery });
    return {
      items: rows.map(rowToItem),
      rowsFetched: rows.length,
      query: fallbackQuery,
      attemptedQuery: primaryQuery,
      queryMode: "week_only_legacy_schema",
      usedLegacySchemaFallback: true,
    };
  }
}

export function publicAppointmentReadQuery({ appointmentId, accountId, useAccountScope = true } = {}) {
  const query = [
    "select=*",
    `id=eq.${encodeURIComponent(cleanString(appointmentId, "", 160))}`,
  ];
  if (useAccountScope) {
    query.push(`account_id=eq.${encodeURIComponent(cleanSlug(accountId, defaultWorkspaceAccountFromCoachAccount().id))}`);
  }
  query.push("limit=1");
  return query.join("&");
}

export function publicAppointmentContactQuery({ accountId, email, useAccountScope = true } = {}) {
  const cleanEmailValue = cleanString(email, "", 180).toLowerCase();
  const query = [
    "select=*",
    "kind=eq.appointment",
    `email=ilike.${encodeURIComponent(cleanEmailValue)}`,
  ];
  if (useAccountScope) {
    query.push(`account_id=eq.${encodeURIComponent(cleanSlug(accountId, defaultWorkspaceAccountFromCoachAccount().id))}`);
  }
  query.push("order=week.asc,day.asc,start.asc,id.asc", "limit=50");
  return query.join("&");
}

async function readPublicAppointmentById(appointmentId, accountId) {
  const cleanAppointmentId = cleanString(appointmentId, "", 160);
  const cleanAccountId = cleanSlug(accountId, defaultWorkspaceAccountFromCoachAccount().id);
  if (!cleanAppointmentId) return null;
  const primaryQuery = publicAppointmentReadQuery({
    appointmentId: cleanAppointmentId,
    accountId: cleanAccountId,
    useAccountScope: true,
  });
  try {
    const rows = await requestSupabaseRows("calendar_items", { query: primaryQuery });
    return rows.map(rowToItem).find((item) => recordBelongsToAccount(item, cleanAccountId)) || null;
  } catch (error) {
    if (!isSupabaseAccountScopeMissingError(error)) throw error;
    const fallbackQuery = publicAppointmentReadQuery({
      appointmentId: cleanAppointmentId,
      accountId: cleanAccountId,
      useAccountScope: false,
    });
    console.warn("public_booking:calendar_item_account_scope_fallback", {
      appointmentId: cleanAppointmentId,
      accountId: cleanAccountId,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error || "").slice(0, 300),
    });
    const rows = await requestSupabaseRows("calendar_items", { query: fallbackQuery });
    return rows.map(rowToItem).find((item) => recordBelongsToAccount(item, cleanAccountId)) || null;
  }
}

async function readPublicAppointmentsForContact({ accountId, email, phone } = {}) {
  const cleanAccountId = cleanSlug(accountId, defaultWorkspaceAccountFromCoachAccount().id);
  const cleanEmailValue = cleanString(email, "", 180).toLowerCase();
  const normalizedEmail = normalizeRescheduleContact(cleanEmailValue);
  const normalizedPhone = normalizeRescheduleContact(phone);
  if (!cleanEmailValue || !normalizedEmail || !normalizedPhone) {
    return { items: [], rowsFetched: 0, queryMode: "invalid_contact" };
  }
  const primaryQuery = publicAppointmentContactQuery({
    accountId: cleanAccountId,
    email: cleanEmailValue,
    useAccountScope: true,
  });
  try {
    const rows = await requestSupabaseRows("calendar_items", { query: primaryQuery });
    const items = rows
      .map(rowToItem)
      .filter((item) => recordBelongsToAccount(item, cleanAccountId) && matchesRescheduleContact(item, normalizedEmail, normalizedPhone));
    return { items, rowsFetched: rows.length, query: primaryQuery, queryMode: "account_email" };
  } catch (error) {
    if (!isSupabaseAccountScopeMissingError(error)) throw error;
    const fallbackQuery = publicAppointmentContactQuery({
      accountId: cleanAccountId,
      email: cleanEmailValue,
      useAccountScope: false,
    });
    console.warn("public_reschedule_lookup:calendar_items_account_scope_fallback", {
      accountId: cleanAccountId,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error || "").slice(0, 300),
    });
    const rows = await requestSupabaseRows("calendar_items", { query: fallbackQuery });
    const items = rows
      .map(rowToItem)
      .filter((item) => recordBelongsToAccount(item, cleanAccountId) && matchesRescheduleContact(item, normalizedEmail, normalizedPhone));
    return { items, rowsFetched: rows.length, query: fallbackQuery, attemptedQuery: primaryQuery, queryMode: "email_only_legacy_schema" };
  }
}

function queryRows(result) {
  return Array.isArray(result) ? result : result?.rows || [];
}

function rowToPerson(row, fallbackAccountId = defaultWorkspaceAccountFromCoachAccount().id) {
  return {
    id: row.id,
    accountId: row.account_id || fallbackAccountId,
    name: row.name,
    email: row.email || "",
    phone: row.phone || "",
    notes: row.notes || "",
    source: row.source || "",
    caddyProfileId: row.caddy_profile_id || "",
    caddyProfileUrl: row.caddy_profile_url || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function notificationPersonKey({ name = "", email = "", phone = "" } = {}) {
  const cleanEmailValue = cleanString(email, "", 180).toLowerCase();
  if (cleanEmailValue) return `email:${cleanEmailValue}`;
  const phoneDigits = cleanString(phone, "", 80).replace(/\D/g, "");
  if (phoneDigits) return `phone:${phoneDigits}`;
  const cleanName = cleanString(name, "", 180)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return cleanName ? `name:${cleanName}` : "";
}

function notificationStatusPriority(status = "") {
  return (
    {
      skipped: 0,
      queued: 1,
      sent: 10,
      delayed: 15,
      delivered: 20,
      opened: 25,
      clicked: 30,
      failed: 40,
      suppressed: 45,
      complained: 50,
      bounced: 60,
    }[status] ?? 0
  );
}

function shouldApplyNotificationStatus(currentStatus = "", nextStatus = "") {
  if (!nextStatus) return false;
  if (!currentStatus) return true;
  return (
    notificationStatusPriority(nextStatus) >=
    notificationStatusPriority(currentStatus)
  );
}

function resendWebhookStatus(type = "") {
  switch (type) {
    case "email.sent":
      return "sent";
    case "email.delivered":
      return "delivered";
    case "email.delivery_delayed":
      return "delayed";
    case "email.opened":
      return "opened";
    case "email.clicked":
      return "clicked";
    case "email.failed":
      return "failed";
    case "email.bounced":
      return "bounced";
    case "email.complained":
      return "complained";
    case "email.suppressed":
      return "suppressed";
    default:
      return "";
  }
}

function resendWebhookErrorMessage(event = {}) {
  const data = event?.data || {};
  const bounce = data?.bounce || {};
  return cleanString(
    bounce?.message ||
      data?.error ||
      data?.message ||
      data?.reason ||
      data?.response ||
      "",
    "",
    500,
  );
}

function rowToNotification(row) {
  return {
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
    createdAt: row.created_at,
  };
}

async function readNotificationHistory() {
  const rows = await db().sql`
    SELECT *
    FROM notification_history
    ORDER BY created_at DESC
    LIMIT 500
  `;
  return rows.map(rowToNotification);
}

async function readNotificationHistoryForAppointment(appointmentId) {
  const cleanAppointmentId = cleanString(appointmentId, "", 160);
  if (!cleanAppointmentId) return [];
  const rows = await db().sql`
    SELECT *
    FROM notification_history
    WHERE calendar_item_id = ${cleanAppointmentId}
    ORDER BY created_at DESC
    LIMIT 50
  `;
  return rows.map(rowToNotification);
}

async function recordNotification({
  personKey = "",
  calendarItemId = "",
  recipient = "",
  subject = "",
  kind = "",
  status = "",
  provider = "",
  providerId = "",
  error = "",
}) {
  const record = {
    id: randomUUID(),
    personKey,
    calendarItemId,
    recipient: cleanString(recipient, "", 180),
    subject: cleanString(subject, "", 220),
    kind: cleanString(kind, "", 80),
    status: cleanString(status, "", 80),
    provider: cleanString(provider, "", 80),
    providerId: cleanString(providerId, "", 180),
    error: cleanString(error, "", 500),
  };
  await db().sql`
    INSERT INTO notification_history (
      id, person_key, calendar_item_id, recipient, subject, kind, status, provider, provider_id, error, created_at
    )
    VALUES (
      ${record.id}, ${record.personKey}, ${record.calendarItemId}, ${record.recipient}, ${record.subject},
      ${record.kind}, ${record.status}, ${record.provider}, ${record.providerId}, ${record.error}, NOW()
    )
  `;
  return record;
}

async function readPeople(fallbackAccountId = defaultWorkspaceAccountFromCoachAccount().id) {
  const rows = await db().sql`
    SELECT * FROM people
    ORDER BY LOWER(name), LOWER(email), id
  `;
  return rows.map((row) => rowToPerson(row, fallbackAccountId));
}

const LESSON_NOTES_SETTING_PREFIX = "lessonNotes.v1";

function lessonNotesSettingKey(accountId = defaultWorkspaceAccountFromCoachAccount().id) {
  return `${LESSON_NOTES_SETTING_PREFIX}.${cleanSlug(accountId, defaultWorkspaceAccountFromCoachAccount().id)}`;
}

function rowToLessonNote(note, fallbackAccountId = defaultWorkspaceAccountFromCoachAccount().id) {
  const createdAt = cleanString(note?.createdAt || note?.created_at, "", 80) || nowIso();
  const updatedAt = cleanString(note?.updatedAt || note?.updated_at, "", 80) || createdAt;
  return {
    id: cleanString(note?.id, "", 120) || randomUUID(),
    accountId: cleanSlug(note?.accountId || note?.account_id, fallbackAccountId),
    playerId: cleanString(note?.playerId || note?.player_id, "", 160),
    playerName: cleanString(note?.playerName || note?.player_name, "", 180),
    lessonId: cleanString(note?.lessonId || note?.lesson_id, "", 160),
    calendarItemId: cleanString(note?.calendarItemId || note?.calendar_item_id, "", 160),
    title: cleanString(note?.title, "Lesson note", 180),
    body: cleanString(note?.body || note?.text || note?.note, "", 8000),
    source: cleanString(note?.source, "typed", 40) === "voice" ? "voice" : "typed",
    createdAt,
    updatedAt,
  };
}

async function readLessonNotes(accountId = defaultWorkspaceAccountFromCoachAccount().id) {
  const cleanAccountId = cleanSlug(accountId, defaultWorkspaceAccountFromCoachAccount().id);
  const raw = await getSetting(lessonNotesSettingKey(cleanAccountId));
  const parsed = safeJsonParse(raw, []);
  return Array.isArray(parsed)
    ? parsed
        .map((note) => rowToLessonNote(note, cleanAccountId))
        .filter((note) => note.playerId && note.body)
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    : [];
}

async function writeLessonNotes(notes, accountId = defaultWorkspaceAccountFromCoachAccount().id) {
  const cleanAccountId = cleanSlug(accountId, defaultWorkspaceAccountFromCoachAccount().id);
  const scopedNotes = Array.isArray(notes)
    ? notes
        .map((note) => rowToLessonNote(note, cleanAccountId))
        .filter((note) => note.playerId && note.body)
    : [];
  await setSetting(lessonNotesSettingKey(cleanAccountId), JSON.stringify(scopedNotes));
  return scopedNotes.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

async function upsertLessonNote(rawNote, accountId = defaultWorkspaceAccountFromCoachAccount().id) {
  const cleanAccountId = cleanSlug(accountId, defaultWorkspaceAccountFromCoachAccount().id);
  const now = nowIso();
  const current = await readLessonNotes(cleanAccountId);
  const note = rowToLessonNote(
    {
      ...rawNote,
      accountId: cleanAccountId,
      id: rawNote?.id || randomUUID(),
      createdAt: rawNote?.createdAt || now,
      updatedAt: now,
    },
    cleanAccountId,
  );
  if (!note.playerId) {
    throw Object.assign(new Error("A lesson note needs a player id."), { status: 400 });
  }
  if (!note.body.trim()) {
    throw Object.assign(new Error("A lesson note cannot be empty."), { status: 400 });
  }
  const next = [note, ...current.filter((entry) => entry.id !== note.id)];
  const notes = await writeLessonNotes(next, cleanAccountId);
  return { note, notes };
}

async function deleteLessonNote(noteId, accountId = defaultWorkspaceAccountFromCoachAccount().id) {
  const cleanAccountId = cleanSlug(accountId, defaultWorkspaceAccountFromCoachAccount().id);
  const cleanId = cleanString(noteId, "", 120);
  if (!cleanId) {
    throw Object.assign(new Error("A lesson note id is required."), { status: 400 });
  }
  const current = await readLessonNotes(cleanAccountId);
  const notes = await writeLessonNotes(current.filter((note) => note.id !== cleanId), cleanAccountId);
  return { notes };
}

async function importPeople(rawPeople, source = "import", accountId = defaultWorkspaceAccountFromCoachAccount().id) {
  const cleanAccountId = cleanSlug(accountId, defaultWorkspaceAccountFromCoachAccount().id);
  const people = Array.isArray(rawPeople)
    ? rawPeople.map((person) => cleanPerson(person, source, cleanAccountId)).filter(Boolean)
    : [];
  const result = {
    imported: 0,
    updated: 0,
    skipped: Array.isArray(rawPeople) ? rawPeople.length - people.length : 0,
    failed: 0,
    errors: [],
    people: [],
  };
  if (!Array.isArray(rawPeople)) return result;

  const knownPeople = await readPeople(cleanAccountId);
  const client = await db().pool.connect();
  try {
    await client.query("BEGIN");
    for (const person of people) {
      const existing = compatiblePersonMatch(person, knownPeople);
      const existingId = existing?.id || "";

      if (existingId) {
        await client.query(
          `UPDATE people
           SET name = COALESCE(NULLIF($2, ''), name),
               email = COALESCE(NULLIF($3, ''), email),
               phone = COALESCE(NULLIF($4, ''), phone),
               notes = COALESCE(NULLIF($5, ''), notes),
	               source = COALESCE(NULLIF($6, ''), source),
	               caddy_profile_id = COALESCE(NULLIF($7, ''), caddy_profile_id),
	               caddy_profile_url = COALESCE(NULLIF($8, ''), caddy_profile_url),
	               account_id = COALESCE(NULLIF($9, ''), account_id),
	               updated_at = NOW()
	           WHERE id = $1`,
	          [
            existingId,
            person.name,
            person.email,
            person.phone,
            person.notes,
	            person.source || source,
	            person.caddyProfileId,
	            person.caddyProfileUrl,
              person.accountId || cleanAccountId,
	          ],
	        );
	        Object.assign(existing, {
            accountId: person.accountId || cleanAccountId,
	          name: person.name || existing.name,
          email: person.email || existing.email,
          phone: person.phone || existing.phone,
          notes: person.notes || existing.notes,
          source: person.source || source || existing.source,
          caddyProfileId: person.caddyProfileId || existing.caddyProfileId,
          caddyProfileUrl: person.caddyProfileUrl || existing.caddyProfileUrl,
        });
        result.updated += 1;
      } else {
        const personId = person.id || randomUUID();
	        await client.query(
	          `INSERT INTO people (
	             id, name, email, phone, notes, source, caddy_profile_id, caddy_profile_url, account_id, created_at, updated_at
	           ) VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''), $6, NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''), NOW(), NOW())`,
	          [
            personId,
            person.name,
            person.email,
            person.phone,
            person.notes,
	            person.source || source,
	            person.caddyProfileId,
	            person.caddyProfileUrl,
              person.accountId || cleanAccountId,
	          ],
	        );
        knownPeople.push({ ...person, id: personId });
        result.imported += 1;
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  result.people = await readPeople(cleanAccountId);
  return result;
}

async function updatePerson(rawPerson, accountId = defaultWorkspaceAccountFromCoachAccount().id) {
  const cleanAccountId = cleanSlug(accountId, defaultWorkspaceAccountFromCoachAccount().id);
  const person = cleanPerson(rawPerson, "manual_update", cleanAccountId);
  if (!person) {
    const error = new Error("A person needs a name or email.");
    error.status = 400;
    throw error;
  }

  const knownPeople = await readPeople(cleanAccountId);
  const existing = compatiblePersonMatch(person, knownPeople);
  const existingId = existing?.id || "";
  const personId =
    existingId ||
    (person.id && !person.id.startsWith("appointment-")
      ? person.id
      : randomUUID());
  const emailOwner = personByEmail(knownPeople, person.email, cleanAccountId);
  const emailOwnerId = cleanString(emailOwner?.id, "", 120);
  if (emailOwnerId && emailOwnerId !== personId) {
    throw duplicatePersonEmailError({ ...person, id: personId }, emailOwner);
  }

  const client = await db().pool.connect();
  try {
    await client.query("BEGIN");
    if (existingId) {
      const emailUnchanged =
        normalizedPersonEmail(existing?.email) === normalizedPersonEmail(person.email);
      await client.query(
        emailUnchanged
          ? `UPDATE people
             SET name = $2,
                 phone = NULLIF($4, ''),
                 notes = NULLIF($5, ''),
                 source = COALESCE(NULLIF($6, ''), source),
                 caddy_profile_id = NULLIF($7, ''),
                 caddy_profile_url = NULLIF($8, ''),
                 account_id = COALESCE(NULLIF($9, ''), account_id),
                 updated_at = NOW()
             WHERE id = $1`
          : `UPDATE people
             SET name = $2,
                 email = NULLIF($3, ''),
                 phone = NULLIF($4, ''),
                 notes = NULLIF($5, ''),
                 source = COALESCE(NULLIF($6, ''), source),
                 caddy_profile_id = NULLIF($7, ''),
                 caddy_profile_url = NULLIF($8, ''),
                 account_id = COALESCE(NULLIF($9, ''), account_id),
                 updated_at = NOW()
             WHERE id = $1`,
        [
          personId,
          person.name,
          person.email,
          person.phone,
          person.notes,
	          person.source,
	          person.caddyProfileId,
	          person.caddyProfileUrl,
            person.accountId || cleanAccountId,
	        ],
	      );
	    } else {
	      await client.query(
	        `INSERT INTO people (
	          id, name, email, phone, notes, source, caddy_profile_id, caddy_profile_url, account_id, created_at, updated_at
	        ) VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''), $6, NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''), NOW(), NOW())`,
	        [
          personId,
          person.name,
          person.email,
          person.phone,
          person.notes,
	          person.source,
	          person.caddyProfileId,
	          person.caddyProfileUrl,
            person.accountId || cleanAccountId,
	        ],
	      );
    }

    const saved = await client.query(
      "SELECT * FROM people WHERE id = $1 LIMIT 1",
      [personId],
    );
    await client.query("COMMIT");
    return { person: rowToPerson(saved.rows[0], cleanAccountId), people: await readPeople(cleanAccountId) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function writeItems(items, options = {}) {
  const cleanItems = normalizeItems(items);
  const client = await db().pool.connect();
  try {
    await client.query("BEGIN");
    if (options.clearItems === true) {
      if (options.accountId) {
        await client.query("DELETE FROM calendar_items WHERE account_id = $1", [options.accountId]);
      } else {
        await client.query("DELETE FROM calendar_items");
      }
    }
    for (const item of cleanItems) {
      await client.query(
        `INSERT INTO calendar_items (
          id, account_id, kind, week, day, start, duration, coach_id, location_id, service_id, client, title, phone, email, note, status, custom_group, coach, location, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18::jsonb, $19::jsonb, NOW(), NOW())
        ON CONFLICT (id) DO UPDATE SET
          account_id = EXCLUDED.account_id,
          kind = EXCLUDED.kind,
          week = EXCLUDED.week,
          day = EXCLUDED.day,
          start = EXCLUDED.start,
          duration = EXCLUDED.duration,
          coach_id = EXCLUDED.coach_id,
          location_id = EXCLUDED.location_id,
          service_id = EXCLUDED.service_id,
          client = EXCLUDED.client,
          title = EXCLUDED.title,
          phone = EXCLUDED.phone,
          email = EXCLUDED.email,
          note = EXCLUDED.note,
          status = EXCLUDED.status,
          custom_group = EXCLUDED.custom_group,
          coach = EXCLUDED.coach,
          location = EXCLUDED.location,
          updated_at = NOW()`,
        [
          item.id,
          item.accountId || defaultWorkspaceAccountFromCoachAccount().id,
          item.kind,
          item.week ?? 0,
          item.day,
          item.start,
          item.duration,
          item.coachId || defaultCoachProfileFromAccount().id,
          item.locationId || item.location?.locationId || "",
          item.serviceId || "",
          item.client || "",
          item.title,
          item.phone || "",
          item.email || "",
          item.note || "",
          item.status || "booked",
          item.customGroup ? JSON.stringify(cleanCustomGroupData(item)) : null,
          item.coach ? JSON.stringify(cleanBookingCoachSnapshot(item.coach)) : null,
          item.location ? JSON.stringify(cleanBookingLocationSnapshot(item.location)) : null,
        ],
      );
    }
    if (options.replaceItems === true && cleanItems.length) {
      const keepIds = new Set(cleanItems.map((item) => item.id));
      const existingRows = queryRows(
        options.accountId
          ? await client.query("SELECT id, account_id FROM calendar_items")
          : await client.query("SELECT id FROM calendar_items"),
      );
      const staleIds = existingRows
        .filter((row) => !options.accountId || recordAccountId({ accountId: row?.account_id || "" }, options.accountId) === options.accountId)
        .map((row) => cleanString(row?.id, "", 140))
        .filter((id) => id && !keepIds.has(id));
      if (staleIds.length) {
        console.info("CALENDAR_STATE_REPLACE_UNSUPPORTED_QUERY", {
          action: "replace_stale_cleanup",
          route: "/api/calendar-state",
          accountId: options.accountId || "",
          targetedDelete: false,
          staleCount: staleIds.length,
          supportedCleanup: true,
        });
      }
      for (const staleId of staleIds) {
        await client.query("DELETE FROM calendar_items WHERE id = $1", [staleId]);
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return readItems();
}

async function seedPeopleFromAppointments() {
  const countRows = await db().sql`SELECT COUNT(*) AS count FROM people`;
  if ((countRows[0]?.count ?? 0) > 0) return;
  const settings = await readSettingsMap();
  await importPeople(
    initialItems.map(personFromAppointment).filter(Boolean),
    "appointment",
    peopleAccountIdFromSettings(settings),
  );
}

async function readStateSettingsSnapshot() {
  await ensureSeeded();
  const settings = await readSettingsMap();
  let syncKey = settingValue(settings, "syncKey");
  if (!syncKey) {
    syncKey = generateSyncKey();
    await setSetting("syncKey", syncKey);
    settings.syncKey = syncKey;
  }
  let updatedAt = settingValue(settings, "updatedAt");
  if (!updatedAt) {
    updatedAt = nowIso();
    await setSetting("updatedAt", updatedAt);
    settings.updatedAt = updatedAt;
  }
  return { settings, syncKey, updatedAt };
}

function coachAccountFromSettings(settings) {
  const defaults = defaultCoachAccount();
  return cleanCoachAccount({
    id: settingValue(settings, "accountId") || defaults.id,
    coachName: settingValue(settings, "accountCoachName") || defaults.coachName,
    businessName:
      settingValue(settings, "accountBusinessName") ||
      settingValue(settings, "coachName") ||
      defaults.businessName,
    venueName: settingValue(settings, "accountVenueName") || defaults.venueName,
    venueShortName:
      settingValue(settings, "accountVenueShortName") || defaults.venueShortName,
    timezone: settingValue(settings, "accountTimezone") || defaults.timezone,
    contactEmail:
      settingValue(settings, "accountContactEmail") || defaults.contactEmail,
    bookingUrl: settingValue(settings, "accountBookingUrl") || defaults.bookingUrl,
    calendarSlug:
      settingValue(settings, "accountCalendarSlug") || defaults.calendarSlug,
    caddyWorkspaceUrl:
      settingValue(settings, "accountCaddyWorkspaceUrl") ||
      defaults.caddyWorkspaceUrl,
    invoiceSettings: parseSettingJson(
      settings,
      "accountInvoiceSettingsJson",
      defaults.invoiceSettings,
    ),
  });
}

function adminSettingsFromSettings(settings) {
  const delaySeconds = Number(settingValue(settings, "notificationDelaySeconds") || 30);
  return {
    emailNotificationsEnabled: settingValue(settings, "emailNotificationsEnabled") !== "false",
    notificationEmail: settingValue(settings, "notificationEmail"),
    coachEmail: settingValue(settings, "coachEmail"),
    replyToEmail: settingValue(settings, "replyToEmail"),
    notificationDelaySeconds: Number.isFinite(delaySeconds)
      ? Math.max(30, Math.min(3600, delaySeconds))
      : 30,
    sendClientEmail: settingValue(settings, "sendClientEmail") !== "false",
    sendCoachEmail: settingValue(settings, "sendCoachEmail") !== "false",
    sendAdminEmail: settingValue(settings, "sendAdminEmail") !== "false",
    clientEmailSubject:
      settingValue(settings, "clientEmailSubject") ||
      defaultEmailTemplates.clientEmailSubject,
    clientEmailIntro:
      settingValue(settings, "clientEmailIntro") ||
      defaultEmailTemplates.clientEmailIntro,
    clientEmailFooter: modernClientEmailFooter(
      settingValue(settings, "clientEmailFooter") ||
        defaultEmailTemplates.clientEmailFooter,
    ),
    adminEmailSubject:
      settingValue(settings, "adminEmailSubject") ||
      defaultEmailTemplates.adminEmailSubject,
    adminEmailIntro:
      settingValue(settings, "adminEmailIntro") ||
      defaultEmailTemplates.adminEmailIntro,
    smsProviderName: settingValue(settings, "smsProviderName"),
    smsWebhookUrl: settingValue(settings, "smsWebhookUrl"),
    smsFromNumber: settingValue(settings, "smsFromNumber"),
    sendClientSms: settingValue(settings, "sendClientSms") === "true",
    sendAdminSms: settingValue(settings, "sendAdminSms") === "true",
  };
}

function brandSettingsFromSettings(settings, account) {
  return {
    coachName: settingValue(settings, "coachName") || account.businessName,
    logoName: settingValue(settings, "brandLogoName"),
    logoPreview: settingValue(settings, "brandLogoPreview"),
    showLogo: settingValue(settings, "brandShowLogo") === "true",
    neutral: settingValue(settings, "brandNeutral") || "#ffffff",
    primary: settingValue(settings, "brandPrimary") || "#1fd36d",
    secondary: settingValue(settings, "brandSecondary") || "#d7b06b",
    accent: settingValue(settings, "brandAccent") || "#07100a",
    bookingTheme:
      settingValue(settings, "brandBookingTheme") === "light" ? "light" : "dark",
  };
}

function servicesFromSettings(settings) {
  return normalizeServices(parseSettingJson(settings, "servicesJson", defaultServices));
}

function workspaceAccountsFromSettings(settings, account) {
  return normalizeWorkspaceAccounts(
    parseSettingJson(settings, "workspaceAccountsJson", []),
    account,
  );
}

function coachProfilesFromSettings(settings, account) {
  return normalizeCoachProfiles(
    parseSettingJson(settings, "coachProfilesJson", []),
    account,
  );
}

function appUsersFromSettings(settings, account) {
  const users = parseSettingJson(settings, "appUsersJson", []);
  return Array.isArray(users) && users.length ? users : [defaultAppUserFromAccount(account)];
}

function locationsFromSettings(settings, account) {
  return normalizeLocations(
    parseSettingJson(settings, "locationsJson", []),
    account,
  );
}

function availabilityFromSettings(settings) {
  return normalizeAvailability(
    parseSettingJson(settings, "availabilityJson", defaultAvailability),
  );
}

async function readAdminSettings() {
  await ensureSeeded();
  const delaySeconds = Number(
    (await getSetting("notificationDelaySeconds")) || 30,
  );
  return {
    emailNotificationsEnabled: (await getSetting("emailNotificationsEnabled")) !== "false",
    notificationEmail: await getSetting("notificationEmail"),
    coachEmail: await getSetting("coachEmail"),
    replyToEmail: await getSetting("replyToEmail"),
    notificationDelaySeconds: Number.isFinite(delaySeconds)
      ? Math.max(30, Math.min(3600, delaySeconds))
      : 30,
    sendClientEmail: (await getSetting("sendClientEmail")) !== "false",
    sendCoachEmail: (await getSetting("sendCoachEmail")) !== "false",
    sendAdminEmail: (await getSetting("sendAdminEmail")) !== "false",
    clientEmailSubject:
      (await getSetting("clientEmailSubject")) ||
      defaultEmailTemplates.clientEmailSubject,
    clientEmailIntro:
      (await getSetting("clientEmailIntro")) ||
      defaultEmailTemplates.clientEmailIntro,
    clientEmailFooter: modernClientEmailFooter(
      (await getSetting("clientEmailFooter")) ||
        defaultEmailTemplates.clientEmailFooter,
    ),
    adminEmailSubject:
      (await getSetting("adminEmailSubject")) ||
      defaultEmailTemplates.adminEmailSubject,
    adminEmailIntro:
      (await getSetting("adminEmailIntro")) ||
      defaultEmailTemplates.adminEmailIntro,
    smsProviderName: await getSetting("smsProviderName"),
    smsWebhookUrl: await getSetting("smsWebhookUrl"),
    smsFromNumber: await getSetting("smsFromNumber"),
    sendClientSms: (await getSetting("sendClientSms")) === "true",
    sendAdminSms: (await getSetting("sendAdminSms")) === "true",
  };
}

async function writeAdminSettings(settings) {
  if (hasOwn(settings, "emailNotificationsEnabled")) await setSetting("emailNotificationsEnabled", settings?.emailNotificationsEnabled ? "true" : "false");
  if (hasOwn(settings, "notificationEmail")) await setSetting("notificationEmail", cleanString(settings?.notificationEmail, "", 180));
  if (hasOwn(settings, "coachEmail")) await setSetting("coachEmail", cleanString(settings?.coachEmail, "", 180));
  if (hasOwn(settings, "replyToEmail")) await setSetting("replyToEmail", cleanString(settings?.replyToEmail, "", 180));
  if (hasOwn(settings, "notificationDelaySeconds")) {
    const delaySeconds = Number(settings?.notificationDelaySeconds ?? 30);
    await setSetting("notificationDelaySeconds", String(Number.isFinite(delaySeconds) ? Math.max(30, Math.min(3600, delaySeconds)) : 30));
  }
  if (hasOwn(settings, "sendClientEmail")) await setSetting("sendClientEmail", settings?.sendClientEmail ? "true" : "false");
  if (hasOwn(settings, "sendCoachEmail")) await setSetting("sendCoachEmail", settings?.sendCoachEmail ? "true" : "false");
  if (hasOwn(settings, "sendAdminEmail")) await setSetting("sendAdminEmail", settings?.sendAdminEmail ? "true" : "false");
  if (hasOwn(settings, "clientEmailSubject")) await setSetting("clientEmailSubject", cleanString(settings?.clientEmailSubject, defaultEmailTemplates.clientEmailSubject, 180));
  if (hasOwn(settings, "clientEmailIntro")) await setSetting("clientEmailIntro", cleanString(settings?.clientEmailIntro, defaultEmailTemplates.clientEmailIntro, 900));
  if (hasOwn(settings, "clientEmailFooter")) await setSetting("clientEmailFooter", modernClientEmailFooter(settings?.clientEmailFooter));
  if (hasOwn(settings, "adminEmailSubject")) await setSetting("adminEmailSubject", cleanString(settings?.adminEmailSubject, defaultEmailTemplates.adminEmailSubject, 180));
  if (hasOwn(settings, "adminEmailIntro")) await setSetting("adminEmailIntro", cleanString(settings?.adminEmailIntro, defaultEmailTemplates.adminEmailIntro, 900));
  if (hasOwn(settings, "smsProviderName")) await setSetting("smsProviderName", cleanString(settings?.smsProviderName, "", 80));
  if (hasOwn(settings, "smsWebhookUrl")) await setSetting("smsWebhookUrl", cleanString(settings?.smsWebhookUrl, "", 600));
  if (hasOwn(settings, "smsFromNumber")) await setSetting("smsFromNumber", cleanString(settings?.smsFromNumber, "", 80));
  if (hasOwn(settings, "sendClientSms")) await setSetting("sendClientSms", settings?.sendClientSms ? "true" : "false");
  if (hasOwn(settings, "sendAdminSms")) await setSetting("sendAdminSms", settings?.sendAdminSms ? "true" : "false");
  await setSetting("updatedAt", nowIso());
  return readAdminSettings();
}

async function readServices() {
  await ensureSeeded();
  try {
    return normalizeServices(
      JSON.parse((await getSetting("servicesJson")) || "[]"),
    );
  } catch {
    return normalizeServices(defaultServices);
  }
}

async function writeServices(services, context = null) {
  const clean = normalizeServices(services).map((service) =>
    context ? { ...service, accountId: context.accountId } : service,
  );
  const account = context?.account || await readDefaultWorkspaceAccount();
  assertAccountFeature(account, "services");
  const activeServices = clean.filter((service) => service.accountId === account.id && service.archived !== true).length;
  assertAccountLimit(account, activeServices, "maxServices");
  await setSetting("servicesJson", JSON.stringify(clean));
  await setSetting("updatedAt", nowIso());
  return clean;
}

async function readWorkspaceAccounts() {
  await ensureSeeded();
  const account = await readCoachAccount();
  try {
    return normalizeWorkspaceAccounts(
      JSON.parse((await getSetting("workspaceAccountsJson")) || "[]"),
      account,
    );
  } catch {
    return normalizeWorkspaceAccounts([], account);
  }
}

async function writeWorkspaceAccounts(accounts) {
  const account = await readCoachAccount();
  const clean = normalizeWorkspaceAccounts(accounts, account);
  await setSetting("workspaceAccountsJson", JSON.stringify(clean));
  await setSetting("updatedAt", nowIso());
  return clean;
}

async function readDefaultWorkspaceAccount() {
  const accounts = await readWorkspaceAccounts();
  const id = defaultAccountId(accounts);
  return accounts.find((account) => account.id === id) || accounts[0] || defaultWorkspaceAccountFromCoachAccount();
}

async function readCoachProfiles() {
  await ensureSeeded();
  const account = await readCoachAccount();
  try {
    return normalizeCoachProfiles(
      JSON.parse((await getSetting("coachProfilesJson")) || "[]"),
      account,
    );
  } catch {
    return normalizeCoachProfiles([], account);
  }
}

async function writeCoachProfiles(coaches, context = null) {
  const account = await readCoachAccount();
  const workspaceAccount = context?.account || await readDefaultWorkspaceAccount();
  const clean = normalizeCoachProfiles(coaches, account).map((coach) => ({
    ...coach,
    accountId: workspaceAccount.id,
  }));
  const activeCoaches = clean.filter((coach) => coach.accountId === workspaceAccount.id && coach.active && coach.archived !== true).length;
  if (activeCoaches > 1) assertAccountFeature(workspaceAccount, "multiCoach");
  assertAccountLimit(workspaceAccount, activeCoaches, "maxCoaches");
  await setSetting("coachProfilesJson", JSON.stringify(clean));
  await setSetting("updatedAt", nowIso());
  return clean;
}

async function readAppUsers() {
  await ensureSeeded();
  const account = await readCoachAccount();
  try {
    const users = JSON.parse((await getSetting("appUsersJson")) || "[]");
    return Array.isArray(users) && users.length ? users : [defaultAppUserFromAccount(account)];
  } catch {
    return [defaultAppUserFromAccount(account)];
  }
}

async function readLocations() {
  await ensureSeeded();
  const account = await readCoachAccount();
  try {
    return normalizeLocations(
      JSON.parse((await getSetting("locationsJson")) || "[]"),
      account,
    );
  } catch {
    return normalizeLocations([], account);
  }
}

async function writeLocations(locations, context = null) {
  const account = await readCoachAccount();
  const workspaceAccount = context?.account || await readDefaultWorkspaceAccount();
  const clean = normalizeLocations(locations, account).map((location) => ({
    ...location,
    accountId: workspaceAccount.id,
  }));
  const activeLocations = clean.filter((location) => location.accountId === workspaceAccount.id && location.active && location.archived !== true).length;
  if (activeLocations > 1) assertAccountFeature(workspaceAccount, "multiLocation");
  assertAccountLimit(workspaceAccount, activeLocations, "maxLocations");
  await setSetting("locationsJson", JSON.stringify(clean));
  await setSetting("updatedAt", nowIso());
  return clean;
}

async function readAvailability() {
  await ensureSeeded();
  try {
    return normalizeAvailability(
      JSON.parse((await getSetting("availabilityJson")) || "[]"),
    );
  } catch {
    return normalizeAvailability(defaultAvailability);
  }
}

async function writeAvailability(availability, context = null) {
  const clean = normalizeAvailability(availability).map((dayWindows) =>
    dayWindows.map((window) => ({
      ...window,
      ...(context ? { accountId: context.accountId } : {}),
    })),
  );
  await setSetting("availabilityJson", JSON.stringify(clean));
  await setSetting("updatedAt", nowIso());
  return clean;
}

async function readCoachAccount() {
  await ensureSeeded();
  const defaults = defaultCoachAccount();
  return cleanCoachAccount({
    id: (await getSetting("accountId")) || defaults.id,
    coachName: (await getSetting("accountCoachName")) || defaults.coachName,
    businessName:
      (await getSetting("accountBusinessName")) ||
      (await getSetting("coachName")) ||
      defaults.businessName,
    venueName: (await getSetting("accountVenueName")) || defaults.venueName,
    venueShortName:
      (await getSetting("accountVenueShortName")) || defaults.venueShortName,
    timezone: (await getSetting("accountTimezone")) || defaults.timezone,
    contactEmail:
      (await getSetting("accountContactEmail")) || defaults.contactEmail,
    bookingUrl: (await getSetting("accountBookingUrl")) || defaults.bookingUrl,
    calendarSlug:
      (await getSetting("accountCalendarSlug")) || defaults.calendarSlug,
    caddyWorkspaceUrl:
      (await getSetting("accountCaddyWorkspaceUrl")) ||
      defaults.caddyWorkspaceUrl,
    invoiceSettings: safeJsonParse(
      (await getSetting("accountInvoiceSettingsJson")) || "",
      defaults.invoiceSettings,
    ),
  });
}

async function writeCoachAccount(account) {
  const clean = cleanCoachAccount(account);
  await setSetting("accountId", clean.id);
  await setSetting("accountCoachName", clean.coachName);
  await setSetting("accountBusinessName", clean.businessName);
  await setSetting("accountVenueName", clean.venueName);
  await setSetting("accountVenueShortName", clean.venueShortName);
  await setSetting("accountTimezone", clean.timezone);
  await setSetting("accountContactEmail", clean.contactEmail);
  await setSetting("accountBookingUrl", clean.bookingUrl);
  await setSetting("accountCalendarSlug", clean.calendarSlug);
  await setSetting("accountCaddyWorkspaceUrl", clean.caddyWorkspaceUrl);
  await setSetting(
    "accountInvoiceSettingsJson",
    JSON.stringify(clean.invoiceSettings),
  );
  await setSetting("coachName", clean.businessName);
  await setSetting("updatedAt", nowIso());
  return clean;
}

async function readBrandSettings() {
  await ensureSeeded();
  const account = await readCoachAccount();
  return {
    coachName: (await getSetting("coachName")) || account.businessName,
    logoName: await getSetting("brandLogoName"),
    logoPreview: await getSetting("brandLogoPreview"),
    showLogo: (await getSetting("brandShowLogo")) === "true",
    neutral: (await getSetting("brandNeutral")) || "#ffffff",
    primary: (await getSetting("brandPrimary")) || "#1fd36d",
    secondary: (await getSetting("brandSecondary")) || "#d7b06b",
    accent: (await getSetting("brandAccent")) || "#07100a",
    bookingTheme:
      (await getSetting("brandBookingTheme")) === "light" ? "light" : "dark",
  };
}

async function writeBrandSettings(settings) {
  const account = await readCoachAccount();
  await setSetting(
    "coachName",
    cleanString(settings?.coachName, account.businessName, 80),
  );
  await setSetting("brandLogoName", cleanString(settings?.logoName, "", 120));
  await setSetting("brandLogoPreview", cleanLogoPreview(settings?.logoPreview));
  await setSetting("brandShowLogo", settings?.showLogo === true ? "true" : "false");
  await setSetting("brandNeutral", cleanHexColor(settings?.neutral, "#ffffff"));
  await setSetting("brandPrimary", cleanHexColor(settings?.primary, "#1fd36d"));
  await setSetting(
    "brandSecondary",
    cleanHexColor(settings?.secondary, "#d7b06b"),
  );
  await setSetting("brandAccent", cleanHexColor(settings?.accent, "#07100a"));
  await setSetting(
    "brandBookingTheme",
    settings?.bookingTheme === "light" ? "light" : "dark",
  );
  await setSetting("updatedAt", nowIso());
  return readBrandSettings();
}

async function readCalendarState() {
  const { settings: settingsMap, syncKey, updatedAt } = await readStateSettingsSnapshot();
  const account = coachAccountFromSettings(settingsMap);
  const peopleAccountId = peopleAccountIdFromSettings(settingsMap, account);
  const [items, people, notifications, googleCalendar] = await Promise.all([
    readItems(),
    readPeople(peopleAccountId),
    readNotificationHistory(),
    getGoogleCalendarSyncStatus(),
  ]);
  return {
    syncKey,
    updatedAt,
    items,
    services: servicesFromSettings(settingsMap),
    workspaceAccounts: workspaceAccountsFromSettings(settingsMap, account),
    coaches: coachProfilesFromSettings(settingsMap, account),
    currentUser: appUsersFromSettings(settingsMap, account)[0],
    locations: locationsFromSettings(settingsMap, account),
    availability: availabilityFromSettings(settingsMap),
    people,
    notifications,
    settings: adminSettingsFromSettings(settingsMap),
    brand: brandSettingsFromSettings(settingsMap, account),
    account,
    googleCalendar,
  };
}

async function readAdminCalendarShellState() {
  const startedAt = Date.now();
  console.info("CALENDAR_SHELL_STATE_LOAD_STARTED", {
    route: "/api/calendar-state",
    routeUsed: "shell",
  });

  const { settings: settingsMap, syncKey, updatedAt } = await readStateSettingsSnapshot();
  const account = coachAccountFromSettings(settingsMap);
  const items = await readItems();
  const shellLoadDurationMs = Date.now() - startedAt;
  const deferred = {
    people: true,
    notifications: true,
    googleSyncStatus: true,
  };

  console.info("PEOPLE_LOAD_DEFERRED", {
    route: "/api/calendar-state",
    routeUsed: "shell",
  });
  console.info("NOTIFICATION_HISTORY_DEFERRED", {
    route: "/api/calendar-state",
    routeUsed: "shell",
  });
  console.info("GOOGLE_SYNC_STATUS_DEFERRED", {
    route: "/api/calendar-state",
    routeUsed: "shell",
  });
  console.info("NON_CRITICAL_DATA_DEFERRED", {
    route: "/api/calendar-state",
    routeUsed: "shell",
    peopleDeferred: deferred.people,
    notificationsDeferred: deferred.notifications,
    googleSyncStatusDeferred: deferred.googleSyncStatus,
  });
  console.info("CALENDAR_SHELL_STATE_LOAD_COMPLETED", {
    route: "/api/calendar-state",
    routeUsed: "shell",
    shellLoadDurationMs,
    itemCount: items.length,
    peopleDeferred: deferred.people,
    notificationsDeferred: deferred.notifications,
    googleSyncStatusDeferred: deferred.googleSyncStatus,
  });

  return {
    syncKey,
    updatedAt,
    items,
    services: servicesFromSettings(settingsMap),
    workspaceAccounts: workspaceAccountsFromSettings(settingsMap, account),
    coaches: coachProfilesFromSettings(settingsMap, account),
    currentUser: appUsersFromSettings(settingsMap, account)[0],
    locations: locationsFromSettings(settingsMap, account),
    availability: availabilityFromSettings(settingsMap),
    people: [],
    notifications: [],
    settings: adminSettingsFromSettings(settingsMap),
    brand: brandSettingsFromSettings(settingsMap, account),
    account,
    googleCalendar: {
      configured: false,
      connected: false,
      calendarId: "primary",
      autoSync: false,
      manualOnly: true,
      accountEmail: "",
      lastSyncAt: "",
      lastSyncStatus: "",
      lastSyncError: "",
      connectedAt: "",
      redirectUri: "",
      scope: "",
      ok: true,
      skipped: true,
    },
    diagnostics: {
      calendarState: {
        routeUsed: "shell",
        shellLoadDurationMs,
        itemCount: items.length,
        peopleDeferred: deferred.people,
        notificationsDeferred: deferred.notifications,
        googleSyncStatusDeferred: deferred.googleSyncStatus,
      },
    },
  };
}

async function readColdSetupState() {
  const { settings: settingsMap } = await readStateSettingsSnapshot();
  const account = coachAccountFromSettings(settingsMap);
  return {
    workspaceAccounts: workspaceAccountsFromSettings(settingsMap, account),
    coaches: coachProfilesFromSettings(settingsMap, account),
    currentUser: appUsersFromSettings(settingsMap, account)[0],
    locations: locationsFromSettings(settingsMap, account),
    account,
  };
}

async function readPublicCalendarState() {
  const { settings: settingsMap, syncKey, updatedAt } = await readStateSettingsSnapshot();
  const account = coachAccountFromSettings(settingsMap);
  return {
    syncKey,
    updatedAt,
    items: await readItems(),
    services: servicesFromSettings(settingsMap),
    workspaceAccounts: workspaceAccountsFromSettings(settingsMap, account),
    coaches: coachProfilesFromSettings(settingsMap, account),
    locations: locationsFromSettings(settingsMap, account),
    availability: availabilityFromSettings(settingsMap),
    brand: brandSettingsFromSettings(settingsMap, account),
    account,
  };
}

export async function readPublicSlotContext({ serviceId, week } = {}, options = {}) {
  const metrics = options.metrics || null;
  const safeWeek = publicBookingSlotsWeek(week);
  const settingsStartedAt = Date.now();
  const snapshot = options.settingsSnapshot || await readStateSettingsSnapshot();
  const settingsMap = snapshot.settings || {};
  const syncKey = snapshot.syncKey || settingValue(settingsMap, "syncKey") || "";
  const updatedAt = snapshot.updatedAt || settingValue(settingsMap, "updatedAt") || nowIso();
  const account = coachAccountFromSettings(settingsMap);
  const state = {
    syncKey,
    updatedAt,
    items: [],
    services: servicesFromSettings(settingsMap),
    workspaceAccounts: workspaceAccountsFromSettings(settingsMap, account),
    coaches: coachProfilesFromSettings(settingsMap, account),
    locations: locationsFromSettings(settingsMap, account),
    availability: availabilityFromSettings(settingsMap),
    brand: brandSettingsFromSettings(settingsMap, account),
    account,
  };
  if (metrics) metrics.settingsReadMs = Date.now() - settingsStartedAt;

  const { workspaceAccount, state: accountState } = publicAccountState(state);
  const cleanServiceId = cleanString(serviceId, "", 140);
  if (!cleanServiceId) {
    throw publicBookingSlotsRequestError("Choose a public lesson type.", 400, "service_required");
  }
  const targetService = publicBookableServices(accountState.services).find((service) => service.id === cleanServiceId);
  if (!targetService) {
    throw publicBookingSlotsRequestError("Choose a public lesson type.", 404);
  }

  const itemsStartedAt = Date.now();
  const readItemsForWeek = options.readItemsForWeek || readPublicSlotItemsForWeek;
  const itemRead = await readItemsForWeek({
    accountId: workspaceAccount.id,
    serviceId: targetService.id,
    week: safeWeek,
  });
  const rawItems = Array.isArray(itemRead) ? itemRead : itemRead?.items || [];
  const rowsFetched = Number.isFinite(Number(itemRead?.rowsFetched)) ? Number(itemRead.rowsFetched) : rawItems.length;
  const accountItems = rawItems.filter((item) => recordBelongsToAccount(item, workspaceAccount.id));
  const requestedWeekItems = publicSlotRequestedWeekItems(accountItems, safeWeek);
  const relevantResourceItems = publicSlotRelevantResourceItems(requestedWeekItems, targetService, accountState);

  if (metrics) {
    metrics.itemsReadMs = Date.now() - itemsStartedAt;
    metrics.rowsFetched = rowsFetched;
    metrics.requestedWeekItemCount = requestedWeekItems.length;
    metrics.relevantResourceItemCount = relevantResourceItems.length;
    metrics.queryMode = itemRead?.queryMode || "injected";
    metrics.usedLegacySchemaFallback = itemRead?.usedLegacySchemaFallback === true;
  }

  return {
    ...state,
    items: relevantResourceItems,
    workspaceAccount,
    service: targetService,
    publicSlotRead: {
      week: safeWeek,
      rowsFetched,
      requestedWeekItemCount: requestedWeekItems.length,
      relevantResourceItemCount: relevantResourceItems.length,
      query: itemRead?.query || "",
      attemptedQuery: itemRead?.attemptedQuery || "",
      queryMode: itemRead?.queryMode || "injected",
      usedLegacySchemaFallback: itemRead?.usedLegacySchemaFallback === true,
    },
  };
}

async function readPublicCatalogState() {
  const { settings: settingsMap, syncKey, updatedAt } = await readStateSettingsSnapshot();
  const account = coachAccountFromSettings(settingsMap);
  return {
    syncKey,
    updatedAt,
    services: servicesFromSettings(settingsMap),
    workspaceAccounts: workspaceAccountsFromSettings(settingsMap, account),
    coaches: coachProfilesFromSettings(settingsMap, account),
    locations: locationsFromSettings(settingsMap, account),
    availability: availabilityFromSettings(settingsMap),
    brand: brandSettingsFromSettings(settingsMap, account),
    account,
  };
}

async function readFastPublicCalendarState() {
  const { settings: settingsMap, syncKey, updatedAt } = await readStateSettingsSnapshot();
  const account = coachAccountFromSettings(settingsMap);
  return {
    syncKey,
    updatedAt,
    items: await readItems(),
    services: servicesFromSettings(settingsMap),
    workspaceAccounts: workspaceAccountsFromSettings(settingsMap, account),
    coaches: coachProfilesFromSettings(settingsMap, account),
    locations: locationsFromSettings(settingsMap, account),
    availability: availabilityFromSettings(settingsMap),
    brand: brandSettingsFromSettings(settingsMap, account),
    account,
  };
}

async function runPublicDiagnostics() {
  const diagnostics = {};
  const checks = {
    updatedAt: async () => (await getSetting("updatedAt")) || nowIso(),
    syncKey: async () => (await getSetting("syncKey")) || "",
    items: async () => await readItems(),
    services: async () => await readServices(),
    availability: async () => await readAvailability(),
    brand: async () => await readBrandSettings(),
    account: async () => await readCoachAccount(),
  };

  for (const [key, check] of Object.entries(checks)) {
    try {
      const value = await check();
      diagnostics[key] = {
        ok: true,
        summary: Array.isArray(value)
          ? `${value.length} records`
          : typeof value,
      };
    } catch (error) {
      diagnostics[key] = {
        ok: false,
        message:
          error instanceof Error ? error.message : "Unknown diagnostics error",
      };
    }
  }

  return diagnostics;
}

async function runPublicSerializationDiagnostics() {
  const state = await readPublicCalendarState();
  const payload = publicBookingState(state);
  const diagnostics = {};

  for (const [key, value] of Object.entries(payload)) {
    try {
      const serialized = JSON.stringify(value);
      diagnostics[key] = {
        ok: true,
        bytes: serialized?.length ?? 0,
      };
    } catch (error) {
      diagnostics[key] = {
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : "Unknown serialization error",
      };
    }
  }

  try {
    const ics = generateCalendarFeed(state);
    diagnostics.calendarFeed = {
      ok: true,
      bytes: ics.length,
    };
  } catch (error) {
    diagnostics.calendarFeed = {
      ok: false,
      message:
        error instanceof Error ? error.message : "Unknown calendar feed error",
    };
  }

  return diagnostics;
}

async function runDatabaseHealth() {
  const checks = {};
  async function check(name, fn) {
    const startedAt = Date.now();
    try {
      const result = await fn();
      checks[name] = {
        ok: true,
        ms: Date.now() - startedAt,
        summary:
          typeof result === "number"
            ? `${result} records`
            : typeof result === "string"
              ? result
              : Array.isArray(result)
                ? `${result.length} records`
                : "ok",
      };
    } catch (error) {
      checks[name] = {
        ok: false,
        ms: Date.now() - startedAt,
        message:
          error instanceof Error
            ? error.message
            : "Unknown database health error",
        name: error instanceof Error ? error.name : "UnknownError",
      };
    }
  }

  await check("getDatabase", async () => {
    db();
    return "database handle created";
  });
  await check("coreTables", async () => {
    await ensureCoreTables();
    return "core tables ready";
  });
  await check("settingsSeed", async () => {
    await seedSettings();
    return "settings seed ready";
  });
  await check("notificationTables", async () => {
    await ensureNotificationHistoryTable();
    return "notification tables ready";
  });
  await check("itemsRead", async () => (await readItems()).length);
  await check("servicesRead", async () => (await readServices()).length);
  await check(
    "availabilityRead",
    async () => (await readAvailability()).flat().length,
  );
  await check("peopleRead", async () => (await readPeople()).length);
  await check(
    "notificationsRead",
    async () => (await readNotificationHistory()).length,
  );
  await check("adminSeed", async () => {
    await ensureAdminUser();
    return "admin seed checked";
  });
  await check("calendarStateRead", async () => {
    const state = await readCalendarState();
    return `${state.items.length} items, ${state.people.length} people`;
  });

  const failed = Object.entries(checks)
    .filter(([, value]) => !value.ok)
    .map(([name, value]) => ({ name, ...value }));
  return {
    ok: failed.length === 0,
    failed,
    checks,
    timestamp: nowIso(),
  };
}

export async function handleCalendarFeedRequest(req: Request) {
  try {
    const state = await readPublicCalendarState();
    const key = new URL(req.url).searchParams.get("key");
    if (key !== state.syncKey) return text("Invalid calendar sync key.", 401);
    const workspaceAccount = publicWorkspaceAccount(state);
    assertAccountFeature(workspaceAccount, "coachCalendar");
    const scopedState = {
      ...state,
      items: (state.items || []).filter((item) => recordBelongsToAccount(item, workspaceAccount.id)),
      services: (state.services || []).filter((service) => recordBelongsToAccount(service, workspaceAccount.id)),
      coaches: (state.coaches || []).filter((coach) => recordBelongsToAccount(coach, workspaceAccount.id)),
      locations: (state.locations || []).filter((location) => recordBelongsToAccount(location, workspaceAccount.id)),
      availability: (state.availability || []).map((day) => day.filter((window) => recordBelongsToAccount(window, workspaceAccount.id))),
    };
    return text(
      generateCalendarFeed(scopedState),
      200,
      "text/calendar; charset=utf-8",
    );
  } catch (error) {
    console.error("calendar_feed_error", error);
    throw error;
  }
}

export async function handlePublicBookingStateRequest() {
  try {
    return json(publicBookingState(await readPublicCalendarState()));
  } catch (error) {
    console.error("public_booking_state_error", error);
    throw error;
  }
}

export async function handlePublicBookingCatalogRequest() {
  try {
    return json(publicBookingCatalog(await readPublicCatalogState()));
  } catch (error) {
    console.error("public_booking_catalog_error", error);
    throw error;
  }
}

async function writeCalendarState(nextState, context = null) {
  const current = await readCalendarState();
  if (context) {
    assertAccountFeature(context.account, "coachCalendar");
  }
  const expectedUpdatedAt = cleanString(
    nextState?.updatedAt || nextState?.previousUpdatedAt,
    "",
    120,
  );
  if (
    expectedUpdatedAt &&
    current.updatedAt &&
    expectedUpdatedAt !== current.updatedAt
  ) {
    throw Object.assign(
      new Error(
        "Calendar changed elsewhere. Reload before saving so you do not overwrite live bookings.",
      ),
      {
        status: 409,
        expectedUpdatedAt,
        backendUpdatedAt: current.updatedAt,
        conflictSource: "calendar_updated_at_mismatch",
      },
    );
  }
  const syncKey = cleanString(nextState?.syncKey, current.syncKey, 140);
  if (context && nextState?.clearItems === true && !context.isAdmin) {
    throw permissionDenied("You do not have permission to clear the account calendar.");
  }
  let requestedItems = nextState?.items ?? current.items;
  if (context) {
    requestedItems = normalizeCalendarItemsForContext(requestedItems, context);
    const previousById = new Map((current.items || []).map((item) => [item.id, item]));
    requestedItems.forEach((item) => assertCanWriteCalendarItem(context, item, previousById.get(item.id), current));
    if (!context.isAdmin && (nextState?.replaceItems === true || nextState?.itemsOperation === "replace")) {
      const preservedItems = current.items.filter((item) => !canReadCalendarItem(context, item, current));
      requestedItems = [...preservedItems, ...requestedItems];
    }
  }
  const items = await writeItems(requestedItems, {
    replaceItems: nextState?.replaceItems === true || nextState?.itemsOperation === "replace",
    clearItems: nextState?.clearItems === true,
    accountId: context?.accountId,
  });
  const updatedAt = nowIso();
  await setSetting("syncKey", syncKey);
  await setSetting("updatedAt", updatedAt);
  const peopleAccountId = context?.accountId || defaultAccountId(current.workspaceAccounts);
  await importPeople(items.map(personFromAppointment).filter(Boolean), "appointment", peopleAccountId);
  let googleCalendarSync = null;
  try {
    googleCalendarSync = await syncGoogleCalendarIfEnabled();
  } catch (error) {
    googleCalendarSync = {
      ...(await getGoogleCalendarSyncStatus()),
      ok: false,
      skipped: false,
      error: error instanceof Error ? error.message : "Google Calendar sync failed.",
    };
  }
  return {
    syncKey,
    items: context ? items.filter((item) => canReadCalendarItem(context, item, { ...current, items })) : items,
    updatedAt,
    services: current.services,
    workspaceAccounts: current.workspaceAccounts,
    currentUser: current.currentUser,
    coaches: current.coaches,
    locations: current.locations,
    availability: current.availability,
    people: await readPeople(peopleAccountId),
    notifications: await readNotificationHistory(),
    settings: await readAdminSettings(),
    brand: await readBrandSettings(),
    account: await readCoachAccount(),
    googleCalendar: await getGoogleCalendarSyncStatus(),
    googleCalendarSync,
  };
}

function deleteErrorIsPeoplePatch(error) {
  const code = cleanString(error?.code, "", 120);
  const message = error instanceof Error ? error.message : String(error?.message || error || "");
  return (
    code === "DUPLICATE_PERSON_EMAIL" ||
    /patch people|update people|people.*duplicate|idx_people_email_unique/i.test(message)
  );
}

function deleteErrorOperationOwner(error) {
  const explicitOwner = cleanString(error?.operationOwner, "", 120);
  if (explicitOwner) return explicitOwner;
  if (deleteErrorIsPeoplePatch(error)) return "people_patch";
  const code = cleanString(error?.code, "", 120);
  if (code === "BOOKING_DELETE_VERIFY_FAILED") return "calendar_reload_verify";
  if (code === "BOOKING_DELETE_RELOAD_FAILED") return "calendar_reload";
  if (code === "BOOKING_DELETE_INVALID_ID" || code === "BOOKING_DELETE_NOT_FOUND") return "calendar_delete_request";
  return "calendar_delete";
}

function deleteErrorCode(error, operationOwner) {
  if (operationOwner === "people_patch") return "BOOKING_DELETE_OWNERSHIP_VIOLATION";
  const code = cleanString(error?.code, "", 120);
  if (code) return code;
  if (operationOwner === "calendar_reload") return "BOOKING_DELETE_RELOAD_FAILED";
  return "BOOKING_DELETE_FAILED";
}

function deleteUserMessage(operationOwner, code) {
  if (operationOwner === "people_patch") {
    return "Booking delete triggered an unexpected people save. The calendar result was not trusted.";
  }
  if (code === "BOOKING_DELETE_VERIFY_FAILED") {
    return "The booking delete could not be verified because the backend still returned the deleted booking.";
  }
  if (operationOwner === "calendar_reload") {
    return "The booking delete reached storage, but calendar state could not be reloaded for verification.";
  }
  return "The booking could not be deleted. The calendar was not changed.";
}

function deleteFailureDiagnostics(error, baseDetails, durationMs) {
  const operationOwner = deleteErrorOperationOwner(error);
  const code = deleteErrorCode(error, operationOwner);
  const status = Number.isFinite(Number(error?.status)) ? Number(error.status) : 500;
  const backendMessage = error instanceof Error ? error.message : String(error?.message || error || "Calendar delete failed.");
  const details = error?.details && typeof error.details === "object" ? error.details : {};
  const route = cleanString(error?.route, "", 120) || baseDetails.route;
  return {
    ...baseDetails,
    ...details,
    route,
    operationOwner,
    httpStatus: status,
    durationMs,
    errorCode: code,
    backendMessage,
    personId: cleanString(error?.personId || details.personId || baseDetails.personId, "", 120),
    email: normalizedPersonEmail(error?.email || details.email || baseDetails.email),
  };
}

async function deleteCalendarItemById(id, context = null) {
  const cleanId = cleanString(id, "", 140);
  if (!cleanId) {
    throw Object.assign(new Error("Calendar item id is required for delete."), {
      status: 400,
      code: "BOOKING_DELETE_INVALID_ID",
      operationOwner: "calendar_delete_request",
      route: "DELETE /api/calendar-state",
    });
  }
  const current = await readCalendarState();
  if (context) assertAccountFeature(context.account, "coachCalendar");
  const existingItem = current.items.find((item) => item.id === cleanId);
  if (context) {
    if (!existingItem) {
      throw Object.assign(new Error("Booking was not found in this workspace."), {
        status: 404,
        code: "BOOKING_DELETE_NOT_FOUND",
        operationOwner: "calendar_delete_request",
        route: "DELETE /api/calendar-state",
      });
    }
    assertCanWriteCalendarItem(context, existingItem, existingItem, current);
  }

  const client = await db().pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM calendar_items WHERE id = $1", [cleanId]);
    const verifyRows = queryRows(
      await client.query("SELECT id FROM calendar_items WHERE id = $1 LIMIT 1", [cleanId]),
    );
    if (verifyRows.length) {
      throw Object.assign(new Error("Deleted calendar item is still present after delete."), {
        status: 409,
        code: "BOOKING_DELETE_VERIFY_FAILED",
        operationOwner: "calendar_delete_verify",
        route: "DELETE /api/calendar-state",
      });
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const updatedAt = nowIso();
  await setSetting("updatedAt", updatedAt);
  let googleCalendarSync = null;
  try {
    googleCalendarSync = await syncGoogleCalendarIfEnabled();
  } catch (error) {
    googleCalendarSync = {
      ...(await getGoogleCalendarSyncStatus()),
      ok: false,
      skipped: false,
      error: error instanceof Error ? error.message : "Google Calendar sync failed.",
    };
  }
  let nextState = null;
  try {
    nextState = await readCalendarState();
  } catch (error) {
    throw Object.assign(
      new Error(
        `Calendar delete persisted, but verification reload failed: ${
          error instanceof Error ? error.message : String(error || "unknown reload error")
        }`,
      ),
      {
        status: 502,
        code: "BOOKING_DELETE_RELOAD_FAILED",
        operationOwner: "calendar_reload",
        route: "GET /api/calendar-state",
      },
    );
  }
  return {
    ...nextState,
    items: context ? nextState.items.filter((item) => canReadCalendarItem(context, item, nextState)) : nextState.items,
    updatedAt,
    googleCalendarSync,
  };
}

async function writePublicBookingState(currentState, items) {
  const cleanItems = await writeItems(items);
  const updatedAt = nowIso();
  await setSetting("updatedAt", updatedAt);
  const peopleAccountId = cleanItems.find((item) => item.accountId)?.accountId || defaultAccountId(currentState.workspaceAccounts || []);
  await importPeople(cleanItems.map(personFromAppointment).filter(Boolean), "appointment", peopleAccountId);
  await syncGoogleCalendarIfEnabled().catch((error) => console.error("public_booking_state:google_calendar_sync_failed", error));
  return {
    syncKey: currentState.syncKey,
    updatedAt,
    items: cleanItems,
    services: currentState.services,
    availability: currentState.availability,
    brand: currentState.brand,
    account: currentState.account,
  };
}

function schedulePublicBookingSideEffects(context, appointment) {
  const task = (async () => {
    await importPeople([personFromAppointment(appointment)].filter(Boolean), "appointment", appointment?.accountId || defaultWorkspaceAccountFromCoachAccount().id);
    await syncGoogleCalendarIfEnabled().catch((error) =>
      console.error("public_booking:google_calendar_sync_failed", error),
    );
  })().catch((error) => console.error("public_booking:side_effects_failed", appointment?.id, error));

  if (context && typeof context.waitUntil === "function") {
    context.waitUntil(task);
  }
}

async function writePublicBookingAppointment(currentState, appointment, context = null) {
  const cleanItems = await writeItems([appointment]);
  const updatedAt = nowIso();
  await setSetting("updatedAt", updatedAt);
  const savedAppointment = cleanItems.find((item) => item.id === appointment.id) || appointment;
  schedulePublicBookingSideEffects(context, savedAppointment);
  return {
    syncKey: currentState.syncKey,
    updatedAt,
    items: cleanItems,
    services: currentState.services,
    availability: currentState.availability,
    brand: currentState.brand,
    account: currentState.account,
  };
}

function publicCalendarState(state) {
  return {
    syncKey: state.syncKey,
    updatedAt: state.updatedAt,
    items: state.items,
    services: state.services || [],
    workspaceAccounts: state.workspaceAccounts || [],
    currentUser: state.currentUser || null,
    coaches: state.coaches || [],
    locations: state.locations || [],
    availability: state.availability || [],
    people: state.people || [],
    notifications: state.notifications || [],
    settings: state.settings,
    brand: state.brand,
    account: state.account,
    googleCalendar: state.googleCalendar,
    googleCalendarSync: state.googleCalendarSync,
    diagnostics: state.diagnostics,
  };
}

export function publicBookingState(state) {
  const workspaceAccount = publicWorkspaceAccount(state);
  assertAccountFeature(workspaceAccount, "publicBooking");
  const accountServices = (state.services || []).filter((service) => recordBelongsToAccount(service, workspaceAccount.id));
  const accountItems = (state.items || []).filter((item) => recordBelongsToAccount(item, workspaceAccount.id));
  return {
    updatedAt: state.updatedAt,
    services: accountServices.filter(
      (service) =>
        service.active &&
        service.archived !== true &&
        service.visibility === "public" &&
        service.lessonFormat !== "package",
    ),
    coaches: (state.coaches || []).filter((coach) => recordBelongsToAccount(coach, workspaceAccount.id)),
    locations: (state.locations || []).filter((location) => recordBelongsToAccount(location, workspaceAccount.id)),
    availability: (state.availability || []).map((day) => day.filter((window) => recordBelongsToAccount(window, workspaceAccount.id))),
    brand: state.brand,
    account: state.account,
    items: accountItems.map((item) => ({
      id: item.id,
      kind: item.kind,
      week: item.week ?? 0,
      day: item.day,
      start: item.start,
      duration: item.duration,
      coachId: item.coachId || item.coach?.coachId || "",
      locationId: item.locationId || item.location?.locationId || "",
      serviceId: item.serviceId || "",
      status: item.status || "booked",
      location: item.location,
    })),
  };
}

export function publicBookingCatalog(state) {
  const workspaceAccount = publicWorkspaceAccount(state);
  assertAccountFeature(workspaceAccount, "publicBooking");
  const accountServices = (state.services || []).filter((service) => recordBelongsToAccount(service, workspaceAccount.id));
  return {
    updatedAt: state.updatedAt,
    services: accountServices.filter(
      (service) =>
        service.active &&
        service.archived !== true &&
        service.visibility === "public" &&
        service.lessonFormat !== "package",
    ),
    workspaceAccounts: (state.workspaceAccounts || []).filter((account) => recordBelongsToAccount(account, workspaceAccount.id)),
    coaches: (state.coaches || []).filter((coach) => recordBelongsToAccount(coach, workspaceAccount.id)),
    locations: (state.locations || []).filter((location) => recordBelongsToAccount(location, workspaceAccount.id)),
    brand: state.brand,
    account: state.account,
  };
}

function appointmentPositionSignature(item) {
  if (!item) return "";
  return JSON.stringify({
    week: Number(item.week ?? 0),
    day: Number(item.day ?? 0),
    start: Number(item.start ?? 0),
    duration: Number(item.duration ?? 0),
    serviceId: cleanString(item.serviceId || item.service_id, "", 140),
  });
}

function appointmentNotificationSignature(item) {
  if (!item) return "";
  return JSON.stringify({
    position: appointmentPositionSignature(item),
    client: cleanString(item.client || item.title, "", 160),
    title: cleanString(item.title, "", 160),
    phone: cleanString(item.phone, "", 80),
    email: cleanEmail(item.email, ""),
    status: cleanString(item.status, "booked", 40),
    customGroup: item.customGroup === true,
    calculatedPrice: Number(item.calculatedPrice ?? 0),
    attendees: Array.isArray(item.attendees)
      ? item.attendees.map((attendee) => ({
          id: cleanString(attendee?.id, "", 120),
          name: cleanString(attendee?.name, "", 120),
          email: cleanEmail(attendee?.email, ""),
          status: cleanString(attendee?.status, "", 40),
          token: cleanString(attendee?.token, "", 220),
        }))
      : [],
  });
}

function appointmentById(items = []) {
  return new Map(
    items
      .filter((item) => item?.kind === "appointment" && item?.id)
      .map((item) => [String(item.id), item]),
  );
}

function parseTimestamp(value) {
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
  let parts;
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
  const value = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    minutes: value("hour") * 60 + value("minute"),
  };
}

function dateSortValue(parts) {
  return parts.year * 10000 + parts.month * 100 + parts.day;
}

function isAppointmentInPast(item, timeZone = "Pacific/Auckland") {
  if (!item || item.kind !== "appointment") return false;
  const slotDate = slotDateParts(Number(item.week ?? 0), Number(item.day ?? 0));
  const now = nowInTimeZoneParts(timeZone);
  const slotValue = dateSortValue(slotDate);
  const nowValue = dateSortValue(now);
  if (slotValue !== nowValue) return slotValue < nowValue;
  return Number(item.start ?? 0) < now.minutes;
}

function cleanPendingAdminNotification(value) {
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
  try {
    const parsed = JSON.parse((await getSetting(ADMIN_NOTIFICATION_DEBOUNCE_QUEUE_KEY)) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map(cleanPendingAdminNotification).filter(Boolean);
  } catch {
    return [];
  }
}

async function writePendingAdminNotifications(queue) {
  await setSetting(ADMIN_NOTIFICATION_DEBOUNCE_QUEUE_KEY, JSON.stringify(queue));
}

async function processAdminNotificationDebounce(
  previousItems = [],
  nextItems = [],
  options = {},
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
  const results = [];
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

async function verifyAdminPassword(email, password) {
  const startedAt = Date.now();
  let ok = false;
  try {
    const rows = await db().sql`
      SELECT * FROM admin_users
      WHERE email = ${cleanString(email, "", 180)}
    `;
    const row = rows[0];
    if (!row || typeof password !== "string") return null;

    const { passwordHash } = hashPassword(password, row.password_salt);
    const saved = Buffer.from(row.password_hash, "hex");
    const attempt = Buffer.from(passwordHash, "hex");
    if (saved.length !== attempt.length || !timingSafeEqual(saved, attempt))
      return null;

    ok = true;
    return {
      id: row.id,
      email: row.email,
      password_hash: row.password_hash,
      password_salt: row.password_salt,
    };
  } finally {
    logAuthTiming("verifyAdminPassword", startedAt, { ok });
  }
}

async function cleanupExpiredPasswordResets() {
  await db().sql`
    DELETE FROM admin_password_resets
    WHERE expires_at <= NOW()
       OR used_at IS NOT NULL
  `;
}

async function createPasswordReset(email) {
  const cleanedEmail = cleanEmail(email, "");
  if (!cleanedEmail) return null;

  const rows = await db().sql`
    SELECT id, email
    FROM admin_users
    WHERE LOWER(email) = LOWER(${cleanedEmail})
    LIMIT 1
  `;
  const user = rows[0];
  if (!user) return null;

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(
    Date.now() + passwordResetMinutes * 60 * 1000,
  ).toISOString();
  await db().sql`
    INSERT INTO admin_password_resets (id, token_hash, user_id, expires_at, created_at)
    VALUES (${randomUUID()}, ${hashToken(token)}, ${user.id}, ${expiresAt}, NOW())
  `;
  return { token, expiresAt, email: user.email };
}

function passwordResetUrl(req, token) {
  const origin = env("CLARITY_APP_URL", new URL(req.url).origin).replace(
    /\/$/,
    "",
  );
  const url = new URL(origin || new URL(req.url).origin);
  url.searchParams.set("reset", token);
  return url.toString();
}

async function sendEmail({ to, subject, html, text, replyTo, idempotencyKey }) {
  if (emailNotificationsGloballyDisabled()) return { sent: false, reason: "email_notifications_disabled" };

  const apiKey = env("RESEND_API_KEY");
  if (!apiKey) return { sent: false, reason: "missing_resend_key" };

  const account = await readCoachAccount();
  const businessName = account.businessName || "Clarity Golf";
  const from = env(
    "CLARITY_EMAIL_FROM",
    `${businessName} <onboarding@resend.dev>`,
  );
  const body = {
    from,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    text,
    ...(replyTo ? { reply_to: replyTo } : {}),
  };
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const message = await response.text().catch(() => "");
    console.error(
      "Resend email failed",
      response.status,
      message.slice(0, 500),
    );
    return {
      sent: false,
      reason: "resend_failed",
      error: message.slice(0, 500),
    };
  }

  const data = await response.json().catch(() => ({}));
  return { sent: true, id: data?.id || "" };
}

async function sendPasswordResetEmail(reset, req) {
  const account = await readCoachAccount();
  const resetUrl = passwordResetUrl(req, reset.token);
  const businessName = account.businessName || "Clarity Golf";
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111">
      <h2>${escapeHtml(businessName)} password reset</h2>
      <p>Use the button below to reset your Clarity Golf Booking admin password. This link expires in ${passwordResetMinutes} minutes.</p>
      <p><a href="${escapeHtml(resetUrl)}" style="display:inline-block;background:#07100a;color:#fff;padding:12px 16px;text-decoration:none;border-radius:6px">Reset password</a></p>
      <p>If the button does not work, paste this link into your browser:</p>
      <p><a href="${escapeHtml(resetUrl)}">${escapeHtml(resetUrl)}</a></p>
      <p>If you did not request this, you can ignore this email.</p>
    </div>
  `;
  const textBody = [
    `${businessName} password reset`,
    "",
    `Use this link to reset your Clarity Golf Booking admin password. It expires in ${passwordResetMinutes} minutes:`,
    resetUrl,
    "",
    "If you did not request this, you can ignore this email.",
  ].join("\n");

  return sendEmail({
    to: reset.email,
    subject: `${businessName} password reset`,
    html,
    text: textBody,
    idempotencyKey: `password-reset-${hashToken(reset.token).slice(0, 24)}`,
  });
}

function bookingGoogleCalendarUrl({ appointment, service, account, rescheduleUrl }) {
  const week = itemWeek(appointment);
  const location = cleanBookingLocationSnapshot(appointment.location, {
    name: account.venueName,
    shortName: account.venueShortName,
    timezone: account.timezone,
  });
  const start = formatLocalDateTime(week, appointment.day, appointment.start);
  const end = formatLocalDateTime(
    week,
    appointment.day,
    Number(appointment.start || 0) + Number(appointment.duration || 0),
  );
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `${service?.name || "Golf Lesson"} with ${account.coachName || account.businessName}`,
    dates: `${start}/${end}`,
    details: [
      `${service?.name || "Golf Lesson"} for ${appointment.client || appointment.title || "Client"}.`,
      location?.address ? `Address: ${location.address}` : "",
      location?.arrivalInstructions ? `Arrival: ${location.arrivalInstructions}` : "",
      location?.mapUrl ? `Map: ${location.mapUrl}` : "",
      rescheduleUrl ? `Manage or reschedule: ${rescheduleUrl}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    location: bookingLocationDisplay(location),
    ctz: location?.timezone || account.timezone || "Pacific/Auckland",
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function bookingAppleCalendarUrl({ appointment }) {
  const siteUrl =
    env("URL") ||
    env("DEPLOY_PRIME_URL") ||
    env("CLARITY_SITE_URL", "https://claritygolf.app");
  try {
    const url = new URL("/api/public-calendar-invite", siteUrl);
    url.searchParams.set("booking", appointment.id);
    if (appointment.email) url.searchParams.set("email", appointment.email);
    if (appointment.phone) url.searchParams.set("phone", appointment.phone);
    return url.toString();
  } catch {
    return "";
  }
}

function customGroupConfirmUrl(token) {
  const siteUrl =
    env("URL") ||
    env("DEPLOY_PRIME_URL") ||
    env("CLARITY_SITE_URL", "https://claritygolf.app");
  try {
    const url = new URL("/api/custom-group-confirm", siteUrl);
    url.searchParams.set("token", token);
    return url.toString();
  } catch {
    return "";
  }
}

function customGroupInviteEmail({ appointment, attendee, service, account }) {
  const variables = bookingEmailVariables({ appointment, service, account });
  const confirmUrl = customGroupConfirmUrl(attendee.token);
  const title = `${appointment.client || "A golfer"} invited you to ${variables.service}`;
  const intro = `${attendee.name || "Hi"}, you have been invited to join ${appointment.client || "the booker"} for ${variables.service}.`;
  const detailRows = `
    <tr><td style="padding:8px;border-bottom:1px solid #dfe5d8;color:#697166">When</td><td style="padding:8px;border-bottom:1px solid #dfe5d8">${escapeHtml(variables.date)}, ${escapeHtml(variables.time)}</td></tr>
    <tr><td style="padding:8px;border-bottom:1px solid #dfe5d8;color:#697166">Where</td><td style="padding:8px;border-bottom:1px solid #dfe5d8">${escapeHtml(variables.venue)}</td></tr>
    <tr><td style="padding:8px;color:#697166">Group price</td><td style="padding:8px">${escapeHtml(variables.price)}</td></tr>
  `;
  return {
    subject: title,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.55;color:#101612">
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(intro)}</p>
        <table style="border-collapse:collapse;margin:18px 0;width:100%;max-width:520px">${detailRows}</table>
        ${confirmUrl ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 14px"><tr><td><a href="${escapeHtml(confirmUrl)}" style="display:inline-block;background:#07100a;color:#ffffff;padding:12px 18px;text-decoration:none;border-radius:6px;font-weight:700">Confirm attendance</a></td></tr></table>` : ""}
        <p>Confirmation is helpful, but the booking is already in place.</p>
      </div>
    `,
    text: [
      title,
      "",
      intro,
      "",
      `When: ${variables.date}, ${variables.time}`,
      `Where: ${variables.venue}`,
      `Group price: ${variables.price}`,
      confirmUrl ? `Confirm attendance: ${confirmUrl}` : "",
      "",
      "Confirmation is helpful, but the booking is already in place.",
    ].filter(Boolean).join("\n"),
  };
}

function modernClientEmailFooter(value) {
  const footer = cleanString(value, "", 900);
  const legacyChangeFooter =
    /need to (move|change)|reply to this email.*(move|change|reschedul)|email.*(move|change|reschedul)/i.test(
      footer,
    );
  return footer && !legacyChangeFooter
    ? footer
    : "We look forward to seeing you.";
}

function bookingEmailVariables({ appointment, service, account }) {
  const client = appointment.client || appointment.title || "Client";
  const location = cleanBookingLocationSnapshot(appointment.location, {
    name: account.venueName,
    shortName: account.venueShortName,
    timezone: account.timezone,
  });
  const rescheduleUrl = new URL(
    account.bookingUrl || "https://book.claritygolf.app",
  );
  rescheduleUrl.searchParams.set("embed", "booking");
  rescheduleUrl.searchParams.set("mode", "reschedule");
  if (appointment.id) rescheduleUrl.searchParams.set("booking", appointment.id);
  if (appointment.email)
    rescheduleUrl.searchParams.set("email", appointment.email);
  if (appointment.phone)
    rescheduleUrl.searchParams.set("phone", appointment.phone);
  return {
    client,
    firstName: client.split(/\s+/)[0] || client,
    coach: account.coachName || account.businessName,
    service: service?.name || "Golf Lesson",
    date: formatBookingDate(itemWeek(appointment), appointment.day),
    time: formatRange(appointment.start, appointment.duration),
    venue: location?.name || account.venueName,
    location: location?.name || account.venueName,
    locationShortName: location?.shortName || location?.name || account.venueShortName || account.venueName,
    locationAddress: location?.address || "",
    mapUrl: location?.mapUrl || "",
    arrivalInstructions: location?.arrivalInstructions || "",
    publicNotes: location?.publicNotes || "",
    price: appointment.customGroup && Number.isFinite(Number(appointment.calculatedPrice))
      ? `NZ$${Number(appointment.calculatedPrice)}.00`
      : servicePriceLabel(service),
    duration: `${appointment.duration} minutes`,
    replyTo: account.contactEmail,
    rescheduleUrl: rescheduleUrl.toString(),
    googleCalendarUrl: bookingGoogleCalendarUrl({
      appointment,
      service,
      account,
      rescheduleUrl: rescheduleUrl.toString(),
    }),
    appleCalendarUrl: bookingAppleCalendarUrl({ appointment }),
  };
}

function bookingEmailHtml({ title, intro, footer, variables }) {
  const manageButton = variables.rescheduleUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 14px"><tr><td><a href="${escapeHtml(variables.rescheduleUrl)}" style="display:inline-block;background:#07100a;color:#ffffff;padding:12px 18px;text-decoration:none;border-radius:6px;font-weight:700">Manage / Reschedule</a></td></tr></table>`
    : "";
  const calendarButtons = variables.googleCalendarUrl || variables.appleCalendarUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px"><tr>${
        variables.googleCalendarUrl
          ? `<td style="padding:0 8px 8px 0"><a href="${escapeHtml(variables.googleCalendarUrl)}" style="display:inline-block;border:1px solid #cfd8ca;color:#101612;padding:10px 13px;text-decoration:none;border-radius:7px;font-weight:600"><span style="font-size:15px;vertical-align:-1px;margin-right:6px">&#128197;</span>Google Calendar</a></td>`
          : ""
      }${
        variables.appleCalendarUrl
          ? `<td style="padding:0 0 8px 0"><a href="${escapeHtml(variables.appleCalendarUrl)}" style="display:inline-block;border:1px solid #cfd8ca;color:#101612;padding:10px 13px;text-decoration:none;border-radius:7px;font-weight:600"><span style="font-size:15px;vertical-align:-1px;margin-right:6px">&#128467;&#65039;</span>Apple Calendar</a></td>`
          : ""
      }</tr></table>`
    : "";
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.55;color:#101612">
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(intro)}</p>
      <table style="border-collapse:collapse;margin:18px 0;width:100%;max-width:520px">
        <tr><td style="padding:8px;border-bottom:1px solid #dfe5d8;color:#697166">Lesson</td><td style="padding:8px;border-bottom:1px solid #dfe5d8"><strong>${escapeHtml(variables.service)}</strong></td></tr>
        <tr><td style="padding:8px;border-bottom:1px solid #dfe5d8;color:#697166">When</td><td style="padding:8px;border-bottom:1px solid #dfe5d8">${escapeHtml(variables.date)}, ${escapeHtml(variables.time)}</td></tr>
        <tr><td style="padding:8px;border-bottom:1px solid #dfe5d8;color:#697166">Where</td><td style="padding:8px;border-bottom:1px solid #dfe5d8">${escapeHtml(variables.venue)}</td></tr>
        <tr><td style="padding:8px;color:#697166">Price</td><td style="padding:8px">${escapeHtml(variables.price)}</td></tr>
      </table>
      ${manageButton}
      ${calendarButtons}
      <p>${escapeHtml(footer).replace(/\n/g, "<br/>")}</p>
    </div>
  `;
}

function bookingEmailText({ title, intro, footer, variables }) {
  return [
    title,
    "",
    intro,
    "",
    `Lesson: ${variables.service}`,
    `When: ${variables.date}, ${variables.time}`,
    `Where: ${variables.venue}`,
    `Price: ${variables.price}`,
    "",
    variables.rescheduleUrl
      ? `Manage / Reschedule: ${variables.rescheduleUrl}`
      : "",
    variables.googleCalendarUrl
      ? `Google Calendar: ${variables.googleCalendarUrl}`
      : "",
    variables.appleCalendarUrl
      ? `Apple Calendar: ${variables.appleCalendarUrl}`
      : "",
    "",
    footer,
  ]
    .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
    .join("\n");
}

async function sendBookingNotifications(
  appointment,
  { kind = "booking", testRecipient = "", clientOnly = false, idempotencyNonce = "" } = {},
) {
  const settings = await readAdminSettings();
  const account = await readCoachAccount();
  const services = await readServices();
  const service = services.find(
    (candidate) => candidate.id === appointment.serviceId,
  );
  const variables = bookingEmailVariables({ appointment, service, account });
  const personKey = notificationPersonKey({
    name: appointment.client || appointment.title,
    email: appointment.email,
    phone: appointment.phone,
  });
  const replyTo = settings.replyToEmail || account.contactEmail;
  const jobs = [];

  async function sendAndRecord(channel, recipient, subject, html, text, key) {
    const notificationKind = `${kind}_${channel}_email`;
    const deliveryKey = idempotencyNonce ? `${key}-${idempotencyNonce}` : key;
    const result = await sendEmail({
      to: recipient,
      subject,
      html,
      text,
      replyTo,
      idempotencyKey: deliveryKey,
    });
    const status = result.sent ? "sent" : "failed";

    try {
      await recordNotification({
        personKey,
        calendarItemId: appointment.id,
        recipient,
        subject,
        kind: notificationKind,
        status,
        provider: "resend",
        providerId: result.id || "",
        error: result.reason || result.error || "",
      });
    } catch (error) {
      console.error("Notification history write failed", channel, error);
    }

    if (result.sent) {
      console.log(
        "Booking email sent",
        channel,
        recipient,
        result.id || "no-provider-id",
      );
    }

    return {
      channel,
      recipient,
      subject,
      kind: notificationKind,
      status,
      ...result,
    };
  }

  async function recordSkipped(channel, recipient, subject, reason) {
    const notificationKind = `${kind}_${channel}_email`;
    try {
      await recordNotification({
        personKey,
        calendarItemId: appointment.id,
        recipient,
        subject,
        kind: notificationKind,
        status: "skipped",
        provider: "settings",
        providerId: "",
        error: reason,
      });
    } catch (error) {
      console.error(
        "Notification skipped history write failed",
        channel,
        error,
      );
    }
    return {
      channel,
      recipient,
      subject,
      kind: notificationKind,
      status: "skipped",
      sent: false,
      reason,
    };
  }

  if (
    (settings.sendClientEmail || kind === "test") &&
    (testRecipient || appointment.email)
  ) {
    const subject = renderTemplate(settings.clientEmailSubject, variables);
    const intro = renderTemplate(settings.clientEmailIntro, variables);
    const footerBase = modernClientEmailFooter(
      renderTemplate(settings.clientEmailFooter, variables),
    );
    const recipient = testRecipient || appointment.email;
    const clientVariables = testRecipient
      ? {
          ...variables,
          rescheduleUrl: "",
          googleCalendarUrl: "",
          appleCalendarUrl: "",
        }
      : variables;
    jobs.push(
      sendAndRecord(
        "client",
        recipient,
        subject,
        bookingEmailHtml({
          title: subject,
          intro,
          footer: footerBase,
          variables: clientVariables,
        }),
        bookingEmailText({
          title: subject,
          intro,
          footer: footerBase,
          variables: clientVariables,
        }),
        `${kind}-client-${appointment.id}-${hashToken(recipient).slice(0, 12)}`,
      ),
    );
  } else if (kind !== "test") {
    const recipient = appointment.email || "";
    const subject = renderTemplate(settings.clientEmailSubject, variables);
    jobs.push(
      recordSkipped(
        "client",
        recipient,
        subject,
        settings.sendClientEmail
          ? "missing_client_email"
          : "disabled_in_notification_settings",
      ),
    );
  }

  const inviteAttendees = Array.isArray(appointment.attendees)
    ? appointment.attendees.filter((attendee) => attendee?.email && attendee?.token && attendee.status === "invited")
    : [];
  if (!clientOnly && (kind === "booking" || kind === "updated") && inviteAttendees.length) {
    for (const attendee of inviteAttendees) {
      const invite = customGroupInviteEmail({ appointment, attendee, service, account });
      if (settings.sendClientEmail) {
        jobs.push(
          sendAndRecord(
            "custom_group_invite",
            attendee.email,
            invite.subject,
            invite.html,
            invite.text,
            `${kind}-custom-group-invite-${appointment.id}-${hashToken(attendee.email).slice(0, 12)}`,
          ),
        );
      } else {
        jobs.push(recordSkipped("custom_group_invite", attendee.email, invite.subject, "disabled_in_notification_settings"));
      }
    }
  }

  if (!clientOnly && settings.sendCoachEmail && kind !== "test") {
    const recipient = settings.coachEmail || "";
    const subject = renderTemplate(settings.adminEmailSubject, variables);
    const intro = renderTemplate(settings.adminEmailIntro, variables);
    if (recipient) {
      jobs.push(
        sendAndRecord(
          "coach",
          recipient,
          subject,
          bookingEmailHtml({ title: subject, intro, footer: "Coach booking alert.", variables }),
          bookingEmailText({ title: subject, intro, footer: "Coach booking alert.", variables }),
          `${kind}-coach-${appointment.id}-${hashToken(recipient).slice(0, 12)}`,
        ),
      );
    } else {
      jobs.push(recordSkipped("coach", "", subject, "missing_coach_email"));
    }
  } else if (!clientOnly && kind !== "test") {
    const subject = renderTemplate(settings.adminEmailSubject, variables);
    jobs.push(recordSkipped("coach", settings.coachEmail || "", subject, "disabled_in_notification_settings"));
  }

  if (!clientOnly && settings.sendAdminEmail && kind !== "test") {
    const recipient = settings.notificationEmail || account.contactEmail;
    const subject = renderTemplate(settings.adminEmailSubject, variables);
    const intro = renderTemplate(settings.adminEmailIntro, variables);
    jobs.push(
      sendAndRecord(
        "admin",
        recipient,
        subject,
        bookingEmailHtml({
          title: subject,
          intro,
          footer: "Admin booking alert.",
          variables,
        }),
        bookingEmailText({
          title: subject,
          intro,
          footer: "Admin booking alert.",
          variables,
        }),
        `${kind}-admin-${appointment.id}-${hashToken(recipient).slice(0, 12)}`,
      ),
    );
  } else if (!clientOnly && kind !== "test") {
    const recipient = settings.notificationEmail || account.contactEmail;
    const subject = renderTemplate(settings.adminEmailSubject, variables);
    jobs.push(
      recordSkipped(
        "admin",
        recipient,
        subject,
        "disabled_in_notification_settings",
      ),
    );
  }

  if (!jobs.length) return [];
  return Promise.all(jobs);
}

async function resendBookingConfirmation(appointmentId, context, state = null) {
  assertAccountAdminContext(context, "You do not have permission to resend booking confirmations.");
  assertAccountFeature(context.account, "notifications");
  const current = state || await readCalendarState();
  const cleanId = cleanString(appointmentId, "", 140);
  const appointment = (current.items || []).find((item) => item.id === cleanId);
  if (!appointment || appointment.kind !== "appointment" || !canReadCalendarItem(context, appointment, current)) {
    throw Object.assign(new Error("Booking was not found in this workspace."), { status: 404 });
  }
  if (!cleanEmail(appointment.email, "")) {
    throw Object.assign(new Error("This booking does not have a customer email address."), { status: 400 });
  }

  const results = await sendBookingNotifications(appointment, {
    kind: "booking",
    clientOnly: true,
    idempotencyNonce: `admin-resend-${Date.now()}-${randomUUID().slice(0, 8)}`,
  });
  const notifications = filterNotificationsForContext(await readNotificationHistory(), context, current);
  return {
    ok: results.some((result) => result.sent),
    results,
    notifications,
  };
}

async function sendInitialBookingNotifications(appointment, kind = "booking") {
  try {
    const results = await sendBookingNotifications(appointment, { kind });
    return Array.isArray(results) ? results : [];
  } catch (error) {
    const errorMessage = cleanString(
      error instanceof Error ? error.message : String(error || "unknown_error"),
      "unknown_error",
      450,
    );
    console.error(
      "Initial booking notifications failed",
      appointment?.id,
      kind,
      error,
    );

    const fallbackResults = [];
    try {
      const settings = await readAdminSettings();
      const account = await readCoachAccount();
      const services = await readServices();
      const service = services.find(
        (candidate) => candidate.id === appointment?.serviceId,
      );
      const variables = bookingEmailVariables({
        appointment,
        service,
        account,
      });
      const personKey = notificationPersonKey({
        name: appointment?.client || appointment?.title,
        email: appointment?.email,
        phone: appointment?.phone,
      });

      async function recordFailed(
        channel,
        recipient,
        subject,
        reason = "send_exception",
      ) {
        const notificationKind = `${kind}_${channel}_email`;
        const result = {
          channel,
          recipient,
          subject,
          kind: notificationKind,
          status: "failed",
          sent: false,
          reason,
          error: errorMessage,
        };
        fallbackResults.push(result);
        await recordNotification({
          personKey,
          calendarItemId: appointment?.id || "",
          recipient,
          subject,
          kind: notificationKind,
          status: "failed",
          provider: "resend",
          providerId: "",
          error: `${reason}:${errorMessage}`,
        });
      }

      if (appointment?.email && settings.sendClientEmail) {
        await recordFailed(
          "client",
          appointment.email,
          renderTemplate(settings.clientEmailSubject, variables),
        );
      }

      if (settings.sendCoachEmail && settings.coachEmail) {
        await recordFailed(
          "coach",
          settings.coachEmail,
          renderTemplate(settings.adminEmailSubject, variables),
        );
      }

      if (settings.sendAdminEmail) {
        const recipient = settings.notificationEmail || account.contactEmail;
        await recordFailed(
          "admin",
          recipient,
          renderTemplate(settings.adminEmailSubject, variables),
        );
      }
    } catch (recordError) {
      console.error(
        "Initial booking notification fallback receipt failed",
        appointment?.id,
        kind,
        recordError,
      );
    }

    return fallbackResults.length
      ? fallbackResults
      : [
          {
            channel: "client",
            sent: false,
            status: "failed",
            reason: "send_exception",
            error: errorMessage,
          },
        ];
  }
}

async function resetAdminPassword(token, password) {
  const cleanToken = cleanString(token, "", 500);
  if (!cleanToken) return { error: "invalid_token" };
  if (typeof password !== "string" || password.length < 8)
    return { error: "weak_password" };

  const rows = await db().sql`
    SELECT admin_password_resets.id AS reset_id,
           admin_users.id AS user_id,
           admin_users.email AS email
    FROM admin_password_resets
    JOIN admin_users ON admin_users.id = admin_password_resets.user_id
    WHERE admin_password_resets.token_hash = ${hashToken(cleanToken)}
      AND admin_password_resets.used_at IS NULL
      AND admin_password_resets.expires_at > NOW()
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return { error: "invalid_token" };

  const { passwordHash, salt } = hashPassword(password);
  const client = await db().pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE admin_users
       SET password_hash = $1,
           password_salt = $2,
           updated_at = NOW()
       WHERE id = $3`,
      [passwordHash, salt, row.user_id],
    );
    await client.query(
      "UPDATE admin_password_resets SET used_at = NOW() WHERE id = $1",
      [row.reset_id],
    );
    await client.query("DELETE FROM admin_sessions WHERE user_id = $1", [
      row.user_id,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return { user: { id: row.user_id, email: row.email, password_hash: passwordHash, password_salt: salt } };
}

async function changeAdminPassword(session, currentPassword, nextPassword) {
  if (!session?.email) return { error: "unauthorized" };
  if (typeof nextPassword !== "string" || nextPassword.length < 8)
    return { error: "weak_password" };
  const user = await verifyAdminPassword(session.email, currentPassword || "");
  if (!user) return { error: "invalid_current_password" };

  const { passwordHash, salt } = hashPassword(nextPassword);
  const client = await db().pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE admin_users
       SET password_hash = $1,
           password_salt = $2,
           updated_at = NOW()
       WHERE id = $3`,
      [passwordHash, salt, user.id],
    );
    await client.query("DELETE FROM admin_sessions WHERE user_id = $1", [
      user.id,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return { user: { id: user.id, email: user.email, password_hash: passwordHash, password_salt: salt } };
}

async function createAdminSession(userOrId) {
  const startedAt = Date.now();
  let ok = false;
  const userId = typeof userOrId === "object" ? userOrId.id : userOrId;
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000).toISOString();
  try {
    await db().sql`
      INSERT INTO admin_sessions (id, token_hash, user_id, expires_at, created_at)
      VALUES (${randomUUID()}, ${tokenHash}, ${userId}, ${expiresAt}, NOW())
    `;
    ok = true;
    return { token, expiresAt };
  } finally {
    logAuthTiming("createAdminSession", startedAt, { ok });
  }
}

async function readAdminSession(token) {
  if (!token) return null;
  const rows = await db().sql`
    SELECT admin_users.id, admin_users.email, admin_sessions.expires_at
    FROM admin_sessions
    JOIN admin_users ON admin_users.id = admin_sessions.user_id
    WHERE admin_sessions.token_hash = ${hashToken(token)}
  `;
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await destroyAdminSession(token);
    return null;
  }
  return { id: row.id, email: row.email, expiresAt: row.expires_at };
}

async function destroyAdminSession(token) {
  if (!token) return;
  const tokenHash = hashToken(token);
  await db().sql`DELETE FROM admin_sessions WHERE token_hash = ${tokenHash}`;
}

async function cleanupExpiredSessions() {
  await db().sql`DELETE FROM admin_sessions WHERE expires_at <= NOW()`;
}

async function requireAdmin(req) {
  const session = await readAdminSession(sessionTokenFromRequest(req));
  if (!session) return null;
  return session;
}

async function readBackendSettings() {
  return readCalendarState();
}

function defaultWorkspaceAccount(settings = {}) {
  const accounts = normalizeWorkspaceAccounts(settings.workspaceAccounts || [], settings.account || defaultCoachAccount());
  const id = defaultAccountId(accounts);
  return accounts.find((account) => account.id === id) || accounts[0] || defaultWorkspaceAccountFromCoachAccount(settings.account);
}

function publicWorkspaceAccount(state = {}) {
  return defaultWorkspaceAccount(state);
}

function resolveWorkspaceAccount(_req, settings = {}) {
  return defaultWorkspaceAccount(settings);
}

function defaultAppUserForAccount(account, settings = {}) {
  const accountSettings = settings.account || defaultCoachAccount();
  const users = Array.isArray(settings.currentUser)
    ? settings.currentUser
    : Array.isArray(settings.appUsers)
      ? settings.appUsers
      : [];
  const cleanUsers = users.length ? users : [settings.currentUser].filter(Boolean);
  const fallback = { ...defaultAppUserFromAccount(accountSettings), accountId: account.id };
  return cleanUsers.find((user) => user?.accountId === account.id) || fallback;
}

async function readCurrentSessionUser(req, settings = {}) {
  const session = await readAdminSession(sessionTokenFromRequest(req));
  if (!session) return null;
  const account = defaultWorkspaceAccount(settings);
  const appUsers = await readAppUsers();
  const matched =
    appUsers.find((user) => user.accountId === account.id && user.email && session.email && user.email.toLowerCase() === session.email.toLowerCase()) ||
    appUsers.find((user) => user.accountId === account.id && isAdminUser(user)) ||
    defaultAppUserForAccount(account, { ...settings, currentUser: settings.currentUser });
  return { ...matched, accountId: matched.accountId || account.id };
}

function isAdminUser(user) {
  return ["admin", "account_admin", "platform_admin"].includes(user?.role) || Object.values(user?.permissions || {}).includes("all");
}

function userBelongsToAccount(user, accountId) {
  return Boolean(user && (!user.accountId || user.accountId === accountId));
}

function userCoachId(user) {
  return cleanSlug(user?.coachId, "") || undefined;
}

function hasPermission(user, permissionKey, scope = "own") {
  if (isAdminUser(user)) return true;
  const grant = user?.permissions?.[permissionKey];
  if (!grant) return false;
  if (grant === "all") return true;
  if (scope === "assigned") return grant === "assigned";
  if (scope === "own") return grant === "own" || grant === "assigned";
  return false;
}

function assertUserBelongsToAccount(user, accountId) {
  if (!userBelongsToAccount(user, accountId)) {
    throw permissionDenied("This user does not belong to the requested workspace.");
  }
}

function assertAuthenticatedContext(context) {
  if (!context?.user) throw Object.assign(new Error("Admin login required."), { status: 401, code: "unauthorized" });
  assertAccountActive(context.account);
  assertUserBelongsToAccount(context.user, context.accountId);
}

function assertAccountAdminContext(context, message = "You do not have permission to change account settings.") {
  assertAuthenticatedContext(context);
  if (!context.isAdmin) throw permissionDenied(message);
}

async function resolveBackendRequestContext(req, settings = null) {
  const resolvedSettings = settings || await readBackendSettings();
  const account = resolveWorkspaceAccount(req, resolvedSettings);
  const user = await readCurrentSessionUser(req, resolvedSettings);
  const context = {
    account,
    accountId: account.id,
    user,
    userId: user?.id || "",
    coachId: userCoachId(user),
    isAdmin: isAdminUser(user),
    entitlements: accountEntitlements(account),
  };
  assertAuthenticatedContext(context);
  return context;
}

function itemWeek(item) {
  return item.week ?? 0;
}

function slotOverlaps(a, b) {
  return (
    a.week === b.week &&
    a.day === b.day &&
    a.start < b.start + b.duration &&
    a.start + a.duration > b.start
  );
}

function isInsideAvailability(availability, day, start, duration, coachId = defaultCoachProfileFromAccount().id) {
  const end = start + duration;
  const fallbackCoachId = defaultCoachProfileFromAccount().id;
  return (
    availability[day]?.some(
      (window) =>
        (window.coachId || fallbackCoachId) === coachId &&
        start >= window.start &&
        end <= window.end,
    ) ?? false
  );
}

function currentWeekOffset() {
  const today = new Date();
  const day = today.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const weekStart = new Date(today);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() + mondayOffset);
  const weekStartUtc = Date.UTC(
    weekStart.getFullYear(),
    weekStart.getMonth(),
    weekStart.getDate(),
  );
  const baseWeekStartUtc = Date.UTC(
    baseWeekStart.getFullYear(),
    baseWeekStart.getMonth(),
    baseWeekStart.getDate(),
  );
  return Math.round((weekStartUtc - baseWeekStartUtc) / (7 * 24 * 60 * 60 * 1000));
}

function isGroupServiceSlotMatch(service, candidate) {
  if (!isScheduledGroupService(service)) return false;
  if (!service.groupSchedule || service.groupSchedule.active === false) return false;
  const schedule = service.groupSchedule;
  if (candidate.day !== schedule.dayOfWeek) return false;
  if (candidate.start !== schedule.startMinutes) return false;
  if (!Number.isInteger(candidate.week)) return false;
  const minWeek = currentWeekOffset();
  const occurrenceCount = Math.max(1, Math.min(MAX_GROUP_OCCURRENCE_COUNT, Math.round(schedule.occurrenceCount || 1)));
  if (candidate.week < minWeek || candidate.week >= minWeek + occurrenceCount) return false;
  return true;
}

function conflictItemSummary(item, state = {}) {
  if (!item) return null;
  const services = state.services || defaultServices;
  const coaches = state.coaches || [];
  const locations = state.locations || [];
  const account = state.account || defaultCoachAccount();
  const service = services.find((candidateService) => candidateService.id === item.serviceId);
  return {
    id: item.id,
    kind: item.kind,
    status: item.status || "booked",
    serviceId: item.serviceId || "",
    serviceName: service?.name || "",
    week: itemWeek(item),
    day: item.day,
    start: item.start,
    duration: item.duration,
    coachId: resolvedCalendarItemCoachId(item, service, coaches, account),
    locationId: resolvedCalendarItemLocationId(item, service, locations, account),
  };
}

function findCollision(items, candidate, service, state = {}) {
  const services = state.services || defaultServices;
  const coaches = state.coaches || [];
  const locations = state.locations || [];
  const account = state.account || defaultCoachAccount();
  const candidateCoachId = service?.coachId || defaultCoachId(coaches);
  const candidateLocationId = serviceLocation(service, locations, account).id;
  const candidateItem = {
    kind: "appointment",
    coachId: candidateCoachId,
    locationId: candidateLocationId,
    ...candidate,
  };
  const existingService = (item) => services.find((candidateService) => candidateService.id === item.serviceId);
  const isCoachConflict = (item) => {
    if (isInactiveForConflict(item) || isLocationOnlyBlock(item)) return false;
    const itemCoachId = resolvedCalendarItemCoachId(item, existingService(item), coaches, account);
    return Boolean(candidateCoachId && itemCoachId && candidateCoachId === itemCoachId);
  };
  const isLocationConflict = (item) => {
    if (isInactiveForConflict(item)) return false;
    const itemLocationId = resolvedCalendarItemLocationId(item, existingService(item), locations, account);
    if (!candidateLocationId || !itemLocationId || candidateLocationId !== itemLocationId) return false;
    if (isLocationOnlyBlock(item)) return true;
    if (isCoachOnlyBlock(item)) return false;
    if (isCoachLocationBlock(item)) return isCoachConflict(item);
    return candidateItem.kind === "block" && isLocationOnlyBlock(candidateItem);
  };
  const isAppointmentConflict = (item) => isCoachConflict(item) || isLocationConflict(item);
  const overlapping = items.filter((item) =>
    slotOverlaps(
      {
        week: itemWeek(item),
        day: item.day,
        start: item.start,
        duration: item.duration,
      },
      candidate,
    ),
  );
  if (!isScheduledGroupService(service)) {
    const item = overlapping.find(isAppointmentConflict);
    return item ? { reason: "blocking_item", item, candidateCoachId, candidateLocationId } : null;
  }
  const blockingItem = overlapping.find(
    (item) => (item.kind !== "appointment" || item.serviceId !== service.id) && isAppointmentConflict(item),
  );
  if (blockingItem) return { reason: "blocking_item", item: blockingItem, candidateCoachId, candidateLocationId };
  const sameService = overlapping.filter((item) => item.serviceId === service.id && !isInactiveForConflict(item));
  if (sameService.length >= service.capacity) {
    return { reason: "capacity_full", item: sameService[0], candidateCoachId, candidateLocationId };
  }
  return null;
}

function hasCollision(items, candidate, service, state = {}) {
  return Boolean(findCollision(items, candidate, service, state));
}

function publicBookingSlotsRequestError(message, status, code = "request_error") {
  return Object.assign(new Error(message), { status, code });
}

function publicAccountState(state) {
  const workspaceAccount = publicWorkspaceAccount(state);
  assertAccountFeature(workspaceAccount, "publicBooking");
  return {
    workspaceAccount,
    state: {
      ...state,
      items: (state.items || []).filter((item) => recordBelongsToAccount(item, workspaceAccount.id)),
      services: (state.services || []).filter((service) => recordBelongsToAccount(service, workspaceAccount.id)),
      coaches: (state.coaches || []).filter((coach) => recordBelongsToAccount(coach, workspaceAccount.id)),
      locations: (state.locations || []).filter((location) => recordBelongsToAccount(location, workspaceAccount.id)),
      availability: (state.availability || []).map((day) => day.filter((window) => recordBelongsToAccount(window, workspaceAccount.id))),
    },
  };
}

function publicBookableServices(services = []) {
  return services.filter(
    (service) =>
      service.active &&
      service.archived !== true &&
      service.visibility === "public" &&
      service.lessonFormat !== "package",
  );
}

function groupSlotRemainingSpots(items, candidate, service) {
  const capacity = Math.max(1, Math.round(Number(service.capacity || 1)));
  const bookedCount = items.filter(
    (item) =>
      item.serviceId === service.id &&
      !isInactiveForConflict(item) &&
      slotOverlaps(
        {
          week: itemWeek(item),
          day: item.day,
          start: item.start,
          duration: item.duration,
        },
        candidate,
      ),
  ).length;
  return Math.max(0, capacity - bookedCount);
}

function publicSlotRequestedWeekItems(items = [], week) {
  return items.filter((item) => itemWeek(item) === week && !isInactiveForConflict(item));
}

function publicSlotItemMayAffectService(item, service, state = {}) {
  const services = state.services || defaultServices;
  const coaches = state.coaches || [];
  const locations = state.locations || [];
  const account = state.account || defaultCoachAccount();
  const itemService = serviceForCalendarItem(item, services);
  const serviceCoachId = service?.coachId || defaultCoachId(coaches);
  const serviceLocationId = serviceLocation(service, locations, account).id;
  const itemCoachId = isLocationOnlyBlock(item)
    ? ""
    : resolvedCalendarItemCoachId(item, itemService, coaches, account);
  const itemLocationId = resolvedCalendarItemLocationId(item, itemService, locations, account);

  if (item.serviceId && item.serviceId === service?.id) return true;

  if (isLocationOnlyBlock(item)) {
    if (!itemLocationId || !serviceLocationId) return true;
    return itemLocationId === serviceLocationId;
  }

  if (isCoachOnlyBlock(item)) {
    if (!itemCoachId || !serviceCoachId) return true;
    return itemCoachId === serviceCoachId;
  }

  if (isCoachLocationBlock(item)) {
    if (!itemCoachId || !serviceCoachId) return true;
    return itemCoachId === serviceCoachId;
  }

  if (item.kind === "appointment") {
    if (!itemCoachId || !serviceCoachId) return true;
    return itemCoachId === serviceCoachId;
  }

  if (!itemCoachId || !itemLocationId || !serviceCoachId || !serviceLocationId) return true;
  return itemCoachId === serviceCoachId || itemLocationId === serviceLocationId;
}

function publicSlotRelevantResourceItems(items = [], service, state = {}) {
  return items.filter((item) => publicSlotItemMayAffectService(item, service, state));
}

function publicSlotsForService(accountState, service, week, ignoreId = "") {
  const ignoredItemId = cleanString(ignoreId, "", 160);
  const items = ignoredItemId ? accountState.items.filter((item) => item.id !== ignoredItemId) : accountState.items;
  const serviceCoachId = service.coachId || defaultCoachId(accountState.coaches || []);
  const serviceLocationId = serviceLocation(service, accountState.locations || [], accountState.account).id;

  if (isScheduledGroupService(service)) {
    const schedule = service.groupSchedule;
    if (!schedule?.active) return [];
    const candidate = {
      week,
      day: schedule.dayOfWeek,
      start: schedule.startMinutes,
      duration: service.duration,
    };
    if (!isGroupServiceSlotMatch(service, candidate)) return [];
    if (hasCollision(items, candidate, service, accountState)) return [];
    const remainingSpots = groupSlotRemainingSpots(items, candidate, service);
    if (!remainingSpots) return [];
    return [
      {
        week: candidate.week,
        day: candidate.day,
        start: candidate.start,
        remainingSpots,
        coachId: serviceCoachId,
        locationId: serviceLocationId,
      },
    ];
  }

  const slots = [];
  for (let day = 0; day < 7; day += 1) {
    const windows = accountState.availability[day] || [];
    for (const window of windows) {
      const windowCoachId = window.coachId || defaultCoachProfileFromAccount().id;
      if (windowCoachId !== serviceCoachId) continue;
      for (let start = window.start; start + service.duration <= window.end; start += PUBLIC_SLOT_STEP_MINUTES) {
        const candidate = {
          week,
          day,
          start,
          duration: service.duration,
        };
        if (
          isInsideAvailability(accountState.availability, day, start, service.duration, serviceCoachId) &&
          !hasCollision(items, candidate, service, accountState)
        ) {
          slots.push({
            week: candidate.week,
            day: candidate.day,
            start: candidate.start,
            remainingSpots: 0,
            coachId: serviceCoachId,
            locationId: serviceLocationId,
          });
        }
      }
    }
  }
  return slots;
}

export function publicBookingSlots(state, options = {}) {
  const { state: accountState } = publicAccountState(state);
  const week = publicBookingSlotsWeek(options.week);
  const serviceId = cleanString(options.serviceId, "", 140);
  const ignoreId = cleanString(options.ignoreId, "", 160);
  const metrics = options.metrics;
  if (!serviceId) {
    throw publicBookingSlotsRequestError("Choose a public lesson type.", 400, "service_required");
  }
  const services = publicBookableServices(accountState.services);
  const totalPublicItemCount = accountState.items.length;
  if (metrics) {
    metrics.serviceId = serviceId;
    metrics.week = week;
    if (metrics.totalPublicItemCount == null) metrics.totalPublicItemCount = totalPublicItemCount;
  }
  const targetService = services.find((service) => service.id === serviceId);
  if (!targetService) {
    throw publicBookingSlotsRequestError("Choose a public lesson type.", 404);
  }
  const requestedWeekItems = publicSlotRequestedWeekItems(accountState.items, week);
  const relevantResourceItems = publicSlotRelevantResourceItems(requestedWeekItems, targetService, accountState);
  const filteredAccountState = { ...accountState, items: relevantResourceItems };
  if (metrics) {
    if (metrics.requestedWeekItemCount == null) metrics.requestedWeekItemCount = requestedWeekItems.length;
    if (metrics.relevantResourceItemCount == null) metrics.relevantResourceItemCount = relevantResourceItems.length;
  }
  const slots = publicSlotsForService(filteredAccountState, targetService, week, ignoreId);
  if (metrics) metrics.returnedSlotCount = slots.length;
  const servicesById = {};
  servicesById[targetService.id] = {
    serviceId: targetService.id,
    week,
    slots: slots.map((slot) => ({ ...slot })),
  };
  return {
    updatedAt: state.updatedAt,
    week,
    serviceId,
    ignoreId,
    slots,
    services: servicesById,
  };
}

export async function handlePublicBookingSlotsRequest(req, options = {}) {
  const startedAt = Date.now();
  const url = new URL(req.url);
  const serviceId = cleanString(url.searchParams.get("serviceId") || "", "", 140);
  const week = publicBookingSlotsWeek(url.searchParams.get("week") || "");
  const metrics = {
    serviceId,
    week,
    settingsReadMs: null,
    itemsReadMs: null,
    slotCalculationMs: null,
    totalPublicItemCount: null,
    rowsFetched: null,
    requestedWeekItemCount: null,
    relevantResourceItemCount: null,
    returnedSlotCount: null,
    queryMode: "",
    usedLegacySchemaFallback: false,
    status: 500,
  };
  try {
    if (!serviceId) {
      metrics.status = 400;
      return json(
        {
          error: "service_required",
          message: "Choose a public lesson type.",
        },
        400,
      );
    }
    const readSlotContext = options.readPublicSlotContext || readPublicSlotContext;
    const slotContext = await readSlotContext({ serviceId, week }, { ...options, metrics });
    const slotCalculationStartedAt = Date.now();
    const payload = publicBookingSlots(slotContext, {
      serviceId,
      week,
      ignoreId: url.searchParams.get("ignoreId") || "",
      metrics,
    });
    metrics.slotCalculationMs = Date.now() - slotCalculationStartedAt;
    metrics.status = 200;
    return json(payload);
  } catch (error) {
    console.error("public_booking_slots_error", error);
    const status = error?.status || 500;
    metrics.status = status;
    return json(
      {
        error: error?.code === "service_required" ? "service_required" : status === 500 ? "public_booking_slots_error" : "request_error",
        message: error instanceof Error ? error.message : "Unknown public booking slots error",
      },
      status,
    );
  } finally {
    const durationMs = Date.now() - startedAt;
    console.info("public_booking_slots:timing", {
      ...metrics,
      durationMs,
      totalMs: durationMs,
    });
  }
}

function publicSlotUnavailableError(detail) {
  console.warn("public_booking:slot_rejected", detail);
  return Object.assign(new Error("That time is no longer available."), {
    status: 409,
    detail,
  });
}

async function createPublicBooking(payload, context = null) {
  const state = await readFastPublicCalendarState();
  const workspaceAccount =
    (state.workspaceAccounts || []).find((account) => account.id === defaultAccountId(state.workspaceAccounts)) ||
    (state.workspaceAccounts || [])[0] ||
    defaultWorkspaceAccountFromCoachAccount(state.account);
  assertAccountFeature(workspaceAccount, "publicBooking");
  const accountState = {
    ...state,
    items: (state.items || []).filter((item) => recordBelongsToAccount(item, workspaceAccount.id)),
    services: (state.services || []).filter((service) => recordBelongsToAccount(service, workspaceAccount.id)),
    coaches: (state.coaches || []).filter((coach) => recordBelongsToAccount(coach, workspaceAccount.id)),
    locations: (state.locations || []).filter((location) => recordBelongsToAccount(location, workspaceAccount.id)),
    availability: (state.availability || []).map((day) => day.filter((window) => recordBelongsToAccount(window, workspaceAccount.id))),
  };
  const service = accountState.services.find(
    (candidate) =>
      candidate.id === payload?.serviceId &&
      candidate.active &&
      candidate.archived !== true &&
      candidate.visibility === "public" &&
      candidate.lessonFormat !== "package",
  );
  if (!service)
    throw Object.assign(new Error("Choose a public lesson type."), {
      status: 400,
    });

  const week = Number(payload.week ?? 0);
  const day = Number(payload.day);
  const start = Number(payload.start);
  const firstName = cleanString(payload.firstName, "", 80);
  const lastName = cleanString(payload.lastName, "", 80);
  const email = cleanString(payload.email, "", 180);
  const phone = cleanString(payload.phone, "", 80);

  if (!firstName || !lastName || !email) {
    throw Object.assign(
      new Error("First name, last name, and email are required."),
      { status: 400 },
    );
  }
  if (
    !Number.isInteger(week) ||
    !Number.isInteger(day) ||
    !Number.isInteger(start) ||
    day < 0 ||
    day > 6
  ) {
    throw Object.assign(new Error("Choose a valid appointment time."), {
      status: 400,
    });
  }

  const slot = { week, day, start, duration: service.duration };
  const serviceCoachId = service.coachId || defaultCoachId(accountState.coaches || []);
  const serviceLocationId = serviceLocation(service, accountState.locations || [], accountState.account).id;
  const rejectionBase = {
    serviceId: service.id,
    serviceName: service.name,
    slot,
    coachId: serviceCoachId,
    locationId: serviceLocationId,
    itemCount: accountState.items.length,
  };
  if (isScheduledGroupService(service)) {
    if (!isGroupServiceSlotMatch(service, slot)) {
      throw publicSlotUnavailableError({ ...rejectionBase, reason: "group_schedule_mismatch" });
    }
    const collision = findCollision(accountState.items, slot, service, accountState);
    if (collision) {
      throw publicSlotUnavailableError({
        ...rejectionBase,
        reason: collision.reason,
        candidateCoachId: collision.candidateCoachId,
        candidateLocationId: collision.candidateLocationId,
        conflictItem: conflictItemSummary(collision.item, accountState),
      });
    }
  } else if (!isInsideAvailability(accountState.availability, day, start, service.duration, serviceCoachId)) {
    throw publicSlotUnavailableError({
      ...rejectionBase,
      reason: "outside_availability",
      availability: accountState.availability[day] || [],
    });
  } else {
    const collision = findCollision(accountState.items, slot, service, accountState);
    if (collision) {
      throw publicSlotUnavailableError({
        ...rejectionBase,
        reason: collision.reason,
        candidateCoachId: collision.candidateCoachId,
        candidateLocationId: collision.candidateLocationId,
        conflictItem: conflictItemSummary(collision.item, accountState),
      });
    }
  }

  const client = `${firstName} ${lastName}`;
  const rawAttendees = Array.isArray(payload?.attendees) ? payload.attendees : [];
  let customGroup = null;
  if (isCustomGroupService(service)) {
    const invalidInvite = rawAttendees.find((attendee) => {
      const rawEmail = cleanString(attendee?.email, "", 180);
      return rawEmail && !cleanEmail(rawEmail, "");
    });
    if (invalidInvite) {
      throw Object.assign(new Error("Enter a valid attendee email or leave it blank."), {
        status: 400,
      });
    }
    const otherAttendees = rawAttendees
      .map((attendee, index) => cleanCustomGroupAttendee({
        id: `attendee-${index + 1}`,
        name: attendee?.name,
        email: attendee?.email,
        status: attendee?.email ? "invited" : "manual",
        token: attendee?.email ? randomUUID() : "",
      }, index))
      .filter(Boolean)
      .slice(0, customGroupMaxParticipants(service) - 1);
    const participantCount = 1 + otherAttendees.length;
    if (participantCount < customGroupMinParticipants(service)) {
      throw Object.assign(new Error("Add at least one other person before confirming."), {
        status: 400,
      });
    }
    if (participantCount > customGroupMaxParticipants(service)) {
      throw Object.assign(new Error("This custom group has too many attendees."), {
        status: 400,
      });
    }
    customGroup = {
      customGroup: true,
      attendees: [
        {
          id: "booker",
          name: client,
          email,
          status: "booker",
        },
        ...otherAttendees,
      ],
      calculatedPrice: calculateCustomGroupPrice(service, participantCount),
    };
  }
  const coachId = serviceCoachId;
  const location = cleanBookingLocationSnapshot(
    bookingLocationSnapshotFor(service, accountState.locations || [], accountState.account),
  );
  const coach = cleanBookingCoachSnapshot(
    bookingCoachSnapshotFor(coachId, accountState.coaches || [], accountState.account),
  );
  const appointment = {
    id: `appt-${Date.now()}`,
    accountId: service.accountId || workspaceAccount.id,
    kind: "appointment",
    ...slot,
    coachId,
    locationId: cleanSlug(location?.locationId || service.locationId, ""),
    coach,
    serviceId: service.id,
    client,
    title: client,
    phone,
    email,
    note: "Booked from public booking page.",
    location,
    ...(customGroup || {}),
  };
  const nextState = await writePublicBookingAppointment(state, appointment, context);
  return { appointment, notifications: [], state: nextState };
}

export async function handlePublicBookingRequest(req, context = null) {
  try {
    console.log("public_booking:start");
    const result = await createPublicBooking(await parseBody(req), context);
    console.log("public_booking:saved", result.appointment.id);
    return json({
      ok: true,
      appointment: {
        id: result.appointment.id,
        week: result.appointment.week,
        day: result.appointment.day,
        start: result.appointment.start,
        duration: result.appointment.duration,
        coachId: result.appointment.coachId,
        locationId: result.appointment.locationId,
        coach: result.appointment.coach,
        location: result.appointment.location,
      },
      state: { items: result.state?.items || [] },
      notifications: clientNotificationResults(result.notifications),
    });
  } catch (error) {
    console.error("public_booking:failed", error);
    const status = error?.status || 500;
    return json(
      {
        error: status === 500 ? "public_booking_error" : "request_error",
        message:
          error instanceof Error
            ? error.message
            : "Unknown public booking error",
      },
      status,
    );
  }
}

export async function handleCustomGroupConfirmRequest(req) {
  try {
    const token = cleanString(new URL(req.url).searchParams.get("token") || "", "", 180);
    if (!token) return text("This confirmation link is missing its token.", 400);

    const state = await readPublicCalendarState();
    const workspaceAccount = publicWorkspaceAccount(state);
    assertAccountFeature(workspaceAccount, "publicBooking");
    let confirmedAttendee = null;
    let confirmedAppointment = null;
    const nextItems = state.items.map((item) => {
      if (!recordBelongsToAccount(item, workspaceAccount.id)) return item;
      if (!item.customGroup || !Array.isArray(item.attendees)) return item;
      let changed = false;
      const attendees = item.attendees.map((attendee) => {
        if (attendee.token !== token) return attendee;
        changed = true;
        confirmedAttendee = attendee;
        confirmedAppointment = item;
        return { ...attendee, status: "confirmed" };
      });
      return changed ? { ...item, attendees } : item;
    });

    if (!confirmedAttendee || !confirmedAppointment) {
      return text("This confirmation link is not valid or has already been replaced.", 404);
    }

    await writePublicBookingState(state, nextItems);
    const service = state.services.find((candidate) => recordBelongsToAccount(candidate, workspaceAccount.id) && candidate.id === confirmedAppointment.serviceId);
    const title = "Attendance confirmed";
    return text(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:Arial,sans-serif;line-height:1.5;color:#101612;padding:32px;max-width:640px;margin:auto"><h1>${title}</h1><p>${escapeHtml(confirmedAttendee.name)} is confirmed for ${escapeHtml(service?.name || "the custom group lesson")}.</p><p>You can close this page.</p></body></html>`,
      200,
      "text/html; charset=utf-8",
    );
  } catch (error) {
    console.error("custom_group_confirm:failed", error);
    return text("Attendance could not be confirmed. Please contact the coach.", 500);
  }
}

export async function handlePublicNotificationStatusRequest(req) {
  try {
    const url = new URL(req.url);
    const appointmentId = cleanString(
      url.searchParams.get("appointment") || "",
      "",
      120,
    );
    const email = normalizeRescheduleContact(
      url.searchParams.get("email") || "",
    );
    const phone = normalizeRescheduleContact(
      url.searchParams.get("phone") || "",
    );
    if (!appointmentId || (!email && !phone)) return json({ sent: false }, 400);

    const state = await readPublicCatalogState();
    const workspaceAccount = publicWorkspaceAccount(state);
    assertAccountFeature(workspaceAccount, "publicBooking");
    const appointment = await readPublicAppointmentById(appointmentId, workspaceAccount.id);
    if (!appointment || !matchesNotificationContact(appointment, email, phone)) {
      return json({ sent: false }, 404);
    }

    const history = await readNotificationHistoryForAppointment(appointmentId);
    const notification = history.find(
      (candidate) =>
        candidate.calendarItemId === appointmentId &&
        candidate.kind.includes("client_email"),
    );
    return json({
      sent: ["sent", "delivered", "opened", "clicked"].includes(
        notification?.status || "",
      ),
      notification: notification
        ? notificationResultFromRecord(notification)
        : null,
    });
  } catch (error) {
    console.error("public_notification_status:failed", error);
    return json({ sent: false }, 500);
  }
}

async function applyResendWebhookEvent(event = {}, deliveryId = "") {
  const status = resendWebhookStatus(event?.type || "");
  const providerId = cleanString(
    deliveryId || event?.data?.email_id || "",
    "",
    180,
  );
  if (!status || !providerId) {
    return { ok: false, reason: "ignored", providerId, status };
  }

  const existingRows = await db().sql`
    SELECT id, status, error
    FROM notification_history
    WHERE provider_id = ${providerId}
  `;
  if (!existingRows.length) {
    return { ok: false, reason: "notification_not_found", providerId, status };
  }

  const errorMessage = resendWebhookErrorMessage(event);
  for (const row of existingRows) {
    if (!shouldApplyNotificationStatus(row.status || "", status)) continue;
    await db().sql`
      UPDATE notification_history
      SET status = ${status},
          error = CASE
            WHEN ${errorMessage} <> '' THEN ${errorMessage}
            ELSE error
          END
      WHERE id = ${row.id}
    `;
  }

  return { ok: true, providerId, status };
}

export async function handleResendWebhookRequest(req) {
  const payloadText = await req.text();
  let event = {};
  try {
    event = payloadText ? JSON.parse(payloadText) : {};
  } catch {
    return json({ ok: false, message: "Invalid webhook payload." }, 400);
  }

  await ensureSeeded();

  const deliveryId = cleanString(req.headers.get("svix-id") || "", "", 180);
  if (deliveryId) {
    const existing = await db()
      .sql`SELECT id FROM notification_webhook_events WHERE id = ${deliveryId} LIMIT 1`;
    if (existing.length) return json({ ok: true, duplicate: true });
  }

  const result = await applyResendWebhookEvent(event, "");

  await db().sql`
    INSERT INTO notification_webhook_events (id, provider_id, event_type, payload, received_at)
    VALUES (
      ${deliveryId || randomUUID()},
      ${cleanString(event?.data?.email_id || "", "", 180)},
      ${cleanString(event?.type || "unknown", "unknown", 120)},
      ${payloadText.slice(0, 12000)},
      NOW()
    )
    ON CONFLICT (id) DO NOTHING
  `;

  return json({ ok: true, result });
}

function normalizeRescheduleContact(value) {
  return cleanString(value, "", 180)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function publicRescheduleItem(item, serviceList = defaultServices) {
  return {
    id: item.id,
    serviceId: item.serviceId || "",
    serviceName: serviceName(item.serviceId, serviceList),
    duration: item.duration,
    week: itemWeek(item),
    day: item.day,
    start: item.start,
    client: item.client || item.title,
    location: item.location,
  };
}

function matchesRescheduleContact(item, email, phone) {
  if (item.kind !== "appointment") return false;
  const itemEmail = normalizeRescheduleContact(item.email);
  const itemPhone = normalizeRescheduleContact(item.phone);
  return Boolean(
    itemEmail && itemPhone && itemEmail === email && itemPhone === phone,
  );
}

function matchesNotificationContact(item, email, phone) {
  if (item.kind !== "appointment") return false;
  const itemEmail = normalizeRescheduleContact(item.email);
  const itemPhone = normalizeRescheduleContact(item.phone);
  if (!itemEmail || itemEmail !== email) return false;
  return !itemPhone || !phone || itemPhone === phone;
}

function notificationResultFromRecord(notification) {
  const channel = notification.kind.includes("admin") ? "admin" : notification.kind.includes("coach") ? "coach" : "client";
  return {
    channel,
    recipient: notification.recipient,
    subject: notification.subject,
    kind: notification.kind,
    status: notification.status,
    sent: ["sent", "delivered", "opened", "clicked"].includes(
      notification.status || "",
    ),
    id: notification.providerId,
    reason: notification.error,
  };
}

function clientNotificationResults(results = []) {
  return results.filter(
    (result) =>
      result?.channel === "client" ||
      cleanString(result?.kind, "", 120).includes("client_email"),
  );
}

function clientNotificationRecords(records = [], appointmentId = "") {
  return records.filter(
    (record) =>
      (!appointmentId || record.calendarItemId === appointmentId) &&
      cleanString(record.kind, "", 120).includes("client_email"),
  );
}

async function triggerPublicBookingNotifications(payload) {
  const appointmentId = cleanString(
    payload?.appointmentId || payload?.appointment || "",
    "",
    120,
  );
  const email = normalizeRescheduleContact(payload?.email);
  const phone = normalizeRescheduleContact(payload?.phone);
  const kind = payload?.kind === "reschedule" ? "reschedule" : "booking";

  if (!appointmentId || !email) {
    throw Object.assign(new Error("Booking email details are missing."), {
      status: 400,
    });
  }

  const state = await readPublicCatalogState();
  const workspaceAccount = publicWorkspaceAccount(state);
  assertAccountFeature(workspaceAccount, "publicBooking");
  const appointment = await readPublicAppointmentById(appointmentId, workspaceAccount.id);
  if (!appointment || !matchesNotificationContact(appointment, email, phone)) {
    throw Object.assign(
      new Error("That booking could not be verified for email notification."),
      { status: 404 },
    );
  }

  const existing = clientNotificationRecords(
    await readNotificationHistoryForAppointment(appointmentId),
    appointmentId,
  ).filter((notification) => notification.kind.startsWith(`${kind}_`));
  const alreadySent = existing.some(
    (notification) => notification.status === "sent",
  );
  if (alreadySent) {
    return {
      ok: true,
      alreadySent: true,
      results: existing.map(notificationResultFromRecord),
    };
  }

  const results = clientNotificationResults(
    await sendBookingNotifications(appointment, { kind }),
  );
  return {
    ok: results.some((result) => result.sent),
    alreadySent: false,
    results,
    notifications: clientNotificationRecords(
      await readNotificationHistoryForAppointment(appointmentId),
      appointmentId,
    ),
  };
}

async function lookupPublicReschedule(payload) {
  const rawEmail = cleanString(payload?.email, "", 180).toLowerCase();
  const email = normalizeRescheduleContact(payload?.email);
  const phone = normalizeRescheduleContact(payload?.phone);
  if (!email || !phone) {
    throw Object.assign(
      new Error("Enter the email and phone number used on the booking."),
      { status: 400 },
    );
  }

  const state = await readPublicCatalogState();
  const workspaceAccount = publicWorkspaceAccount(state);
  assertAccountFeature(workspaceAccount, "publicBooking");
  const accountState = {
    ...state,
    services: (state.services || []).filter((service) => recordBelongsToAccount(service, workspaceAccount.id)),
  };
  const serviceList = accountState.services || defaultServices;
  const itemRead = await readPublicAppointmentsForContact({
    accountId: workspaceAccount.id,
    email: rawEmail,
    phone,
  });
  console.info("public_reschedule_lookup:items_read", {
    accountId: workspaceAccount.id,
    rowsFetched: itemRead.rowsFetched,
    itemCount: itemRead.items.length,
    queryMode: itemRead.queryMode,
  });
  const matches = itemRead.items
    .sort(
      (a, b) => itemWeek(a) - itemWeek(b) || a.day - b.day || a.start - b.start,
    )
    .map((item) => publicRescheduleItem(item, serviceList));

  return { matches };
}

async function reschedulePublicBooking(payload, context = null) {
  const appointmentId = cleanString(payload?.appointmentId, "", 120);
  const email = normalizeRescheduleContact(payload?.email);
  const phone = normalizeRescheduleContact(payload?.phone);
  const week = Number(payload?.week ?? 0);
  const day = Number(payload?.day);
  const start = Number(payload?.start);

  if (!appointmentId || !email || !phone) {
    throw Object.assign(new Error("Choose the booking to reschedule."), {
      status: 400,
    });
  }
  if (
    !Number.isInteger(week) ||
    !Number.isInteger(day) ||
    !Number.isInteger(start) ||
    day < 0 ||
    day > 6
  ) {
    throw Object.assign(new Error("Choose a valid new appointment time."), {
      status: 400,
    });
  }

  const state = await readPublicCatalogState();
  const workspaceAccount = publicWorkspaceAccount(state);
  assertAccountFeature(workspaceAccount, "publicBooking");
  const accountState = {
    ...state,
    items: [],
    services: (state.services || []).filter((service) => recordBelongsToAccount(service, workspaceAccount.id)),
    coaches: (state.coaches || []).filter((coach) => recordBelongsToAccount(coach, workspaceAccount.id)),
    locations: (state.locations || []).filter((location) => recordBelongsToAccount(location, workspaceAccount.id)),
    availability: (state.availability || []).map((day) => day.filter((window) => recordBelongsToAccount(window, workspaceAccount.id))),
  };
  const appointment = await readPublicAppointmentById(appointmentId, workspaceAccount.id);
  if (!appointment || !matchesRescheduleContact(appointment, email, phone)) {
    throw Object.assign(new Error("That booking could not be verified."), {
      status: 404,
    });
  }

  const serviceList = accountState.services || defaultServices;
  const service = serviceList.find(
    (candidate) => candidate.id === appointment.serviceId,
  );
  const duration = service?.duration || appointment.duration;
  const serviceCoachId = appointment.coachId || service?.coachId || defaultCoachId(accountState.coaches || []);
  const slot = { week, day, start, duration };
  const itemRead = await readPublicSlotItemsForWeek({ accountId: workspaceAccount.id, week });
  const accountItems = (itemRead.items || []).filter((item) => recordBelongsToAccount(item, workspaceAccount.id));
  const requestedWeekItems = publicSlotRequestedWeekItems(accountItems, week);
  const relevantResourceItems = service
    ? publicSlotRelevantResourceItems(requestedWeekItems, service, accountState)
    : requestedWeekItems;
  accountState.items = relevantResourceItems;
  console.info("public_reschedule:items_read", {
    accountId: workspaceAccount.id,
    appointmentId,
    week,
    rowsFetched: itemRead.rowsFetched,
    requestedWeekItemCount: requestedWeekItems.length,
    relevantResourceItemCount: relevantResourceItems.length,
    queryMode: itemRead.queryMode,
  });
  const itemsWithoutOriginal = relevantResourceItems.filter(
    (item) => item.id !== appointment.id,
  );
  if (
    !service ||
    !service.active ||
    service.lessonFormat === "package" ||
    (isScheduledGroupService(service)
      ? !isGroupServiceSlotMatch(service, slot)
      : !isInsideAvailability(
          accountState.availability || defaultAvailability,
          day,
          start,
          duration,
          serviceCoachId,
        ) ||
        !Number.isInteger(duration)) ||
    hasCollision(itemsWithoutOriginal, slot, service, accountState)
  ) {
    throw Object.assign(new Error("That time is no longer available."), {
      status: 409,
    });
  }

  const updatedAppointment = {
    ...appointment,
    week,
    day,
    start,
    duration,
    note: appointment.note || "Rescheduled from public booking page.",
  };
  await writePublicBookingAppointment(
    state,
    updatedAppointment,
    context,
  );
  let notifications = [];
  try {
    notifications = await notifyBookingEvent({
      action: "rescheduled",
      appointment: updatedAppointment,
      previousAppointment: appointment,
      source: "public-reschedule",
    });
  } catch (error) {
    console.error("public_reschedule:notification_failed", error);
  }

  return { appointment: updatedAppointment, notifications };
}

async function cancelPublicBooking(payload) {
  const appointmentId = cleanString(payload?.appointmentId, "", 120);
  const email = normalizeRescheduleContact(payload?.email);
  const phone = normalizeRescheduleContact(payload?.phone);

  if (!appointmentId || !email || !phone) {
    throw Object.assign(new Error("Choose the booking to cancel."), {
      status: 400,
    });
  }

  const state = await readPublicCalendarState();
  const workspaceAccount = publicWorkspaceAccount(state);
  assertAccountFeature(workspaceAccount, "publicBooking");
  const appointment = state.items.find((item) => recordBelongsToAccount(item, workspaceAccount.id) && item.id === appointmentId);
  if (!appointment || !matchesRescheduleContact(appointment, email, phone)) {
    throw Object.assign(new Error("That booking could not be verified."), {
      status: 404,
    });
  }

  const nextState = await writePublicBookingState(
    state,
    state.items.filter((item) => item.id !== appointment.id),
  );

  let notifications = [];
  try {
    notifications = await notifyBookingEvent({
      action: "cancelled",
      appointment,
      previousAppointment: appointment,
      source: "public-cancel",
    });
  } catch (error) {
    console.error("public_cancel:notification_failed", error);
  }

  return { appointment, notifications, state: nextState };
}

export async function handlePublicRescheduleLookupRequest(req) {
  try {
    return json(await lookupPublicReschedule(await parseBody(req)));
  } catch (error) {
    console.error("public_reschedule_lookup:failed", error);
    const status = error?.status || 500;
    return json(
      {
        error:
          status === 500 ? "public_reschedule_lookup_error" : "request_error",
        message:
          error instanceof Error
            ? error.message
            : "Unknown public reschedule lookup error",
      },
      status,
    );
  }
}

export async function handlePublicRescheduleRequest(req, context = null) {
  try {
    const result = await reschedulePublicBooking(await parseBody(req), context);
    return json({
      ok: true,
      appointment: {
        id: result.appointment.id,
        week: result.appointment.week,
        day: result.appointment.day,
        start: result.appointment.start,
        duration: result.appointment.duration,
        location: result.appointment.location,
      },
      notifications: clientNotificationResults(result.notifications),
    });
  } catch (error) {
    console.error("public_reschedule:failed", error);
    const status = error?.status || 500;
    return json(
      {
        error: status === 500 ? "public_reschedule_error" : "request_error",
        message:
          error instanceof Error
            ? error.message
            : "Unknown public reschedule error",
      },
      status,
    );
  }
}

export async function handlePublicCancelRequest(req) {
  try {
    if (req.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }
    const result = await cancelPublicBooking(await parseBody(req));
    return json({
      ok: true,
      appointment: {
        id: result.appointment.id,
        week: result.appointment.week,
        day: result.appointment.day,
        start: result.appointment.start,
        duration: result.appointment.duration,
      },
      state: { items: publicBookingState(result.state).items },
      notifications: clientNotificationResults(result.notifications),
    });
  } catch (error) {
    console.error("public_cancel:failed", error);
    const status = error?.status || 500;
    return json(
      {
        error: status === 500 ? "public_cancel_error" : "request_error",
        message:
          error instanceof Error
            ? error.message
            : "Unknown public cancellation error",
      },
      status,
    );
  }
}

function serviceName(serviceId, serviceList = defaultServices) {
  return (
    serviceList.find((service) => service.id === serviceId)?.name ??
    "Golf Lesson"
  );
}

function escapeText(value) {
  return String(value || "")
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,");
}

function foldLine(line) {
  const chunks = [];
  let remaining = line;
  while (remaining.length > 75) {
    chunks.push(remaining.slice(0, 75));
    remaining = remaining.slice(75);
  }
  chunks.push(remaining);
  return chunks.join("\r\n ");
}

function formatUtcStamp(date = new Date()) {
  return date
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/, "Z");
}

function dateForSlot(week, day) {
  const date = new Date(baseWeekStart);
  date.setUTCDate(baseWeekStart.getUTCDate() + week * 7 + day);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatLocalDateTime(week, day, minutes) {
  const date = dateForSlot(week, day);
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${date.year}${pad(date.month)}${pad(date.day)}T${pad(hour)}${pad(minute)}00`;
}

function eventDescription(item, serviceList, location) {
  const rows =
    item.kind === "block"
      ? ["Blocked time", item.note]
      : [
          serviceName(item.serviceId, serviceList),
          location?.address ? `Address: ${location.address}` : "",
          location?.arrivalInstructions ? `Arrival: ${location.arrivalInstructions}` : "",
          location?.mapUrl ? `Map: ${location.mapUrl}` : "",
          item.phone ? `Phone: ${item.phone}` : "",
          item.email ? `Email: ${item.email}` : "",
          item.note,
        ];
  return rows.filter(Boolean).join("\n");
}

function eventSummary(item, account, serviceList) {
  if (item.kind === "block") return `Busy - ${account.businessName}`;
  return `${item.client || item.title} - ${serviceName(item.serviceId, serviceList)}`;
}

function generateCalendarFeed(state) {
  const stamp = formatUtcStamp();
  const account = cleanCoachAccount(state.account);
  const timezone = account.timezone;
  const serviceList = state.services || defaultServices;
  const locationList = normalizeLocations(state.locations || [], account);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Clarity Golf//Booking System//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(account.businessName)} Bookings`,
    `X-WR-TIMEZONE:${timezone}`,
    "X-PUBLISHED-TTL:PT5M",
    "REFRESH-INTERVAL;VALUE=DURATION:PT5M",
  ];

  state.items
    .slice()
    .sort(
      (a, b) => itemWeek(a) - itemWeek(b) || a.day - b.day || a.start - b.start,
    )
    .forEach((item) => {
      const week = itemWeek(item);
      const service = serviceList.find((candidate) => candidate.id === item.serviceId);
      const location = calendarItemLocation(item, service, locationList, account);
      lines.push(
        "BEGIN:VEVENT",
        `UID:${escapeText(item.id)}@clarity-golf-booking`,
        `DTSTAMP:${stamp}`,
        `DTSTART;TZID=${location?.timezone || timezone}:${formatLocalDateTime(week, item.day, item.start)}`,
        `DTEND;TZID=${location?.timezone || timezone}:${formatLocalDateTime(week, item.day, item.start + item.duration)}`,
        `SUMMARY:${escapeText(eventSummary(item, account, serviceList))}`,
        `DESCRIPTION:${escapeText(eventDescription(item, serviceList, location))}`,
        `LOCATION:${escapeText(bookingLocationDisplay(location))}`,
        `ORGANIZER;CN=${escapeText(account.businessName)}:MAILTO:${account.contactEmail}`,
        item.kind === "block" ? "CATEGORIES:Busy" : "CATEGORIES:Golf Lesson",
        "STATUS:CONFIRMED",
        "TRANSP:OPAQUE",
        "END:VEVENT",
      );
    });

  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

async function parseBody(req) {
  const raw = await req.text();
  return raw ? JSON.parse(raw) : {};
}

export async function handleBookingApiRoute(
  req: Request,
  forcedPathname = "",
  context = null,
) {
  const url = new URL(req.url);
  const rawPathname = url.pathname;
  const pathname = forcedPathname
    ? forcedPathname
    : rawPathname === "/.netlify/functions/booking-api"
      ? "/"
      : rawPathname;

  try {
    // A browser with no session cookie should reach the login form immediately.
    // Avoid running the full calendar/settings seed path for this read-only check.
    if (
      req.method === "GET" &&
      pathname === "/api/auth/session" &&
      !sessionTokenFromRequest(req)
    ) {
      return json({ authenticated: false });
    }

    if (req.method === "GET" && pathname === "/api/public-booking-state") {
      return handlePublicBookingStateRequest();
    }

    if (req.method === "GET" && pathname === "/api/public-booking-catalog") {
      return handlePublicBookingCatalogRequest();
    }

    if (req.method === "GET" && pathname === "/api/public-booking-slots") {
      return handlePublicBookingSlotsRequest(req);
    }

    if (req.method === "POST" && pathname === "/api/public-booking") {
      return handlePublicBookingRequest(req, context);
    }

    if (req.method === "GET" && pathname === "/api/public-notification-status") {
      return handlePublicNotificationStatusRequest(req);
    }

    if (
      req.method === "POST" &&
      pathname === "/api/public-booking-notifications"
    ) {
      return json(
        await triggerPublicBookingNotifications(await parseBody(req)),
      );
    }

    if (pathname.startsWith("/api/auth/")) {
      await ensureAuthReady();
    } else {
      await ensureSeeded();
    }

    if (
      req.method === "GET" &&
      /^\/calendar\/[a-z0-9-]+\.ics$/.test(pathname)
    ) {
      return handleCalendarFeedRequest(req);
    }

    if (req.method === "POST" && pathname === "/api/auth/login") {
      const body = await parseBody(req);
      const user = await verifyAdminPassword(body.email || "", body.password || "");
      if (!user) return json({ error: "invalid_login", message: "Email or password is incorrect." }, 401);
      const session = await createAdminSession(user);
      return json(
        {
          authenticated: true,
          email: user.email,
          expiresAt: session.expiresAt,
        },
        200,
        { "Set-Cookie": cookieHeader(session.token, req, 7 * 24 * 60 * 60) },
      );
    }

    if (req.method === "POST" && pathname === "/api/auth/forgot-password") {
      const emailConfigured = Boolean(env("RESEND_API_KEY"));
      if (!emailConfigured) {
        return json(
          {
            ok: false,
            message: "Password reset email is not configured yet.",
          },
          503,
        );
      }

      await cleanupExpiredPasswordResets();
      const body = await parseBody(req);
      const reset = await createPasswordReset(body.email || "");
      if (reset) {
        const emailResult = await sendPasswordResetEmail(reset, req);
        if (!emailResult.sent) {
          return json(
            {
              ok: false,
              message: "Could not send the reset email. Try again in a minute.",
            },
            502,
          );
        }
      }

      return json({
        ok: true,
        message:
          "If that email matches an admin account, a reset link has been sent.",
      });
    }

    if (req.method === "POST" && pathname === "/api/auth/reset-password") {
      await cleanupExpiredPasswordResets();
      const body = await parseBody(req);
      const result = await resetAdminPassword(
        body.token || "",
        body.password || "",
      );
      if (result.error === "weak_password") {
        return json(
          { error: "weak_password", message: "Use at least 8 characters." },
          400,
        );
      }
      if (!result.user) {
        return json(
          {
            error: "invalid_token",
            message: "This reset link has expired or has already been used.",
          },
          400,
        );
      }
      const session = await createAdminSession(result.user);
      return json(
        {
          authenticated: true,
          email: result.user.email,
          expiresAt: session.expiresAt,
        },
        200,
        { "Set-Cookie": cookieHeader(session.token, req, 7 * 24 * 60 * 60) },
      );
    }

    if (req.method === "POST" && pathname === "/api/auth/change-password") {
      const currentSession = await requireAdmin(req);
      if (!currentSession)
        return json(
          { error: "unauthorized", message: "Admin login required." },
          401,
        );
      const body = await parseBody(req);
      const result = await changeAdminPassword(
        currentSession,
        body.currentPassword || "",
        body.newPassword || "",
      );
      if (result.error === "weak_password") {
        return json(
          { error: "weak_password", message: "Use at least 8 characters." },
          400,
        );
      }
      if (result.error === "invalid_current_password") {
        return json(
          {
            error: "invalid_current_password",
            message: "Current password is incorrect.",
          },
          400,
        );
      }
      if (!result.user) {
        return json(
          {
            error: "change_password_failed",
            message: "Could not change password.",
          },
          400,
        );
      }
      const session = await createAdminSession(result.user);
      return json(
        {
          authenticated: true,
          email: result.user.email,
          expiresAt: session.expiresAt,
        },
        200,
        { "Set-Cookie": cookieHeader(session.token, req, 7 * 24 * 60 * 60) },
      );
    }

    if (req.method === "POST" && pathname === "/api/auth/logout") {
      await destroyAdminSession(sessionTokenFromRequest(req));
      return json({ authenticated: false }, 200, {
        "Set-Cookie": clearCookieHeader(),
      });
    }

    if (req.method === "GET" && pathname === "/api/auth/session") {
      const session = await readAdminSession(sessionTokenFromRequest(req));
      return json(
        session
          ? { authenticated: true, email: session.email }
          : { authenticated: false },
      );
    }

    if (req.method === "GET" && pathname === "/api/public-booking-state") {
      return handlePublicBookingStateRequest();
    }

    if (req.method === "GET" && pathname === "/api/public-booking-catalog") {
      return handlePublicBookingCatalogRequest();
    }

    if (req.method === "GET" && pathname === "/api/public-booking-slots") {
      return handlePublicBookingSlotsRequest(req);
    }

    if (req.method === "POST" && pathname === "/api/public-booking") {
      return handlePublicBookingRequest(req, context);
    }

    if (req.method === "GET" && pathname === "/api/public-notification-status") {
      return handlePublicNotificationStatusRequest(req);
    }

    if (
      req.method === "POST" &&
      pathname === "/api/public-booking-notifications"
    ) {
      return json(
        await triggerPublicBookingNotifications(await parseBody(req)),
      );
    }

    if (req.method === "POST" && pathname === "/api/public-cancel") {
      return handlePublicCancelRequest(req);
    }

    if (req.method === "GET" && pathname === "/api/public-diagnostics") {
      return json(await runPublicDiagnostics());
    }

    if (
      req.method === "GET" &&
      pathname === "/api/public-serialization-diagnostics"
    ) {
      return json(await runPublicSerializationDiagnostics());
    }

    if (req.method === "GET" && pathname === "/api/database-health") {
      return json(await runDatabaseHealth());
    }

    if (pathname.startsWith("/api/")) {
      if (!(await requireAdmin(req)))
        return json(
          { error: "unauthorized", message: "Admin login required." },
          401,
        );
    }

    if (req.method === "GET" && pathname === "/api/calendar-state") {
      const state = await readAdminCalendarShellState();
      const requestContext = await resolveBackendRequestContext(req, state);
      return json(publicCalendarState(filterCalendarStateForContext(state, requestContext)));
    }

    if (req.method === "PUT" && pathname === "/api/calendar-state") {
      const body = await parseBody(req);
      const current = await readCalendarState();
      const action = cleanString(body?.action, "", 120);
      if (action === "complete_lesson") {
        const startAt = Date.now();
        const requestContext = await resolveBackendRequestContext(req, current);
        const itemId = cleanString(body?.itemId, "", 140);
        const timedDetails = {
          action: "lesson_complete",
          itemId,
          calendarId: current.account?.id || "",
          route: "PUT /api/calendar-state",
          operationOwner: "lesson_complete",
          accountId: requestContext.accountId || "",
        };
        console.info("lesson_complete_started", {
          ...timedDetails,
          expectedStatus: "completed",
          expectedRevision: cleanString(body?.updatedAt, "", 140),
          httpStatus: 0,
        });
        try {
          const response = await completeCalendarItemById(
            current,
            itemId,
            requestContext,
          );
          const durationMs = Date.now() - startAt;
          console.info("lesson_complete_saved", {
            ...timedDetails,
            httpStatus: 200,
            backendUpdatedAt: response.updatedAt || current.updatedAt,
            itemId,
            itemStatus: "completed",
            durationMs,
            stageTimings: response.stageTimings || {
              totalMs: durationMs,
            },
          });
          return json(response);
        } catch (error) {
          const durationMs = Date.now() - startAt;
          const diagnostics = lessonCompleteActionFailure(
            error,
            timedDetails,
            durationMs,
          );
          console.error("lesson_complete_failed", diagnostics);
          return json(
            {
              error: diagnostics.errorCode,
              message: diagnostics.backendMessage,
              ...diagnostics,
            },
            diagnostics.httpStatus || 500,
          );
        }
      }
      const requestContext = await resolveBackendRequestContext(req, current);
      const nextState = await writeCalendarState({
        syncKey:
          typeof body.syncKey === "string" ? body.syncKey : current.syncKey,
        items: Array.isArray(body.items) ? body.items : current.items,
        replaceItems: body.replaceItems === true,
        clearItems: body.clearItems === true,
        itemsOperation: body.itemsOperation,
        updatedAt: typeof body.updatedAt === "string" ? body.updatedAt : "",
      }, requestContext);
      let notificationResults = [];
      let notificationWarning = "";
      try {
        notificationResults = await processAdminNotificationDebounce(
          current.items,
          nextState.items,
          { timeZone: nextState.account?.timezone },
        );
      } catch (error) {
        notificationWarning =
          "Calendar saved, but booking alerts could not be processed.";
        console.error("calendar_state:notification_failed", error);
      }
      const existingWarnings = Array.isArray(nextState.warnings)
        ? nextState.warnings
        : [];
      return json({
        ...publicCalendarState({
          ...nextState,
          notifications: await readNotificationHistory(),
        }),
        notificationResults,
        ...(notificationWarning
          ? { warnings: [...new Set([...existingWarnings, notificationWarning])] }
          : {}),
      });
    }

    if (req.method === "DELETE" && pathname === "/api/calendar-state") {
      const current = await readCalendarState();
      const requestContext = await resolveBackendRequestContext(req, current);
      const calendarItemId = cleanString(url.searchParams.get("id"), "", 140);
      const targetItem = current.items.find((item) => item.id === calendarItemId) || {};
      const startedAt = Date.now();
      const baseDetails = {
        action: "delete_calendar_item",
        route: "DELETE /api/calendar-state",
        verificationRoute: "GET /api/calendar-state",
        operationOwner: "calendar_delete",
        bookingId: calendarItemId,
        calendarItemId,
        personId: cleanString(targetItem.personId || targetItem.person?.id, "", 120),
        email: normalizedPersonEmail(targetItem.email),
        accountId: requestContext.accountId || "",
        targetedDelete: true,
      };
      console.info("BOOKING_DELETE_STARTED", baseDetails);
      console.info("BOOKING_DELETE_VERIFY_STARTED", {
        ...baseDetails,
        route: "GET /api/calendar-state",
        operationOwner: "calendar_reload_verify",
      });
      try {
        const nextState = await deleteCalendarItemById(calendarItemId, requestContext);
        const verificationResult = nextState.items.some((item) => item.id === calendarItemId)
          ? "found"
          : "not_found";
        if (verificationResult !== "not_found") {
          throw Object.assign(new Error("Deleted calendar item was returned by the next calendar read."), {
            code: "BOOKING_DELETE_VERIFY_FAILED",
            status: 409,
            operationOwner: "calendar_reload_verify",
            route: "GET /api/calendar-state",
          });
        }
        const durationMs = Date.now() - startedAt;
        console.info("BOOKING_DELETE_COMPLETED", {
          ...baseDetails,
          httpStatus: 200,
          durationMs,
          verificationResult,
        });
        console.info("BOOKING_DELETE_VERIFY_COMPLETED", {
          ...baseDetails,
          route: "GET /api/calendar-state",
          operationOwner: "calendar_reload_verify",
          httpStatus: 200,
          durationMs,
          verificationResult,
        });
        let notificationResults = [];
        let notificationWarning = "";
        try {
          notificationResults = await processAdminNotificationDebounce(
            current.items,
            nextState.items,
            { timeZone: nextState.account?.timezone },
          );
        } catch (error) {
          notificationWarning =
            "Calendar saved, but booking alerts could not be processed.";
          console.error("calendar_state:notification_failed", error);
        }
        const existingWarnings = Array.isArray(nextState.warnings)
          ? nextState.warnings
          : [];
        return json({
          ...publicCalendarState({
            ...nextState,
            notifications: await readNotificationHistory(),
          }),
          notificationResults,
          ...(notificationWarning
            ? { warnings: [...new Set([...existingWarnings, notificationWarning])] }
            : {}),
          diagnostics: {
            code: "BOOKING_DELETE_VERIFY_COMPLETED",
            ...baseDetails,
            route: "GET /api/calendar-state",
            operationOwner: "calendar_reload_verify",
            httpStatus: 200,
            durationMs,
            verificationResult,
          },
        });
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        const failure = deleteFailureDiagnostics(error, baseDetails, durationMs);
        if (failure.operationOwner === "people_patch") {
          console.error("BOOKING_DELETE_OWNERSHIP_VIOLATION", failure);
        }
        console.error(failure.errorCode === "BOOKING_DELETE_VERIFY_FAILED" ? "BOOKING_DELETE_VERIFY_FAILED" : "BOOKING_DELETE_FAILED", failure);
        return json(
          {
            error: failure.errorCode,
            message: deleteUserMessage(failure.operationOwner, failure.errorCode),
            detail: failure.backendMessage,
            diagnostics: {
              code: failure.errorCode,
              ...failure,
            },
          },
          failure.httpStatus || 500,
        );
      }
    }

    if (req.method === "POST" && pathname === "/api/admin-notification-debounce") {
      const state = await readCalendarState();
      const requestContext = await resolveBackendRequestContext(req, state);
      let notificationResults = [];
      let notificationWarning = "";
      try {
        notificationResults = await processAdminNotificationDebounce(
          state.items,
          state.items,
          { queueDiffs: false, timeZone: state.account?.timezone },
        );
      } catch (error) {
        notificationWarning =
          "Booking alerts could not be processed.";
        console.error("calendar_state:notification_debounce_failed", error);
      }
      const refreshedState = notificationResults.length ? await readCalendarState() : state;
      return json({
        notifications: filterNotificationsForContext(
          await readNotificationHistory(),
          requestContext,
          refreshedState,
        ),
        notificationResults,
        ...(notificationWarning ? { warnings: [notificationWarning] } : {}),
      });
    }

    if (req.method === "PUT" && pathname === "/api/calendar-sync-key") {
      const body = await parseBody(req);
      const current = await readCalendarState();
      const requestContext = await resolveBackendRequestContext(req, current);
      assertAccountAdminContext(requestContext, "You do not have permission to rotate the calendar sync key.");
      return json(
        publicCalendarState(
          await writeCalendarState({
            ...current,
            syncKey:
              typeof body.syncKey === "string" && body.syncKey.startsWith("cg_")
                ? body.syncKey
                : generateSyncKey(),
          }),
        ),
      );
    }

    if (req.method === "GET" && pathname === "/api/admin-settings") {
      const state = await readCalendarState();
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountAdminContext(requestContext, "You do not have permission to view account settings.");
      return json(await readAdminSettings());
    }

    if ((req.method === "PUT" || req.method === "POST") && pathname === "/api/admin-settings") {
      const state = await readCalendarState();
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountAdminContext(requestContext, "You do not have permission to change account settings.");
      return json(await writeAdminSettings(await parseBody(req)));
    }

    if (req.method === "GET" && pathname === "/api/notification-history") {
      const state = await readCalendarState();
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "notifications");
      return json({ notifications: filterNotificationsForContext(await readNotificationHistory(), requestContext, state) });
    }

    if (req.method === "POST" && pathname === "/api/booking-confirmation-resend") {
      const body = await parseBody(req);
      const state = await readCalendarState();
      const requestContext = await resolveBackendRequestContext(req, state);
      return json(await resendBookingConfirmation(body.appointmentId || body.id, requestContext, state));
    }

    if (req.method === "POST" && pathname === "/api/test-email") {
      const body = await parseBody(req);
      const state = await readCalendarState();
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountAdminContext(requestContext, "You do not have permission to send test emails.");
      assertAccountFeature(requestContext.account, "notifications");
      const recipient = cleanEmail(body.email, "");
      if (!recipient)
        return json(
          {
            error: "missing_email",
            message: "Enter an email address to send the test to.",
          },
          400,
        );
      const services = state.services;
      const service =
        services.find((candidate) => candidate.active) || defaultServices[0];
      const appointment = {
        id: `test-${Date.now()}`,
        accountId: requestContext.account.id,
        kind: "appointment",
        week: 0,
        day: 0,
        start: 14 * 60,
        duration: service.duration,
        serviceId: service.id,
        client: "Donna Steele",
        title: "Donna Steele",
        email: recipient,
        phone: "+64 27 555 014",
        note: "Test email from Clarity Golf Booking.",
      };
      const results = await sendBookingNotifications(appointment, {
        kind: "test",
        testRecipient: recipient,
      });
      const sent = results.some((result) => result.sent);
      const missingResendKey = results.some(
        (result) => result.reason === "missing_resend_key",
      );
      return json(
        {
          ok: sent,
          results,
          message: sent
            ? "Test email sent."
            : missingResendKey
              ? "Test email could not be sent because the Resend API key is missing in production."
              : "Test email could not be sent. Check Resend settings.",
        },
        sent ? 200 : 502,
      );
    }

    if (req.method === "GET" && pathname === "/api/coach-account") {
      return json(await readCoachAccount());
    }

    if (req.method === "PUT" && pathname === "/api/coach-account") {
      const body = await parseBody(req);
      const state = await readCalendarState();
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountAdminContext(requestContext, "You do not have permission to change business account settings.");
      if (body?.invoiceSettings?.enabled) assertAccountFeature(requestContext.account, "invoicing");
      return json(await writeCoachAccount(body));
    }

    if (req.method === "GET" && pathname === "/api/services") {
      const state = await readCalendarState();
      const requestContext = await resolveBackendRequestContext(req, state);
      return json({
        services: state.services.filter((service) => serviceBelongsToContext(service, requestContext, state.coaches)),
      });
    }

    if (req.method === "PUT" && pathname === "/api/services") {
      const body = await parseBody(req);
      const state = await readCalendarState();
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "services");
      const nextServices = mergeServicesForContext(body.services || [], state.services, requestContext, state.coaches);
      const savedServices = await writeServices(nextServices, requestContext);
      return json({
        services: savedServices.filter((service) => serviceBelongsToContext(service, requestContext, state.coaches)),
      });
    }

    if (req.method === "GET" && pathname === "/api/locations") {
      const state = await readColdSetupState();
      const requestContext = await resolveBackendRequestContext(req, state);
      return json({ locations: filterLocationsForContext(state.locations, requestContext, state.coaches) });
    }

    if (req.method === "PUT" && pathname === "/api/locations") {
      const body = await parseBody(req);
      const state = await readCalendarState();
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountAdminContext(requestContext, "You do not have permission to manage locations.");
      return json({ locations: await writeLocations(body.locations, requestContext) });
    }

    if (req.method === "GET" && pathname === "/api/coaches") {
      const state = await readColdSetupState();
      const requestContext = await resolveBackendRequestContext(req, state);
      return json({
        coaches: filterCoachesForContext(state.coaches, requestContext),
        currentUser: requestContext.user,
      });
    }

    if (req.method === "PUT" && pathname === "/api/coaches") {
      const body = await parseBody(req);
      const state = await readCalendarState();
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountAdminContext(requestContext, "You do not have permission to manage coaches.");
      return json({ coaches: await writeCoachProfiles(body.coaches, requestContext) });
    }

    if (req.method === "GET" && pathname === "/api/availability") {
      const state = await readCalendarState();
      const requestContext = await resolveBackendRequestContext(req, state);
      const fallbackCoachId = defaultCoachId(state.coaches);
      return json({
        availability: state.availability.map((dayWindows) =>
          dayWindows.filter((window) => availabilityWindowBelongsToContext(window, requestContext, fallbackCoachId)),
        ),
      });
    }

    if (req.method === "PUT" && pathname === "/api/availability") {
      const body = await parseBody(req);
      const state = await readCalendarState();
      const requestContext = await resolveBackendRequestContext(req, state);
      const nextAvailability = mergeAvailabilityForContext(
        body.availability || [],
        state.availability,
        requestContext,
        defaultCoachId(state.coaches),
      );
      const savedAvailability = await writeAvailability(nextAvailability, requestContext);
      const fallbackCoachId = defaultCoachId(state.coaches);
      return json({
        availability: savedAvailability.map((dayWindows) =>
          dayWindows.filter((window) => availabilityWindowBelongsToContext(window, requestContext, fallbackCoachId)),
        ),
      });
    }

    if (req.method === "GET" && pathname === "/api/brand-settings") {
      return json(await readBrandSettings());
    }

    if (req.method === "PUT" && pathname === "/api/brand-settings") {
      const state = await readCalendarState();
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountAdminContext(requestContext, "You do not have permission to change brand settings.");
      assertAccountFeature(requestContext.account, "customBranding");
      return json(await writeBrandSettings(await parseBody(req)));
    }

    if (req.method === "GET" && pathname === "/api/people") {
      const state = await readCalendarState();
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "clients");
      return json({ people: filterPeopleForContext(await readPeople(requestContext.accountId), requestContext, state) });
    }

    if (req.method === "GET" && pathname === "/api/notes") {
      const state = await readCalendarState();
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "clients");
      const playerId = cleanString(url.searchParams.get("playerId"), "", 160);
      const calendarItemId = cleanString(url.searchParams.get("calendarItemId"), "", 160);
      const notes = (await readLessonNotes(requestContext.accountId)).filter(
        (note) =>
          (!playerId || note.playerId === playerId) &&
          (!calendarItemId || note.calendarItemId === calendarItemId),
      );
      return json({ notes });
    }

    if ((req.method === "POST" || req.method === "PUT") && pathname === "/api/notes") {
      const body = await parseBody(req);
      const state = await readCalendarState();
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "clients");
      const result = await upsertLessonNote(body.note || body, requestContext.accountId);
      return json(result, req.method === "POST" ? 201 : 200);
    }

    if (req.method === "DELETE" && pathname === "/api/notes") {
      const state = await readCalendarState();
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "clients");
      const noteId = cleanString(url.searchParams.get("id"), "", 120);
      return json(await deleteLessonNote(noteId, requestContext.accountId));
    }

	    if (req.method === "POST" && (pathname === "/api/people/import" || pathname === "/api/people/import-lite")) {
	      const body = await parseBody(req);
	      const state = await readCalendarState();
	      const requestContext = await resolveBackendRequestContext(req, state);
	      assertAccountAdminContext(requestContext, "You do not have permission to import clients.");
	      assertAccountFeature(requestContext.account, "clients");
      const result = await importPeople(body.people || body.clients || [], body.source || "manual_import", requestContext.accountId);
	      return json(
        {
          ok: true,
          ...result,
          people: filterPeopleForContext(result.people, requestContext, state),
        },
        201,
      );
	    }

    if (req.method === "PUT" && pathname === "/api/people") {
      const body = await parseBody(req);
      const state = await readCalendarState();
      const requestContext = await resolveBackendRequestContext(req, state);
      assertCanManagePerson(requestContext, body.person || body, state);
	      const result = await updatePerson(body.person || body, requestContext.accountId);
      return json({
        ...result,
        people: filterPeopleForContext(result.people, requestContext, state),
      });
    }

    return json({ error: "not_found", message: "Route not found." }, 404);
  } catch (error) {
    const anyError = error as {
      status?: number;
      code?: string;
      operationOwner?: string;
      route?: string;
      personId?: string;
      email?: string;
      expectedUpdatedAt?: string;
      backendUpdatedAt?: string;
      conflictSource?: string;
      details?: unknown;
    };
    const status = anyError?.status || 500;
    return json(
      {
        error: anyError?.code || (status === 500 ? "booking_api_error" : "request_error"),
        message:
          error instanceof Error ? error.message : "Unknown booking API error",
        ...(anyError?.expectedUpdatedAt ? { expectedUpdatedAt: anyError.expectedUpdatedAt } : {}),
        ...(anyError?.backendUpdatedAt ? { backendUpdatedAt: anyError.backendUpdatedAt } : {}),
        ...(anyError?.conflictSource ? { conflictSource: anyError.conflictSource } : {}),
        ...(anyError?.operationOwner ? { operationOwner: anyError.operationOwner } : {}),
        ...(anyError?.route ? { route: anyError.route } : {}),
        ...(anyError?.personId ? { personId: anyError.personId } : {}),
        ...(anyError?.email ? { email: anyError.email } : {}),
        ...(anyError?.details !== undefined ? { details: anyError.details } : {}),
      },
      status,
    );
  }
}
