import type { Config, Context } from "@netlify/functions";
import { getDatabase } from "@netlify/database";
import { createHash, randomUUID } from "node:crypto";
import { defaultAccountId as fallbackAccountId, defaultCalendarSlug } from "./_shared/account.mts";
import { activeCurrency } from "./_shared/locale.mts";
import { setActivePhoneCountry } from "./_shared/phone.mts";

type BookingCoreModule = {
  handleBookingApiRoute: (req: Request, forcedPathname?: string, context?: Context) => Promise<Response> | Response;
};

const sessionCookieName = "clarity_session";
const CANCELLED_GROUP_SESSION_TITLE = "Cancelled group session";
const CANCELLED_GROUP_SESSION_NOTE = "__cancelled_group_session__";

const defaultInvoiceSettings = {
  enabled: true,
  showBillingWorkspace: true,
  prefix: "INV",
  nextNumber: 1001,
  currency: activeCurrency(),
  taxName: "GST",
  taxNumber: "",
  taxRate: 15,
  bankAccount: "",
  paymentTermsDays: 7,
  businessAddress: "",
  headerText: "",
  footerText: "Thank you for training with Sam Hale Golf.",
  defaultCustomerNote: "Thanks for your work on the lesson programme. Invoice attached below.",
  paymentInstructions: "Please pay by bank transfer and use the invoice number as reference.",
  customFields: [],
};

const defaultServices = [
  { id: "lesson-30", name: "30min Lesson", duration: 30, price: 100, description: "Price Includes Bay Hire", visibility: "public", active: true, capacity: 1, minParticipants: 1, lessonFormat: "private", priceMode: "session", lessonNote: "Bay hire included", location: "Bay hire included" },
  { id: "lesson-60", name: "1 Hour Golf Lesson", duration: 60, price: 180, description: "Price Includes Bay Hire", visibility: "public", active: true, capacity: 1, minParticipants: 1, lessonFormat: "private", priceMode: "session", lessonNote: "Bay hire included", location: "Bay hire included" },
  { id: "lesson-pair", name: "2 Person Golf Lesson", duration: 60, price: 200, description: "Two-player coaching session", visibility: "public", active: true, capacity: 2, minParticipants: 1, lessonFormat: "private", priceMode: "session", lessonNote: "Bay hire included", location: "Bay hire included" },
  { id: "group-clinic", name: "Group Golf Clinic", duration: 90, price: 55, description: "Small-group coaching session with shared practice goals", visibility: "public", active: true, capacity: 6, minParticipants: 3, lessonFormat: "group", priceMode: "per-person", lessonNote: "Group coaching bay", location: "Group coaching bay", groupSchedule: { dayOfWeek: 2, startMinutes: 18 * 60, occurrenceCount: 8, active: true } },
  { id: "member-30", name: "30min Golf Lesson (Range 24/7 Member)", duration: 30, price: 90, description: "Bay hire is deducted from membership account", visibility: "public", active: true, capacity: 1, minParticipants: 1, lessonFormat: "private", priceMode: "session", lessonNote: "Bay hire deducted from membership account", location: "Range 24/7 member bay" },
  { id: "member-60", name: "1 Hour Golf Lesson (Range 24/7 Member)", duration: 60, price: 160, description: "Bay hire is deducted from membership account", visibility: "public", active: true, capacity: 1, minParticipants: 1, lessonFormat: "private", priceMode: "session", lessonNote: "Bay hire deducted from membership account", location: "Range 24/7 member bay" },
  { id: "package-60", name: "1 hour Lesson - 5 Lesson Package", duration: 60, price: 650, description: "Five one-hour lessons tracked as a package.", visibility: "private", active: true, capacity: 1, minParticipants: 1, lessonFormat: "package", priceMode: "session", lessonNote: "Package allowance", location: "Package allowance", packageAllowance: 5, packageCoverageMode: "upfront", packageCoversServiceId: "lesson-60" },
];

const defaultAvailability = [
  [{ start: 16 * 60 + 30, end: 20 * 60 }],
  [],
  [{ start: 14 * 60, end: 20 * 60 }],
  [{ start: 7 * 60, end: 11 * 60 }, { start: 14 * 60, end: 16 * 60 + 30 }],
  [{ start: 14 * 60, end: 16 * 60 }],
  [],
  [{ start: 15 * 60, end: 18 * 60 }],
];

function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function db() {
  return getDatabase();
}

function safeJsonStringify(value: unknown) {
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

function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (!value || typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function cleanString(value: unknown, fallback = "", max = 1200) {
  return typeof value === "string" ? value.trim().slice(0, max) || fallback : fallback;
}

function cleanSlug(value: unknown, fallback = "") {
  const cleaned = cleanString(value, fallback, 160)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

function cleanEmail(value: unknown, fallback = "") {
  const email = cleanString(value, fallback, 180).toLowerCase();
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : fallback;
}

function cleanUrl(value: unknown, fallback = "") {
  const raw = cleanString(value, "", 600);
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    return ["http:", "https:"].includes(url.protocol) ? url.toString().replace(/\/$/, "") : fallback;
  } catch {
    return fallback;
  }
}

function json(value: unknown, status = 200) {
  return new Response(safeJsonStringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function safeErrorDetail(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error || "Unknown error");
  return raw.replace(/\s+/g, " ").slice(0, 1200);
}

function safeErrorStack(error: unknown) {
  return error instanceof Error && error.stack ? error.stack.replace(/\s+/g, " ").slice(0, 1600) : "";
}

function errorStatus(error: unknown) {
  const status = Number((error as { status?: unknown })?.status);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

function jsonError(req: Request, error: unknown, phase: "import" | "handler" | "shell") {
  const status = errorStatus(error);
  return json(
    {
      error: phase === "import" ? "calendar_state_import_error" : "calendar_state_error",
      phase,
      details: safeErrorDetail(error),
      stack: safeErrorStack(error),
      message:
        req.method === "PUT"
          ? "Your calendar change could not be saved. Please try again."
          : "Calendar data could not be loaded. Please refresh.",
    },
    status,
  );
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
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
          : [decodeURIComponent(pair.slice(0, index)), decodeURIComponent(pair.slice(index + 1))];
      }),
  );
}

async function readAdminSession(req: Request) {
  const token = parseCookies(req)[sessionCookieName] || "";
  if (!token) return null;
  const tokenHash = hashToken(token);
  const rows = await db().sql`
    SELECT admin_users.id, admin_users.email, admin_sessions.expires_at
    FROM admin_sessions
    JOIN admin_users ON admin_users.id = admin_sessions.user_id
    WHERE admin_sessions.token_hash = ${tokenHash}
  `;
  const row = rows[0];
  if (!row || new Date(row.expires_at).getTime() <= Date.now()) return null;
  return { id: row.id, email: row.email, expiresAt: row.expires_at };
}

function defaultCoachAccount() {
  return {
    id: fallbackAccountId(),
    coachName: env("CLARITY_COACH_NAME", "Sam Hale"),
    businessName: env("CLARITY_BUSINESS_NAME", "Sam Hale Golf"),
    venueName: env("CLARITY_VENUE_NAME", "The Range 24/7 - Three Kings"),
    venueShortName: env("CLARITY_VENUE_SHORT_NAME", "The Range 24/7"),
    timezone: env("CLARITY_TIMEZONE", "Pacific/Auckland"),
    contactEmail: env("CLARITY_CONTACT_EMAIL", ""),
    bookingUrl: env("CLARITY_BOOKING_URL", "https://book.claritygolf.app"),
    calendarSlug: defaultCalendarSlug(),
    caddyWorkspaceUrl: env("CLARITY_CADDY_WORKSPACE_URL", "https://caddy.claritygolf.app"),
    invoiceSettings: defaultInvoiceSettings,
  };
}

function cleanInvoiceSettings(settings: Record<string, unknown> = {}) {
  return { ...defaultInvoiceSettings, ...(settings || {}) };
}

function cleanCoachAccount(account: Record<string, unknown> = {}) {
  const defaults = defaultCoachAccount();
  const businessName = cleanString(account.businessName, defaults.businessName, 100);
  const venueName = cleanString(account.venueName, defaults.venueName, 140);
  return {
    id: cleanSlug(account.id, defaults.id),
    coachName: cleanString(account.coachName, defaults.coachName, 100),
    businessName,
    venueName,
    venueShortName: cleanString(account.venueShortName, defaults.venueShortName || venueName, 80),
    timezone: cleanString(account.timezone, defaults.timezone, 80),
    contactEmail: cleanEmail(account.contactEmail, defaults.contactEmail),
    bookingUrl: cleanUrl(account.bookingUrl, defaults.bookingUrl),
    calendarSlug: cleanSlug(account.calendarSlug, cleanSlug(businessName, defaults.calendarSlug)),
    caddyWorkspaceUrl: cleanUrl(account.caddyWorkspaceUrl, defaults.caddyWorkspaceUrl),
    invoiceSettings: cleanInvoiceSettings(account.invoiceSettings as Record<string, unknown>),
  };
}

function defaultWorkspaceAccountFromCoachAccount(account = defaultCoachAccount()) {
  const clean = cleanCoachAccount(account);
  const slug = cleanSlug(clean.calendarSlug || clean.businessName, fallbackAccountId());
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

function defaultCoachProfileFromAccount(account = defaultCoachAccount()) {
  const clean = cleanCoachAccount(account);
  const workspaceAccount = defaultWorkspaceAccountFromCoachAccount(clean);
  return {
    id: clean.id || fallbackAccountId(),
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

function settingValue(settings: Record<string, string>, key: string) {
  return settings?.[key] || "";
}

function parseSettingJson<T>(settings: Record<string, string>, key: string, fallback: T): T {
  return safeJsonParse(settingValue(settings, key), fallback);
}

function coachAccountFromSettings(settings: Record<string, string>) {
  const defaults = defaultCoachAccount();
  return cleanCoachAccount({
    id: settingValue(settings, "accountId") || defaults.id,
    coachName: settingValue(settings, "accountCoachName") || defaults.coachName,
    businessName: settingValue(settings, "accountBusinessName") || settingValue(settings, "coachName") || defaults.businessName,
    venueName: settingValue(settings, "accountVenueName") || defaults.venueName,
    venueShortName: settingValue(settings, "accountVenueShortName") || defaults.venueShortName,
    timezone: settingValue(settings, "accountTimezone") || defaults.timezone,
    contactEmail: settingValue(settings, "accountContactEmail") || defaults.contactEmail,
    bookingUrl: settingValue(settings, "accountBookingUrl") || defaults.bookingUrl,
    calendarSlug: settingValue(settings, "accountCalendarSlug") || defaults.calendarSlug,
    caddyWorkspaceUrl: settingValue(settings, "accountCaddyWorkspaceUrl") || defaults.caddyWorkspaceUrl,
    invoiceSettings: parseSettingJson(settings, "accountInvoiceSettingsJson", defaults.invoiceSettings),
  });
}

function adminSettingsFromSettings(settings: Record<string, string>) {
  const delaySeconds = Number(settingValue(settings, "notificationDelaySeconds") || 30);
  return {
    emailNotificationsEnabled: settingValue(settings, "emailNotificationsEnabled") !== "false",
    notificationEmail: settingValue(settings, "notificationEmail"),
    coachEmail: settingValue(settings, "coachEmail"),
    replyToEmail: settingValue(settings, "replyToEmail"),
    notificationDelaySeconds: Number.isFinite(delaySeconds) ? Math.max(30, Math.min(3600, delaySeconds)) : 30,
    sendClientEmail: settingValue(settings, "sendClientEmail") !== "false",
    sendCoachEmail: settingValue(settings, "sendCoachEmail") !== "false",
    sendAdminEmail: settingValue(settings, "sendAdminEmail") !== "false",
    clientEmailSubject: settingValue(settings, "clientEmailSubject") || "Your {{service}} is confirmed",
    clientEmailIntro: settingValue(settings, "clientEmailIntro") || "Thanks {{firstName}}, your booking with {{coach}} is confirmed.",
    clientEmailFooter: settingValue(settings, "clientEmailFooter") || "We look forward to seeing you.",
    adminEmailSubject: settingValue(settings, "adminEmailSubject") || "New booking: {{client}}",
    adminEmailIntro: settingValue(settings, "adminEmailIntro") || "{{client}} booked {{service}} for {{date}} at {{time}}.",
    smsProviderName: settingValue(settings, "smsProviderName"),
    smsWebhookUrl: settingValue(settings, "smsWebhookUrl"),
    smsFromNumber: settingValue(settings, "smsFromNumber"),
    sendClientSms: settingValue(settings, "sendClientSms") === "true",
    sendAdminSms: settingValue(settings, "sendAdminSms") === "true",
  };
}

function brandSettingsFromSettings(settings: Record<string, string>, account: ReturnType<typeof cleanCoachAccount>) {
  return {
    coachName: settingValue(settings, "coachName") || account.businessName,
    logoName: settingValue(settings, "brandLogoName"),
    logoPreview: settingValue(settings, "brandLogoPreview"),
    showLogo: settingValue(settings, "brandShowLogo") === "true",
    neutral: settingValue(settings, "brandNeutral") || "#ffffff",
    primary: settingValue(settings, "brandPrimary") || "#1fd36d",
    secondary: settingValue(settings, "brandSecondary") || "#d7b06b",
    accent: settingValue(settings, "brandAccent") || "#07100a",
    bookingTheme: settingValue(settings, "brandBookingTheme") === "light" ? "light" : "dark",
  };
}

function normalizeWorkspaceAccounts(rawAccounts: unknown, account = defaultCoachAccount()) {
  const fallback = defaultWorkspaceAccountFromCoachAccount(account);
  const source = Array.isArray(rawAccounts) && rawAccounts.length ? rawAccounts : [fallback];
  const seen = new Set<string>();
  return source.map((raw, index) => {
    const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const name = cleanString(item.name, fallback.name, 120);
    const slug = cleanSlug(item.slug || item.id || name, fallback.slug);
    let id = cleanSlug(item.id, slug);
    let suffix = 2;
    while (seen.has(id)) {
      id = `${slug}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    return {
      id,
      name,
      slug,
      planKey: cleanString(item.planKey, fallback.planKey, 40),
      subscriptionStatus: cleanString(item.subscriptionStatus, fallback.subscriptionStatus, 40),
      billingProvider: cleanString(item.billingProvider, fallback.billingProvider, 40),
      active: item.active !== false || index === 0,
    };
  });
}

function normalizeCoachProfiles(rawProfiles: unknown, account = defaultCoachAccount()) {
  const fallback = defaultCoachProfileFromAccount(account);
  const source = Array.isArray(rawProfiles) && rawProfiles.length ? rawProfiles : [fallback];
  const seen = new Set<string>();
  return source.map((raw, index) => {
    const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const name = cleanString(item.name, fallback.name, 120);
    const baseId = cleanSlug(item.id, cleanSlug(name, `coach-${index + 1}`));
    let id = baseId;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    return {
      id,
      accountId: cleanSlug(item.accountId, fallback.accountId),
      name,
      displayName: cleanString(item.displayName, name, 120),
      shortName: cleanString(item.shortName, name.split(/\s+/).map((part) => part[0]).join("").slice(0, 4).toUpperCase(), 60),
      email: cleanEmail(item.email, fallback.email),
      phone: cleanString(item.phone, "", 80) || undefined,
      bio: cleanString(item.bio, "", 600) || undefined,
      photoUrl: cleanUrl(item.photoUrl, "", 300) || undefined,
      active: item.active !== false,
      archived: item.archived === true,
      isDefault: item.isDefault === true || index === 0,
      bookable: item.bookable !== false,
      assignedLocationIds: Array.isArray(item.assignedLocationIds) ? item.assignedLocationIds.map((id) => cleanSlug(id, "")).filter(Boolean) : fallback.assignedLocationIds,
      defaultLocationId: cleanSlug(item.defaultLocationId, "") || fallback.defaultLocationId,
      sortOrder: Number.isFinite(Number(item.sortOrder)) ? Math.round(Number(item.sortOrder)) : index,
    };
  }).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.displayName.localeCompare(b.displayName));
}

function normalizeLocations(rawLocations: unknown, account = defaultCoachAccount()) {
  const fallback = defaultLocationFromCoachAccount(account);
  const source = Array.isArray(rawLocations) && rawLocations.length ? rawLocations : [fallback];
  const seen = new Set<string>();
  return source.map((raw, index) => {
    const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const name = cleanString(item.name, fallback.name, 140);
    const baseId = cleanSlug(item.id, cleanSlug(name, `location-${index + 1}`));
    let id = baseId;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    return {
      id,
      accountId: cleanSlug(item.accountId, fallback.accountId),
      name,
      shortName: cleanString(item.shortName, name, 80),
      address: cleanString(item.address, fallback.address || "", 240),
      mapUrl: cleanUrl(item.mapUrl, "", 300) || undefined,
      arrivalInstructions: cleanString(item.arrivalInstructions, "", 500) || undefined,
      publicNotes: cleanString(item.publicNotes, "", 500) || undefined,
      timezone: cleanString(item.timezone, fallback.timezone, 80),
      active: item.active !== false,
      archived: item.archived === true,
      isDefault: item.isDefault === true || index === 0,
      sortOrder: Number.isFinite(Number(item.sortOrder)) ? Math.round(Number(item.sortOrder)) : index,
    };
  }).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
}

function normalizeAvailability(rawAvailability: unknown) {
  const source = Array.isArray(rawAvailability) ? rawAvailability : defaultAvailability;
  return Array.from({ length: 7 }, (_, day) => {
    const windows = Array.isArray(source[day]) ? source[day] : [];
    return windows
      .map((raw) => {
        const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
        const start = Number.isFinite(Number(item.start)) ? Math.max(0, Math.min(24 * 60 - 15, Math.round(Number(item.start) / 15) * 15)) : 7 * 60;
        const end = Number.isFinite(Number(item.end)) ? Math.max(start + 15, Math.min(24 * 60, Math.round(Number(item.end) / 15) * 15)) : start + 60;
        return end > start ? { ...item, start, end, coachId: cleanSlug(item.coachId, defaultCoachProfileFromAccount().id) } : null;
      })
      .filter(Boolean);
  });
}

function normalizeServices(rawServices: unknown) {
  return Array.isArray(rawServices) && rawServices.length ? rawServices : defaultServices;
}

function readJsonField(value: unknown) {
  if (!value || typeof value !== "string") return value;
  return safeJsonParse(value, null);
}

function cleanBookingLocationSnapshot(raw: unknown) {
  const source = readJsonField(raw);
  if (!source || typeof source !== "object" || !(source as Record<string, unknown>).name) return undefined;
  const item = source as Record<string, unknown>;
  return {
    locationId: cleanSlug(item.locationId, "") || undefined,
    name: cleanString(item.name, "", 140),
    shortName: cleanString(item.shortName, "", 80) || undefined,
    address: cleanString(item.address, "", 240) || undefined,
    mapUrl: cleanUrl(item.mapUrl, "", 300) || undefined,
    arrivalInstructions: cleanString(item.arrivalInstructions, "", 500) || undefined,
    publicNotes: cleanString(item.publicNotes, "", 500) || undefined,
    timezone: cleanString(item.timezone, "", 80) || undefined,
  };
}

function cleanBookingCoachSnapshot(raw: unknown) {
  const source = readJsonField(raw);
  if (!source || typeof source !== "object" || !(source as Record<string, unknown>).name) return undefined;
  const item = source as Record<string, unknown>;
  return {
    coachId: cleanSlug(item.coachId, "") || undefined,
    name: cleanString(item.name, "", 120),
    displayName: cleanString(item.displayName, "", 120) || undefined,
    email: cleanEmail(item.email, "") || undefined,
    phone: cleanString(item.phone, "", 80) || undefined,
  };
}

function cleanCustomGroupData(value: unknown) {
  const source = readJsonField(value);
  if (!source || typeof source !== "object") return null;
  const item = source as Record<string, unknown>;
  const attendees = Array.isArray(item.attendees)
    ? item.attendees.map((attendee, index) => {
        const raw = attendee && typeof attendee === "object" ? attendee as Record<string, unknown> : {};
        const email = cleanEmail(raw.email, "");
        const name = cleanString(raw.name, email, 140);
        return name || email
          ? { id: cleanString(raw.id, `attendee-${index + 1}`, 120), name, ...(email ? { email } : {}), status: cleanString(raw.status, "pending", 40) }
          : null;
      }).filter(Boolean)
    : [];
  if (item.customGroup !== true && !attendees.length) return null;
  return {
    customGroup: true,
    attendees,
    calculatedPrice: Number.isFinite(Number(item.calculatedPrice)) ? Math.max(0, Math.round(Number(item.calculatedPrice))) : 0,
  };
}

function isCancelledGroupSessionLike(row: Record<string, unknown>) {
  return row.kind === "block" && Boolean(row.service_id || row.serviceId) && (row.note === CANCELLED_GROUP_SESSION_NOTE || row.title === CANCELLED_GROUP_SESSION_TITLE);
}

function rowToItem(row: Record<string, unknown>) {
  const status = ["completed", "cancelled", "no_show"].includes(String(row.status || "")) ? String(row.status) : "booked";
  const customGroup = cleanCustomGroupData(row.custom_group);
  const cancelledGroupSession = isCancelledGroupSessionLike(row);
  return {
    id: cleanString(row.id, "", 140),
    accountId: cleanSlug(row.account_id, defaultWorkspaceAccountFromCoachAccount().id),
    kind: row.kind === "block" ? "block" : "appointment",
    week: Number(row.week ?? 0),
    day: Number(row.day ?? 0),
    start: Number(row.start ?? 0),
    duration: Number(row.duration ?? 0),
    coachId: cleanSlug(row.coach_id, defaultCoachProfileFromAccount().id),
    locationId: cleanSlug(row.location_id, "") || cleanBookingLocationSnapshot(row.location)?.locationId || "",
    serviceId: cleanString(row.service_id, "", 120),
    client: cleanString(row.client, "", 180),
    title: cleanString(row.title, row.kind === "block" ? "Busy" : "Appointment", 180),
    phone: cleanString(row.phone, "", 80),
    email: cleanEmail(row.email, ""),
    note: cleanString(row.note, "", 1200),
    coach: cleanBookingCoachSnapshot(row.coach),
    location: cleanBookingLocationSnapshot(row.location),
    status: cancelledGroupSession ? "cancelled" : status,
    ...(cancelledGroupSession ? { readOnly: true, groupSlot: true } : {}),
    ...(customGroup || {}),
  };
}

function recordBelongsToAccount(record: Record<string, unknown>, accountId: string) {
  return (record.accountId || accountId) === accountId;
}

function isAdminUser(user: Record<string, unknown> | null | undefined) {
  return ["admin", "account_admin", "platform_admin"].includes(String(user?.role || "")) || Object.values((user?.permissions || {}) as Record<string, unknown>).includes("all");
}

function filterCalendarStateForContext(state: Record<string, any>, context: { accountId: string; isAdmin: boolean; coachId?: string }) {
  const coaches = state.coaches || [];
  const defaultCoachId = coaches.find((coach: Record<string, unknown>) => coach.isDefault && coach.active && !coach.archived)?.id || coaches[0]?.id || "";
  const filteredItems = context.isAdmin
    ? (state.items || []).filter((item: Record<string, unknown>) => recordBelongsToAccount(item, context.accountId))
    : (state.items || []).filter((item: Record<string, unknown>) => recordBelongsToAccount(item, context.accountId) && (item.coachId || defaultCoachId) === context.coachId);
  return {
    ...state,
    items: filteredItems,
    services: context.isAdmin
      ? (state.services || []).filter((service: Record<string, unknown>) => recordBelongsToAccount(service, context.accountId))
      : (state.services || []).filter((service: Record<string, unknown>) => recordBelongsToAccount(service, context.accountId) && (service.coachId || defaultCoachId) === context.coachId),
    availability: context.isAdmin
      ? (state.availability || []).map((day: Array<Record<string, unknown>>) => day.filter((window) => recordBelongsToAccount(window, context.accountId)))
      : (state.availability || []).map((day: Array<Record<string, unknown>>) => day.filter((window) => recordBelongsToAccount(window, context.accountId) && (window.coachId || defaultCoachId) === context.coachId)),
    people: state.people || [],
    notifications: state.notifications || [],
  };
}

function publicCalendarState(state: Record<string, unknown>) {
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

async function readSettingsMap() {
  const rows = await db().sql`SELECT key, value FROM settings`;
  return Object.fromEntries(rows.map((row: Record<string, string>) => [row.key, row.value || ""]));
}

async function readItems() {
  const rows = await db().sql`
    SELECT *
    FROM calendar_items
    ORDER BY week, day, start, id
  `;
  return rows.map(rowToItem);
}

function appUsersFromSettings(settings: Record<string, string>, account: ReturnType<typeof cleanCoachAccount>) {
  const users = parseSettingJson(settings, "appUsersJson", []);
  return Array.isArray(users) && users.length ? users : [defaultAppUserFromAccount(account)];
}

async function readTinyCalendarShell(req: Request, requestStartedAt: number) {
  const session = await readAdminSession(req);
  if (!session) return json({ error: "unauthorized", message: "Admin login required." }, 401);

  const shellStartedAt = Date.now();
  console.info("CALENDAR_SHELL_STATE_LOAD_STARTED", {
    route: "/api/calendar-state",
    routeUsed: "shell",
    entrypoint: "tiny",
  });

  const [settingsMap, items] = await Promise.all([readSettingsMap(), readItems()]);
  // Resolve the workspace's country before any date or price is formatted, so
  // this lambda uses the coach's conventions rather than New Zealand's.
  setActivePhoneCountry(settingValue(settingsMap, "accountCountry"));
  const account = coachAccountFromSettings(settingsMap);
  const workspaceAccounts = normalizeWorkspaceAccounts(parseSettingJson(settingsMap, "workspaceAccountsJson", []), account);
  const accountId = workspaceAccounts.find((workspaceAccount) => workspaceAccount.active)?.id || workspaceAccounts[0]?.id || defaultWorkspaceAccountFromCoachAccount(account).id;
  const users = appUsersFromSettings(settingsMap, account);
  const sessionEmail = cleanEmail(session.email, "");
  const currentUser =
    users.find((user: Record<string, unknown>) => cleanEmail(user.email, "") === sessionEmail && (!user.accountId || user.accountId === accountId)) ||
    users.find((user: Record<string, unknown>) => user.accountId === accountId && isAdminUser(user)) ||
    { ...defaultAppUserFromAccount(account), accountId };
  const context = {
    accountId,
    isAdmin: isAdminUser(currentUser),
    coachId: cleanSlug(currentUser.coachId, ""),
  };
  const shellLoadDurationMs = Date.now() - shellStartedAt;
  const responseDurationMs = Date.now() - requestStartedAt;
  const deferred = {
    people: true,
    notifications: true,
    googleSyncStatus: true,
  };

  console.info("PEOPLE_LOAD_DEFERRED", { route: "/api/calendar-state", routeUsed: "shell", entrypoint: "tiny" });
  console.info("NOTIFICATION_HISTORY_DEFERRED", { route: "/api/calendar-state", routeUsed: "shell", entrypoint: "tiny" });
  console.info("GOOGLE_SYNC_STATUS_DEFERRED", { route: "/api/calendar-state", routeUsed: "shell", entrypoint: "tiny" });
  console.info("NON_CRITICAL_DATA_DEFERRED", {
    route: "/api/calendar-state",
    routeUsed: "shell",
    entrypoint: "tiny",
    peopleDeferred: deferred.people,
    notificationsDeferred: deferred.notifications,
    googleSyncStatusDeferred: deferred.googleSyncStatus,
  });
  console.info("CALENDAR_SHELL_STATE_LOAD_COMPLETED", {
    route: "/api/calendar-state",
    routeUsed: "shell",
    entrypoint: "tiny",
    shellLoadDurationMs,
    responseDurationMs,
    itemCount: items.length,
    peopleDeferred: deferred.people,
    notificationsDeferred: deferred.notifications,
    googleSyncStatusDeferred: deferred.googleSyncStatus,
  });

  const state = {
    syncKey: settingValue(settingsMap, "syncKey") || env("CLARITY_CALENDAR_SYNC_KEY") || `cg_${randomUUID().replaceAll("-", "")}`,
    updatedAt: settingValue(settingsMap, "updatedAt") || nowIso(),
    items,
    services: normalizeServices(parseSettingJson(settingsMap, "servicesJson", defaultServices)),
    workspaceAccounts,
    coaches: normalizeCoachProfiles(parseSettingJson(settingsMap, "coachProfilesJson", []), account),
    currentUser,
    locations: normalizeLocations(parseSettingJson(settingsMap, "locationsJson", []), account),
    availability: normalizeAvailability(parseSettingJson(settingsMap, "availabilityJson", defaultAvailability)),
    people: [],
    notifications: [],
    settings: adminSettingsFromSettings(settingsMap),
    brand: brandSettingsFromSettings(settingsMap, account),
    account,
    googleCalendar: {
      configured: false,
      connected: false,
      calendarId: "primary",
      autoSync: true,
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
        entrypoint: "tiny",
        shellLoadDurationMs,
        responseDurationMs,
        itemCount: items.length,
        peopleDeferred: deferred.people,
        notificationsDeferred: deferred.notifications,
        googleSyncStatusDeferred: deferred.googleSyncStatus,
      },
    },
  };

  return json(publicCalendarState(filterCalendarStateForContext(state, context)));
}

async function delegateToBookingCore(req: Request, context: Context) {
  let bookingCore: BookingCoreModule;
  try {
    bookingCore = (await import("./booking-core.mts")) as BookingCoreModule;
  } catch (error) {
    console.error("calendar_state_wrapper:booking_core_import_failed", error);
    return jsonError(req, error, "import");
  }

  try {
    return await bookingCore.handleBookingApiRoute(req, "/api/calendar-state", context);
  } catch (error) {
    console.error("calendar_state_wrapper:handler_failed", error);
    return jsonError(req, error, "handler");
  }
}

export default async function handler(req: Request, context: Context) {
  if (req.method !== "GET") return delegateToBookingCore(req, context);
  const requestStartedAt = Date.now();
  try {
    return await readTinyCalendarShell(req, requestStartedAt);
  } catch (error) {
    console.error("calendar_state_wrapper:shell_failed", error);
    return jsonError(req, error, "shell");
  }
}

export const config: Config = {
  path: "/api/calendar-state",
};
