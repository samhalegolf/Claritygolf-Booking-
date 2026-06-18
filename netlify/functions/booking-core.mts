import { getDatabase } from "@netlify/database";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

const sessionCookieName = "clarity_session";
const sessionDays = 7;
const passwordResetMinutes = 30;
const baseWeekStart = new Date(Date.UTC(2026, 5, 1));
const defaultEmailTemplates = {
  clientEmailSubject: "Your {{service}} is confirmed",
  clientEmailIntro: "Thanks {{firstName}}, your booking with {{coach}} is confirmed.",
  clientEmailFooter: "Need to move your booking? Reply to this email and we will help.",
  adminEmailSubject: "New booking: {{client}}",
  adminEmailIntro: "{{client}} booked {{service}} for {{date}} at {{time}}.",
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

function timeToMinutes(hour, minute) {
  return hour * 60 + minute;
}

function env(name, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
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
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).toLocaleDateString("en-NZ", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

function renderTemplate(template, variables) {
  return String(template || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => variables[key] ?? "");
}

function servicePriceLabel(service) {
  if (!service) return "No charge";
  return `NZ$${service.price}.00${service.priceMode === "per-person" ? " pp" : ""}`;
}

function cleanEmail(value, fallback = "sam@samhalegolf.co.nz") {
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
    id: env("CLARITY_COACH_ACCOUNT_ID", "sam-hale-golf"),
    coachName: env("CLARITY_COACH_NAME", "Sam Hale"),
    businessName: env("CLARITY_BUSINESS_NAME", "Sam Hale Golf"),
    venueName: env("CLARITY_VENUE_NAME", "The Range 24/7 - Three Kings"),
    venueShortName: env("CLARITY_VENUE_SHORT_NAME", "The Range 24/7"),
    timezone: env("CLARITY_TIMEZONE", "Pacific/Auckland"),
    contactEmail: env("CLARITY_CONTACT_EMAIL", "sam@samhalegolf.co.nz"),
    bookingUrl: env("CLARITY_BOOKING_URL", "https://book.claritygolf.app"),
    calendarSlug: env("CLARITY_CALENDAR_SLUG", "sam-hale-golf"),
    caddyWorkspaceUrl: env("CLARITY_CADDY_WORKSPACE_URL", "https://caddy.claritygolf.app"),
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
          : [decodeURIComponent(pair.slice(0, index)), decodeURIComponent(pair.slice(index + 1))];
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
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
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
  // Do not create a functional/partial unique index here. The Netlify/Supabase
  // storage adapter used by this app rejects queries such as
  // CREATE UNIQUE INDEX ... ON people (LOWER(email)) WHERE ... at runtime.
  // Duplicate protection for imports is handled in application code by
  // matching existing people on normalised email, phone, and name/contact.
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

async function defaultSettings() {
  const account = defaultCoachAccount();
  return {
    syncKey: env("CLARITY_CALENDAR_SYNC_KEY") || generateSyncKey(),
    notificationEmail: env("CLARITY_NOTIFICATION_EMAIL", "sam@samhalegolf.co.nz"),
    replyToEmail: env("CLARITY_REPLY_TO_EMAIL", "sam@samhalegolf.co.nz"),
    notificationDelaySeconds: "30",
    sendClientEmail: "true",
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
    coachName: account.businessName,
    servicesJson: JSON.stringify(defaultServices),
    availabilityJson: JSON.stringify(defaultAvailability),
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

async function seedDefaults() {
  const settings = await defaultSettings();
  for (const [key, value] of Object.entries(settings)) {
    const rows = await db().sql`SELECT value FROM settings WHERE key = ${key}`;
    if (!rows.length) {
      await setSetting(key, value);
    }
  }
}

async function seedAdmin() {
  const email = cleanEmail(env("CLARITY_ADMIN_EMAIL", "sam@samhalegolf.co.nz"));
  const password = env("CLARITY_ADMIN_PASSWORD", "ClarityGolfAdmin2026!");
  const rows = await db().sql`SELECT id FROM admin_users WHERE LOWER(email) = LOWER(${email}) LIMIT 1`;
  if (rows.length) return;
  const { passwordHash, salt } = hashPassword(password);
  await db().sql`
    INSERT INTO admin_users (id, email, password_hash, password_salt, created_at, updated_at)
    VALUES (${randomUUID()}, ${email}, ${passwordHash}, ${salt}, NOW(), NOW())
  `;
}

async function ensureSeeded() {
  await ensureCoreTables();
  await seedDefaults();
  await seedAdmin();
}

function rowToService(row) {
  return cleanService({
    id: row.id,
    name: row.name,
    duration: Number(row.duration),
    price: Number(row.price),
    description: row.description,
    visibility: row.visibility,
    active: row.active !== false,
    capacity: Number(row.capacity || 1),
    minParticipants: Number(row.min_participants || row.minParticipants || 1),
    lessonFormat: row.lesson_format || row.lessonFormat || "private",
    priceMode: row.price_mode || row.priceMode || "session",
    location: row.location || "",
  });
}

function rowToPerson(row) {
  return {
    id: row.id,
    name: cleanString(row.name, "Unnamed client", 180),
    email: cleanString(row.email, "", 180),
    phone: cleanString(row.phone, "", 80),
    notes: cleanString(row.notes, "", 2000),
    source: cleanString(row.source, "", 120),
    caddyProfileId: cleanString(row.caddy_profile_id, "", 120),
    caddyProfileUrl: cleanString(row.caddy_profile_url, "", 300),
    bookings: Number(row.booking_count ?? 0),
    lastBookingAt: cleanString(row.last_booking_at, "", 80),
  };
}

function personFromAppointment(item) {
  const client = cleanString(item.client || item.title, "", 180);
  if (!client && !item.email && !item.phone) return null;
  return {
    id: item.id ? `appointment-${item.id}` : randomUUID(),
    name: client || item.email || item.phone,
    email: cleanString(item.email, "", 180),
    phone: cleanString(item.phone, "", 80),
    notes: cleanString(item.note, "", 800),
    source: "appointment",
  };
}

function cleanPerson(person, fallbackSource = "manual") {
  if (!person || typeof person !== "object") return null;
  const name = cleanString(person.name || person.fullName || [person.firstName, person.lastName].filter(Boolean).join(" "), "", 180);
  const email = cleanString(person.email, "", 180).toLowerCase();
  const phone = cleanString(person.phone || person.mobile, "", 80);
  const notes = cleanString(person.notes || person.note, "", 2000);
  if (!name && !email && !phone) return null;
  return {
    id: cleanString(person.id, "", 120),
    name: name || email || phone,
    email,
    phone,
    notes,
    source: cleanString(person.source, fallbackSource, 120),
    caddyProfileId: cleanString(person.caddyProfileId || person.caddy_profile_id, "", 120),
    caddyProfileUrl: cleanString(person.caddyProfileUrl || person.caddy_profile_url, "", 300),
  };
}

function normalizeItem(item) {
  const service = cleanString(item.serviceId || item.service_id, "lesson-30", 80);
  const title = cleanString(item.title || item.client, "Booking", 160);
  const client = cleanString(item.client || title, title, 160);
  const start = Number.isFinite(Number(item.start)) ? Math.round(Number(item.start)) : timeToMinutes(9, 0);
  const duration = Number.isFinite(Number(item.duration)) ? Math.round(Number(item.duration)) : 30;
  const day = Number.isFinite(Number(item.day)) ? Math.max(0, Math.min(6, Math.round(Number(item.day)))) : 0;
  const week = Number.isFinite(Number(item.week)) ? Math.max(-52, Math.min(520, Math.round(Number(item.week)))) : 0;
  return {
    id: cleanString(item.id, randomUUID(), 120),
    kind: item.kind === "block" ? "block" : "booking",
    week,
    day,
    start: Math.max(0, Math.min(24 * 60, start)),
    duration: Math.max(15, Math.min(240, duration)),
    serviceId: service,
    client,
    title,
    phone: cleanString(item.phone, "", 80),
    email: cleanString(item.email, "", 180).toLowerCase(),
    note: cleanString(item.note, "", 1000),
  };
}

function normalizeItems(items) {
  return (Array.isArray(items) ? items : initialItems).map(normalizeItem);
}

function minutesToDateForWeek(week, day, start) {
  const base = new Date(baseWeekStart.getTime());
  base.setUTCDate(base.getUTCDate() + Number(week || 0) * 7 + Number(day || 0));
  base.setUTCHours(Math.floor(start / 60), start % 60, 0, 0);
  return base;
}

function dateForSlot(week, day) {
  const date = minutesToDateForWeek(week, day, 0);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function isoForSlot(item) {
  return minutesToDateForWeek(item.week || 0, item.day || 0, item.start || 0).toISOString();
}

function publicItem(item, services = defaultServices) {
  const service = services.find((entry) => entry.id === item.serviceId);
  return {
    ...item,
    date: formatBookingDate(item.week || 0, item.day || 0),
    time: formatTime(item.start),
    timeRange: formatRange(item.start, item.duration),
    serviceName: service?.name || item.serviceId,
    servicePrice: servicePriceLabel(service),
  };
}

function findService(services, serviceId) {
  return services.find((service) => service.id === serviceId) || services[0] || defaultServices[0];
}

function parseDateParts(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function weekDayFromDate(value) {
  const parts = parseDateParts(value);
  if (!parts) return null;
  const target = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const diffMs = target.getTime() - baseWeekStart.getTime();
  const diffDays = Math.round(diffMs / 86_400_000);
  const week = Math.floor(diffDays / 7);
  const day = ((diffDays % 7) + 7) % 7;
  return { week, day };
}

function serviceDurationForId(services, serviceId) {
  return findService(services, serviceId)?.duration || 30;
}

function bookingMatchesLookup(item, lookup) {
  if (!item || item.kind !== "booking") return false;
  if (lookup.id && item.id === lookup.id) return true;
  const email = cleanString(lookup.email, "", 180).toLowerCase();
  const phone = cleanString(lookup.phone, "", 80);
  const client = cleanString(lookup.client, "", 180).toLowerCase();
  const dateMatch = lookup.date
    ? weekDayFromDate(lookup.date)?.week === item.week && weekDayFromDate(lookup.date)?.day === item.day
    : true;
  const contactMatch =
    (email && item.email?.toLowerCase() === email) ||
    (phone && item.phone === phone) ||
    (client && item.client?.toLowerCase() === client);
  return Boolean(dateMatch && contactMatch);
}

async function requestCalendarReschedule(request) {
  await ensureSeeded();
  const lookup = request || {};
  const rows = await db().sql`
    SELECT * FROM calendar_items
    WHERE kind = 'booking'
    ORDER BY week DESC, day DESC, start DESC
  `;
  const services = await readServices();
  const items = rows.map(normalizeItem);
  const existing = items.find((item) => bookingMatchesLookup(item, lookup));
  if (!existing) {
    const error = new Error("We could not find a matching booking. Please reply to your confirmation email or contact us directly.");
    error.status = 404;
    throw error;
  }
  const publicBooking = publicItem(existing, services);
  const record = await queueNotification({
    kind: "reschedule_request",
    recipient: await getSetting("notificationEmail"),
    subject: `Reschedule request: ${publicBooking.client}`,
    html: renderEmailLayout({
      title: `Reschedule request: ${publicBooking.client}`,
      intro: `${escapeHtml(publicBooking.client)} asked to reschedule a booking.`,
      rows: [
        ["Current booking", `${publicBooking.date} at ${publicBooking.timeRange}`],
        ["Service", publicBooking.serviceName],
        ["Email", publicBooking.email || "Not supplied"],
        ["Phone", publicBooking.phone || "Not supplied"],
        ["Message", cleanString(lookup.message, "", 600) || "No message supplied"],
      ],
      footer: "Open the admin calendar to move this booking.",
    }),
    text: `${publicBooking.client} requested a reschedule for ${publicBooking.date} at ${publicBooking.timeRange}. ${cleanString(lookup.message, "", 600)}`,
    meta: { bookingId: existing.id, request: lookup },
  });
  return { ok: true, booking: publicBooking, notification: record };
}

async function readItems() {
  await ensureSeeded();
  const rows = await db().sql`SELECT * FROM calendar_items ORDER BY week, day, start`;
  return rows.map(normalizeItem);
}

async function readNotificationHistory() {
  await ensureSeeded();
  const rows = await db().sql`
    SELECT * FROM notification_history
    ORDER BY created_at DESC
    LIMIT 200
  `;
  return rows.map((row) => ({
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
  }));
}

function notificationPersonKey({ email = "", phone = "", client = "" }) {
  const emailKey = cleanString(email, "", 180).toLowerCase();
  if (emailKey) return `email:${emailKey}`;
  const phoneKey = cleanString(phone, "", 80).replace(/\s+/g, "");
  if (phoneKey) return `phone:${phoneKey}`;
  return `client:${cleanString(client, "", 180).toLowerCase()}`;
}

function notificationRecordFromMeta(meta = {}) {
  const id = cleanString(meta.notificationId, "", 120) || randomUUID();
  return {
    id,
    createdAt: nowIso(),
    personKey: notificationPersonKey(meta),
    calendarItemId: cleanString(meta.calendarItemId, "", 120),
    recipient: cleanString(meta.recipient, "", 180),
    subject: cleanString(meta.subject, "", 220),
    kind: cleanString(meta.kind, "email", 80),
    status: cleanString(meta.status, "queued", 80),
    provider: cleanString(meta.provider, "pending", 80),
    providerId: cleanString(meta.providerId, "", 180),
    error: cleanString(meta.error, "", 500),
  };
}

async function insertNotificationHistory(meta = {}) {
  const record = notificationRecordFromMeta(meta);
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

function normalizePhoneForImport(phone) {
  return cleanString(phone, "", 80).replace(/[^0-9+]/g, "").replace(/^00/, "+");
}

function mergeImportedNotes(existingNotes, importedNotes, appendNotes = true) {
  const existing = cleanString(existingNotes, "", 2000);
  const incoming = cleanString(importedNotes, "", 1200);
  if (!incoming) return existing;
  if (!existing) return incoming;
  if (!appendNotes) return incoming;
  if (existing.includes(incoming)) return existing;
  return `${existing}\n\n${incoming}`.slice(0, 2400);
}

function findExistingImportPerson(existingPeople, person) {
  const email = cleanString(person.email, "", 180).toLowerCase();
  const phone = normalizePhoneForImport(person.phone);
  const name = cleanString(person.name, "", 180).toLowerCase();
  if (person.id && !person.id.startsWith("import-") && !person.id.startsWith("csv-")) {
    const byId = existingPeople.find((candidate) => candidate.id === person.id);
    if (byId) return byId;
  }
  if (email) {
    const byEmail = existingPeople.find((candidate) => cleanString(candidate.email, "", 180).toLowerCase() === email);
    if (byEmail) return byEmail;
  }
  if (phone) {
    const byPhone = existingPeople.find((candidate) => normalizePhoneForImport(candidate.phone) === phone);
    if (byPhone) return byPhone;
  }
  if (name && (email || phone)) {
    return existingPeople.find((candidate) => {
      const candidateName = cleanString(candidate.name, "", 180).toLowerCase();
      return (
        candidateName === name &&
        ((email && cleanString(candidate.email, "", 180).toLowerCase() === email) ||
          (phone && normalizePhoneForImport(candidate.phone) === phone))
      );
    }) || null;
  }
  return null;
}

async function importPeople(rawPeople, source = "import", options = {}) {
  const people = Array.isArray(rawPeople) ? rawPeople.map((person) => cleanPerson(person, source)).filter(Boolean) : [];
  const mode = ["create_only", "update_existing", "upsert"].includes(options?.mode) ? options.mode : "upsert";
  const appendNotes = options?.appendNotes !== false;
  const result = {
    imported: 0,
    created: 0,
    updated: 0,
    skipped: Array.isArray(rawPeople) ? rawPeople.length - people.length : 0,
    failed: 0,
    errors: [],
    results: [],
    people: [],
  };
  if (!Array.isArray(rawPeople)) return result;

  const client = await db().pool.connect();
  try {
    const existingResult = await client.query("SELECT * FROM people ORDER BY LOWER(name), LOWER(email), id");
    const knownPeople = existingResult.rows || [];
    for (let index = 0; index < people.length; index += 1) {
      const person = people[index];
      const rowNumber = Number(rawPeople[index]?.rowNumber || index + 1);
      try {
        await client.query("BEGIN");
        const existing = findExistingImportPerson(knownPeople, person);

        if (existing && mode === "create_only") {
          result.skipped += 1;
          result.results.push({ rowNumber, status: "skipped", reason: "Existing client matched; create-only mode selected.", id: existing.id });
          await client.query("COMMIT");
          continue;
        }
        if (!existing && mode === "update_existing") {
          result.skipped += 1;
          result.results.push({ rowNumber, status: "skipped", reason: "No existing client matched; update-only mode selected." });
          await client.query("COMMIT");
          continue;
        }

        if (existing) {
          const nextNotes = mergeImportedNotes(existing.notes, person.notes, appendNotes);
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
              existing.id,
              person.name,
              person.email,
              person.phone,
              nextNotes,
              person.source || source,
              person.caddyProfileId,
              person.caddyProfileUrl,
            ],
          );
          Object.assign(existing, {
            name: person.name || existing.name,
            email: person.email || existing.email,
            phone: person.phone || existing.phone,
            notes: nextNotes || existing.notes,
            source: person.source || source || existing.source,
            caddy_profile_id: person.caddyProfileId || existing.caddy_profile_id,
            caddy_profile_url: person.caddyProfileUrl || existing.caddy_profile_url,
          });
          result.updated += 1;
          result.results.push({ rowNumber, status: "updated", id: existing.id });
        } else {
          const personId = randomUUID();
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
          knownPeople.push({
            id: personId,
            name: person.name,
            email: person.email,
            phone: person.phone,
            notes: person.notes,
            source: person.source || source,
            caddy_profile_id: person.caddyProfileId,
            caddy_profile_url: person.caddyProfileUrl,
          });
          result.imported += 1;
          result.created += 1;
          result.results.push({ rowNumber, status: "created", id: personId });
        }
        await client.query("COMMIT");
      } catch (rowError) {
        await client.query("ROLLBACK").catch(() => undefined);
        result.failed += 1;
        const reason = rowError instanceof Error ? rowError.message : "Unknown row import error.";
        result.errors.push({ rowNumber, reason });
        result.results.push({ rowNumber, status: "failed", reason });
      }
    }
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

  const client = await db().pool.connect();
  try {
    await client.query("BEGIN");
    let existingId = "";
    if (person.id && !person.id.startsWith("appointment-")) {
      const existing = await client.query("SELECT id FROM people WHERE id = $1 LIMIT 1", [person.id]);
      existingId = existing.rows[0]?.id || "";
    }
    if (!existingId && person.email) {
      const existing = await client.query("SELECT id FROM people WHERE LOWER(email) = LOWER($1) LIMIT 1", [
        person.email,
      ]);
      existingId = existing.rows[0]?.id || "";
    }
    if (!existingId && person.phone) {
      const existing = await client.query(
        "SELECT id FROM people WHERE LOWER(name) = LOWER($1) AND phone = $2 LIMIT 1",
        [person.name, person.phone],
      );
      existingId = existing.rows[0]?.id || "";
    }

    const personId = existingId || (person.id && !person.id.startsWith("appointment-") ? person.id : randomUUID());
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

    const saved = await client.query("SELECT * FROM people WHERE id = $1 LIMIT 1", [personId]);
    await client.query("COMMIT");
    return { person: rowToPerson(saved.rows[0]), people: await readPeople() };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function writeItems(items) {
  const cleanItems = normalizeItems(items);
  const client = await db().pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM calendar_items");
    for (const item of cleanItems) {
      await client.query(
        `INSERT INTO calendar_items (
          id, kind, week, day, start, duration, service_id, client, title, phone, email, note, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())`,
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
  return cleanItems;
}

async function seedPeopleFromAppointments() {
  const countRows = await db().sql`SELECT COUNT(*) AS count FROM people`;
  if ((countRows[0]?.count ?? 0) > 0) return;
  await importPeople(initialItems.map(personFromAppointment).filter(Boolean), "appointment");
}

async function readAdminSettings() {
  await ensureSeeded();
  const delaySeconds = Number((await getSetting("notificationDelaySeconds")) || 30);
  return {
    notificationEmail: await getSetting("notificationEmail"),
    replyToEmail: await getSetting("replyToEmail"),
    notificationDelaySeconds: Number.isFinite(delaySeconds) ? Math.max(30, Math.min(3600, delaySeconds)) : 30,
    sendClientEmail: (await getSetting("sendClientEmail")) !== "false",
    sendAdminEmail: (await getSetting("sendAdminEmail")) !== "false",
    clientEmailSubject: (await getSetting("clientEmailSubject")) || defaultEmailTemplates.clientEmailSubject,
    clientEmailIntro: (await getSetting("clientEmailIntro")) || defaultEmailTemplates.clientEmailIntro,
    clientEmailFooter: (await getSetting("clientEmailFooter")) || defaultEmailTemplates.clientEmailFooter,
    adminEmailSubject: (await getSetting("adminEmailSubject")) || defaultEmailTemplates.adminEmailSubject,
    adminEmailIntro: (await getSetting("adminEmailIntro")) || defaultEmailTemplates.adminEmailIntro,
    smsProviderName: await getSetting("smsProviderName"),
    smsWebhookUrl: await getSetting("smsWebhookUrl"),
    smsFromNumber: await getSetting("smsFromNumber"),
    sendClientSms: (await getSetting("sendClientSms")) === "true",
    sendAdminSms: (await getSetting("sendAdminSms")) === "true",
  };
}

async function writeAdminSettings(settings) {
  const next = {
    notificationEmail: cleanEmail(settings?.notificationEmail),
    replyToEmail: cleanEmail(settings?.replyToEmail),
    notificationDelaySeconds: String(
      Math.max(30, Math.min(3600, Math.round(Number(settings?.notificationDelaySeconds) || 30))),
    ),
    sendClientEmail: settings?.sendClientEmail === false ? "false" : "true",
    sendAdminEmail: settings?.sendAdminEmail === false ? "false" : "true",
    clientEmailSubject: cleanString(settings?.clientEmailSubject, defaultEmailTemplates.clientEmailSubject, 180),
    clientEmailIntro: cleanString(settings?.clientEmailIntro, defaultEmailTemplates.clientEmailIntro, 500),
    clientEmailFooter: cleanString(settings?.clientEmailFooter, defaultEmailTemplates.clientEmailFooter, 500),
    adminEmailSubject: cleanString(settings?.adminEmailSubject, defaultEmailTemplates.adminEmailSubject, 180),
    adminEmailIntro: cleanString(settings?.adminEmailIntro, defaultEmailTemplates.adminEmailIntro, 500),
    smsProviderName: cleanString(settings?.smsProviderName, "", 80),
    smsWebhookUrl: cleanUrl(settings?.smsWebhookUrl, ""),
    smsFromNumber: cleanString(settings?.smsFromNumber, "", 40),
    sendClientSms: settings?.sendClientSms === true ? "true" : "false",
    sendAdminSms: settings?.sendAdminSms === true ? "true" : "false",
  };
  for (const [key, value] of Object.entries(next)) await setSetting(key, value);
  await setSetting("updatedAt", nowIso());
  return readAdminSettings();
}

async function readCoachAccount() {
  await ensureSeeded();
  return cleanCoachAccount({
    id: await getSetting("accountId"),
    coachName: await getSetting("accountCoachName"),
    businessName: await getSetting("accountBusinessName") || (await getSetting("coachName")),
    venueName: await getSetting("accountVenueName"),
    venueShortName: await getSetting("accountVenueShortName"),
    timezone: await getSetting("accountTimezone"),
    contactEmail: await getSetting("accountContactEmail"),
    bookingUrl: await getSetting("accountBookingUrl"),
    calendarSlug: await getSetting("accountCalendarSlug"),
    caddyWorkspaceUrl: await getSetting("accountCaddyWorkspaceUrl"),
  });
}

async function writeCoachAccount(account) {
  const next = cleanCoachAccount(account);
  await setSetting("accountId", next.id);
  await setSetting("accountCoachName", next.coachName);
  await setSetting("accountBusinessName", next.businessName);
  await setSetting("accountVenueName", next.venueName);
  await setSetting("accountVenueShortName", next.venueShortName);
  await setSetting("accountTimezone", next.timezone);
  await setSetting("accountContactEmail", next.contactEmail);
  await setSetting("accountBookingUrl", next.bookingUrl);
  await setSetting("accountCalendarSlug", next.calendarSlug);
  await setSetting("accountCaddyWorkspaceUrl", next.caddyWorkspaceUrl);
  await setSetting("coachName", next.businessName);
  await setSetting("updatedAt", nowIso());
  return readCoachAccount();
}

async function readBrandSettings() {
  await ensureSeeded();
  return {
    logoName: await getSetting("brandLogoName"),
    logoPreview: await getSetting("brandLogoPreview"),
    neutral: cleanHexColor(await getSetting("brandNeutral"), "#ffffff"),
    primary: cleanHexColor(await getSetting("brandPrimary"), "#1fd36d"),
    secondary: cleanHexColor(await getSetting("brandSecondary"), "#d7b06b"),
    accent: cleanHexColor(await getSetting("brandAccent"), "#07100a"),
    bookingTheme: (await getSetting("brandBookingTheme")) === "light" ? "light" : "dark",
  };
}

async function writeBrandSettings(settings) {
  const next = {
    logoName: cleanString(settings?.logoName, "", 160),
    logoPreview: cleanLogoPreview(settings?.logoPreview),
    neutral: cleanHexColor(settings?.neutral, "#ffffff"),
    primary: cleanHexColor(settings?.primary, "#1fd36d"),
    secondary: cleanHexColor(settings?.secondary, "#d7b06b"),
    accent: cleanHexColor(settings?.accent, "#07100a"),
    bookingTheme: settings?.bookingTheme === "light" ? "light" : "dark",
  };
  await setSetting("brandLogoName", next.logoName);
  await setSetting("brandLogoPreview", next.logoPreview);
  await setSetting("brandNeutral", next.neutral);
  await setSetting("brandPrimary", next.primary);
  await setSetting("brandSecondary", next.secondary);
  await setSetting("brandAccent", next.accent);
  await setSetting("brandBookingTheme", next.bookingTheme);
  await setSetting("updatedAt", nowIso());
  return readBrandSettings();
}

async function readServices() {
  await ensureSeeded();
  try {
    const services = JSON.parse((await getSetting("servicesJson")) || "[]");
    return normalizeServices(services);
  } catch {
    return defaultServices;
  }
}

async function writeServices(services) {
  const normalized = normalizeServices(services);
  await setSetting("servicesJson", JSON.stringify(normalized));
  await setSetting("updatedAt", nowIso());
  return normalized;
}

async function readAvailability() {
  await ensureSeeded();
  try {
    const availability = JSON.parse((await getSetting("availabilityJson")) || "[]");
    return normalizeAvailability(availability);
  } catch {
    return defaultAvailability;
  }
}

async function writeAvailability(availability) {
  const normalized = normalizeAvailability(availability);
  await setSetting("availabilityJson", JSON.stringify(normalized));
  await setSetting("updatedAt", nowIso());
  return normalized;
}

function bookingConflict(items, nextItem) {
  if (nextItem.kind !== "booking") return false;
  return items.some((item) => {
    if (item.id === nextItem.id || item.kind !== "booking") return false;
    if (item.week !== nextItem.week || item.day !== nextItem.day) return false;
    return nextItem.start < item.start + item.duration && item.start < nextItem.start + nextItem.duration;
  });
}

function slotIsBlocked(items, nextItem) {
  return items.some((item) => {
    if (item.kind !== "block") return false;
    if (item.week !== nextItem.week || item.day !== nextItem.day) return false;
    return nextItem.start < item.start + item.duration && item.start < nextItem.start + nextItem.duration;
  });
}

function isWithinAvailability(availability, item) {
  const windows = availability[item.day] || [];
  if (!windows.length) return false;
  return windows.some((window) => item.start >= window.start && item.start + item.duration <= window.end);
}

function validatePublicBooking(item, services, availability, items) {
  if (item.kind !== "booking") throw Object.assign(new Error("Invalid booking type."), { status: 400 });
  const service = findService(services, item.serviceId);
  if (!service || service.active === false || service.visibility === "private") {
    throw Object.assign(new Error("This service is not available for public booking."), { status: 400 });
  }
  item.duration = service.duration;
  if (!isWithinAvailability(availability, item)) {
    throw Object.assign(new Error("That time is outside the available booking hours."), { status: 409 });
  }
  if (slotIsBlocked(items, item)) throw Object.assign(new Error("That time is blocked out."), { status: 409 });
  if (bookingConflict(items, item)) throw Object.assign(new Error("That time has already been booked."), { status: 409 });
  if (!item.client || !item.email) throw Object.assign(new Error("Name and email are required."), { status: 400 });
}

function bookingCapacityCount(items, nextItem, service) {
  if (service?.lessonFormat !== "group") return bookingConflict(items, nextItem) ? service.capacity || 1 : 0;
  return items.filter((item) => {
    if (item.kind !== "booking") return false;
    if (item.serviceId !== service.id) return false;
    return item.week === nextItem.week && item.day === nextItem.day && item.start === nextItem.start;
  }).length;
}

function validateBookingCapacity(item, services, items) {
  const service = findService(services, item.serviceId);
  const count = bookingCapacityCount(items, item, service);
  const capacity = Math.max(1, service?.capacity || 1);
  if (service?.lessonFormat === "group") {
    if (count >= capacity) throw Object.assign(new Error("That class is full."), { status: 409 });
    return;
  }
  if (count >= capacity) throw Object.assign(new Error("That time has already been booked."), { status: 409 });
}

async function createPublicBooking(rawItem, mode = "public") {
  await ensureSeeded();
  const items = await readItems();
  const services = await readServices();
  const availability = await readAvailability();
  const item = normalizeItem({ ...rawItem, id: randomUUID(), kind: "booking" });
  validatePublicBooking(item, services, availability, items);
  validateBookingCapacity(item, services, items);
  const cleanItems = [...items, item];
  await writeItems(cleanItems);
  await updatePerson(personFromAppointment(item));
  const publicBooking = publicItem(item, services);
  if (mode === "public") await notifyBooking(publicBooking);
  return { item, publicBooking };
}

async function updatePublicBooking(rawItem) {
  await ensureSeeded();
  const items = await readItems();
  const services = await readServices();
  const availability = await readAvailability();
  const item = normalizeItem({ ...rawItem, kind: "booking" });
  const existing = items.find((entry) => entry.id === item.id && entry.kind === "booking");
  if (!existing) throw Object.assign(new Error("Booking not found."), { status: 404 });
  const service = findService(services, item.serviceId);
  item.duration = service.duration;
  const others = items.filter((entry) => entry.id !== item.id);
  validatePublicBooking(item, services, availability, others);
  validateBookingCapacity(item, services, others);
  const nextItems = items.map((entry) => (entry.id === item.id ? item : entry));
  await writeItems(nextItems);
  await updatePerson(personFromAppointment(item));
  const publicBooking = publicItem(item, services);
  await notifyBooking(publicBooking, "booking_updated");
  return { item, publicBooking };
}

async function cancelPublicBooking(lookup) {
  await ensureSeeded();
  const items = await readItems();
  const services = await readServices();
  const existing = items.find((item) => bookingMatchesLookup(item, lookup));
  if (!existing) throw Object.assign(new Error("Booking not found."), { status: 404 });
  await writeItems(items.filter((item) => item.id !== existing.id));
  const publicBooking = publicItem(existing, services);
  await queueNotification({
    kind: "booking_cancelled",
    recipient: publicBooking.email,
    subject: `Booking cancelled: ${publicBooking.serviceName}`,
    html: renderEmailLayout({
      title: "Booking cancelled",
      intro: `Your booking for ${escapeHtml(publicBooking.serviceName)} has been cancelled.`,
      rows: [
        ["Date", publicBooking.date],
        ["Time", publicBooking.timeRange],
        ["Client", publicBooking.client],
      ],
      footer: "Contact us if you need to make another booking.",
    }),
    text: `Your booking for ${publicBooking.serviceName} on ${publicBooking.date} at ${publicBooking.timeRange} has been cancelled.`,
    meta: { calendarItemId: existing.id, recipient: publicBooking.email, client: publicBooking.client, kind: "booking_cancelled" },
  });
  return { ok: true, item: existing };
}

function currentWeekIndex() {
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((todayUtc - baseWeekStart.getTime()) / (7 * 86_400_000));
}

function publicBookingStatePayload(settings, services, availability, items, brand) {
  return {
    coachName: settings.coachName || defaultCoachAccount().businessName,
    account: settings.account || defaultCoachAccount(),
    services: services
      .filter((service) => service.active && service.visibility !== "private")
      .map((service) => ({
        id: service.id,
        name: service.name,
        duration: service.duration,
        price: service.price,
        description: service.description,
        capacity: service.capacity,
        minParticipants: service.minParticipants,
        lessonFormat: service.lessonFormat,
        priceMode: service.priceMode,
        location: service.location,
        priceLabel: servicePriceLabel(service),
      })),
    availability,
    booked: items.filter((item) => item.kind === "booking").map((item) => publicItem(item, services)),
    blocked: items.filter((item) => item.kind === "block"),
    currentWeek: currentWeekIndex(),
    brand,
  };
}

async function readPublicBookingState() {
  const [account, services, availability, items, brand] = await Promise.all([
    readCoachAccount(),
    readServices(),
    readAvailability(),
    readItems(),
    readBrandSettings(),
  ]);
  return publicBookingStatePayload({ coachName: account.businessName, account }, services, availability, items, brand);
}

async function readBookingState() {
  const [account, adminSettings, services, availability, items, brand] = await Promise.all([
    readCoachAccount(),
    readAdminSettings(),
    readServices(),
    readAvailability(),
    readItems(),
    readBrandSettings(),
  ]);
  return {
    coachName: account.businessName,
    account,
    adminSettings,
    services,
    availability,
    items,
    people: await readPeople(),
    notificationHistory: await readNotificationHistory(),
    brand,
  };
}

async function queueNotification(payload) {
  await ensureSeeded();
  const record = {
    id: randomUUID(),
    payload,
    status: "queued",
    attempts: 0,
    createdAt: nowIso(),
  };
  return record;
}

async function flushNotificationQueue() {
  return { delivered: 0, queued: 0, failed: 0 };
}

function renderEmailLayout({ title, intro, rows = [], footer = "" }) {
  const renderedRows = rows
    .filter(([label, value]) => value !== undefined && value !== null && value !== "")
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:8px 0;color:#6b7280;font-size:13px;">${escapeHtml(label)}</td>
          <td style="padding:8px 0;color:#111827;font-size:14px;font-weight:600;text-align:right;">${escapeHtml(value)}</td>
        </tr>`,
    )
    .join("");
  return `
    <div style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;">
      <div style="max-width:560px;margin:0 auto;padding:28px 16px;">
        <div style="background:#ffffff;border-radius:22px;padding:28px;border:1px solid #e5e7eb;box-shadow:0 20px 55px rgba(15,23,42,0.08);">
          <div style="font-size:12px;font-weight:800;letter-spacing:0.16em;text-transform:uppercase;color:#16a34a;">Clarity Golf Booking</div>
          <h1 style="margin:10px 0 12px;font-size:26px;line-height:1.15;">${escapeHtml(title)}</h1>
          <p style="font-size:15px;line-height:1.6;color:#374151;margin:0 0 20px;">${escapeHtml(intro)}</p>
          <table style="width:100%;border-collapse:collapse;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;margin:18px 0;">
            ${renderedRows}
          </table>
          ${footer ? `<p style="font-size:13px;line-height:1.6;color:#6b7280;margin:18px 0 0;">${escapeHtml(footer)}</p>` : ""}
        </div>
      </div>
    </div>`;
}

async function sendWebhookEmail({ to, subject, html, text: textBody, meta = {} }) {
  const webhook = await getSetting("emailWebhookUrl");
  if (!webhook) {
    await insertNotificationHistory({ ...meta, recipient: to, subject, kind: meta.kind || "email", status: "queued", provider: "not_configured" });
    return { ok: true, skipped: true };
  }
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to, subject, html, text: textBody, meta }),
  });
  const body = await response.text().catch(() => "");
  await insertNotificationHistory({
    ...meta,
    recipient: to,
    subject,
    kind: meta.kind || "email",
    status: response.ok ? "sent" : "failed",
    provider: "webhook",
    providerId: response.headers.get("x-message-id") || "",
    error: response.ok ? "" : body.slice(0, 500),
  });
  if (!response.ok) throw new Error(body || "Email webhook failed.");
  return { ok: true };
}

async function notifyBooking(publicBooking, kind = "booking_created") {
  const settings = await readAdminSettings();
  const variables = {
    client: publicBooking.client,
    firstName: publicBooking.client.split(" ")[0],
    service: publicBooking.serviceName,
    coach: (await readCoachAccount()).businessName,
    date: publicBooking.date,
    time: publicBooking.timeRange,
    price: publicBooking.servicePrice,
  };
  const clientSubject = renderTemplate(settings.clientEmailSubject, variables);
  const clientIntro = renderTemplate(settings.clientEmailIntro, variables);
  const adminSubject = renderTemplate(settings.adminEmailSubject, variables);
  const adminIntro = renderTemplate(settings.adminEmailIntro, variables);

  if (settings.sendClientEmail && publicBooking.email) {
    await sendWebhookEmail({
      to: publicBooking.email,
      subject: clientSubject,
      html: renderEmailLayout({
        title: clientSubject,
        intro: clientIntro,
        rows: [
          ["Service", publicBooking.serviceName],
          ["Date", publicBooking.date],
          ["Time", publicBooking.timeRange],
          ["Price", publicBooking.servicePrice],
          ["Venue", (await readCoachAccount()).venueName],
        ],
        footer: settings.clientEmailFooter,
      }),
      text: `${clientIntro}\n${publicBooking.serviceName}\n${publicBooking.date} ${publicBooking.timeRange}`,
      meta: { calendarItemId: publicBooking.id, recipient: publicBooking.email, client: publicBooking.client, kind },
    });
  }

  if (settings.sendAdminEmail && settings.notificationEmail) {
    await sendWebhookEmail({
      to: settings.notificationEmail,
      subject: adminSubject,
      html: renderEmailLayout({
        title: adminSubject,
        intro: adminIntro,
        rows: [
          ["Client", publicBooking.client],
          ["Service", publicBooking.serviceName],
          ["Date", publicBooking.date],
          ["Time", publicBooking.timeRange],
          ["Email", publicBooking.email],
          ["Phone", publicBooking.phone],
          ["Price", publicBooking.servicePrice],
        ],
      }),
      text: `${adminIntro}\n${publicBooking.client}\n${publicBooking.date} ${publicBooking.timeRange}`,
      meta: { calendarItemId: publicBooking.id, recipient: settings.notificationEmail, client: publicBooking.client, kind: `${kind}_admin` },
    });
  }
  return { ok: true };
}

function validateAdminUser(email, password) {
  const clean = cleanEmail(email);
  if (!password || password.length < 8) throw Object.assign(new Error("Enter your admin password."), { status: 400 });
  return { email: clean, password };
}

async function loginAdmin(body, req) {
  await ensureSeeded();
  const { email, password } = validateAdminUser(body?.email, body?.password);
  const users = await db().sql`SELECT * FROM admin_users WHERE LOWER(email) = LOWER(${email}) LIMIT 1`;
  const user = users[0];
  if (!user) throw Object.assign(new Error("Invalid admin login."), { status: 401 });
  const { passwordHash } = hashPassword(password, user.password_salt);
  const ok = timingSafeEqual(Buffer.from(passwordHash, "hex"), Buffer.from(user.password_hash, "hex"));
  if (!ok) throw Object.assign(new Error("Invalid admin login."), { status: 401 });
  const token = randomBytes(32).toString("hex");
  await db().sql`
    INSERT INTO admin_sessions (id, token_hash, user_id, expires_at, created_at)
    VALUES (${randomUUID()}, ${hashToken(token)}, ${user.id}, ${new Date(Date.now() + sessionDays * 86_400_000).toISOString()}, NOW())
  `;
  return json({ ok: true, user: { id: user.id, email: user.email } }, 200, {
    "Set-Cookie": cookieHeader(token, req, sessionDays * 86_400),
  });
}

async function logoutAdmin(req) {
  const token = sessionTokenFromRequest(req);
  if (token) {
    await ensureSeeded();
    await db().sql`DELETE FROM admin_sessions WHERE token_hash = ${hashToken(token)}`;
  }
  return json({ ok: true }, 200, { "Set-Cookie": clearCookieHeader() });
}

async function requireAdmin(req) {
  await ensureSeeded();
  const token = sessionTokenFromRequest(req);
  if (!token) throw Object.assign(new Error("Admin login required."), { status: 401 });
  const rows = await db().sql`
    SELECT admin_users.id, admin_users.email
    FROM admin_sessions
    JOIN admin_users ON admin_users.id = admin_sessions.user_id
    WHERE admin_sessions.token_hash = ${hashToken(token)}
      AND admin_sessions.expires_at > ${new Date().toISOString()}
    LIMIT 1
  `;
  const user = rows[0];
  if (!user) throw Object.assign(new Error("Admin session expired. Please log in again."), { status: 401 });
  return { id: user.id, email: user.email };
}

async function sessionPayload(req) {
  try {
    const user = await requireAdmin(req);
    return { ok: true, admin: true, user };
  } catch {
    return { ok: true, admin: false, user: null };
  }
}

async function requestPasswordReset(body) {
  await ensureSeeded();
  const email = cleanEmail(body?.email);
  const users = await db().sql`SELECT * FROM admin_users WHERE LOWER(email) = LOWER(${email}) LIMIT 1`;
  const user = users[0];
  if (!user) return { ok: true };
  const token = randomBytes(32).toString("hex");
  await db().sql`
    INSERT INTO admin_password_resets (id, token_hash, user_id, expires_at, created_at)
    VALUES (${randomUUID()}, ${hashToken(token)}, ${user.id}, ${new Date(Date.now() + passwordResetMinutes * 60_000).toISOString()}, NOW())
  `;
  return { ok: true, resetToken: token };
}

async function resetPassword(body) {
  await ensureSeeded();
  const token = cleanString(body?.token, "", 200);
  const password = String(body?.password || "");
  if (!token) throw Object.assign(new Error("Reset token required."), { status: 400 });
  if (password.length < 8) throw Object.assign(new Error("Password must be at least 8 characters."), { status: 400 });
  const rows = await db().sql`
    SELECT * FROM admin_password_resets
    WHERE token_hash = ${hashToken(token)}
      AND used_at IS NULL
      AND expires_at > ${new Date().toISOString()}
    LIMIT 1
  `;
  const reset = rows[0];
  if (!reset) throw Object.assign(new Error("Reset link is invalid or expired."), { status: 400 });
  const { passwordHash, salt } = hashPassword(password);
  await db().sql`UPDATE admin_users SET password_hash = ${passwordHash}, password_salt = ${salt}, updated_at = NOW() WHERE id = ${reset.user_id}`;
  await db().sql`UPDATE admin_password_resets SET used_at = NOW() WHERE id = ${reset.id}`;
  await db().sql`DELETE FROM admin_sessions WHERE user_id = ${reset.user_id}`;
  return { ok: true };
}

function icsEscape(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function icsDate(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function calendarFeed(items, services) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Clarity Golf Booking//Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  for (const item of items) {
    if (item.kind === "block") continue;
    const service = findService(services, item.serviceId);
    const start = minutesToDateForWeek(item.week || 0, item.day || 0, item.start || 0);
    const end = new Date(start.getTime() + item.duration * 60_000);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${icsEscape(item.id)}@claritygolf.app`,
      `DTSTAMP:${icsDate(new Date())}`,
      `DTSTART:${icsDate(start)}`,
      `DTEND:${icsDate(end)}`,
      `SUMMARY:${icsEscape(`${item.client || item.title} - ${service?.name || item.serviceId}`)}`,
      `DESCRIPTION:${icsEscape([item.note, item.phone, item.email].filter(Boolean).join("\n"))}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

function parsePath(req, prefix = "") {
  const url = new URL(req.url);
  let path = url.pathname;
  if (prefix && path.startsWith(prefix)) path = path.slice(prefix.length) || "/";
  return { url, path };
}

export async function handleBookingApiRoute(req, prefix = "", context = {}) {
  const { url, path } = parsePath(req, prefix);
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
    if (req.method === "GET" && path === "/auth/session") return json(await sessionPayload(req));
    if (req.method === "POST" && path === "/auth/login") return loginAdmin(await req.json().catch(() => ({})), req);
    if (req.method === "POST" && path === "/auth/logout") return logoutAdmin(req);
    if (req.method === "POST" && path === "/auth/request-reset") return json(await requestPasswordReset(await req.json().catch(() => ({}))));
    if (req.method === "POST" && path === "/auth/reset") return json(await resetPassword(await req.json().catch(() => ({})));

    if (req.method === "GET" && path === "/calendar-feed.ics") {
      const items = await readItems();
      const services = await readServices();
      return text(calendarFeed(items, services), 200, "text/calendar; charset=utf-8");
    }

    if (req.method === "GET" && path === "/public-booking-state") return json(await readPublicBookingState());
    if (req.method === "POST" && path === "/public-booking") return json(await createPublicBooking(await req.json().catch(() => ({})), "public"));
    if (req.method === "POST" && (path === "/public-reschedule" || path === "/public-reschedule/lookup" || path === "/public-reschedule-lookup")) {
      return json(await requestCalendarReschedule(await req.json().catch(() => ({}))));
    }

    await requireAdmin(req);

    if (req.method === "GET" && path === "/booking-state") return json(await readBookingState());
    if (req.method === "POST" && path === "/booking-state") {
      const body = await req.json().catch(() => ({}));
      const services = await readServices();
      const items = normalizeItems(body.items);
      for (const item of items) {
        if (item.kind === "booking") {
          const service = findService(services, item.serviceId);
          item.duration = service?.duration || item.duration;
        }
      }
      const saved = await writeItems(items);
      await Promise.all(saved.filter((item) => item.kind === "booking").map((item) => updatePerson(personFromAppointment(item))));
      return json({ items: saved, people: await readPeople(), notificationHistory: await readNotificationHistory() });
    }
    if (req.method === "GET" && path === "/people") return json({ people: await readPeople() });
    if (req.method === "POST" && path === "/people/import") {
      const body = await req.json().catch(() => ({}));
      return json(await importPeople(body.people || body.clients || [], body.source || "import", body.options || {}));
    }
    if (req.method === "POST" && path === "/people") {
      const body = await req.json().catch(() => ({}));
      return json(await updatePerson(body.person || body));
    }
    if (req.method === "POST" && path === "/people/migrate") {
      await seedPeopleFromAppointments();
      return json({ people: await readPeople() });
    }
    if (req.method === "GET" && path === "/admin-settings") return json(await readAdminSettings());
    if (req.method === "POST" && path === "/admin-settings") return json(await writeAdminSettings(await req.json().catch(() => ({}))));
    if (req.method === "GET" && path === "/coach-account") return json(await readCoachAccount());
    if (req.method === "POST" && path === "/coach-account") return json(await writeCoachAccount(await req.json().catch(() => ({}))));
    if (req.method === "GET" && path === "/brand-settings") return json(await readBrandSettings());
    if (req.method === "POST" && path === "/brand-settings") return json(await writeBrandSettings(await req.json().catch(() => ({}))));
    if (req.method === "GET" && path === "/services") return json({ services: await readServices() });
    if (req.method === "POST" && path === "/services") return json({ services: await writeServices((await req.json().catch(() => ({}))).services) });
    if (req.method === "GET" && path === "/availability") return json({ availability: await readAvailability() });
    if (req.method === "POST" && path === "/availability") return json({ availability: await writeAvailability((await req.json().catch(() => ({}))).availability) });
    if (req.method === "POST" && path === "/flush-notifications") return json(await flushNotificationQueue());
    if (req.method === "GET" && path === "/notification-history") return json({ notificationHistory: await readNotificationHistory() });

    return json({ error: "Not found" }, 404);
  } catch (error) {
    const status = Number(error?.status || 500);
    return json({ error: error?.message || "Request failed" }, status);
  }
}
