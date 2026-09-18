import { getDatabase } from "@netlify/database";
import { ddlBatch } from "./_shared/database.mts";
import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

import {
  getGoogleCalendarSyncStatus,
  syncGoogleCalendarChangesIfEnabled,
  syncGoogleCalendarNow,
} from "./google-calendar-sync.mts";
import { inferBookingAction, notifyBookingEvent, sendCoachPushForBooking } from "./notification-engine.mts";
import { cancelOptixBayForCalendarItem, cancelOptixCustomerBooking } from "./_shared/optix-cancel.mts";
import { autoBookResourceForNewBooking, rebookResourceAfterReschedule } from "./_shared/optix-book-resource.mts";
import { bayBookingMatchesSlot } from "./_shared/optix-reconcile.mts";
import { calendarSlot, MINUTES_IN_DAY } from "./_shared/calendar-slot.mts";
import { planExternalReschedule, sameSlot } from "./_shared/external-reschedule.mts";
import { legacyOriginalWorkspaceId, defaultCalendarSlug } from "./_shared/account.mts";
import {
  findReviewService,
  newSwingReviewLessonId,
  reviewDraftVerdict,
} from "./_shared/swing-review.mts";
import {
  checkoutSourceRef,
  findPlayerShopItem,
  playerShopItems,
} from "./_shared/player-shop.mts";
import {
  createStripeCheckoutSession,
  isStripeSecretShaped,
  resolveStripeCredential,
  retrieveStripeCheckoutSession,
  stripeCredentialStatus,
  STRIPE_SECRET_SETTING,
} from "./_shared/stripe.mts";
import {
  assignPass,
  grantPass,
  issuedSourceRefs,
  passOptionsForService,
  passTemplatesFromServices,
  playerPassViews,
  readFlexibleValueForPerson,
  readIssuedPasses,
  readPassesForPerson,
  readUnassignedPasses,
  redeemPassManually,
  resolveInboxPassValue,
  reserveFlexibleValueForPurchase,
  reversePassRedemption,
  reversePassValueTransaction,
  reservePassForService,
  reverseRedemptionsForBooking,
  suggestPassTemplate,
  settleFlexibleValuePurchase,
  voidPass,
} from "./_shared/passes.mts";
import {
  classifyInboxLine,
  inboxLineType,
  isDismissedLine,
} from "./_shared/pass-inbox-lines.mts";
import { bestPassForLine } from "./_shared/pass-invoice-match.mts";
import { unlinkedLineBelongsToPerson } from "./_shared/invoice-line-owner.mts";
import {
  requireCoachActor,
  resolveMembershipForAuthUser,
  switchActiveAccount,
  sessionRoleForMembership,
  appUserRoleForMembership,
  resolvePublicAccount,
  ensureLegacyOwnerMembershipIfMissing,
  createCoachSession,
  findSupabaseAuthUserId as findCoachAuthUserId,
  verifySupabaseAuthPassword as verifyCoachAuthPassword,
  userBelongsToAccountStrict,
  recordBelongsToAccountStrict,
} from "./_shared/coach-auth.mts";
import {
  readSandboxForAccount,
  requireSandboxAccount,
  sandboxAccountIdFor,
} from "./_shared/sandbox.mts";
import type { CoachActor } from "./_shared/coach-auth.mts";
import { authSessionResponse, type WorkspaceBootstrap } from "./_shared/auth-contract.mts";
import { currencyForAccountSettings, currencyForCountry, localeForCountry } from "./_shared/locale.mts";
import {
  caddyAppUrl,
  caddyConfigured,
  caddyPlayerDeepLink,
  ensureCoachPlayerRelationship,
  issueCaddyPass,
  readCaddyPlayerStatus,
} from "./_shared/caddy.mts";
import { unavailableSpans } from "./_shared/availability-blocks.mts";
import {
  cleanPlayerBookingEmbedHeight,
  cleanPlayerBookingEmbedIntro,
  cleanPlayerBookingEmbedLabel,
  cleanPlayerBookingEmbedUrl,
  playerBookingEmbedForPortal,
  playerBookingEmbedFromSettings,
} from "./_shared/player-booking-embed.mts";
import {
  guestRegistrationsPerAccountPerDay,
  guestRetentionDays,
  guestSubmissionsLifetime,
} from "./_shared/guest-limits.mts";
import {
  canonicalPhoneKey,
  cleanPhoneCountry,
  FALLBACK_PHONE_COUNTRY,
} from "./_shared/phone.mts";
import { deliverEmail } from "./_shared/email-delivery.mts";

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
  // The last-resort currency, for a business whose country is unreadable. This
  // read activeCurrency() before, which -- being evaluated at module load,
  // before any account had been read -- had always been this same fallback
  // anyway. The per-account answer comes from currencyForAccountSettings()
  // in cleanInvoiceSettings below.
  currency: currencyForCountry(FALLBACK_PHONE_COUNTRY),
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
  // The coach's own labels for invoice lines, and how loudly the workspace
  // flags unpaid invoices. Both are set in Billing Settings - see
  // src/modules/billing/invoiceSettings.ts, which this mirrors.
  lineTags: [],
  unpaidLoudness: 2,
};

/**
 * Invoice defaults for a business that has not been set up yet.
 *
 * Same shape as defaultInvoiceSettings, minus everything that names the
 * original business -- the footer said "Thank you for training with Sam Hale
 * Golf" on every invoice a second business would have sent.
 */
function neutralInvoiceSettings() {
  return {
    ...defaultInvoiceSettings,
    footerText: "",
    defaultCustomerNote: "",
  };
}

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
function isVideoReviewService(service) {
  return Boolean(service?.lessonFormat === "video-review");
}

/** Default working days between booking a review and owing it back. */
const VIDEO_REVIEW_DEFAULT_TURNAROUND_DAYS = 3;
const VIDEO_REVIEW_MAX_TURNAROUND_DAYS = 30;
/**
 * Where a review sits when the coach has no availability that day. 8pm is the
 * calendar's own default end hour, so the card lands inside the rendered grid
 * rather than below it.
 */
const VIDEO_REVIEW_FALLBACK_DAY_END_MINUTES = 20 * 60;

function cleanReviewTurnaroundDays(value, fallback = VIDEO_REVIEW_DEFAULT_TURNAROUND_DAYS) {
  const days = Number(value);
  if (!Number.isFinite(days)) return fallback;
  return Math.max(1, Math.min(VIDEO_REVIEW_MAX_TURNAROUND_DAYS, Math.round(days)));
}

/**
 * Where a review's deadline lands on the calendar grid.
 *
 * The date is the booking moment plus the turnaround. The time is the end of
 * that day's work, so the card reads as "owed by close of play" rather than
 * pretending to be an appointment at some invented hour -- and it ends exactly
 * where the coach's day does.
 *
 * Reviews already due that day stack backwards from there, one duration at a
 * time, so a day with three of them shows three cards in a row instead of one
 * card with two hidden underneath it.
 */
function videoReviewDueSlot(service, accountState, coachId, timezone) {
  const duration = Math.max(15, Math.round(Number(service?.duration) || 30));
  const turnaround = cleanReviewTurnaroundDays(service?.reviewTurnaroundDays);
  const dueAt = new Date(Date.now() + turnaround * 86_400_000);
  // Same rule the rest of the clock maths follows: an unusable timezone falls
  // back to UTC loudly rather than throwing inside a booking the player has
  // already paid attention to.
  let grid;
  try {
    grid = calendarSlot(dueAt.toISOString(), timezone);
  } catch {
    console.warn("booking_core:invalid_timezone_falling_back_to_utc", { timeZone: timezone });
    grid = calendarSlot(dueAt.toISOString(), FALLBACK_TIME_ZONE);
  }
  const { week, day } = grid;
  const fallbackCoachId = defaultCoachProfileFromAccount().id;
  const windows = (accountState?.availability?.[day] || []).filter(
    (window) => (window.coachId || fallbackCoachId) === (coachId || fallbackCoachId),
  );
  const dayEnd = windows.length
    ? Math.max(...windows.map((window) => Number(window.end) || 0))
    : VIDEO_REVIEW_FALLBACK_DAY_END_MINUTES;
  // Count what is already owed on this day so the next one sits beside it.
  const reviewServiceIds = new Set(
    (accountState?.services || []).filter(isVideoReviewService).map((entry) => entry.id),
  );
  const alreadyDue = (accountState?.items || []).filter(
    (item) =>
      Number(item.week ?? 0) === week &&
      Number(item.day) === day &&
      !isInactiveForConflict(item) &&
      reviewServiceIds.has(item.serviceId),
  ).length;
  const start = Math.max(
    0,
    Math.min(MINUTES_IN_DAY - duration, dayEnd - duration * (alreadyDue + 1)),
  );
  return { week, day, start, duration, dueAt: dueAt.toISOString() };
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
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  // An array value is appended one header at a time. Set-Cookie is the reason:
  // logout clears both the admin and the player cookie, and a comma-joined
  // Set-Cookie is not a valid header -- the browser would drop both.
  for (const [name, value] of Object.entries(extraHeaders)) {
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else if (value !== undefined && value !== null) {
      headers.set(name, value);
    }
  }
  return new Response(safeJsonStringify(value), { status, headers });
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

function cleanSlug(value, fallback = legacyOriginalWorkspaceId()) {
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

function formatBookingDate(week, day, country = FALLBACK_PHONE_COUNTRY) {
  const date = dateForSlot(week, day);
  return new Date(
    Date.UTC(date.year, date.month - 1, date.day),
  ).toLocaleDateString(localeForCountry(country), {
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
    coachId: cleanSlug(service?.coachId, ""),
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
    locationId: cleanSlug(service?.locationId, "") || undefined,
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
  // The reserved External Booking type always exists, so an inbound external
  // booking can never reference a lesson type that isn't in the catalogue. A
  // stored copy wins (the coach may recolour or rename it); deleting it just
  // brings the default back on the next read.
  if (!seen.has(EXTERNAL_BOOKING_SERVICE_ID)) {
    services.push(cleanService(externalBookingServiceTemplate, services.length, accountId));
  }
  return services;
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
        // Keep the owning business on the window. Every account filter is
        // strict now, so a window that loses its accountId here is dropped
        // from the public slot calculation and the booking page shows no
        // times at all.
        const accountId = cleanSlug(window?.accountId, "");
        if (end <= start) return null;
        return accountId ? { start, end, coachId, accountId } : { start, end, coachId };
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

// Original-workspace bootstrapping only — never used as auth fallback or account resolution.
// New workspaces get their own values from DB settings per-account.
/** True only for the business this deployment started life as. */
function isOriginalWorkspace(accountId) {
  return cleanSlug(accountId, "") === legacyOriginalWorkspaceId();
}

/**
 * Product defaults for a business that has not been set up yet.
 *
 * A new workspace must not open on somebody else's details. Before this, an
 * account with no settings rows fell through to defaultCoachAccount(), so the
 * second business's first login showed "Sam Hale", "Sam Hale Golf" and "The
 * Range 24/7 - Three Kings" -- and its invoices carried "Thank you for training
 * with Sam Hale Golf". Everything identifying starts empty and is filled in
 * during setup; only genuinely product-level things (Clarity's own booking and
 * Caddy URLs, the platform's timezone guess) carry over.
 */
function neutralCoachAccount(accountId) {
  return {
    id: cleanSlug(accountId, ""),
    coachName: "",
    businessName: "",
    venueName: "",
    venueShortName: "",
    timezone: defaultTimeZone(),
    country: cleanPhoneCountry(env("CLARITY_COUNTRY", FALLBACK_PHONE_COUNTRY)),
    contactEmail: "",
    bookingUrl: env("CLARITY_BOOKING_URL", "https://book.claritygolf.app"),
    calendarSlug: cleanSlug(accountId, ""),
    caddyWorkspaceUrl: env("CLARITY_CADDY_WORKSPACE_URL", "https://caddy.claritygolf.app"),
    invoiceSettings: neutralInvoiceSettings(),
  };
}

function defaultCoachAccount() {
  return {
    id: legacyOriginalWorkspaceId(),
    coachName: env("CLARITY_COACH_NAME", "Sam Hale"),
    businessName: env("CLARITY_BUSINESS_NAME", "Sam Hale Golf"),
    venueName: env("CLARITY_VENUE_NAME", "The Range 24/7 - Three Kings"),
    venueShortName: env("CLARITY_VENUE_SHORT_NAME", "The Range 24/7"),
    timezone: defaultTimeZone(),
    // ISO 3166-1 alpha-2. The workspace's home country: what a phone number
    // with no + is assumed to be, and the default selection in the country
    // dropdown. Everything else that is currently hardcoded to New Zealand
    // (date formatting, currency) should eventually derive from this too.
    country: cleanPhoneCountry(env("CLARITY_COUNTRY", FALLBACK_PHONE_COUNTRY)),
    contactEmail: env("CLARITY_CONTACT_EMAIL", ""),
    bookingUrl: env("CLARITY_BOOKING_URL", "https://book.claritygolf.app"),
    calendarSlug: defaultCalendarSlug(),
    caddyWorkspaceUrl: env("CLARITY_CADDY_WORKSPACE_URL", "https://caddy.claritygolf.app"),
    invoiceSettings: defaultInvoiceSettings,
	  };
	}

/**
 * Normalises one of the coach's invoice custom fields. Like cleanInvoiceLineTag
 * below, this keeps a blank row and does not trim, so the settings editor gets
 * its draft back unchanged when it saves: an added-but-not-filled-in row stays
 * on screen, and a label still being typed keeps its trailing space. The blank
 * rows are dropped and the labels trimmed where the fields are printed - see
 * printableInvoiceCustomFields in src/modules/billing/invoiceSettings.ts, which
 * this mirrors.
 */
function cleanInvoiceCustomField(field, index = 0) {
  if (!field || typeof field !== "object") return null;
  const placement = ["bill-to", "payment", "footer"].includes(field?.placement)
    ? field.placement
    : "header";
  return {
    id: cleanString(field?.id, `field-${index + 1}`, 80),
    label: typeof field?.label === "string" ? field.label.slice(0, 80) : "",
    value: typeof field?.value === "string" ? field.value.slice(0, 180) : "",
    placement,
  };
}

/**
 * Normalises one of the coach's invoice-line tags. Deliberately keeps a blank
 * label and does not trim, so this is the same shape the browser's
 * cleanInvoiceLineTag returns: the settings editor round-trips its draft
 * through here on save, and a row the coach has added but not named yet has to
 * come back the way it went in rather than disappearing under the cursor.
 */
function cleanInvoiceLineTag(tag, index = 0) {
  if (!tag || typeof tag !== "object") return null;
  return {
    id: cleanString(tag?.id, `tag-${index + 1}`, 80),
    label: typeof tag?.label === "string" ? tag.label.slice(0, 60) : "",
  };
}

function cleanInvoiceSettings(settings = {}, country = FALLBACK_PHONE_COUNTRY) {
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
  // Duplicate ids would make the picker ambiguous and split one tag's lines into
  // two buckets, so the first entry to claim an id keeps it.
  const seenTagIds = new Set();
  const lineTags = [];
  if (Array.isArray(settings?.lineTags)) {
    for (const [index, raw] of settings.lineTags.entries()) {
      if (lineTags.length >= 40) break;
      const tag = cleanInvoiceLineTag(raw, index);
      if (!tag || seenTagIds.has(tag.id)) continue;
      seenTagIds.add(tag.id);
      lineTags.push(tag);
    }
  }
  return {
    enabled: settings?.enabled !== false,
    showBillingWorkspace: settings?.showBillingWorkspace !== false,
    prefix:
      cleanString(settings?.prefix, defaultInvoiceSettings.prefix, 12)
        .toUpperCase()
        .replace(/[^A-Z0-9-]/g, "") || defaultInvoiceSettings.prefix,
    // Same range the browser allows (see cleanInvoiceSettings in
    // src/modules/billing/invoiceSettings.ts): min 0 so the field can be cleared
    // while typing, and up to 9 digits so a year-based scheme like 20260001
    // survives the save rather than being rewritten to 999999.
    nextNumber: Number.isFinite(nextNumber)
      ? Math.max(0, Math.min(999999999, Math.round(nextNumber)))
      : defaultInvoiceSettings.nextNumber,
    // A business that has chosen a currency keeps it; one that has not gets the
    // one its country uses, rather than New Zealand's. This is the same helper
    // billing-api already invoices with, so the two cannot disagree.
    currency: currencyForAccountSettings(settings?.currency, country),
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
    lineTags,
    unpaidLoudness: [1, 2, 3].includes(Number(settings?.unpaidLoudness))
      ? Number(settings?.unpaidLoudness)
      : defaultInvoiceSettings.unpaidLoudness,
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
    country: cleanPhoneCountry(account?.country, defaults.country),
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
    invoiceSettings: cleanInvoiceSettings(
      account?.invoiceSettings,
      cleanPhoneCountry(account?.country, defaults.country),
    ),
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

/**
 * Raised when a query would have to run without an account filter.
 *
 * Several reads used to retry unscoped when Supabase reported account_id
 * missing, which turned a schema problem into a silent cross-tenant read. The
 * column is NOT NULL now; if the scope cannot be applied, that is a server
 * fault and the request fails.
 */
function missingAccountScope(where = "query") {
  return Object.assign(
    new Error("This request could not be scoped to a business and was refused."),
    { status: 500, code: "account_scope_unavailable", scope: where },
  );
}

function defaultWorkspaceAccountFromCoachAccount(account = defaultCoachAccount()) {
  const clean = cleanCoachAccount(account);
  const slug = cleanSlug(clean.calendarSlug || clean.businessName, legacyOriginalWorkspaceId());
  return {
    id: slug,
    name: clean.businessName,
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
    id: clean.id || legacyOriginalWorkspaceId(),
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
    // The fallback is the caller's account (via `fallback`), never the original
    // workspace: a coach profile whose stored accountId is missing belongs to
    // the business being read, not to Sam Hale Golf.
    accountId: cleanSlug(raw?.accountId, fallback.accountId || ""),
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
    // As cleanCoachProfile: the caller's account, not the original workspace.
    accountId: cleanSlug(raw?.accountId, fallback.accountId || ""),
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

function recordAccountId(record) {
  return typeof record?.accountId === "string" && record.accountId !== "" ? record.accountId : "";
}

export function recordBelongsToAccount(record, accountId) {
  return recordBelongsToAccountStrict(record, accountId);
}


export function calendarItemBelongsToAccount(item, accountId) {
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

export function filterCalendarStateForContext(state, context) {
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

// Player portal sessions are a separate space from the admin session above --
// a distinct cookie name so a coach who is also a player on the same browser
// can hold both without one masquerading as the other. Same HttpOnly/SameSite
// posture as the admin cookie.
const playerSessionCookieName = "clarity_player_session";
const playerSessionDays = 30;

function playerCookieHeader(token, req, maxAgeSeconds) {
  const secure = new URL(req.url).protocol === "https:";
  return [
    `${playerSessionCookieName}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function clearPlayerCookieHeader() {
  return `${playerSessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * The native app cannot hold the cookie above.
 *
 * It is served from capacitor://localhost, so every request here is cross-site
 * and a SameSite=Lax cookie is never sent -- there is no cookie posture that
 * fixes that without opening the browser up too. It carries the same
 * player_sessions token in an Authorization header instead. Same token, same
 * table, same expiry and the same revocation check; only the transport differs,
 * so nothing downstream has to know which client it is answering.
 */
function bearerTokenFromRequest(req) {
  const header = req.headers.get("authorization") || "";
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : "";
}

function playerSessionTokenFromRequest(req) {
  return bearerTokenFromRequest(req) || parseCookies(req)[playerSessionCookieName] || "";
}

/**
 * True when the caller has told us it cannot store cookies, which is the only
 * case where a login response carries the raw session token. A browser never
 * sends this header and so never sees the token.
 */
function wantsTokenAuth(req) {
  return (req.headers.get("x-clarity-client") || "").toLowerCase() === "app";
}

// The only origins allowed to call this API from somewhere other than our own
// pages: the two schemes a Capacitor webview serves from. Nothing here is
// credentialed -- these clients authenticate with a bearer token, so a cookie
// is never in play and a hostile page on one of these origins gains nothing.
const nativeAppOrigins = new Set([
  "capacitor://localhost",
  "http://localhost",
  "https://localhost",
]);

function corsHeaders(req) {
  const origin = req.headers.get("origin") || "";
  if (!nativeAppOrigins.has(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, Accept, X-Clarity-Client, X-Clarity-Guest-Token",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function db() {
  return getDatabase();
}

/**
 * Does this table exist?
 *
 * Some tables here are created by a migration rather than by ensureSchema(), so
 * a database that has never run one is missing them without being broken. A
 * reader that assumes otherwise turns "this account has no Optix" into a 500.
 */
async function tableExists(table: string) {
  const rows = (await db().sql`
    SELECT to_regclass(${`public.${table}`}) AS name
  `) as Record<string, unknown>[];
  return Boolean(rows[0]?.name);
}

async function setSetting(accountId: string, key: string, value: unknown) {
  await setSettingsBulk(accountId, { [key]: value });
}

/**
 * Write a group of settings in one statement — account-scoped.
 *
 * Saving a settings form means writing a dozen or more keys, and doing that one
 * key at a time is a dozen or more sequential round trips to Postgres for a
 * change the coach experiences as pressing Save once. Same shape as the calendar
 * save that was rewriting one item per round trip: individually cheap, and the
 * cost is the count.
 *
 * Callers that write a single key keep using setSetting, which comes through
 * here with one entry. `run` is the statement runner, injectable so the built
 * SQL can be checked without a database behind it.
 *
 * accountId is required. No global writes.
 */
export async function setSettingsBulk(accountId: string, values: Record<string, unknown>, run: null | ((text: string, args: unknown[]) => Promise<unknown>) = null) {
  const entries = Object.entries(values || {}).filter(([key]) => key);
  if (!entries.length) return;
  if (!accountId) {
    throw new Error("setSettingsBulk: accountId is required");
  }

  const params: unknown[] = [];
  const rows = entries.map(([key, value]) => {
    params.push(accountId, key, String(value ?? ""));
    return `($${params.length - 2}, $${params.length - 1}, $${params.length}, NOW())`;
  });
  const query = run || ((text: string, args: unknown[]) => db().pool.query(text, args));
  await query(
    `INSERT INTO settings (account_id, key, value, updated_at)
     VALUES ${rows.join(", ")}
     ON CONFLICT (account_id, key) DO UPDATE
       SET value = EXCLUDED.value,
           updated_at = EXCLUDED.updated_at`,
    params,
  );
}

export async function getSetting(accountId: string, key: string): Promise<string> {
  if (!accountId) return "";
  const rows = await db().sql<{ value: string }[]>`SELECT value FROM settings WHERE account_id = ${accountId} AND key = ${key}`;
  return rows[0]?.value || "";
}

export async function readSettingsMap(accountId: string): Promise<Record<string, string>> {
  if (!accountId) return {};
  // Excludes the bulk-excluded keys (see _shared/settings-keys.mts): this read
  // runs on nearly every request and was shipping a 34 kB Google sync debug log
  // with it. Read those keys individually via getSetting() when needed.
  const rows = await db().sql<{ key: string; value: string }[]>`SELECT key, value FROM settings WHERE account_id = ${accountId} AND key <> 'googleCalendarDebugLogJson'`;
  return Object.fromEntries(rows.map((row) => [row.key, row.value || ""]));
}

function settingValue(settings, key) {
  return settings?.[key] || "";
}

function parseSettingJson(settings, key, fallback) {
  return safeJsonParse(settingValue(settings, key), fallback);
}

async function ensureCoreTables() {
  const ddl = ddlBatch();
  ddl.sql`
    CREATE TABLE IF NOT EXISTS settings (
      account_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (account_id, key)
    )
  `;
  ddl.sql`
    CREATE TABLE IF NOT EXISTS calendar_items (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
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
  ddl.sql`ALTER TABLE calendar_items ADD COLUMN IF NOT EXISTS account_id TEXT`;
  ddl.sql`ALTER TABLE calendar_items ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'booked'`;
  ddl.sql`ALTER TABLE calendar_items ADD COLUMN IF NOT EXISTS coach_id TEXT`;
  ddl.sql`ALTER TABLE calendar_items ADD COLUMN IF NOT EXISTS location_id TEXT`;
  ddl.sql`ALTER TABLE calendar_items ADD COLUMN IF NOT EXISTS coach JSONB`;
  ddl.sql`ALTER TABLE calendar_items ADD COLUMN IF NOT EXISTS location JSONB`;
  ddl.sql`ALTER TABLE calendar_items ADD COLUMN IF NOT EXISTS custom_group JSONB`;
  ddl.sql`ALTER TABLE calendar_items ADD COLUMN IF NOT EXISTS completed_at TEXT`;
  ddl.sql`
    CREATE INDEX IF NOT EXISTS idx_calendar_items_slot
    ON calendar_items (week, day, start)
  `;
	  ddl.sql`
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
  ddl.sql`ALTER TABLE people ADD COLUMN IF NOT EXISTS account_id TEXT`;
  // External booking clients (created by an inbound Optix booking) live in
  // their own list until an admin merges or moves them into the main list.
  ddl.sql`ALTER TABLE people ADD COLUMN IF NOT EXISTS external BOOLEAN NOT NULL DEFAULT FALSE`;
	  ddl.sql`DROP INDEX IF EXISTS idx_people_email_unique`;
	  ddl.sql`
	    CREATE INDEX IF NOT EXISTS idx_people_email_lookup
	    ON people (LOWER(email))
	    WHERE email IS NOT NULL AND email <> ''
	  `;
	  ddl.sql`
	    CREATE INDEX IF NOT EXISTS idx_people_name_phone_lookup
	    ON people (LOWER(name), phone)
	    WHERE phone IS NOT NULL AND phone <> ''
	  `;
  ddl.sql`
    CREATE INDEX IF NOT EXISTS idx_people_account_name_lookup
    ON people (account_id, LOWER(name), LOWER(email), id)
  `;
  ddl.sql`
    CREATE TABLE IF NOT EXISTS admin_users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
  ddl.sql`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL,
      auth_user_id UUID,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
  // Which of the user's businesses this session is acting for. NULL means
  // "their primary one", which is every session that has never switched -- so
  // the column is additive and no existing session changes behaviour.
  ddl.sql`ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS active_account_id TEXT`;
  ddl.sql`
    CREATE TABLE IF NOT EXISTS admin_password_resets (
      id TEXT PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
  await ddl.run(db().pool);
}

async function ensureAuthTables() {
  const ddl = ddlBatch();
  // The tenancy backbone. Identity comes from Supabase Auth; authorization
  // comes from an active row here. Created alongside the auth tables so a
  // fresh environment can resolve an actor on its very first request.
  ddl.sql`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      business_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  // What kind of account this is: a real business, or the sandbox that shadows
  // one. Defaulting to 'live' is what makes this additive -- every existing row
  // is a live business and nothing about it changes.
  ddl.sql`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'live'`;
  ddl.sql`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS sandbox_of_account_id TEXT`;
  // One sandbox per business, enforced by the schema rather than by a check
  // somebody has to remember to write.
  ddl.sql`
    CREATE UNIQUE INDEX IF NOT EXISTS accounts_one_sandbox_per_account
    ON accounts (sandbox_of_account_id)
    WHERE sandbox_of_account_id IS NOT NULL
  `;
  ddl.sql`
    CREATE TABLE IF NOT EXISTS account_memberships (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      auth_user_id UUID NOT NULL,
      role TEXT NOT NULL,
      coach_id TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  ddl.sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_account_memberships_account_auth_user
      ON account_memberships (account_id, auth_user_id)
  `;
  ddl.sql`
    CREATE INDEX IF NOT EXISTS idx_account_memberships_auth_user
      ON account_memberships (auth_user_id, active)
  `;
  ddl.sql`
    CREATE TABLE IF NOT EXISTS settings (
      account_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (account_id, key)
    )
  `;
  ddl.sql`
    CREATE TABLE IF NOT EXISTS admin_users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
  ddl.sql`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL,
      auth_user_id UUID,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
  // Which of the user's businesses this session is acting for. NULL means
  // "their primary one", which is every session that has never switched -- so
  // the column is additive and no existing session changes behaviour.
  ddl.sql`ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS active_account_id TEXT`;
  ddl.sql`
    CREATE TABLE IF NOT EXISTS admin_password_resets (
      id TEXT PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
  await ddl.run(db().pool);
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
    sendLessonTypeChangeEmail: "false",
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

// Forty-five keys, and this runs once on every cold start before the instance
// can answer anything. One INSERT per key made that forty-five sequential round
// trips of pure latency on the first request each new instance served.
// DO NOTHING, not DO UPDATE: these are defaults, so an existing value wins.
async function seedSettings(accountId: string) {
  if (!accountId) throw missingAccountScope("seed_settings");
  const entries = Object.entries(await defaultSettings()).filter(([key]) => key);
  if (!entries.length) return;

  const params = [];
  const rows = entries.map(([key, value]) => {
    params.push(accountId, key, String(value ?? ""));
    return `($${params.length - 2}, $${params.length - 1}, $${params.length}, NOW())`;
  });
  await db().pool.query(
    `INSERT INTO settings (account_id, key, value, updated_at)
     VALUES ${rows.join(", ")}
     ON CONFLICT (account_id, key) DO NOTHING`,
    params,
  );
}

async function seedItems(accountId: string) {
  if (!accountId) throw missingAccountScope("seed_items");
  const countRows = await db()
    .sql`SELECT COUNT(*) AS count FROM calendar_items WHERE account_id = ${accountId}`;
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
          accountId,
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

/**
 * Seeds the ORIGINAL workspace's admin login from CLARITY_ADMIN_EMAIL /
 * CLARITY_ADMIN_PASSWORD.
 *
 * Deliberately not a way to create further business owners: a second business
 * gets a Supabase Auth user and an account_memberships row, not an env pair.
 * The seed-key bookkeeping is stored against the original workspace, which is
 * the only account this function has ever seeded.
 */
async function ensureAdminUser() {
  const startedAt = Date.now();
  let outcome = "unknown";
  let wrote = false;
  let hashed = false;
  const bootstrapAccountId = legacyOriginalWorkspaceId();
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
      const currentSeedKey = await getSetting(bootstrapAccountId, "adminPasswordSeedKey");
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
      await setSetting(bootstrapAccountId, "adminPasswordSeedKey", seedKey);
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
    await setSetting(bootstrapAccountId, "adminPasswordSeedKey", seedKey);
    wrote = true;
    outcome = "inserted_seed";
  } finally {
    // Attach the original owner to their workspace if nothing has yet. No-op
    // once any membership exists, so it cannot re-seed or overwrite.
    await ensureLegacyOwnerMembershipIfMissing({ adminEmail: email });
    logAuthTiming("ensureAdminUser", startedAt, { outcome, wrote, hashed });
  }
}

async function ensureNotificationHistoryTable() {
  const ddl = ddlBatch();
  ddl.sql`
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
  ddl.sql`
    CREATE INDEX IF NOT EXISTS idx_notification_history_person
    ON notification_history (person_key, created_at DESC)
  `;
  ddl.sql`
    CREATE INDEX IF NOT EXISTS idx_notification_history_item
    ON notification_history (calendar_item_id, created_at DESC)
  `;
  ddl.sql`
    CREATE INDEX IF NOT EXISTS idx_notification_history_provider
    ON notification_history (provider_id)
    WHERE provider_id IS NOT NULL AND provider_id <> ''
  `;
  ddl.sql`
    CREATE TABLE IF NOT EXISTS notification_webhook_events (
      id TEXT PRIMARY KEY,
      provider_id TEXT,
      event_type TEXT NOT NULL,
      payload TEXT,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await ddl.run(db().pool);
}

// Self-creating like the notification tables above -- the player portal is
// additive, so its session table is provisioned on first use rather than
// requiring a separate production migration step. A repo migration file exists
// alongside it for the schema record (database/migrations).
let playerSessionsTableReady = false;
async function ensurePlayerSessionsTable() {
  if (playerSessionsTableReady) return;
  const ddl = ddlBatch();
  ddl.sql`
    CREATE TABLE IF NOT EXISTS player_sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      person_id TEXT,
      email TEXT NOT NULL,
      phone TEXT,
      account_id TEXT,
      auth_user_id UUID,
      portal_player_id TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  // Sessions predate the Supabase Auth login, so an existing table needs the
  // new columns adding and its phone requirement dropping -- phone is no longer
  // collected at login.
  ddl.sql`ALTER TABLE player_sessions ADD COLUMN IF NOT EXISTS auth_user_id UUID`;
  ddl.sql`ALTER TABLE player_sessions ADD COLUMN IF NOT EXISTS portal_player_id TEXT`;
  // Set only on a sandbox handoff: the coach who is driving this player. It is
  // what makes the session distinguishable from a real player's, which is how
  // the portal knows to offer a way back and how /api/auth/session knows to
  // prefer it over the coach cookie sitting alongside it in the same browser.
  ddl.sql`ALTER TABLE player_sessions ADD COLUMN IF NOT EXISTS sandbox_actor_auth_user UUID`;
  ddl.sql`ALTER TABLE player_sessions ALTER COLUMN phone DROP NOT NULL`;
  ddl.sql`
    CREATE INDEX IF NOT EXISTS idx_player_sessions_token
    ON player_sessions (token_hash)
  `;
  ddl.sql`
    CREATE INDEX IF NOT EXISTS idx_player_sessions_expires
    ON player_sessions (expires_at)
  `;
  ddl.sql`
    CREATE INDEX IF NOT EXISTS idx_player_sessions_portal_player
    ON player_sessions (portal_player_id)
  `;
  ddl.sql`
    CREATE TABLE IF NOT EXISTS portal_players (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      auth_user_id UUID NOT NULL,
      email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'invited',
      invite_token_hash TEXT,
      invite_expires_at TIMESTAMPTZ,
      invited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      activated_at TIMESTAMPTZ,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT portal_players_status_check
        CHECK (status IN ('invited', 'active', 'disabled'))
    )
  `;
  ddl.sql`
    CREATE UNIQUE INDEX IF NOT EXISTS portal_players_account_person_idx
    ON portal_players (account_id, person_id)
  `;
  ddl.sql`
    CREATE UNIQUE INDEX IF NOT EXISTS portal_players_auth_user_idx
    ON portal_players (auth_user_id)
  `;
  ddl.sql`
    CREATE INDEX IF NOT EXISTS portal_players_invite_token_idx
    ON portal_players (invite_token_hash)
  `;
  // Through the same handle as every other statement, rather than reaching for
  // the pool directly: setDatabaseForTests exists to stand in for the database,
  // and DDL that bypasses it makes this whole surface untestable.
  await ddl.run(db().pool);
  // Only once the statements have actually landed: marking it ready first would
  // let a failed run leave every later call skipping the creation it needs.
  playerSessionsTableReady = true;
}

// One-time bootstrap of the original workspace's legacy rows (see
// ensureSeeded). The caller passes legacyOriginalWorkspaceId() explicitly.
async function backfillLegacyPeopleAccountIds(accountId) {
  const cleanAccountId = cleanSlug(accountId, "");
  if (!cleanAccountId) return;
  try {
    await db().sql`
      UPDATE people
      SET account_id = ${cleanAccountId}
      WHERE account_id IS NULL OR BTRIM(account_id) = ''
    `;
  } catch (error) {
    const code = cleanString(error?.code, "", 120);
    const message = error instanceof Error ? error.message : String(error || "");
    // Stamping the account on to a legacy row can collide with the
    // account-scoped unique index on lower(email) when an orphaned duplicate
    // shares an address with a row that already belongs to the account. That is
    // a data-hygiene problem, not a reason to fail whatever the caller was
    // actually trying to do, so any constraint violation is logged and skipped.
    if (
      code === "DUPLICATE_PERSON_EMAIL" ||
      code === "23505" ||
      /Another person already uses that email address|duplicate key|unique constraint|idx_people_.*email/i.test(message)
    ) {
      console.warn("people_account_backfill_duplicate_email_skipped", {
        accountId: cleanAccountId,
        message: message.slice(0, 300),
      });
      return;
    }
    throw error;
  }
}

/**
 * One-time bootstrap of the original workspace.
 *
 * This is the "explicit original-workspace bootstrapping" that
 * legacyOriginalWorkspaceId() exists for: creating the tables, seeding the
 * first business's settings and demo rows, and making sure the original admin
 * exists. It runs once per instance and does not participate in resolving who
 * is making a request -- a second business is provisioned with its own rows,
 * not by running this again.
 */
/**
 * Whether this database has already been through the seed below.
 *
 * One round trip, and it decides whether a new container pays for eight. Every
 * cold start used to run the whole seed -- DDL for every table, the default
 * settings, the legacy backfill, two counts and the admin user -- in series,
 * at ~217 ms per hop between Netlify and Supabase, before answering anything.
 * With seven requests fanning out at boot, that was seven containers each
 * spending well over a second on work that had been done months ago. The
 * schema is the migration runner's job now (scripts/migrate.mjs, on deploy),
 * and the seed only matters on a database that has never seen one.
 *
 * The probe reads the admin seed marker rather than any settings row, so a
 * rotated CLARITY_ADMIN_PASSWORD still reaches the legacy admin user: the
 * marker stops matching, the full seed runs once, and ensureAdminUser rotates
 * it as before. A missing table throws, which reads as "fresh database".
 * CLARITY_RUNTIME_SEED=always is the escape hatch back to the old behaviour.
 */
async function seededAlready(accountId: string) {
  if (env("CLARITY_RUNTIME_SEED") === "always") return false;
  try {
    const email = cleanEmail(env("CLARITY_ADMIN_EMAIL"), "");
    const password = env("CLARITY_ADMIN_PASSWORD");
    const rows = await db().sql`
      SELECT key, value FROM settings
      WHERE account_id = ${accountId} AND key IN ('adminPasswordSeedKey', 'accountBusinessName')
    `;
    if (!rows.length) return false;
    if (!email || !password) return true;
    const marker = rows.find((row) => row.key === "adminPasswordSeedKey");
    return Boolean(marker) && marker.value === hashToken(`${email}:${password}`);
  } catch {
    return false;
  }
}

async function ensureSeeded() {
  if (!seedReadyPromise) {
    seedReadyPromise = (async () => {
      const originalWorkspaceId = legacyOriginalWorkspaceId();
      if (await seededAlready(originalWorkspaceId)) {
        console.info("runtime_seed_skipped", { reason: "already_seeded" });
        return;
      }
      await ensureCoreTables();
      await seedSettings(originalWorkspaceId);
      await backfillLegacyPeopleAccountIds(originalWorkspaceId);
      await ensureNotificationHistoryTable();
      await seedItems(originalWorkspaceId);
      await seedPeopleFromAppointments(originalWorkspaceId);
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
  const location = cleanBookingLocationSnapshot(row.location);
  // A synced sync row is not on its own proof of a bay: it can be left over
  // from before the lesson was moved. See bayBookingMatchesSlot.
  const bayBooked =
    row.bay_booked === true &&
    bayBookingMatchesSlot(
      { week: Number(row.week ?? 0), day: Number(row.day ?? 0), start: Number(row.start ?? 0), location },
      // The lesson's own location timezone wins inside; this is only reached
      // when it has none. A deployment constant, not another business's clock.
      Number(row.bay_start_timestamp ?? 0),
      defaultTimeZone(),
    );
  return {
    id: row.id,
    // No owner means no owner. Migration C made the column NOT NULL, so this
    // only bites genuinely malformed data -- which should be invisible, not
    // adopted by whichever business is reading.
    accountId: cleanSlug(row.accountId || row.account_id, ""),
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
    personId: row.person_id || "",
    note: row.note || "",
    coach: cleanBookingCoachSnapshot(row.coach),
    location,
    status: cancelledGroupSession ? "cancelled" : status,
    // Who owns this booking. The calendar needs this to tell a native lesson
    // from one an external system owns -- without it the UI cannot label an
    // Optix booking, and worse, cannot stop a gesture that would silently
    // convert one. Read-only: writeItems() never updates these columns, so a
    // client cannot claim a booking for a provider by echoing them back.
    origin: row.origin || "clarity",
    externalProvider: row.external_provider || "",
    externalBookingId: row.external_booking_id || "",
    bayBooked,
    bayResourceId: row.bay_resource_id || "",
    updatedAt,
    completedAt,
    ...(cancelledGroupSession ? { readOnly: true, groupSlot: true } : {}),
    ...(customGroup || {}),
	  };
	}

// An upstream status must never become this API's status. Optix answers a
// failed bay call with HTTP 200 and a GraphQL error body, and passing that 200
// straight through made a failed request look like a success to the browser:
// response.ok was true but the payload carried an error instead of calendar
// items, so the app reported a confusing reload failure while the change had
// silently not happened. Anything that is not a real 4xx/5xx becomes a 500.
function responseStatusFromError(error) {
  const status = Number(error?.status);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

function lessonCompleteActionFailure(error, baseDetails, durationMs) {
  const status = responseStatusFromError(error);
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

/**
 * Permanently deletes a Supabase Auth user through GoTrue's admin API. There
 * is no client library call for this -- the app never uses the Supabase JS
 * admin client, only direct REST with the service role key (see
 * supabaseStorageConfig above), so this is a plain fetch like the others.
 */
async function deleteSupabaseAuthUser(authUserId: string) {
  const { url, key } = supabaseStorageConfig();
  const response = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(authUserId)}`, {
    method: "DELETE",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
  });
  // A 404 means the login is already gone, which is the outcome this call
  // wants -- not a failure to surface.
  if (!response.ok && response.status !== 404) {
    const text = await response.text().catch(() => "");
    throw Object.assign(
      new Error(`Supabase auth user delete failed ${response.status}: ${String(text || "").slice(0, 300)}`),
      { status: response.status },
    );
  }
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

// Completing a lesson is a write by id. It is always scoped to the owning
// account as well: an id on its own must never be enough to complete another
// business's booking.
function lessonCompletePatchFilter(itemId, accountId) {
  if (!accountId) throw missingAccountScope("lesson_complete");
  return `id=eq.${encodeURIComponent(itemId)}&account_id=eq.${encodeURIComponent(accountId)}&select=*`;
}

function lessonCompleteReadFilter(itemId, accountId) {
  if (!accountId) throw missingAccountScope("lesson_complete");
  return `select=*&id=eq.${encodeURIComponent(itemId)}&account_id=eq.${encodeURIComponent(accountId)}&limit=1`;
}

async function readLessonItemForCompletion(itemId, accountId) {
  const rows = await requestSupabaseRows("calendar_items", {
    query: lessonCompleteReadFilter(itemId, accountId),
    method: "GET",
  });
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function patchLessonItemComplete(itemId, accountId, completedAt, includeCompletedAt) {
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
    query: lessonCompletePatchFilter(itemId, accountId),
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
  // The authenticated actor's account, not the row's. The row was already
  // checked against it by assertCanWriteCalendarItem above; taking the id from
  // the row here would mean a row that slipped through carried its own
  // authority into the write.
  const accountId = cleanString(requestContext?.accountId, "", 140);
  if (!accountId) throw missingAccountScope("lesson_complete");
  const updateStarted = Date.now();
  let rows = [];
  let usedCompletedAtColumn = true;
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
          ),
        );
        break;
      } catch (error) {
        // No unscoped retry. If account_id cannot be applied the write is
        // refused rather than completing a lesson globally by id.
        if (isSupabaseAccountScopeMissingError(error)) throw missingAccountScope("lesson_complete");
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
        existing = await readLessonItemForCompletion(cleanItemId, accountId);
      } catch (error) {
        if (isSupabaseAccountScopeMissingError(error)) throw missingAccountScope("lesson_complete");
        throw error;
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
          usedAccountScope: true,
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
          usedAccountScope: true,
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
    await setSetting(accountId, "updatedAt", row.updated_at || nowIso());
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
      usedAccountScope: true,
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
      usedAccountScope: true,
      usedCompletedAtColumn,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const errorStatus = responseStatusFromError(error);
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
      usedAccountScope: true,
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
    // Whatever the client claimed, or nothing. The authoritative stamp happens
    // in calendarItemParams from server context.
    accountId: cleanSlug(item.accountId, ""),
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
    personId: cancelledGroupSession ? "" : cleanString(item.personId, "", 120),
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

// accountId is required. As an optional parameter defaulting to the original
// workspace, any caller that lost track of the business silently wrote a client
// into Sam Hale Golf.
function cleanPerson(person, source = "import", accountId: string) {
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
    // The server's account, full stop. This read `person.accountId || accountId`,
    // so a request body could name the business a client was filed under --
    // the forged-account-id case, for people.
    accountId: cleanSlug(accountId, ""),
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

// The country a bare national number (one with no leading +) is assumed to
// belong to. The deployment default comes from CLARITY_PHONE_COUNTRY; the
// workspace's own country setting overrides it. The active value lives in the
// shared phone module so the frontend and the server cannot drift apart.
function defaultPhoneCountry() {
  return cleanPhoneCountry(env("CLARITY_PHONE_COUNTRY", FALLBACK_PHONE_COUNTRY));
}

// UTC, not Auckland. When we genuinely do not know where the coach is, being
// obviously wrong everywhere beats being silently right in one country.
const FALLBACK_TIME_ZONE = "UTC";

// There used to be a module-level `activeTimeZone` here, set from whichever
// account was read last and reached through accountTimeZone() in a dozen
// places. It was written to stop a call site forgetting an argument, and it did
// -- by answering with a value that belonged to a different business.
//
// That matters more than the country did. Five of those call sites are slot
// maths (isSlotInPast, slotWallTimeToUtcMillis, appointmentMinutesSinceEnd,
// isAppointmentInPast, nowInTimeZoneParts). A stale timezone there does not
// format a date oddly; it decides whether a lesson has already happened, which
// is the difference between a reminder sending and not, and between a slot
// being offered to the public and not.
//
// The timezone is an argument now, and the functions that need one take it with
// no default -- so forgetting is a tsc error rather than a silently wrong hour.
// The deployment default below is a constant, never a previous request's value.
function defaultTimeZone() {
  return cleanString(env("CLARITY_TIMEZONE", ""), "", 80) || FALLBACK_TIME_ZONE;
}

/**
 * The timezone a business's wall-clock times are in.
 *
 * One key rather than readSettingsMap(): the bulk settings read is measured in
 * tens of kilobytes and some of these paths run per request. Mirrors
 * accountPhoneCountry() below, for the same reason.
 */
async function accountTimeZoneFor(accountId: string) {
  return (
    cleanString(await getSetting(cleanSlug(accountId, ""), "accountTimezone"), "", 80) ||
    defaultTimeZone()
  );
}

// Phone numbers reach us in three shapes for the same person: the booking form
// captures the national form (0274637700), spreadsheet imports carry the
// international form (+64274637700), and Excel prefixes text cells with an
// apostrophe ('+64274637700). Comparing raw digits treated these as three
// different people, so compatiblePersonMatch missed an existing contact, fell
// through to INSERT, and collided with the account-scoped unique index on
// lower(email) — taking the caller's entire calendar save down with it. The
// shared module is the single source of truth the frontend uses too.
/**
 * The country this business's bare phone numbers belong to.
 *
 * One key rather than readSettingsMap(): this is called on paths that write a
 * person, and the bulk settings read is measured in tens of kilobytes. Falls
 * back to the deployment default, never to whatever another business set.
 */
async function accountPhoneCountry(accountId: string) {
  return cleanPhoneCountry(
    await getSetting(cleanSlug(accountId, ""), "accountCountry"),
    defaultPhoneCountry(),
  );
}

function normalizedPersonPhone(value, country) {
  return canonicalPhoneKey(cleanString(value, "", 80), cleanPhoneCountry(country, defaultPhoneCountry()));
}

/**
 * `country` decides what a bare national number means, so it has to be the
 * business's own -- and it used to come from a module-level value that belonged
 * to whichever business the warm instance served last. It is an argument now.
 * The frontend passes the same one from the same setting, which is what keeps
 * the two sides agreeing about whether two numbers are one person.
 */
export function compatiblePersonMatch(candidate, rows = [], country = defaultPhoneCountry()) {
  if (!candidate || !Array.isArray(rows) || !rows.length) return null;
  // A candidate with no business matches nobody. Falling back to the original
  // workspace here would have merged a second business's client into a
  // same-named client of the first.
  const accountId = cleanSlug(candidate.accountId, "");
  if (!accountId) return null;
  const scopedRows = rows.filter((row) => recordBelongsToAccount(row, accountId));

  const candidateId = cleanString(candidate.id, "", 120);
  if (candidateId && !candidateId.startsWith("appointment-")) {
    const exactId = scopedRows.find((row) => String(row?.id || "") === candidateId);
    if (exactId) return exactId;
  }

  const name = normalizedPersonName(candidate.name);
  const email = normalizedPersonEmail(candidate.email);
  const phone = normalizedPersonPhone(candidate.phone, country);

  if (name && email) {
    const matches = scopedRows.filter(
      (row) =>
        normalizedPersonName(row?.name) === name &&
        normalizedPersonEmail(row?.email) === email,
    );
    const exact = matches.find((row) => {
      const existingPhone = normalizedPersonPhone(row?.phone, country);
      return !phone || !existingPhone || phone === existingPhone;
    });
    if (exact) return exact;
  }

  if (name && phone) {
    const exact = scopedRows.find(
      (row) =>
        normalizedPersonName(row?.name) === name &&
        normalizedPersonPhone(row?.phone, country) === phone,
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
      const existingPhone = normalizedPersonPhone(only?.phone, country);
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
      (row) => normalizedPersonPhone(row?.phone, country) === phone,
    );
    if (matches.length === 1) {
      const only = matches[0];
      const existingName = normalizedPersonName(only?.name);
      if (!name || !existingName || name === existingName) return only;
    }
  }

  // A booking taken with a name and nothing else. Every check above needs an
  // email or a phone number, so a contact with neither fell through to null and
  // the caller minted a fresh person row -- one per booking, forever, for the
  // same walk-in. Match on the name alone, but only against rows that are
  // themselves contactless and only when exactly one exists: two people who
  // share a name are told apart by their contact details, and a row that has
  // some must not be silently absorbed by one that has none.
  if (name && !email && !phone) {
    const matches = scopedRows.filter(
      (row) =>
        normalizedPersonName(row?.name) === name &&
        !normalizedPersonEmail(row?.email) &&
        !normalizedPersonPhone(row?.phone, country),
    );
    if (matches.length === 1) return matches[0];
  }

  return null;
}

// personByEmail() and duplicatePersonEmailError() were removed on 14 July 2026.
// They existed to enforce one-person-per-email, which the unique index on
// lower(email) also enforced at the database level. Both are gone: an email
// address is a contact method, not an identity, and families, clubs and couples
// legitimately share one. Same-person merging is compatiblePersonMatch's job and
// happens on name plus a compatible phone or email — never on an email alone.
// Please do not reintroduce a "this email is taken" rule here.

// The client derived from a booking belongs to the booking's business.
function personFromAppointment(item, accountId: string) {
  if (!item || item.kind !== "appointment") return null;
  return cleanPerson(
    {
      // A personId already stamped on the booking (see person_id on
      // calendar_items) is a stable link set up on a previous save. Carrying
      // it through here means importPeople's id-first match (see
      // compatiblePersonMatch) updates that same row instead of re-deriving
      // the link from name/email/phone, which used to spin off a duplicate,
      // disconnected profile whenever an edit changed any of those fields.
      id: item.personId,
      name: item.client || item.title,
      email: item.email,
      phone: item.phone,
      source: "appointment",
    },
    "appointment",
    accountId,
  );
}

// Applies the per-index results of importPeople(items.map(personFromAppointment))
// back onto the appointments they came from. Must run before writeItems so the
// resolved id is persisted in the same write instead of a second round trip.
function stampResolvedPersonIds(items, resolvedIds = []) {
  return items.map((item, index) => {
    if (item.kind !== "appointment") return item;
    const resolvedId = resolvedIds[index];
    if (!resolvedId || resolvedId === item.personId) return item;
    return { ...item, personId: resolvedId };
  });
}

// The account filter is in the SQL, not in a .filter() afterwards. Reading
// every business's calendar and then discarding the rows that do not belong to
// the caller made the tenant boundary a JavaScript predicate -- one wrong
// comparison and another business's day was on screen. It was also the whole
// table over the wire on every load.
export async function readItems(accountId: string) {
  if (!accountId) return [];
  // The bay comes along with the lesson so the calendar can show which ones are
  // covered without a second request and without matching on rendered text.
  // Only a live booking counts: a failed or cancelled sync row means no bay.
  const rows = await db().sql`
    SELECT ci.*,
           (s.optix_booking_id IS NOT NULL AND s.optix_booking_id <> ''
            AND s.sync_status = 'synced') AS bay_booked,
           s.resource_id AS bay_resource_id,
           s.start_timestamp AS bay_start_timestamp
    FROM calendar_items ci
    LEFT JOIN optix_booking_sync s ON s.calendar_item_id = ci.id
    WHERE ci.account_id = ${accountId}
    ORDER BY ci.week, ci.day, ci.start, ci.id
  `;
  return rows.map(rowToItem);
}

// Same shape as readItems() but for a single booking. Used by paths that act on
// one item and have no reason to pull the whole calendar first.
export async function readCalendarItemById(accountId: string, itemId) {
  const cleanId = cleanString(itemId, "", 140);
  if (!cleanId || !accountId) return null;
  // Scoped by id AND account: knowing another business's booking id must not be
  // enough to read it.
  const rows = await db().sql`
    SELECT ci.*,
           (s.optix_booking_id IS NOT NULL AND s.optix_booking_id <> ''
            AND s.sync_status = 'synced') AS bay_booked,
           s.resource_id AS bay_resource_id,
           s.start_timestamp AS bay_start_timestamp
    FROM calendar_items ci
    LEFT JOIN optix_booking_sync s ON s.calendar_item_id = ci.id
    WHERE ci.id = ${cleanId}
      AND ci.account_id = ${accountId}
    LIMIT 1
  `;
  return rows.length ? rowToItem(rows[0]) : null;
}

function publicBookingSlotsWeek(value) {
  const rawWeek = Number(value ?? currentWeekOffset());
  return Number.isInteger(rawWeek) ? rawWeek : currentWeekOffset();
}

// account_id is not optional any more. The `useAccountScope: false` variant
// existed for a schema where calendar_items had no account_id column; that
// column is now NOT NULL, and an unscoped week query would return every
// business's bookings.
export function publicSlotCalendarItemsQuery({ accountId, week } = {}) {
  const safeWeek = publicBookingSlotsWeek(week);
  const scopedAccountId = cleanSlug(accountId, "");
  if (!scopedAccountId) throw missingAccountScope("public_booking_slots");
  return [
    "select=*",
    `account_id=eq.${encodeURIComponent(scopedAccountId)}`,
    `week=eq.${encodeURIComponent(String(safeWeek))}`,
    "order=day.asc,start.asc,id.asc",
  ].join("&");
}

export async function readPublicSlotItemsForWeek({ accountId, week } = {}) {
  const safeWeek = publicBookingSlotsWeek(week);
  const query = publicSlotCalendarItemsQuery({ accountId, week: safeWeek });
  // No week_only_legacy_schema retry. If the account scope cannot be applied,
  // the correct answer is an error, not every business's week.
  const rows = await requestSupabaseRows("calendar_items", { query });
  return {
    items: rows.map(rowToItem),
    rowsFetched: rows.length,
    query,
    queryMode: "account_week",
    usedLegacySchemaFallback: false,
  };
}

export function publicAppointmentReadQuery({ appointmentId = "", accountId = "" } = {}) {
  const scopedAccountId = cleanSlug(accountId, "");
  if (!scopedAccountId) throw missingAccountScope("public_appointment_read");
  return [
    "select=*",
    `id=eq.${encodeURIComponent(cleanString(appointmentId, "", 160))}`,
    `account_id=eq.${encodeURIComponent(scopedAccountId)}`,
    "limit=1",
  ].join("&");
}

export function publicAppointmentContactQuery({ accountId, email } = {}) {
  const cleanEmailValue = cleanString(email, "", 180).toLowerCase();
  const scopedAccountId = cleanSlug(accountId, "");
  if (!scopedAccountId) throw missingAccountScope("public_reschedule_lookup");
  return [
    "select=*",
    "kind=eq.appointment",
    `email=ilike.${encodeURIComponent(cleanEmailValue)}`,
    `account_id=eq.${encodeURIComponent(scopedAccountId)}`,
    "order=week.asc,day.asc,start.asc,id.asc",
    "limit=50",
  ].join("&");
}

async function readPublicAppointmentById(appointmentId, accountId) {
  const cleanAppointmentId = cleanString(appointmentId, "", 160);
  const cleanAccountId = cleanSlug(accountId, "");
  if (!cleanAppointmentId) return null;
  if (!cleanAccountId) throw missingAccountScope("public_appointment_read");
  const query = publicAppointmentReadQuery({
    appointmentId: cleanAppointmentId,
    accountId: cleanAccountId,
  });
  const rows = await requestSupabaseRows("calendar_items", { query });
  return rows.map(rowToItem).find((item) => recordBelongsToAccount(item, cleanAccountId)) || null;
}

async function readPublicAppointmentsForContact({ accountId, email, phone } = {}) {
  const cleanAccountId = cleanSlug(accountId, "");
  const cleanEmailValue = cleanString(email, "", 180).toLowerCase();
  const normalizedEmail = normalizeRescheduleContact(cleanEmailValue);
  const normalizedPhone = normalizeRescheduleContact(phone);
  if (!cleanEmailValue || !normalizedEmail || !normalizedPhone) {
    return { items: [], rowsFetched: 0, queryMode: "invalid_contact" };
  }
  if (!cleanAccountId) throw missingAccountScope("public_reschedule_lookup");
  const query = publicAppointmentContactQuery({ accountId: cleanAccountId, email: cleanEmailValue });
  const rows = await requestSupabaseRows("calendar_items", { query });
  const items = rows
    .map(rowToItem)
    .filter((item) => recordBelongsToAccount(item, cleanAccountId) && matchesRescheduleContact(item, normalizedEmail, normalizedPhone));
  return { items, rowsFetched: rows.length, query, queryMode: "account_email" };
}

function queryRows(result) {
  return Array.isArray(result) ? result : result?.rows || [];
}

// No fallback account id. A person row with no owner belongs to nobody and is
// invisible to every business, rather than joining whichever one happens to be
// reading. Migration C backfilled the legacy rows and made the column NOT NULL,
// so this only bites genuinely malformed data.
function rowToPerson(row) {
  return {
    id: row.id,
    accountId: cleanSlug(row.account_id, ""),
    name: row.name,
    email: row.email || "",
    phone: row.phone || "",
    notes: row.notes || "",
    source: row.source || "",
    caddyProfileId: row.caddy_profile_id || "",
    caddyProfileUrl: row.caddy_profile_url || "",
    // TRUE only for people an inbound external booking created. They show in
    // the external booking clients list until merged or moved into the main
    // client list.
    external: row.external === true,
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

// notification_history carries its own account_id since Migration C. It used
// to be read globally -- the newest 500 rows for everyone -- and visibility was
// then inferred from whether the reader recognised the calendar item id. The
// owner column is the boundary now.
async function readNotificationHistory(accountId: string) {
  if (!accountId) return [];
  const rows = await db().sql`
    SELECT *
    FROM notification_history
    WHERE account_id = ${accountId}
    ORDER BY created_at DESC
    LIMIT 500
  `;
  return rows.map(rowToNotification);
}

async function readNotificationHistoryForAppointment(accountId: string, appointmentId) {
  const cleanAppointmentId = cleanString(appointmentId, "", 160);
  if (!cleanAppointmentId || !accountId) return [];
  const rows = await db().sql`
    SELECT *
    FROM notification_history
    WHERE calendar_item_id = ${cleanAppointmentId}
      AND account_id = ${accountId}
    ORDER BY created_at DESC
    LIMIT 50
  `;
  return rows.map(rowToNotification);
}

async function recordNotification({
  accountId = "",
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
  const owner = cleanSlug(accountId, "");
  if (!owner) throw missingAccountScope("record_notification");
  const record = {
    id: randomUUID(),
    accountId: owner,
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
      id, account_id, person_key, calendar_item_id, recipient, subject, kind, status, provider, provider_id, error, created_at
    )
    VALUES (
      ${record.id}, ${record.accountId}, ${record.personKey}, ${record.calendarItemId}, ${record.recipient}, ${record.subject},
      ${record.kind}, ${record.status}, ${record.provider}, ${record.providerId}, ${record.error}, NOW()
    )
  `;
  return record;
}

export async function readPeople(accountId: string) {
  if (!accountId) return [];
  const rows = await db().sql`
    SELECT * FROM people
    WHERE account_id = ${accountId}
    ORDER BY LOWER(name), LOWER(email), id
  `;
  return rows.map(rowToPerson);
}

const LESSON_NOTES_SETTING_PREFIX = "lessonNotes.v1";

function lessonNotesSettingKey(accountId: string) {
  const scoped = cleanSlug(accountId, "");
  if (!scoped) throw missingAccountScope("lesson_notes");
  return `${LESSON_NOTES_SETTING_PREFIX}.${scoped}`;
}

function rowToLessonNote(note, fallbackAccountId: string) {
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

async function readLessonNotes(accountId: string) {
  const cleanAccountId = cleanSlug(accountId, "");
  if (!cleanAccountId) throw missingAccountScope("lesson_notes");
  const raw = await getSetting(cleanAccountId, lessonNotesSettingKey(cleanAccountId));
  const parsed = safeJsonParse(raw, []);
  return Array.isArray(parsed)
    ? parsed
        .map((note) => rowToLessonNote(note, cleanAccountId))
        .filter((note) => note.playerId && note.body)
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    : [];
}

async function writeLessonNotes(notes, accountId: string) {
  const cleanAccountId = cleanSlug(accountId, "");
  if (!cleanAccountId) throw missingAccountScope("lesson_notes");
  const scopedNotes = Array.isArray(notes)
    ? notes
        .map((note) => rowToLessonNote(note, cleanAccountId))
        .filter((note) => note.playerId && note.body)
    : [];
  await setSetting(cleanAccountId, lessonNotesSettingKey(cleanAccountId), JSON.stringify(scopedNotes));
  return scopedNotes.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

async function upsertLessonNote(rawNote, accountId: string) {
  const cleanAccountId = cleanSlug(accountId, "");
  if (!cleanAccountId) throw missingAccountScope("lesson_notes");
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

async function deleteLessonNote(noteId, accountId: string) {
  const cleanAccountId = cleanSlug(accountId, "");
  if (!cleanAccountId) throw missingAccountScope("lesson_notes");
  const cleanId = cleanString(noteId, "", 120);
  if (!cleanId) {
    throw Object.assign(new Error("A lesson note id is required."), { status: 400 });
  }
  const current = await readLessonNotes(cleanAccountId);
  const notes = await writeLessonNotes(current.filter((note) => note.id !== cleanId), cleanAccountId);
  return { notes };
}

/* --- Practice blocks --------------------------------------------------------
 *
 * A Practice Block is a coach-authored practice prescription assigned
 * directly to a player: a title, the prescription text, an optional expiry,
 * an optional linked video. It is a real table (not settings JSON like lesson
 * notes) because the player portal reads "my active blocks" on every profile
 * load and status transitions server-side (active -> completed/expired/
 * archived) -- both want indexed per-player, per-status queries rather than a
 * whole document read-and-rewritten each time.
 *
 * Self-creating like guest_senders/player_sessions above: a deploy that
 * reaches production before the migration is applied by hand must not 500.
 * The repo migration (database/migrations/20260825000100_create_practice_blocks)
 * is the schema record.
 * ------------------------------------------------------------------------- */

let practiceBlocksTableReady = false;
async function ensurePracticeBlocksTable() {
  if (practiceBlocksTableReady) return;
  const ddl = ddlBatch();
  ddl.sql`
    CREATE TABLE IF NOT EXISTS practice_blocks (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      player_name TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      block_type TEXT NOT NULL DEFAULT 'custom',
      dose TEXT NOT NULL DEFAULT '',
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expiry_type TEXT NOT NULL DEFAULT 'none',
      expiry_date TIMESTAMPTZ,
      resolved_from_calendar_item_id TEXT,
      linked_video_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      completed_at TIMESTAMPTZ,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  // Added after the first release of this table, so ALTER rather than only
  // the CREATE above: a deployed account already has practice_blocks without
  // these two, and both reads and writes below assume the columns exist.
  ddl.sql`ALTER TABLE practice_blocks ADD COLUMN IF NOT EXISTS block_type TEXT NOT NULL DEFAULT 'custom'`;
  ddl.sql`ALTER TABLE practice_blocks ADD COLUMN IF NOT EXISTS dose TEXT NOT NULL DEFAULT ''`;
  ddl.sql`CREATE INDEX IF NOT EXISTS practice_blocks_player_history_idx ON practice_blocks (account_id, player_id, created_at DESC)`;
  ddl.sql`CREATE INDEX IF NOT EXISTS practice_blocks_player_active_idx ON practice_blocks (account_id, player_id) WHERE status = 'active'`;
  ddl.sql`CREATE INDEX IF NOT EXISTS practice_blocks_expiry_sweep_idx ON practice_blocks (account_id, expiry_date) WHERE status = 'active' AND expiry_date IS NOT NULL`;
  await ddl.run(db().pool);
  practiceBlocksTableReady = true;
}

/* A block's kind is a label, a colour and a set of composer fields -- all of
 * it account-configurable, none of it changing what a block *is*. So the
 * backend does not police the value: it stores the id the client sent, and the
 * client resolves it against the account's list when it renders.
 *
 * That is deliberate. The alternative -- validating against the stored list --
 * would mean a coach deleting a type could make an already-assigned block
 * unwritable, and would put a read of the settings blob in the path of every
 * save. Ids are slugs, so the only thing worth enforcing is the shape. */
export function practiceBlockType(value) {
  const clean = cleanString(value, "", 60).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || "custom";
}

/* --- Block types -----------------------------------------------------------
 *
 * Account config, so a settings key rather than a table: read whole, written
 * whole, a handful of rows, and never queried by anything but "give me the
 * list". A table would buy indexes nothing needs.
 *
 * Nothing is stored until a coach edits something. An untouched workspace
 * reads back an empty list and the client falls back to its own defaults --
 * which is what keeps the five built-in types defined in exactly one place
 * (src/modules/practice/practiceModel.ts) instead of here as well, drifting.
 * ------------------------------------------------------------------------- */
function practiceBlockTypesKey(accountId) {
  return `practice.blockTypes.v1.${cleanSlug(accountId, "default")}`;
}

const PRACTICE_FIELD_KEYS = ["steps", "dose", "expiry", "video"];

export function cleanPracticeBlockType(raw, taken) {
  const label = cleanString(raw?.label, "", 60);
  if (!label) return null;
  let id = practiceBlockType(raw?.id || label);
  // Ids are what every assigned block points at, so a collision inside one
  // save must not silently merge two types into one.
  if (taken.has(id)) {
    let n = 2;
    while (taken.has(`${id}-${n}`)) n += 1;
    id = `${id}-${n}`;
  }
  taken.add(id);
  const fields = {};
  PRACTICE_FIELD_KEYS.forEach((key) => {
    fields[key] = raw?.fields?.[key] !== false;
  });
  return {
    id,
    label,
    hint: cleanString(raw?.hint, "", 80),
    // #rgb or #rrggbb only. A colour is painted straight into a style
    // attribute, so anything else is refused rather than sanitised into
    // something the coach did not pick.
    tone: /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(String(raw?.tone || "")) ? String(raw.tone) : "#57544d",
    titleHint: cleanString(raw?.titleHint, "", 80),
    doseHint: cleanString(raw?.doseHint, "", 40),
    fields,
    archived: raw?.archived === true,
  };
}

async function readPracticeBlockTypes(accountId) {
  const parsed = safeJsonParse(await getSetting(accountId, practiceBlockTypesKey(accountId)), []);
  if (!Array.isArray(parsed)) return [];
  const taken = new Set();
  return parsed.map((raw) => cleanPracticeBlockType(raw, taken)).filter(Boolean);
}

async function writePracticeBlockTypes(input, requestContext) {
  const raw = Array.isArray(input?.blockTypes) ? input.blockTypes : null;
  if (!raw) throw Object.assign(new Error("A list of block types is required."), { status: 400 });
  if (raw.length > 24) {
    throw Object.assign(new Error("That is more block types than a wall can stay readable with."), { status: 400 });
  }
  const taken = new Set();
  const blockTypes = raw.map((entry) => cleanPracticeBlockType(entry, taken)).filter(Boolean);
  if (!blockTypes.length) {
    throw Object.assign(new Error("Keep at least one block type."), { status: 400 });
  }
  await setSetting(requestContext.accountId, practiceBlockTypesKey(requestContext.accountId), JSON.stringify(blockTypes));
  return { blockTypes };
}

function rowToApiPracticeBlock(row) {
  return {
    id: row.id,
    playerId: row.player_id,
    playerName: row.player_name || "",
    title: row.title,
    content: row.content,
    blockType: practiceBlockType(row.block_type),
    dose: row.dose || "",
    assignedAt: row.assigned_at,
    expiryType: row.expiry_type,
    expiryDate: row.expiry_date || null,
    linkedVideoId: row.linked_video_id || null,
    status: row.status,
    completedAt: row.completed_at || null,
    createdBy: row.created_by || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The player-facing shape -- no createdBy/playerName, nothing internal. */
function rowToPlayerPracticeBlock(row) {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    blockType: practiceBlockType(row.block_type),
    dose: row.dose || "",
    assignedAt: row.assigned_at,
    expiryType: row.expiry_type,
    expiryDate: row.expiry_date || null,
    linkedVideoId: row.linked_video_id || null,
    status: row.status,
    completedAt: row.completed_at || null,
  };
}

/**
 * Flips any active block whose expiry has passed to 'expired'. Run at the top
 * of every read path (coach list, player profile) so a status='active' filter
 * can never return a row whose expiry_date is already behind NOW() -- lazy,
 * on-read expiry, the same spirit as readPlayerSession destroying an expired
 * session token when it happens to be the one read.
 */
async function expirePracticeBlocksDue(accountId) {
  await ensurePracticeBlocksTable();
  await db().sql`
    UPDATE practice_blocks
    SET status = 'expired', updated_at = NOW()
    WHERE account_id = ${accountId}
      AND status = 'active'
      AND expiry_date IS NOT NULL
      AND expiry_date <= NOW()
  `;
}

/** Coach view: history included (completed/expired), archived excluded. */
async function readPracticeBlocksForPlayer(accountId, playerId) {
  await expirePracticeBlocksDue(accountId);
  const rows = await db().sql`
    SELECT * FROM practice_blocks
    WHERE account_id = ${accountId} AND player_id = ${playerId} AND status != 'archived'
    ORDER BY created_at DESC
  `;
  return rows.map(rowToApiPracticeBlock);
}

/**
 * Player-portal view. Filed against the same player id candidates as notes
 * (playerProfileIdCandidates), so a player who exists under more than one
 * historical id still sees everything filed under any of them.
 */
async function readPracticeBlocksForCandidates(accountId, candidates) {
  await expirePracticeBlocksDue(accountId);
  const ids = Array.from(candidates);
  if (!ids.length) return [];
  const rows = await db().sql`
    SELECT * FROM practice_blocks
    WHERE account_id = ${accountId} AND player_id = ANY(${ids}) AND status != 'archived'
    ORDER BY created_at DESC
  `;
  return rows.map(rowToPlayerPracticeBlock);
}

async function findPracticeBlockRow(accountId, id) {
  const rows = await db().sql`SELECT * FROM practice_blocks WHERE id = ${id} AND account_id = ${accountId} LIMIT 1`;
  return rows[0] || null;
}

async function createPracticeBlock(input, requestContext) {
  await ensurePracticeBlocksTable();
  const accountId = requestContext.accountId;
  const playerId = cleanString(input?.playerId, "", 160);
  const title = cleanString(input?.title, "", 200);
  const content = cleanString(input?.content, "", 8000);
  if (!playerId) throw Object.assign(new Error("A practice block needs a player id."), { status: 400 });
  if (!title) throw Object.assign(new Error("A practice block needs a title."), { status: 400 });
  if (!content) throw Object.assign(new Error("A practice block needs a description."), { status: 400 });

  const expiryTypeRequested = ["next_lesson", "set_date", "none"].includes(input?.expiryType)
    ? input.expiryType
    : "none";
  let expiryType = expiryTypeRequested;
  let expiryDate = null;
  let resolvedFromCalendarItemId = null;
  let warning;

  if (expiryTypeRequested === "set_date") {
    expiryDate = cleanString(input?.expiryDate, "", 80);
    if (!expiryDate) throw Object.assign(new Error("Pick a date for this block's expiry."), { status: 400 });
  } else if (expiryTypeRequested === "next_lesson") {
    const resolved = await resolveNextLessonExpiry(playerId, accountId);
    if (resolved) {
      expiryDate = resolved.expiryDate;
      resolvedFromCalendarItemId = resolved.calendarItemId;
    } else {
      // Confirmed fallback: save anyway with no expiry rather than inventing
      // a fake date or blocking the save outright.
      expiryType = "none";
      warning = "no_upcoming_booking";
    }
  }

  const id = randomUUID();
  const now = nowIso();
  const rows = await db().sql`
    INSERT INTO practice_blocks (
      id, account_id, player_id, player_name, title, content, block_type, dose,
      assigned_at, expiry_type, expiry_date, resolved_from_calendar_item_id,
      linked_video_id, status, created_by, created_at, updated_at
    ) VALUES (
      ${id}, ${accountId}, ${playerId}, ${cleanString(input?.playerName, "", 180)},
      ${title}, ${content}, ${practiceBlockType(input?.blockType)}, ${cleanString(input?.dose, "", 60)},
      ${now}, ${expiryType}, ${expiryDate}, ${resolvedFromCalendarItemId},
      ${cleanString(input?.linkedVideoId, "", 160) || null}, 'active',
      ${requestContext.userId || requestContext.user?.email || ""}, ${now}, ${now}
    )
    RETURNING *
  `;
  return { block: rowToApiPracticeBlock(rows[0]), ...(warning ? { warning } : {}) };
}

async function updatePracticeBlock(id, input, requestContext) {
  await ensurePracticeBlocksTable();
  const accountId = requestContext.accountId;
  const cleanId = cleanString(id, "", 120);
  if (!cleanId) throw Object.assign(new Error("A practice block id is required."), { status: 400 });
  const current = await findPracticeBlockRow(accountId, cleanId);
  if (!current) throw Object.assign(new Error("That practice block was not found."), { status: 404, code: "not_found" });
  if (current.status !== "active") {
    throw Object.assign(new Error("Only an active practice block can be edited."), { status: 409, code: "not_editable" });
  }

  const title = cleanString(input?.title, current.title, 200);
  const content = cleanString(input?.content, current.content, 8000);
  const expiryTypeRequested = ["next_lesson", "set_date", "none"].includes(input?.expiryType)
    ? input.expiryType
    : current.expiry_type;

  let expiryType = expiryTypeRequested;
  let expiryDate = current.expiry_date;
  let resolvedFromCalendarItemId = current.resolved_from_calendar_item_id;
  let warning;

  // Re-resolving next_lesson only happens when the coach explicitly (re-)picks
  // it -- editing title/content alone must never move an already-assigned
  // expiry.
  if (expiryTypeRequested === "set_date" && expiryTypeRequested !== current.expiry_type) {
    expiryDate = cleanString(input?.expiryDate, "", 80) || null;
    resolvedFromCalendarItemId = null;
  } else if (expiryTypeRequested === "set_date" && input?.expiryDate) {
    expiryDate = cleanString(input.expiryDate, "", 80);
    resolvedFromCalendarItemId = null;
  } else if (expiryTypeRequested === "none" && expiryTypeRequested !== current.expiry_type) {
    expiryDate = null;
    resolvedFromCalendarItemId = null;
  } else if (expiryTypeRequested === "next_lesson" && expiryTypeRequested !== current.expiry_type) {
    const resolved = await resolveNextLessonExpiry(current.player_id, accountId);
    if (resolved) {
      expiryDate = resolved.expiryDate;
      resolvedFromCalendarItemId = resolved.calendarItemId;
    } else {
      expiryType = "none";
      expiryDate = null;
      resolvedFromCalendarItemId = null;
      warning = "no_upcoming_booking";
    }
  }

  const linkedVideoId =
    input?.linkedVideoId !== undefined
      ? cleanString(input.linkedVideoId, "", 160) || null
      : current.linked_video_id;

  const blockType = input?.blockType !== undefined ? practiceBlockType(input.blockType) : practiceBlockType(current.block_type);
  const dose = input?.dose !== undefined ? cleanString(input.dose, "", 60) : current.dose || "";

  const rows = await db().sql`
    UPDATE practice_blocks
    SET title = ${title}, content = ${content}, block_type = ${blockType}, dose = ${dose},
        expiry_type = ${expiryType},
        expiry_date = ${expiryDate}, resolved_from_calendar_item_id = ${resolvedFromCalendarItemId},
        linked_video_id = ${linkedVideoId},
        updated_at = NOW()
    WHERE id = ${cleanId} AND account_id = ${accountId}
    RETURNING *
  `;
  return { block: rowToApiPracticeBlock(rows[0]), ...(warning ? { warning } : {}) };
}

/** Soft-delete only -- "Remove" archives, it never issues a SQL DELETE. */
async function archivePracticeBlock(id, requestContext) {
  await ensurePracticeBlocksTable();
  const cleanId = cleanString(id, "", 120);
  if (!cleanId) throw Object.assign(new Error("A practice block id is required."), { status: 400 });
  const rows = await db().sql`
    UPDATE practice_blocks
    SET status = 'archived', updated_at = NOW()
    WHERE id = ${cleanId} AND account_id = ${requestContext.accountId}
    RETURNING *
  `;
  if (!rows[0]) throw Object.assign(new Error("That practice block was not found."), { status: 404, code: "not_found" });
  return { block: rowToApiPracticeBlock(rows[0]) };
}

/**
 * Player-side "Mark Complete". A block completed after it expired still
 * counts -- a player who did the work late shouldn't be blocked from getting
 * credit -- so the only rejected states are "doesn't belong to this player"
 * and "archived" (the coach removed it; no longer actionable).
 */
async function completePracticeBlockForPlayer(id, session) {
  await ensurePracticeBlocksTable();
  const cleanId = cleanString(id, "", 120);
  if (!cleanId) throw Object.assign(new Error("A practice block id is required."), { status: 400 });
  // The player's session records the business they belong to. It used to fall
  // back to "the default public workspace", which would have handed a player
  // from one business the other's practice blocks.
  const accountId = cleanSlug(session?.accountId, "");
  if (!accountId) throw missingAccountScope("player_practice_complete");
  await expirePracticeBlocksDue(accountId);
  const row = await findPracticeBlockRow(accountId, cleanId);
  const candidates = playerProfileIdCandidates(session);
  if (!row || !candidates.has(row.player_id)) {
    throw Object.assign(new Error("That practice block was not found."), { status: 404, code: "not_found" });
  }
  if (row.status === "archived") {
    throw Object.assign(new Error("That practice block was not found."), { status: 404, code: "not_found" });
  }
  const rows = await db().sql`
    UPDATE practice_blocks
    SET status = 'completed', completed_at = NOW(), updated_at = NOW()
    WHERE id = ${cleanId}
    RETURNING *
  `;
  return { block: rowToPlayerPracticeBlock(rows[0]) };
}

/* --- Practice block presets and suggestions ---------------------------------
 *
 * Two ways to start a block without retyping it, both feeding the same
 * composer:
 *
 *   Presets      -- what the coach chose to keep. A real table, because the
 *                   coach decides what goes in it and expects it to stay put.
 *   Suggestions  -- what the coach actually assigns most, derived on read from
 *                   practice_blocks. No table: anything stored would drift
 *                   from the assignment history it claims to summarise.
 *
 * They are read together by one route, because the composer wants both at the
 * same moment and a second round trip buys nothing.
 * ------------------------------------------------------------------------- */

let practiceBlockPresetsTableReady = false;
async function ensurePracticeBlockPresetsTable() {
  if (practiceBlockPresetsTableReady) return;
  const ddl = ddlBatch();
  ddl.sql`
    CREATE TABLE IF NOT EXISTS practice_block_presets (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      block_type TEXT NOT NULL DEFAULT 'custom',
      dose TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  // Added after this table's first release -- see the matching ALTERs on
  // practice_blocks. sort_order exists because the rail is hand-ordered by
  // drag: the coach's order is a decision, not a side effect of when they
  // happened to save each one.
  ddl.sql`ALTER TABLE practice_block_presets ADD COLUMN IF NOT EXISTS block_type TEXT NOT NULL DEFAULT 'custom'`;
  ddl.sql`ALTER TABLE practice_block_presets ADD COLUMN IF NOT EXISTS dose TEXT NOT NULL DEFAULT ''`;
  ddl.sql`ALTER TABLE practice_block_presets ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0`;
  ddl.sql`CREATE INDEX IF NOT EXISTS practice_block_presets_account_idx ON practice_block_presets (account_id, sort_order, created_at DESC)`;
  // The save path's ON CONFLICT target -- must exist before any preset is
  // saved, not just before the migration is applied by hand.
  ddl.sql`CREATE UNIQUE INDEX IF NOT EXISTS practice_block_presets_title_key ON practice_block_presets (account_id, lower(title))`;
  await ddl.run(db().pool);
  practiceBlockPresetsTableReady = true;
}

function rowToApiPracticePreset(row) {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    blockType: practiceBlockType(row.block_type),
    dose: row.dose || "",
    sortOrder: Number(row.sort_order) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The coach's favourites rail, in the order they dragged it into. New ones
 * are saved at sort_order 0 so they land at the top of the rail where the
 * coach is looking; created_at breaks ties between anything never dragged.
 */
async function readPracticeBlockPresets(accountId) {
  await ensurePracticeBlockPresetsTable();
  const rows = await db().sql`
    SELECT * FROM practice_block_presets
    WHERE account_id = ${accountId}
    ORDER BY sort_order ASC, created_at DESC
  `;
  return rows.map(rowToApiPracticePreset);
}

/**
 * Save-as-preset. Saving under a title that already exists rewrites that
 * preset rather than sitting a near-duplicate next to it -- a coach who edits
 * a block and saves it again means "the preset says this now", and a list of
 * three subtly different "Start Line Control"s helps nobody.
 */
async function savePracticeBlockPreset(input, requestContext) {
  await ensurePracticeBlockPresetsTable();
  const title = cleanString(input?.title, "", 200);
  const content = cleanString(input?.content, "", 8000);
  if (!title) throw Object.assign(new Error("A preset needs a title."), { status: 400 });
  if (!content) throw Object.assign(new Error("A preset needs a description."), { status: 400 });

  const now = nowIso();
  // Everything already in the rail is pushed down one so this lands at the
  // top. Done before the insert, and the insert then claims 0, so two saves in
  // a row still come out newest-first rather than tied.
  await db().sql`
    UPDATE practice_block_presets SET sort_order = sort_order + 1
    WHERE account_id = ${requestContext.accountId}
  `;
  const rows = await db().sql`
    INSERT INTO practice_block_presets (
      id, account_id, title, content, block_type, dose, sort_order, created_by, created_at, updated_at
    )
    VALUES (
      ${randomUUID()}, ${requestContext.accountId}, ${title}, ${content},
      ${practiceBlockType(input?.blockType)}, ${cleanString(input?.dose, "", 60)}, 0,
      ${requestContext.userId || requestContext.user?.email || ""}, ${now}, ${now}
    )
    ON CONFLICT (account_id, lower(title)) DO UPDATE
      SET title = EXCLUDED.title, content = EXCLUDED.content,
          block_type = EXCLUDED.block_type, dose = EXCLUDED.dose,
          sort_order = 0, updated_at = NOW()
    RETURNING *
  `;
  return { preset: rowToApiPracticePreset(rows[0]) };
}

/**
 * Rename in place, and reorder the rail. Two edits of the same kind -- both
 * are the coach saying "this rail is wrong, fix it" without changing what any
 * block prescribes -- so they share a route rather than each getting one.
 *
 * A rename that collides with another preset's title is rejected rather than
 * silently merged: the unique index means one of the two would have to go, and
 * which one is not this route's call to make.
 */
async function updatePracticeBlockPreset(input, requestContext) {
  await ensurePracticeBlockPresetsTable();
  const accountId = requestContext.accountId;

  const order = Array.isArray(input?.order) ? input.order.map((id) => cleanString(id, "", 120)).filter(Boolean) : null;
  if (order && order.length) {
    // One statement per row: the list is a handful of ids, and a CASE-based
    // bulk update would need dynamic SQL the tagged-template client can't take.
    for (let index = 0; index < order.length; index += 1) {
      await db().sql`
        UPDATE practice_block_presets SET sort_order = ${index}, updated_at = NOW()
        WHERE id = ${order[index]} AND account_id = ${accountId}
      `;
    }
    return { presets: await readPracticeBlockPresets(accountId) };
  }

  const cleanId = cleanString(input?.id, "", 120);
  if (!cleanId) throw Object.assign(new Error("A preset id is required."), { status: 400 });
  const existing = await db().sql`
    SELECT * FROM practice_block_presets WHERE id = ${cleanId} AND account_id = ${accountId} LIMIT 1
  `;
  const current = existing[0];
  if (!current) throw Object.assign(new Error("That preset was not found."), { status: 404, code: "not_found" });

  const title = cleanString(input?.title, current.title, 200);
  if (!title) throw Object.assign(new Error("A preset needs a title."), { status: 400 });
  const clash = await db().sql`
    SELECT id FROM practice_block_presets
    WHERE account_id = ${accountId} AND lower(title) = ${title.toLowerCase()} AND id <> ${cleanId}
    LIMIT 1
  `;
  if (clash[0]) {
    throw Object.assign(new Error(`You already have a preset called "${title}".`), { status: 409, code: "duplicate_title" });
  }

  const content = cleanString(input?.content, current.content, 8000);
  const blockType = input?.blockType !== undefined ? practiceBlockType(input.blockType) : practiceBlockType(current.block_type);
  const dose = input?.dose !== undefined ? cleanString(input.dose, "", 60) : current.dose || "";

  const rows = await db().sql`
    UPDATE practice_block_presets
    SET title = ${title}, content = ${content}, block_type = ${blockType}, dose = ${dose}, updated_at = NOW()
    WHERE id = ${cleanId} AND account_id = ${accountId}
    RETURNING *
  `;
  return { preset: rowToApiPracticePreset(rows[0]) };
}

/**
 * Hard delete, unlike a practice block's archive. A preset is a convenience
 * with no history worth keeping -- the blocks already assigned from it are
 * their own rows and are untouched by this.
 */
async function deletePracticeBlockPreset(id, requestContext) {
  await ensurePracticeBlockPresetsTable();
  const cleanId = cleanString(id, "", 120);
  if (!cleanId) throw Object.assign(new Error("A preset id is required."), { status: 400 });
  const rows = await db().sql`
    DELETE FROM practice_block_presets
    WHERE id = ${cleanId} AND account_id = ${requestContext.accountId}
    RETURNING id
  `;
  if (!rows[0]) throw Object.assign(new Error("That preset was not found."), { status: 404, code: "not_found" });
  return { deletedId: cleanId };
}

/**
 * "Used often" -- the account's most-assigned block titles, carrying the most
 * recent wording of each.
 *
 * Grouped by title rather than by title+content on purpose: the same drill
 * gets its text tweaked per player, and grouping on the pair would scatter one
 * popular block across a dozen rows that each look assigned once. The newest
 * version of the text wins, since that is the phrasing the coach settled on.
 *
 * Titles the player already has active are dropped -- suggesting what they are
 * currently working on is the one suggestion that is never useful.
 */
async function readPracticeSuggestions(accountId, playerId) {
  await ensurePracticeBlocksTable();
  // Read before the query, not after it: filtering dismissals out of an
  // already-capped result would let a coach who has waved away the top few
  // end up with a short rail while plenty more were available below the cap.
  const dismissed = Array.from(await readPracticeDismissedSuggestions(accountId));
  const rows = await db().sql`
    WITH ranked AS (
      SELECT
        title,
        content,
        block_type,
        dose,
        created_at,
        COUNT(*) OVER (PARTITION BY lower(title)) AS uses,
        ROW_NUMBER() OVER (PARTITION BY lower(title) ORDER BY created_at DESC) AS recency
      FROM practice_blocks
      WHERE account_id = ${accountId} AND status <> 'archived'
    )
    SELECT title, content, block_type, dose, uses, created_at
    FROM ranked
    WHERE recency = 1
      AND NOT (lower(title) = ANY(${dismissed}))
      AND lower(title) NOT IN (
        SELECT lower(title) FROM practice_blocks
        WHERE account_id = ${accountId} AND player_id = ${playerId} AND status = 'active'
      )
    ORDER BY uses DESC, created_at DESC
    LIMIT 24
  `;
  return rows.map((row) => ({
    title: row.title,
    content: row.content,
    blockType: practiceBlockType(row.block_type),
    dose: row.dose || "",
    uses: Number(row.uses) || 1,
  }));
}

/* Dismissed suggestions.
 *
 * A suggestion is derived, so "hide this one" has nowhere on practice_blocks
 * to live -- the only alternative would be marking the underlying blocks,
 * which would rewrite history to change a chip. A settings key instead: a
 * list of titles the coach has waved away, account-scoped like the
 * suggestions themselves.
 *
 * Titles, not ids, because that is what a suggestion is grouped by. Assigning
 * the same title again does not resurrect it -- the coach still meant "stop
 * offering me this" -- but un-hiding it is one click in the same rail. */
function practiceDismissedSuggestionsKey(accountId) {
  return `practice.dismissedSuggestions.v1.${cleanSlug(accountId, "default")}`;
}

async function readPracticeDismissedSuggestions(accountId) {
  const raw = await getSetting(accountId, practiceDismissedSuggestionsKey(accountId));
  const parsed = safeJsonParse(raw, []);
  return new Set(
    Array.isArray(parsed) ? parsed.map((title) => String(title).toLowerCase()).filter(Boolean) : [],
  );
}

async function dismissPracticeSuggestion(input, requestContext) {
  const title = cleanString(input?.title, "", 200);
  if (!title) throw Object.assign(new Error("A suggestion title is required."), { status: 400 });
  const accountId = requestContext.accountId;
  const dismissed = await readPracticeDismissedSuggestions(accountId);
  if (input?.restore) dismissed.delete(title.toLowerCase());
  else dismissed.add(title.toLowerCase());
  // Capped so one coach dismissing steadily for a year cannot grow a settings
  // row without bound. Oldest dismissals fall off first, which just means a
  // long-forgotten suggestion may be offered again.
  const kept = Array.from(dismissed).slice(-200);
  await setSetting(accountId, practiceDismissedSuggestionsKey(accountId), JSON.stringify(kept));
  return { dismissed: kept };
}

/**
 * The composer's whole "start from something" payload. Suggestions that
 * duplicate a preset are dropped here rather than in the panel -- one chip per
 * idea, and the preset is the better chip because the coach can delete it.
 */
async function readPracticeComposerStarters(accountId, playerId) {
  const [presets, suggestions, blockTypes] = await Promise.all([
    readPracticeBlockPresets(accountId),
    readPracticeSuggestions(accountId, playerId),
    // Carried here rather than on a third call: the composer cannot render a
    // type tab without them, so they are wanted at exactly this moment.
    readPracticeBlockTypes(accountId),
  ]);
  const presetTitles = new Set(presets.map((preset) => preset.title.toLowerCase()));
  return {
    presets,
    suggestions: suggestions.filter((suggestion) => !presetTitles.has(suggestion.title.toLowerCase())),
    blockTypes,
  };
}

/**
 * True when writing this person would leave the stored row exactly as it is.
 *
 * The UPDATE in importPeople sets each field with COALESCE(NULLIF($n, ''),
 * column), so an empty incoming value never overwrites anything and an equal one
 * writes back what is already there. Every full calendar save re-derives a
 * contact from every appointment on the calendar, and on an ordinary save none
 * of them differ — so this is the check that turns hundreds of round trips into
 * none. updated_at would move, but nothing reads it as a contact-changed signal.
 */
export function personRowUnchanged(person, existing, fallbackAccountId, source) {
  const matches = (incoming, current) => {
    const next = cleanString(incoming, "", 400);
    return !next || next === cleanString(current, "", 400);
  };
  return (
    matches(person.name, existing.name) &&
    matches(person.email, existing.email) &&
    matches(person.phone, existing.phone) &&
    matches(person.notes, existing.notes) &&
    matches(person.source || source, existing.source) &&
    matches(person.caddyProfileId, existing.caddyProfileId) &&
    matches(person.caddyProfileUrl, existing.caddyProfileUrl) &&
    // The account this write would actually use -- which is the caller's, not
    // the payload's, since the write paths stopped honouring person.accountId.
    matches(fallbackAccountId, existing.accountId)
  );
}

async function importPeople(rawPeople, source = "import", accountId: string) {
  const cleanAccountId = cleanSlug(accountId, "");
  if (!cleanAccountId) throw missingAccountScope("import_people");
  // Indexed (not filtered) so callers that need to stamp a resolved person id
  // back onto the record a given input came from (see resolvedIds below) can
  // line results up positionally with rawPeople, including the null/skipped
  // entries.
  const indexedPeople = Array.isArray(rawPeople)
    ? rawPeople.map((person) => cleanPerson(person, source, cleanAccountId))
    : [];
  const people = indexedPeople.filter(Boolean);
  const resolvedIds = indexedPeople.map(() => "");
  const result = {
    imported: 0,
    updated: 0,
    skipped: Array.isArray(rawPeople) ? rawPeople.length - people.length : 0,
    failed: 0,
    errors: [],
    people: [],
    resolvedIds,
  };
  if (!Array.isArray(rawPeople)) return result;

  // Read once for the whole import rather than per row: matching every incoming
  // person against the list needs the same country, and it is this business's.
  const phoneCountry = await accountPhoneCountry(cleanAccountId);

  const knownPeople = await readPeople(cleanAccountId);
  const knownById = new Map(knownPeople.map((row) => [row.id, row]));
  // Opened on the first person that actually needs writing. A full calendar save
  // re-derives a contact from every appointment on the calendar, and on a normal
  // save none of them have changed — see personRowUnchanged. Connecting and
  // running BEGIN/COMMIT for a transaction with no writes in it is pure latency
  // on a pool that only has three connections to hand out.
  let client = null;
  const openTransaction = async () => {
    if (!client) {
      client = await db().pool.connect();
      await client.query("BEGIN");
    }
    return client;
  };
  let personIndex = 0;
  try {
    for (let sourceIndex = 0; sourceIndex < indexedPeople.length; sourceIndex += 1) {
      const person = indexedPeople[sourceIndex];
      if (!person) continue;
      // A person id carried on the incoming record (an appointment's stored
      // person_id, see personFromAppointment) is an explicit, stable link set
      // up on a previous save. Trust it ahead of the fuzzy name/email/phone
      // heuristic below: compatiblePersonMatch already checks this id first,
      // but knownById lets us confirm the id still resolves to a real row
      // before treating the fuzzy match as a fallback.
      const linkedId = cleanString(person.id, "", 120);
      const linked = linkedId && !linkedId.startsWith("appointment-") ? knownById.get(linkedId) : null;
      const existing = linked || compatiblePersonMatch(person, knownPeople, phoneCountry);
      const existingId = existing?.id || "";

      // Already matches what is stored, so the UPDATE below would write the row
      // back to itself. Skip it: this is the case for nearly every contact on
      // nearly every save, and the round trips it saves are the difference
      // between a save that lands and one that times out.
      if (existingId && personRowUnchanged(person, existing, cleanAccountId, source)) {
        result.updated += 1;
        resolvedIds[sourceIndex] = existingId;
        continue;
      }

      // Every person write gets its own savepoint. Deriving contacts from
      // appointments is housekeeping that rides along with the caller's save;
      // when one contact cannot be reconciled (for example its email already
      // belongs to another row under the account-scoped unique index) it must
      // not abort the transaction and take the lesson the coach just booked
      // down with it. Previously a single duplicate contact rolled back the
      // whole calendar save and surfaced as a 409 the coach could not act on.
      const savepoint = `person_${personIndex}`;
      personIndex += 1;
      await (await openTransaction()).query(`SAVEPOINT ${savepoint}`);
      try {
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
              cleanAccountId,
	          ],
	        );
	        Object.assign(existing, {
            accountId: cleanAccountId,
	          name: person.name || existing.name,
          email: person.email || existing.email,
          phone: person.phone || existing.phone,
          notes: person.notes || existing.notes,
          source: person.source || source || existing.source,
          caddyProfileId: person.caddyProfileId || existing.caddyProfileId,
          caddyProfileUrl: person.caddyProfileUrl || existing.caddyProfileUrl,
        });
        result.updated += 1;
        resolvedIds[sourceIndex] = existingId;
      } else {
        const personId = linkedId && !linkedId.startsWith("appointment-") ? linkedId : randomUUID();
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
              cleanAccountId,
	          ],
	        );
        const created = { ...person, id: personId };
        knownPeople.push(created);
        knownById.set(personId, created);
        result.imported += 1;
        resolvedIds[sourceIndex] = personId;
      }
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        const message = error instanceof Error ? error.message : String(error || "");
        result.failed += 1;
        result.errors.push({
          name: person.name || "",
          email: person.email || "",
          reason: /duplicate key|idx_people_.*email/i.test(message)
            ? "A contact in this account already uses that email address."
            : message.slice(0, 300),
        });
        console.warn("people_import_person_skipped", {
          source,
          accountId: cleanAccountId,
          name: person.name || "",
          email: person.email || "",
          message: message.slice(0, 300),
        });
      }
    }
    if (client) await client.query("COMMIT");
  } catch (error) {
    if (client) await client.query("ROLLBACK");
    throw error;
  } finally {
    if (client) client.release();
  }

  result.people = await readPeople(cleanAccountId);
  return result;
}

async function updatePerson(rawPerson, accountId: string) {
  const cleanAccountId = cleanSlug(accountId, "");
  if (!cleanAccountId) throw missingAccountScope("update_person");
  const person = cleanPerson(rawPerson, "manual_update", cleanAccountId);
  if (!person) {
    const error = new Error("A person needs a name or email.");
    error.status = 400;
    throw error;
  }

  const knownPeople = await readPeople(cleanAccountId);
  const existing = compatiblePersonMatch(person, knownPeople, await accountPhoneCountry(cleanAccountId));
  const existingId = existing?.id || "";
  const personId =
    existingId ||
    (person.id && !person.id.startsWith("appointment-")
      ? person.id
      : randomUUID());

  // No email-ownership check. A parent booking for two children, a club booking
  // for its players, a couple sharing an inbox — all use one address for several
  // people, and refusing the second one is wrong. compatiblePersonMatch above has
  // already merged this record into an existing contact if it genuinely is the
  // same person (matching name with a compatible phone or email); if it did not,
  // this is a different person who happens to share an address, and they are
  // entitled to their own row.

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
            cleanAccountId,
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
            cleanAccountId,
	        ],
	      );
    }

    const saved = await client.query(
      "SELECT * FROM people WHERE id = $1 LIMIT 1",
      [personId],
    );
    await client.query("COMMIT");
    return { person: rowToPerson(saved.rows[0]), people: await readPeople(cleanAccountId) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function mergePeople(rawSurvivorId, rawLoserId, fieldOverrides = {}, accountId: string) {
  const cleanAccountId = cleanSlug(accountId, "");
  if (!cleanAccountId) throw missingAccountScope("merge_people");
  const survivorId = cleanString(rawSurvivorId, "", 120);
  const loserId = cleanString(rawLoserId, "", 120);
  if (!survivorId || !loserId || survivorId === loserId) {
    throw Object.assign(new Error("Two different clients are required to merge."), {
      status: 400,
      code: "PEOPLE_MERGE_INVALID_IDS",
    });
  }

  const knownPeople = await readPeople(cleanAccountId);
  const survivorRow = knownPeople.find((person) => person.id === survivorId);
  const loserRow = knownPeople.find((person) => person.id === loserId);
  if (!survivorRow || !loserRow) {
    throw Object.assign(new Error("One of the selected clients could not be found."), {
      status: 404,
      code: "PEOPLE_MERGE_NOT_FOUND",
    });
  }

  const merged = cleanPerson({ ...survivorRow, ...fieldOverrides, id: survivorId }, survivorRow.source, cleanAccountId);
  if (!merged) {
    throw Object.assign(new Error("The merged client needs a name or email."), {
      status: 400,
      code: "PEOPLE_MERGE_INVALID_FIELDS",
    });
  }

  const client = await db().pool.connect();
  let mergedItemIds = [];
  let mergedExternalBookingIds = [];
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE people
       SET name = $2,
           email = NULLIF($3, ''),
           phone = NULLIF($4, ''),
           notes = NULLIF($5, ''),
           caddy_profile_id = NULLIF($6, ''),
           caddy_profile_url = NULLIF($7, ''),
           updated_at = NOW()
       WHERE id = $1`,
      [survivorId, merged.name, merged.email, merged.phone, merged.notes, merged.caddyProfileId, merged.caddyProfileUrl],
    );
    const reassigned = await client.query(
      "UPDATE calendar_items SET person_id = $1, updated_at = NOW() WHERE person_id = $2 RETURNING id",
      [survivorId, loserId],
    );
    mergedItemIds = queryRows(reassigned).map((row) => row.id);
    // Both tables below are created outside ensureSchema() — one by a migration,
    // one lazily on first player login — so a database that has never needed
    // them is not an error and must not abort the merge.
    // Same question as the module-level tableExists(), asked on the pooled
    // client this transaction is already holding rather than on a new one.
    const tableExistsHere = async (table) =>
      Boolean(
        queryRows(await client.query("SELECT to_regclass($1) AS name", [`public.${table}`]))[0]?.name,
      );
    // External providers resolve the customer from their own link row, and
    // processStoredExternalEvent() prefers that value over the calendar item. Left
    // behind, the next inbound event would write the deleted loser id straight
    // back onto the booking and silently undo this merge.
    if (await tableExistsHere("external_booking_links")) {
      const relinked = await client.query(
        "UPDATE external_booking_links SET person_id = $1, updated_at = NOW() WHERE person_id = $2 RETURNING external_booking_id",
        [survivorId, loserId],
      );
      mergedExternalBookingIds = queryRows(relinked).map((row) => row.external_booking_id);
    }
    // A live player session carries the person id into playerProfileIdCandidates(),
    // which is what selects the portal's lesson notes. The notes move to the
    // survivor below, so a session left on the loser id would show the customer
    // an empty notes list until their next sign-in. No updated_at on this table.
    if (await tableExistsHere("player_sessions")) {
      await client.query(
        "UPDATE player_sessions SET person_id = $1 WHERE person_id = $2",
        [survivorId, loserId],
      );
    }
    // Optix sales carry no email, so they are the records most likely to be
    // sitting on a duplicate person in the first place — which makes them the
    // ones a merge most needs to move. There is no foreign key on this column,
    // so leaving them behind does not fail loudly: the purchase would simply
    // point at a deleted person id and drop out of the client's history with
    // nothing to show it had ever been linked.
    if (await tableExistsHere("optix_pass_purchases")) {
      await client.query(
        "UPDATE optix_pass_purchases SET person_id = $1, updated_at = NOW() WHERE person_id = $2",
        [survivorId, loserId],
      );
    }
    await client.query("DELETE FROM people WHERE id = $1", [loserId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  // Lesson notes live in a per-account settings JSON blob (see
  // LESSON_NOTES_SETTING_PREFIX), not a SQL table, so they can't be reassigned
  // inside the transaction above. Do it right after the transaction commits so
  // a note is never left pointing at a person id that no longer exists.
  const currentNotes = await readLessonNotes(cleanAccountId);
  const mergedNoteIds = currentNotes.filter((note) => note.playerId === loserId).map((note) => note.id);
  if (mergedNoteIds.length) {
    await writeLessonNotes(
      currentNotes.map((note) => (note.playerId === loserId ? { ...note, playerId: survivorId } : note)),
      cleanAccountId,
    );
  }

  const savedRows = await db().sql`SELECT * FROM people WHERE id = ${survivorId} LIMIT 1`;
  return {
    person: rowToPerson(savedRows[0]),
    removedPersonId: loserId,
    mergedItemIds,
    mergedExternalBookingIds,
    mergedNoteIds,
    people: await readPeople(cleanAccountId),
  };
}

/**
 * Permanently removes a person and everything scoped to them: bookings,
 * practice blocks, video submissions, portal access, and -- if they had a
 * portal login -- the underlying Supabase Auth user. Unlike mergePeople there
 * is no survivor to reassign history onto, so this deletes it instead of
 * moving it.
 *
 * For an admin cleaning out test accounts. Sends no email or other
 * notification by design: it exists specifically to remove a login and its
 * data without telling anyone.
 *
 * Deleting the Supabase Auth user also removes their Clarity Caddy sign-in if
 * they had one -- the two products share one auth.users table (see
 * portal_players' table comment) -- which is why this is a distinct,
 * explicit action rather than folded into the ordinary client delete UI.
 */
async function hardDeletePerson(personId: string, accountId: string) {
  const cleanAccountId = cleanSlug(accountId, "");
  if (!cleanAccountId) throw missingAccountScope("delete_person");
  const cleanPersonId = cleanString(personId, "", 160);
  if (!cleanPersonId) {
    throw Object.assign(new Error("A client id is required."), {
      status: 400,
      code: "PEOPLE_DELETE_INVALID_ID",
    });
  }

  const knownPeople = await readPeople(cleanAccountId);
  const person = knownPeople.find((candidate) => candidate.id === cleanPersonId);
  if (!person) {
    throw Object.assign(new Error("That client was not found in this workspace."), {
      status: 404,
      code: "PEOPLE_DELETE_NOT_FOUND",
    });
  }

  // Read the portal login, if any, before the cascade below removes the
  // portal_players row (ON DELETE CASCADE on person_id) -- its Supabase Auth
  // user has to be deleted separately, through GoTrue's admin API.
  const portalPlayers = await listPortalPlayers(cleanAccountId);
  const portalPlayer = portalPlayers.find((entry) => entry.personId === cleanPersonId) || null;
  if (portalPlayer) {
    await destroyPortalPlayerSessions(portalPlayer.id);
  }

  const client = await db().pool.connect();
  try {
    await client.query("BEGIN");
    // video_transfer_sessions and player_sessions are created outside
    // ensureSchema() (a migration and a lazy first-login create respectively),
    // so a database that has never needed them is not an error -- same guard
    // mergePeople uses above.
    // Same question as the module-level tableExists(), asked on the pooled
    // client this transaction is already holding rather than on a new one.
    const tableExistsHere = async (table) =>
      Boolean(
        queryRows(await client.query("SELECT to_regclass($1) AS name", [`public.${table}`]))[0]?.name,
      );
    await client.query(
      "DELETE FROM calendar_items WHERE account_id = $1 AND person_id = $2",
      [cleanAccountId, cleanPersonId],
    );
    await client.query(
      "DELETE FROM practice_blocks WHERE account_id = $1 AND player_id = $2",
      [cleanAccountId, cleanPersonId],
    );
    if (await tableExistsHere("video_transfer_sessions")) {
      await client.query(
        "DELETE FROM video_transfer_sessions WHERE account_id = $1 AND player_id = $2",
        [cleanAccountId, cleanPersonId],
      );
    }
    if (await tableExistsHere("player_sessions")) {
      await client.query(
        "DELETE FROM player_sessions WHERE account_id = $1 AND person_id = $2",
        [cleanAccountId, cleanPersonId],
      );
    }
    // Defence in depth, same as deleteCalendarItemById: the account_id in this
    // predicate means a person id alone can never delete another business's
    // row even if a check above is ever refactored away. Cascades away the
    // portal_players row.
    await client.query(
      "DELETE FROM people WHERE id = $1 AND account_id = $2",
      [cleanPersonId, cleanAccountId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  // Lesson notes live in a per-account settings JSON blob (see
  // LESSON_NOTES_SETTING_PREFIX), not a table, so they can't be deleted inside
  // the transaction above -- filtered and rewritten right after it commits,
  // the same way deleteLessonNote handles a single note.
  const remainingNotes = (await readLessonNotes(cleanAccountId)).filter(
    (note) => note.playerId !== cleanPersonId,
  );
  await writeLessonNotes(remainingNotes, cleanAccountId);

  let authUserDeleted = false;
  let warning = "";
  if (portalPlayer?.authUserId) {
    try {
      await deleteSupabaseAuthUser(portalPlayer.authUserId);
      authUserDeleted = true;
    } catch (error) {
      warning = cleanString(
        error instanceof Error ? error.message : String(error || ""),
        "Could not delete the linked login.",
        300,
      );
      console.error("hard_delete_person:auth_user_delete_failed", {
        personId: cleanPersonId,
        authUserId: portalPlayer.authUserId,
        detail: warning,
      });
    }
  }

  await setSetting(cleanAccountId, "updatedAt", nowIso());

  return {
    deletedPersonId: cleanPersonId,
    authUserDeleted,
    people: await readPeople(cleanAccountId),
    ...(warning
      ? {
          warning: `${person.name || person.email || "The client"} was deleted, but their login could not be removed: ${warning}`,
        }
      : {}),
  };
}

// The columns every calendar item write sets, in the order calendarItemParams
// builds them. created_at/updated_at come from NOW() rather than a parameter.
const CALENDAR_ITEM_WRITE_COLUMNS = [
  "id",
  "account_id",
  "kind",
  "week",
  "day",
  "start",
  "duration",
  "coach_id",
  "location_id",
  "service_id",
  "client",
  "title",
  "phone",
  "email",
  "person_id",
  "note",
  "status",
  "custom_group",
  "coach",
  "location",
];
const CALENDAR_ITEM_JSON_WRITE_COLUMNS = new Set(["custom_group", "coach", "location"]);
// Postgres caps a statement at 65535 parameters, which at twenty columns would
// allow far more rows than this. The smaller chunk keeps any single statement
// modest enough to stay well inside statement_timeout.
const CALENDAR_ITEM_WRITE_CHUNK = 250;

/**
 * The column values for one calendar row.
 *
 * accountId is passed in from server context, never read off the item. The
 * item arrives from the client, and `item.accountId || <default workspace>`
 * meant a write that lost or omitted its tenant was stamped into the original
 * business. Any account id on the item is ignored.
 */
export function calendarItemParams(item, accountId: string) {
  if (!accountId) throw missingAccountScope("calendar_item_write");
  return [
    item.id,
    accountId,
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
    item.personId || "",
    item.note || "",
    item.status || "booked",
    item.customGroup ? JSON.stringify(cleanCustomGroupData(item)) : null,
    item.coach ? JSON.stringify(cleanBookingCoachSnapshot(item.coach)) : null,
    item.location ? JSON.stringify(cleanBookingLocationSnapshot(item.location)) : null,
  ];
}

/**
 * Upsert a batch of calendar items in one statement.
 *
 * A full calendar save replaces the whole item array, so this used to run one
 * INSERT per item. Every one of those is a round trip to Postgres, and the
 * calendar only grows: a coach with a season of history behind them was paying
 * hundreds of sequential round trips to move a single lesson, which is what
 * eventually pushed the save past the function timeout and surfaced as
 * "Calendar save failed" on a booking that had nothing wrong with it.
 */
export async function upsertCalendarItemChunk(client, chunk, accountId: string) {
  const params = [];
  const rows = chunk.map((item) => {
    const placeholders = calendarItemParams(item, accountId).map((value, column) => {
      params.push(value);
      return CALENDAR_ITEM_JSON_WRITE_COLUMNS.has(CALENDAR_ITEM_WRITE_COLUMNS[column])
        ? `$${params.length}::jsonb`
        : `$${params.length}`;
    });
    return `(${placeholders.join(", ")}, NOW(), NOW())`;
  });
  const assignments = CALENDAR_ITEM_WRITE_COLUMNS
    .filter((column) => column !== "id")
    .map((column) => `${column} = EXCLUDED.${column}`)
    .concat("updated_at = NOW()")
    .join(", ");
  const result = await client.query(
    `INSERT INTO calendar_items (${CALENDAR_ITEM_WRITE_COLUMNS.join(", ")}, created_at, updated_at)
     VALUES ${rows.join(", ")}
     ON CONFLICT (id) DO UPDATE SET ${assignments}
     RETURNING *`,
    params,
  );
  return queryRows(result);
}

/**
 * Write calendar items for exactly one business.
 *
 * options.accountId is required. It used to be optional, and without it both
 * the clear and the replace-stale-rows paths ran against the whole table --
 * `DELETE FROM calendar_items` with no predicate, and a stale-id scan that
 * loaded every business's rows and filtered them in JavaScript. Both are now
 * scoped in the SQL.
 */
export async function writeItems(items, options = {}) {
  const accountId = cleanSlug(options.accountId, "");
  if (!accountId) throw missingAccountScope("calendar_write");
  // ON CONFLICT DO UPDATE cannot touch the same row twice in one statement, so
  // a repeated id has to collapse before the insert. Last write wins, which is
  // what the row-at-a-time loop did.
  const cleanItems = Array.from(
    new Map(normalizeItems(items).map((item) => [item.id, item])).values(),
  );
  const returnedRows = [];
  const client = await db().pool.connect();
  try {
    await client.query("BEGIN");
    if (options.clearItems === true) {
      await client.query("DELETE FROM calendar_items WHERE account_id = $1", [accountId]);
    }
    for (let offset = 0; offset < cleanItems.length; offset += CALENDAR_ITEM_WRITE_CHUNK) {
      returnedRows.push(
        ...(await upsertCalendarItemChunk(
          client,
          cleanItems.slice(offset, offset + CALENDAR_ITEM_WRITE_CHUNK),
          accountId,
        )),
      );
    }
    if (options.replaceItems === true && cleanItems.length) {
      const keepIds = Array.from(new Set(cleanItems.map((item) => item.id)));
      // One scoped statement instead of "read every row, filter in JS, delete
      // by id list". Rows belonging to other businesses are not read, let alone
      // considered for deletion.
      const deleted = queryRows(
        await client.query(
          "DELETE FROM calendar_items WHERE account_id = $1 AND NOT (id = ANY($2::text[])) RETURNING id",
          [accountId, keepIds],
        ),
      );
      if (deleted.length) {
        console.info("CALENDAR_STATE_REPLACE_STALE_CLEANUP", {
          action: "replace_stale_cleanup",
          route: "/api/calendar-state",
          accountId,
          targetedDelete: true,
          staleCount: deleted.length,
        });
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  if (
    options.returnMode === "single" &&
    cleanItems.length === 1 &&
    options.clearItems !== true &&
    options.replaceItems !== true
  ) {
    // The Supabase REST adapter ignores `INSERT ... RETURNING` and always
    // resolves with no rows, so returnedRows can be empty even though the write
    // committed. Fall back to the item we just wrote instead of calling
    // rowToItem(undefined), which threw *after* the commit -- surfacing to the
    // client as a failed save that then rolled the optimistic edit back (a
    // dragged lesson visibly jumped to its original slot, and the reschedule
    // notification that runs after this write never fired).
    return returnedRows[0] ? rowToItem(returnedRows[0]) : cleanItems[0];
  }
  return readItems(accountId);
}

async function seedPeopleFromAppointments(accountId: string) {
  const countRows = await db().sql`SELECT COUNT(*) AS count FROM people WHERE account_id = ${accountId}`;
  if ((countRows[0]?.count ?? 0) > 0) return;
  await importPeople(
    initialItems.map((item) => personFromAppointment(item, accountId)).filter(Boolean),
    "appointment",
    accountId,
  );
}

async function readStateSettingsSnapshot(accountId: string) {
  await ensureSeeded();
  const settings = await readSettingsMap(accountId);
  let syncKey = settingValue(settings, "syncKey");
  if (!syncKey) {
    syncKey = generateSyncKey();
    await setSetting(accountId, "syncKey", syncKey);
    settings.syncKey = syncKey;
  }
  let updatedAt = settingValue(settings, "updatedAt");
  if (!updatedAt) {
    updatedAt = nowIso();
    await setSetting(accountId, "updatedAt", updatedAt);
    settings.updatedAt = updatedAt;
  }
  return { settings, syncKey, updatedAt };
}

/**
 * The coach account for one business, from that business's own settings.
 *
 * The defaults differ by business on purpose. The original workspace keeps the
 * env-backed values it has always had, so nothing about it changes. Any other
 * business falls back to neutral product defaults rather than inheriting the
 * original coach's name, venue and invoice footer.
 */
export function coachAccountFromSettings(settings, accountId = "") {
  const scopedAccountId = cleanSlug(settingValue(settings, "accountId") || accountId, "");
  const defaults =
    !scopedAccountId || isOriginalWorkspace(scopedAccountId)
      ? defaultCoachAccount()
      : neutralCoachAccount(scopedAccountId);
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
    country: settingValue(settings, "accountCountry") || defaults.country,
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

// Reminder lead time: 1 hour to 14 days before the lesson, default 24 hours.
// Mirrors admin-settings.mts, which owns the /api/admin-settings write path.
function cleanReminderLeadMinutes(value, fallback = 24 * 60) {
  const minutes = Number(value === "" || value === undefined || value === null ? fallback : value);
  return Number.isFinite(minutes) ? Math.max(60, Math.min(14 * 24 * 60, Math.round(minutes))) : fallback;
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
    sendLessonTypeChangeEmail: settingValue(settings, "sendLessonTypeChangeEmail") === "true",
    reminderEnabled: settingValue(settings, "reminderEnabled") === "true",
    reminderLeadMinutes: cleanReminderLeadMinutes(settingValue(settings, "reminderLeadMinutes")),
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
    ...playerBookingEmbedFromSettings(settings),
  };
}

/**
 * The two outlines a booking card can wear: a border once the lesson is done,
 * and a ring while a bay is held for it. The fill is not here — that is the
 * lesson type's own colour, stored on the service in servicesJson.
 */
const defaultCalendarColors = {
  statusCompleted: "#7f8a80",
  statusBayBooked: "#e08a2e",
};

function cleanCalendarColors(colors) {
  const cleaned = {};
  for (const [key, fallback] of Object.entries(defaultCalendarColors)) {
    cleaned[key] = cleanHexColor(colors?.[key], fallback);
  }
  return cleaned;
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
    calendarColors: cleanCalendarColors(
      parseSettingJson(settings, "brandCalendarColorsJson", defaultCalendarColors),
    ),
  };
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

/**
 * A business's bookable hours.
 *
 * defaultAvailability is the original coach's actual working week, so a new
 * business starts closed rather than advertising somebody else's evenings.
 */
export function availabilityFromSettings(settings, accountId = "") {
  const scopedAccountId = cleanSlug(settingValue(settings, "accountId") || accountId, "");
  const seed =
    !scopedAccountId || isOriginalWorkspace(scopedAccountId) ? defaultAvailability : [[], [], [], [], [], [], []];
  // availabilityJson is a per-account settings row, so every window in it
  // belongs to the business whose row was read. Windows saved before accountId
  // was stamped on write (and the seeded defaults) carry no accountId; file
  // them under that account so the strict account filters keep them.
  const ownerAccountId = cleanSlug(accountId, "") || scopedAccountId;
  return normalizeAvailability(parseSettingJson(settings, "availabilityJson", seed)).map((dayWindows) =>
    dayWindows.map((window) =>
      window.accountId || !ownerAccountId ? window : { ...window, accountId: ownerAccountId },
    ),
  );
}

async function readAdminSettings(accountId: string, settingsMap = null) {
  await ensureSeeded();
  return adminSettingsFromSettings(settingsMap || (await readSettingsMap(accountId)));
}

// Only the keys the caller actually sent are written, so the shape stays a
// partial update. They are collected rather than written one at a time: this is
// one Save press, and it should cost one round trip rather than nineteen.
async function writeAdminSettings(accountId: string, settings) {
  const next = {};
  const put = (key, value) => {
    if (hasOwn(settings, key)) next[key] = value;
  };
  put("emailNotificationsEnabled", settings?.emailNotificationsEnabled ? "true" : "false");
  put("notificationEmail", cleanString(settings?.notificationEmail, "", 180));
  put("coachEmail", cleanString(settings?.coachEmail, "", 180));
  put("replyToEmail", cleanString(settings?.replyToEmail, "", 180));
  if (hasOwn(settings, "notificationDelaySeconds")) {
    const delaySeconds = Number(settings?.notificationDelaySeconds ?? 30);
    next.notificationDelaySeconds = String(
      Number.isFinite(delaySeconds) ? Math.max(30, Math.min(3600, delaySeconds)) : 30,
    );
  }
  put("sendClientEmail", settings?.sendClientEmail ? "true" : "false");
  put("sendCoachEmail", settings?.sendCoachEmail ? "true" : "false");
  put("sendAdminEmail", settings?.sendAdminEmail ? "true" : "false");
  put("sendLessonTypeChangeEmail", settings?.sendLessonTypeChangeEmail ? "true" : "false");
  put("reminderEnabled", settings?.reminderEnabled ? "true" : "false");
  if (hasOwn(settings, "reminderLeadMinutes")) {
    next.reminderLeadMinutes = String(cleanReminderLeadMinutes(settings?.reminderLeadMinutes));
  }
  put("clientEmailSubject", cleanString(settings?.clientEmailSubject, defaultEmailTemplates.clientEmailSubject, 180));
  put("clientEmailIntro", cleanString(settings?.clientEmailIntro, defaultEmailTemplates.clientEmailIntro, 900));
  put("clientEmailFooter", modernClientEmailFooter(settings?.clientEmailFooter));
  put("adminEmailSubject", cleanString(settings?.adminEmailSubject, defaultEmailTemplates.adminEmailSubject, 180));
  put("adminEmailIntro", cleanString(settings?.adminEmailIntro, defaultEmailTemplates.adminEmailIntro, 900));
  put("smsProviderName", cleanString(settings?.smsProviderName, "", 80));
  put("smsWebhookUrl", cleanString(settings?.smsWebhookUrl, "", 600));
  put("smsFromNumber", cleanString(settings?.smsFromNumber, "", 80));
  put("sendClientSms", settings?.sendClientSms ? "true" : "false");
  put("sendAdminSms", settings?.sendAdminSms ? "true" : "false");
  put("playerBookingEmbedUrl", cleanPlayerBookingEmbedUrl(settings?.playerBookingEmbedUrl));
  put("playerBookingEmbedLabel", cleanPlayerBookingEmbedLabel(settings?.playerBookingEmbedLabel));
  put("playerBookingEmbedIntro", cleanPlayerBookingEmbedIntro(settings?.playerBookingEmbedIntro));
  put("playerBookingEmbedHeight", String(cleanPlayerBookingEmbedHeight(settings?.playerBookingEmbedHeight)));
  await setSettingsBulk(accountId, { ...next, updatedAt: nowIso() });
  return readAdminSettings(accountId);
}

async function readServices(accountId: string) {
  await ensureSeeded();
  const stored = await getSetting(accountId, "servicesJson");
  try {
    return normalizeServices(JSON.parse(stored || "[]"), accountId);
  } catch {
    // A corrupt servicesJson is not a reason to hand this business the
    // original coach's price list.
    console.error("services:unparseable", accountId);
    return normalizeServices([], accountId);
  }
}

async function writeServices(accountId: string, services, context = null) {
  // Stamped with the server's account, never the payload's.
  const clean = normalizeServices(services, accountId).map((service) => ({
    ...service,
    accountId,
  }));
  const account = context?.account || (await readDefaultWorkspaceAccount(accountId));
  assertAccountFeature(account, "services");
  const activeServices = clean.filter((service) => service.accountId === account.id && service.archived !== true).length;
  assertAccountLimit(account, activeServices, "maxServices");
  await setSettingsBulk(accountId, { servicesJson: JSON.stringify(clean), updatedAt: nowIso() });
  return clean;
}

async function readWorkspaceAccounts(accountId: string) {
  await ensureSeeded();
  const account = await readCoachAccount(accountId);
  try {
    return normalizeWorkspaceAccounts(
      JSON.parse((await getSetting(accountId, "workspaceAccountsJson")) || "[]"),
      account,
    );
  } catch {
    return normalizeWorkspaceAccounts([], account);
  }
}

async function writeWorkspaceAccounts(accountId: string, accounts) {
  const account = await readCoachAccount(accountId);
  const clean = normalizeWorkspaceAccounts(accounts, account);
  await setSettingsBulk(accountId, { workspaceAccountsJson: JSON.stringify(clean), updatedAt: nowIso() });
  return clean;
}

// The workspace-account record for one explicit business. The id is supplied
// by the caller (from the authenticated actor or a validated public slug);
// this only looks it up, it never chooses.
async function readDefaultWorkspaceAccount(accountId: string) {
  const accounts = await readWorkspaceAccounts(accountId);
  return accounts.find((account) => account.id === accountId) || neutralWorkspaceAccount(accountId);
}

async function readCoachProfiles(accountId: string) {
  await ensureSeeded();
  const account = await readCoachAccount(accountId);
  try {
    return normalizeCoachProfiles(
      JSON.parse((await getSetting(accountId, "coachProfilesJson")) || "[]"),
      account,
    );
  } catch {
    return normalizeCoachProfiles([], account);
  }
}

async function writeCoachProfiles(accountId: string, coaches, context = null) {
  const account = await readCoachAccount(accountId);
  const workspaceAccount = context?.account || (await readDefaultWorkspaceAccount(accountId));
  const clean = normalizeCoachProfiles(coaches, account).map((coach) => ({
    ...coach,
    accountId: workspaceAccount.id,
  }));
  const activeCoaches = clean.filter((coach) => coach.accountId === workspaceAccount.id && coach.active && coach.archived !== true).length;
  if (activeCoaches > 1) assertAccountFeature(workspaceAccount, "multiCoach");
  assertAccountLimit(workspaceAccount, activeCoaches, "maxCoaches");
  await setSettingsBulk(accountId, { coachProfilesJson: JSON.stringify(clean), updatedAt: nowIso() });
  return clean;
}

async function readAppUsers(accountId: string) {
  await ensureSeeded();
  const account = await readCoachAccount(accountId);
  try {
    const users = JSON.parse((await getSetting(accountId, "appUsersJson")) || "[]");
    return Array.isArray(users) && users.length ? users : [defaultAppUserFromAccount(account)];
  } catch {
    return [defaultAppUserFromAccount(account)];
  }
}

async function readLocations(accountId: string) {
  await ensureSeeded();
  const account = await readCoachAccount(accountId);
  try {
    return normalizeLocations(
      JSON.parse((await getSetting(accountId, "locationsJson")) || "[]"),
      account,
    );
  } catch {
    return normalizeLocations([], account);
  }
}

async function writeLocations(accountId: string, locations, context = null) {
  const account = await readCoachAccount(accountId);
  const workspaceAccount = context?.account || (await readDefaultWorkspaceAccount(accountId));
  const clean = normalizeLocations(locations, account).map((location) => ({
    ...location,
    accountId: workspaceAccount.id,
  }));
  const activeLocations = clean.filter((location) => location.accountId === workspaceAccount.id && location.active && location.archived !== true).length;
  if (activeLocations > 1) assertAccountFeature(workspaceAccount, "multiLocation");
  assertAccountLimit(workspaceAccount, activeLocations, "maxLocations");
  await setSettingsBulk(accountId, { locationsJson: JSON.stringify(clean), updatedAt: nowIso() });
  return clean;
}

async function readAvailability(accountId: string) {
  await ensureSeeded();
  try {
    return normalizeAvailability(
      JSON.parse((await getSetting(accountId, "availabilityJson")) || "[]"),
    );
  } catch {
    return normalizeAvailability(defaultAvailability);
  }
}

async function writeAvailability(accountId: string, availability, context = null) {
  const clean = normalizeAvailability(availability).map((dayWindows) =>
    dayWindows.map((window) => ({
      ...window,
      ...(context ? { accountId: context.accountId } : {}),
    })),
  );
  await setSettingsBulk(accountId, { availabilityJson: JSON.stringify(clean), updatedAt: nowIso() });
  return clean;
}

async function readCoachAccount(accountId: string, settingsMap = null) {
  await ensureSeeded();
  // Was 13 sequential single-key `getSetting` round trips -- reuse the same
  // bulk-read + settings-map derivation that readCalendarState already uses
  // (coachAccountFromSettings), instead of re-fetching the same rows one at a
  // time on every one of this function's ~16 call sites. Callers that already
  // have a settings map (e.g. because they're also calling readAdminSettings
  // or readBrandSettings in the same batch) can pass it in to skip the read
  // entirely instead of each function fetching its own copy in parallel.
  return coachAccountFromSettings(settingsMap || (await readSettingsMap(accountId)), accountId);
}

async function writeCoachAccount(accountId: string, account) {
  const clean = cleanCoachAccount(account);
  await setSettingsBulk(accountId, {
    accountId: clean.id,
    accountCoachName: clean.coachName,
    accountBusinessName: clean.businessName,
    accountVenueName: clean.venueName,
    accountVenueShortName: clean.venueShortName,
    accountTimezone: clean.timezone,
    accountCountry: clean.country,
    accountContactEmail: clean.contactEmail,
    accountBookingUrl: clean.bookingUrl,
    accountCalendarSlug: clean.calendarSlug,
    accountCaddyWorkspaceUrl: clean.caddyWorkspaceUrl,
    accountInvoiceSettingsJson: JSON.stringify(clean.invoiceSettings),
    coachName: clean.businessName,
    updatedAt: nowIso(),
  });
  return clean;
}

async function readBrandSettings(accountId: string, settingsMap = null) {
  await ensureSeeded();
  const resolvedSettingsMap = settingsMap || (await readSettingsMap(accountId));
  const account = coachAccountFromSettings(resolvedSettingsMap, accountId);
  return brandSettingsFromSettings(resolvedSettingsMap, account);
}

async function writeBrandSettings(accountId: string, settings) {
  const account = await readCoachAccount(accountId);
  await setSettingsBulk(accountId, {
    coachName: cleanString(settings?.coachName, account.businessName, 80),
    brandLogoName: cleanString(settings?.logoName, "", 120),
    brandLogoPreview: cleanLogoPreview(settings?.logoPreview),
    brandShowLogo: settings?.showLogo === true ? "true" : "false",
    brandNeutral: cleanHexColor(settings?.neutral, "#ffffff"),
    brandPrimary: cleanHexColor(settings?.primary, "#1fd36d"),
    brandSecondary: cleanHexColor(settings?.secondary, "#d7b06b"),
    brandAccent: cleanHexColor(settings?.accent, "#07100a"),
    brandBookingTheme: settings?.bookingTheme === "light" ? "light" : "dark",
    brandCalendarColorsJson: JSON.stringify(cleanCalendarColors(settings?.calendarColors)),
    updatedAt: nowIso(),
  });
  return readBrandSettings(accountId);
}

/**
 * What the coach shell needs to draw its frame correctly before the calendar
 * arrives: the business, its plan, its coaches and who the signed-in user is
 * inside it. Sent with the session answer so the sidebar is right on first
 * paint -- without it every load opened on a made-up solo account, and Sell
 * and Billing turned up whenever the calendar shell did. One settings read;
 * the shell still re-reads and overwrites all of this when it answers.
 *
 * Best effort by design. A session answer must never fail because settings
 * could not be read, so this returns undefined and the shell fills the gap.
 */
async function readWorkspaceBootstrap(membership: CoachActor): Promise<WorkspaceBootstrap | undefined> {
  try {
    const { settings: settingsMap } = await readStateSettingsSnapshot(membership.accountId);
    const account = coachAccountFromSettings(settingsMap, membership.accountId);
    const coaches = coachProfilesFromSettings(settingsMap, account);
    const defaultCoachId =
      coaches.find((coach) => coach.isDefault && coach.active && !coach.archived)?.id || coaches[0]?.id || "";
    const coachName = settingValue(settingsMap, "accountCoachName") || account.coachName;
    return {
      accountId: membership.accountId,
      workspaceAccounts: workspaceAccountsFromSettings(settingsMap, account),
      account,
      coaches,
      // Mirrors the calendar shell's currentUser exactly: the app-user
      // vocabulary, and permissions from the membership rather than settings.
      currentUser: {
        id: membership.authUserId,
        accountId: membership.accountId,
        name: coachName,
        role: appUserRoleForMembership(membership.role),
        coachId: membership.coachId || defaultCoachId,
        permissions: membership.isAdmin
          ? { bookings: "all", services: "all", availability: "all", locations: "all", clients: "all", settings: "all" }
          : { bookings: "own", services: "own", availability: "own", locations: "none", clients: "own", settings: "none" },
      },
    };
  } catch (error) {
    console.warn("workspace_bootstrap_unavailable", {
      accountId: membership.accountId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

async function readCalendarState(accountId: string) {
  const { settings: settingsMap, syncKey, updatedAt } = await readStateSettingsSnapshot(accountId);
  const account = coachAccountFromSettings(settingsMap, accountId);
  const [items, people, notifications, googleCalendar] = await Promise.all([
    readItems(accountId),
    readPeople(accountId),
    readNotificationHistory(accountId),
    getGoogleCalendarSyncStatus(accountId),
  ]);
  return {
    syncKey,
    updatedAt,
    items,
    services: servicesFromSettings(settingsMap, accountId),
    workspaceAccounts: workspaceAccountsFromSettings(settingsMap, account),
    coaches: coachProfilesFromSettings(settingsMap, account),
    currentUser: appUsersFromSettings(settingsMap, account)[0],
    locations: locationsFromSettings(settingsMap, account),
    availability: availabilityFromSettings(settingsMap, accountId),
    people,
    notifications,
    settings: adminSettingsFromSettings(settingsMap),
    brand: brandSettingsFromSettings(settingsMap, account),
    accountId,
    account,
    googleCalendar,
  };
}

// Marking one lesson complete needs the target booking plus the settings the
// permission check reads. It does not need people, notification history or the
// Google sync status, so this skips those three reads entirely and looks the
// booking up by id instead of scanning the whole calendar.
/**
 * Everything readCalendarState derives from the settings blob, and nothing it
 * reads from the calendar, people, notifications or Google. This is what a
 * request needs to know who is asking and what they may do; the calendar
 * itself is only needed by routes that actually answer with bookings. Every
 * one of the 49 routes that started with a full readCalendarState was paying
 * for four table reads to get this.
 */
async function readSettingsState(accountId: string) {
  const { settings: settingsMap, syncKey, updatedAt } = await readStateSettingsSnapshot(accountId);
  const account = coachAccountFromSettings(settingsMap, accountId);
  return {
    syncKey,
    updatedAt,
    items: [],
    services: servicesFromSettings(settingsMap, accountId),
    workspaceAccounts: workspaceAccountsFromSettings(settingsMap, account),
    coaches: coachProfilesFromSettings(settingsMap, account),
    currentUser: appUsersFromSettings(settingsMap, account)[0],
    locations: locationsFromSettings(settingsMap, account),
    availability: availabilityFromSettings(settingsMap, accountId),
    people: [],
    notifications: [],
    settings: adminSettingsFromSettings(settingsMap),
    brand: brandSettingsFromSettings(settingsMap, account),
    accountId,
    account,
  };
}

async function readLessonCompleteState(accountId: string, itemId) {
  const { settings: settingsMap, syncKey, updatedAt } = await readStateSettingsSnapshot(accountId);
  const account = coachAccountFromSettings(settingsMap, accountId);
  const item = await readCalendarItemById(accountId, itemId);
  return {
    syncKey,
    updatedAt,
    items: item ? [item] : [],
    services: servicesFromSettings(settingsMap, accountId),
    workspaceAccounts: workspaceAccountsFromSettings(settingsMap, account),
    coaches: coachProfilesFromSettings(settingsMap, account),
    currentUser: appUsersFromSettings(settingsMap, account)[0],
    locations: locationsFromSettings(settingsMap, account),
    availability: availabilityFromSettings(settingsMap, accountId),
    people: [],
    notifications: [],
    settings: adminSettingsFromSettings(settingsMap),
    brand: brandSettingsFromSettings(settingsMap, account),
    accountId,
    account,
  };
}

async function readAdminCalendarShellState(accountId: string) {
  const startedAt = Date.now();
  console.info("CALENDAR_SHELL_STATE_LOAD_STARTED", {
    route: "/api/calendar-state",
    routeUsed: "shell",
  });

  const { settings: settingsMap, syncKey, updatedAt } = await readStateSettingsSnapshot(accountId);
  const account = coachAccountFromSettings(settingsMap, accountId);
  const items = await readItems(accountId);
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
    services: servicesFromSettings(settingsMap, accountId),
    workspaceAccounts: workspaceAccountsFromSettings(settingsMap, account),
    coaches: coachProfilesFromSettings(settingsMap, account),
    currentUser: appUsersFromSettings(settingsMap, account)[0],
    locations: locationsFromSettings(settingsMap, account),
    availability: availabilityFromSettings(settingsMap, accountId),
    people: [],
    notifications: [],
    settings: adminSettingsFromSettings(settingsMap),
    brand: brandSettingsFromSettings(settingsMap, account),
    accountId,
    account,
    // No googleCalendar here on purpose: this route does not read the Google
    // status. The placeholder it used to send said configured: false, which the
    // client applied over the real status and greyed out Connect Google.
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

async function readColdSetupState(accountId: string) {
  const { settings: settingsMap } = await readStateSettingsSnapshot(accountId);
  const account = coachAccountFromSettings(settingsMap, accountId);
  return {
    workspaceAccounts: workspaceAccountsFromSettings(settingsMap, account),
    coaches: coachProfilesFromSettings(settingsMap, account),
    currentUser: appUsersFromSettings(settingsMap, account)[0],
    locations: locationsFromSettings(settingsMap, account),
    accountId,
    account,
  };
}

async function readPublicCalendarState(accountId: string) {
  // The settings snapshot and the calendar items are independent reads, and
  // this runs on the public booking path where the customer is watching a
  // spinner. Netlify (US) to Supabase (Mumbai) is ~217 ms at best, so running
  // them in sequence cost a full extra round trip for nothing.
  const [snapshot, items] = await Promise.all([readStateSettingsSnapshot(accountId), readItems(accountId)]);
  const { settings: settingsMap, syncKey, updatedAt } = snapshot;
  const account = coachAccountFromSettings(settingsMap, accountId);
  return {
    syncKey,
    updatedAt,
    items,
    services: servicesFromSettings(settingsMap, accountId),
    workspaceAccounts: workspaceAccountsFromSettings(settingsMap, account),
    coaches: coachProfilesFromSettings(settingsMap, account),
    locations: locationsFromSettings(settingsMap, account),
    availability: availabilityFromSettings(settingsMap, accountId),
    brand: brandSettingsFromSettings(settingsMap, account),
    accountId,
    account,
  };
}

export async function readPublicSlotContext({ accountId, serviceId, week } = {}, options = {}) {
  const metrics = options.metrics || null;
  const safeWeek = publicBookingSlotsWeek(week);
  if (!accountId) throw missingAccountScope("public_slot_context");
  const settingsStartedAt = Date.now();
  const snapshot = options.settingsSnapshot || (await readStateSettingsSnapshot(accountId));
  const settingsMap = snapshot.settings || {};
  const syncKey = snapshot.syncKey || settingValue(settingsMap, "syncKey") || "";
  const updatedAt = snapshot.updatedAt || settingValue(settingsMap, "updatedAt") || nowIso();
  const account = coachAccountFromSettings(settingsMap, accountId);
  const state = {
    accountId,
    syncKey,
    updatedAt,
    items: [],
    services: servicesFromSettings(settingsMap, accountId),
    workspaceAccounts: workspaceAccountsFromSettings(settingsMap, account),
    coaches: coachProfilesFromSettings(settingsMap, account),
    locations: locationsFromSettings(settingsMap, account),
    availability: availabilityFromSettings(settingsMap, accountId),
    brand: brandSettingsFromSettings(settingsMap, account),
    account,
  };
  if (metrics) metrics.settingsReadMs = Date.now() - settingsStartedAt;

  const { workspaceAccount, state: accountState } = publicAccountState(state);
  const cleanServiceId = cleanString(serviceId, "", 140);
  const publicServices = publicBookableServices(accountState.services);
  const targetService = cleanServiceId ? publicServices.find((service) => service.id === cleanServiceId) : null;
  if (cleanServiceId && !targetService) {
    throw publicBookingSlotsRequestError("Choose a public lesson type.", 404);
  }

  const itemsStartedAt = Date.now();
  const readItemsForWeek = options.readItemsForWeek || readPublicSlotItemsForWeek;
  const itemRead = await readItemsForWeek({
    accountId: workspaceAccount.id,
    serviceId: targetService?.id || "",
    week: safeWeek,
  });
  const rawItems = Array.isArray(itemRead) ? itemRead : itemRead?.items || [];
  const rowsFetched = Number.isFinite(Number(itemRead?.rowsFetched)) ? Number(itemRead.rowsFetched) : rawItems.length;
  const accountItems = rawItems.filter((item) => recordBelongsToAccount(item, workspaceAccount.id));
  const requestedWeekItems = publicSlotRequestedWeekItems(accountItems, safeWeek);
  // A normal booking page requests the whole week's public availability once.
  // It still needs every booking in the week because different public services
  // can share a coach or location.  The targeted path stays narrow for a
  // reschedule, where ignoreId makes the calculation genuinely different.
  const relevantResourceItems = targetService
    ? publicSlotRelevantResourceItems(requestedWeekItems, targetService, accountState)
    : requestedWeekItems;

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

async function readPublicCatalogState(accountId: string) {
  const { settings: settingsMap, syncKey, updatedAt } = await readStateSettingsSnapshot(accountId);
  const account = coachAccountFromSettings(settingsMap, accountId);
  return {
    accountId,
    syncKey,
    updatedAt,
    services: servicesFromSettings(settingsMap, accountId),
    workspaceAccounts: workspaceAccountsFromSettings(settingsMap, account),
    coaches: coachProfilesFromSettings(settingsMap, account),
    locations: locationsFromSettings(settingsMap, account),
    availability: availabilityFromSettings(settingsMap, accountId),
    brand: brandSettingsFromSettings(settingsMap, account),
    account,
  };
}

async function readFastPublicCalendarState(accountId: string) {
  const { settings: settingsMap, syncKey, updatedAt } = await readStateSettingsSnapshot(accountId);
  const account = coachAccountFromSettings(settingsMap, accountId);
  return {
    accountId,
    syncKey,
    updatedAt,
    items: await readItems(accountId),
    services: servicesFromSettings(settingsMap, accountId),
    workspaceAccounts: workspaceAccountsFromSettings(settingsMap, account),
    coaches: coachProfilesFromSettings(settingsMap, account),
    locations: locationsFromSettings(settingsMap, account),
    availability: availabilityFromSettings(settingsMap, accountId),
    brand: brandSettingsFromSettings(settingsMap, account),
    account,
  };
}

async function runPublicDiagnostics(accountId) {
  const diagnostics = {};
  const checks = {
    updatedAt: async () => (await getSetting(accountId, "updatedAt")) || nowIso(),
    syncKey: async () => (await getSetting(accountId, "syncKey")) || "",
    items: async () => await readItems(accountId),
    services: async () => await readServices(accountId),
    availability: async () => await readAvailability(accountId),
    brand: async () => await readBrandSettings(accountId),
    account: async () => await readCoachAccount(accountId),
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

async function runPublicSerializationDiagnostics(accountId) {
  const state = await readPublicCalendarState(accountId);
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

async function runDatabaseHealth(accountId) {
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
    await seedSettings(accountId);
    return "settings seed ready";
  });
  await check("notificationTables", async () => {
    await ensureNotificationHistoryTable();
    return "notification tables ready";
  });
  await check("itemsRead", async () => (await readItems(accountId)).length);
  await check("servicesRead", async () => (await readServices(accountId)).length);
  await check(
    "availabilityRead",
    async () => (await readAvailability(accountId)).flat().length,
  );
  await check("peopleRead", async () => (await readPeople(accountId)).length);
  await check(
    "notificationsRead",
    async () => (await readNotificationHistory(accountId)).length,
  );
  await check("adminSeed", async () => {
    await ensureAdminUser();
    return "admin seed checked";
  });
  await check("calendarStateRead", async () => {
    const state = await readCalendarState(accountId);
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
    const state = await readPublicCalendarState(await resolvePublicAccountId(req));
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

export async function handlePublicBookingStateRequest(req: Request) {
  try {
    return json(publicBookingState(await readPublicCalendarState(await resolvePublicAccountId(req))));
  } catch (error) {
    console.error("public_booking_state_error", error);
    throw error;
  }
}

export async function handlePublicBookingCatalogRequest(req: Request) {
  try {
    return json(publicBookingCatalog(await readPublicCatalogState(await resolvePublicAccountId(req))));
  } catch (error) {
    console.error("public_booking_catalog_error", error);
    throw error;
  }
}

function googleCalendarRelevantItem(item) {
  if (!item) return null;
  return {
    kind: item.kind,
    week: Number(item.week ?? 0),
    day: Number(item.day ?? 0),
    start: Number(item.start ?? 0),
    duration: Number(item.duration ?? 0),
    client: item.client || "",
    title: item.title || "",
    serviceId: item.serviceId || "",
    locationId: item.locationId || "",
    location: item.location || null,
    phone: item.phone || "",
    email: item.email || "",
    note: item.note || "",
    // Cancelling a booking changes nothing else about it, so without status
    // here the change never registers and the Google event is never taken
    // down — the slot stays held on a lesson that is not happening.
    status: item.status || "",
  };
}

function googleCalendarChangesBetween(previousItems, nextItems) {
  const previous = new Map((previousItems || []).map((item) => [item.id, item]));
  const next = new Map((nextItems || []).map((item) => [item.id, item]));
  const changes = [];
  for (const [id, item] of next) {
    const before = previous.get(id);
    if (JSON.stringify(googleCalendarRelevantItem(before)) !== JSON.stringify(googleCalendarRelevantItem(item))) {
      changes.push({ id, action: "upsert" });
    }
  }
  for (const id of previous.keys()) {
    if (!next.has(id)) changes.push({ id, action: "delete" });
  }
  return changes;
}

/**
 * Hand a Google Calendar sync to the runtime instead of to the response.
 *
 * Google is not on the critical path of a save. The rows are committed before
 * the sync starts, the sync re-runs on the next change, and the nightly
 * reconcile rebuilds anything a failed push missed — so a save that waits on
 * Google is paying for a round trip it does not need.
 *
 * It used to wait behind a five second budget, and that turned out to be worse
 * than either waiting or not. A sync that outran the budget kept running, but
 * the function froze as soon as it answered, suspending that sync mid-request.
 * The change queue is module level, so the next save on the same warm instance
 * queued behind the suspended one and inherited the whole stall. Two or three
 * saves in a row and the calendar sat on "Saving…" for the full budget every
 * time, with nothing actually reaching Google.
 *
 * waitUntil is what makes firing and forgetting safe: it holds the instance
 * open until the sync finishes, so the work completes rather than being
 * suspended. Failures still land in the Google sync debug log and in
 * googleCalendarLastSyncStatus, so a coach sees them on the next save or state
 * read instead of inline on this one.
 */
function deferGoogleCalendarSync(accountId, changes, trigger = "admin_calendar_save", netlifyContext = null) {
  const task = syncGoogleCalendarChangesIfEnabled(accountId, changes, trigger)
    .then((result) =>
      console.info("calendar_state:google_sync_completed_after_response", { trigger, ok: result?.ok !== false }),
    )
    .catch((error) => console.error("calendar_state:google_sync_failed_after_response", trigger, error));
  if (netlifyContext && typeof netlifyContext.waitUntil === "function") {
    netlifyContext.waitUntil(task);
  }
  return { ok: true, skipped: false, pending: true };
}

/**
 * Push availability-derived blocks to Google after an availability edit.
 *
 * A full rebuild rather than a targeted change: unavailable blocks are not
 * calendar items, so there is no item diff that describes them moving. Deferred
 * for the same reason as the calendar save — a rebuild touches every event on
 * the calendar, which is the last thing a save should be made to wait for.
 */
function deferGoogleCalendarAvailabilitySync(accountId, netlifyContext = null) {
  const task = syncGoogleCalendarNow(accountId, "availability_save")
    .then((result) => console.info("availability:google_sync_completed_after_response", { ok: result?.ok !== false }))
    .catch((error) => console.error("availability:google_sync_failed_after_response", error));
  if (netlifyContext && typeof netlifyContext.waitUntil === "function") {
    netlifyContext.waitUntil(task);
  }
}

/**
 * A moved lesson takes its bay with it: cancel the old Optix bay booking and
 * rebook at the new slot. Deferred like the Google sync so a drag save never
 * waits on Optix (two round trips, up to 25s each). rebookResourceAfterReschedule
 * never throws and skips lessons without a synced bay, so callers pass every
 * slot-changed appointment id without checking the sync table first.
 */
function deferOptixBayRebook(accountId: string, calendarItemIds, netlifyContext = null) {
  const ids = (calendarItemIds || []).filter(Boolean);
  if (!ids.length) return;
  const task = (async () => {
    for (const id of ids) {
      await rebookResourceAfterReschedule(accountId, id);
    }
  })().catch((error) => console.error("optix_bay_rebook_deferred_failed", error));
  if (netlifyContext && typeof netlifyContext.waitUntil === "function") {
    netlifyContext.waitUntil(task);
  }
}

/**
 * How many freshly created appointments one save may auto-book.
 *
 * A normal save creates one booking. Generating a term of group sessions, or
 * importing, can create dozens at once, and each one is an Optix round trip of
 * up to 25 seconds run one after another. Past this many the save is treated
 * as bulk work: nothing is auto-booked and the coach books what they want from
 * the cards, rather than the function running for twenty minutes in the
 * background against a rate-limited API.
 */
const OPTIX_AUTO_BOOK_MAX_PER_SAVE = 25;

/**
 * Appointments this save brought into existence that should get a bay booked.
 *
 * Deliberately narrow. An appointment qualifies only when it is new to this
 * account's calendar, still live, and Clarity's own:
 *
 * - Already present before the save → not a creation. Editing a note must not
 *   book a bay, and a moved lesson is deferOptixBayRebook's job.
 * - Cancelled or no-show → nobody is coming; holding a bay for one is the
 *   opposite of what auto-book is for.
 * - `origin` other than clarity → an imported Optix lesson IS the customer's
 *   own Optix booking. It already holds its resource there, and booking a
 *   second one against it would double-hold the bay.
 * - A video review → a deadline, not an appointment. Booking a bay for one
 *   would hold a hitting bay empty on a day nobody is coming in. Same reason
 *   the public booking path passes `autoBookResource: !isReview`.
 *
 * The lesson type's own Auto-book tick is NOT checked here: that lives in the
 * account's settings, and autoBookResourceForNewBooking reads it per booking.
 */
function newlyCreatedAutoBookableAppointments(
  previousItemsById: Map<any, any>,
  items: any[],
  services: any[],
) {
  const serviceById = new Map((services || []).map((service) => [service.id, service]));
  return (items || []).filter(
    (item) =>
      item?.kind === "appointment" &&
      !previousItemsById.has(item.id) &&
      !isInactiveForConflict(item) &&
      (item.origin || "clarity") === "clarity" &&
      !isVideoReviewService(serviceById.get(item.serviceId)),
  );
}

/**
 * Book Optix bays for lessons the coach just created on the calendar.
 *
 * The counterpart of the auto-book that already runs for client bookings
 * (schedulePublicBookingSideEffects). A lesson type with Auto-book ticked
 * should get its bay whichever door the booking came through — the client's
 * public page or the coach typing it straight onto the calendar — and until
 * now only the first door was wired up.
 *
 * Deferred like the Google sync and the bay rebook: autoBookResourceForNewBooking
 * costs an Optix round trip of up to 25 seconds, and a calendar save must not
 * wait on it. Never throws, and returns immediately for lesson types without
 * the tick, so callers pass every new appointment without checking settings.
 */
function deferOptixAutoBook(accountId: string, appointments: any[], netlifyContext = null) {
  const pending = (appointments || []).filter(Boolean);
  if (!pending.length) return;
  if (pending.length > OPTIX_AUTO_BOOK_MAX_PER_SAVE) {
    console.warn("optix_auto_book_skipped_bulk_save", {
      accountId,
      created: pending.length,
      limit: OPTIX_AUTO_BOOK_MAX_PER_SAVE,
    });
    return;
  }
  const task = (async () => {
    for (const appointment of pending) {
      await autoBookResourceForNewBooking(accountId, appointment.id, appointment.serviceId);
    }
  })().catch((error) => console.error("optix_auto_book_deferred_failed", error));
  if (netlifyContext && typeof netlifyContext.waitUntil === "function") {
    netlifyContext.waitUntil(task);
  }
}

/** True when a saved appointment occupies a different slot than before. */
function appointmentSlotChanged(previousItem, item) {
  if (!previousItem || !item || item.kind !== "appointment") return false;
  return !sameSlot(
    {
      week: Number(previousItem.week ?? 0),
      day: Number(previousItem.day ?? 0),
      start: Number(previousItem.start ?? 0),
      duration: Number(previousItem.duration ?? 0),
    },
    {
      week: Number(item.week ?? 0),
      day: Number(item.day ?? 0),
      start: Number(item.start ?? 0),
      duration: Number(item.duration ?? 0),
    },
  );
}

async function writeCalendarState(accountId: string, nextState: Record<string, any>, context = null, netlifyContext = null) {
  if (!accountId) throw missingAccountScope("calendar_state_write");
  const current = await readCalendarState(accountId);
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
  // The calendar refuses to move an externally owned booking, but the UI is not
  // the boundary -- a direct PUT would otherwise move the lesson here while the
  // provider carries on holding the original time, and nothing anywhere would
  // signal the gap. Only the slot is guarded: notes, coach and the rest stay
  // editable, and an unchanged external booking passes straight through.
  const previousItemsById = new Map((current.items || []).map((item) => [item.id, item]));
  for (const item of requestedItems) {
    const previous = previousItemsById.get(item.id);
    if (!previous) continue;
    const plan = planExternalReschedule(
      {
        id: previous.id,
        origin: previous.origin || "clarity",
        externalProvider: previous.externalProvider || "",
        externalBookingId: previous.externalBookingId || "",
        week: Number(previous.week ?? 0),
        day: Number(previous.day ?? 0),
        start: Number(previous.start ?? 0),
        duration: Number(previous.duration ?? 0),
      },
      {
        week: Number(item.week ?? 0),
        day: Number(item.day ?? 0),
        start: Number(item.start ?? 0),
        duration: Number(item.duration ?? 0),
      },
    );
    if (plan.action === "refuse") {
      throw Object.assign(new Error(plan.message), {
        status: 409,
        code: plan.code,
        operationOwner: "external_reschedule_guard",
        route: "PUT /api/calendar-state",
      });
    }
  }
  // The authenticated account, full stop. It used to fall back to whichever
  // workspace the settings blob listed first.
  const peopleAccountId = accountId;
  // Resolve/sync the client link before writing the items so the resolved
  // person_id can be stamped onto each appointment in the same write, rather
  // than a second pass. See stampResolvedPersonIds for why this must run
  // before writeItems.
  const peopleSync = await importPeople(
    requestedItems.map((item) => personFromAppointment(item, accountId)),
    "appointment",
    peopleAccountId,
  );
  const itemsToWrite = stampResolvedPersonIds(requestedItems, peopleSync.resolvedIds);
  const items = await writeItems(itemsToWrite, {
    replaceItems: nextState?.replaceItems === true || nextState?.itemsOperation === "replace",
    clearItems: nextState?.clearItems === true,
    accountId: context?.accountId,
  });
  // Bay bookings follow their lessons: every appointment whose slot changed in
  // this save gets its Optix bay cancelled and rebooked in the background.
  deferOptixBayRebook(
    accountId,
    items
      .filter((item) => appointmentSlotChanged(previousItemsById.get(item.id), item))
      .map((item) => item.id),
    netlifyContext,
  );
  // Lessons the coach just created get the same Auto-book treatment a client
  // booking gets. Runs after the rebook scheduling above and never overlaps
  // with it: an appointment is either new to this save or it already existed,
  // never both.
  deferOptixAutoBook(
    accountId,
    newlyCreatedAutoBookableAppointments(previousItemsById, items, current.services),
    netlifyContext,
  );
  const updatedAt = nowIso();
  await setSettingsBulk(accountId, { syncKey, updatedAt });
  // The response payload rebuilds the whole admin state. None of these reads depend on each
  // other, and running them one after another stacked six round trips onto every save.
  // readAdminSettings/readBrandSettings/readCoachAccount all derive from the same settings
  // table, so share one bulk read across them instead of each fetching its own copy in parallel.
  const sharedSettingsMap = await readSettingsMap(accountId);
  const [people, notifications, settings, brand, account, googleCalendar] = await Promise.all([
    readPeople(peopleAccountId),
    readNotificationHistory(accountId),
    readAdminSettings(accountId, sharedSettingsMap),
    readBrandSettings(accountId, sharedSettingsMap),
    readCoachAccount(accountId, sharedSettingsMap),
    getGoogleCalendarSyncStatus(accountId),
  ]);
  // Fired, not awaited: see deferGoogleCalendarSync. The connection status the
  // client shows comes from the read above, so the pending marker adds to it
  // rather than replacing it with a bare flag.
  const googleCalendarSync = {
    ...googleCalendar,
    ...deferGoogleCalendarSync(
      accountId,
      googleCalendarChangesBetween(current.items, items),
      "admin_calendar_save",
      netlifyContext,
    ),
  };
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
    people,
    notifications,
    settings,
    brand,
    account,
    googleCalendar,
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
  const status = responseStatusFromError(error);
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

async function deleteCalendarItemById(accountId: string, id, context = null, netlifyContext = null) {
  const cleanId = cleanString(id, "", 140);
  if (!accountId) throw missingAccountScope("calendar_delete");
  if (!cleanId) {
    throw Object.assign(new Error("Calendar item id is required for delete."), {
      status: 400,
      code: "BOOKING_DELETE_INVALID_ID",
      operationOwner: "calendar_delete_request",
      route: "DELETE /api/calendar-state",
    });
  }
  const current = await readCalendarState(accountId);
  if (context) assertAccountFeature(context.account, "coachCalendar");
  const existingItem = current.items.find((item) => item.id === cleanId);
  let optixBayWarning = "";
  if (existingItem?.kind === "appointment") {
    try {
      await cancelOptixBayForCalendarItem(cleanId);
    } catch (error) {
      // A bay Optix will not release must not strand the lesson in Clarity.
      // Blocking the delete here is what left an undeletable ghost on the
      // calendar when Optix answered a release with an internal server error.
      // cancelOptixBayForCalendarItem has already marked the sync row failed,
      // so the delete goes ahead and the coach is told to clear the bay there.
      const detail = cleanString(
        error?.cause?.message || (error instanceof Error ? error.message : String(error || "")),
        "Optix did not confirm the release.",
        400,
      );
      optixBayWarning = `The lesson was removed from Clarity, but its Optix bay booking was not released: ${detail} Cancel the bay in Optix so the slot is not held.`;
      console.error("calendar_delete:optix_bay_release_failed", { calendarItemId: cleanId, detail });
    }
  }
  // An imported Optix lesson is the CUSTOMER's booking in Optix, which the bay
  // release above never touches (there is no optix_booking_sync row for it).
  // Ask Optix to cancel it too, so deleting in Clarity no longer strands a
  // live booking on the customer. Failure is a warning, never a blocker: the
  // admin decided this lesson goes, and is told plainly if Optix kept it.
  let optixCustomerCancelWarning = "";
  if (
    existingItem?.kind === "appointment" &&
    existingItem.origin === "optix" &&
    cleanString(existingItem.externalBookingId, "", 140)
  ) {
    try {
      await cancelOptixCustomerBooking({
        externalBookingId: existingItem.externalBookingId,
        week: existingItem.week,
        day: existingItem.day,
        start: existingItem.start,
        duration: existingItem.duration,
        timezone: existingItem.location?.timezone || "",
        clientName: existingItem.client || existingItem.title || "",
      });
    } catch (error) {
      const detail = cleanString(
        error?.cause?.message || (error instanceof Error ? error.message : String(error || "")),
        "Optix did not confirm the cancellation.",
        400,
      );
      optixCustomerCancelWarning = `The lesson was removed from Clarity, but Optix did not confirm cancelling the customer's booking: ${detail} Cancel it in Optix or the customer stays booked there.`;
      console.error("calendar_delete:optix_customer_cancel_failed", { calendarItemId: cleanId, optixBookingId: existingItem.externalBookingId, detail });
    }
  }
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

  let passCreditsReturned = 0;
  const client = await db().pool.connect();
  try {
    await client.query("BEGIN");
    // Defence in depth. The permission check above already established that
    // this booking belongs to the caller's business; the destructive statement
    // says so too, so an id alone can never delete another business's row even
    // if a check above is ever refactored away.
    // A deleted booking cannot hold a pass credit, so the credit goes back
    // here rather than on whatever read happens to come next. In the same
    // transaction as the delete on purpose: committing one without the other
    // is how a credit ends up stranded against a lesson that no longer exists.
    //
    // No prompt, unlike a cancellation -- there is nothing left to charge for.
    passCreditsReturned = await reverseRedemptionsForBooking(
      client,
      accountId,
      cleanId,
      "Booking deleted",
      context?.userId || "",
    );
    await client.query("DELETE FROM calendar_items WHERE id = $1 AND account_id = $2", [cleanId, accountId]);
    const verifyRows = queryRows(
      await client.query(
        "SELECT id FROM calendar_items WHERE id = $1 AND account_id = $2 LIMIT 1",
        [cleanId, accountId],
      ),
    );
    if (verifyRows.length) {
      throw Object.assign(new Error("Deleted calendar item is still present after delete."), {
        status: 409,
        code: "BOOKING_DELETE_VERIFY_FAILED",
        operationOwner: "calendar_delete_verify",
        route: "DELETE /api/calendar-state",
      });
    }
    // Tombstone for externally-imported bookings. The DELETE above cascades
    // away the external_booking_links row, which is the dedupe anchor the
    // webhook importer uses — without a replacement, a redelivered
    // new_member_booking event would quietly re-import a lesson the admin
    // deliberately deleted. clarity_item_id is NULL because the lesson no
    // longer exists; the importer treats processing_status
    // 'deleted_in_clarity' as "never import this booking again".
    const externalBookingId = cleanString(existingItem?.externalBookingId, "", 140);
    const externalProvider = cleanString(existingItem?.externalProvider, "", 40) || "optix";
    if (existingItem && existingItem.origin && existingItem.origin !== "clarity" && externalBookingId) {
      await client.query(
        `INSERT INTO external_booking_links
           (provider, purpose, external_booking_id, clarity_item_id, origin, processing_status, email_status, created_at, updated_at)
         VALUES ($1, 'lesson', $2, NULL, $3, 'deleted_in_clarity', 'suppressed', NOW(), NOW())
         ON CONFLICT (provider, purpose, external_booking_id)
         DO UPDATE SET clarity_item_id = NULL, processing_status = 'deleted_in_clarity', updated_at = NOW()`,
        [externalProvider, externalBookingId, existingItem.origin],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const updatedAt = nowIso();
  await setSetting(accountId, "updatedAt", updatedAt);
  const googleCalendarSync = deferGoogleCalendarSync(
    accountId,
    [{ id: cleanId, action: "delete" }],
    "admin_calendar_delete",
    netlifyContext,
  );
  let nextState = null;
  try {
    nextState = await readCalendarState(accountId);
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
  const deleteWarnings = [optixBayWarning, optixCustomerCancelWarning].filter(Boolean);
  const passNotice = passCreditsReturned
    ? passCreditsReturned === 1
      ? "That lesson was paid with a pass. The credit has been returned."
      : `That lesson was paid with a pass. ${passCreditsReturned} credits have been returned.`
    : "";
  return {
    ...nextState,
    items: context ? nextState.items.filter((item) => canReadCalendarItem(context, item, nextState)) : nextState.items,
    updatedAt,
    googleCalendarSync,
    ...(deleteWarnings.length ? { warnings: deleteWarnings } : {}),
    ...(passNotice ? { notices: [passNotice] } : {}),
  };
}

function scheduleAdminDeleteSideEffects(accountId, context, previousItems, nextItems, timeZone) {
  const task = (async () => {
    try {
      await processAdminNotificationDebounce(accountId, previousItems, nextItems, { timeZone });
    } catch (error) {
      console.error("calendar_state:notification_failed", error);
    }
  })().catch((error) => console.error("calendar_state:delete_side_effects_failed", error));

  if (context && typeof context.waitUntil === "function") {
    context.waitUntil(task);
  }
}

async function writePublicBookingState(accountId: string, currentState: Record<string, any>, items) {
  // The resolved public business, not "whichever account the first item
  // happens to claim" -- an item is client-shaped data on this path.
  const peopleAccountId = accountId;
  const peopleSync = await importPeople(
    items.map((item) => personFromAppointment(item, peopleAccountId)),
    "appointment",
    peopleAccountId,
  );
  const itemsToWrite = stampResolvedPersonIds(items, peopleSync.resolvedIds);
  const cleanItems = await writeItems(itemsToWrite, { accountId });
  const updatedAt = nowIso();
  await setSetting(accountId, "updatedAt", updatedAt);
  await syncGoogleCalendarChangesIfEnabled(
    accountId,
    googleCalendarChangesBetween(currentState.items, cleanItems),
    "public_booking_state_write",
  ).catch((error) =>
    console.error("public_booking_state:google_calendar_sync_failed", error),
  );
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

function schedulePublicBookingSideEffects(accountId: string, context, appointment: Record<string, any>, options = {}) {
  const task = (async () => {
    // Send the booking confirmation from the server, first thing. It used to
    // be triggered only by the client's browser calling
    // /api/public-booking-notifications after the confirmation screen
    // rendered — so closing the tab (or a dropped mobile request) right after
    // booking meant no email until something poked the appointment later.
    // The history check keeps this idempotent against retries and replays.
    if (options.sendConfirmation === true) {
      try {
        const history = clientNotificationRecords(
          await readNotificationHistoryForAppointment(accountId, appointment.id),
          appointment.id,
        );
        const alreadySent = history.some(
          (notification) => notification.kind.startsWith("booking_") && notification.status === "sent",
        );
        if (!alreadySent) {
          await sendBookingNotifications(accountId, appointment, { kind: "booking" });
        }
      } catch (error) {
        console.error("public_booking:confirmation_email_failed", appointment?.id, error);
      }
    }
    // The appointment was already written without waiting on this (public
    // booking latency matters more than the client link being instant). Once
    // the person is resolved/created here, stamp its id back onto the row so
    // the coach's calendar sees the same link a moment later — and so the
    // *next* edit to this booking finds it via id instead of re-deriving the
    // match from name/email/phone.
    const peopleSync = await importPeople(
      [personFromAppointment(appointment, accountId)],
      "appointment",
      appointment?.accountId || "",
    );
    const [stamped] = stampResolvedPersonIds([appointment], peopleSync.resolvedIds);
    if (stamped.personId && stamped.personId !== appointment.personId) {
      await writeItems([stamped]);
    }
    await syncGoogleCalendarChangesIfEnabled(accountId, [{ id: appointment.id, action: "upsert" }], "public_booking_created").catch((error) =>
      console.error("public_booking:google_calendar_sync_failed", error),
    );
    // Lesson types with Auto-book ticked in Resources get their Optix bay
    // booked here — after the booking is already on the calendar — instead of
    // holding up the client's booking flow. Only for newly created client
    // bookings. Never throws; on failure the card simply shows no bay and the
    // coach books it manually as before.
    if (options.autoBookResource === true) {
      await autoBookResourceForNewBooking(accountId, appointment.id, appointment.serviceId);
    }
    // A client rescheduled: cancel the bay at the old slot and book a fresh
    // one at the new slot. Same helper the admin drag uses, deferred the same
    // way — the client's confirmation screen must not wait on two Optix round
    // trips. Never throws, and skips lessons that had no bay to begin with.
    if (options.rebookResource === true) {
      await rebookResourceAfterReschedule(accountId, appointment.id);
    }
    // A client just booked. This path sends its confirmation through
    // sendBookingNotifications above rather than notifyBookingEvent, so the
    // coach's browser pop-up is sent explicitly here — same composer, so the
    // wording matches the cancel and reschedule pop-ups.
    if (options.coachPush === true) {
      await sendCoachPushForBooking({ action: "booking", appointment, source: "public-booking" });
    }
  })().catch((error) => console.error("public_booking:side_effects_failed", appointment?.id, error));

  if (context && typeof context.waitUntil === "function") {
    context.waitUntil(task);
  }
}

async function writePublicBookingAppointment(accountId: string, currentState: Record<string, any>, appointment: Record<string, any>, context = null, options = {}) {
  const cleanItems = await writeItems([appointment], { accountId });
  const updatedAt = nowIso();
  await setSetting(accountId, "updatedAt", updatedAt);
  const savedAppointment = cleanItems.find((item) => item.id === appointment.id) || appointment;
  schedulePublicBookingSideEffects(accountId, context, savedAppointment, options);
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

// The locale here is arbitrary and deliberately fixed: every field below is
// numeric and read back by part type, so the locale cannot change the result.
// It is not a formatting choice and must not be confused with one.
const CLOCK_PARTS_LOCALE = "en-GB";

function clockParts(timeZone) {
  return new Intl.DateTimeFormat(CLOCK_PARTS_LOCALE, {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
}

// No default at all. This function decides what "now" is, and
// isAppointmentInPast() below uses it to decide whether a lesson has already
// happened. A caller that forgot to pass a timezone used to silently get
// Auckland — an 11-to-13 hour error for a coach anywhere in Europe, in the code
// path that hides past lessons and suppresses their reminders. Replacing that
// with a module-level "current" workspace only moved the problem: a warm
// instance handed the previous business's clock to the next one. Required
// argument, so an omission is a type error; an unusable value still falls back
// to UTC loudly rather than pretending the coach is in New Zealand.
function nowInTimeZoneParts(timeZone: string) {
  let parts;
  try {
    parts = clockParts(timeZone);
  } catch {
    console.warn("booking_core:invalid_timezone_falling_back_to_utc", { timeZone });
    parts = clockParts(FALLBACK_TIME_ZONE);
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

// True when the wall-clock start of a {week, day, start} slot is at or before
// "now" in the workspace's timezone. Public booking uses this to stop offering
// times that have already passed today (a slot starting exactly now is treated
// as past — you can't book the instant it begins). Mirrors isAppointmentInPast
// but works on a raw candidate rather than a stored calendar item.
function isSlotInPast(week, day, start, timeZone: string) {
  const slotDate = slotDateParts(Number(week ?? 0), Number(day ?? 0));
  const now = nowInTimeZoneParts(timeZone);
  const slotValue = dateSortValue(slotDate);
  const nowValue = dateSortValue(now);
  if (slotValue !== nowValue) return slotValue < nowValue;
  return Number(start ?? 0) <= now.minutes;
}

// Minutes since the appointment's wall-clock end in the workspace's timezone.
// Negative while the lesson is still in the future. Used by the debounce flush
// to distinguish "flushed a bit late" (still send) from "genuinely stale" (drop).
function appointmentMinutesSinceEnd(item, timeZone: string) {
  const slot = slotDateParts(Number(item?.week ?? 0), Number(item?.day ?? 0));
  const now = nowInTimeZoneParts(timeZone);
  const dayDiff =
    (Date.UTC(now.year, now.month - 1, now.day) - Date.UTC(slot.year, slot.month - 1, slot.day)) / 86400000;
  const end = Number(item?.start ?? 0) + Number(item?.duration ?? 0);
  return dayDiff * 1440 + (now.minutes - end);
}

function isAppointmentInPast(item, timeZone: string) {
  if (!item || item.kind !== "appointment") return false;
  const slotDate = slotDateParts(Number(item.week ?? 0), Number(item.day ?? 0));
  const now = nowInTimeZoneParts(timeZone);
  const slotValue = dateSortValue(slotDate);
  const nowValue = dateSortValue(now);
  if (slotValue !== nowValue) return slotValue < nowValue;
  return Number(item.start ?? 0) < now.minutes;
}

// Converts one {week, day, start} slot's wall-clock time in the workspace
// timezone into a true UTC instant. Existing helpers above (slotDateParts,
// nowInTimeZoneParts, isAppointmentInPast) deliberately never do this -- they
// only ever compare wall-clock parts against each other. A Practice Block's
// expiry_date is a real TIMESTAMPTZ compared against Postgres NOW(), so the
// one slot chosen as "next lesson" needs an actual instant, not a parts label.
function slotWallTimeToUtcMillis(week, day, start, timeZone: string) {
  const { year, month, day: dayOfMonth } = slotDateParts(Number(week || 0), Number(day || 0));
  const hour = Math.floor(Number(start || 0) / 60);
  const minute = Number(start || 0) % 60;
  const guess = Date.UTC(year, month - 1, dayOfMonth, hour, minute, 0);
  // Format that guess back in the target zone; the delta between what we
  // asked for and what came back is the zone's offset at that instant
  // (handles DST without a timezone-database dependency).
  const parts = new Intl.DateTimeFormat(CLOCK_PARTS_LOCALE, {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(new Date(guess));
  const value = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  const observed = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour") % 24, value("minute"), value("second"));
  return guess - (observed - guess);
}

/**
 * Resolves a player's next future lesson to a frozen expiry instant, for
 * Practice Block expiry_type='next_lesson'. Called exactly once, at
 * assignment time (createPracticeBlock / updatePracticeBlock when the coach
 * explicitly re-picks next_lesson) -- never from a read path, so a later
 * reschedule cannot silently move an already-assigned block's expiry.
 *
 * Deliberately reuses readPublicAppointmentsForContact, the same source the
 * player portal's own "next lesson" is built from client-side
 * (PlayerPortal.tsx upcomingBookings), so the server-resolved expiry matches
 * what the player already sees as their next lesson rather than introducing a
 * second, differently-behaved notion of it. That function requires both an
 * email and a phone on file for the contact match; if the player has neither,
 * or has no future booking, this returns null and the caller falls back to
 * no expiry.
 */
async function resolveNextLessonExpiry(playerId, accountId) {
  // playerId arrives from the practice-block request body, so the read is
  // scoped: an id on its own must not reach another business's client.
  const rows = await db().sql`
    SELECT * FROM people WHERE id = ${playerId} AND account_id = ${accountId} LIMIT 1
  `;
  const person = rows[0] ? rowToPerson(rows[0]) : null;
  if (!person?.email || !person?.phone) return null;
  const { items } = await readPublicAppointmentsForContact({
    accountId,
    email: person.email,
    phone: person.phone,
  });
  const timeZone = await accountTimeZoneFor(accountId);
  const future = items
    .filter((item) => !isInactiveForConflict(item) && !isAppointmentInPast(item, timeZone))
    .sort((a, b) => itemWeek(a) - itemWeek(b) || a.day - b.day || a.start - b.start);
  const winner = future[0];
  if (!winner) return null;
  const atMillis = slotWallTimeToUtcMillis(winner.week, winner.day, winner.start, timeZone);
  return { expiryDate: new Date(atMillis).toISOString(), calendarItemId: winner.id };
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
    deferrals: Math.max(0, Math.min(10, Math.round(Number(value?.deferrals) || 0))),
  };
}

async function readPendingAdminNotifications(accountId) {
  try {
    const parsed = JSON.parse((await getSetting(accountId, ADMIN_NOTIFICATION_DEBOUNCE_QUEUE_KEY)) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map(cleanPendingAdminNotification).filter(Boolean);
  } catch {
    return [];
  }
}

async function writePendingAdminNotifications(accountId, queue) {
  await setSetting(accountId, ADMIN_NOTIFICATION_DEBOUNCE_QUEUE_KEY, JSON.stringify(queue));
}

async function processAdminNotificationDebounce(
  accountId: string,
  previousItems = [],
  nextItems = [],
  options = {},
) {
  if (!accountId) throw missingAccountScope("admin_notification_debounce");
  const now = Date.now();
  const timeZone =
    cleanString(options.timeZone, "", 80) || (await accountTimeZoneFor(accountId));
  const queueById = new Map(
    (await readPendingAdminNotifications(accountId)).map((entry) => [
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
          deferrals: 0,
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
          deferrals: 0,
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
    if (!current) {
      console.warn("admin_notification_debounce:dropped", { calendarItemId: id, action: pending.action, reason: "item_deleted" });
      continue;
    }
    // A late flush must not swallow the notification just because the lesson's
    // (new) start time has since passed — the client still needs to hear about a
    // reschedule that fired an hour late. Only genuinely stale entries (the
    // lesson ended more than a day ago) are dropped, and the drop is logged.
    if (appointmentMinutesSinceEnd(current, timeZone) > 24 * 60) {
      console.warn("admin_notification_debounce:dropped", { calendarItemId: id, action: pending.action, reason: "ended_over_24h_ago" });
      continue;
    }
    if (appointmentNotificationSignature(current) !== pending.targetSignature) {
      // The appointment changed again after this entry was queued (a price tweak,
      // a status change — anything outside inferBookingAction's diff). Dropping
      // here silently was how admin reschedule emails went missing. Instead,
      // re-queue against the current state so the email sends once editing
      // settles; after a few deferrals send anyway rather than defer forever.
      const deferrals = Number(pending.deferrals ?? 0);
      if (deferrals < 5) {
        queueById.set(id, {
          ...pending,
          deferrals: deferrals + 1,
          fireAfter: new Date(now + ADMIN_NOTIFICATION_DEBOUNCE_MS).toISOString(),
          targetSignature: appointmentNotificationSignature(current),
          appointment: current,
        });
        continue;
      }
      console.warn("admin_notification_debounce:deferral_limit_reached_sending_anyway", { calendarItemId: id, action: pending.action });
    }
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

  if (queueChanged) await writePendingAdminNotifications(accountId, [...queueById.values()]);
  return results;
}

// Flush the admin notification debounce queue without queueing new diffs.
// Called by the scheduled function (admin-notification-flush.mts) so queued
// booking/reschedule emails send even when no admin browser tab is open to
// fire the client-side setTimeout flush — previously the only trigger, which
// is why admin reschedule emails went missing whenever the tab closed within
// the 30-second debounce window.
export async function flushAdminNotificationQueue() {
  // Per business. The queue lives in that business's settings row and the
  // debounce reads that business's calendar, so a single global pass would
  // have flushed one coach's queue against another coach's lessons.
  const accountIds = await listActiveAccountIds();
  let pending = 0;
  const results = [];
  for (const accountId of accountIds) {
    try {
      const queued = await readPendingAdminNotifications(accountId);
      if (!queued.length) continue;
      pending += queued.length;
      const state = await readCalendarState(accountId);
      results.push(
        ...(await processAdminNotificationDebounce(accountId, state.items, state.items, {
          queueDiffs: false,
          timeZone: state.account?.timezone,
        })),
      );
    } catch (error) {
      console.error("admin_notification_flush:account_failed", { accountId, error });
    }
  }
  return { pending, results };
}

// Cap reminder sends per scheduled run so a backlog (e.g. the feature being
// switched on with a full week already booked) drains over a few runs instead
// of tripping Resend's rate limit or the function timeout. Leftovers are
// picked up by the next run — the due window is wide, not a single instant.
const REMINDER_MAX_SENDS_PER_RUN = 20;

// Send lesson reminder emails for appointments whose start time is within the
// configured lead window. Called by the scheduled function
// (lesson-reminders.mts); everything here must therefore be idempotent — the
// notification_history row written by the send is what stops the next run
// from reminding the same lesson again.
export async function processDueLessonReminders() {
  // One pass per business. Reminder lead time, timezone and templates are all
  // per-account settings, and the lessons being reminded about belong to one
  // business -- so the whole job runs inside an account, not across them.
  const accountIds = await listActiveAccountIds();
  const perAccount = [];
  for (const accountId of accountIds) {
    try {
      perAccount.push({ accountId, ...(await processDueLessonRemindersForAccount(accountId)) });
    } catch (error) {
      console.error("lesson_reminders:account_failed", { accountId, error });
    }
  }
  return {
    accounts: perAccount,
    enabled: perAccount.some((result) => result.enabled),
    due: perAccount.reduce((total, result) => total + (result.due || 0), 0),
    sent: perAccount.reduce((total, result) => total + (result.sent || 0), 0),
    skipped: perAccount.reduce((total, result) => total + (result.skipped || 0), 0),
  };
}

async function processDueLessonRemindersForAccount(accountId) {
  const settingsMap = await readSettingsMap(accountId);
  const settings = adminSettingsFromSettings(settingsMap);
  if (!settings.reminderEnabled) return { enabled: false, due: 0, sent: 0 };
  const leadMinutes = settings.reminderLeadMinutes;
  const timeZone = cleanString(settingValue(settingsMap, "accountTimezone"), defaultTimeZone(), 80);
  const items = await readItems(accountId);

  const due = items.filter((item) => {
    if (item.kind !== "appointment") return false;
    // Cancelled, no-show and already-completed lessons never need a reminder.
    if (["cancelled", "no_show", "completed"].includes(item.status)) return false;
    // Reminders go to whoever booked; group slots without a direct email are
    // skipped rather than guessed at.
    if (!cleanEmail(item.email, "")) return false;
    const minutesUntilStart = -appointmentMinutesSinceEnd(item, timeZone) - Number(item.duration || 0);
    return minutesUntilStart > 0 && minutesUntilStart <= leadMinutes;
  });
  if (!due.length) return { enabled: true, due: 0, sent: 0 };

  let sent = 0;
  let skipped = 0;
  for (const item of due.slice(0, REMINDER_MAX_SENDS_PER_RUN)) {
    try {
      const history = await readNotificationHistoryForAppointment(accountId, item.id);
      // One reminder per lesson. A failed send may retry, but at most once an
      // hour — not on every 5-minute run — so a dead address can't flood the
      // history while the lesson is still days away.
      const reminderRows = history.filter((notification) => notification.kind === "reminder_client_email");
      const alreadyReminded =
        reminderRows.some((notification) => notification.status === "sent" || notification.status === "skipped") ||
        reminderRows.some((notification) => {
          const createdMs = new Date(notification.createdAt || 0).getTime();
          return Number.isFinite(createdMs) && Date.now() - createdMs < 60 * 60000;
        });
      if (alreadyReminded) {
        skipped += 1;
        continue;
      }
      // If the confirmation (or a reschedule/update email) went out after the
      // reminder became due, the client already has a fresh email with the
      // full details — booking 2 hours before a lesson with a 24-hour lead
      // should not stack a reminder straight on top of the confirmation.
      const minutesUntilStart = -appointmentMinutesSinceEnd(item, timeZone) - Number(item.duration || 0);
      const dueAtMs = Date.now() + (minutesUntilStart - leadMinutes) * 60000;
      const freshClientEmail = history.some((notification) => {
        if (!/^(booking|rescheduled|reschedule|updated)_client_email$/.test(notification.kind)) return false;
        if (notification.status !== "sent") return false;
        // created_at can arrive as a string or a Date depending on the driver.
        const createdMs = new Date(notification.createdAt || 0).getTime();
        return Number.isFinite(createdMs) && createdMs >= dueAtMs;
      });
      if (freshClientEmail) {
        skipped += 1;
        continue;
      }
      await notifyBookingEvent({ action: "reminder", appointment: item, source: "lesson-reminder-schedule" });
      sent += 1;
    } catch (error) {
      console.error("lesson_reminders:send_failed", item.id, error);
    }
  }
  if (due.length > REMINDER_MAX_SENDS_PER_RUN) {
    console.warn("lesson_reminders:capped", { due: due.length, cap: REMINDER_MAX_SENDS_PER_RUN });
  }
  return { enabled: true, due: due.length, sent, skipped };
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

async function sendPasswordResetEmail(accountId, reset, req) {
  const account = await readCoachAccount(accountId);
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

  return deliverEmail({
    accountId,
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
    ctz: location?.timezone || account.timezone || defaultTimeZone(),
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

function customGroupInviteEmail({ appointment, attendee, service, account, coach = null }) {
  const variables = bookingEmailVariables({ appointment, service, account, coach });
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

// Coach emails used to go to a single global `settings.coachEmail`, ignoring the coach who
// actually owns the booking. Resolve from the live coach profile first (so profile edits take
// effect on existing bookings), then the snapshot stored on the appointment, then the legacy
// account-wide setting as a last resort.
function resolveAppointmentCoach(appointment, coaches = [], account = defaultCoachAccount(), settings = {}) {
  const snapshot = appointment?.coach || null;
  const coachId = cleanSlug(appointment?.coachId || snapshot?.coachId || "", "") || defaultCoachId(coaches);
  const profile = coachById(coaches, coachId);
  const email =
    cleanEmail(profile?.email, "") ||
    cleanEmail(snapshot?.email, "") ||
    cleanEmail(settings?.coachEmail, "") ||
    cleanEmail(account?.contactEmail, "");
  const name =
    cleanString(profile?.displayName || profile?.name, "", 120) ||
    cleanString(snapshot?.displayName || snapshot?.name, "", 120) ||
    cleanString(account?.coachName, "", 120) ||
    cleanString(account?.businessName, "", 120);
  return { coachId, email, name };
}

function bookingEmailVariables({ appointment, service, account, coach = null }) {
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
    coach: coach?.name || account.coachName || account.businessName,
    service: service?.name || "Golf Lesson",
    date: formatBookingDate(itemWeek(appointment), appointment.day),
    // A review's slot is a deadline, so the clock range it happens to occupy
    // is not a time to be anywhere. The templates are the coach's to edit, so
    // {{time}} keeps working -- it just stops naming an hour that means
    // nothing. {{date}}, the part that does mean something, is unchanged.
    time: isVideoReviewService(service)
      ? "end of day"
      : formatRange(appointment.start, appointment.duration),
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
  accountId: string,
  appointment: Record<string, any>,
  { kind = "booking", testRecipient = "", clientOnly = false, idempotencyNonce = "" } = {},
) {
  if (!accountId) throw missingAccountScope("booking_notifications");
  const sharedSettingsMap = await readSettingsMap(accountId);
  const [settings, account, services, coaches] = await Promise.all([
    readAdminSettings(accountId, sharedSettingsMap),
    readCoachAccount(accountId, sharedSettingsMap),
    readServices(accountId),
    readCoachProfiles(accountId),
  ]);
  const service = services.find(
    (candidate) => candidate.id === appointment.serviceId,
  );
  const coach = resolveAppointmentCoach(appointment, coaches, account, settings);
  const variables = bookingEmailVariables({ appointment, service, account, coach });
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
    const result = await deliverEmail({
      accountId,
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
      const invite = customGroupInviteEmail({ appointment, attendee, service, account, coach });
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
    const recipient = coach.email || "";
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
    jobs.push(recordSkipped("coach", coach.email || "", subject, "disabled_in_notification_settings"));
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
  const current = state || (await readCalendarState(context.accountId));
  const cleanId = cleanString(appointmentId, "", 140);
  const appointment = (current.items || []).find((item) => item.id === cleanId);
  if (!appointment || appointment.kind !== "appointment" || !canReadCalendarItem(context, appointment, current)) {
    throw Object.assign(new Error("Booking was not found in this workspace."), { status: 404 });
  }
  if (!cleanEmail(appointment.email, "")) {
    throw Object.assign(new Error("This booking does not have a customer email address."), { status: 400 });
  }

  const results = await sendBookingNotifications(context.accountId, appointment, {
    kind: "booking",
    clientOnly: true,
    idempotencyNonce: `admin-resend-${Date.now()}-${randomUUID().slice(0, 8)}`,
  });
  const notifications = filterNotificationsForContext(await readNotificationHistory(context.accountId), context, current);
  return {
    ok: results.some((result) => result.sent),
    results,
    notifications,
  };
}

async function sendInitialBookingNotifications(accountId: string, appointment: Record<string, any>, kind = "booking") {
  try {
    const results = await sendBookingNotifications(accountId, appointment, { kind });
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
      const sharedSettingsMap = await readSettingsMap(accountId);
      const [settings, account, services, coaches] = await Promise.all([
        readAdminSettings(accountId, sharedSettingsMap),
        readCoachAccount(accountId, sharedSettingsMap),
        readServices(accountId),
        readCoachProfiles(accountId),
      ]);
      const service = services.find(
        (candidate) => candidate.id === appointment?.serviceId,
      );
      const coach = resolveAppointmentCoach(appointment, coaches, account, settings);
      const variables = bookingEmailVariables({
        appointment,
        service,
        account,
        coach,
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

      if (settings.sendCoachEmail && coach.email) {
        await recordFailed(
          "coach",
          coach.email,
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

/**
 * Mint the app session cookie.
 *
 * The cookie stays -- the calendar UI is built on it -- but it is no longer the
 * authority on identity. The row records the Supabase auth.users id that
 * actually proved the password, and requireCoachActor() resolves that id
 * through account_memberships to get the account. A session with no
 * auth_user_id can prove someone logged in once and nothing more.
 */
async function createAdminSession(userOrId, authUserId = "") {
  const startedAt = Date.now();
  let ok = false;
  const userId = typeof userOrId === "object" ? userOrId.id : userOrId;
  const linkedAuthUserId = cleanString(
    typeof userOrId === "object" ? userOrId.authUserId || authUserId : authUserId,
    "",
    80,
  );
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000).toISOString();
  try {
    await db().sql`
      INSERT INTO admin_sessions (id, token_hash, user_id, auth_user_id, expires_at, created_at)
      VALUES (
        ${randomUUID()},
        ${tokenHash},
        ${userId},
        ${linkedAuthUserId || null}::uuid,
        ${expiresAt},
        NOW()
      )
    `;
    ok = true;
    return { token, expiresAt };
  } finally {
    logAuthTiming("createAdminSession", startedAt, { ok, linked: Boolean(linkedAuthUserId) });
  }
}

// LEFT JOIN, not JOIN: a coach whose credential lives only in Supabase Auth
// has no admin_users row, and an inner join silently dropped their session.
async function readAdminSession(token) {
  if (!token) return null;
  const rows = await db().sql`
    SELECT admin_sessions.user_id AS id,
           admin_sessions.auth_user_id,
           admin_users.email,
           admin_sessions.expires_at,
           admin_sessions.active_account_id
    FROM admin_sessions
    LEFT JOIN admin_users ON admin_users.id = admin_sessions.user_id
    WHERE admin_sessions.token_hash = ${hashToken(token)}
  `;
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await destroyAdminSession(token);
    return null;
  }
  return {
    id: row.id,
    authUserId: cleanString(row.auth_user_id, "", 80),
    email: cleanEmail(row.email, ""),
    expiresAt: row.expires_at,
    activeAccountId: cleanSlug(row.active_account_id, ""),
  };
}

async function destroyAdminSession(token) {
  if (!token) return;
  const tokenHash = hashToken(token);
  await db().sql`DELETE FROM admin_sessions WHERE token_hash = ${tokenHash}`;
}

async function cleanupExpiredSessions() {
  await db().sql`DELETE FROM admin_sessions WHERE expires_at <= NOW()`;
}

/**
 * The /api/* gate.
 *
 * A valid session cookie is no longer enough. The session has to resolve to a
 * Supabase identity and that identity to an active account membership, which
 * is exactly what currentActor() does -- so the gate and the per-route account
 * resolution can never disagree, and the membership lookup is paid once.
 *
 * Returns the actor on success. On failure it throws the same 401/403 the
 * routes would, so an authenticated user with no workspace gets "no
 * membership" rather than "not logged in".
 */
async function requireAdmin(req) {
  return currentActor(req);
}

// --- Portal players (Supabase Auth) ---------------------------------------
//
// A person becomes a portal user only when the coach promotes them in Player
// Profiles. This is deliberately not every row in `people` -- most clients are
// a name and a phone number on a booking, not an account.
//
// The credential lives in Supabase Auth (auth.users), the same one Clarity
// Caddy uses, so a player who has a Caddy account signs in to both products
// with one email and password. `portal_players` is what makes an auth user a
// valid login here: an auth user with no active row for this account gets
// nothing.
//
// The browser never receives a Supabase JWT. The password is verified against
// GoTrue server-side and then the app mints its own player_sessions cookie, so
// there is one session mechanism in this app rather than two.

const portalInviteDays = 14;
// A reset link is one the player asked for a minute ago, so it does not get the
// invite's two-week life: an hour is long enough to find the email on a phone
// and short enough that the link is not a standing key to the account.
const portalResetMinutes = 60;

function supabaseAuthConfig() {
  const { url, key } = supabaseStorageConfig();
  // The password grant is a public endpoint and expects the anon key. The
  // service key is accepted as a fallback so a deploy that only sets the
  // service key still logs players in.
  const anonKey =
    env("SUPABASE_ANON_KEY") || env("SUPABASE_PUBLISHABLE_KEY") || key;
  return { url, serviceKey: key, anonKey };
}

async function supabaseAuthFetch(path, { method = "POST", body, useAnonKey = false } = {}) {
  const { url, serviceKey, anonKey } = supabaseAuthConfig();
  const key = useAnonKey ? anonKey : serviceKey;
  const response = await fetch(`${url}/auth/v1${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
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
  return { ok: response.ok, status: response.status, payload };
}

function supabaseAuthError(payload, fallback, status) {
  const message =
    cleanString(payload?.msg, "", 300) ||
    cleanString(payload?.message, "", 300) ||
    cleanString(payload?.error_description, "", 300) ||
    fallback;
  return Object.assign(new Error(message), { status: status || 502 });
}

// The password grant hands back a Supabase session we have no use for. Ending
// it immediately means a portal login never leaves a live Supabase refresh
// token behind for a browser that was never going to hold one.
async function revokeSupabaseAuthSession(accessToken) {
  if (!accessToken) return;
  try {
    const { url, anonKey } = supabaseAuthConfig();
    await fetch(`${url}/auth/v1/logout?scope=local`, {
      method: "POST",
      headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    // Best effort. The token expires on its own.
  }
}

/** Verifies an email + password against Supabase Auth. Returns the auth user id, or "". */
async function verifySupabaseAuthPassword(email, password) {
  if (!email || !password) return "";
  const { ok, payload } = await supabaseAuthFetch("/token?grant_type=password", {
    body: { email, password },
    useAnonKey: true,
  });
  if (!ok) return "";
  await revokeSupabaseAuthSession(cleanString(payload?.access_token, "", 4000));
  return cleanString(payload?.user?.id, "", 80);
}

/**
 * Look the auth user up in Postgres rather than through GoTrue's admin list
 * endpoint. This app talks to Postgres directly, `auth.users` is right there,
 * and the admin list endpoint's filtering behaviour varies by GoTrue version.
 */
async function findSupabaseAuthUserId(email) {
  const cleanEmailValue = cleanEmail(email, "");
  if (!cleanEmailValue) return "";
  try {
    const rows = await db().sql`
      SELECT id FROM auth.users WHERE lower(email) = ${cleanEmailValue} LIMIT 1
    `;
    return cleanString(rows[0]?.id, "", 80);
  } catch (error) {
    console.warn("portal_players:auth_user_lookup_failed", error instanceof Error ? error.message : error);
    return "";
  }
}

/**
 * Creates the Supabase Auth user for a promoted player, or links to the one
 * they already have (most likely from Clarity Caddy). The password set here is
 * random and thrown away -- the player sets a real one through the invite.
 */
async function ensureSupabaseAuthUser(email) {
  const existing = await findSupabaseAuthUserId(email);
  if (existing) return { authUserId: existing, created: false };

  const { ok, status, payload } = await supabaseAuthFetch("/admin/users", {
    body: {
      email,
      email_confirm: true,
      password: randomBytes(24).toString("base64url"),
    },
  });
  if (ok) {
    const authUserId = cleanString(payload?.id, "", 80);
    if (authUserId) return { authUserId, created: true };
  }
  // A race, or an account GoTrue knows about that the lookup missed.
  const afterConflict = await findSupabaseAuthUserId(email);
  if (afterConflict) return { authUserId: afterConflict, created: false };
  throw supabaseAuthError(payload, "Could not create the portal login.", status);
}

async function setSupabaseAuthPassword(authUserId, password) {
  const { ok, status, payload } = await supabaseAuthFetch(
    `/admin/users/${encodeURIComponent(authUserId)}`,
    { method: "PUT", body: { password, email_confirm: true } },
  );
  if (!ok) throw supabaseAuthError(payload, "Could not set that password.", status);
}

function rowToPortalPlayer(row) {
  if (!row) return null;
  return {
    id: cleanString(row.id, "", 80),
    accountId: cleanString(row.account_id, "", 120),
    personId: cleanString(row.person_id, "", 160),
    authUserId: cleanString(row.auth_user_id, "", 80),
    email: cleanEmail(row.email, ""),
    status: cleanString(row.status, "invited", 20),
    invitedAt: row.invited_at || null,
    activatedAt: row.activated_at || null,
    lastLoginAt: row.last_login_at || null,
  };
}

async function readPortalPlayerByAuthUser(authUserId, accountId) {
  if (!authUserId) return null;
  await ensurePlayerSessionsTable();
  const rows = await db().sql`
    SELECT * FROM portal_players
    WHERE auth_user_id = ${authUserId} AND account_id = ${accountId}
    LIMIT 1
  `;
  return rowToPortalPlayer(rows[0]);
}

/**
 * The email is the only thing a signed-out player can offer, so this is what
 * "forgot password" has to look up. Scoped to the account for the same reason
 * the login is: portal access is access to one business.
 *
 * Disabled rows are excluded here rather than left to readPortalInvite. A
 * player whose access was revoked should get no email at all, not an email
 * carrying a link that dies when they open it.
 */
async function readPortalPlayerByEmail(rawEmail, accountId) {
  const email = cleanEmail(rawEmail, "");
  if (!email || !accountId) return null;
  await ensurePlayerSessionsTable();
  const rows = await db().sql`
    SELECT * FROM portal_players
    WHERE LOWER(email) = LOWER(${email})
      AND account_id = ${accountId}
      AND status <> 'disabled'
    LIMIT 1
  `;
  return rowToPortalPlayer(rows[0]);
}

async function readPortalPlayerById(portalPlayerId) {
  if (!portalPlayerId) return null;
  await ensurePlayerSessionsTable();
  const rows = await db().sql`
    SELECT * FROM portal_players WHERE id = ${portalPlayerId} LIMIT 1
  `;
  return rowToPortalPlayer(rows[0]);
}

async function listPortalPlayers(accountId) {
  await ensurePlayerSessionsTable();
  const rows = await db().sql`
    SELECT * FROM portal_players
    WHERE account_id = ${accountId}
    ORDER BY updated_at DESC
  `;
  return rows.map(rowToPortalPlayer).filter(Boolean);
}

/**
 * The portal shows a player their bookings, and bookings are matched by email
 * and phone. The login no longer collects a phone, so it comes from the linked
 * people row instead -- which is the more trustworthy source anyway.
 */
async function portalPlayerContact(portalPlayer) {
  const people = await readPeople(portalPlayer.accountId);
  const person = people.find((candidate) => candidate.id === portalPlayer.personId);
  return {
    personId: portalPlayer.personId,
    name: cleanString(person?.name, "", 180),
    email: portalPlayer.email || cleanEmail(person?.email, ""),
    phone: cleanString(person?.phone, "", 80),
  };
}

async function createPlayerSession({
  personId,
  email,
  phone,
  accountId,
  authUserId,
  portalPlayerId,
  sandboxActorAuthUser = "",
  lifetimeMs = playerSessionDays * 24 * 60 * 60 * 1000,
}) {
  await ensurePlayerSessionsTable();
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + lifetimeMs).toISOString();
  await db().sql`
    INSERT INTO player_sessions (
      id, token_hash, person_id, email, phone, account_id,
      auth_user_id, portal_player_id, sandbox_actor_auth_user, expires_at, created_at
    )
    VALUES (
      ${randomUUID()}, ${tokenHash}, ${personId || null}, ${email}, ${phone || null}, ${accountId || null},
      ${authUserId || null}, ${portalPlayerId || null}, ${sandboxActorAuthUser || null}, ${expiresAt}, NOW()
    )
  `;
  return { token, expiresAt };
}

async function readPlayerSession(token) {
  if (!token) return null;
  await ensurePlayerSessionsTable();
  const rows = await db().sql`
    SELECT person_id, email, phone, account_id, auth_user_id, portal_player_id,
           sandbox_actor_auth_user, expires_at
    FROM player_sessions
    WHERE token_hash = ${hashToken(token)}
  `;
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await destroyPlayerSession(token);
    return null;
  }
  // Revoking portal access has to end the session that access created, not
  // wait for it to expire up to 30 days later.
  const portalPlayerId = cleanString(row.portal_player_id, "", 80);
  if (portalPlayerId) {
    const portalPlayer = await readPortalPlayerById(portalPlayerId);
    if (!portalPlayer || portalPlayer.status === "disabled") {
      await destroyPlayerSession(token);
      return null;
    }
  }
  return {
    personId: row.person_id || "",
    email: row.email || "",
    phone: row.phone || "",
    accountId: row.account_id || "",
    authUserId: cleanString(row.auth_user_id, "", 80),
    portalPlayerId,
    sandboxActorAuthUser: cleanString(row.sandbox_actor_auth_user, "", 80),
    expiresAt: row.expires_at,
  };
}

async function destroyPlayerSession(token) {
  if (!token) return;
  await ensurePlayerSessionsTable();
  await db().sql`DELETE FROM player_sessions WHERE token_hash = ${hashToken(token)}`;
}

async function destroyPortalPlayerSessions(portalPlayerId) {
  if (!portalPlayerId) return;
  await ensurePlayerSessionsTable();
  await db().sql`DELETE FROM player_sessions WHERE portal_player_id = ${portalPlayerId}`;
}

/**
 * The portal half of a login, for an auth user whose password /api/auth/login
 * has already checked.
 *
 * The password check is deliberately NOT in here. Coach and player share one
 * auth store, so there is exactly one password to verify and no way to tell
 * the two apart by verifying it twice -- this used to re-run the same Supabase
 * password grant the caller had just run, on an identity it had already
 * confirmed. What makes someone a player is the portal_players row, and that
 * is what this looks for.
 *
 * Returns null when the auth user has no active portal access for this
 * account, so the caller cannot use the login response to probe who has one.
 */
async function portalPlayerSessionIdentity(authUserId, rawEmail, accountId) {
  const email = cleanEmail(rawEmail, "");
  if (!authUserId || !accountId) return null;

  const portalPlayer = await readPortalPlayerByAuthUser(authUserId, accountId);
  if (!portalPlayer || portalPlayer.status === "disabled") return null;

  const contact = await portalPlayerContact(portalPlayer);
  await db().sql`
    UPDATE portal_players
    SET status = 'active',
        activated_at = COALESCE(activated_at, NOW()),
        last_login_at = NOW(),
        invite_token_hash = NULL,
        invite_expires_at = NULL,
        updated_at = NOW()
    WHERE id = ${portalPlayer.id}
  `;

  return {
    accountId,
    personId: contact.personId,
    email: contact.email || email,
    phone: contact.phone,
    name: contact.name,
    authUserId,
    portalPlayerId: portalPlayer.id,
  };
}

/** Mints a player session and answers with it. */
async function playerSessionResponse(player, req) {
  const session = await createPlayerSession(player);
  return json(
    {
      authenticated: true,
      role: "player",
      email: player.email,
      name: player.name,
      expiresAt: session.expiresAt,
      // Only to a client that has said it cannot hold the cookie. The cookie is
      // still set either way, so the web is unchanged.
      ...(wantsTokenAuth(req) ? { token: session.token } : {}),
    },
    200,
    {
      "Set-Cookie": playerCookieHeader(
        session.token,
        req,
        playerSessionDays * 24 * 60 * 60,
      ),
    },
  );
}

// --- Portal invites --------------------------------------------------------
//
// The set-password link is this app's own token, not a Supabase invite link.
// Supabase's link redirects through GoTrue and hands the browser a Supabase
// session, which is exactly what this design avoids. Issuing our own token
// keeps the flow the same shape as the existing admin password reset, and
// means "resend invite" and player "forgot password" are one code path: both
// issue a portal_players token, both land on /api/portal/set-password, and the
// only difference is how long the token lives and what the email says.

function portalInviteUrl(req, token, variant = "invite") {
  const origin = env("CLARITY_APP_URL", new URL(req.url).origin).replace(/\/$/, "");
  const url = new URL(origin || new URL(req.url).origin);
  url.searchParams.set("portalInvite", token);
  // Wording only -- the token and the route behind it are identical either way.
  // Without it a reset link introduces itself as an invitation from a coach the
  // player has been with for a year.
  if (variant === "reset") url.searchParams.set("portalReset", "1");
  return url.toString();
}

async function issuePortalInvite(portalPlayerId, variant = "invite") {
  const token = randomBytes(32).toString("base64url");
  const isReset = variant === "reset";
  const expiresAt = new Date(
    Date.now() +
      (isReset ? portalResetMinutes * 60 * 1000 : portalInviteDays * 24 * 60 * 60 * 1000),
  ).toISOString();
  await db().sql`
    UPDATE portal_players
    SET invite_token_hash = ${hashToken(token)},
        invite_expires_at = ${expiresAt},
        -- A reset is not a new invitation. Stamping invited_at would lose the
        -- date the coach actually granted access, which is what Player Profiles
        -- reports back to them.
        invited_at = CASE WHEN ${isReset}::boolean THEN invited_at ELSE NOW() END,
        updated_at = NOW()
    WHERE id = ${portalPlayerId}
  `;
  return { token, expiresAt };
}

/**
 * One portal email, three axes. The Caddy version adds a line and a second
 * link and says the same login works for both; the reset version drops the
 * welcome and says the player asked for this. Keeping them one template stops
 * this becoming a second communications system.
 *
 * Pure and exported so the copy can be checked without a database or an email
 * provider -- in particular that a reset never claims the coach set up an
 * account, and never offers a Caddy pass it did not issue.
 */
export function portalInviteEmailContent({
  businessName,
  coachName,
  name,
  linkUrl,
  caddyUrl,
  withCaddyPass = false,
  variant = "invite",
}) {
  const isReset = variant === "reset";
  const greeting = name ? `Hi ${escapeHtml(String(name).split(/\s+/)[0])},` : "Hi,";
  const heading = isReset ? "Reset your password" : "Welcome to the Clarity Player Portal";
  const opening = isReset
    ? `Someone asked to reset the password for your ${businessName} player portal.`
    : `${coachName} has set up a player portal account for you. Set a password to see your lessons, your lesson notes and your videos, and to book your next session.`;
  const buttonLabel = isReset ? "Choose a new password" : "Set your password";
  // A pass is only ever issued alongside a fresh invite, so a reset says
  // nothing about Caddy even if the flag were somehow passed.
  const mentionCaddy = withCaddyPass && !isReset;
  const expiry = isReset
    ? `This link expires in ${portalResetMinutes} minutes.`
    : `This link expires in ${portalInviteDays} days.`;
  // The line that matters on a reset nobody asked for. An invite has no
  // equivalent: ignoring it is already the whole remedy.
  const ignoreLine = isReset
    ? "If you did not ask for this, ignore this email. Your password will not change."
    : "";

  const subject = isReset
    ? `Reset your ${businessName} player portal password`
    : mentionCaddy
      ? `Your ${businessName} player portal and Clarity Caddy pass`
      : `Your ${businessName} player portal`;

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111">
      <h2>${escapeHtml(heading)}</h2>
      <p>${greeting}</p>
      <p>${escapeHtml(opening)}</p>
      ${mentionCaddy ? `<p><strong>You also have a Clarity Caddy pass.</strong> The same login works for both.</p>` : ""}
      <p><a href="${escapeHtml(linkUrl)}" style="display:inline-block;background:#07100a;color:#fff;padding:12px 16px;text-decoration:none;border-radius:6px">${escapeHtml(buttonLabel)}</a></p>
      <p>If the button does not work, paste this link into your browser:</p>
      <p><a href="${escapeHtml(linkUrl)}">${escapeHtml(linkUrl)}</a></p>
      ${mentionCaddy ? `<p>Clarity Caddy: <a href="${escapeHtml(caddyUrl)}">${escapeHtml(caddyUrl)}</a></p>` : ""}
      <p>${escapeHtml(expiry)}</p>
      ${ignoreLine ? `<p>${escapeHtml(ignoreLine)}</p>` : ""}
    </div>
  `;
  const text = [
    heading,
    "",
    opening,
    mentionCaddy ? "You also have a Clarity Caddy pass. The same login works for both." : "",
    "",
    isReset ? "Choose a new password:" : "Set a password to see your lessons, lesson notes and videos, and to book your next session:",
    linkUrl,
    mentionCaddy ? `\nClarity Caddy: ${caddyUrl}` : "",
    "",
    expiry,
    ignoreLine,
  ]
    .filter((line) => line !== "")
    .join("\n");

  return { subject, html, text };
}

async function sendPortalInviteEmail({ accountId, req, email, name, token, withCaddyPass, variant = "invite" }) {
  const account = await readCoachAccount(accountId);
  const businessName = account.businessName || "Clarity Golf";
  const { subject, html, text } = portalInviteEmailContent({
    businessName,
    coachName: account.coachName || businessName,
    name: cleanString(name, "", 180),
    linkUrl: portalInviteUrl(req, token, variant),
    caddyUrl: caddyAppUrl(),
    withCaddyPass,
    variant,
  });

  return deliverEmail({
    accountId,
    to: email,
    subject,
    html,
    text,
    idempotencyKey: `portal-${variant}-${hashToken(token).slice(0, 24)}`,
  });
}

/**
 * Promotes a person to a portal player: links (or creates) their Supabase Auth
 * user, records the grant, and issues the set-password invite. Re-running it
 * for someone who already has access just re-issues the invite, which is what
 * "resend invite" needs.
 */
async function grantPortalAccess({ req, personId, accountId, includeCaddyPass = false }) {
  await ensurePlayerSessionsTable();
  // Portal access is access to one business's videos and lessons, so the
  // business has to be the caller's, not a default.
  const cleanAccountId = cleanSlug(accountId, "");
  if (!cleanAccountId) throw missingAccountScope("grant_portal_access");
  const cleanPersonId = cleanString(personId, "", 160);
  if (!cleanPersonId) {
    throw Object.assign(new Error("A player is required."), { status: 400 });
  }

  const people = await readPeople(cleanAccountId);
  const person = people.find((candidate) => candidate.id === cleanPersonId);
  if (!person) {
    throw Object.assign(new Error("That player is not in this account."), { status: 404 });
  }
  const email = cleanEmail(person.email, "");
  if (!email) {
    throw Object.assign(
      new Error("Add an email address to this player before giving them portal access."),
      { status: 400 },
    );
  }

  const { authUserId } = await ensureSupabaseAuthUser(email);
  const existingRows = await db().sql`
    SELECT * FROM portal_players
    WHERE account_id = ${cleanAccountId} AND person_id = ${cleanPersonId}
    LIMIT 1
  `;
  const existing = rowToPortalPlayer(existingRows[0]);

  let portalPlayerId = existing?.id || "";
  if (existing) {
    portalPlayerId = existing.id;
    await db().sql`
      UPDATE portal_players
      SET auth_user_id = ${authUserId},
          email = ${email},
          status = CASE WHEN status = 'disabled' THEN 'invited' ELSE status END,
          updated_at = NOW()
      WHERE id = ${portalPlayerId}
    `;
  } else {
    portalPlayerId = randomUUID();
    await db().sql`
      INSERT INTO portal_players (id, account_id, person_id, auth_user_id, email, status, invited_at, created_at, updated_at)
      VALUES (${portalPlayerId}, ${cleanAccountId}, ${cleanPersonId}, ${authUserId}, ${email}, 'invited', NOW(), NOW(), NOW())
    `;
  }

  // --- Clarity Caddy ------------------------------------------------------
  //
  // Booking administers the coaching relationship, so it makes sure the
  // relationship exists in Caddy too. That is idempotent and additive: it never
  // takes the player away from another coach.
  //
  // A pass is separate and optional. Having a Clarity login does not mean
  // having paid Caddy access, and Booking does not own that decision -- it just
  // asks Caddy to issue one when the coach ticks the box.
  //
  // Neither step may fail the portal invite. The player still gets their
  // portal; the coach gets told what did not happen.
  const caddy = { attempted: false, linked: false, passIssued: false, error: "" };
  if (caddyConfigured()) {
    caddy.attempted = true;
    try {
      const link = await ensureCoachPlayerRelationship(authUserId, email);
      caddy.linked = Boolean(link?.linked);
    } catch (error) {
      caddy.error =
        error instanceof Error ? error.message : "Could not reach Clarity Caddy.";
    }
    if (includeCaddyPass && !caddy.error) {
      try {
        await issueCaddyPass({
          playerAuthUserId: authUserId,
          playerEmail: email,
          issuedBy: cleanString((await readCoachAccount(cleanAccountId)).coachName, "clarity_booking", 160),
        });
        caddy.passIssued = true;
      } catch (error) {
        caddy.error =
          error instanceof Error ? error.message : "Could not issue the Clarity Caddy pass.";
      }
    }
  } else if (includeCaddyPass) {
    caddy.error = "Clarity Caddy is not configured for this deployment.";
  }

  const invite = await issuePortalInvite(portalPlayerId);
  const emailResult = await sendPortalInviteEmail({
    accountId: cleanAccountId,
    req,
    email,
    name: cleanString(person.name, "", 180),
    token: invite.token,
    // Only promise a pass in the email if one was actually issued.
    withCaddyPass: caddy.passIssued,
  });

  const portalPlayer = await readPortalPlayerById(portalPlayerId);
  return {
    portalPlayer,
    caddy,
    inviteSent: Boolean(emailResult?.sent),
    inviteReason: emailResult?.sent ? "" : cleanString(emailResult?.reason, "", 80),
    // Returned so the coach can hand the link over directly when email is not
    // configured or bounces. It is single-use and time limited.
    inviteUrl: emailResult?.sent ? "" : portalInviteUrl(req, invite.token),
  };
}

/**
 * The player half of "forgot password".
 *
 * Deliberately the invite machinery with a different label on it: same token
 * column, same expiry column, same /api/portal/set-password route at the other
 * end. Nothing here creates access -- a person who was never given a portal
 * gets nothing, because a reset is not a way in.
 *
 * Returns null when there is no portal player for that address, so the caller
 * can answer identically either way.
 */
async function issuePortalPasswordReset({ req, email, accountId }) {
  const portalPlayer = await readPortalPlayerByEmail(email, accountId);
  if (!portalPlayer) return null;
  // Pre-dates the auth link, or the row was written before ensureSupabaseAuthUser
  // ran. There is no credential to reset, so this is the coach's to fix by
  // re-granting access rather than something to paper over with a dead link.
  if (!portalPlayer.authUserId) {
    console.warn("portal_players:reset_without_auth_user", portalPlayer.id);
    return null;
  }

  const reset = await issuePortalInvite(portalPlayer.id, "reset");
  const contact = await portalPlayerContact(portalPlayer);
  const emailResult = await sendPortalInviteEmail({
    accountId: portalPlayer.accountId,
    req,
    email: portalPlayer.email,
    name: contact.name,
    token: reset.token,
    variant: "reset",
  });
  return { portalPlayer, sent: Boolean(emailResult?.sent), reason: cleanString(emailResult?.reason, "", 80) };
}

async function revokePortalAccess({ portalPlayerId, accountId }) {
  await ensurePlayerSessionsTable();
  const portalPlayer = await readPortalPlayerById(portalPlayerId);
  if (!portalPlayer || portalPlayer.accountId !== accountId) {
    throw Object.assign(new Error("That portal player was not found."), { status: 404 });
  }
  // The row is kept rather than deleted so the history of who had access
  // survives, and so re-granting reuses the same auth user.
  await db().sql`
    UPDATE portal_players
    SET status = 'disabled', invite_token_hash = NULL, invite_expires_at = NULL, updated_at = NOW()
    WHERE id = ${portalPlayerId}
  `;
  await destroyPortalPlayerSessions(portalPlayerId);
  return readPortalPlayerById(portalPlayerId);
}

async function readPortalInvite(token) {
  if (!token) return null;
  await ensurePlayerSessionsTable();
  const rows = await db().sql`
    SELECT * FROM portal_players
    WHERE invite_token_hash = ${hashToken(token)}
    LIMIT 1
  `;
  const portalPlayer = rowToPortalPlayer(rows[0]);
  if (!portalPlayer) return null;
  const expiresAt = rows[0]?.invite_expires_at;
  if (!expiresAt || new Date(expiresAt).getTime() <= Date.now()) return null;
  if (portalPlayer.status === "disabled") return null;
  return portalPlayer;
}

/** Completes an invite: sets the real Supabase Auth password and clears the token. */
async function completePortalInvite(token, password) {
  const portalPlayer = await readPortalInvite(token);
  if (!portalPlayer) {
    return { error: "invalid_token" };
  }
  if (cleanString(password, "", 200).length < 10) {
    return { error: "weak_password" };
  }
  await setSupabaseAuthPassword(portalPlayer.authUserId, password);
  await db().sql`
    UPDATE portal_players
    SET status = 'active',
        activated_at = COALESCE(activated_at, NOW()),
        invite_token_hash = NULL,
        invite_expires_at = NULL,
        updated_at = NOW()
    WHERE id = ${portalPlayer.id}
  `;
  return { portalPlayer: await readPortalPlayerById(portalPlayer.id) };
}

function playerBase64(value) {
  try {
    return Buffer.from(String(value ?? ""), "utf8").toString("base64");
  } catch {
    return "";
  }
}

// Mirrors the client's profileIdsForClient (src/App.tsx): lesson notes are
// keyed by whatever id form a note was saved under -- a resolved people.id
// (which for legacy rows is itself often `email-<base64>`), the raw email, an
// `email-<base64>` derivation, or `phone-<canonical>`. Building the same
// candidate set here lets the player see every note that belongs to them
// regardless of which historical form its playerId took. Both padded and
// unpadded base64 are included because legacy people ids stored it unpadded.
function playerProfileIdCandidates({ personId, email, phone }, country = defaultPhoneCountry()) {
  const ids = new Set();
  const cleanId = cleanString(personId, "", 160).trim();
  const cleanEmailValue = cleanString(email, "", 180).trim().toLowerCase();
  const cleanPhone = normalizedPersonPhone(phone, country);
  if (cleanId) ids.add(cleanId);
  if (cleanEmailValue) {
    ids.add(cleanEmailValue);
    const encoded = playerBase64(cleanEmailValue);
    if (encoded) {
      ids.add(`email-${encoded}`);
      ids.add(`email-${encoded.replace(/=+$/, "")}`);
    }
  }
  if (cleanPhone) ids.add(`phone-${cleanPhone}`);
  return ids;
}

/* ---------------------------------------------------------------------------
 * Guest senders
 *
 * Someone with no account who wants their coach to see a swing video. They get
 * a token, and that token buys exactly two things: the right to upload a
 * bounded number of videos, and the right to ask whether a coach has added
 * them yet. It is deliberately NOT a player_sessions row with a null
 * portal_player_id -- readPlayerProfile below resolves bookings and lesson
 * notes from the session's email string, and readPlayerSession only checks
 * portal_player_id when one is set, so a guest row there would hand anyone who
 * typed someone else's address that person's real lessons. Separate table,
 * separate header, fail-closed: code that does not know guests exist cannot
 * authenticate one.
 * ------------------------------------------------------------------------- */

// Self-creating, like player_sessions above: a deploy that reaches production
// before the migration is applied by hand must not 500. The repo migration
// (database/migrations/20260821000100_create_guest_senders) is the
// schema record.
let guestSendersTableReady = false;
async function ensureGuestSendersTable() {
  if (guestSendersTableReady) return;
  const ddl = ddlBatch();
  ddl.sql`
    CREATE TABLE IF NOT EXISTS guest_senders (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      source_device_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      claimed_person_id TEXT,
      claimed_portal_player_id TEXT,
      claimed_at TIMESTAMPTZ
    )
  `;
  ddl.sql`CREATE INDEX IF NOT EXISTS guest_senders_token_idx ON guest_senders (token_hash)`;
  ddl.sql`
    CREATE INDEX IF NOT EXISTS guest_senders_account_created_idx
    ON guest_senders (account_id, created_at DESC)
  `;
  await ddl.run(db().pool);
  guestSendersTableReady = true;
}

/**
 * Its own header, never Authorization. A guest credential must not be
 * presentable anywhere a player bearer token is read.
 */
function guestTokenFromRequest(req) {
  return cleanString(req.headers.get("x-clarity-guest-token"), "", 400);
}

async function readGuestSender(token) {
  if (!token) return null;
  await ensureGuestSendersTable();
  const rows = await db().sql`
    SELECT * FROM guest_senders WHERE token_hash = ${hashToken(token)} LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  // Best effort -- a failed touch must never fail the caller.
  try {
    await db().sql`UPDATE guest_senders SET last_seen_at = NOW() WHERE id = ${row.id}`;
  } catch {
    // Ignore.
  }
  return {
    id: row.id,
    accountId: row.account_id || "",
    name: row.name || "",
    email: (row.email || "").toLowerCase(),
    claimedPersonId: row.claimed_person_id || "",
    claimedPortalPlayerId: row.claimed_portal_player_id || "",
    claimedAt: row.claimed_at || "",
  };
}

async function countGuestRegistrationsToday(accountId) {
  const rows = await db().sql`
    SELECT COUNT(*)::int AS count FROM guest_senders
    WHERE account_id = ${accountId}
      AND created_at > NOW() - INTERVAL '24 hours'
  `;
  return Number(rows[0]?.count || 0);
}

/**
 * Deliberately no de-dupe by email. Deduping would hand an existing guest's
 * row, their remaining quota and their pending videos to anyone who retyped
 * that address -- and people genuinely do share an inbox (see
 * 20260714000200_allow_shared_client_emails). Every registration is a new row.
 *
 * Also deliberately sends no email. Mailing the address someone just typed is
 * what turns a feature like this into an open spam relay.
 */
async function createGuestSender({ name, email, deviceId, accountId }) {
  await ensureGuestSendersTable();
  const token = randomBytes(32).toString("base64url");
  const id = randomUUID();
  await db().sql`
    INSERT INTO guest_senders (id, account_id, token_hash, name, email, source_device_id)
    VALUES (
      ${id},
      ${accountId},
      ${hashToken(token)},
      ${name},
      ${email},
      ${deviceId || null}
    )
  `;
  return { id, token, name, email, accountId };
}

/** How many videos this guest has already sent. Never throws. */
async function countGuestSubmissions(guestSenderId) {
  if (!guestSenderId) return 0;
  try {
    const rows = await db().sql`
      SELECT COUNT(*)::int AS count FROM video_transfer_sessions
      WHERE guest_sender_id = ${guestSenderId}
        AND direction = 'guest-submission'
        AND status NOT IN ('cancelled', 'failed', 'expired')
    `;
    return Number(rows[0]?.count || 0);
  } catch {
    return 0;
  }
}

/**
 * What the app polls to find out whether the coach has acted. Reads
 * guest_senders and portal_players and nothing else -- it must never touch
 * readPlayerProfile, readPeople or readLessonNotes, because every one of those
 * resolves by email string and that is exactly the fail-open this whole design
 * exists to avoid.
 */
async function readGuestStatus(guest) {
  const portalPlayer = guest.claimedPortalPlayerId
    ? await readPortalPlayerById(guest.claimedPortalPlayerId)
    : null;
  const guestAccountId = cleanSlug(guest?.accountId, "");
  if (!guestAccountId) throw missingAccountScope("guest_status");
  const coachAccount = await readCoachAccount(guestAccountId);
  return {
    ok: true,
    connected: Boolean(guest.claimedAt),
    inviteSent: Boolean(portalPlayer && portalPlayer.status !== "disabled"),
    coachName: coachAccount?.coachName || coachAccount?.businessName || "Your coach",
    retentionDays: guestRetentionDays,
    sent: {
      count: await countGuestSubmissions(guest.id),
      limit: guestSubmissionsLifetime,
    },
  };
}

/**
 * The coach has added this guest as a player. Re-point their submissions at the
 * real person and stop the clock: a claimed video is no longer ephemeral.
 *
 * player_id moving from `guest-<id>` to the real person id is the whole
 * integration -- importSummaryFromManifest reads it off the row, so on the
 * coach's next catalogue refresh the video stops being an orphan and appears
 * inside that player's profile with no new UI.
 *
 * direction stays 'guest-submission': it is a true record of how the video
 * arrived, and rewriting it would erase the audit trail.
 */
async function claimGuestSubmissions({ guestSenderId, personId, portalPlayerId, accountId }) {
  await ensureGuestSendersTable();
  await db().sql`
    UPDATE guest_senders
    SET claimed_person_id = ${personId},
        claimed_portal_player_id = ${portalPlayerId || null},
        claimed_at = COALESCE(claimed_at, NOW())
    WHERE id = ${guestSenderId} AND account_id = ${accountId}
  `;
  try {
    const rows = await db().sql`
      UPDATE video_transfer_sessions
      SET player_id = ${personId},
          submitted_by_portal_player_id = ${portalPlayerId || null},
          claimed_at = COALESCE(claimed_at, NOW()),
          cleanup_after = NULL,
          cleanup_status = 'not_scheduled',
          updated_at = NOW()
      WHERE guest_sender_id = ${guestSenderId}
        AND account_id = ${accountId}
        AND direction = 'guest-submission'
      RETURNING transfer_id
    `;
    return rows.length;
  } catch {
    // The person and their portal invite are already real; a failure to
    // re-point old videos must not undo that. They stay under the guest badge
    // with the same action available.
    return 0;
  }
}

/** The account's billing currency, for the portal's price labels. Parsed from
 *  the same settings blob the invoice editor writes, so a coach changes it in
 *  one place and the shop follows. */
function playerShopCurrency(settingsMap: Record<string, string>) {
  const invoiceSettings = safeJsonParse(settingsMap.accountInvoiceSettingsJson, {});
  return currencyForAccountSettings(invoiceSettings?.currency, settingsMap.accountCountry);
}

async function readPlayerProfile(session) {
  const accountId = cleanSlug(session?.accountId, "");
  if (!accountId) throw missingAccountScope("player_profile");
  const state = await readPublicCatalogState(accountId);
  const workspaceAccount = publicWorkspaceAccount(state);
  const serviceList = (state.services || []).filter((service) =>
    recordBelongsToAccount(service, workspaceAccount.id),
  );

  const itemRead = await readPublicAppointmentsForContact({
    accountId,
    email: session.email,
    phone: session.phone,
  });
  const bookings = itemRead.items
    .sort((a, b) => itemWeek(a) - itemWeek(b) || a.day - b.day || a.start - b.start)
    .map((item) => publicRescheduleItem(item, serviceList));

  const candidates = playerProfileIdCandidates(session);
  const notes = (await readLessonNotes(accountId))
    .filter((note) => note.playerId && candidates.has(note.playerId))
    .map((note) => ({
      id: note.id,
      title: note.title,
      body: note.body,
      playerName: note.playerName,
      // The note's sitting, and the only thing tying a swing review together
      // -- the portal groups on it. Dropping it here is what made a review
      // arrive as loose notes; it grants no access the note itself doesn't,
      // because the player is already being handed the note.
      lessonId: note.lessonId,
      // Which booking it was taken against, when it was taken against one.
      // The portal's booking history matches on this rather than on the day,
      // so a note never appears under the wrong lesson.
      calendarItemId: note.calendarItemId,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    }));

  // Prescribed practice. Filed against the same player id candidates as the
  // notes above, so a player who exists under more than one historical id
  // still sees everything filed under any of them.
  const practice = await readPracticeBlocksForCandidates(accountId, candidates);
  // The player's wall is the coach's wall, so it needs the same names and
  // colours. Empty means the workspace never edited them and the portal falls
  // back to the same defaults the coach's app does.
  const practiceBlockTypes = await readPracticeBlockTypes(accountId);

  // Surface display name + original-formatted phone (from the matched
  // appointment) so the client can pre-fill the booking form on hand-off
  // without ever re-asking the player for their details.
  const primary = itemRead.items[0];

  // The business's own booking widget, if it runs one somewhere else. Read
  // straight from settings rather than off `state`: readPublicCatalogState is
  // the shape the *public* booking page gets, and this belongs to a signed-in
  // player's portal, not to it.
  const settingsMap = await readSettingsMap(accountId);
  const bookingEmbed = playerBookingEmbedForPortal(settingsMap);

  /* The shop, and whether it can take a card.
   *
   * Read off the same settings map as the booking embed rather than with a
   * second query: a cold instance pays roughly 217ms per database round trip,
   * and this is the landing screen.
   *
   * `configured` is the account's own answer, not the platform's -- a business
   * with its own Stripe key can sell whether or not Clarity has one, and one
   * relying on the platform's cannot sell if it is missing. Nothing about
   * which key is in play reaches the player; they are buying from the coach
   * either way.
   */
  /* What they have already paid for.
   *
   * Keyed on the resolved person id alone, not the candidate set the notes use
   * above: a pass is written against a real people.id by whatever took the
   * money, so there are no historical id forms to chase. No person id means no
   * passes rather than an unfiltered read.
   *
   * playerPassViews, not the coach's PassView: see the allow-list in
   * passes.mts. Service names are resolved here because this is where the
   * catalogue already is -- the player has no way to look an id up.
   */
  // Read once and used twice -- for the player's own pass list and for what
  // may pay for a review. readPassesForPerson sweeps returnable credits before
  // answering, so calling it twice is two writes and two reads on the landing
  // screen, at roughly 217ms per round trip on a cold instance.
  const heldPasses = session.personId
    ? await readPassesForPerson(accountId, session.personId)
    : [];
  const passes = playerPassViews(
    heldPasses,
    new Map(serviceList.map((service) => [service.id, service.name])),
  );

  const stripeStatus = stripeCredentialStatus(settingsMap[STRIPE_SECRET_SETTING]);
  const currency = playerShopCurrency(settingsMap);
  const flexibleValueCents = session.personId
    ? await readFlexibleValueForPerson(accountId, session.personId, currency)
    : 0;
  const shop = stripeStatus.configured ? playerShopItems(serviceList, currency) : [];

  /* Everything the New Swing Review screen needs to decide what it can offer.
   *
   * Which passes may pay for a review is worked out here rather than in the
   * browser, for the same reason the checkout is priced here: the portal
   * should be asking "what may I do", not deciding it. It also keeps the
   * player's pass view free of catalogue ids -- the portal never has to match
   * a coverage list against a service id to know whether a credit fits.
   */
  const reviewService = findReviewService(serviceList);
  const review = reviewService
    ? {
        serviceId: reviewService.id,
        name: reviewService.name,
        price: reviewService.price,
        currency,
        turnaroundDays: reviewService.turnaroundDays,
        /** Empty means they must buy one -- or that the coach sells none. */
        passOptions: passOptionsForService(heldPasses, reviewService.id, reviewService.name, {
          serviceValueCents: Math.max(0, Math.round(Number(reviewService.price || 0) * 100)),
          currency,
          acceptsCrossRedemption: reviewService.acceptsCrossRedemption !== false,
          flexibleValueCents,
        })
          .filter((option) => option.covered)
          .map((option) => ({
            passId: option.passId,
            name: option.paymentKind === "cross_redemption" ? "Clarity balance" : option.name,
            creditsAvailable: option.creditsAvailable,
            expiresAt: option.nextExpiry || option.expiresAt,
          })),
        /** False when the business cannot take a card, so the screen offers a
         *  credit or nothing rather than a button that cannot charge. */
        canBuy: stripeStatus.configured && reviewService.price > 0,
      }
    : null;

  return {
    player: {
      // The person id matters to the portal: videos recorded there are filed
      // under it, which is what makes them line up with this player's profile
      // on the coach side.
      id: session.personId || "",
      email: session.email,
      name: primary?.client || primary?.title || "",
      phone: primary?.phone || session.phone || "",
    },
    bookings,
    notes,
    practice,
    practiceBlockTypes,
    passes,
    flexibleValueCents,
    passCurrency: currency,
    shop,
    review,
    bookingEmbed,
  };
}

async function readBackendSettings(accountId: string) {
  // Who is asking and what they may do: settings only. The calendar itself
  // is read by the routes that answer with bookings, not by every route.
  return readSettingsState(accountId);
}

/**
 * A workspace-account shell for a business that has no workspaceAccountsJson
 * entry yet -- a newly provisioned account, or one whose blob predates the
 * account. Everything comes from the account's own scoped settings; nothing is
 * inherited from the original workspace.
 */
function neutralWorkspaceAccount(accountId, settings = {}) {
  const account = settings.account || null;
  const name =
    cleanString(account?.businessName, "", 120) ||
    cleanString(settingValue(settings, "accountBusinessName"), "", 120) ||
    accountId;
  return {
    id: accountId,
    name,
    slug: accountId,
    // "solo" because it is a plan the catalogue actually defines --
    // accountEntitlements() silently falls back to solo for an unknown key, so
    // naming a plan that does not exist just hides the decision.
    planKey: "solo",
    subscriptionStatus: "trialing",
    billingProvider: "none",
    active: true,
  };
}

/**
 * The workspace account behind a public booking page.
 *
 * Public state is read for one explicitly resolved business (see
 * resolvePublicAccountId), and carries that id on the state object. This reads
 * it back rather than picking "the default workspace" out of the settings blob,
 * which is what made every public page resolve to the original business.
 */
function publicWorkspaceAccount(state = {}) {
  const accountId = cleanSlug(state?.accountId || state?.account?.id, "");
  if (!accountId) {
    throw Object.assign(new Error("This booking page is not available."), {
      status: 404,
      code: "unknown_business",
    });
  }
  return workspaceAccountForId(accountId, state);
}

/**
 * Create this business's sandbox, or hand back the one it already has.
 *
 * A sandbox is an ordinary account, so creating one is the ordinary account
 * creation path: insert the row, then seedSettings() gives it the same 45
 * defaults any new business gets -- its own services, location, availability and
 * coach profile, and none of the live account's data. That is asserted by
 * tenant-boundary.test.mts for a new business and is true here for the same
 * reason.
 *
 * Idempotent twice over: ON CONFLICT DO NOTHING on the id, and a unique index on
 * sandbox_of_account_id. A second call returns the first sandbox rather than
 * making another.
 */
async function ensureSandboxForAccount(liveAccountId: string) {
  const parentId = cleanSlug(liveAccountId, "");
  if (!parentId) throw missingAccountScope("ensure_sandbox");

  const existing = await readSandboxForAccount(parentId);
  if (existing) return existing;

  const sandboxId = sandboxAccountIdFor(parentId);
  const parentSettings = await readSettingsMap(parentId);
  const parentName =
    cleanString(settingValue(parentSettings, "accountBusinessName"), "", 120) || parentId;
  const sandboxName = `${parentName} (Sandbox)`;

  await db().sql`
    INSERT INTO accounts (id, slug, business_name, status, kind, sandbox_of_account_id)
    VALUES (${sandboxId}, ${sandboxId}, ${sandboxName}, 'active', 'sandbox', ${parentId})
    ON CONFLICT (id) DO NOTHING
  `;

  await seedSettings(sandboxId);

  // The plan the sandbox runs on is a copy of the live one, so entitlement
  // checks run for real rather than being bypassed. subscriptionStatus is
  // 'internal' -- an existing status isAccountActive() already accepts -- so the
  // sandbox is entitled without being billed. The coach can change the plan
  // afterwards to see what a smaller one feels like.
  const parentWorkspace = parseSettingJson(parentSettings, "workspaceAccountsJson", []);
  const parentEntry = Array.isArray(parentWorkspace)
    ? parentWorkspace.find((entry) => entry?.id === parentId)
    : null;
  const planKey = accountPlanCatalog[parentEntry?.planKey] ? parentEntry.planKey : "solo";

  await setSettingsBulk(sandboxId, {
    accountId: sandboxId,
    accountBusinessName: sandboxName,
    // Start where the live business is, so the first thing a tester sees is
    // their own configuration rather than a default one. All of it is editable.
    accountCountry: settingValue(parentSettings, "accountCountry"),
    accountTimezone: settingValue(parentSettings, "accountTimezone"),
    accountCurrency: settingValue(parentSettings, "accountCurrency"),
    workspaceAccountsJson: JSON.stringify([
      {
        id: sandboxId,
        name: sandboxName,
        slug: sandboxId,
        planKey,
        subscriptionStatus: "internal",
        billingProvider: "none",
        active: true,
      },
    ]),
  });

  // Two players, because "create a player" is not the workflow anyone opens the
  // sandbox to test -- everything downstream of having one is. Bookings, passes
  // and invoices are made through the real UI, which is the point.
  await db().sql`
    INSERT INTO people (id, account_id, name, email, phone, source, created_at, updated_at)
    VALUES
      (${`${sandboxId}-player-alex`}, ${sandboxId}, 'Alex Demo', ${`alex@${sandboxId}.test`}, '', 'sandbox_seed', NOW(), NOW()),
      (${`${sandboxId}-player-sam`}, ${sandboxId}, 'Sam Demo', ${`sam@${sandboxId}.test`}, '', 'sandbox_seed', NOW(), NOW())
    ON CONFLICT (id) DO NOTHING
  `;

  const created = await readSandboxForAccount(parentId);
  if (!created) throw new Error("The sandbox workspace could not be created.");
  return created;
}

/** The plan a sandbox is currently running on. */
async function sandboxPlanKey(sandboxId: string): Promise<string> {
  const settings = await readSettingsMap(sandboxId);
  const entries = parseSettingJson(settings, "workspaceAccountsJson", []);
  const entry = Array.isArray(entries) ? entries.find((row) => row?.id === sandboxId) : null;
  return accountPlanCatalog[entry?.planKey] ? entry.planKey : "solo";
}

/**
 * Change the plan a sandbox runs on.
 *
 * Writes the same workspaceAccountsJson entry a live account carries, so
 * accountEntitlements() reads it through the ordinary path and every
 * assertAccountFeature/assertAccountLimit in the app starts enforcing the new
 * plan immediately. Nothing is bypassed and no data is removed: dropping to a
 * smaller plan leaves anything already over the limit in place and refuses the
 * next one, which is exactly what a real coach who downgrades experiences.
 */
async function setSandboxPlanKey(sandboxId: string, sandboxName: string, planKey: string) {
  await setSettingsBulk(sandboxId, {
    workspaceAccountsJson: JSON.stringify([
      {
        id: sandboxId,
        name: sandboxName,
        slug: sandboxId,
        planKey,
        subscriptionStatus: "internal",
        billingProvider: "none",
        active: true,
      },
    ]),
  });
}

// One actor resolution per request, shared by every read on that request.
//
// requireCoachActor() costs a session lookup plus a membership lookup. A single
// route can need the account id in half a dozen places (state read, settings
// read, people read, the permission check), and resolving it once per call
// would multiply the round trips. The cache is keyed on the Request object, so
// it cannot leak between requests: the key becomes unreachable when the request
// ends.
const requestActorCache = new WeakMap<Request, Promise<CoachActor>>();

function currentActor(req: Request): Promise<CoachActor> {
  const cached = requestActorCache.get(req);
  if (cached) return cached;
  const pending = requireCoachActor(req);
  requestActorCache.set(req, pending);
  return pending;
}

/**
 * The authoritative account id for this request.
 *
 * Derived only from the authenticated Supabase identity plus an active
 * account_memberships row. Never from the body, the query string, a cookie
 * other than the session, or workspaceAccountsJson. Throws 401 when there is
 * no session and 403 when the session has no membership -- it never falls back
 * to the original workspace.
 */
async function currentAccountId(req: Request): Promise<string> {
  return (await currentActor(req)).accountId;
}

const requestPublicAccountCache = new WeakMap<Request, Promise<string>>();

function unknownBusiness() {
  return Object.assign(new Error("This booking page is not available."), {
    status: 404,
    code: "unknown_business",
  });
}

/**
 * The account behind a public request.
 *
 * Public routes have no session to resolve, so the business has to come from a
 * stable public identifier -- ?business=<slug> (also accepted as ?account= or
 * ?slug=) -- validated against the accounts table. An unknown slug is a 404.
 *
 * When no slug is supplied and the deployment holds exactly one active
 * business, that business is the answer: there is nothing to disambiguate.
 * With two or more it is a 404 rather than a guess, because guessing is how
 * every public page ended up resolving to the original workspace. Existing
 * single-business links therefore keep working, and the moment a second
 * business exists the public URLs have to name which one they mean.
 */
/**
 * Every active business, for the scheduled jobs.
 *
 * Reminders and the admin-notification debounce used to run once against "the"
 * settings and "the" calendar. With more than one business that would have
 * reminded one coach's clients using another coach's templates, lead time and
 * timezone -- so these jobs iterate accounts instead.
 */
async function listActiveAccountIds(): Promise<string[]> {
  // Live businesses only. A sandbox would otherwise get real lesson reminders
  // on the real schedule, and until the sandbox outbox exists those would leave
  // Clarity and reach whatever address the test data happens to hold. Once
  // outbound email is captured per account, sandboxes can join this list and
  // reminders become testable.
  const rows = await db().sql<{ id: string }[]>`
    SELECT id FROM accounts
    WHERE status = 'active' AND kind = 'live'
    ORDER BY created_at ASC, id ASC
  `;
  return rows.map((row) => cleanSlug(row.id, "")).filter(Boolean);
}

async function resolvePublicAccountId(req: Request): Promise<string> {
  const cached = requestPublicAccountCache.get(req);
  if (cached) return cached;
  const pending = (async () => {
    const url = new URL(req.url);
    const slug = cleanSlug(
      url.searchParams.get("business") ||
        url.searchParams.get("account") ||
        url.searchParams.get("accountId") ||
        url.searchParams.get("slug") ||
        "",
      "",
    );
    if (slug) {
      const account = await resolvePublicAccount(slug);
      if (!account) throw unknownBusiness();
      return account.id;
    }
    // `kind = 'live'` is load-bearing, not tidiness. Creating a sandbox adds a
    // second active account, and without this filter that alone would make the
    // count ambiguous and 404 every existing public booking link that does not
    // name its business.
    const rows = await db().sql`
      SELECT id FROM accounts
      WHERE status = 'active' AND kind = 'live'
      ORDER BY created_at ASC, id ASC LIMIT 2
    `;
    if (rows.length === 1) return cleanSlug(rows[0].id, "");
    throw unknownBusiness();
  })();
  requestPublicAccountCache.set(req, pending);
  return pending;
}

/**
 * The workspace account for the request, resolved from the authenticated
 * actor rather than from whatever workspaceAccountsJson happens to hold.
 *
 * The JSON blob still supplies presentation and plan/entitlement detail for
 * the account, but it can no longer *choose* the account: the id comes from
 * the membership row and the blob is only searched for a matching entry.
 */
function workspaceAccountForId(accountId: string, settings: Record<string, unknown> = {}) {
  const accounts = Array.isArray((settings as { workspaceAccounts?: unknown[] }).workspaceAccounts)
    ? ((settings as { workspaceAccounts: Record<string, unknown>[] }).workspaceAccounts)
    : [];
  const matched = accounts.find((account) => account?.id === accountId);
  if (matched) return matched;
  // The account exists (the membership proved it) but has no entry in the
  // settings blob yet -- a brand new business, or one whose blob was never
  // written. Build a neutral shell rather than adopting another account's.
  return neutralWorkspaceAccount(accountId, settings);
}

/**
 * The app user for the authenticated actor.
 *
 * appUsersJson is presentation and per-user permission detail, not identity:
 * identity is the membership row. So this looks for the actor's own entry
 * inside the account's own settings blob and, failing that, builds a user from
 * the membership itself.
 *
 * What it deliberately does not do any more is fall through to "some other
 * admin on this account" or "the default admin". An authenticated user whose
 * mapping is missing used to be promoted into whichever workspace was loaded;
 * now they get exactly the permissions their membership role grants, in their
 * own account and no other.
 */
function appUserForActor(actor, settings = {}) {
  const users = Array.isArray(settings.appUsers)
    ? settings.appUsers
    : Array.isArray(settings.currentUser)
      ? settings.currentUser
      : [settings.currentUser].filter(Boolean);
  const matched = users.find(
    (user) =>
      user?.accountId === actor.accountId &&
      ((actor.coachId && user?.coachId === actor.coachId) || user?.authUserId === actor.authUserId),
  );
  if (matched) return { ...matched, accountId: actor.accountId, authUserId: actor.authUserId };
  return {
    id: actor.authUserId,
    authUserId: actor.authUserId,
    accountId: actor.accountId,
    name: cleanString(settingValue(settings, "accountCoachName"), "", 120) || "Coach",
    email: "",
    role: appUserRoleForMembership(actor.role),
    coachId: actor.coachId,
    active: true,
    permissions: actor.isAdmin
      ? { calendar: "all", people: "all", services: "all", billing: "all", settings: "all" }
      : { calendar: "own", people: "own" },
  };
}

function isAdminUser(user) {
  return ["admin", "account_admin", "platform_admin"].includes(user?.role) || Object.values(user?.permissions || {}).includes("all");
}

function userBelongsToAccount(user, accountId) {
  return userBelongsToAccountStrict(user, accountId);
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

/**
 * The authorization context for a private request.
 *
 * The account comes from the actor (Supabase identity -> membership row), not
 * from the settings blob and not from anything the client sent. `settings` is
 * only ever the already-scoped state for that same account; passing state read
 * for a different account would be a bug, so the id is re-derived here rather
 * than trusted from it.
 */
async function resolveBackendRequestContext(req, settings = null) {
  const actor = await currentActor(req);
  const resolvedSettings = settings || (await readBackendSettings(actor.accountId));
  const account = workspaceAccountForId(actor.accountId, resolvedSettings);
  const user = appUserForActor(actor, resolvedSettings);
  const context = {
    actor,
    authUserId: actor.authUserId,
    account,
    accountId: actor.accountId,
    user,
    userId: user?.id || actor.authUserId,
    coachId: actor.coachId || userCoachId(user),
    isAdmin: actor.isAdmin,
    isOwner: actor.isOwner,
    role: actor.role,
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

function isCancelledGroupSessionRecord(item, serviceId, session) {
  return (
    isCancelledGroupSessionLike(item) &&
    (item.serviceId || item.service_id) === serviceId &&
    itemWeek(item) === session.week &&
    Number(item.day) === session.day &&
    Number(item.start) === session.start
  );
}

// Scheduled group sessions are recurring service definitions, not stored calendar rows.
// They only become rows once someone books one, so conflict checks must synthesise a
// "hold" for every live occurrence — otherwise a private lesson can be booked on top of
// an empty group session.
function scheduledGroupSessionHolds(items = [], candidate, state = {}) {
  const services = state.services || defaultServices;
  const coaches = state.coaches || [];
  const locations = state.locations || [];
  const account = state.account || defaultCoachAccount();
  if (!Number.isInteger(candidate?.week)) return [];
  // Cancelled-session rows are stripped from some conflict item lists (they are status
  // "cancelled"), so callers can supply them separately to keep cancelled occurrences bookable.
  const cancellations = Array.isArray(state.cancelledGroupSessions) ? state.cancelledGroupSessions : items;
  const holds = [];
  for (const groupService of services) {
    if (!groupService?.active || groupService.archived === true) continue;
    if (!isScheduledGroupService(groupService)) continue;
    const schedule = groupService.groupSchedule;
    if (!schedule?.active) continue;
    const session = {
      week: candidate.week,
      day: schedule.dayOfWeek,
      start: schedule.startMinutes,
      duration: groupService.duration,
    };
    if (!isGroupServiceSlotMatch(groupService, session)) continue;
    if (!slotOverlaps(session, candidate)) continue;
    if (cancellations.some((item) => isCancelledGroupSessionRecord(item, groupService.id, session))) continue;
    const holdSeed = { serviceId: groupService.id };
    holds.push({
      ...session,
      id: `group-session-hold-${groupService.id}-${session.week}`,
      kind: "appointment",
      status: "booked",
      serviceId: groupService.id,
      coachId: resolvedCalendarItemCoachId(holdSeed, groupService, coaches, account),
      locationId: resolvedCalendarItemLocationId(holdSeed, groupService, locations, account),
      title: `${groupService.name} (group session)`,
      syntheticGroupSlot: true,
      readOnly: true,
    });
  }
  return holds;
}

function itemsWithGroupSessionHolds(items = [], candidate, service, state = {}) {
  const holds = scheduledGroupSessionHolds(items, candidate, state).filter((hold) => hold.serviceId !== service?.id);
  return holds.length ? [...items, ...holds] : items;
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
  const conflictItems = itemsWithGroupSessionHolds(items, candidate, service, state);
  const overlapping = conflictItems.filter((item) =>
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

function serviceHasBookingScreen(service) {
  // Legacy rows without the field are treated as visible on the main screen.
  if (!Array.isArray(service?.bookingScreenIds)) return true;
  return service.bookingScreenIds.length > 0;
}

export function publicBookableServices(services = []) {
  return services.filter(
    (service) =>
      service.active &&
      service.archived !== true &&
      service.visibility === "public" &&
      service.lessonFormat !== "package" &&
      serviceHasBookingScreen(service),
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
  const serviceLocation_ = serviceLocation(service, accountState.locations || [], accountState.account);
  const serviceLocationId = serviceLocation_.id;
  // Past times must never be offered to the public. Use the location's timezone
  // when it has one, otherwise the workspace timezone — the same precedence the
  // calendar invite (ctz) uses — so "now" is computed where the lesson happens.
  const slotTimeZone =
    cleanString(serviceLocation_?.timezone, "", 80) ||
    cleanString(accountState.account?.timezone, "", 80) ||
    defaultTimeZone();

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
    if (isSlotInPast(candidate.week, candidate.day, candidate.start, slotTimeZone)) return [];
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
          !isSlotInPast(week, day, start, slotTimeZone) &&
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
  const services = publicBookableServices(accountState.services);
  const totalPublicItemCount = accountState.items.length;
  if (metrics) {
    metrics.serviceId = serviceId;
    metrics.week = week;
    if (metrics.totalPublicItemCount == null) metrics.totalPublicItemCount = totalPublicItemCount;
  }
  const targetService = serviceId ? services.find((service) => service.id === serviceId) : null;
  if (serviceId && !targetService) {
    throw publicBookingSlotsRequestError("Choose a public lesson type.", 404);
  }
  const requestedWeekItems = publicSlotRequestedWeekItems(accountState.items, week);
  const cancelledGroupSessions = (accountState.items || []).filter(
    (item) => isCancelledGroupSessionLike(item) && itemWeek(item) === week,
  );
  const filteredAccountState = { ...accountState, items: requestedWeekItems, cancelledGroupSessions };
  if (metrics) {
    if (metrics.requestedWeekItemCount == null) metrics.requestedWeekItemCount = requestedWeekItems.length;
    if (metrics.relevantResourceItemCount == null) metrics.relevantResourceItemCount = requestedWeekItems.length;
  }
  const servicesById = {};
  const requestedServices = targetService ? [targetService] : services;
  for (const service of requestedServices) {
    // Restrict each calculation to resources that can collide with this
    // service, while reusing the one weekly database read above.
    const serviceState = {
      ...filteredAccountState,
      items: publicSlotRelevantResourceItems(requestedWeekItems, service, accountState),
    };
    // A review is bookable but has no times: its deadline is derived at
    // booking, not chosen from availability. Answering with the coach's open
    // hours would offer the player a choice that means nothing.
    const serviceSlots = isVideoReviewService(service)
      ? []
      : publicSlotsForService(serviceState, service, week, ignoreId);
    servicesById[service.id] = { serviceId: service.id, week, slots: serviceSlots.map((slot) => ({ ...slot })) };
  }
  // safeJsonStringify deliberately rejects shared references, so retain the
  // legacy top-level `slots` compatibility field as a separate copy.
  const slots = targetService ? servicesById[targetService.id].slots.map((slot) => ({ ...slot })) : [];
  if (metrics) metrics.returnedSlotCount = Object.values(servicesById).reduce((sum, entry: any) => sum + entry.slots.length, 0);
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
    const readSlotContext = options.readPublicSlotContext || readPublicSlotContext;
    // The business comes from the validated public identifier on the request,
    // not from the settings blob. options.resolveAccountId is the same seam
    // options.readPublicSlotContext already uses, so tests can supply one.
    const resolveAccountId = options.resolveAccountId || resolvePublicAccountId;
    const accountId = await resolveAccountId(req);
    const slotContext = await readSlotContext({ accountId, serviceId, week }, { ...options, metrics });
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

async function createPublicBooking(accountId: string, payload: Record<string, any>, context = null) {
  const state = await readFastPublicCalendarState(accountId);
  const workspaceAccount = publicWorkspaceAccount(state);
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
  // A review is booked without a time, so there is no time to validate. The
  // client sends none and any it did send is ignored rather than trusted --
  // the deadline is the server's to set, not the player's to choose.
  const isReview = isVideoReviewService(service);
  if (
    !isReview &&
    (!Number.isInteger(week) ||
      !Number.isInteger(day) ||
      !Number.isInteger(start) ||
      day < 0 ||
      day > 6)
  ) {
    throw Object.assign(new Error("Choose a valid appointment time."), {
      status: 400,
    });
  }

  const serviceCoachId = service.coachId || defaultCoachId(accountState.coaches || []);
  const serviceLocationId = serviceLocation(service, accountState.locations || [], accountState.account).id;
  const reviewDue = isReview
    ? videoReviewDueSlot(
        service,
        accountState,
        serviceCoachId,
        // Same precedence publicSlotsForService uses: the business's own
        // timezone from the state already in hand, never a global.
        cleanString(accountState.account?.timezone, "", 80) || defaultTimeZone(),
      )
    : null;
  const slot = reviewDue
    ? { week: reviewDue.week, day: reviewDue.day, start: reviewDue.start, duration: reviewDue.duration }
    : { week, day, start, duration: service.duration };
  const rejectionBase = {
    serviceId: service.id,
    serviceName: service.name,
    slot,
    coachId: serviceCoachId,
    locationId: serviceLocationId,
    itemCount: accountState.items.length,
  };
  if (isReview) {
    // Nothing to check. A review does not hold a slot against anyone: two due
    // the same afternoon is a workload, not a double booking, and refusing the
    // second would be refusing work the coach has capacity to do.
  } else if (isScheduledGroupService(service)) {
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
    note: reviewDue
      ? `Video review booked from public booking page. Due back ${formatBookingDate(reviewDue.week, reviewDue.day)}.`
      : "Booked from public booking page.",
    location,
    ...(customGroup || {}),
  };
  const nextState = await writePublicBookingAppointment(accountId, state, appointment, context, {
    // A review occupies no bay. Auto-booking a resource for one would hold a
    // hitting bay empty for half an hour on a day nobody is coming in.
    autoBookResource: !isReview,
    sendConfirmation: true,
    coachPush: true,
  });
  return { appointment, notifications: [], state: nextState };
}

export async function handlePublicBookingRequest(req, context = null) {
  try {
    console.log("public_booking:start");
    const result = await createPublicBooking(await resolvePublicAccountId(req), await parseBody(req), context);
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

    const state = await readPublicCalendarState(await resolvePublicAccountId(req));
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

    await writePublicBookingState(workspaceAccount.id, state, nextItems);
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

    const state = await readPublicCatalogState(await resolvePublicAccountId(req));
    const workspaceAccount = publicWorkspaceAccount(state);
    assertAccountFeature(workspaceAccount, "publicBooking");
    const appointment = await readPublicAppointmentById(appointmentId, workspaceAccount.id);
    if (!appointment || !matchesNotificationContact(appointment, email, phone)) {
      return json({ sent: false }, 404);
    }

    const history = await readNotificationHistoryForAppointment(workspaceAccount.id, appointmentId);
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
  const service = (serviceList || []).find((candidate) => candidate.id === item.serviceId);
  return {
    id: item.id,
    serviceId: item.serviceId || "",
    serviceName: serviceName(item.serviceId, serviceList),
    // The portal and the reschedule page both have to know that a video review
    // is a deadline rather than an appointment: one renders it differently,
    // the other must not offer to move it.
    lessonFormat: service?.lessonFormat || "private",
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

async function triggerPublicBookingNotifications(accountId: string, payload: Record<string, any>) {
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

  const state = await readPublicCatalogState(accountId);
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
    await readNotificationHistoryForAppointment(accountId, appointmentId),
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
    await sendBookingNotifications(accountId, appointment, { kind }),
  );
  return {
    ok: results.some((result) => result.sent),
    alreadySent: false,
    results,
    notifications: clientNotificationRecords(
      await readNotificationHistoryForAppointment(accountId, appointmentId),
      appointmentId,
    ),
  };
}

async function lookupPublicReschedule(accountId: string, payload: Record<string, any>) {
  const rawEmail = cleanString(payload?.email, "", 180).toLowerCase();
  const email = normalizeRescheduleContact(payload?.email);
  const phone = normalizeRescheduleContact(payload?.phone);
  if (!email || !phone) {
    throw Object.assign(
      new Error("Enter the email and phone number used on the booking."),
      { status: 400 },
    );
  }

  const state = await readPublicCatalogState(accountId);
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

async function reschedulePublicBooking(accountId: string, payload: Record<string, any>, context = null) {
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

  const state = await readPublicCatalogState(accountId);
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
  // A review has no appointment time, so there is nothing to move. Letting one
  // through here would drop it onto a real slot and turn a deadline into an
  // appointment nobody is attending.
  if (isVideoReviewService(service)) {
    throw Object.assign(
      new Error("A video review has no appointment time to change. Contact your coach about the turnaround."),
      { status: 409 },
    );
  }
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
    accountId,
    state,
    updatedAppointment,
    context,
    // A client confirming a reschedule moves the lesson exactly like a coach
    // dragging it, so the Optix bay has to move too. The admin paths get this
    // from deferOptixBayRebook on the calendar save; this one writes the
    // appointment row directly and never touched the bay, so a client
    // reschedule used to leave the bay held at the old time — still 'synced',
    // still painting the orange ring over a lesson that had no bay.
    { rebookResource: appointmentSlotChanged(appointment, updatedAppointment) },
  );
  let notifications = [];
  try {
    notifications = await notifyBookingEvent({
      action: "rescheduled",
      appointment: updatedAppointment,
      previousAppointment: appointment,
      source: "public-reschedule",
      coachPush: true,
    });
  } catch (error) {
    console.error("public_reschedule:notification_failed", error);
  }

  return { appointment: updatedAppointment, notifications };
}

async function cancelPublicBooking(accountId: string, payload: Record<string, any>) {
  const appointmentId = cleanString(payload?.appointmentId, "", 120);
  const email = normalizeRescheduleContact(payload?.email);
  const phone = normalizeRescheduleContact(payload?.phone);

  if (!appointmentId || !email || !phone) {
    throw Object.assign(new Error("Choose the booking to cancel."), {
      status: 400,
    });
  }

  const state = await readPublicCalendarState(accountId);
  const workspaceAccount = publicWorkspaceAccount(state);
  assertAccountFeature(workspaceAccount, "publicBooking");
  const appointment = state.items.find((item) => recordBelongsToAccount(item, workspaceAccount.id) && item.id === appointmentId);
  if (!appointment || !matchesRescheduleContact(appointment, email, phone)) {
    throw Object.assign(new Error("That booking could not be verified."), {
      status: 404,
    });
  }

  const nextState = await writePublicBookingState(
    accountId,
    state,
    state.items.filter((item) => item.id !== appointment.id),
  );

  const notificationsTask = notifyBookingEvent({
    action: "cancelled",
    appointment,
    previousAppointment: appointment,
    source: "public-cancel",
    coachPush: true,
  }).catch((error) => {
    console.error("public_cancel:notification_failed", error);
    return [];
  });

  if (payload?.context && typeof payload.context.waitUntil === "function") {
    payload.context.waitUntil(notificationsTask);
  }

  return { appointment, notifications: [], state: nextState };
}

export async function handlePublicRescheduleLookupRequest(req) {
  try {
    return json(await lookupPublicReschedule(await resolvePublicAccountId(req), await parseBody(req)));
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
    const result = await reschedulePublicBooking(await resolvePublicAccountId(req), await parseBody(req), context);
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

export async function handlePublicCancelRequest(req, context = null) {
  try {
    if (req.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }
    const result = await cancelPublicBooking(await resolvePublicAccountId(req), { ...(await parseBody(req)), context });
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

/**
 * Like formatLocalDateTime, but for a time measured from the start of a weekday
 * that may run past midnight — an unavailable span from Friday evening to
 * Monday morning is 3900 minutes into Friday, not hour 65 of it.
 */
function formatSpanDateTime(day, minutes) {
  const dayOffset = Math.floor(minutes / (24 * 60));
  return formatLocalDateTime(0, day + dayOffset, minutes - dayOffset * 24 * 60);
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

/**
 * A cancelled or no-show booking is not busy time. It stays on the Clarity
 * calendar as a record, but publishing it to Google would hold an hour the
 * coach is free to fill — the one thing a subscribed calendar must not do.
 */
export function feedItemIsBusy(item) {
  if (item?.status === "cancelled" || item?.status === "no_show") return false;
  // Cancelling a scheduled group session leaves a placeholder block behind so
  // the slot does not regenerate. It marks an absence, not an engagement.
  if (item?.kind === "block" && item?.note === CANCELLED_GROUP_SESSION_NOTE) return false;
  return true;
}

/**
 * Busy events covering the time the coach is not open for bookings, so a
 * subscribed calendar shows a working week rather than an empty one with a few
 * lessons floating in it.
 *
 * The stretches themselves come from _shared/availability-blocks.mts, which the
 * Google Calendar API sync publishes from too — two ideas of "unavailable"
 * would drift, and a coach on the feed would see a different week from one on
 * the sync with no way to tell which was right.
 */
function unavailableFeedEvents(state, account, stamp) {
  const timezone = account.timezone;
  // Anchored to week 0 and repeating weekly, so the event body never changes
  // just because time passed and every hour stays covered indefinitely.
  return unavailableSpans(state.availability || []).flatMap((span) => [
    "BEGIN:VEVENT",
    `UID:${span.id}@clarity-golf-booking`,
    `DTSTAMP:${stamp}`,
    `DTSTART;TZID=${timezone}:${formatSpanDateTime(span.day, span.start)}`,
    `DTEND;TZID=${timezone}:${formatSpanDateTime(span.day, span.start + span.durationMinutes)}`,
    "RRULE:FREQ=WEEKLY",
    `SUMMARY:${escapeText(`Unavailable - ${account.businessName}`)}`,
    `DESCRIPTION:${escapeText("Not bookable. Set by your Clarity availability.")}`,
    "CATEGORIES:Unavailable",
    "STATUS:CONFIRMED",
    "TRANSP:OPAQUE",
    "END:VEVENT",
  ]);
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

  lines.push(...unavailableFeedEvents(state, account, stamp));

  state.items
    .slice()
    .filter(feedItemIsBusy)
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

// Typed as an object, not `any`, on purpose. Several route helpers take
// (accountId, payload) since the boundary work, and with an `any` body the
// compiler happily accepted the two swapped -- which is exactly how a couple of
// public routes briefly passed the request body where the business id belongs.
async function parseBody(req: Request): Promise<Record<string, any>> {
  const raw = await req.text();
  return raw ? JSON.parse(raw) : {};
}

/**
 * Every route reaches the network through here, so this is the one place that
 * has to know a caller might be the native app rather than one of our pages.
 * A preflight is answered without touching the database; anything else is
 * routed as normal and the headers are added on the way out.
 */
export async function handleBookingApiRoute(
  req: Request,
  forcedPathname = "",
  context = null,
) {
  const cors = corsHeaders(req);
  if (!cors) return routeBookingApiRequest(req, forcedPathname, context);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const response = await routeBookingApiRequest(req, forcedPathname, context);
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(cors)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function routeBookingApiRequest(
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
    // Both cookies have to be absent: this endpoint now answers for players too,
    // and the app routes on its `role`.
    if (
      req.method === "GET" &&
      pathname === "/api/auth/session" &&
      !sessionTokenFromRequest(req) &&
      !playerSessionTokenFromRequest(req)
    ) {
      return json({ authenticated: false, role: "guest" });
    }

    if (req.method === "GET" && pathname === "/api/public-booking-state") {
      return handlePublicBookingStateRequest(req);
    }

    if (req.method === "GET" && pathname === "/api/public-booking-catalog") {
      return handlePublicBookingCatalogRequest(req);
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
        await triggerPublicBookingNotifications(await resolvePublicAccountId(req), await parseBody(req)),
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

    // One login form for the whole app. The coach is checked first against
    // admin_users, exactly as before; anything that is not a coach is then
    // offered to Supabase Auth as a portal player. The response's `role` is
    // what the app routes on -- coach to the booking workspace, player to the
    // portal.
    if (req.method === "POST" && pathname === "/api/auth/login") {
      const body = await parseBody(req);
      const loginEmail = cleanEmail(body.email, "");
      const loginPassword = typeof body.password === "string" ? body.password : "";

      // Coach/business-owner credentials live in Supabase Auth, the same store
      // the player side already uses. admin_users is checked only as a
      // transitional fallback for the original workspace's existing login, and
      // even then the session is linked to the matching Supabase identity if
      // one exists -- a session that cannot name an auth user resolves to no
      // account and every private route answers 403.
      const coachAuthUserId = await verifyCoachAuthPassword(loginEmail, loginPassword);
      const legacyUser = coachAuthUserId
        ? null
        : await verifyAdminPassword(loginEmail, loginPassword);

      if (coachAuthUserId || legacyUser) {
        const authUserId = coachAuthUserId || (await findCoachAuthUserId(loginEmail));
        const membership = authUserId ? await resolveMembershipForAuthUser(authUserId) : null;
        if (!membership) {
          // Authenticated is not authorised -- but "no membership" is the
          // normal shape of a PLAYER, not only of a coach without a workspace.
          //
          // verifyCoachAuthPassword is an alias of verifySupabaseAuthPassword,
          // the same grant the portal uses, so every portal player passes the
          // check above. Returning 403 here sent them away with "this login is
          // not attached to a business workspace yet" and left the player
          // branch below unreachable for anyone whose password was right.
          const playerAccountId = await resolvePublicAccountId(req).catch(() => "");
          const portalPlayer = coachAuthUserId
            ? await portalPlayerSessionIdentity(coachAuthUserId, loginEmail, playerAccountId)
            : null;
          if (portalPlayer) {
            return playerSessionResponse(portalPlayer, req);
          }
          // Genuinely nothing to sign in to: a coach whose workspace was never
          // created, and not a player either. There is deliberately no default
          // account to fall back on.
          return json(
            {
              error: "membership_required",
              message: "This login is not attached to a business workspace yet.",
            },
            403,
          );
        }
        const adminUserId = legacyUser?.id || authUserId;
        const session = await createAdminSession(adminUserId, authUserId);
        return json(
          // Wrapped so the union is checked here: an object literal in this
          // file infers `role: string` and would accept anything.
          authSessionResponse({
            authenticated: true,
            // The session vocabulary the app shell routes on -- NOT the
            // membership role, which is reported separately below.
            role: sessionRoleForMembership(membership.role),
            accountRole: membership.role,
            email: loginEmail,
            accountId: membership.accountId,
            expiresAt: session.expiresAt,
            workspace: await readWorkspaceBootstrap(membership),
          }),
          200,
          { "Set-Cookie": cookieHeader(session.token, req, 7 * 24 * 60 * 60) },
        );
      }

      // No second player attempt here. It used to re-verify the same password
      // that just failed both checks above, against the same auth store, and
      // could only fail again.
      return json({ error: "invalid_login", message: "Email or password is incorrect." }, 401);
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
        // Only for the branding on the email (business name, from address).
        // The reset itself is keyed on the admin_users row, and this route
        // deliberately answers the same way whether or not the address exists.
        const resetMembership = await resolveMembershipForAuthUser(
          await findCoachAuthUserId(reset.email),
        );
        const emailResult = await sendPasswordResetEmail(
          resetMembership?.accountId || legacyOriginalWorkspaceId(),
          reset,
          req,
        );
        if (!emailResult.sent) {
          return json(
            {
              ok: false,
              message: "Could not send the reset email. Try again in a minute.",
            },
            502,
          );
        }
      } else {
        // Not an admin, so try the player portal. This used to stop at the line
        // above, which meant every player reset returned "sent" and sent
        // nothing -- the screen said the mail was on its way and it never was.
        //
        // Players are looked up second because the admin table is the smaller,
        // older set: an address in both is the coach, and the coach login is
        // the one that opens the workspace.
        //
        // A request that cannot name a business is not an error here, just a
        // lookup with nowhere to look: once a second business goes live,
        // resolvePublicAccountId needs a ?business= slug, and a coach resetting
        // their own password on the bare domain must not start getting a 404
        // from a route that answered them fine the day before.
        const playerAccountId = await resolvePublicAccountId(req).catch(() => "");
        const playerReset = playerAccountId
          ? await issuePortalPasswordReset({
              req,
              email: body.email || "",
              accountId: playerAccountId,
            })
          : null;
        if (playerReset && !playerReset.sent) {
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
        message: "If that email matches an account, a reset link has been sent.",
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
      // Mint the session the same way the login route does: linked to the
      // Supabase identity and checked against a membership. Without the link
      // the session carries no auth_user_id, so requireCoachActor refuses every
      // request after it -- a reset that "succeeds" and then cannot do anything.
      const resetAuthUserId = await findCoachAuthUserId(result.user.email);
      const resetMembership = resetAuthUserId
        ? await resolveMembershipForAuthUser(resetAuthUserId)
        : null;
      if (!resetMembership) {
        return json(
          authSessionResponse({
            authenticated: false,
            role: "guest",
            error: "membership_required",
            message:
              "Your password was changed, but this login is not attached to a business workspace yet.",
          }),
          403,
        );
      }
      const session = await createAdminSession(result.user, resetAuthUserId);
      return json(
        authSessionResponse({
          authenticated: true,
          role: sessionRoleForMembership(resetMembership.role),
          accountRole: resetMembership.role,
          email: result.user.email,
          accountId: resetMembership.accountId,
          expiresAt: session.expiresAt,
        }),
        200,
        { "Set-Cookie": cookieHeader(session.token, req, 7 * 24 * 60 * 60) },
      );
    }

    if (req.method === "POST" && pathname === "/api/auth/change-password") {
      // The boundary check first (401 without a session, 403 without a
      // membership), then the legacy session row for the email this route
      // needs. Coaches whose credential lives only in Supabase Auth have no
      // admin_users row, so this route reports invalid_current_password for
      // them -- they change their password through Supabase, not here.
      await requireAdmin(req);
      const currentSession = await readAdminSession(sessionTokenFromRequest(req));
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
      // The new session must carry the same Supabase identity the old one did,
      // or the coach is signed out in all but name: requireCoachActor would
      // find no auth_user_id and refuse every request. requireAdmin above
      // already resolved this actor, so it is cached.
      const changeActor = await currentActor(req);
      const session = await createAdminSession(result.user, changeActor.authUserId);
      return json(
        authSessionResponse({
          authenticated: true,
          role: sessionRoleForMembership(changeActor.role),
          accountRole: changeActor.role,
          email: result.user.email,
          accountId: changeActor.accountId,
          expiresAt: session.expiresAt,
        }),
        200,
        { "Set-Cookie": cookieHeader(session.token, req, 7 * 24 * 60 * 60) },
      );
    }

    // Clears whichever session the browser is holding. A coach who is also a
    // player on the same browser can hold both cookies, so both are cleared.
    if (req.method === "POST" && pathname === "/api/auth/logout") {
      const adminToken = sessionTokenFromRequest(req);
      const playerToken = playerSessionTokenFromRequest(req);
      if (adminToken) await destroyAdminSession(adminToken);
      if (playerToken) await destroyPlayerSession(playerToken);
      return json({ authenticated: false, role: "guest" }, 200, {
        "Set-Cookie": [clearCookieHeader(), clearPlayerCookieHeader()],
      });
    }

    if (req.method === "GET" && pathname === "/api/auth/session") {
      // A sandbox handoff wins over the coach cookie sitting beside it.
      //
      // The two cookies coexist by design -- that is what lets "Return to coach"
      // be instant rather than a logout and a login. But it means the ordinary
      // "coach first" answer below would send the shell straight back to the
      // workspace the coach just stepped out of. Only a handoff is preferred: a
      // real player session with a coach cookie alongside it is still a coach,
      // which is what happens when a coach is also a player on their own
      // browser.
      const handoff = await readPlayerSession(playerSessionTokenFromRequest(req));
      if (handoff?.sandboxActorAuthUser) {
        return json({
          authenticated: true,
          role: "player",
          email: handoff.email,
          accountId: handoff.accountId,
          accountKind: "sandbox",
          viewingAs: (await readPeople(handoff.accountId)).find(
            (person) => person.id === handoff.personId,
          )?.name || handoff.email,
        });
      }

      const session = await readAdminSession(sessionTokenFromRequest(req));
      if (session) {
        // A coach session is only useful with a workspace behind it. Reporting
        // "signed in" for a session with no membership would put the client
        // into the app proper, where every request then answers 403 -- so the
        // session check says which business, or says there isn't one.
        const membership = session.authUserId
          ? await resolveMembershipForAuthUser(session.authUserId, session.activeAccountId)
          : null;
        if (!membership) {
          // 200, not 403. This endpoint answers "who is this request?", and the
          // honest answer is "nobody with a workspace" -- which the client
          // renders as the sign-in screen. A non-2xx here is read as the
          // session API being down, which is a worse and less true story. Every
          // route that actually returns data still refuses with 403.
          return json(
            authSessionResponse({
              authenticated: false,
              role: "guest",
              error: "membership_required",
              message: "This login is not attached to a business workspace yet.",
            }),
          );
        }
        return json(
          authSessionResponse({
            authenticated: true,
            role: sessionRoleForMembership(membership.role),
            accountRole: membership.role,
            email: session.email,
            accountId: membership.accountId,
            // What the shell needs to know it must draw the sandbox bar. Derived
            // from the accounts table by the membership resolution, not from
            // anything the client sent.
            accountKind: membership.sandboxOfAccountId ? "sandbox" : "live",
            ...(membership.sandboxOfAccountId
              ? { liveAccountId: membership.sandboxOfAccountId }
              : {}),
            workspace: await readWorkspaceBootstrap(membership),
          }),
        );
      }
      const player = await readPlayerSession(playerSessionTokenFromRequest(req));
      if (player) {
        return json({
          authenticated: true,
          role: "player",
          email: player.email,
        });
      }
      return json({ authenticated: false, role: "guest" });
    }

    if (req.method === "GET" && pathname === "/api/public-booking-state") {
      return handlePublicBookingStateRequest(req);
    }

    if (req.method === "GET" && pathname === "/api/public-booking-catalog") {
      return handlePublicBookingCatalogRequest(req);
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
        await triggerPublicBookingNotifications(await resolvePublicAccountId(req), await parseBody(req)),
      );
    }

    if (req.method === "POST" && pathname === "/api/public-cancel") {
      return handlePublicCancelRequest(req, context);
    }

    if (req.method === "GET" && pathname === "/api/public-diagnostics") {
      return json(await runPublicDiagnostics(await resolvePublicAccountId(req)));
    }

    if (
      req.method === "GET" &&
      pathname === "/api/public-serialization-diagnostics"
    ) {
      return json(await runPublicSerializationDiagnostics(await resolvePublicAccountId(req)));
    }

    if (req.method === "GET" && pathname === "/api/database-health") {
      return json(await runDatabaseHealth(await resolvePublicAccountId(req)));
    }

    // --- Player portal (public, pre-gate). Each route does its own player-
    // session check; the admin gate below is intentionally left untouched so
    // the player surface can never widen admin access. ---------------------
    //
    // Login, session and logout are handled by /api/auth/* for everyone. The
    // old /api/player/login (email + phone) is gone: a phone number is not a
    // credential for a surface holding lesson notes and video.

    // Completing an invite is necessarily unauthenticated -- the token is the
    // credential.
    if (req.method === "GET" && pathname === "/api/portal/invite") {
      const token = new URL(req.url).searchParams.get("token") || "";
      const portalPlayer = await readPortalInvite(token);
      return json(
        portalPlayer
          ? { valid: true, email: portalPlayer.email }
          : { valid: false, message: "That invite link has expired. Ask your coach to send a new one." },
      );
    }

    if (req.method === "POST" && pathname === "/api/portal/set-password") {
      const body = await parseBody(req);
      const result = await completePortalInvite(body?.token || "", body?.password || "");
      if (result.error === "weak_password") {
        return json(
          { error: "weak_password", message: "Use at least 10 characters." },
          400,
        );
      }
      if (result.error) {
        return json(
          {
            error: "invalid_token",
            message: "That invite link has expired. Ask your coach to send a new one.",
          },
          400,
        );
      }
      return json({ ok: true, email: result.portalPlayer?.email || "" });
    }

    if (req.method === "GET" && pathname === "/api/player/profile") {
      const session = await readPlayerSession(playerSessionTokenFromRequest(req));
      if (!session) {
        return json({ error: "unauthorized", message: "Player login required." }, 401);
      }
      return json(await readPlayerProfile(session));
    }

    // Player-side "Mark Complete." Player-session-authenticated, ahead of the
    // admin gate below, same shape as /api/player/profile above.
    if (req.method === "POST" && pathname === "/api/practice-blocks/complete") {
      const session = await readPlayerSession(playerSessionTokenFromRequest(req));
      if (!session) {
        return json({ error: "unauthorized", message: "Player login required." }, 401);
      }
      const body = await parseBody(req);
      return json(await completePracticeBlockForPlayer(body?.id, session));
    }

    /* --- Asking for a swing review ---------------------------------------
     *
     * Creates an ordinary booking. The pass schema is explicit that this is
     * what a review is -- a booking of a video-review service, with a
     * server-set deadline instead of a slot -- so this route composes existing
     * machinery rather than adding a parallel notion of "a review":
     *
     *   createPublicBooking  the booking and its turnaround deadline
     *   reservePassCredit    the credit, taken atomically against that booking
     *   upsertLessonNote     what the player wants looked at, filed under the
     *                        review's lesson id so the coach's swing review
     *                        screen gathers it with the video
     *
     * The video is not here. It goes up through the transfer pipeline from the
     * player's device, carrying the same lesson id this returns, because the
     * bytes should not pass through a JSON route.
     */
    if (req.method === "POST" && pathname === "/api/player/reviews") {
      const session = await readPlayerSession(playerSessionTokenFromRequest(req));
      if (!session) {
        return json({ error: "unauthorized", message: "Player login required." }, 401);
      }
      if (!session.personId) {
        return json(
          { error: "no_profile", message: "Your coach needs to finish setting up your profile." },
          409,
        );
      }
      const accountId = cleanSlug(session.accountId, "");
      if (!accountId) throw missingAccountScope("player_review");

      const body = await parseBody(req);
      const notes = cleanString(body?.notes, "", 4000);
      const hasVideo = body?.hasVideo === true;

      const verdict = reviewDraftVerdict({ notes, hasVideo });
      if (!verdict.ok) return json({ error: "empty_review", message: verdict.reason }, 400);

      const state = await readPublicCatalogState(accountId);
      const service = findReviewService(
        (state.services || []).filter((entry) =>
          recordBelongsToAccount(entry, publicWorkspaceAccount(state).id),
        ),
      );
      if (!service) {
        return json(
          {
            error: "no_review_service",
            message: "Your coach does not offer video reviews yet.",
          },
          409,
        );
      }

      // Which credit is being spent is named by the caller, but whether it may
      // be spent is decided here and then again, atomically, inside
      // reservePassCredit. The pre-check exists only so the common failure --
      // no credits at all -- costs a 402 rather than an orphaned booking.
      const passId = cleanString(body?.passId, "", 120);
      const settingsMap = await readSettingsMap(accountId);
      const currency = playerShopCurrency(settingsMap);
      const heldPasses = await readPassesForPerson(accountId, session.personId);
      const options = passOptionsForService(heldPasses, service.id, service.name, {
        serviceValueCents: Math.max(0, Math.round(Number(service.price || 0) * 100)),
        currency,
        acceptsCrossRedemption: service.acceptsCrossRedemption !== false,
        flexibleValueCents: await readFlexibleValueForPerson(accountId, session.personId, currency),
      }).filter((option) => option.covered);
      const chosen = passId
        ? options.find((option) => option.passId === passId)
        : options[0];
      if (!chosen) {
        return json(
          {
            error: "payment_required",
            message: "You have no review credits left.",
            serviceId: service.id,
            price: service.price,
          },
          402,
        );
      }

      const lessonId = newSwingReviewLessonId();
      // createPublicBooking wants a name, and the session carries only an
      // email. Read it from the person the session already resolves to rather
      // than asking the player to retype it into a form they have no reason to
      // see.
      const personRows = (await db().sql`
        SELECT name FROM people
        WHERE account_id = ${accountId} AND id = ${session.personId}
        LIMIT 1
      `) as Record<string, unknown>[];
      const fullName =
        cleanString(personRows[0]?.name, "", 180) ||
        cleanString(session.email, "", 180).split("@")[0] ||
        "Player";
      const [firstName, ...rest] = fullName.split(/\s+/);
      const booking = await createPublicBooking(
        accountId,
        {
          serviceId: service.id,
          firstName,
          lastName: rest.join(" ") || firstName,
          email: session.email || "",
          phone: session.phone || "",
        },
        context,
      );
      const bookingId = cleanString(booking?.appointment?.id, "", 160);

      /* From here the booking exists and the player is committed.
       *
       * A reservation that fails now is the race this cannot prevent: two
       * devices spending the last credit at the same moment. The booking is
       * deliberately left standing rather than unwound -- it is a real request
       * the coach can see and settle at the till, which is a better outcome
       * than a review that silently never happened. It is logged loudly
       * because it should be rare.
       */
      try {
        await reservePassForService({
          accountId,
          passId: chosen.passId,
          bookingId,
          serviceId: service.id,
          serviceValueCents: Math.max(0, Math.round(Number(service.price || 0) * 100)),
          currency,
          acceptsCrossRedemption: service.acceptsCrossRedemption !== false,
          actorId: session.personId,
        });
      } catch (error) {
        console.error("player_review:credit_lost_race", accountId, bookingId, error);
        return json(
          {
            error: "credit_unavailable",
            message:
              "Your review was booked but the credit could not be taken. Your coach will sort it out.",
            bookingId,
            lessonId,
          },
          409,
        );
      }

      if (notes) {
        await upsertLessonNote(
          {
            playerId: session.personId,
            playerName: fullName,
            lessonId,
            title: "What I would like looked at",
            body: notes,
            source: "typed",
          },
          accountId,
        );
      }

      return json({
        ok: true,
        bookingId,
        lessonId,
        service: { id: service.id, name: service.name, turnaroundDays: service.turnaroundDays },
        ...(await readPlayerProfile(session)),
      });
    }

    /* --- Buying, as the player -------------------------------------------
     *
     * The first place in this app where a customer, rather than a coach, moves
     * money. Two routes, and the split is deliberate: creating a session takes
     * no money and can be retried freely, while confirming one hands out a real
     * spendable entitlement and must be safe to call repeatedly.
     *
     * What the player buys is always a pass. That is not a workaround -- it is
     * the pass system doing its job, and it means a card payment lands in the
     * same ledger as a counter sale, spends through the same checkout, and
     * reverses through the same reversal.
     */
    if (req.method === "POST" && pathname === "/api/player/checkout") {
      const session = await readPlayerSession(playerSessionTokenFromRequest(req));
      if (!session) {
        return json({ error: "unauthorized", message: "Player login required." }, 401);
      }
      if (!session.personId) {
        return json(
          {
            error: "no_profile",
            message: "Your coach needs to finish setting up your profile before you can buy.",
          },
          409,
        );
      }
      const accountId = cleanSlug(session.accountId, "");
      if (!accountId) throw missingAccountScope("player_checkout");

      const body = await parseBody(req);
      const state = await readPublicCatalogState(accountId);
      const settingsMap = await readSettingsMap(accountId);
      const credential = resolveStripeCredential(settingsMap[STRIPE_SECRET_SETTING]);

      // Priced from the catalogue on the server, never from the request. The
      // browser sends which thing, not what it costs.
      const item = findPlayerShopItem(
        playerShopItems(
          (state.services || []).filter((service) =>
            recordBelongsToAccount(service, publicWorkspaceAccount(state).id),
          ),
          playerShopCurrency(settingsMap),
        ),
        body?.serviceId,
      );
      if (!item) {
        return json({ error: "not_for_sale", message: "That is not for sale." }, 400);
      }

      const origin = new URL(req.url).origin;
      const purchaseValueCents = Math.max(0, Math.round(item.price * 100));
      const reservation = await reserveFlexibleValueForPurchase({
        accountId,
        personId: session.personId,
        purchaseValueCents,
        currency: item.currency,
        sourceRef: `checkout-attempt:${randomUUID()}`,
        actorId: session.personId,
      });
      const cardValueCents = purchaseValueCents - (reservation?.creditUsedCents || 0);

      if (cardValueCents === 0 && reservation) {
        const purchaseRef = `credit-purchase:${reservation.transactionId}`;
        try {
          // Bank the tender before issuing the entitlement. If issuing fails,
          // the catch path appends the exact opposite value movement and marks
          // this tender refunded, so a partial failure cannot leave a free pass.
          await db().sql`
            INSERT INTO public.billing_payment_tenders (
              id, account_id, purchase_ref, tender_kind, amount_cents, currency,
              pass_value_transaction_id, created_at
            ) VALUES (
              ${`tender-${randomUUID()}`}, ${accountId}, ${purchaseRef},
              'clarity_credit', ${reservation.creditUsedCents}, ${item.currency},
              ${reservation.transactionId}, NOW()
            ) ON CONFLICT (account_id, purchase_ref, tender_kind) DO NOTHING
          `;
          await settleFlexibleValuePurchase(accountId, reservation.transactionId);
          await grantPass(
            {
              personId: session.personId,
              ...(item.kind === "package"
                ? { templateServiceId: item.serviceId }
                : { name: item.name, coversServiceIds: item.coversServiceIds }),
              credits: item.credits,
              source: "clarity_checkout",
              sourceRef: purchaseRef,
              totalValueCents: purchaseValueCents,
              currency: item.currency,
              entitlementServiceId:
                item.coversServiceIds.length === 1 ? item.coversServiceIds[0] : undefined,
              note: "Bought in the player portal with Clarity credit",
            },
            passTemplatesFromServices(state.services),
            { accountId, actorId: session.personId },
          );
        } catch (error) {
          await reversePassValueTransaction(
            accountId,
            reservation.transactionId,
            "Purchase could not be completed",
            session.personId,
          ).catch(() => null);
          await db().sql`
            UPDATE public.billing_payment_tenders
            SET refunded_cents = amount_cents
            WHERE account_id = ${accountId}
              AND purchase_ref = ${purchaseRef}
              AND tender_kind = 'clarity_credit'
          `.catch(() => null);
          throw error;
        }
        return json({ ok: true, paid: true, ...(await readPlayerProfile(session)) });
      }

      let checkout;
      try {
        checkout = await createStripeCheckoutSession(credential, {
          amount: cardValueCents / 100,
          currency: item.currency,
          productName: item.name,
          productDescription:
            item.credits === 1 ? "1 credit" : `${item.credits} credits`,
          customerEmail: session.email || "",
          clientReferenceId: session.personId,
          // Read back on confirm and checked against the session doing the
          // confirming. Without this a player could take somebody else's session
          // id and have the credits land on their own account.
          metadata: {
            account_id: accountId,
            person_id: session.personId,
            service_id: item.serviceId,
            full_value_cents: String(purchaseValueCents),
            credit_used_cents: String(reservation?.creditUsedCents || 0),
            value_transaction_id: reservation?.transactionId || "",
            cross_redeemable: item.crossRedeemable ? "true" : "false",
          },
          // The portal is the root app, chosen by the session's role -- there is
          // no /portal path to come back to.
          successUrl: `${origin}/?purchase={CHECKOUT_SESSION_ID}`,
          cancelUrl:
            `${origin}/?purchase=cancelled` +
            (reservation ? `&reservation=${encodeURIComponent(reservation.transactionId)}` : ""),
        });
      } catch (error) {
        if (reservation) {
          await reversePassValueTransaction(
            accountId,
            reservation.transactionId,
            "Card checkout could not be created",
            session.personId,
          ).catch(() => null);
        }
        throw error;
      }
      return json({ url: checkout.url, sessionId: checkout.sessionId });
    }

    if (req.method === "POST" && pathname === "/api/player/checkout/cancel") {
      const session = await readPlayerSession(playerSessionTokenFromRequest(req));
      if (!session) return json({ error: "unauthorized", message: "Player login required." }, 401);
      const accountId = cleanSlug(session.accountId, "");
      const body = await parseBody(req);
      const transactionId = cleanString(body?.transactionId, "", 160);
      if (transactionId) {
        const owned = await db().sql`
          SELECT id FROM public.pass_value_transactions
          WHERE id = ${transactionId}
            AND account_id = ${accountId}
            AND person_id = ${session.personId || ""}
            AND kind = 'purchase_tender'
            AND settled_at IS NULL
            AND reversed_at IS NULL
          LIMIT 1
        `;
        if (owned.length) {
          await reversePassValueTransaction(
            accountId,
            transactionId,
            "Purchase cancelled",
            session.personId || "",
          );
        }
      }
      return json({ ok: true });
    }

    /* Bank a finished checkout.
     *
     * A poll, not a webhook: the player is coming back from Stripe with the
     * session id in the URL and the portal asks until it is paid. That makes
     * idempotency the whole design rather than an afterthought -- issuing is
     * keyed on the session id through the unique index on
     * (account_id, source, source_ref), so calling this a hundred times issues
     * one pass.
     *
     * A webhook would be the belt to this braces and is the obvious next
     * addition; it would call exactly this code path.
     */
    if (req.method === "POST" && pathname === "/api/player/checkout/confirm") {
      const session = await readPlayerSession(playerSessionTokenFromRequest(req));
      if (!session) {
        return json({ error: "unauthorized", message: "Player login required." }, 401);
      }
      const accountId = cleanSlug(session.accountId, "");
      if (!accountId) throw missingAccountScope("player_checkout_confirm");

      const body = await parseBody(req);
      const sessionId = cleanString(body?.sessionId, "", 180);
      if (!sessionId) return json({ error: "invalid", message: "Which purchase?" }, 400);

      const settingsMap = await readSettingsMap(accountId);
      const credential = resolveStripeCredential(settingsMap[STRIPE_SECRET_SETTING]);
      const paid = await retrieveStripeCheckoutSession(credential, sessionId);

      // Whose purchase this was is Stripe's answer, not the caller's. Both
      // halves are checked: the account stops one business banking another's
      // session, the person stops a player banking somebody else's.
      if (paid.metadata?.account_id !== accountId || paid.metadata?.person_id !== session.personId) {
        return json({ error: "not_found", message: "That purchase was not found." }, 404);
      }
      if (!paid.paid) {
        if (paid.expired && paid.metadata?.value_transaction_id) {
          await reversePassValueTransaction(
            accountId,
            paid.metadata.value_transaction_id,
            "Card checkout expired",
            session.personId || "",
          );
        }
        return json({ ok: false, status: paid.expired ? "expired" : "pending" });
      }

      const state = await readPublicCatalogState(accountId);
      const services = (state.services || []).filter((service) =>
        recordBelongsToAccount(service, publicWorkspaceAccount(state).id),
      );
      const item = findPlayerShopItem(
        playerShopItems(services, playerShopCurrency(settingsMap)),
        paid.metadata?.service_id,
      );
      if (!item) {
        // Paid for something the catalogue no longer sells. The money is real,
        // so this is a job for a human rather than a silent drop.
        console.error("player_checkout:item_gone", accountId, sessionId);
        return json(
          {
            ok: false,
            status: "needs_coach",
            message: "Your payment went through. Your coach will add this to your account.",
          },
          202,
        );
      }

      const creditUsedCents = Math.max(0, Math.round(Number(paid.metadata?.credit_used_cents) || 0));
      const fullValueCents = Math.max(
        paid.amountTotal + creditUsedCents,
        Math.round(Number(paid.metadata?.full_value_cents) || 0),
      );
      if (paid.amountTotal + creditUsedCents !== fullValueCents) {
        return json({ error: "payment_mismatch", message: "Your payment needs coach review." }, 409);
      }
      const valueTransactionId = cleanString(paid.metadata?.value_transaction_id, "", 160);
      if (creditUsedCents > 0) {
        const activeReservation = await db().sql`
          SELECT id FROM public.pass_value_transactions
          WHERE id = ${valueTransactionId}
            AND account_id = ${accountId}
            AND person_id = ${session.personId || ""}
            AND kind = 'purchase_tender'
            AND reversed_at IS NULL
          LIMIT 1
        `;
        if (!activeReservation.length) {
          return json({
            error: "credit_reservation_missing",
            message: "Your card payment went through, but the credit reservation needs coach review.",
          }, 409);
        }
      }

      await grantPass(
        {
          personId: session.personId,
          // A package brings its own coverage from the catalogue; a single
          // review has none to bring, so it is granted free-form covering
          // itself.
          ...(item.kind === "package"
            ? { templateServiceId: item.serviceId }
            : { name: item.name, coversServiceIds: item.coversServiceIds }),
          credits: item.credits,
          source: "clarity_checkout",
          sourceRef: checkoutSourceRef(sessionId),
          totalValueCents: fullValueCents,
          currency: paid.currency || item.currency,
          entitlementServiceId:
            item.coversServiceIds.length === 1 ? item.coversServiceIds[0] : undefined,
          crossRedeemable: paid.metadata?.cross_redeemable === "true",
          note: `Bought in the player portal`,
        },
        passTemplatesFromServices(services),
        { accountId, actorId: session.personId },
      );

      if (creditUsedCents > 0 && valueTransactionId) {
        await db().sql`
          INSERT INTO public.billing_payment_tenders (
            id, account_id, purchase_ref, tender_kind, amount_cents, currency,
            pass_value_transaction_id, created_at
          ) VALUES (
            ${`tender-${randomUUID()}`}, ${accountId}, ${checkoutSourceRef(sessionId)},
            'clarity_credit', ${creditUsedCents}, ${paid.currency || item.currency},
            ${valueTransactionId}, NOW()
          ) ON CONFLICT (account_id, purchase_ref, tender_kind) DO NOTHING
        `;
        await settleFlexibleValuePurchase(accountId, valueTransactionId);
      }
      if (paid.amountTotal > 0) {
        await db().sql`
          INSERT INTO public.billing_payment_tenders (
            id, account_id, purchase_ref, tender_kind, amount_cents, currency,
            external_payment_ref, created_at
          ) VALUES (
            ${`tender-${randomUUID()}`}, ${accountId}, ${checkoutSourceRef(sessionId)},
            'card', ${paid.amountTotal}, ${paid.currency || item.currency},
            ${paid.paymentIntentId || sessionId}, NOW()
          ) ON CONFLICT (account_id, purchase_ref, tender_kind) DO NOTHING
        `;
      }

      return json({ ok: true, status: "paid", ...(await readPlayerProfile(session)) });
    }

    // The player's own view of Clarity Caddy. Deliberately not the coach deep
    // link: that one names a player for a coach to open, and hands a coach's
    // view to whoever holds it. A player opens Caddy as themselves, so all this
    // returns is where Caddy lives plus their own access state.
    if (req.method === "GET" && pathname === "/api/player/caddy") {
      const session = await readPlayerSession(playerSessionTokenFromRequest(req));
      if (!session) {
        return json({ error: "unauthorized", message: "Player login required." }, 401);
      }
      // Never throws -- an unreachable or unconfigured Caddy still has to leave
      // the portal with a working link.
      const status = await readCaddyPlayerStatus(session.authUserId, session.email);
      return json({ ok: true, appUrl: caddyAppUrl(), status });
    }

    // Registering as a guest is necessarily unauthenticated -- having no
    // account is the entire premise. The bar is the one createPublicBooking
    // already set for a stranger writing into this account: a name, an
    // address, and no verification. What is bounded is what the resulting
    // token can spend (see _shared/guest-limits.mts), not who may ask for one.
    if (req.method === "POST" && pathname === "/api/guest/register") {
      const body = await parseBody(req);
      const name = cleanString(body?.name, "", 180);
      const email = cleanEmail(body?.email, "");
      if (!name || !email) {
        return json(
          {
            error: "invalid",
            message: "Add your name and email so your coach knows who sent it.",
          },
          400,
        );
      }
      // Resolved server-side from the validated public workspace, not from the
      // body: a body-supplied account would let anyone pick whose Drive they
      // spend. Guests are unauthenticated by definition, so this is the public
      // resolver, not the coach actor.
      const accountId = await resolvePublicAccountId(req);
      await ensureGuestSendersTable();
      if ((await countGuestRegistrationsToday(accountId)) >= guestRegistrationsPerAccountPerDay) {
        return json(
          {
            error: "rate_limited",
            message: "Too many people are setting this up right now. Try again later.",
          },
          429,
        );
      }
      const guest = await createGuestSender({
        name,
        email,
        deviceId: cleanString(body?.deviceId, "", 160),
        accountId,
      });
      // The raw token is returned exactly once and never stored.
      return json(
        {
          ok: true,
          token: guest.token,
          guest: { id: guest.id, name: guest.name, email: guest.email },
        },
        201,
      );
    }

    if (req.method === "GET" && pathname === "/api/guest/status") {
      const guest = await readGuestSender(guestTokenFromRequest(req));
      if (!guest) {
        return json({ error: "unauthorized", message: "Guest session required." }, 401);
      }
      return json(await readGuestStatus(guest));
    }

    // ...and back. Only the player session is destroyed; the coach's own cookie
    // was never touched, so the workspace returns without a login.
    //
    // Deliberately above the requireAdmin gate below. The handoff session is its
    // own credential -- this route reads it, checks it really is a handoff, and
    // ends that one session and nothing else. Putting it behind the coach gate
    // would mean a coach whose admin session lapsed mid-handoff had no way out
    // of the portal at all.
    //
    // Refusing a session with no sandbox_actor_auth_user is what stops it being
    // a way to sign a real player out of their own portal.
    if (req.method === "POST" && pathname === "/api/sandbox/return") {
      const token = playerSessionTokenFromRequest(req);
      const player = await readPlayerSession(token);
      if (!player?.sandboxActorAuthUser) {
        return json({ error: "not_impersonating", message: "This is not a sandbox handoff." }, 400);
      }
      await destroyPlayerSession(token);
      return json({ ok: true }, 200, { "Set-Cookie": clearPlayerCookieHeader() });
    }

    // Everything below this line is a private route. requireAdmin throws 401
    // without a session and 403 with a session that has no workspace
    // membership -- authenticated is not authorised -- and the thrown error
    // carries the status the outer handler renders.
    if (pathname.startsWith("/api/")) {
      await requireAdmin(req);
    }

    if (req.method === "GET" && pathname === "/api/calendar-state") {
      const state = await readAdminCalendarShellState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      return json(publicCalendarState(filterCalendarStateForContext(state, requestContext)));
    }

    if (req.method === "PUT" && pathname === "/api/calendar-state") {
      const body = await parseBody(req);
      const action = cleanString(body?.action, "", 120);
      if (action === "complete_lesson") {
        const startAt = Date.now();
        const itemId = cleanString(body?.itemId, "", 140);
        const current = await readLessonCompleteState(await currentAccountId(req), itemId);
        const requestContext = await resolveBackendRequestContext(req, current);
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
      const current = await readCalendarState(await currentAccountId(req));
      if (action === "upsert_item") {
        const startAt = Date.now();
        const requestContext = await resolveBackendRequestContext(req, current);
        const candidateItem = { ...(body?.item || {}), accountId: requestContext.accountId };
        const item = cleanCalendarItem(candidateItem);
        const timedDetails = {
          action: "upsert_item",
          itemId: item?.id || cleanString(body?.item?.id, "", 140),
          calendarId: current.account?.id || "",
          route: "PUT /api/calendar-state",
          operationOwner: "upsert_item",
          accountId: requestContext.accountId || "",
        };
        if (!item) {
          console.error("upsert_item_failed", {
            ...timedDetails,
            httpStatus: 400,
            message: "Calendar item was invalid.",
          });
          return json(
            { error: "BOOKING_UPSERT_INVALID_ITEM", message: "Calendar item was invalid." },
            400,
          );
        }
        console.info("upsert_item_started", { ...timedDetails, httpStatus: 0 });
        try {
          const previousItem = current.items.find((existing) => existing.id === item.id) || null;
          assertCanWriteCalendarItem(requestContext, item, previousItem, current);
          const nextItems = previousItem
            ? current.items.map((existing) => (existing.id === item.id ? item : existing))
            : [...current.items, item];
          const savedItem = await writeItems([item], {
            returnMode: "single",
            accountId: requestContext.accountId,
          });
          const updatedAt = nowIso();
          await setSetting(await currentAccountId(req), "updatedAt", updatedAt);
          // A moved lesson takes its Optix bay with it — cancel and rebook in
          // the background (see deferOptixBayRebook).
          if (appointmentSlotChanged(previousItem, item)) {
            deferOptixBayRebook(requestContext.accountId, [item.id], context);
          }
          // Keep Google Calendar in step with every single-booking change (drag
          // reschedule, edit, lesson-complete). Deferred like the other save
          // paths so the round trip runs after the response rather than inside
          // it.
          const googleCalendarSync = deferGoogleCalendarSync(
            requestContext.accountId,
            [{ id: item.id, action: "upsert" }],
            "admin_item_upsert",
            context,
          );
          let notificationResults = [];
          let notificationWarning = "";
          try {
            notificationResults = await processAdminNotificationDebounce(
              requestContext.accountId,
              current.items,
              nextItems,
              { timeZone: current.account?.timezone },
            );
          } catch (error) {
            notificationWarning =
              "Calendar saved, but booking alerts could not be processed.";
            console.error("calendar_state:notification_failed", error);
          }
          const durationMs = Date.now() - startAt;
          console.info("upsert_item_saved", {
            ...timedDetails,
            httpStatus: 200,
            durationMs,
          });
          return json({
            ok: true,
            action: "upsert_item",
            item: savedItem,
            updatedAt,
            notificationResults,
            googleCalendarSync,
            ...(notificationWarning ? { warnings: [notificationWarning] } : {}),
          });
        } catch (error) {
          const durationMs = Date.now() - startAt;
          const status = responseStatusFromError(error);
          const errorCode = cleanString(error?.code, "BOOKING_UPSERT_FAILED", 120);
          const backendMessage = error instanceof Error ? error.message : String(error || "Calendar item could not be saved.");
          console.error("upsert_item_failed", {
            ...timedDetails,
            httpStatus: status,
            durationMs,
            message: backendMessage,
          });
          return json({ error: errorCode, message: backendMessage }, status);
        }
      }
      const requestContext = await resolveBackendRequestContext(req, current);
      const nextState = await writeCalendarState(requestContext.accountId, {
        syncKey:
          typeof body.syncKey === "string" ? body.syncKey : current.syncKey,
        items: Array.isArray(body.items) ? body.items : current.items,
        replaceItems: body.replaceItems === true,
        clearItems: body.clearItems === true,
        itemsOperation: body.itemsOperation,
        updatedAt: typeof body.updatedAt === "string" ? body.updatedAt : "",
      }, requestContext, context);
      let notificationResults = [];
      let notificationWarning = "";
      try {
        notificationResults = await processAdminNotificationDebounce(
          requestContext.accountId,
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
          notifications: await readNotificationHistory(await currentAccountId(req)),
        }),
        notificationResults,
        ...(notificationWarning
          ? { warnings: [...new Set([...existingWarnings, notificationWarning])] }
          : {}),
      });
    }

    if (req.method === "DELETE" && pathname === "/api/calendar-state") {
      const current = await readCalendarState(await currentAccountId(req));
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
        const nextState = await deleteCalendarItemById(requestContext.accountId, calendarItemId, requestContext, context);
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
        scheduleAdminDeleteSideEffects(requestContext.accountId, context, current.items, nextState.items, nextState.account?.timezone);
        const notificationResults = [];
        return json({
          ...publicCalendarState({
            ...nextState,
            notifications: nextState.notifications,
          }),
          notificationResults,
          ...(nextState.warnings?.length ? { warnings: nextState.warnings } : {}),
          diagnostics: {
            code: "BOOKING_DELETE_VERIFY_COMPLETED",
            ...baseDetails,
            route: "GET /api/calendar-state",
            operationOwner: "calendar_reload_verify",
            httpStatus: 200,
            durationMs,
            verificationResult,
            sideEffectsPending: true,
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
      const state = await readCalendarState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      let notificationResults = [];
      let notificationWarning = "";
      try {
        notificationResults = await processAdminNotificationDebounce(
          requestContext.accountId,
          state.items,
          state.items,
          { queueDiffs: false, timeZone: state.account?.timezone },
        );
      } catch (error) {
        notificationWarning =
          "Booking alerts could not be processed.";
        console.error("calendar_state:notification_debounce_failed", error);
      }
      const refreshedState = notificationResults.length ? await readCalendarState(await currentAccountId(req)) : state;
      return json({
        notifications: filterNotificationsForContext(
          await readNotificationHistory(await currentAccountId(req)),
          requestContext,
          refreshedState,
        ),
        notificationResults,
        ...(notificationWarning ? { warnings: [notificationWarning] } : {}),
      });
    }

    if (req.method === "PUT" && pathname === "/api/calendar-sync-key") {
      const body = await parseBody(req);
      const current = await readCalendarState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, current);
      assertAccountAdminContext(requestContext, "You do not have permission to rotate the calendar sync key.");
      return json(
        publicCalendarState(
          await writeCalendarState(requestContext.accountId, {
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
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountAdminContext(requestContext, "You do not have permission to view account settings.");
      return json(await readAdminSettings(await currentAccountId(req)));
    }

    if ((req.method === "PUT" || req.method === "POST") && pathname === "/api/admin-settings") {
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountAdminContext(requestContext, "You do not have permission to change account settings.");
      return json(await writeAdminSettings(await currentAccountId(req), await parseBody(req)));
    }

    if (req.method === "GET" && pathname === "/api/notification-history") {
      // Same split as /api/people: an admin sees the whole account's history
      // without the calendar being read; only a coach-scoped user needs the
      // bookings, to keep to the notifications on their own lessons.
      const settingsState = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, settingsState);
      assertAccountFeature(requestContext.account, "notifications");
      const [notifications, state] = await Promise.all([
        readNotificationHistory(requestContext.accountId),
        requestContext.isAdmin
          ? Promise.resolve(settingsState)
          : readItems(requestContext.accountId).then((items) => ({ ...settingsState, items })),
      ]);
      return json({ notifications: filterNotificationsForContext(notifications, requestContext, state) });
    }

    if (req.method === "POST" && pathname === "/api/booking-confirmation-resend") {
      const body = await parseBody(req);
      const state = await readCalendarState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      return json(await resendBookingConfirmation(body.appointmentId || body.id, requestContext, state));
    }

    if (req.method === "POST" && pathname === "/api/test-email") {
      const body = await parseBody(req);
      const state = await readSettingsState(await currentAccountId(req));
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
        // This route really does send an email, so the sample client is named
        // as what it is. It previously used a real person's name.
        client: "Test Client",
        title: "Test Client",
        email: recipient,
        phone: "",
        note: "Test email from Clarity Golf Booking.",
      };
      const results = await sendBookingNotifications(requestContext.accountId, appointment, {
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

    // Who the coach can become. Sandbox only, and only their own sandbox --
    // this is a read of the same people list the Clients screen shows, filtered
    // to the account the actor already resolved to.
    if (req.method === "GET" && pathname === "/api/sandbox/players") {
      const actor = await currentActor(req);
      const sandbox = await requireSandboxAccount(actor.accountId);
      const people = await readPeople(sandbox.id);
      return json({
        players: people.map((person) => ({
          id: person.id,
          name: cleanString(person.name, "", 180),
          email: cleanEmail(person.email, ""),
        })),
      });
    }

    // Coach -> player, without the email round trip.
    //
    // Everything a real player does to get here -- a welcome email, a link, a
    // password -- is a communication and authentication boundary, and Sandbox
    // replaces boundaries. What it does NOT replace is the workflow: the coach
    // still created this person through the real screens, and the portal this
    // opens is the real portal reading the real tables.
    //
    // Four checks, in this order, all server-side and all against the database:
    //
    //   1. a real coach session resolves                (requireCoachActor, via the gate)
    //   2. the account it acts for IS a sandbox         (requireSandboxAccount)
    //   3. that sandbox belongs to this coach's business
    //   4. the person belongs to that same sandbox
    //
    // Check 2 is what makes this impossible in production rather than merely
    // forbidden: a live account has no sandbox row, so there is nothing it could
    // present that would satisfy the check. There is no sandbox flag to forge
    // because there is no sandbox flag.
    if (req.method === "POST" && pathname === "/api/sandbox/impersonate") {
      const actor = await currentActor(req);
      const sandbox = await requireSandboxAccount(actor.accountId);
      if (!actor.sandboxOfAccountId || sandbox.sandboxOfAccountId !== actor.sandboxOfAccountId) {
        throw forbidden("That sandbox is not yours.", "sandbox_required");
      }

      const body = await parseBody(req);
      const personId = cleanString(body?.personId, "", 160);
      const people = await readPeople(sandbox.id);
      const person = people.find((candidate) => candidate.id === personId);
      if (!person) {
        return json({ error: "unknown_player", message: "That player is not in this sandbox." }, 404);
      }

      // Reuse the portal row when the coach has already promoted them, so the
      // portal behaves exactly as it would for that player -- revocation checks
      // included. A person who has never been promoted is still viewable: being
      // promoted is a workflow to test, not a prerequisite for testing.
      const portalPlayers = await listPortalPlayers(sandbox.id);
      const portalPlayer = portalPlayers.find((candidate) => candidate.personId === person.id);

      // Two hours, not thirty days. A handoff is something a coach is doing
      // right now, and a forgotten one should expire rather than sit in a
      // browser being mistaken for a real login next week.
      const session = await createPlayerSession({
        personId: person.id,
        email: cleanEmail(person.email, "") || cleanEmail(portalPlayer?.email, ""),
        phone: cleanString(person.phone, "", 80),
        accountId: sandbox.id,
        portalPlayerId: portalPlayer?.id || "",
        sandboxActorAuthUser: actor.authUserId,
        lifetimeMs: 2 * 60 * 60 * 1000,
      });

      return json(
        { ok: true, viewingAs: cleanString(person.name, "", 180) },
        200,
        { "Set-Cookie": playerCookieHeader(session.token, req, 2 * 60 * 60) },
      );
    }

    // Does this business have a sandbox, and is this session in it?
    //
    // Answers for the *live* business either way: asked from inside the sandbox
    // it reports the same sandbox, so the shell does not need to know which side
    // it is on to draw the switch.
    if (req.method === "GET" && pathname === "/api/sandbox") {
      const actor = await currentActor(req);
      const parentId = actor.sandboxOfAccountId || actor.accountId;
      const sandbox = await readSandboxForAccount(parentId);
      return json({
        liveAccountId: parentId,
        inSandbox: Boolean(actor.sandboxOfAccountId),
        sandbox: sandbox
          ? { id: sandbox.id, name: sandbox.businessName, planKey: await sandboxPlanKey(sandbox.id) }
          : null,
      });
    }

    // Create it. Owners and admins only: a sandbox is a whole second workspace
    // for the business, not a personal scratch pad, and everyone on the business
    // shares the one that gets made.
    if (req.method === "POST" && pathname === "/api/sandbox") {
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountAdminContext(requestContext, "You do not have permission to create a sandbox workspace.");
      const parentId = requestContext.actor.sandboxOfAccountId || requestContext.accountId;
      const sandbox = await ensureSandboxForAccount(parentId);
      return json({
        ok: true,
        sandbox: { id: sandbox.id, name: sandbox.businessName, planKey: await sandboxPlanKey(sandbox.id) },
      });
    }

    // The plan a sandbox runs on.
    //
    // The account being changed is never named by the request: it is looked up
    // from the caller's own business, so this route can only ever reach that
    // business's sandbox. A live account has no sandbox row to find, so its plan
    // is not editable here -- or anywhere else in the app.
    //
    // Works from either side. Asked from inside the sandbox it resolves the same
    // row, so a coach does not have to leave to change what they are testing.
    if (req.method === "PUT" && pathname === "/api/sandbox/plan") {
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountAdminContext(requestContext, "You do not have permission to change the sandbox plan.");
      const parentId = requestContext.actor.sandboxOfAccountId || requestContext.accountId;
      const sandbox = await readSandboxForAccount(parentId);
      if (!sandbox) {
        return json({ error: "no_sandbox", message: "This business has no sandbox yet." }, 404);
      }
      const body = await parseBody(req);
      const planKey = cleanString(body?.planKey, "", 40);
      if (!accountPlanCatalog[planKey]) {
        return json({ error: "unknown_plan", message: "That is not a plan." }, 400);
      }
      await setSandboxPlanKey(sandbox.id, sandbox.businessName, planKey);
      return json({ ok: true, planKey });
    }

    // Point this session at another of the user's businesses.
    //
    // The account id in the body names a choice, it does not grant one:
    // switchActiveAccount only writes it when account_memberships already says
    // this user holds it. Everything downstream keeps reading the account off
    // the membership, so nothing else in the app has to know this route exists.
    if (req.method === "POST" && pathname === "/api/workspace/switch") {
      const body = await parseBody(req);
      const actor = await switchActiveAccount(req, cleanString(body?.accountId, "", 120));
      return json({
        ok: true,
        accountId: actor.accountId,
        accountRole: actor.role,
      });
    }

    if (req.method === "GET" && pathname === "/api/coach-account") {
      return json(await readCoachAccount(await currentAccountId(req)));
    }

    if (req.method === "PUT" && pathname === "/api/coach-account") {
      const body = await parseBody(req);
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountAdminContext(requestContext, "You do not have permission to change business account settings.");
      if (body?.invoiceSettings?.enabled) assertAccountFeature(requestContext.account, "invoicing");
      return json(await writeCoachAccount(await currentAccountId(req), body));
    }

    if (req.method === "GET" && pathname === "/api/services") {
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      return json({
        services: state.services.filter((service) => serviceBelongsToContext(service, requestContext, state.coaches)),
      });
    }

    if (req.method === "PUT" && pathname === "/api/services") {
      const body = await parseBody(req);
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "services");
      const nextServices = mergeServicesForContext(body.services || [], state.services, requestContext, state.coaches);
      const savedServices = await writeServices(requestContext.accountId, nextServices, requestContext);
      return json({
        services: savedServices.filter((service) => serviceBelongsToContext(service, requestContext, state.coaches)),
      });
    }

    if (req.method === "GET" && pathname === "/api/locations") {
      const state = await readColdSetupState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      return json({ locations: filterLocationsForContext(state.locations, requestContext, state.coaches) });
    }

    if (req.method === "PUT" && pathname === "/api/locations") {
      const body = await parseBody(req);
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountAdminContext(requestContext, "You do not have permission to manage locations.");
      return json({ locations: await writeLocations(requestContext.accountId, body.locations, requestContext) });
    }

    if (req.method === "GET" && pathname === "/api/coaches") {
      const state = await readColdSetupState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      return json({
        coaches: filterCoachesForContext(state.coaches, requestContext),
        currentUser: requestContext.user,
      });
    }

    if (req.method === "PUT" && pathname === "/api/coaches") {
      const body = await parseBody(req);
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountAdminContext(requestContext, "You do not have permission to manage coaches.");
      return json({ coaches: await writeCoachProfiles(requestContext.accountId, body.coaches, requestContext) });
    }

    if (req.method === "GET" && pathname === "/api/availability") {
      const state = await readSettingsState(await currentAccountId(req));
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
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      const nextAvailability = mergeAvailabilityForContext(
        body.availability || [],
        state.availability,
        requestContext,
        defaultCoachId(state.coaches),
      );
      const savedAvailability = await writeAvailability(requestContext.accountId, nextAvailability, requestContext);
      // Unavailable blocks in Google are derived from availability, so a change
      // here is the only thing that can move them. The targeted change path
      // cannot express it — it works from calendar item diffs — so this takes
      // the full rebuild, deferred like every other save's sync.
      deferGoogleCalendarAvailabilitySync(requestContext.accountId, context);
      const fallbackCoachId = defaultCoachId(state.coaches);
      return json({
        availability: savedAvailability.map((dayWindows) =>
          dayWindows.filter((window) => availabilityWindowBelongsToContext(window, requestContext, fallbackCoachId)),
        ),
      });
    }

    if (req.method === "GET" && pathname === "/api/brand-settings") {
      return json(await readBrandSettings(await currentAccountId(req)));
    }

    if (req.method === "PUT" && pathname === "/api/brand-settings") {
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountAdminContext(requestContext, "You do not have permission to change brand settings.");
      assertAccountFeature(requestContext.account, "customBranding");
      return json(await writeBrandSettings(await currentAccountId(req), await parseBody(req)));
    }

    if (req.method === "GET" && pathname === "/api/people") {
      // The list, and only the list. This used to begin with a full
      // readCalendarState -- every booking, every notification, the Google
      // status -- to answer a request for names and phone numbers, which made
      // the "cheap background" read of the client list cost as much as the
      // calendar shell. An admin sees every client of the business, so the
      // calendar is not consulted at all; a coach-scoped user sees the clients
      // on their own lessons, which is the one case that needs the bookings.
      const settingsState = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, settingsState);
      assertAccountFeature(requestContext.account, "clients");
      const people = await readPeople(requestContext.accountId);
      const state = requestContext.isAdmin
        ? settingsState
        : { ...settingsState, items: await readItems(requestContext.accountId) };
      return json({ people: filterPeopleForContext(people, requestContext, state) });
    }

    // --- Portal access (admin) ---------------------------------------------
    // Granting is the coach's decision, made per player in Player Profiles.
    if (req.method === "GET" && pathname === "/api/portal-players") {
      // Settings only, for the same reason as /api/notes above.
      const requestContext = await resolveBackendRequestContext(req, await readSettingsState(await currentAccountId(req)));
      assertAccountFeature(requestContext.account, "clients");
      return json({ portalPlayers: await listPortalPlayers(requestContext.accountId) });
    }

    // POST both grants access and resends the invite -- for a player who
    // already has a row it just issues a fresh set-password link.
    if (req.method === "POST" && pathname === "/api/portal-players") {
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "clients");
      const body = await parseBody(req);
      const result = await grantPortalAccess({
        req,
        personId: body?.personId || body?.playerId || "",
        accountId: requestContext.accountId,
        includeCaddyPass: body?.includeCaddyPass === true,
      });
      return json({ ok: true, ...result });
    }

    // Adding a guest sender to the player list. The whole connect-coach flow:
    // merge or create the person, grant portal access exactly as the manual
    // button does, then re-point their already-sent videos at the new person
    // and stop the retention clock.
    //
    // Name and email come from the guest_senders row, never the request body.
    // Taking them from the body would turn the coach's own UI into an
    // arbitrary-person-creation endpoint.
    if (req.method === "POST" && pathname === "/api/guest-players") {
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "clients");
      const body = await parseBody(req);
      const guestSenderId = cleanString(body?.guestSenderId, "", 80);
      await ensureGuestSendersTable();
      const rows = await db().sql`
        SELECT * FROM guest_senders
        WHERE id = ${guestSenderId} AND account_id = ${requestContext.accountId}
        LIMIT 1
      `;
      const guest = rows[0];
      if (!guest) {
        return json({ error: "not_found", message: "That sender is not in this account." }, 404);
      }

      // updatePerson runs compatiblePersonMatch internally, so a guest who is
      // already a client under the same name and email merges into that row
      // rather than creating a duplicate.
      const saved = await updatePerson(
        { name: guest.name, email: guest.email, source: "guest_submission" },
        requestContext.accountId,
      );
      const personId = saved?.person?.id || "";
      if (!personId) {
        return json({ error: "invalid", message: "Could not create that player." }, 400);
      }

      const result = await grantPortalAccess({
        req,
        personId,
        accountId: requestContext.accountId,
        includeCaddyPass: body?.includeCaddyPass === true,
      });

      const claimed = await claimGuestSubmissions({
        guestSenderId,
        personId,
        portalPlayerId: result?.portalPlayer?.id || "",
        accountId: requestContext.accountId,
      });

      return json({ ok: true, personId, claimed, ...result });
    }

    // The Caddy card on a Booking player profile. Read-only, and it never
    // fails the page: an unreachable Caddy comes back as unavailable.
    if (req.method === "GET" && pathname === "/api/caddy-status") {
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "clients");
      const personId = cleanString(url.searchParams.get("personId"), "", 160);
      const portalPlayers = await listPortalPlayers(requestContext.accountId);
      const portalPlayer = portalPlayers.find(
        (entry) => entry.personId === personId && entry.status !== "disabled",
      );
      if (!portalPlayer) {
        return json({ ok: true, status: { connected: false, access: "none", unavailable: "no_portal_access" } });
      }
      const status = await readCaddyPlayerStatus(portalPlayer.authUserId, portalPlayer.email);
      return json({
        ok: true,
        status,
        deepLink: status.connected ? caddyPlayerDeepLink(portalPlayer.authUserId) : "",
      });
    }

    if (req.method === "DELETE" && pathname === "/api/portal-players") {
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "clients");
      const portalPlayerId =
        cleanString(url.searchParams.get("id"), "", 80) ||
        cleanString((await parseBody(req))?.id, "", 80);
      const portalPlayer = await revokePortalAccess({
        portalPlayerId,
        accountId: requestContext.accountId,
      });
      return json({ ok: true, portalPlayer });
    }

    if (req.method === "GET" && pathname === "/api/notes") {
      // Settings only: nothing below reads the calendar, and Player Profiles
      // waits on this answer before it can list anyone.
      const requestContext = await resolveBackendRequestContext(req, await readSettingsState(await currentAccountId(req)));
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
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "clients");
      const result = await upsertLessonNote(body.note || body, requestContext.accountId);
      return json(result, req.method === "POST" ? 201 : 200);
    }

    if (req.method === "DELETE" && pathname === "/api/notes") {
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "clients");
      const noteId = cleanString(url.searchParams.get("id"), "", 120);
      return json(await deleteLessonNote(noteId, requestContext.accountId));
    }

    // Practice Blocks -- the coach's side. /api/practice-blocks/complete (the
    // player's side) lives further up, alongside the other player-session
    // routes, since it authenticates differently and must run before the
    // blanket requireAdmin gate below.
    if (req.method === "GET" && pathname === "/api/practice-blocks") {
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "clients");
      const playerId = cleanString(url.searchParams.get("playerId"), "", 160);
      if (!playerId) {
        return json({ error: "invalid", message: "A player id is required." }, 400);
      }
      return json({ blocks: await readPracticeBlocksForPlayer(requestContext.accountId, playerId) });
    }

    if (req.method === "POST" && pathname === "/api/practice-blocks") {
      const body = await parseBody(req);
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "clients");
      const result = await createPracticeBlock(body.block || body, requestContext);
      return json(result, 201);
    }

    if (req.method === "PUT" && pathname === "/api/practice-blocks") {
      const body = await parseBody(req);
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "clients");
      const result = await updatePracticeBlock(body.id || body.block?.id, body.block || body, requestContext);
      return json(result);
    }

    if (req.method === "DELETE" && pathname === "/api/practice-blocks") {
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "clients");
      const blockId = cleanString(url.searchParams.get("id"), "", 120);
      return json(await archivePracticeBlock(blockId, requestContext));
    }

    // Passes -- the coach's side. The engine itself is in _shared/passes.mts;
    // what lives here is only the route, the account resolution and the feature
    // gate, so that the credit arithmetic stays somewhere typed.
    //
    // The GET answers with the templates as well as the passes. A pass template
    // is a `package` service inside the settings blob, so working out which
    // services qualify is a server-side decision, and returning it here saves
    // the profile a second round trip on a cold instance.
    if (req.method === "GET" && pathname === "/api/passes") {
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "clients");
      const personId = cleanString(url.searchParams.get("personId"), "", 160);
      if (!personId) {
        return json({ error: "invalid", message: "A person id is required." }, 400);
      }
      const passes = await readPassesForPerson(requestContext.accountId, personId);
      // Only for the profile's own read. A checkout naming a serviceId is
      // asking "can this person pay with a pass", and answering it with three
      // hundred invoice lines would put a billing query on the booking path
      // for a screen that never shows them.
      const invoiced = url.searchParams.get("serviceId")
        ? { invoicedLines: [], unmatchedInvoicedLines: [] }
        : await readInvoicedLessonsForPerson(requestContext.accountId, personId, passes);
      // A checkout asks about one service, and whether a pass covers it is the
      // server's answer to give -- the browser must not be deciding what a
      // credit is allowed to buy.
      const serviceId = cleanString(url.searchParams.get("serviceId"), "", 120);
      const service = serviceId
        ? (state.services || []).find((entry) => entry.id === serviceId)
        : null;
      const settingsMap = serviceId ? await readSettingsMap(requestContext.accountId) : null;
      const currency = settingsMap ? playerShopCurrency(settingsMap) : "";
      const flexibleValueCents = serviceId
        ? await readFlexibleValueForPerson(requestContext.accountId, personId, currency)
        : 0;
      return json({
        passes,
        ...invoiced,
        flexibleValueCents,
        currency: currency || undefined,
        templates: passTemplatesFromServices(state.services),
        // Everything a pass could be told to cover, so a free-form grant can
        // say what it is for. Packages are excluded: a pass that covers a pass
        // is not a thing.
        coverableServices: (state.services || [])
          .filter((entry) => entry.lessonFormat !== "package" && entry.active !== false)
          .map((entry) => ({ id: entry.id, name: entry.name })),
        ...(serviceId
          ? {
              options: passOptionsForService(passes, serviceId, service?.name || "", {
                serviceValueCents: Math.max(0, Math.round(Number(service?.price || 0) * 100)),
                currency,
                acceptsCrossRedemption: service?.acceptsCrossRedemption !== false,
                flexibleValueCents,
              }),
            }
          : {}),
      });
    }

/* --- What a client was billed for, beside what they hold -----------------
 *
 * A pass is created under somebody's name by hand: a coach knows they sold ten
 * lessons and records ten credits. The invoice that took the money is a
 * separate record, written by a separate route -- typed onto a Clarity invoice,
 * or synced in from Stripe -- and nothing joins the two. There is no id in
 * common, because at the moment either was written the other did not exist.
 *
 * So the join is the wording, and it is only ever evidence. Nothing here
 * issues a credit, spends one or reconciles anything. It puts "you gave them
 * ten" next to "you billed them for ten" and lets the coach see whether those
 * agree -- which is a question they currently answer by opening two screens
 * and counting.
 *
 * WHY THE EMAIL PATH MATTERS
 *
 * A Clarity invoice carries the client's own id, so it is found directly. A
 * Stripe-synced one carries the *Stripe* customer (cus_...), which is not a
 * person here and never will be, so those are found by the address on the
 * invoice instead. Leaving that path out would silently hide every online
 * sale -- exactly the ones a coach is least able to check from memory.
 */
async function readInvoicedLessonsForPerson(accountId: string, personId: string, passes) {
  if (!personId) return { invoicedLines: [], unmatchedInvoicedLines: [] };
  if (!(await tableExists("billing_invoices")) || !(await tableExists("billing_invoice_items"))) {
    return { invoicedLines: [], unmatchedInvoicedLines: [] };
  }
  const hasLinks = await tableExists("billing_booking_invoice_links");

  const rows = (await db().sql`
    WITH person AS (
      SELECT
        NULLIF(lower(COALESCE(email, '')), '') AS email,
        COALESCE(name, '') AS name
      FROM people
      WHERE account_id = ${accountId} AND id = ${personId}
      LIMIT 1
    ),
    theirs AS (
      SELECT
        invoice.id,
        invoice.invoice_number,
        invoice.status,
        invoice.currency,
        invoice.issue_date,
        invoice.customer_name,
        -- How this invoice was tied to them, kept because the three are not
        -- equally certain. "billed" is their own client id on the invoice;
        -- "matched" is an address that agreed; "included" is a bulk invoice
        -- addressed to somebody else that contains one of their lessons.
        CASE
          WHEN invoice.customer_id = ${personId} THEN 'billed'
          WHEN invoice.customer_email IS NOT NULL
            AND lower(invoice.customer_email) = (SELECT email FROM person) THEN 'matched'
          ELSE 'included'
        END AS relation
      FROM public.billing_invoices invoice
      WHERE invoice.account_id = ${accountId}
        AND invoice.status <> 'void'
        AND (
          invoice.customer_id = ${personId}
          OR (
            invoice.customer_email IS NOT NULL
            AND (SELECT email FROM person) IS NOT NULL
            AND lower(invoice.customer_email) = (SELECT email FROM person)
          )
          OR (
            ${hasLinks}
            AND EXISTS (
              SELECT 1
              FROM public.billing_booking_invoice_links link
              JOIN public.calendar_items booking
                ON booking.id = link.booking_id AND booking.account_id = link.account_id
              WHERE link.invoice_id = invoice.id
                AND link.account_id = ${accountId}
                AND booking.person_id = ${personId}
            )
          )
        )
    )
    SELECT
      item.id,
      item.invoice_id,
      item.description,
      item.quantity,
      item.line_total,
      item.service_date,
      theirs.invoice_number,
      theirs.status,
      theirs.currency,
      theirs.issue_date,
      theirs.customer_name,
      theirs.relation,
      -- Present only when the line was pulled from a booking, in which case it
      -- is this person's booking: the join says so, and the WHERE below drops
      -- every line whose booking belongs to somebody else. Read in JS to tell
      -- a line that has been proven theirs from one nothing vouches for.
      owner.person_id AS booking_person_id,
      (SELECT name FROM person) AS person_name
    FROM public.billing_invoice_items item
    JOIN theirs ON theirs.id = item.invoice_id
    -- A pulled lesson carries its booking id in source_id, and the booking
    -- carries the person who had the lesson. On a bulk invoice that is the only
    -- thing that separates this client's lines from the other fourteen.
    LEFT JOIN public.calendar_items owner
      ON item.source_type = 'booking'
      AND owner.id = item.source_id
      AND owner.account_id = ${accountId}
    WHERE item.account_id = ${accountId}
      AND item.line_total > 0
      -- Done here rather than after the fetch so the row limit is spent on
      -- lines that could be theirs.
      AND (owner.person_id IS NULL OR owner.person_id = ${personId})
    ORDER BY theirs.issue_date DESC, item.id
    LIMIT 300
  `) as Record<string, unknown>[];

  // Newest pass first, so a repeat purchase of the same package lands against
  // the one still being used rather than the exhausted one behind it.
  const candidates = [...(passes || [])]
    .filter((pass) => pass.status !== "void")
    .map((pass) => ({ id: String(pass.id), name: String(pass.name || "") }))
    .filter((pass) => pass.name);

  const invoicedLines: Record<string, unknown>[] = [];
  const unmatchedInvoicedLines: Record<string, unknown>[] = [];
  for (const row of rows) {
    const description = cleanString(row.description, "", 500);
    const relation = cleanString(row.relation, "", 20);
    // Lines the booking join vouched for are theirs and need no wording test.
    // Everything else on somebody else's invoice has to name them.
    if (
      !cleanString(row.booking_person_id, "", 160) &&
      !unlinkedLineBelongsToPerson(relation, description, cleanString(row.person_name, "", 140))
    ) {
      continue;
    }
    const line = {
      id: String(row.id || ""),
      invoiceId: cleanString(row.invoice_id, "", 200),
      invoiceNumber: cleanString(row.invoice_number, "", 60),
      invoiceStatus: cleanString(row.status, "", 20),
      billedTo: cleanString(row.customer_name, "", 140),
      relation,
      description,
      quantity: Math.max(1, Math.round(Number(row.quantity) || 1)),
      amountCents: Math.max(0, Math.round((Number(row.line_total) || 0) * 100)),
      currency: cleanString(row.currency, "", 10),
      // The date the work happened when the line says so, because that is what
      // a coach is comparing against; the invoice date otherwise.
      when: cleanString(row.service_date, "", 40) || cleanString(row.issue_date, "", 40),
    };
    const best = bestPassForLine(description, candidates);
    if (best) invoicedLines.push({ ...line, passId: best.pass.id, strength: best.strength });
    else unmatchedInvoicedLines.push(line);
  }
  return { invoicedLines, unmatchedInvoicedLines };
}

/* --- The Pass Inbox ------------------------------------------------------
 *
 * Two queues that look the same on screen and are not the same problem.
 *
 *   Waiting to be issued  An external sale that classified as a lesson pass
 *                         and has produced no pass. Somebody paid and holds
 *                         nothing. What is missing is which package it was --
 *                         the sale names a product, not a credit count.
 *
 *   Waiting for an owner   A pass that exists and belongs to nobody. What is
 *                         missing is a person.
 *
 * Neither is resolved automatically, and the reason is the same in both cases:
 * the payload cannot answer it, so a machine answering it is a machine
 * guessing. What this does instead is pre-fill the guess and make pressing the
 * button cheap.
 *
 * WHY STRIPE SALES ARE NOT HERE
 *
 * They were, briefly, in September 2026. Reading them worked -- the lines are
 * already in billing_invoice_items -- but issuing from them did not, because a
 * Stripe line is an invoice for a lesson, not the purchase of a package. There
 * was nothing in a row to turn into a credit count, so every row arrived with
 * an empty dropdown and a coach filling it in from memory. A queue whose rows
 * cannot be dispatched is not a queue.
 *
 * The lines are genuinely useful, just not as work: they are the record of
 * what somebody was billed for, and what that is worth is being able to hold
 * it against a pass issued under their name. So they moved to the client's
 * Passes tab as evidence -- see readInvoicedLessonsForPerson -- where nothing
 * is pending and the coach is reconciling rather than dispatching.
 *
 * Gift vouchers bought through Stripe get their own route, separately.
 */

/** Where "this product is never an entitlement" is remembered, per account. */
function passInboxDismissedTypesKey(accountId: string) {
  return `passInbox.dismissedTypes.v1.${cleanSlug(accountId, "default")}`;
}

/*
 * Product types the coach has said are not entitlements.
 *
 * Dismissal is by product, not by purchase, and that is the whole point. A
 * per-row dismissal means next month's bay-hire line is back in the queue and
 * the queue is never empty, which is how a screen stops being opened. The
 * coach's actual intent -- "Extra Hour is not a pass" -- is a fact about the
 * product that stays true for every sale of it.
 *
 * A settings key rather than a column, because the fact is about a product
 * nothing in Clarity owns: the line is a description on a Stripe invoice, and
 * there is no catalogue row to hang a flag on. Same shape, and for the same
 * reason, as practice.dismissedSuggestions.
 *
 * Stored as {type, label} pairs. The type is what matching runs on and it is
 * unreadable by design -- "1xextrahour" -- so the wording that was dismissed
 * is kept beside it. Without that, the list offering to undo a dismissal could
 * only show the key, and "1xextrahour · Show again" asks the coach to
 * recognise something they never typed.
 *
 * Bare strings are still read, because that is what the first version wrote.
 */
async function readPassInboxDismissedTypes(accountId: string): Promise<Map<string, string>> {
  const parsed = safeJsonParse(await getSetting(accountId, passInboxDismissedTypesKey(accountId)), []);
  const dismissed = new Map<string, string>();
  if (!Array.isArray(parsed)) return dismissed;
  for (const entry of parsed) {
    const label = cleanString(
      typeof entry === "string" ? entry : (entry as Record<string, unknown>)?.label,
      "",
      200,
    );
    const type = inboxLineType(
      typeof entry === "string" ? entry : cleanString((entry as Record<string, unknown>)?.type, "", 200),
    );
    if (type) dismissed.set(type, label || type);
  }
  return dismissed;
}

async function writePassInboxDismissedType(accountId: string, description: string, restore: boolean) {
  const raw = cleanString(description, "", 200);
  const type = inboxLineType(raw);
  if (!type) throw Object.assign(new Error("Which product?"), { status: 400 });
  const dismissed = await readPassInboxDismissedTypes(accountId);
  // Restoring accepts the key as readily as the wording, because that is what
  // the undo list has to hand.
  if (restore) dismissed.delete(type);
  else dismissed.set(type, raw);
  // Capped for the same reason the practice list is: a coach dismissing
  // steadily for a year must not grow a settings row without bound. Oldest
  // fall off first, which only means a long-forgotten product is offered again.
  const kept = Array.from(dismissed, ([key, label]) => ({ type: key, label })).slice(-300);
  await setSetting(accountId, passInboxDismissedTypesKey(accountId), JSON.stringify(kept));
  return kept;
}

async function readPassInbox(accountId: string, services) {
  const templates = passTemplatesFromServices(services);
  const dismissed = await readPassInboxDismissedTypes(accountId);
  const dismissedKeys = new Set(dismissed.keys());
  const purchases = (await tableExists("optix_pass_purchases"))
    ? ((await db().sql`
        SELECT id, provider, sale_number, member_name, member_email, person_id,
               person_link_source, item_name, quantity, amount_cents, currency,
               purchased_at, classification
        FROM public.optix_pass_purchases
        WHERE account_id = ${accountId}
          AND classification IN ('pass', 'unknown')
        ORDER BY purchased_at DESC
        LIMIT 100
      `) as Record<string, unknown>[])
    : [];

  // Asked of the passes table rather than tracked on the purchase, so the
  // inbox and the unique index that actually prevents double-issuing can never
  // disagree about what has been issued.
  const issued = await issuedSourceRefs(
    accountId,
    "optix",
    purchases.map((row) => `optix:${String(row.id || "")}`),
  );

  const people = new Map<string, string>();
  const personIds = [...new Set(purchases.map((row) => String(row.person_id || "")).filter(Boolean))];
  if (personIds.length) {
    const rows = (await db().sql`
      SELECT id, name FROM people WHERE account_id = ${accountId} AND id = ANY(${personIds})
    `) as Record<string, unknown>[];
    for (const row of rows) people.set(String(row.id), String(row.name || ""));
  }

  const optixRows = purchases
    .filter((row) => !issued.has(`optix:${String(row.id || "")}`))
    .map((row) => {
      const itemName = cleanString(row.item_name, "", 200);
      const suggestion = suggestPassTemplate(itemName, templates);
      const personId = cleanString(row.person_id, "", 160);
      const classification = cleanString(row.classification, "unknown", 20);
      return {
        id: String(row.id || ""),
        provider: cleanString(row.provider, "optix", 40),
        // Optix purchases were classified on arrival and only ever as passes.
        // The wording classifier is applied on top so a gift voucher sold
        // through Optix reaches the same button a Stripe one does.
        kind: classification === "unknown" ? classifyInboxLine(itemName) : "pass",
        saleNumber: cleanString(row.sale_number, "", 60),
        itemName,
        quantity: Number(row.quantity || 1) || 1,
        amountCents: row.amount_cents === null ? null : Number(row.amount_cents),
        currency: cleanString(row.currency, "", 10),
        purchasedAt: cleanString(row.purchased_at, "", 80),
        buyerName: cleanString(row.member_name, "", 180),
        buyerEmail: cleanString(row.member_email, "", 200),
        personId,
        personName: people.get(personId) || "",
        // How the buyer was tied to that person, so "matched on a name" is
        // never mistaken on screen for "matched on an email".
        personLinkSource: cleanString(row.person_link_source, "", 20),
        classification,
        suggestedTemplateServiceId: suggestion.template?.serviceId || "",
        suggestedTemplateName: suggestion.template?.name || "",
        suggestionConfidence: suggestion.confidence,
      };
    })
    .filter((row) => !isDismissedLine(row.itemName, dismissedKeys));

  return {
    templates,
    waitingToIssue: optixRows,
    dismissedTypes: Array.from(dismissed, ([type, label]) => ({ type, label })),
    waitingForOwner: (await readUnassignedPasses(accountId)).map((pass) => ({
      id: pass.id,
      name: pass.name,
      creditsAvailable: pass.creditsAvailable,
      creditsAllocated: pass.creditsAllocated,
      expiresAt: pass.nextExpiry || pass.expiresAt,
      source: pass.source,
      note: pass.note,
      issuedAt: pass.issuedAt,
    })),
  };
}

    /* --- Card payments: whose Stripe account this business uses -----------
     *
     * Its own route rather than a field on the settings payload, for two
     * reasons. A secret key must never travel in the same body as a pile of
     * notification toggles -- a block that PUTs a stale whole-object draft
     * would wipe it. And the read has to be asymmetric: this answers with a
     * status and a masked tail, never with the key, so there is no shape of
     * response that could leak it into a browser.
     *
     * Leaving the field empty is how a business goes back to being billed
     * through the platform's account. That is a real choice, not a failure to
     * configure, so clearing is allowed and says so.
     */
    if (req.method === "GET" && pathname === "/api/payments/stripe") {
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "invoicing");
      const settingsMap = await readSettingsMap(requestContext.accountId);
      return json({ stripe: stripeCredentialStatus(settingsMap[STRIPE_SECRET_SETTING]) });
    }

    if (req.method === "PUT" && pathname === "/api/payments/stripe") {
      const body = await parseBody(req);
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "invoicing");
      const accountId = requestContext.accountId;

      const raw = cleanString(body?.secretKey, "", 200);
      if (raw && !isStripeSecretShaped(raw)) {
        return json(
          {
            error: "invalid_key",
            message:
              "That does not look like a Stripe secret key. It starts sk_ or rk_ — " +
              "a key starting pk_ is the publishable one and cannot take payments.",
          },
          400,
        );
      }

      await setSettingsBulk(accountId, { [STRIPE_SECRET_SETTING]: raw });
      const settingsMap = await readSettingsMap(accountId);
      return json({
        stripe: stripeCredentialStatus(settingsMap[STRIPE_SECRET_SETTING]),
        cleared: !raw,
      });
    }

    // Billing's Passes tab: everything issued, whoever holds it. The inbox
    // below is what is still unfinished; this is what is done.
    if (req.method === "GET" && pathname === "/api/passes/list") {
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "clients");
      return json({ passes: await readIssuedPasses(requestContext.accountId) });
    }

    if (req.method === "GET" && pathname === "/api/passes/inbox") {
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "clients");
      return json(await readPassInbox(requestContext.accountId, state.services));
    }

    /* The sale behind a queue row.
     *
     * A thin read rather than trusting what the browser sends back: the list
     * has been open for who knows how long, and the quantity, price and buyer
     * that decide how many credits get issued must come from the row, not from
     * the payload. Filters on account_id in the SQL, not afterwards.
     */
    async function readInboxSale(accountId: string, purchaseId: string) {
      if (!(await tableExists("optix_pass_purchases"))) return null;
      const rows = (await db().sql`
        SELECT id, item_name, quantity, person_id, member_name, member_email,
               classification, amount_cents, currency
        FROM public.optix_pass_purchases
        WHERE id = ${purchaseId} AND account_id = ${accountId}
        LIMIT 1
      `) as Record<string, unknown>[];
      const purchase = rows[0];
      if (!purchase) return null;
      return {
        provider: "optix" as const,
        sourceRef: `optix:${purchaseId}`,
        itemName: cleanString(purchase.item_name, "", 500),
        quantity: Math.max(1, Number(purchase.quantity || 1) || 1),
        amountCents: purchase.amount_cents === null ? null : Number(purchase.amount_cents),
        currency: cleanString(purchase.currency, "", 10),
        personId: cleanString(purchase.person_id, "", 160),
      };
    }

    /* Turn a sale into a pass, or say it is not one.
     *
     * The template is named by the caller, never inferred here. readPassInbox
     * suggests one and says how confident it is; committing that suggestion is
     * a click, because a wrong template issues real spendable credits for the
     * wrong number of lessons and nothing downstream can tell.
     *
     * The sale's own id is the source ref, so the unique index makes a
     * double-tap -- or two coaches on the same queue -- idempotent rather than
     * a second pass.
     */
    if (req.method === "POST" && pathname === "/api/passes/inbox") {
      const body = await parseBody(req);
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "clients");
      const accountId = requestContext.accountId;
      const action = cleanString(body?.action, "", 20);

      /* "Never a pass" -- a whole product waved away rather than one sale.
       *
       * Handled before the sale is looked up, and deliberately: the type is
       * the product's wording, which the coach can dismiss from a row that is
       * about to stop existing. It is also the only action here that can be
       * undone, so it carries a restore rather than needing a support request.
       */
      if (action === "dismissType" || action === "restoreType") {
        await writePassInboxDismissedType(
          accountId,
          cleanString(body?.itemName, "", 500),
          action === "restoreType",
        );
        return json(await readPassInbox(accountId, state.services));
      }

      const purchaseId = cleanString(body?.purchaseId, "", 220);
      if (!purchaseId) return json({ error: "invalid", message: "Which purchase?" }, 400);
      const sale = await readInboxSale(accountId, purchaseId);
      if (!sale) return json({ error: "not_found", message: "That purchase was not found." }, 404);

      // "Not a pass", for this one sale. Writes back to the purchase, which is
      // where the classifier's own output lives, so a wrong guess is corrected
      // rather than merely hidden. The product-level answer is dismissType
      // above -- the one to reach for when the product will be sold again.
      if (action === "dismiss") {
        await db().sql`
          UPDATE public.optix_pass_purchases
          SET classification = 'not_pass', is_pass = FALSE, updated_at = NOW()
          WHERE id = ${purchaseId} AND account_id = ${accountId}
        `;
        return json(await readPassInbox(accountId, state.services));
      }

      const templates = passTemplatesFromServices(state.services);
      const templateServiceId = cleanString(body?.templateServiceId, "", 120);
      const template = templates.find((entry) => entry.serviceId === templateServiceId);
      if (!template) {
        return json(
          { error: "invalid", message: "Pick which package this sale was, so the credits are right." },
          400,
        );
      }

      const quantity = sale.quantity;
      const passValue = resolveInboxPassValue({
        typed: body?.totalValueCents,
        purchaseCents: sale.amountCents,
        purchaseCurrency: cleanString(sale.currency, "", 3),
        templatePriceCents: template.priceCents,
        quantity,
        accountCurrency: playerShopCurrency(await readSettingsMap(accountId)),
      });

      await grantPass(
        {
          // The buyer was resolved when the purchase was recorded, or from the
          // invoice's email just now. Null is legitimate and lands in the other
          // half of this queue rather than blocking the issue -- the
          // entitlement is real either way.
          personId: sale.personId,
          templateServiceId: template.serviceId,
          credits: template.credits * quantity,
          source: sale.provider,
          sourceRef: sale.sourceRef,
          // Both halves or neither -- never a number with no currency, which is
          // what a 0.00 Optix sale used to produce and what refused the issue.
          totalValueCents: passValue?.cents,
          currency: passValue?.currency,
          entitlementServiceId:
            template.coversServiceIds.length === 1 ? template.coversServiceIds[0] : undefined,
          note: `Optix sale · ${sale.itemName.slice(0, 200)}`,
          allowUnassigned: true,
        },
        templates,
        { accountId, actorId: requestContext.userId || requestContext.user?.email || "" },
      );

      return json(await readPassInbox(accountId, state.services));
    }

    if (req.method === "POST" && pathname === "/api/passes/attach") {
      const body = await parseBody(req);
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "clients");
      await assignPass(
        cleanString(body?.passId, "", 120),
        cleanString(body?.personId, "", 160),
        {
          accountId: requestContext.accountId,
          actorId: requestContext.userId || requestContext.user?.email || "",
        },
      );
      return json(await readPassInbox(requestContext.accountId, state.services));
    }

    if (req.method === "POST" && pathname === "/api/passes") {
      const body = await parseBody(req);
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "clients");
      const result = await grantPass(body.grant || body, passTemplatesFromServices(state.services), {
        accountId: requestContext.accountId,
        actorId: requestContext.userId || requestContext.user?.email || "",
      });
      return json(result, 201);
    }

    /* Spend a credit by hand, and hand one back.
     *
     * Both exist because the calendar is not a complete record of what was
     * coached. A lesson that happened but was never booked leaves the balance
     * one too high, and correcting it used to mean voiding the pass and
     * granting a smaller one -- rewriting what somebody was given to fix what
     * they have used.
     *
     * The reversal is restricted to redemptions with no booking behind them,
     * and that restriction is the important part. A credit taken to pay for a
     * lesson is tied to that lesson's paid state; handing it back here would
     * return the credit and leave the booking still showing as settled, with
     * nothing on either record admitting they disagree. The way to undo one of
     * those is to cancel the lesson, which sweepReturnableCredits already
     * answers.
     */
    if (req.method === "POST" && pathname === "/api/passes/redeem") {
      const body = await parseBody(req);
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "clients");
      const personId = cleanString(body?.personId, "", 160);
      await redeemPassManually({
        accountId: requestContext.accountId,
        passId: cleanString(body?.passId, "", 120),
        credits: Number(body?.credits) || 1,
        note: cleanString(body?.note, "", 300),
        actorId: requestContext.userId || requestContext.user?.email || "",
      });
      return json({ passes: await readPassesForPerson(requestContext.accountId, personId) });
    }

    if (req.method === "POST" && pathname === "/api/passes/redeem/reverse") {
      const body = await parseBody(req);
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "clients");
      const accountId = requestContext.accountId;
      const personId = cleanString(body?.personId, "", 160);
      const redemptionId = cleanString(body?.redemptionId, "", 120);
      if (!redemptionId) return json({ error: "invalid", message: "Which redemption?" }, 400);

      // Read before reversing, and scoped to the account in the SQL: the id
      // came from a browser, and "is this one of mine, and is it a hand-written
      // one" are the two questions that have to be answered from the row.
      const rows = (await db().sql`
        SELECT booking_id, reversed_at
        FROM public.pass_redemptions
        WHERE id = ${redemptionId} AND account_id = ${accountId}
        LIMIT 1
      `) as Record<string, unknown>[];
      const redemption = rows[0];
      if (!redemption) return json({ error: "not_found", message: "That entry was not found." }, 404);
      if (redemption.reversed_at) {
        return json({ error: "already_reversed", message: "That credit has already been returned." }, 409);
      }
      if (redemption.booking_id) {
        return json(
          {
            error: "booking_backed",
            message:
              "That credit paid for a lesson. Cancel the lesson to hand it back, " +
              "so the booking stops showing as paid at the same time.",
          },
          409,
        );
      }

      await reversePassRedemption(
        accountId,
        redemptionId,
        cleanString(body?.reason, "Returned by hand", 300),
        requestContext.userId || requestContext.user?.email || "",
      );
      return json({ passes: await readPassesForPerson(accountId, personId) });
    }

    if (req.method === "DELETE" && pathname === "/api/passes") {
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "clients");
      const result = await voidPass(
        cleanString(url.searchParams.get("id"), "", 120),
        cleanString(url.searchParams.get("reason"), "", 300),
        {
          accountId: requestContext.accountId,
          actorId: requestContext.userId || requestContext.user?.email || "",
        },
      );
      return json(result);
    }

    // Presets and "used often" suggestions -- what the composer offers before
    // the coach types anything. One GET returns both; playerId is optional and
    // only narrows the suggestions (it drops what that player already has
    // active), so a call without it is still valid.
    if (req.method === "GET" && pathname === "/api/practice-block-presets") {
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "clients");
      const playerId = cleanString(url.searchParams.get("playerId"), "", 160);
      return json(await readPracticeComposerStarters(requestContext.accountId, playerId));
    }

    if (req.method === "POST" && pathname === "/api/practice-block-presets") {
      const body = await parseBody(req);
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "clients");
      return json(await savePracticeBlockPreset(body.preset || body, requestContext), 201);
    }

    // Rename a favourite, or hand back the whole rail in a new order. Both are
    // edits to the rail rather than to any block, so both are PUT here.
    if (req.method === "PUT" && pathname === "/api/practice-block-presets") {
      const body = await parseBody(req);
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "clients");
      return json(await updatePracticeBlockPreset(body.preset || body, requestContext));
    }

    // Block types -- the account's own list of kinds. Read by the settings
    // screen; the composer gets them free with its starters call above.
    if (req.method === "GET" && pathname === "/api/practice-block-types") {
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "clients");
      return json({ blockTypes: await readPracticeBlockTypes(requestContext.accountId) });
    }

    // The whole list at once, not one type at a time: order matters, ids must
    // stay unique across the set, and "at least one" is a rule about the list
    // rather than about any member of it.
    if (req.method === "PUT" && pathname === "/api/practice-block-types") {
      const body = await parseBody(req);
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "clients");
      return json(await writePracticeBlockTypes(body, requestContext));
    }

    // "Stop offering me this one." Suggestions are derived from assignment
    // history, so hiding one is a preference, not an edit to any block.
    if (req.method === "POST" && pathname === "/api/practice-block-presets/dismiss") {
      const body = await parseBody(req);
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "clients");
      return json(await dismissPracticeSuggestion(body, requestContext));
    }

    if (req.method === "DELETE" && pathname === "/api/practice-block-presets") {
      const state = await readSettingsState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountFeature(requestContext.account, "clients");
      const presetId = cleanString(url.searchParams.get("id"), "", 120);
      return json(await deletePracticeBlockPreset(presetId, requestContext));
    }

	    if (req.method === "POST" && (pathname === "/api/people/import" || pathname === "/api/people/import-lite")) {
	      const body = await parseBody(req);
	      const state = await readCalendarState(await currentAccountId(req));
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
      const state = await readCalendarState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertCanManagePerson(requestContext, body.person || body, state);
	      const result = await updatePerson(body.person || body, requestContext.accountId);
      return json({
        ...result,
        people: filterPeopleForContext(result.people, requestContext, state),
      });
    }

    // Hard delete -- not the ordinary client-management action above. Removes
    // the person and everything scoped to them (bookings, practice blocks,
    // video submissions, lesson notes, portal login, and the Supabase Auth
    // user behind it) with no way back and no notification sent. Account
    // admin only, same gate as importing clients.
    if (req.method === "DELETE" && pathname === "/api/people") {
      const state = await readCalendarState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      assertAccountAdminContext(requestContext, "You do not have permission to delete clients.");
      assertAccountFeature(requestContext.account, "clients");
      const personId =
        cleanString(url.searchParams.get("id"), "", 160) ||
        cleanString((await parseBody(req))?.id, "", 160);
      const result = await hardDeletePerson(personId, requestContext.accountId);
      return json({
        ...result,
        people: filterPeopleForContext(result.people, requestContext, state),
      });
    }

    if (req.method === "POST" && pathname === "/api/people/merge") {
      const body = await parseBody(req);
      const state = await readCalendarState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      const survivorId = cleanString(body?.survivorId, "", 120);
      const loserId = cleanString(body?.loserId, "", 120);
      const knownPeople = await readPeople(requestContext.accountId);
      const survivorRow = knownPeople.find((person) => person.id === survivorId);
      const loserRow = knownPeople.find((person) => person.id === loserId);
      if (!survivorRow || !loserRow) {
        return json(
          { error: "PEOPLE_MERGE_NOT_FOUND", message: "One of the selected clients could not be found." },
          404,
        );
      }
      assertCanManagePerson(requestContext, survivorRow, state);
      assertCanManagePerson(requestContext, loserRow, state);
      const result = await mergePeople(survivorId, loserId, body?.fields || {}, requestContext.accountId);
      return json({
        ok: true,
        ...result,
        people: filterPeopleForContext(result.people, requestContext, state),
      });
    }

    // Moves a client between the external booking clients list and the main
    // client list. A plain flag flip on the same row: bookings, notes and the
    // person id all stay exactly as they are.
    if (req.method === "POST" && pathname === "/api/people/set-external") {
      const body = await parseBody(req);
      const state = await readCalendarState(await currentAccountId(req));
      const requestContext = await resolveBackendRequestContext(req, state);
      const personId = cleanString(body?.personId, "", 120);
      const external = body?.external === true;
      const knownPeople = await readPeople(requestContext.accountId);
      const personRow = knownPeople.find((person) => person.id === personId);
      if (!personRow) {
        return json({ error: "PERSON_NOT_FOUND", message: "That client could not be found." }, 404);
      }
      assertCanManagePerson(requestContext, personRow, state);
      await db().sql`UPDATE people SET external = ${external}, updated_at = NOW() WHERE id = ${personId}`;
      return json({
        ok: true,
        person: { ...personRow, external },
        people: filterPeopleForContext(await readPeople(requestContext.accountId), requestContext, state),
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
