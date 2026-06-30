import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.CLARITY_DB_PATH || join(__dirname, "clarity-booking.sqlite");
const legacyStatePath = join(__dirname, "calendar-state.json");

const baseWeekStart = new Date(Date.UTC(2026, 5, 1));
const sessionDays = 7;
const passwordResetMinutes = 30;
const defaultEmailTemplates = {
  clientEmailSubject: "Your {{service}} is confirmed",
  clientEmailIntro: "Thanks {{firstName}}, your booking with {{coach}} is confirmed.",
  clientEmailFooter: "Need to move your booking? Reply to this email and we will help.",
  adminEmailSubject: "New booking: {{client}}",
  adminEmailIntro: "{{client}} booked {{service}} for {{date}} at {{time}}.",
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
    price: 130,
    description: "Private package redemption rate",
    visibility: "private",
    active: true,
    capacity: 1,
    minParticipants: 1,
    lessonFormat: "private",
    priceMode: "session",
    location: "Package redemption",
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

let db;

function timeToMinutes(hour, minute) {
  return hour * 60 + minute;
}

export function generateSyncKey() {
  return `cg_${randomUUID().replaceAll("-", "")}`;
}

function nowIso() {
  return new Date().toISOString();
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

function cleanEmail(value, fallback = "sam@samhalegolf.co.nz") {
  const email = cleanString(value, "", 180).toLowerCase();
  return email.includes("@") ? email : fallback;
}

function normalizeMatchText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function normalizePhoneDigits(value = "") {
  return String(value || "").replace(/\D/g, "");
}

function phoneVariants(value = "") {
  const digits = normalizePhoneDigits(value);
  const variants = new Set();
  if (digits) variants.add(digits);
  if (digits.startsWith("64") && digits.length > 2) {
    variants.add(`0${digits.slice(2)}`);
    variants.add(digits.slice(2));
  }
  if (digits.startsWith("0") && digits.length > 1) {
    variants.add(`64${digits.slice(1)}`);
    variants.add(digits.slice(1));
  }
  if (digits.length > 8) variants.add(digits.slice(-8));
  if (digits.length > 7) variants.add(digits.slice(-7));
  return Array.from(variants).filter(Boolean);
}

function phoneValuesMatch(source = "", query = "") {
  const sourceVariants = phoneVariants(source);
  const queryVariants = phoneVariants(query);
  if (!sourceVariants.length || !queryVariants.length) return false;

  return sourceVariants.some((sourceValue) =>
    queryVariants.some((queryValue) => {
      if (sourceValue === queryValue) return true;
      const tailLength = Math.min(sourceValue.length, queryValue.length, 8);
      return tailLength >= 7 && sourceValue.slice(-tailLength) === queryValue.slice(-tailLength);
    }),
  );
}

function findExistingPerson(database, person, allowAppointmentIds = false) {
  if (person.id && (allowAppointmentIds || !person.id.startsWith("appointment-"))) {
    const existing = database.prepare("SELECT id FROM people WHERE id = ?").get(person.id);
    if (existing) return existing;
  }
  if (person.email) {
    const existing = database.prepare("SELECT id FROM people WHERE LOWER(email) = LOWER(?)").get(person.email);
    if (existing) return existing;
  }
  const comparableName = normalizeMatchText(person.name);
  const phoneDigits = normalizePhoneDigits(person.phone);
  if (!comparableName && phoneDigits.length < 4) return null;

  return (
    database
      .prepare("SELECT id, name, phone FROM people WHERE phone IS NOT NULL AND phone <> ''")
      .all()
      .find((candidate) => {
        const nameMatches = comparableName && normalizeMatchText(candidate.name) === comparableName;
        const phoneMatches = phoneDigits.length >= 4 && phoneValuesMatch(candidate.phone, person.phone);
        if (nameMatches && phoneMatches) return true;
        return !person.email && phoneMatches && phoneDigits.length >= 7;
      }) ?? null
  );
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

function cleanService(service, index = 0) {
  const fallback = defaultServices[index] ?? defaultServices[0];
  const name = cleanString(service?.name, fallback.name, 120);
  const duration = Number.isFinite(Number(service?.duration)) ? Number(service.duration) : fallback.duration;
  const price = Number.isFinite(Number(service?.price)) ? Number(service.price) : fallback.price;
  const capacity = Number.isFinite(Number(service?.capacity)) ? Number(service.capacity) : fallback.capacity || 1;
  const lessonFormat = service?.lessonFormat === "group" ? "group" : "private";
  const cleanCapacity = Math.max(lessonFormat === "group" ? 2 : 1, Math.min(24, Math.round(capacity)));
  const rawMinParticipants = Number.isFinite(Number(service?.minParticipants))
    ? Number(service.minParticipants)
    : lessonFormat === "group"
      ? Math.min(2, cleanCapacity)
      : 1;
  const minParticipants =
    lessonFormat === "group" ? Math.max(2, Math.min(cleanCapacity, Math.round(rawMinParticipants))) : 1;
  const priceMode = lessonFormat === "group" && service?.priceMode === "per-person" ? "per-person" : "session";
  return {
    id: cleanSlug(service?.id, cleanSlug(name, `service-${Date.now()}-${index}`)),
    name,
    duration: Math.max(15, Math.min(240, Math.round(duration))),
    price: Math.max(0, Math.round(price)),
    description: cleanString(service?.description, fallback.description, 240),
    visibility: service?.visibility === "private" ? "private" : "public",
    active: service?.active !== false,
    capacity: cleanCapacity,
    minParticipants,
    lessonFormat,
    priceMode,
    location: cleanString(service?.location, fallback.location, 160),
  };
}

function normalizeServices(serviceList) {
  const source = Array.isArray(serviceList) && serviceList.length ? serviceList : defaultServices;
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

function defaultLocationFromAccount(account = defaultCoachAccount()) {
  const cleanAccount = cleanCoachAccount(account);
  return {
    id: "default-location",
    accountId: cleanAccount.id,
    name: cleanAccount.venueName,
    shortName: cleanAccount.venueShortName || cleanAccount.venueName,
    address: "",
    timezone: cleanAccount.timezone,
    active: true,
    archived: false,
    isDefault: true,
    sortOrder: 0,
  };
}

function defaultCoachProfileFromAccount(account = defaultCoachAccount()) {
  const cleanAccount = cleanCoachAccount(account);
  return {
    id: cleanAccount.id || "sam-hale",
    accountId: cleanAccount.id,
    name: cleanAccount.coachName,
    displayName: cleanAccount.coachName || cleanAccount.businessName,
    shortName: "Sam",
    email: cleanAccount.contactEmail,
    active: true,
    archived: false,
    isDefault: true,
    bookable: true,
    assignedLocationIds: ["default-location"],
    defaultLocationId: "default-location",
    sortOrder: 0,
  };
}

function cleanLocation(location, fallback = defaultLocationFromAccount(), index = 0) {
  const name = cleanString(location?.name, fallback.name, 140);
  const id = cleanSlug(location?.id, cleanSlug(name, `location-${index + 1}`));
  return {
    id,
    accountId: cleanSlug(location?.accountId, fallback.accountId || defaultCoachAccount().id),
    name,
    shortName: cleanString(location?.shortName, name, 80),
    address: cleanString(location?.address, fallback.address || "", 240),
    mapUrl: cleanUrl(location?.mapUrl, "") || undefined,
    arrivalInstructions: cleanString(location?.arrivalInstructions, "", 500) || undefined,
    publicNotes: cleanString(location?.publicNotes, "", 500) || undefined,
    timezone: cleanString(location?.timezone, fallback.timezone || defaultCoachAccount().timezone, 80),
    active: location?.active !== false,
    archived: location?.archived === true,
    isDefault: location?.isDefault === true || fallback.isDefault === true,
    sortOrder: Number.isFinite(Number(location?.sortOrder)) ? Math.round(Number(location.sortOrder)) : index,
  };
}

function normalizeLocations(locationList, account = defaultCoachAccount()) {
  const fallback = defaultLocationFromAccount(account);
  const source = Array.isArray(locationList) && locationList.length ? locationList : [fallback];
  const seen = new Set();
  const cleaned = source.map((location, index) => {
    const clean = cleanLocation(location, index === 0 ? fallback : undefined, index);
    let id = clean.id;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${clean.id}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    return { ...clean, id };
  });
  if (!cleaned.some((location) => location.active && !location.archived)) {
    cleaned[0] = { ...cleaned[0], active: true, archived: false };
  }
  const defaultIndex = cleaned.findIndex((location) => location.isDefault && location.active && !location.archived);
  const nextDefaultIndex = defaultIndex >= 0 ? defaultIndex : cleaned.findIndex((location) => location.active && !location.archived);
  return cleaned
    .map((location, index) => ({ ...location, isDefault: index === nextDefaultIndex }))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
}

function cleanCoachProfile(coach, fallback = defaultCoachProfileFromAccount(), index = 0) {
  const name = cleanString(coach?.name, fallback.name, 120);
  const assignedLocationIds = Array.isArray(coach?.assignedLocationIds)
    ? coach.assignedLocationIds.map((id) => cleanSlug(id, "")).filter(Boolean)
    : fallback.assignedLocationIds || ["default-location"];
  const defaultLocationId = cleanSlug(
    coach?.defaultLocationId,
    assignedLocationIds[0] || fallback.defaultLocationId || "default-location",
  );
  return {
    id: cleanSlug(coach?.id, cleanSlug(name, `coach-${index + 1}`)),
    accountId: cleanSlug(coach?.accountId, fallback.accountId || defaultCoachAccount().id),
    name,
    displayName: cleanString(coach?.displayName, name, 120),
    shortName: cleanString(
      coach?.shortName,
      name.split(/\s+/).map((part) => part[0]).join("").slice(0, 4).toUpperCase(),
      60,
    ),
    email: cleanEmail(coach?.email, fallback.email || defaultCoachAccount().contactEmail),
    phone: cleanString(coach?.phone, "", 80) || undefined,
    bio: cleanString(coach?.bio, "", 600) || undefined,
    photoUrl: cleanUrl(coach?.photoUrl, "") || undefined,
    active: coach?.active !== false,
    archived: coach?.archived === true,
    isDefault: coach?.isDefault === true || fallback.isDefault === true,
    bookable: coach?.bookable !== false,
    assignedLocationIds,
    defaultLocationId: defaultLocationId || undefined,
    sortOrder: Number.isFinite(Number(coach?.sortOrder)) ? Math.round(Number(coach.sortOrder)) : index,
  };
}

function normalizeCoachProfiles(coachList, account = defaultCoachAccount()) {
  const fallback = defaultCoachProfileFromAccount(account);
  const source = Array.isArray(coachList) && coachList.length ? coachList : [fallback];
  const seen = new Set();
  const cleaned = source.map((coach, index) => {
    const clean = cleanCoachProfile(coach, index === 0 ? fallback : undefined, index);
    let id = clean.id;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${clean.id}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    return { ...clean, id };
  });
  if (!cleaned.some((coach) => coach.active && !coach.archived && coach.bookable)) {
    cleaned[0] = { ...cleaned[0], active: true, archived: false, bookable: true };
  }
  const defaultIndex = cleaned.findIndex((coach) => coach.isDefault && coach.active && !coach.archived && coach.bookable);
  const nextDefaultIndex = defaultIndex >= 0 ? defaultIndex : cleaned.findIndex((coach) => coach.active && !coach.archived && coach.bookable);
  return cleaned
    .map((coach, index) => ({ ...coach, isDefault: index === nextDefaultIndex }))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
}

function normalizeAvailability(availability) {
  const source = Array.isArray(availability) ? availability : defaultAvailability;
  return Array.from({ length: 7 }, (_, day) => {
    const windows = Array.isArray(source[day]) ? source[day] : [];
    return windows
      .map((window) => {
        const rawStart = Number.isFinite(Number(window?.start)) ? Number(window.start) : timeToMinutes(7, 0);
        const rawEnd = Number.isFinite(Number(window?.end)) ? Number(window.end) : rawStart + 60;
        const start = Math.max(timeToMinutes(7, 0), Math.min(timeToMinutes(19, 45), Math.round(rawStart / 15) * 15));
        const end = Math.max(start + 15, Math.min(timeToMinutes(20, 0), Math.round(rawEnd / 15) * 15));
        return end > start ? { start, end } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.start - b.start)
      .reduce((merged, window) => {
        const previous = merged.at(-1);
        if (previous && window.start <= previous.end) {
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
    id: process.env.CLARITY_COACH_ACCOUNT_ID || "sam-hale-golf",
    coachName: process.env.CLARITY_COACH_NAME || "Sam Hale",
    businessName: process.env.CLARITY_BUSINESS_NAME || "Sam Hale Golf",
    venueName: process.env.CLARITY_VENUE_NAME || "The Range 24/7 - Three Kings",
    venueShortName: process.env.CLARITY_VENUE_SHORT_NAME || "The Range 24/7",
    timezone: process.env.CLARITY_TIMEZONE || "Pacific/Auckland",
    contactEmail: process.env.CLARITY_CONTACT_EMAIL || "sam@samhalegolf.co.nz",
    bookingUrl: process.env.CLARITY_BOOKING_URL || "https://book.claritygolf.app",
    calendarSlug: process.env.CLARITY_CALENDAR_SLUG || "sam-hale-golf",
    caddyWorkspaceUrl: process.env.CLARITY_CADDY_WORKSPACE_URL || "https://caddy.claritygolf.app",
  };
}

function cleanCoachAccount(account) {
  const defaults = defaultCoachAccount();
  const businessName = cleanString(account?.businessName, defaults.businessName, 100);
  const venueName = cleanString(account?.venueName, defaults.venueName, 140);
  return {
    id: cleanSlug(account?.id, defaults.id),
    coachName: cleanString(account?.coachName, defaults.coachName, 100),
    businessName,
    venueName,
    venueShortName: cleanString(account?.venueShortName, defaults.venueShortName || venueName, 80),
    timezone: cleanString(account?.timezone, defaults.timezone, 80),
    contactEmail: cleanEmail(account?.contactEmail, defaults.contactEmail),
    bookingUrl: cleanUrl(account?.bookingUrl, defaults.bookingUrl),
    calendarSlug: cleanSlug(account?.calendarSlug, cleanSlug(businessName, defaults.calendarSlug)),
    caddyWorkspaceUrl: cleanUrl(account?.caddyWorkspaceUrl, defaults.caddyWorkspaceUrl),
  };
}

function cleanCalendarItem(item) {
  if (!item || typeof item !== "object") return null;
  const kind = item.kind === "block" ? "block" : item.kind === "appointment" ? "appointment" : null;
  if (!kind) return null;

  const day = Number(item.day);
  const start = Number(item.start);
  const duration = Number(item.duration);
  if (!Number.isInteger(day) || day < 0 || day > 6) return null;
  if (!Number.isInteger(start) || start < 0 || start > 24 * 60) return null;
  if (!Number.isInteger(duration) || duration <= 0 || duration > 12 * 60) return null;

  return {
    id: cleanString(item.id, `${kind}-${Date.now()}`),
    kind,
    week: Number.isInteger(Number(item.week)) ? Number(item.week) : 0,
    day,
    start,
    duration,
    serviceId: cleanString(item.serviceId),
    client: cleanString(item.client),
    title: cleanString(item.title, kind === "block" ? "Busy" : "Appointment"),
    phone: cleanString(item.phone),
    email: cleanString(item.email),
    note: cleanString(item.note),
  };
}

function normalizeItems(items) {
  return Array.isArray(items) ? items.map(cleanCalendarItem).filter(Boolean) : initialItems;
}

function cleanPerson(person, source = "import") {
  if (!person || typeof person !== "object") return null;
  const joinedName = [person.firstName, person.lastName].filter(Boolean).join(" ");
  const name = cleanString(person.name || joinedName || person.client || person.title, "", 180);
  const email = cleanString(person.email, "", 180).toLowerCase();
  if (!name && !email) return null;

  return {
    id: cleanString(person.id, "", 120),
    name: name || email,
    email,
    phone: cleanString(person.phone, "", 80),
    notes: cleanString(person.notes || person.note, "", 1200),
    source: cleanString(person.source, source, 80),
    caddyProfileId: cleanString(person.caddyProfileId || person.caddyId, "", 120),
    caddyProfileUrl: cleanString(person.caddyProfileUrl || person.caddyUrl, "", 600),
  };
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

function defaultSettings() {
  const account = defaultCoachAccount();
  return {
    syncKey: process.env.CLARITY_CALENDAR_SYNC_KEY || generateSyncKey(),
    notificationEmail: process.env.CLARITY_NOTIFICATION_EMAIL || "sam@samhalegolf.co.nz",
    replyToEmail: process.env.CLARITY_REPLY_TO_EMAIL || "sam@samhalegolf.co.nz",
    notificationDelaySeconds: "30",
    sendClientEmail: "true",
    sendAdminEmail: "true",
    clientEmailSubject: defaultEmailTemplates.clientEmailSubject,
    clientEmailIntro: defaultEmailTemplates.clientEmailIntro,
    clientEmailFooter: defaultEmailTemplates.clientEmailFooter,
    adminEmailSubject: defaultEmailTemplates.adminEmailSubject,
    adminEmailIntro: defaultEmailTemplates.adminEmailIntro,
    smsProviderName: process.env.CLARITY_SMS_PROVIDER || "",
    smsWebhookUrl: process.env.CLARITY_SMS_WEBHOOK_URL || "",
    smsFromNumber: process.env.CLARITY_SMS_FROM_NUMBER || "",
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
    coachName: account.businessName,
    brandLogoName: "",
    brandLogoPreview: "",
    brandNeutral: "#ffffff",
    brandPrimary: "#1fd36d",
    brandSecondary: "#d7b06b",
    brandAccent: "#07100a",
    brandBookingTheme: "dark",
    updatedAt: nowIso(),
  };
}

function getDb() {
  if (db) return db;
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS calendar_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('appointment', 'block')),
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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_calendar_items_slot
      ON calendar_items (week, day, start);

    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      duration INTEGER NOT NULL,
      price INTEGER NOT NULL,
      description TEXT,
      visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
      active INTEGER NOT NULL DEFAULT 1,
      capacity INTEGER NOT NULL DEFAULT 1,
      min_participants INTEGER NOT NULL DEFAULT 1,
      lesson_format TEXT NOT NULL DEFAULT 'private' CHECK (lesson_format IN ('private', 'group')),
      price_mode TEXT NOT NULL DEFAULT 'session' CHECK (price_mode IN ('session', 'per-person')),
      location TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS availability_windows (
      id TEXT PRIMARY KEY,
      day INTEGER NOT NULL CHECK (day >= 0 AND day <= 6),
      start INTEGER NOT NULL,
      end INTEGER NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_availability_windows_day
      ON availability_windows (day, start);

    CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      notes TEXT,
      source TEXT,
      caddy_profile_id TEXT,
      caddy_profile_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_people_email_unique
      ON people (LOWER(email))
      WHERE email IS NOT NULL AND email <> '';

    CREATE INDEX IF NOT EXISTS idx_people_name_phone
      ON people (LOWER(name), phone);

    CREATE TABLE IF NOT EXISTS admin_users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES admin_users (id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_admin_sessions_token
      ON admin_sessions (token_hash);

    CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires
      ON admin_sessions (expires_at);

    CREATE TABLE IF NOT EXISTS admin_password_resets (
      id TEXT PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES admin_users (id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_admin_password_resets_token
      ON admin_password_resets (token_hash);

    CREATE INDEX IF NOT EXISTS idx_admin_password_resets_expires
      ON admin_password_resets (expires_at);
  `);
  ensureServiceColumns(db);
  seedDatabase();
  return db;
}

function ensureServiceColumns(database) {
  const existingColumns = new Set(
    database
      .prepare("PRAGMA table_info(services)")
      .all()
      .map((column) => column.name),
  );
  if (!existingColumns.has("min_participants")) {
    database.exec("ALTER TABLE services ADD COLUMN min_participants INTEGER NOT NULL DEFAULT 1");
  }
  if (!existingColumns.has("lesson_format")) {
    database.exec("ALTER TABLE services ADD COLUMN lesson_format TEXT NOT NULL DEFAULT 'private'");
  }
  if (!existingColumns.has("price_mode")) {
    database.exec("ALTER TABLE services ADD COLUMN price_mode TEXT NOT NULL DEFAULT 'session'");
  }
}

function getSetting(key) {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row?.value ?? null;
}

function setSetting(key, value) {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, String(value ?? ""), nowIso());
}

function readJsonSetting(key) {
  const raw = getSetting(key);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function seedDatabase() {
  const database = db;
  const settings = defaultSettings();
  const insertSetting = database.prepare(
    "INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
  );
  Object.entries(settings).forEach(([key, value]) => insertSetting.run(key, value, nowIso()));

  const count = database.prepare("SELECT COUNT(*) AS count FROM calendar_items").get()?.count ?? 0;
  if (count === 0) {
    const legacy = readLegacyState();
    writeItemsToDb(normalizeItems(legacy?.items ?? initialItems));
    if (legacy?.syncKey) setSetting("syncKey", legacy.syncKey);
  }

  const peopleCount = database.prepare("SELECT COUNT(*) AS count FROM people").get()?.count ?? 0;
  if (peopleCount === 0) {
    importPeople(initialItems.map(personFromAppointment).filter(Boolean), "appointment");
  }

  const serviceCount = database.prepare("SELECT COUNT(*) AS count FROM services").get()?.count ?? 0;
  if (serviceCount === 0) {
    writeServicesToDb(defaultServices);
  }

  const availabilityCount = database.prepare("SELECT COUNT(*) AS count FROM availability_windows").get()?.count ?? 0;
  if (availabilityCount === 0) {
    writeAvailabilityToDb(defaultAvailability);
  }

  ensureAdminUser();
}

function readLegacyState() {
  if (!existsSync(legacyStatePath)) return null;
  try {
    return JSON.parse(readFileSync(legacyStatePath, "utf8"));
  } catch {
    return null;
  }
}

function rowToItem(row) {
  return {
    id: row.id,
    kind: row.kind,
    week: row.week,
    day: row.day,
    start: row.start,
    duration: row.duration,
    serviceId: row.service_id || "",
    client: row.client || "",
    title: row.title,
    phone: row.phone || "",
    email: row.email || "",
    note: row.note || "",
  };
}

function writeItemsToDb(items) {
  const database = getDb();
  const timestamp = nowIso();
  database.exec("BEGIN");
  try {
    database.prepare("DELETE FROM calendar_items").run();
    const insert = database.prepare(`
      INSERT INTO calendar_items (
        id, kind, week, day, start, duration, service_id, client, title, phone, email, note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    items.forEach((item) => {
      insert.run(
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
        timestamp,
        timestamp,
      );
    });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function readItemsFromDb() {
  return getDb()
    .prepare("SELECT * FROM calendar_items ORDER BY week, day, start, id")
    .all()
    .map(rowToItem);
}

function rowToService(row) {
  const lessonFormat = row.lesson_format === "group" ? "group" : "private";
  return {
    id: row.id,
    name: row.name,
    duration: row.duration,
    price: row.price,
    description: row.description || "",
    visibility: row.visibility === "private" ? "private" : "public",
    active: row.active !== 0,
    capacity: row.capacity || 1,
    minParticipants: row.min_participants || 1,
    lessonFormat,
    priceMode: lessonFormat === "group" && row.price_mode === "per-person" ? "per-person" : "session",
    location: row.location || "",
  };
}

function writeServicesToDb(serviceList) {
  const cleanServices = normalizeServices(serviceList);
  const database = getDb();
  const timestamp = nowIso();
  database.exec("BEGIN");
  try {
    database.prepare("DELETE FROM services").run();
    const insert = database.prepare(`
      INSERT INTO services (
        id, name, duration, price, description, visibility, active, capacity, min_participants, lesson_format,
        price_mode, location, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    cleanServices.forEach((service, index) => {
      insert.run(
        service.id,
        service.name,
        service.duration,
        service.price,
        service.description,
        service.visibility,
        service.active ? 1 : 0,
        service.capacity,
        service.minParticipants,
        service.lessonFormat,
        service.priceMode,
        service.location,
        index,
        timestamp,
        timestamp,
      );
    });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return cleanServices;
}

export function readServices() {
  const rows = getDb()
    .prepare("SELECT * FROM services ORDER BY sort_order, name, id")
    .all();
  return rows.length ? rows.map(rowToService) : normalizeServices(defaultServices);
}

export function writeServices(serviceList) {
  const services = writeServicesToDb(serviceList);
  setSetting("updatedAt", nowIso());
  return services;
}

export async function readLocations() {
  return normalizeLocations(readJsonSetting("locationsJson"), await readCoachAccount());
}

export async function writeLocations(locationList) {
  const locations = normalizeLocations(locationList, await readCoachAccount());
  setSetting("locationsJson", JSON.stringify(locations));
  setSetting("updatedAt", nowIso());
  return locations;
}

export async function readCoaches() {
  return normalizeCoachProfiles(readJsonSetting("coachesJson"), await readCoachAccount());
}

export async function writeCoaches(coachList) {
  const coaches = normalizeCoachProfiles(coachList, await readCoachAccount());
  setSetting("coachesJson", JSON.stringify(coaches));
  setSetting("updatedAt", nowIso());
  return coaches;
}

function rowToAvailabilityWindow(row) {
  return {
    start: row.start,
    end: row.end,
  };
}

function writeAvailabilityToDb(nextAvailability) {
  const cleanAvailability = normalizeAvailability(nextAvailability);
  const database = getDb();
  const timestamp = nowIso();
  database.exec("BEGIN");
  try {
    database.prepare("DELETE FROM availability_windows").run();
    const insert = database.prepare(`
      INSERT INTO availability_windows (id, day, start, "end", sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    cleanAvailability.forEach((windows, day) => {
      windows.forEach((window, index) => {
        insert.run(`availability-${day}-${index}`, day, window.start, window.end, index, timestamp, timestamp);
      });
    });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return cleanAvailability;
}

export function readAvailability() {
  const rows = getDb()
    .prepare('SELECT day, start, "end" AS end FROM availability_windows ORDER BY day, sort_order, start')
    .all();
  if (!rows.length) return normalizeAvailability(defaultAvailability);
  const availability = Array.from({ length: 7 }, () => []);
  rows.forEach((row) => {
    availability[row.day]?.push(rowToAvailabilityWindow(row));
  });
  return normalizeAvailability(availability);
}

export function writeAvailability(nextAvailability) {
  const availability = writeAvailabilityToDb(nextAvailability);
  setSetting("updatedAt", nowIso());
  return availability;
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

export function readPeople() {
  return getDb()
    .prepare("SELECT * FROM people ORDER BY LOWER(name), LOWER(email), id")
    .all()
    .map(rowToPerson);
}

export function importPeople(rawPeople, source = "import") {
  const people = Array.isArray(rawPeople) ? rawPeople.map((person) => cleanPerson(person, source)).filter(Boolean) : [];
  const result = {
    imported: 0,
    updated: 0,
    skipped: Array.isArray(rawPeople) ? rawPeople.length - people.length : 0,
    people: [],
  };
  if (!Array.isArray(rawPeople)) return result;

  const database = getDb();
  const insert = database.prepare(`
    INSERT INTO people (
      id, name, email, phone, notes, source, caddy_profile_id, caddy_profile_url, created_at, updated_at
    ) VALUES (?, ?, NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), ?, NULLIF(?, ''), NULLIF(?, ''), ?, ?)
  `);
  const update = database.prepare(`
    UPDATE people
    SET name = COALESCE(NULLIF(?, ''), name),
        email = COALESCE(NULLIF(?, ''), email),
        phone = COALESCE(NULLIF(?, ''), phone),
        notes = COALESCE(NULLIF(?, ''), notes),
        source = COALESCE(NULLIF(?, ''), source),
        caddy_profile_id = COALESCE(NULLIF(?, ''), caddy_profile_id),
        caddy_profile_url = COALESCE(NULLIF(?, ''), caddy_profile_url),
        updated_at = ?
    WHERE id = ?
  `);

  database.exec("BEGIN");
  try {
    people.forEach((person) => {
      const existing = findExistingPerson(database, person, true);

      const timestamp = nowIso();
      if (existing?.id) {
        update.run(
          person.name,
          person.email,
          person.phone,
          person.notes,
          person.source || source,
          person.caddyProfileId,
          person.caddyProfileUrl,
          timestamp,
          existing.id,
        );
        result.updated += 1;
      } else {
        insert.run(
          person.id || randomUUID(),
          person.name,
          person.email,
          person.phone,
          person.notes,
          person.source || source,
          person.caddyProfileId,
          person.caddyProfileUrl,
          timestamp,
          timestamp,
        );
        result.imported += 1;
      }
    });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  result.people = readPeople();
  return result;
}

export function updatePerson(rawPerson) {
  const person = cleanPerson(rawPerson, "manual_update");
  if (!person) {
    const error = new Error("A person needs a name or email.");
    error.status = 400;
    throw error;
  }

  const database = getDb();
  const existing = findExistingPerson(database, person);

  const timestamp = nowIso();
  const personId = existing?.id || (person.id && !person.id.startsWith("appointment-") ? person.id : randomUUID());

  if (existing?.id) {
    database
      .prepare(
        `UPDATE people
         SET name = ?,
             email = NULLIF(?, ''),
             phone = NULLIF(?, ''),
             notes = NULLIF(?, ''),
             source = COALESCE(NULLIF(?, ''), source),
             caddy_profile_id = NULLIF(?, ''),
             caddy_profile_url = NULLIF(?, ''),
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        person.name,
        person.email,
        person.phone,
        person.notes,
        person.source,
        person.caddyProfileId,
        person.caddyProfileUrl,
        timestamp,
        personId,
      );
  } else {
    database
      .prepare(
        `INSERT INTO people (
          id, name, email, phone, notes, source, caddy_profile_id, caddy_profile_url, created_at, updated_at
        ) VALUES (?, ?, NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), ?, NULLIF(?, ''), NULLIF(?, ''), ?, ?)`,
      )
      .run(
        personId,
        person.name,
        person.email,
        person.phone,
        person.notes,
        person.source,
        person.caddyProfileId,
        person.caddyProfileUrl,
        timestamp,
        timestamp,
      );
  }

  const saved = database.prepare("SELECT * FROM people WHERE id = ?").get(personId);
  return { person: rowToPerson(saved), people: readPeople() };
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const passwordHash = scryptSync(password, salt, 64).toString("hex");
  return { passwordHash, salt };
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function ensureAdminUser() {
  const database = getDb();
  const email = cleanEmail(process.env.CLARITY_ADMIN_EMAIL || "", "");
  const password = process.env.CLARITY_ADMIN_PASSWORD || "";

  if (!email || !password) {
    console.warn("Admin user not seeded because CLARITY_ADMIN_EMAIL or CLARITY_ADMIN_PASSWORD is not set.");
    return;
  }

  const existing = database.prepare("SELECT id FROM admin_users WHERE email = ?").get(email);

  const { passwordHash, salt } = hashPassword(password);
  const seedKey = hashToken(`${email}:${password}`);
  if (existing) {
    if (getSetting("adminPasswordSeedKey") === seedKey) return;
    database
      .prepare("UPDATE admin_users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE email = ?")
      .run(passwordHash, salt, nowIso(), email);
    setSetting("adminPasswordSeedKey", seedKey);
    return;
  }

  const timestamp = nowIso();
  database
    .prepare(
      `INSERT INTO admin_users (id, email, password_hash, password_salt, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), email, passwordHash, salt, timestamp, timestamp);
  setSetting("adminPasswordSeedKey", seedKey);
}

export async function verifyAdminPassword(email, password) {
  const row = getDb()
    .prepare("SELECT * FROM admin_users WHERE email = ?")
    .get(cleanString(email, "", 180));
  if (!row || typeof password !== "string") return null;

  const { passwordHash } = hashPassword(password, row.password_salt);
  const saved = Buffer.from(row.password_hash, "hex");
  const attempt = Buffer.from(passwordHash, "hex");
  if (saved.length !== attempt.length || !timingSafeEqual(saved, attempt)) return null;

  return { id: row.id, email: row.email };
}

export async function cleanupExpiredPasswordResets() {
  getDb()
    .prepare("DELETE FROM admin_password_resets WHERE expires_at <= ? OR used_at IS NOT NULL")
    .run(nowIso());
}

export async function createPasswordReset(email) {
  const cleanedEmail = cleanEmail(email, "");
  if (!cleanedEmail) return null;
  const row = getDb()
    .prepare("SELECT id, email FROM admin_users WHERE LOWER(email) = LOWER(?) LIMIT 1")
    .get(cleanedEmail);
  if (!row) return null;

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + passwordResetMinutes * 60 * 1000).toISOString();
  getDb()
    .prepare(
      `INSERT INTO admin_password_resets (id, token_hash, user_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), hashToken(token), row.id, expiresAt, nowIso());
  return { token, expiresAt, email: row.email };
}

export async function resetAdminPassword(token, password) {
  const cleanToken = cleanString(token, "", 500);
  if (!cleanToken) return { error: "invalid_token" };
  if (typeof password !== "string" || password.length < 8) return { error: "weak_password" };

  const row = getDb()
    .prepare(
      `SELECT admin_password_resets.id AS reset_id,
              admin_users.id AS user_id,
              admin_users.email AS email
       FROM admin_password_resets
       JOIN admin_users ON admin_users.id = admin_password_resets.user_id
       WHERE admin_password_resets.token_hash = ?
         AND admin_password_resets.used_at IS NULL
         AND admin_password_resets.expires_at > ?
       LIMIT 1`,
    )
    .get(hashToken(cleanToken), nowIso());
  if (!row) return { error: "invalid_token" };

  const { passwordHash, salt } = hashPassword(password);
  const database = getDb();
  database.exec("BEGIN");
  try {
    database
      .prepare("UPDATE admin_users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?")
      .run(passwordHash, salt, nowIso(), row.user_id);
    database.prepare("UPDATE admin_password_resets SET used_at = ? WHERE id = ?").run(nowIso(), row.reset_id);
    database.prepare("DELETE FROM admin_sessions WHERE user_id = ?").run(row.user_id);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return { user: { id: row.user_id, email: row.email } };
}

export async function changeAdminPassword(session, currentPassword, nextPassword) {
  if (!session?.email) return { error: "unauthorized" };
  if (typeof nextPassword !== "string" || nextPassword.length < 8) return { error: "weak_password" };
  const user = await verifyAdminPassword(session.email, currentPassword || "");
  if (!user) return { error: "invalid_current_password" };

  const { passwordHash, salt } = hashPassword(nextPassword);
  const database = getDb();
  database
    .prepare("UPDATE admin_users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?")
    .run(passwordHash, salt, nowIso(), user.id);
  database.prepare("DELETE FROM admin_sessions WHERE user_id = ?").run(user.id);
  return { user };
}

export async function createAdminSession(userId) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000).toISOString();
  getDb()
    .prepare("INSERT INTO admin_sessions (id, token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(randomUUID(), hashToken(token), userId, expiresAt, nowIso());
  return { token, expiresAt };
}

export async function readAdminSession(token) {
  if (!token) return null;
  const row = getDb()
    .prepare(
      `SELECT admin_users.id, admin_users.email, admin_sessions.expires_at
       FROM admin_sessions
       JOIN admin_users ON admin_users.id = admin_sessions.user_id
       WHERE admin_sessions.token_hash = ?`,
    )
    .get(hashToken(token));
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await destroyAdminSession(token);
    return null;
  }
  return { id: row.id, email: row.email, expiresAt: row.expires_at };
}

export async function destroyAdminSession(token) {
  if (!token) return;
  getDb().prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(hashToken(token));
}

export async function cleanupExpiredSessions() {
  getDb().prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").run(nowIso());
}

export async function readCalendarState() {
  const state = {
    syncKey: getSetting("syncKey") || generateSyncKey(),
    updatedAt: getSetting("updatedAt") || nowIso(),
    items: readItemsFromDb(),
    services: readServices(),
    locations: await readLocations(),
    coaches: await readCoaches(),
    availability: readAvailability(),
    people: readPeople(),
    settings: await readAdminSettings(),
    brand: await readBrandSettings(),
    account: await readCoachAccount(),
  };
  if (!getSetting("syncKey")) setSetting("syncKey", state.syncKey);
  return state;
}

export async function writeCalendarState(nextState) {
  const current = await readCalendarState();
  const syncKey = cleanString(nextState?.syncKey, current.syncKey, 140);
  const items = normalizeItems(nextState?.items ?? current.items);
  const locations = Array.isArray(nextState?.locations) ? await writeLocations(nextState.locations) : current.locations;
  const coaches = Array.isArray(nextState?.coaches) ? await writeCoaches(nextState.coaches) : current.coaches;
  const updatedAt = nowIso();
  writeItemsToDb(items);
  setSetting("syncKey", syncKey);
  setSetting("updatedAt", updatedAt);
  importPeople(items.map(personFromAppointment).filter(Boolean), "appointment");
  return {
    syncKey,
    items,
    updatedAt,
    services: current.services,
    locations,
    coaches,
    availability: current.availability,
    people: readPeople(),
    settings: await readAdminSettings(),
    brand: await readBrandSettings(),
    account: await readCoachAccount(),
  };
}

export async function readCoachAccount() {
  getDb();
  const defaults = defaultCoachAccount();
  return cleanCoachAccount({
    id: getSetting("accountId") || defaults.id,
    coachName: getSetting("accountCoachName") || defaults.coachName,
    businessName: getSetting("accountBusinessName") || getSetting("coachName") || defaults.businessName,
    venueName: getSetting("accountVenueName") || defaults.venueName,
    venueShortName: getSetting("accountVenueShortName") || defaults.venueShortName,
    timezone: getSetting("accountTimezone") || defaults.timezone,
    contactEmail: getSetting("accountContactEmail") || defaults.contactEmail,
    bookingUrl: getSetting("accountBookingUrl") || defaults.bookingUrl,
    calendarSlug: getSetting("accountCalendarSlug") || defaults.calendarSlug,
    caddyWorkspaceUrl: getSetting("accountCaddyWorkspaceUrl") || defaults.caddyWorkspaceUrl,
  });
}

export async function writeCoachAccount(account) {
  const clean = cleanCoachAccount(account);
  setSetting("accountId", clean.id);
  setSetting("accountCoachName", clean.coachName);
  setSetting("accountBusinessName", clean.businessName);
  setSetting("accountVenueName", clean.venueName);
  setSetting("accountVenueShortName", clean.venueShortName);
  setSetting("accountTimezone", clean.timezone);
  setSetting("accountContactEmail", clean.contactEmail);
  setSetting("accountBookingUrl", clean.bookingUrl);
  setSetting("accountCalendarSlug", clean.calendarSlug);
  setSetting("accountCaddyWorkspaceUrl", clean.caddyWorkspaceUrl);
  setSetting("coachName", clean.businessName);
  setSetting("updatedAt", nowIso());
  return clean;
}

export async function readBrandSettings() {
  getDb();
  const account = await readCoachAccount();
  return {
    coachName: getSetting("coachName") || account.businessName,
    logoName: getSetting("brandLogoName") || "",
    logoPreview: getSetting("brandLogoPreview") || "",
    neutral: getSetting("brandNeutral") || "#ffffff",
    primary: getSetting("brandPrimary") || "#1fd36d",
    secondary: getSetting("brandSecondary") || "#d7b06b",
    accent: getSetting("brandAccent") || "#07100a",
    bookingTheme: getSetting("brandBookingTheme") === "light" ? "light" : "dark",
  };
}

export async function writeBrandSettings(settings) {
  const account = await readCoachAccount();
  setSetting("coachName", cleanString(settings?.coachName, account.businessName, 80));
  setSetting("brandLogoName", cleanString(settings?.logoName, "", 120));
  setSetting("brandLogoPreview", cleanLogoPreview(settings?.logoPreview));
  setSetting("brandNeutral", cleanHexColor(settings?.neutral, "#ffffff"));
  setSetting("brandPrimary", cleanHexColor(settings?.primary, "#1fd36d"));
  setSetting("brandSecondary", cleanHexColor(settings?.secondary, "#d7b06b"));
  setSetting("brandAccent", cleanHexColor(settings?.accent, "#07100a"));
  setSetting("brandBookingTheme", settings?.bookingTheme === "light" ? "light" : "dark");
  setSetting("updatedAt", nowIso());
  return readBrandSettings();
}

export async function readAdminSettings() {
  getDb();
  const delaySeconds = Number(getSetting("notificationDelaySeconds") || 30);
  return {
    notificationEmail: getSetting("notificationEmail") || "",
    replyToEmail: getSetting("replyToEmail") || "",
    notificationDelaySeconds: Number.isFinite(delaySeconds) ? Math.max(30, Math.min(3600, delaySeconds)) : 30,
    sendClientEmail: getSetting("sendClientEmail") !== "false",
    sendAdminEmail: getSetting("sendAdminEmail") !== "false",
    clientEmailSubject: getSetting("clientEmailSubject") || defaultEmailTemplates.clientEmailSubject,
    clientEmailIntro: getSetting("clientEmailIntro") || defaultEmailTemplates.clientEmailIntro,
    clientEmailFooter: getSetting("clientEmailFooter") || defaultEmailTemplates.clientEmailFooter,
    adminEmailSubject: getSetting("adminEmailSubject") || defaultEmailTemplates.adminEmailSubject,
    adminEmailIntro: getSetting("adminEmailIntro") || defaultEmailTemplates.adminEmailIntro,
    smsProviderName: getSetting("smsProviderName") || "",
    smsWebhookUrl: getSetting("smsWebhookUrl") || "",
    smsFromNumber: getSetting("smsFromNumber") || "",
    sendClientSms: getSetting("sendClientSms") === "true",
    sendAdminSms: getSetting("sendAdminSms") === "true",
  };
}

export async function writeAdminSettings(settings) {
  const delaySeconds = Number(settings?.notificationDelaySeconds ?? 30);
  setSetting("notificationEmail", cleanString(settings?.notificationEmail, "", 180));
  setSetting("replyToEmail", cleanString(settings?.replyToEmail, "", 180));
  setSetting("notificationDelaySeconds", String(Number.isFinite(delaySeconds) ? Math.max(30, Math.min(3600, delaySeconds)) : 30));
  setSetting("sendClientEmail", settings?.sendClientEmail ? "true" : "false");
  setSetting("sendAdminEmail", settings?.sendAdminEmail ? "true" : "false");
  setSetting("clientEmailSubject", cleanString(settings?.clientEmailSubject, defaultEmailTemplates.clientEmailSubject, 180));
  setSetting("clientEmailIntro", cleanString(settings?.clientEmailIntro, defaultEmailTemplates.clientEmailIntro, 900));
  setSetting("clientEmailFooter", cleanString(settings?.clientEmailFooter, defaultEmailTemplates.clientEmailFooter, 900));
  setSetting("adminEmailSubject", cleanString(settings?.adminEmailSubject, defaultEmailTemplates.adminEmailSubject, 180));
  setSetting("adminEmailIntro", cleanString(settings?.adminEmailIntro, defaultEmailTemplates.adminEmailIntro, 900));
  setSetting("smsProviderName", cleanString(settings?.smsProviderName, "", 80));
  setSetting("smsWebhookUrl", cleanString(settings?.smsWebhookUrl, "", 600));
  setSetting("smsFromNumber", cleanString(settings?.smsFromNumber, "", 80));
  setSetting("sendClientSms", settings?.sendClientSms ? "true" : "false");
  setSetting("sendAdminSms", settings?.sendAdminSms ? "true" : "false");
  setSetting("updatedAt", nowIso());
  return readAdminSettings();
}

export function publicCalendarState(state) {
  return {
    syncKey: state.syncKey,
    updatedAt: state.updatedAt,
    items: state.items,
    services: state.services || [],
    locations: state.locations || [],
    coaches: state.coaches || [],
    availability: state.availability || [],
    people: state.people || [],
    settings: state.settings,
    brand: state.brand,
    account: state.account,
  };
}

export function publicBookingState(state) {
  return {
    updatedAt: state.updatedAt,
    services: (state.services || []).filter((service) => service.active && service.visibility === "public"),
    locations: state.locations || [],
    coaches: state.coaches || [],
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

function serviceName(serviceId, serviceList = defaultServices) {
  return serviceList.find((service) => service.id === serviceId)?.name ?? "Golf Lesson";
}

function itemWeek(item) {
  return item.week ?? 0;
}

function slotOverlaps(a, b) {
  return a.week === b.week && a.day === b.day && a.start < b.start + b.duration && a.start + a.duration > b.start;
}

function isInsideAvailability(availability, day, start, duration) {
  const end = start + duration;
  return availability[day]?.some((window) => start >= window.start && end <= window.end) ?? false;
}

function hasCollision(items, candidate) {
  return items.some((item) =>
    slotOverlaps({ week: itemWeek(item), day: item.day, start: item.start, duration: item.duration }, candidate),
  );
}

export async function createPublicBooking(payload) {
  const state = await readCalendarState();
  const service = state.services.find(
    (candidate) => candidate.id === payload?.serviceId && candidate.active && candidate.visibility === "public",
  );
  if (!service) {
    const error = new Error("Choose a public lesson type.");
    error.status = 400;
    throw error;
  }

  const week = Number(payload.week ?? 0);
  const day = Number(payload.day);
  const start = Number(payload.start);
  const firstName = cleanString(payload.firstName, "", 80);
  const lastName = cleanString(payload.lastName, "", 80);
  const email = cleanString(payload.email, "", 180);
  const phone = cleanString(payload.phone, "", 80);

  if (!firstName || !lastName || !email) {
    const error = new Error("First name, last name, and email are required.");
    error.status = 400;
    throw error;
  }
  if (!Number.isInteger(week) || !Number.isInteger(day) || !Number.isInteger(start) || day < 0 || day > 6) {
    const error = new Error("Choose a valid appointment time.");
    error.status = 400;
    throw error;
  }

  const slot = { week, day, start, duration: service.duration };
  if (!isInsideAvailability(state.availability, day, start, service.duration) || hasCollision(state.items, slot)) {
    const error = new Error("That time is no longer available.");
    error.status = 409;
    throw error;
  }

  const client = `${firstName} ${lastName}`;
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
  };
  const nextState = await writeCalendarState({ ...state, items: [...state.items, appointment] });
  return { state: nextState, appointment };
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
  return date.toISOString().replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}Z$/, "Z");
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

export function generateCalendarFeed(state) {
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
    .sort((a, b) => itemWeek(a) - itemWeek(b) || a.day - b.day || a.start - b.start)
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
