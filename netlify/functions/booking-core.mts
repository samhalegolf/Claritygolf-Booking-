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
  await db().sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_people_email_unique
    ON people (LOWER(email))
    WHERE email IS NOT NULL AND email <> ''
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
  const countRows = await db().sql`SELECT COUNT(*) AS count FROM calendar_items`;
  if ((countRows[0]?.count ?? 0) > 0) return;

  const client = await db().pool.connect();
  try {
    await client.query("BEGIN");
    for (const item of initialItems) {
      await client.query(
        `INSERT INTO calendar_items (
          id, kind, week, day, start, duration, service_id, client, title, phone, email, note, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
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
    console.warn("Admin user not seeded because CLARITY_ADMIN_EMAIL or CLARITY_ADMIN_PASSWORD is not set.");
    return;
  }

  const existing = await db().sql`SELECT id FROM admin_users WHERE email = ${email}`;

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
  const cleanName = cleanString(name, "", 180).toLowerCase().replace(/\s+/g, " ").trim();
  return cleanName ? `name:${cleanName}` : "";
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

async function recordNotification({ personKey = "", calendarItemId = "", recipient = "", subject = "", kind = "", status = "", provider = "", providerId = "", error = "" }) {
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
  const people = Array.isArray(rawPeople) ? rawPeople.map((person) => cleanPerson(person, source)).filter(Boolean) : [];
  const result = {
    imported: 0,
    updated: 0,
    skipped: Array.isArray(rawPeople) ? rawPeople.length - people.length : 0,
    people: [],
  };
  if (!Array.isArray(rawPeople)) return result;

  const client = await db().pool.connect();
  try {
    await client.query("BEGIN");
    for (const person of people) {
      let existingId = "";
      if (person.id) {
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
        result.updated += 1;
      } else {
        await client.query(
          `INSERT INTO people (
             id, name, email, phone, notes, source, caddy_profile_id, caddy_profile_url, created_at, updated_at
           ) VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''), $6, NULLIF($7, ''), NULLIF($8, ''), NOW(), NOW())`,
          [
            person.id || randomUUID(),
            person.name,
            person.email,
            person.phone,
            person.notes,
            person.source || source,
            person.caddyProfileId,
            person.caddyProfileUrl,
          ],
        );
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
  const delaySeconds = Number(settings?.notificationDelaySeconds ?? 30);
  await setSetting("notificationEmail", cleanString(settings?.notificationEmail, "", 180));
  await setSetting("replyToEmail", cleanString(settings?.replyToEmail, "", 180));
  await setSetting("notificationDelaySeconds", String(Number.isFinite(delaySeconds) ? Math.max(30, Math.min(3600, delaySeconds)) : 30));
  await setSetting("sendClientEmail", settings?.sendClientEmail ? "true" : "false");
  await setSetting("sendAdminEmail", settings?.sendAdminEmail ? "true" : "false");
  await setSetting("clientEmailSubject", cleanString(settings?.clientEmailSubject, defaultEmailTemplates.clientEmailSubject, 180));
  await setSetting("clientEmailIntro", cleanString(settings?.clientEmailIntro, defaultEmailTemplates.clientEmailIntro, 900));
  await setSetting("clientEmailFooter", cleanString(settings?.clientEmailFooter, defaultEmailTemplates.clientEmailFooter, 900));
  await setSetting("adminEmailSubject", cleanString(settings?.adminEmailSubject, defaultEmailTemplates.adminEmailSubject, 180));
  await setSetting("adminEmailIntro", cleanString(settings?.adminEmailIntro, defaultEmailTemplates.adminEmailIntro, 900));
  await setSetting("smsProviderName", cleanString(settings?.smsProviderName, "", 80));
  await setSetting("smsWebhookUrl", cleanString(settings?.smsWebhookUrl, "", 600));
  await setSetting("smsFromNumber", cleanString(settings?.smsFromNumber, "", 80));
  await setSetting("sendClientSms", settings?.sendClientSms ? "true" : "false");
  await setSetting("sendAdminSms", settings?.sendAdminSms ? "true" : "false");
  await setSetting("updatedAt", nowIso());
  return readAdminSettings();
}

async function readServices() {
  await ensureSeeded();
  try {
    return normalizeServices(JSON.parse((await getSetting("servicesJson")) || "[]"));
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
    return normalizeAvailability(JSON.parse((await getSetting("availabilityJson")) || "[]"));
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
    businessName: (await getSetting("accountBusinessName")) || (await getSetting("coachName")) || defaults.businessName,
    venueName: (await getSetting("accountVenueName")) || defaults.venueName,
    venueShortName: (await getSetting("accountVenueShortName")) || defaults.venueShortName,
    timezone: (await getSetting("accountTimezone")) || defaults.timezone,
    contactEmail: (await getSetting("accountContactEmail")) || defaults.contactEmail,
    bookingUrl: (await getSetting("accountBookingUrl")) || defaults.bookingUrl,
    calendarSlug: (await getSetting("accountCalendarSlug")) || defaults.calendarSlug,
    caddyWorkspaceUrl: (await getSetting("accountCaddyWorkspaceUrl")) || defaults.caddyWorkspaceUrl,
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
    neutral: (await getSetting("brandNeutral")) || "#ffffff",
    primary: (await getSetting("brandPrimary")) || "#1fd36d",
    secondary: (await getSetting("brandSecondary")) || "#d7b06b",
    accent: (await getSetting("brandAccent")) || "#07100a",
    bookingTheme: (await getSetting("brandBookingTheme")) === "light" ? "light" : "dark",
  };
}

async function writeBrandSettings(settings) {
  const account = await readCoachAccount();
  await setSetting("coachName", cleanString(settings?.coachName, account.businessName, 80));
  await setSetting("brandLogoName", cleanString(settings?.logoName, "", 120));
  await setSetting("brandLogoPreview", cleanLogoPreview(settings?.logoPreview));
  await setSetting("brandNeutral", cleanHexColor(settings?.neutral, "#ffffff"));
  await setSetting("brandPrimary", cleanHexColor(settings?.primary, "#1fd36d"));
  await setSetting("brandSecondary", cleanHexColor(settings?.secondary, "#d7b06b"));
  await setSetting("brandAccent", cleanHexColor(settings?.accent, "#07100a"));
  await setSetting("brandBookingTheme", settings?.bookingTheme === "light" ? "light" : "dark");
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
        summary: Array.isArray(value) ? `${value.length} records` : typeof value,
      };
    } catch (error) {
      diagnostics[key] = {
        ok: false,
        message: error instanceof Error ? error.message : "Unknown diagnostics error",
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
        message: error instanceof Error ? error.message : "Unknown serialization error",
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
      message: error instanceof Error ? error.message : "Unknown calendar feed error",
    };
  }

  return diagnostics;
}

export async function handleCalendarFeedRequest(req: Request) {
  try {
    const state = await readPublicCalendarState();
    const key = new URL(req.url).searchParams.get("key");
    if (key !== state.syncKey) return text("Invalid calendar sync key.", 401);
    return text(generateCalendarFeed(state), 200, "text/calendar; charset=utf-8");
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
  const syncKey = cleanString(nextState?.syncKey, current.syncKey, 140);
  const items = await writeItems(nextState?.items ?? current.items);
  const updatedAt = nowIso();
  await setSetting("syncKey", syncKey);
  await setSetting("updatedAt", updatedAt);
  await importPeople(items.map(personFromAppointment).filter(Boolean), "appointment");
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
  };
}

async function writePublicBookingState(currentState, items) {
  const cleanItems = await writeItems(items);
  const updatedAt = nowIso();
  await setSetting("updatedAt", updatedAt);
  await importPeople(cleanItems.map(personFromAppointment).filter(Boolean), "appointment");
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
  };
}

function publicBookingState(state) {
  return {
    updatedAt: state.updatedAt,
    services: (state.services || []).filter((service) => service.active && service.visibility === "public"),
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
  return [itemWeek(item), item.day, item.start, item.duration, item.serviceId || ""].join(":");
}

function appointmentContactSignature(item) {
  return [item.client || item.title || "", item.email || "", item.phone || ""].join(":").toLowerCase();
}

function notificationJobsForCalendarChange(previousItems = [], nextItems = []) {
  const previousById = new Map(
    previousItems.filter((item) => item.kind === "appointment").map((item) => [item.id, item]),
  );
  return nextItems
    .filter((item) => item.kind === "appointment" && item.email)
    .map((item) => {
      const previous = previousById.get(item.id);
      if (!previous) return { appointment: item, kind: "booking" };
      if (appointmentSlotSignature(previous) !== appointmentSlotSignature(item)) {
        return { appointment: item, kind: "reschedule" };
      }
      if (!previous.email && item.email) return { appointment: item, kind: "booking" };
      if (appointmentContactSignature(previous) !== appointmentContactSignature(item)) return null;
      return null;
    })
    .filter(Boolean);
}

async function sendCalendarChangeNotifications(previousItems = [], nextItems = []) {
  const results = [];
  for (const { appointment, kind } of notificationJobsForCalendarChange(previousItems, nextItems)) {
    try {
      results.push(...(await sendBookingNotifications(appointment, { kind })));
    } catch (error) {
      console.error("Calendar change notification failed", appointment?.id, kind, error);
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
  if (saved.length !== attempt.length || !timingSafeEqual(saved, attempt)) return null;

  return { id: row.id, email: row.email };
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
  const expiresAt = new Date(Date.now() + passwordResetMinutes * 60 * 1000).toISOString();
  await db().sql`
    INSERT INTO admin_password_resets (id, token_hash, user_id, expires_at, created_at)
    VALUES (${randomUUID()}, ${hashToken(token)}, ${user.id}, ${expiresAt}, NOW())
  `;
  return { token, expiresAt, email: user.email };
}

function passwordResetUrl(req, token) {
  const origin = env("CLARITY_APP_URL", new URL(req.url).origin).replace(/\/$/, "");
  const url = new URL(origin || new URL(req.url).origin);
  url.searchParams.set("reset", token);
  return url.toString();
}

async function sendEmail({ to, subject, html, text, replyTo, idempotencyKey }) {
  const apiKey = env("RESEND_API_KEY");
  if (!apiKey) return { sent: false, reason: "missing_resend_key" };

  const account = await readCoachAccount();
  const businessName = account.businessName || "Clarity Golf";
  const from = env("CLARITY_EMAIL_FROM", `${businessName} <onboarding@resend.dev>`);
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
    console.error("Resend email failed", response.status, message.slice(0, 500));
    return { sent: false, reason: "resend_failed", error: message.slice(0, 500) };
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

function bookingEmailVariables({ appointment, service, account }) {
  const client = appointment.client || appointment.title || "Client";
  const rescheduleUrl = new URL(account.bookingUrl || "https://book.claritygolf.app");
  rescheduleUrl.searchParams.set("embed", "booking");
  rescheduleUrl.searchParams.set("mode", "reschedule");
  if (appointment.id) rescheduleUrl.searchParams.set("booking", appointment.id);
  if (appointment.email) rescheduleUrl.searchParams.set("email", appointment.email);
  if (appointment.phone) rescheduleUrl.searchParams.set("phone", appointment.phone);
  return {
    client,
    firstName: client.split(/\s+/)[0] || client,
    coach: account.coachName || account.businessName,
    service: service?.name || "Golf Lesson",
    date: formatBookingDate(itemWeek(appointment), appointment.day),
    time: formatRange(appointment.start, appointment.duration),
    venue: account.venueName,
    price: servicePriceLabel(service),
    duration: `${appointment.duration} minutes`,
    replyTo: account.contactEmail,
    rescheduleUrl: rescheduleUrl.toString(),
  };
}

function bookingEmailHtml({ title, intro, footer, variables }) {
  const manageButton = variables.rescheduleUrl
    ? `<p style="margin:22px 0"><a href="${escapeHtml(variables.rescheduleUrl)}" style="display:inline-block;background:#07100a;color:#ffffff;padding:12px 18px;text-decoration:none;border-radius:6px;font-weight:700">Manage / Reschedule</a></p>`
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
      <p>${escapeHtml(footer).replace(/\n/g, "<br/>")}</p>
      ${manageButton}
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
    footer,
    variables.rescheduleUrl ? `Manage / Reschedule: ${variables.rescheduleUrl}` : "",
  ].join("\n");
}

async function sendBookingNotifications(appointment, { kind = "booking", testRecipient = "" } = {}) {
  const settings = await readAdminSettings();
  const account = await readCoachAccount();
  const services = await readServices();
  const service = services.find((candidate) => candidate.id === appointment.serviceId);
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
      console.log("Booking email sent", channel, recipient, result.id || "no-provider-id");
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
      console.error("Notification skipped history write failed", channel, error);
    }
    return { channel, recipient, subject, kind: notificationKind, status: "skipped", sent: false, reason };
  }

  if ((settings.sendClientEmail || kind === "test") && (testRecipient || appointment.email)) {
    const subject = renderTemplate(settings.clientEmailSubject, variables);
    const intro = renderTemplate(settings.clientEmailIntro, variables);
    const footerBase = renderTemplate(settings.clientEmailFooter, variables);
    const recipient = testRecipient || appointment.email;
    jobs.push(
      sendAndRecord(
        "client",
        recipient,
        subject,
        bookingEmailHtml({ title: subject, intro, footer: footerBase, variables }),
        bookingEmailText({
          title: subject,
          intro,
          footer: footerBase,
          variables: testRecipient ? { ...variables, rescheduleUrl: "" } : variables,
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
        settings.sendClientEmail ? "missing_client_email" : "disabled_in_notification_settings",
      ),
    );
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
        bookingEmailHtml({ title: subject, intro, footer: "Admin booking alert.", variables }),
        bookingEmailText({ title: subject, intro, footer: "Admin booking alert.", variables }),
        `${kind}-admin-${appointment.id}-${hashToken(recipient).slice(0, 12)}`,
      ),
    );
  } else if (kind !== "test") {
    const recipient = settings.notificationEmail || account.contactEmail;
    const subject = renderTemplate(settings.adminEmailSubject, variables);
    jobs.push(recordSkipped("admin", recipient, subject, "disabled_in_notification_settings"));
  }

  if (!jobs.length) return [];
  return Promise.all(jobs);
}

async function resetAdminPassword(token, password) {
  const cleanToken = cleanString(token, "", 500);
  if (!cleanToken) return { error: "invalid_token" };
  if (typeof password !== "string" || password.length < 8) return { error: "weak_password" };

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
    await client.query("UPDATE admin_password_resets SET used_at = NOW() WHERE id = $1", [row.reset_id]);
    await client.query("DELETE FROM admin_sessions WHERE user_id = $1", [row.user_id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return { user: { id: row.user_id, email: row.email } };
}

async function createAdminSession(userId) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000).toISOString();
  await db().sql`
    INSERT INTO admin_sessions (id, token_hash, user_id, expires_at, created_at)
    VALUES (${randomUUID()}, ${hashToken(token)}, ${userId}, ${expiresAt}, NOW())
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
  await db().sql`DELETE FROM admin_sessions WHERE token_hash = ${hashToken(token)}`;
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

async function createPublicBooking(payload, context = null) {
  const state = await readPublicCalendarState();
  const service = state.services.find(
    (candidate) => candidate.id === payload?.serviceId && candidate.active && candidate.visibility === "public",
  );
  if (!service) throw Object.assign(new Error("Choose a public lesson type."), { status: 400 });

  const week = Number(payload.week ?? 0);
  const day = Number(payload.day);
  const start = Number(payload.start);
  const firstName = cleanString(payload.firstName, "", 80);
  const lastName = cleanString(payload.lastName, "", 80);
  const email = cleanString(payload.email, "", 180);
  const phone = cleanString(payload.phone, "", 80);

  if (!firstName || !lastName || !email) {
    throw Object.assign(new Error("First name, last name, and email are required."), { status: 400 });
  }
  if (!Number.isInteger(week) || !Number.isInteger(day) || !Number.isInteger(start) || day < 0 || day > 6) {
    throw Object.assign(new Error("Choose a valid appointment time."), { status: 400 });
  }

  const slot = { week, day, start, duration: service.duration };
  if (!isInsideAvailability(state.availability, day, start, service.duration) || hasCollision(state.items, slot)) {
    throw Object.assign(new Error("That time is no longer available."), { status: 409 });
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
  await writePublicBookingState(state, [...state.items, appointment]);
  queueBookingNotifications(appointment, { kind: "booking" }, context);
  return { appointment, notifications: [] };
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
      notifications: result.notifications,
    });
  } catch (error) {
    console.error("public_booking:failed", error);
    const status = error?.status || 500;
    return json(
      {
        error: status === 500 ? "public_booking_error" : "request_error",
        message: error instanceof Error ? error.message : "Unknown public booking error",
      },
      status,
    );
  }
}

export async function handlePublicNotificationStatusRequest(req) {
  try {
    const url = new URL(req.url);
    const appointmentId = cleanString(url.searchParams.get("appointment") || "", "", 120);
    const email = normalizeRescheduleContact(url.searchParams.get("email") || "");
    const phone = normalizeRescheduleContact(url.searchParams.get("phone") || "");
    if (!appointmentId || (!email && !phone)) return json({ sent: false }, 400);

    const state = await readPublicCalendarState();
    const appointment = state.items.find((item) => item.id === appointmentId);
    if (!appointment || !matchesRescheduleContact(appointment, email, phone)) {
      return json({ sent: false }, 404);
    }

    const history = await readNotificationHistory();
    const notification = history.find(
      (candidate) => candidate.calendarItemId === appointmentId && candidate.kind.includes("client_email"),
    );
    return json({
      sent: notification?.status === "sent",
      notification: notification ? notificationResultFromRecord(notification) : null,
    });
  } catch (error) {
    console.error("public_notification_status:failed", error);
    return json({ sent: false }, 500);
  }
}

function normalizeRescheduleContact(value) {
  return cleanString(value, "", 180).toLowerCase().replace(/[^a-z0-9]/g, "");
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
  return Boolean(itemEmail && itemPhone && itemEmail === email && itemPhone === phone);
}

function matchesNotificationContact(item, email, phone) {
  if (item.kind !== "appointment") return false;
  const itemEmail = normalizeRescheduleContact(item.email);
  const itemPhone = normalizeRescheduleContact(item.phone);
  if (!itemEmail || itemEmail !== email) return false;
  return !itemPhone || !phone || itemPhone === phone;
}

function notificationResultFromRecord(notification) {
  const channel = notification.kind.includes("admin") ? "admin" : "client";
  return {
    channel,
    recipient: notification.recipient,
    subject: notification.subject,
    kind: notification.kind,
    status: notification.status,
    sent: notification.status === "sent",
    id: notification.providerId,
    reason: notification.error,
  };
}

async function triggerPublicBookingNotifications(payload) {
  const appointmentId = cleanString(payload?.appointmentId || payload?.appointment || "", "", 120);
  const email = normalizeRescheduleContact(payload?.email);
  const phone = normalizeRescheduleContact(payload?.phone);
  const kind = payload?.kind === "reschedule" ? "reschedule" : "booking";

  if (!appointmentId || !email) {
    throw Object.assign(new Error("Booking email details are missing."), { status: 400 });
  }

  const state = await readPublicCalendarState();
  const appointment = state.items.find((item) => item.id === appointmentId);
  if (!appointment || !matchesNotificationContact(appointment, email, phone)) {
    throw Object.assign(new Error("That booking could not be verified for email notification."), { status: 404 });
  }

  const existing = (await readNotificationHistory()).filter(
    (notification) => notification.calendarItemId === appointmentId && notification.kind.startsWith(`${kind}_`),
  );
  const alreadySent = existing.some((notification) => notification.status === "sent");
  if (alreadySent) {
    return { ok: true, alreadySent: true, results: existing.map(notificationResultFromRecord) };
  }

  const results = await sendBookingNotifications(appointment, { kind });
  return {
    ok: results.some((result) => result.sent),
    alreadySent: false,
    results,
    notifications: await readNotificationHistory(),
  };
}

async function lookupPublicReschedule(payload) {
  const email = normalizeRescheduleContact(payload?.email);
  const phone = normalizeRescheduleContact(payload?.phone);
  if (!email || !phone) {
    throw Object.assign(new Error("Enter the email and phone number used on the booking."), { status: 400 });
  }

  const state = await readPublicCalendarState();
  const serviceList = state.services || defaultServices;
  const matches = state.items
    .filter((item) => matchesRescheduleContact(item, email, phone))
    .sort((a, b) => itemWeek(a) - itemWeek(b) || a.day - b.day || a.start - b.start)
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
    throw Object.assign(new Error("Choose the booking to reschedule."), { status: 400 });
  }
  if (!Number.isInteger(week) || !Number.isInteger(day) || !Number.isInteger(start) || day < 0 || day > 6) {
    throw Object.assign(new Error("Choose a valid new appointment time."), { status: 400 });
  }

  const state = await readPublicCalendarState();
  const appointment = state.items.find((item) => item.id === appointmentId);
  if (!appointment || !matchesRescheduleContact(appointment, email, phone)) {
    throw Object.assign(new Error("That booking could not be verified."), { status: 404 });
  }

  const serviceList = state.services || defaultServices;
  const service = serviceList.find((candidate) => candidate.id === appointment.serviceId);
  const duration = service?.duration || appointment.duration;
  const slot = { week, day, start, duration };
  const itemsWithoutOriginal = state.items.filter((item) => item.id !== appointment.id);
  if (
    !isInsideAvailability(state.availability || defaultAvailability, day, start, duration) ||
    hasCollision(itemsWithoutOriginal, slot)
  ) {
    throw Object.assign(new Error("That time is no longer available."), { status: 409 });
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
    state.items.map((item) => (item.id === appointment.id ? updatedAppointment : item)),
  );
  queueBookingNotifications(updatedAppointment, { kind: "reschedule" }, context);

  return { appointment: updatedAppointment, notifications: [] };
}

export async function handlePublicRescheduleLookupRequest(req) {
  try {
    return json(await lookupPublicReschedule(await parseBody(req)));
  } catch (error) {
    console.error("public_reschedule_lookup:failed", error);
    const status = error?.status || 500;
    return json(
      {
        error: status === 500 ? "public_reschedule_lookup_error" : "request_error",
        message: error instanceof Error ? error.message : "Unknown public reschedule lookup error",
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
      notifications: result.notifications,
    });
  } catch (error) {
    console.error("public_reschedule:failed", error);
    const status = error?.status || 500;
    return json(
      {
        error: status === 500 ? "public_reschedule_error" : "request_error",
        message: error instanceof Error ? error.message : "Unknown public reschedule error",
      },
      status,
    );
  }
}

function serviceName(serviceId, serviceList = defaultServices) {
  return serviceList.find((service) => service.id === serviceId)?.name ?? "Golf Lesson";
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

async function parseBody(req) {
  const raw = await req.text();
  return raw ? JSON.parse(raw) : {};
}

export async function handleBookingApiRoute(req: Request, forcedPathname = "", context = null) {
  const url = new URL(req.url);
  const rawPathname = url.pathname;
  const pathname = forcedPathname
    ? forcedPathname
    : rawPathname === "/.netlify/functions/booking-api"
      ? "/"
      : rawPathname;

  try {
    await ensureSeeded();

    if (req.method === "GET" && /^\/calendar\/[a-z0-9-]+\.ics$/.test(pathname)) {
      return handleCalendarFeedRequest(req);
    }

    if (req.method === "POST" && pathname === "/api/auth/login") {
      await cleanupExpiredSessions();
      const body = await parseBody(req);
      const user = await verifyAdminPassword(body.email || "", body.password || "");
      if (!user) return json({ error: "invalid_login", message: "Email or password is incorrect." }, 401);
      const session = await createAdminSession(user.id);
      return json(
        { authenticated: true, email: user.email, expiresAt: session.expiresAt },
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
          return json({ ok: false, message: "Could not send the reset email. Try again in a minute." }, 502);
        }
      }

      return json({
        ok: true,
        message: "If that email matches an admin account, a reset link has been sent.",
      });
    }

    if (req.method === "POST" && pathname === "/api/auth/reset-password") {
      await cleanupExpiredPasswordResets();
      const body = await parseBody(req);
      const result = await resetAdminPassword(body.token || "", body.password || "");
      if (result.error === "weak_password") {
        return json({ error: "weak_password", message: "Use at least 8 characters." }, 400);
      }
      if (!result.user) {
        return json({ error: "invalid_token", message: "This reset link has expired or has already been used." }, 400);
      }
      const session = await createAdminSession(result.user.id);
      return json(
        { authenticated: true, email: result.user.email, expiresAt: session.expiresAt },
        200,
        { "Set-Cookie": cookieHeader(session.token, req, 7 * 24 * 60 * 60) },
      );
    }

    if (req.method === "POST" && pathname === "/api/auth/logout") {
      await destroyAdminSession(sessionTokenFromRequest(req));
      return json({ authenticated: false }, 200, { "Set-Cookie": clearCookieHeader() });
    }

    if (req.method === "GET" && pathname === "/api/auth/session") {
      const session = await readAdminSession(sessionTokenFromRequest(req));
      return json(session ? { authenticated: true, email: session.email } : { authenticated: false });
    }

    if (req.method === "GET" && pathname === "/api/public-booking-state") {
      return handlePublicBookingStateRequest();
    }

    if (req.method === "POST" && pathname === "/api/public-booking-notifications") {
      return json(await triggerPublicBookingNotifications(await parseBody(req)));
    }

    if (req.method === "GET" && pathname === "/api/public-diagnostics") {
      return json(await runPublicDiagnostics());
    }

    if (req.method === "GET" && pathname === "/api/public-serialization-diagnostics") {
      return json(await runPublicSerializationDiagnostics());
    }

    if (pathname.startsWith("/api/")) {
      if (!(await requireAdmin(req))) return json({ error: "unauthorized", message: "Admin login required." }, 401);
    }

    if (req.method === "GET" && pathname === "/api/calendar-state") {
      return json(publicCalendarState(await readCalendarState()));
    }

    if (req.method === "PUT" && pathname === "/api/calendar-state") {
      const body = await parseBody(req);
      const current = await readCalendarState();
      const nextState = await writeCalendarState({
        syncKey: typeof body.syncKey === "string" ? body.syncKey : current.syncKey,
        items: Array.isArray(body.items) ? body.items : current.items,
      });
      const notificationResults = await sendCalendarChangeNotifications(current.items, nextState.items);
      return json({
        ...publicCalendarState({ ...nextState, notifications: await readNotificationHistory() }),
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
            syncKey: typeof body.syncKey === "string" && body.syncKey.startsWith("cg_") ? body.syncKey : generateSyncKey(),
          }),
        ),
      );
    }

    if (req.method === "GET" && pathname === "/api/admin-settings") {
      return json(await readAdminSettings());
    }

    if (req.method === "PUT" && pathname === "/api/admin-settings") {
      return json(await writeAdminSettings(await parseBody(req)));
    }

    if (req.method === "GET" && pathname === "/api/notification-history") {
      return json({ notifications: await readNotificationHistory() });
    }

    if (req.method === "POST" && pathname === "/api/test-email") {
      const body = await parseBody(req);
      const recipient = cleanEmail(body.email, "");
      if (!recipient) return json({ error: "missing_email", message: "Enter an email address to send the test to." }, 400);
      const services = await readServices();
      const service = services.find((candidate) => candidate.active) || defaultServices[0];
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
      const results = await sendBookingNotifications(appointment, { kind: "test", testRecipient: recipient });
      const sent = results.some((result) => result.sent);
      const missingResendKey = results.some((result) => result.reason === "missing_resend_key");
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
        message: error instanceof Error ? error.message : "Unknown booking API error",
      },
      status,
    );
  }
}
