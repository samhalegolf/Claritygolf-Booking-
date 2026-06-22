import type { Config } from "@netlify/functions";
import { createHash } from "node:crypto";
import pg from "pg";

const { Client } = pg;

const sessionCookieName = "clarity_session";

const defaultServices = [
  { id: "lesson-30", name: "30min Lesson", duration: 30, price: 100, description: "Price Includes Bay Hire", visibility: "public", active: true, capacity: 1, minParticipants: 1, lessonFormat: "private", priceMode: "session", location: "Bay hire included" },
  { id: "lesson-60", name: "1 Hour Golf Lesson", duration: 60, price: 180, description: "Price Includes Bay Hire", visibility: "public", active: true, capacity: 1, minParticipants: 1, lessonFormat: "private", priceMode: "session", location: "Bay hire included" },
  { id: "lesson-pair", name: "2 Person Golf Lesson", duration: 60, price: 200, description: "Two-player coaching session", visibility: "public", active: true, capacity: 2, minParticipants: 1, lessonFormat: "private", priceMode: "session", location: "Bay hire included" },
  { id: "group-clinic", name: "Group Golf Clinic", duration: 90, price: 55, description: "Small-group coaching session with shared practice goals", visibility: "public", active: true, capacity: 6, minParticipants: 3, lessonFormat: "group", priceMode: "per-person", location: "Group coaching bay" },
  { id: "member-30", name: "30min Golf Lesson (Range 24/7 Member)", duration: 30, price: 90, description: "Bay hire is deducted from membership account", visibility: "public", active: true, capacity: 1, minParticipants: 1, lessonFormat: "private", priceMode: "session", location: "Range 24/7 member bay" },
  { id: "member-60", name: "1 Hour Golf Lesson (Range 24/7 Member)", duration: 60, price: 160, description: "Bay hire is deducted from membership account", visibility: "public", active: true, capacity: 1, minParticipants: 1, lessonFormat: "private", priceMode: "session", location: "Range 24/7 member bay" },
  { id: "package-60", name: "1 hour Lesson - 5 Lesson Package", duration: 60, price: 130, description: "Private package redemption rate", visibility: "private", active: true, capacity: 1, minParticipants: 1, lessonFormat: "private", priceMode: "session", location: "Package redemption" },
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

function env(name, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function cleanString(value, fallback = "", max = 600) {
  return typeof value === "string" ? value.trim().slice(0, max) : fallback;
}

function parseCookies(req) {
  const cookieHeader = req.headers.get("cookie") || "";
  return Object.fromEntries(
    cookieHeader
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

function databaseUrl() {
  return env("DATABASE_URL") || env("NETLIFY_DATABASE_URL") || env("POSTGRES_URL") || env("SUPABASE_DB_URL");
}

function createClient() {
  const connectionString = databaseUrl();
  if (!connectionString) throw new Error("Database is not configured. Set DATABASE_URL in Netlify.");
  return new Client({
    connectionString,
    connectionTimeoutMillis: Number(env("DATABASE_CONNECTION_TIMEOUT_MS", "5000")),
    query_timeout: Number(env("DATABASE_QUERY_TIMEOUT_MS", "15000")),
    statement_timeout: Number(env("DATABASE_STATEMENT_TIMEOUT_MS", "15000")),
    ssl: env("DATABASE_SSL", "true").toLowerCase() === "false" ? false : { rejectUnauthorized: false },
  });
}

async function connect() {
  const client = createClient();
  await client.connect();
  return client;
}

async function ensureTables(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await client.query(`CREATE TABLE IF NOT EXISTS calendar_items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, week INTEGER NOT NULL DEFAULT 0, day INTEGER NOT NULL, start INTEGER NOT NULL, duration INTEGER NOT NULL, service_id TEXT, client TEXT, title TEXT NOT NULL, phone TEXT, email TEXT, note TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_calendar_items_slot ON calendar_items (week, day, start)`);
  await client.query(`CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, phone TEXT, notes TEXT, source TEXT, caddy_profile_id TEXT, caddy_profile_url TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_people_email_unique ON people (LOWER(email)) WHERE email IS NOT NULL AND email <> ''`);
  await client.query(`CREATE TABLE IF NOT EXISTS admin_users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await client.query(`CREATE TABLE IF NOT EXISTS admin_sessions (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await client.query(`CREATE TABLE IF NOT EXISTS notification_history (id TEXT PRIMARY KEY, person_key TEXT, calendar_item_id TEXT, recipient TEXT NOT NULL, subject TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, provider TEXT, provider_id TEXT, error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.query(`CREATE TABLE IF NOT EXISTS notification_webhook_events (id TEXT PRIMARY KEY, provider_id TEXT, event_type TEXT NOT NULL, payload TEXT, received_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}

function defaultSettings() {
  return {
    syncKey: env("CLARITY_CALENDAR_SYNC_KEY", `cg_${Date.now().toString(36)}`),
    notificationEmail: env("CLARITY_NOTIFICATION_EMAIL", ""),
    replyToEmail: env("CLARITY_REPLY_TO_EMAIL", ""),
    notificationDelaySeconds: "30",
    sendClientEmail: "true",
    sendAdminEmail: "true",
    clientEmailSubject: "Your {{service}} is confirmed",
    clientEmailIntro: "Thanks {{firstName}}, your booking with {{coach}} is confirmed.",
    clientEmailFooter: "Need to move your booking? Reply to this email and we will help.",
    adminEmailSubject: "New booking: {{client}}",
    adminEmailIntro: "{{client}} booked {{service}} for {{date}} at {{time}}.",
    sendClientSms: "false",
    sendAdminSms: "false",
    accountId: env("CLARITY_COACH_ACCOUNT_ID", "sam-hale-golf"),
    accountCoachName: env("CLARITY_COACH_NAME", "Sam Hale"),
    accountBusinessName: env("CLARITY_BUSINESS_NAME", "Sam Hale Golf"),
    accountVenueName: env("CLARITY_VENUE_NAME", "The Range 24/7 - Three Kings"),
    accountVenueShortName: env("CLARITY_VENUE_SHORT_NAME", "The Range 24/7"),
    accountTimezone: env("CLARITY_TIMEZONE", "Pacific/Auckland"),
    accountContactEmail: env("CLARITY_CONTACT_EMAIL", ""),
    accountBookingUrl: env("CLARITY_BOOKING_URL", "https://book.claritygolf.app"),
    accountCalendarSlug: env("CLARITY_CALENDAR_SLUG", "sam-hale-golf"),
    accountCaddyWorkspaceUrl: env("CLARITY_CADDY_WORKSPACE_URL", "https://caddy.claritygolf.app"),
    coachName: env("CLARITY_BUSINESS_NAME", "Sam Hale Golf"),
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

async function seedSettingsIfNeeded(client) {
  const count = await client.query("SELECT COUNT(*)::int AS count FROM settings");
  if ((count.rows[0]?.count || 0) > 0) return;
  const defaults = defaultSettings();
  for (const [key, value] of Object.entries(defaults)) {
    await client.query(
      "INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO NOTHING",
      [key, String(value ?? "")],
    );
  }
}

async function readSettingsMap(client) {
  const rows = await client.query("SELECT key, value FROM settings");
  return Object.fromEntries(rows.rows.map((row) => [row.key, row.value]));
}

async function requireAdmin(client, req) {
  const token = parseCookies(req)[sessionCookieName] || "";
  if (!token) return null;
  const result = await client.query(
    `SELECT admin_users.id, admin_users.email, admin_sessions.expires_at
     FROM admin_sessions
     JOIN admin_users ON admin_users.id = admin_sessions.user_id
     WHERE admin_sessions.token_hash = $1
     LIMIT 1`,
    [hashToken(token)],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return { id: row.id, email: row.email };
}

function parseJsonSetting(value, fallback) {
  try {
    const parsed = JSON.parse(value || "");
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
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
    title: row.title || "Appointment",
    phone: row.phone || "",
    email: row.email || "",
    note: row.note || "",
  };
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

function adminSettings(settings) {
  const delaySeconds = Number(settings.notificationDelaySeconds || 30);
  return {
    emailNotificationsEnabled: settings.emailNotificationsEnabled !== "false",
    notificationEmail: settings.notificationEmail || "",
    replyToEmail: settings.replyToEmail || "",
    notificationDelaySeconds: Number.isFinite(delaySeconds) ? Math.max(30, Math.min(3600, delaySeconds)) : 30,
    sendClientEmail: settings.sendClientEmail !== "false",
    sendAdminEmail: settings.sendAdminEmail !== "false",
    clientEmailSubject: settings.clientEmailSubject || "Your {{service}} is confirmed",
    clientEmailIntro: settings.clientEmailIntro || "Thanks {{firstName}}, your booking with {{coach}} is confirmed.",
    clientEmailFooter: settings.clientEmailFooter || "Need to move your booking? Reply to this email and we will help.",
    adminEmailSubject: settings.adminEmailSubject || "New booking: {{client}}",
    adminEmailIntro: settings.adminEmailIntro || "{{client}} booked {{service}} for {{date}} at {{time}}.",
    smsProviderName: settings.smsProviderName || "",
    smsWebhookUrl: settings.smsWebhookUrl || "",
    smsFromNumber: settings.smsFromNumber || "",
    sendClientSms: settings.sendClientSms === "true",
    sendAdminSms: settings.sendAdminSms === "true",
  };
}

function coachAccount(settings) {
  return {
    id: settings.accountId || "sam-hale-golf",
    coachName: settings.accountCoachName || "Sam Hale",
    businessName: settings.accountBusinessName || settings.coachName || "Sam Hale Golf",
    venueName: settings.accountVenueName || "The Range 24/7 - Three Kings",
    venueShortName: settings.accountVenueShortName || "The Range 24/7",
    timezone: settings.accountTimezone || "Pacific/Auckland",
    contactEmail: settings.accountContactEmail || "",
    bookingUrl: settings.accountBookingUrl || "https://book.claritygolf.app",
    calendarSlug: settings.accountCalendarSlug || "sam-hale-golf",
    caddyWorkspaceUrl: settings.accountCaddyWorkspaceUrl || "https://caddy.claritygolf.app",
  };
}

function brandSettings(settings) {
  const account = coachAccount(settings);
  return {
    coachName: settings.coachName || account.businessName,
    logoName: settings.brandLogoName || "",
    logoPreview: settings.brandLogoPreview || "",
    neutral: settings.brandNeutral || "#ffffff",
    primary: settings.brandPrimary || "#1fd36d",
    secondary: settings.brandSecondary || "#d7b06b",
    accent: settings.brandAccent || "#07100a",
    bookingTheme: settings.brandBookingTheme === "light" ? "light" : "dark",
  };
}

async function readCalendarState(client) {
  let settings = await readSettingsMap(client);
  if (!settings.syncKey) {
    const syncKey = defaultSettings().syncKey;
    await client.query("INSERT INTO settings (key, value, updated_at) VALUES ('syncKey', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at", [syncKey]);
    settings = { ...settings, syncKey };
  }

  const [items, people, notifications] = await Promise.all([
    client.query("SELECT * FROM calendar_items ORDER BY week, day, start, id"),
    client.query("SELECT * FROM people ORDER BY LOWER(name), LOWER(email), id"),
    client.query("SELECT * FROM notification_history ORDER BY created_at DESC LIMIT 500"),
  ]);

  return {
    syncKey: settings.syncKey,
    updatedAt: settings.updatedAt || nowIso(),
    items: items.rows.map(rowToItem),
    services: parseJsonSetting(settings.servicesJson, defaultServices),
    availability: parseJsonSetting(settings.availabilityJson, defaultAvailability),
    people: people.rows.map(rowToPerson),
    notifications: notifications.rows.map(rowToNotification),
    settings: adminSettings(settings),
    brand: brandSettings(settings),
    account: coachAccount(settings),
  };
}

function cleanCalendarItem(item) {
  if (!item || typeof item !== "object") return null;
  const kind = item.kind === "block" ? "block" : item.kind === "appointment" ? "appointment" : null;
  const day = Number(item.day);
  const start = Number(item.start);
  const duration = Number(item.duration);
  if (!kind || !Number.isInteger(day) || day < 0 || day > 6) return null;
  if (!Number.isInteger(start) || start < 0 || start > 24 * 60) return null;
  if (!Number.isInteger(duration) || duration <= 0 || duration > 12 * 60) return null;
  return {
    id: cleanString(item.id, `${kind}-${Date.now()}`, 140),
    kind,
    week: Number.isInteger(Number(item.week)) ? Number(item.week) : 0,
    day,
    start,
    duration,
    serviceId: cleanString(item.serviceId, "", 140),
    client: cleanString(item.client, "", 180),
    title: cleanString(item.title, kind === "block" ? "Busy" : "Appointment", 180),
    phone: cleanString(item.phone, "", 80),
    email: cleanString(item.email, "", 180),
    note: cleanString(item.note, "", 1200),
  };
}

async function writeCalendarState(client, body) {
  const items = Array.isArray(body?.items) ? body.items.map(cleanCalendarItem).filter(Boolean) : [];
  const syncKey = cleanString(body?.syncKey, "", 160);
  const updatedAt = nowIso();
  await client.query("BEGIN");
  try {
    if (body?.replaceItems === true || body?.itemsOperation === "replace" || body?.clearItems === true) {
      await client.query("DELETE FROM calendar_items");
    }
    for (const item of items) {
      await client.query(
        `INSERT INTO calendar_items (id, kind, week, day, start, duration, service_id, client, title, phone, email, note, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, week = EXCLUDED.week, day = EXCLUDED.day, start = EXCLUDED.start,
           duration = EXCLUDED.duration, service_id = EXCLUDED.service_id, client = EXCLUDED.client, title = EXCLUDED.title,
           phone = EXCLUDED.phone, email = EXCLUDED.email, note = EXCLUDED.note, updated_at = NOW()`,
        [item.id, item.kind, item.week, item.day, item.start, item.duration, item.serviceId, item.client, item.title, item.phone, item.email, item.note],
      );
    }
    if (syncKey) {
      await client.query("INSERT INTO settings (key, value, updated_at) VALUES ('syncKey', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at", [syncKey]);
    }
    await client.query("INSERT INTO settings (key, value, updated_at) VALUES ('updatedAt', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at", [updatedAt]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
  return { ...(await readCalendarState(client)), notificationResults: [] };
}

export default async (req: Request) => {
  const client = await connect();
  try {
    await ensureTables(client);
    await seedSettingsIfNeeded(client);
    const session = await requireAdmin(client, req);
    if (!session) return json({ error: "unauthorized", message: "Admin login required." }, 401);

    if (req.method === "GET") return json(await readCalendarState(client));
    if (req.method === "PUT") return json(await writeCalendarState(client, await req.json().catch(() => ({}))));
    return json({ error: "method_not_allowed" }, 405);
  } catch (error) {
    console.error("calendar_state_direct_failed", error);
    return json({ error: "calendar_state_error", message: error instanceof Error ? error.message : "Unknown calendar-state error" }, 500);
  } finally {
    await client.end().catch(() => {});
  }
};

export const config: Config = {
  path: "/api/calendar-state",
};
