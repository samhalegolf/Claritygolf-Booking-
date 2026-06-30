import { getDatabase } from "@netlify/database";
import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

import { getGoogleCalendarSyncStatus, syncGoogleCalendarIfEnabled } from "./google-calendar-sync.mts";
import { notifyBookingEvent } from "./notification-engine.mts";

const sessionCookieName = "clarity_session";
const sessionDays = 7;
const passwordResetMinutes = 30;
const baseWeekStart = new Date(Date.UTC(2026, 5, 1));
const MAX_GROUP_OCCURRENCE_COUNT = 52;
const CANCELLED_GROUP_SESSION_TITLE = "Cancelled group session";
const CANCELLED_GROUP_SESSION_NOTE = "__cancelled_group_session__";
const CUSTOM_GROUP_DEFAULTS = {
  baseParticipants: 3,
  basePrice: 200,
  extraPersonPrice: 20,
  minParticipants: 2,
  maxParticipants: 5,
};
const BOOKING_SCREEN_IDS = new Set([
  "main",
  "range-three-kings",
  "group-lessons",
  "private-lessons",
]);
let authReadyPromise = null;
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
        return end > start ? { start, end } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.start - b.start)
      .reduce((merged, window) => {
        const previous = merged.at(-1);
        if (previous && window.start < previous.end) {
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
      kind TEXT NOT NULL,
      week INTEGER NOT NULL DEFAULT 0,
      day INTEGER NOT NULL,
      start INTEGER NOT NULL,
      duration INTEGER NOT NULL,
      service_id TEXT,
      client TEXT,
      title TEXT NOT NULL,
	      phone TEXT,
	      email TEXT,
	      note TEXT,
      custom_group JSONB,
      status TEXT NOT NULL DEFAULT 'booked',
	      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
	    )
	  `;
  await db().sql`ALTER TABLE calendar_items ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'booked'`;
  await db().sql`ALTER TABLE calendar_items ADD COLUMN IF NOT EXISTS custom_group JSONB`;
  await db().sql`
    CREATE INDEX IF NOT EXISTS idx_calendar_items_slot
    ON calendar_items (week, day, start)
  `;
  await db().sql`
    CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY,
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
  if (!authReadyPromise) {
    authReadyPromise = (async () => {
      await ensureAuthTables();
      await ensureAdminUser();
    })().catch((error) => {
      authReadyPromise = null;
      throw error;
    });
  }
  await authReadyPromise;
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
          id, kind, week, day, start, duration, service_id, client, title, phone, email, note, status, created_at, updated_at
	        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW())
	        ON CONFLICT (id) DO NOTHING`,
        [
          item.id,
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
  const email = cleanEmail(env("CLARITY_ADMIN_EMAIL"), "");
  const password = env("CLARITY_ADMIN_PASSWORD");

  if (!email || !password) {
    console.warn(
      "Admin user not seeded because CLARITY_ADMIN_EMAIL or CLARITY_ADMIN_PASSWORD is not set.",
    );
    return;
  }

  const existing = await db()
    .sql`SELECT id FROM admin_users WHERE email = ${email}`;

  const { passwordHash, salt } = hashPassword(password);
  const seedKey = hashToken(`${email}:${password}`);
  if (existing.length) {
    const currentSeedKey = await getSetting("adminPasswordSeedKey");
    if (currentSeedKey === seedKey) return;
    await db().sql`
      UPDATE admin_users
      SET password_hash = ${passwordHash},
          password_salt = ${salt},
          updated_at = NOW()
      WHERE email = ${email}
    `;
    await setSetting("adminPasswordSeedKey", seedKey);
    return;
  }

  await db().sql`
    INSERT INTO admin_users (id, email, password_hash, password_salt, created_at, updated_at)
    VALUES (${randomUUID()}, ${email}, ${passwordHash}, ${salt}, NOW(), NOW())
    ON CONFLICT (email) DO NOTHING
  `;
  await setSetting("adminPasswordSeedKey", seedKey);
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

async function ensureSeeded() {
  await ensureCoreTables();
  await seedSettings();
  await ensureNotificationHistoryTable();
  await seedItems();
  await seedPeopleFromAppointments();
  await ensureAdminUser();
}

function rowToItem(row) {
  const status = ["completed", "cancelled", "no_show"].includes(row.status)
    ? row.status
    : "booked";
  const customGroup = cleanCustomGroupData(row.custom_group);
  const cancelledGroupSession = isCancelledGroupSessionLike(row);
  return {
    id: row.id,
    kind: row.kind,
    week: Number(row.week ?? 0),
    day: Number(row.day ?? 0),
    start: Number(row.start ?? 0),
    duration: Number(row.duration ?? 0),
    serviceId: row.service_id || "",
    client: row.client || "",
    title: row.title,
	    phone: row.phone || "",
	    email: row.email || "",
	    note: row.note || "",
    status: cancelledGroupSession ? "cancelled" : status,
    ...(cancelledGroupSession ? { readOnly: true, groupSlot: true } : {}),
    ...(customGroup || {}),
	  };
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
    kind,
    week: Number.isInteger(Number(item.week)) ? Number(item.week) : 0,
    day,
    start,
    duration,
    serviceId: cleanString(item.serviceId),
    client: cancelledGroupSession ? "" : cleanString(item.client),
    title: cancelledGroupSession
      ? CANCELLED_GROUP_SESSION_TITLE
      : cleanString(item.title, kind === "block" ? "Busy" : "Appointment"),
    phone: cancelledGroupSession ? "" : cleanString(item.phone),
    email: cancelledGroupSession ? "" : cleanString(item.email),
    note: cancelledGroupSession ? CANCELLED_GROUP_SESSION_NOTE : cleanString(item.note),
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

function cleanPerson(person, source = "import") {
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

  const candidateId = cleanString(candidate.id, "", 120);
  if (candidateId && !candidateId.startsWith("appointment-")) {
    const exactId = rows.find((row) => String(row?.id || "") === candidateId);
    if (exactId) return exactId;
  }

  const name = normalizedPersonName(candidate.name);
  const email = normalizedPersonEmail(candidate.email);
  const phone = normalizedPersonPhone(candidate.phone);

  if (name && email) {
    const matches = rows.filter(
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
    const exact = rows.find(
      (row) =>
        normalizedPersonName(row?.name) === name &&
        normalizedPersonPhone(row?.phone) === phone,
    );
    if (exact) return exact;
  }

  // Use a lone contact-method match only when it is unambiguous and names do
  // not conflict. Shared family or organisation details must remain separate.
  if (email) {
    const matches = rows.filter(
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
    const matches = rows.filter(
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

function personFromAppointment(item) {
  if (!item || item.kind !== "appointment") return null;
  return cleanPerson(
    {
      name: item.client || item.title,
      email: item.email,
      phone: item.phone,
      note: item.note,
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

function rowToPerson(row) {
  return {
    id: row.id,
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

async function readPeople() {
  const rows = await db().sql`
    SELECT * FROM people
    ORDER BY LOWER(name), LOWER(email), id
  `;
  return rows.map(rowToPerson);
}

async function importPeople(rawPeople, source = "import") {
  const people = Array.isArray(rawPeople)
    ? rawPeople.map((person) => cleanPerson(person, source)).filter(Boolean)
    : [];
  const result = {
    imported: 0,
    updated: 0,
    skipped: Array.isArray(rawPeople) ? rawPeople.length - people.length : 0,
    people: [],
  };
  if (!Array.isArray(rawPeople)) return result;

  const knownPeople = await readPeople();
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
          ],
        );
        Object.assign(existing, {
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
             id, name, email, phone, notes, source, caddy_profile_id, caddy_profile_url, created_at, updated_at
           ) VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''), $6, NULLIF($7, ''), NULLIF($8, ''), NOW(), NOW())`,
          [
            personId,
            person.name,
            person.email,
            person.phone,
            person.notes,
            person.source || source,
            person.caddyProfileId,
            person.caddyProfileUrl,
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

  result.people = await readPeople();
  return result;
}

async function updatePerson(rawPerson) {
  const person = cleanPerson(rawPerson, "manual_update");
  if (!person) {
    const error = new Error("A person needs a name or email.");
    error.status = 400;
    throw error;
  }

  const knownPeople = await readPeople();
  const existing = compatiblePersonMatch(person, knownPeople);
  const existingId = existing?.id || "";
  const personId =
    existingId ||
    (person.id && !person.id.startsWith("appointment-")
      ? person.id
      : randomUUID());

  const client = await db().pool.connect();
  try {
    await client.query("BEGIN");
    if (existingId) {
      await client.query(
        `UPDATE people
         SET name = $2,
             email = NULLIF($3, ''),
             phone = NULLIF($4, ''),
             notes = NULLIF($5, ''),
             source = COALESCE(NULLIF($6, ''), source),
             caddy_profile_id = NULLIF($7, ''),
             caddy_profile_url = NULLIF($8, ''),
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
        ],
      );
    } else {
      await client.query(
        `INSERT INTO people (
          id, name, email, phone, notes, source, caddy_profile_id, caddy_profile_url, created_at, updated_at
        ) VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''), $6, NULLIF($7, ''), NULLIF($8, ''), NOW(), NOW())`,
        [
          personId,
          person.name,
          person.email,
          person.phone,
          person.notes,
          person.source,
          person.caddyProfileId,
          person.caddyProfileUrl,
        ],
      );
    }

    const saved = await client.query(
      "SELECT * FROM people WHERE id = $1 LIMIT 1",
      [personId],
    );
    await client.query("COMMIT");
    return { person: rowToPerson(saved.rows[0]), people: await readPeople() };
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
      await client.query("DELETE FROM calendar_items");
    }
    for (const item of cleanItems) {
      await client.query(
        `INSERT INTO calendar_items (
          id, kind, week, day, start, duration, service_id, client, title, phone, email, note, status, custom_group, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, NOW(), NOW())
        ON CONFLICT (id) DO UPDATE SET
          kind = EXCLUDED.kind,
          week = EXCLUDED.week,
          day = EXCLUDED.day,
          start = EXCLUDED.start,
          duration = EXCLUDED.duration,
          service_id = EXCLUDED.service_id,
          client = EXCLUDED.client,
          title = EXCLUDED.title,
          phone = EXCLUDED.phone,
          email = EXCLUDED.email,
          note = EXCLUDED.note,
          status = EXCLUDED.status,
          custom_group = EXCLUDED.custom_group,
          updated_at = NOW()`,
        [
          item.id,
          item.kind,
          item.week ?? 0,
          item.day,
          item.start,
          item.duration,
          item.serviceId || "",
          item.client || "",
          item.title,
          item.phone || "",
          item.email || "",
          item.note || "",
          item.status || "booked",
          item.customGroup ? JSON.stringify(cleanCustomGroupData(item)) : null,
        ],
      );
    }
    if (options.replaceItems === true && cleanItems.length) {
      await client.query("DELETE FROM calendar_items WHERE NOT (id = ANY($1::text[]))", [cleanItems.map((item) => item.id)]);
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
  await importPeople(
    initialItems.map(personFromAppointment).filter(Boolean),
    "appointment",
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

async function writeServices(services) {
  const clean = normalizeServices(services);
  await setSetting("servicesJson", JSON.stringify(clean));
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

async function writeAvailability(availability) {
  const clean = normalizeAvailability(availability);
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
  await ensureSeeded();
  let syncKey = await getSetting("syncKey");
  if (!syncKey) {
    syncKey = generateSyncKey();
    await setSetting("syncKey", syncKey);
  }
  return {
    syncKey,
    updatedAt: (await getSetting("updatedAt")) || nowIso(),
    items: await readItems(),
    services: await readServices(),
    availability: await readAvailability(),
    people: await readPeople(),
    notifications: await readNotificationHistory(),
    settings: await readAdminSettings(),
    brand: await readBrandSettings(),
    account: await readCoachAccount(),
    googleCalendar: await getGoogleCalendarSyncStatus(),
  };
}

async function readPublicCalendarState() {
  await ensureSeeded();
  let syncKey = await getSetting("syncKey");
  if (!syncKey) {
    syncKey = generateSyncKey();
    await setSetting("syncKey", syncKey);
  }
  return {
    syncKey,
    updatedAt: (await getSetting("updatedAt")) || nowIso(),
    items: await readItems(),
    services: await readServices(),
    availability: await readAvailability(),
    brand: await readBrandSettings(),
    account: await readCoachAccount(),
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
    return text(
      generateCalendarFeed(state),
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

async function writeCalendarState(nextState) {
  const current = await readCalendarState();
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
      },
    );
  }
  const syncKey = cleanString(nextState?.syncKey, current.syncKey, 140);
  const items = await writeItems(nextState?.items ?? current.items, {
    replaceItems: nextState?.replaceItems === true || nextState?.itemsOperation === "replace",
    clearItems: nextState?.clearItems === true,
  });
  const updatedAt = nowIso();
  await setSetting("syncKey", syncKey);
  await setSetting("updatedAt", updatedAt);
  await importPeople(items.map(personFromAppointment).filter(Boolean), "appointment");
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
    items,
    updatedAt,
    services: current.services,
    availability: current.availability,
    people: await readPeople(),
    notifications: await readNotificationHistory(),
    settings: await readAdminSettings(),
    brand: await readBrandSettings(),
    account: await readCoachAccount(),
    googleCalendar: await getGoogleCalendarSyncStatus(),
    googleCalendarSync,
  };
}

async function writePublicBookingState(currentState, items) {
  const cleanItems = await writeItems(items);
  const updatedAt = nowIso();
  await setSetting("updatedAt", updatedAt);
  await importPeople(cleanItems.map(personFromAppointment).filter(Boolean), "appointment");
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
    await importPeople([personFromAppointment(appointment)].filter(Boolean), "appointment");
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
    availability: state.availability || [],
    people: state.people || [],
    notifications: state.notifications || [],
    settings: state.settings,
    brand: state.brand,
    account: state.account,
    googleCalendar: state.googleCalendar,
    googleCalendarSync: state.googleCalendarSync,
  };
}

export function publicBookingState(state) {
  return {
    updatedAt: state.updatedAt,
    services: (state.services || []).filter(
      (service) =>
        service.active &&
        service.archived !== true &&
        service.visibility === "public" &&
        service.lessonFormat !== "package",
    ),
    availability: state.availability || [],
    brand: state.brand,
    account: state.account,
    items: state.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      week: item.week ?? 0,
      day: item.day,
      start: item.start,
      duration: item.duration,
    })),
  };
}

function queueBookingNotifications(appointment, options = {}, context = null) {
  if (!appointment?.email && options.kind !== "admin") return;
  const task = sendBookingNotifications(appointment, options).catch((error) => {
    console.error("Queued booking notifications failed", error);
  });
  if (context?.waitUntil) {
    context.waitUntil(task);
    return;
  }
  void task;
}

function appointmentSlotSignature(item) {
  return [
    itemWeek(item),
    item.day,
    item.start,
    item.duration,
    item.serviceId || "",
  ].join(":");
}

function appointmentContactSignature(item) {
  return [item.client || item.title || "", item.email || "", item.phone || ""]
    .join(":")
    .toLowerCase();
}

function notificationJobsForCalendarChange(previousItems = [], nextItems = []) {
  const previousById = new Map(
    previousItems
      .filter((item) => item.kind === "appointment")
      .map((item) => [item.id, item]),
  );
  return nextItems
    .filter((item) => item.kind === "appointment" && item.email)
    .map((item) => {
      const previous = previousById.get(item.id);
      if (!previous) return { appointment: item, kind: "booking" };
      if (
        appointmentSlotSignature(previous) !== appointmentSlotSignature(item)
      ) {
        return { appointment: item, kind: "reschedule" };
      }
      if (!previous.email && item.email)
        return { appointment: item, kind: "booking" };
      if (
        appointmentContactSignature(previous) !==
        appointmentContactSignature(item)
      )
        return null;
      return null;
    })
    .filter(Boolean);
}

async function sendCalendarChangeNotifications(
  previousItems = [],
  nextItems = [],
) {
  const results = [];
  for (const { appointment, kind } of notificationJobsForCalendarChange(
    previousItems,
    nextItems,
  )) {
    try {
      results.push(...(await sendBookingNotifications(appointment, { kind })));
    } catch (error) {
      console.error(
        "Calendar change notification failed",
        appointment?.id,
        kind,
        error,
      );
    }
  }
  return results;
}

async function verifyAdminPassword(email, password) {
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

  return {
    id: row.id,
    email: row.email,
    password_hash: row.password_hash,
    password_salt: row.password_salt,
  };
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
      rescheduleUrl ? `Manage or reschedule: ${rescheduleUrl}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    location: account.venueName,
    ctz: account.timezone || "Pacific/Auckland",
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
    venue: account.venueName,
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
  { kind = "booking", testRecipient = "" } = {},
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
    const result = await sendEmail({
      to: recipient,
      subject,
      html,
      text,
      replyTo,
      idempotencyKey: key,
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
  if ((kind === "booking" || kind === "updated") && inviteAttendees.length) {
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

  if (settings.sendCoachEmail && kind !== "test") {
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
  } else if (kind !== "test") {
    const subject = renderTemplate(settings.adminEmailSubject, variables);
    jobs.push(recordSkipped("coach", settings.coachEmail || "", subject, "disabled_in_notification_settings"));
  }

  if (settings.sendAdminEmail && kind !== "test") {
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
  } else if (kind !== "test") {
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
  const userId = typeof userOrId === "object" ? userOrId.id : userOrId;
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000).toISOString();
  await db().sql`
    INSERT INTO admin_sessions (id, token_hash, user_id, expires_at, created_at)
    VALUES (${randomUUID()}, ${tokenHash}, ${userId}, ${expiresAt}, NOW())
  `;
  return { token, expiresAt };
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

function isInsideAvailability(availability, day, start, duration) {
  const end = start + duration;
  return (
    availability[day]?.some(
      (window) => start >= window.start && end <= window.end,
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

function hasCollision(items, candidate, service) {
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
    return overlapping.length > 0;
  }
  const sameServiceCount = overlapping.filter((item) => item.serviceId === service.id).length;
  const blocksOrOtherService = overlapping.some(
    (item) => item.kind !== "appointment" || item.serviceId !== service.id,
  );
  if (blocksOrOtherService) return true;
  return sameServiceCount >= service.capacity;
}

async function createPublicBooking(payload, context = null) {
  const state = await readPublicCalendarState();
  const service = state.services.find(
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
  if (isScheduledGroupService(service)) {
    if (!isGroupServiceSlotMatch(service, slot) || hasCollision(state.items, slot, service)) {
      throw Object.assign(new Error("That time is no longer available."), {
        status: 409,
      });
    }
  } else if (
    !isInsideAvailability(state.availability, day, start, service.duration) ||
    hasCollision(state.items, slot, service)
  ) {
    throw Object.assign(new Error("That time is no longer available."), {
      status: 409,
    });
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
  const appointment = {
    id: `appt-${Date.now()}`,
    kind: "appointment",
    ...slot,
    serviceId: service.id,
    client,
    title: client,
    phone,
    email,
    note: "Booked from public booking page.",
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
    let confirmedAttendee = null;
    let confirmedAppointment = null;
    const nextItems = state.items.map((item) => {
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
    const service = state.services.find((candidate) => candidate.id === confirmedAppointment.serviceId);
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

    const state = await readPublicCalendarState();
    const appointment = state.items.find((item) => item.id === appointmentId);
    if (!appointment || !matchesRescheduleContact(appointment, email, phone)) {
      return json({ sent: false }, 404);
    }

    const history = await readNotificationHistory();
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

  const state = await readPublicCalendarState();
  const appointment = state.items.find((item) => item.id === appointmentId);
  if (!appointment || !matchesNotificationContact(appointment, email, phone)) {
    throw Object.assign(
      new Error("That booking could not be verified for email notification."),
      { status: 404 },
    );
  }

  const existing = clientNotificationRecords(
    await readNotificationHistory(),
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
      await readNotificationHistory(),
      appointmentId,
    ),
  };
}

async function lookupPublicReschedule(payload) {
  const email = normalizeRescheduleContact(payload?.email);
  const phone = normalizeRescheduleContact(payload?.phone);
  if (!email || !phone) {
    throw Object.assign(
      new Error("Enter the email and phone number used on the booking."),
      { status: 400 },
    );
  }

  const state = await readPublicCalendarState();
  const serviceList = state.services || defaultServices;
  const matches = state.items
    .filter((item) => matchesRescheduleContact(item, email, phone))
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

  const state = await readPublicCalendarState();
  const appointment = state.items.find((item) => item.id === appointmentId);
  if (!appointment || !matchesRescheduleContact(appointment, email, phone)) {
    throw Object.assign(new Error("That booking could not be verified."), {
      status: 404,
    });
  }

  const serviceList = state.services || defaultServices;
  const service = serviceList.find(
    (candidate) => candidate.id === appointment.serviceId,
  );
  const duration = service?.duration || appointment.duration;
  const slot = { week, day, start, duration };
  const itemsWithoutOriginal = state.items.filter(
    (item) => item.id !== appointment.id,
  );
  if (
    !service ||
    !service.active ||
    service.lessonFormat === "package" ||
    (isScheduledGroupService(service)
      ? !isGroupServiceSlotMatch(service, slot)
      : !isInsideAvailability(
          state.availability || defaultAvailability,
          day,
          start,
          duration,
        ) ||
        !Number.isInteger(duration)) ||
    hasCollision(itemsWithoutOriginal, slot, service)
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
  await writePublicBookingState(
    state,
    state.items.map((item) =>
      item.id === appointment.id ? updatedAppointment : item,
    ),
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
  const appointment = state.items.find((item) => item.id === appointmentId);
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
      state: { items: result.state.items },
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

function eventDescription(item, serviceList) {
  const rows =
    item.kind === "block"
      ? ["Blocked time", item.note]
      : [
          serviceName(item.serviceId, serviceList),
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
      lines.push(
        "BEGIN:VEVENT",
        `UID:${escapeText(item.id)}@clarity-golf-booking`,
        `DTSTAMP:${stamp}`,
        `DTSTART;TZID=${timezone}:${formatLocalDateTime(week, item.day, item.start)}`,
        `DTEND;TZID=${timezone}:${formatLocalDateTime(week, item.day, item.start + item.duration)}`,
        `SUMMARY:${escapeText(eventSummary(item, account, serviceList))}`,
        `DESCRIPTION:${escapeText(eventDescription(item, serviceList))}`,
        `LOCATION:${escapeText(account.venueName)}`,
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
      return json(publicCalendarState(await readCalendarState()));
    }

    if (req.method === "PUT" && pathname === "/api/calendar-state") {
      const body = await parseBody(req);
      const current = await readCalendarState();
      const nextState = await writeCalendarState({
        syncKey:
          typeof body.syncKey === "string" ? body.syncKey : current.syncKey,
        items: Array.isArray(body.items) ? body.items : current.items,
        replaceItems: body.replaceItems === true,
        clearItems: body.clearItems === true,
        itemsOperation: body.itemsOperation,
        updatedAt: typeof body.updatedAt === "string" ? body.updatedAt : "",
      });
      const notificationResults = await sendCalendarChangeNotifications(
        current.items,
        nextState.items,
      );
      return json({
        ...publicCalendarState({
          ...nextState,
          notifications: await readNotificationHistory(),
        }),
        notificationResults,
      });
    }

    if (req.method === "PUT" && pathname === "/api/calendar-sync-key") {
      const body = await parseBody(req);
      const current = await readCalendarState();
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
      return json(await readAdminSettings());
    }

    if ((req.method === "PUT" || req.method === "POST") && pathname === "/api/admin-settings") {
      return json(await writeAdminSettings(await parseBody(req)));
    }

    if (req.method === "GET" && pathname === "/api/notification-history") {
      return json({ notifications: await readNotificationHistory() });
    }

    if (req.method === "POST" && pathname === "/api/test-email") {
      const body = await parseBody(req);
      const recipient = cleanEmail(body.email, "");
      if (!recipient)
        return json(
          {
            error: "missing_email",
            message: "Enter an email address to send the test to.",
          },
          400,
        );
      const services = await readServices();
      const service =
        services.find((candidate) => candidate.active) || defaultServices[0];
      const appointment = {
        id: `test-${Date.now()}`,
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
      return json(await writeCoachAccount(await parseBody(req)));
    }

    if (req.method === "GET" && pathname === "/api/services") {
      return json({ services: await readServices() });
    }

    if (req.method === "PUT" && pathname === "/api/services") {
      const body = await parseBody(req);
      return json({ services: await writeServices(body.services) });
    }

    if (req.method === "GET" && pathname === "/api/availability") {
      return json({ availability: await readAvailability() });
    }

    if (req.method === "PUT" && pathname === "/api/availability") {
      const body = await parseBody(req);
      return json({ availability: await writeAvailability(body.availability) });
    }

    if (req.method === "GET" && pathname === "/api/brand-settings") {
      return json(await readBrandSettings());
    }

    if (req.method === "PUT" && pathname === "/api/brand-settings") {
      return json(await writeBrandSettings(await parseBody(req)));
    }

    if (req.method === "GET" && pathname === "/api/people") {
      return json({ people: await readPeople() });
    }

    if (req.method === "POST" && pathname === "/api/people/import") {
      const body = await parseBody(req);
      return json(await importPeople(body.people, "manual_import"), 201);
    }

    if (req.method === "PUT" && pathname === "/api/people") {
      const body = await parseBody(req);
      return json(await updatePerson(body.person || body));
    }

    return json({ error: "not_found", message: "Route not found." }, 404);
  } catch (error) {
    const status = error?.status || 500;
    return json(
      {
        error: status === 500 ? "booking_api_error" : "request_error",
        message:
          error instanceof Error ? error.message : "Unknown booking API error",
      },
      status,
    );
  }
}
