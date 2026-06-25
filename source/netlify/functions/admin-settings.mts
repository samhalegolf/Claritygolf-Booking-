import type { Config } from "@netlify/functions";
import { createHash } from "node:crypto";

const sessionCookieName = "clarity_session";
const defaultMinBookingNoticeMinutes = 240;

const defaultEmailTemplates = {
  clientEmailSubject: "Your {{service}} is confirmed",
  clientEmailIntro: "Thanks {{firstName}}, your booking with {{coach}} is confirmed.",
  clientEmailFooter: "We look forward to seeing you.",
  adminEmailSubject: "New booking: {{client}}",
  adminEmailIntro: "{{client}} booked {{service}} for {{date}} at {{time}}.",
};

function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function nowIso() {
  return new Date().toISOString();
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function cleanString(value: unknown, fallback = "", max = 600) {
  return typeof value === "string" ? value.trim().slice(0, max) : fallback;
}

function cleanEmail(value: unknown, fallback = "") {
  return cleanString(value, fallback, 180).toLowerCase();
}

function cleanMinBookingNoticeMinutes(value: unknown, fallback = defaultMinBookingNoticeMinutes) {
  const minutes = Number(value ?? fallback);
  return Number.isFinite(minutes) ? Math.max(0, Math.min(7 * 24 * 60, Math.round(minutes))) : fallback;
}

function modernClientEmailFooter(value: unknown) {
  const footer = cleanString(value, defaultEmailTemplates.clientEmailFooter, 900);
  return /need to (move|change)|reply to this email.*(move|change|reschedul)|email.*(move|change|reschedul)/i.test(footer)
    ? defaultEmailTemplates.clientEmailFooter
    : footer;
}

function hasOwn(source: unknown, key: string) {
  return Object.prototype.hasOwnProperty.call(source || {}, key);
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

function supabaseConfig() {
  const url = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
  if (!url || !key) throw new Error("Supabase is not configured.");
  return { url, key };
}

async function supabase(table: string, options: { method?: string; query?: string; body?: unknown; prefer?: string } = {}) {
  const { url, key } = supabaseConfig();
  const response = await fetch(`${url}/rest/v1/${table}${options.query ? `?${options.query}` : ""}`, {
    method: options.method || "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(options.prefer ? { Prefer: options.prefer } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${options.method || "GET"} ${table} failed ${response.status}: ${text.slice(0, 500)}`);
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

async function setSetting(key: string, value: unknown) {
  await supabase("settings", {
    method: "POST",
    query: "on_conflict=key",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: [{ key, value: String(value ?? ""), updated_at: nowIso() }],
  });
}

async function readAdminSettings() {
  const rows = await supabase("settings", { query: "select=key,value" });
  const settings = settingMap(rows);
  const delaySeconds = Number(settings.notificationDelaySeconds || 30);
  return {
    emailNotificationsEnabled: settings.emailNotificationsEnabled !== "false",
    notificationEmail: settings.notificationEmail || "",
    coachEmail: settings.coachEmail || "",
    replyToEmail: settings.replyToEmail || "",
    notificationSubjectLine: cleanString(settings.notificationSubjectLine, "", 180),
    notificationDelaySeconds: Number.isFinite(delaySeconds) ? Math.max(30, Math.min(3600, delaySeconds)) : 30,
    minBookingNoticeMinutes: cleanMinBookingNoticeMinutes(settings.minBookingNoticeMinutes ?? env("CLARITY_MIN_BOOKING_NOTICE_MINUTES", String(defaultMinBookingNoticeMinutes))),
    sendClientEmail: settings.sendClientEmail !== "false",
    sendCoachEmail: settings.sendCoachEmail !== "false",
    sendAdminEmail: settings.sendAdminEmail !== "false",
    clientEmailSubject: settings.clientEmailSubject || defaultEmailTemplates.clientEmailSubject,
    clientEmailIntro: settings.clientEmailIntro || defaultEmailTemplates.clientEmailIntro,
    clientEmailFooter: modernClientEmailFooter(settings.clientEmailFooter),
    adminEmailSubject: settings.adminEmailSubject || defaultEmailTemplates.adminEmailSubject,
    adminEmailIntro: settings.adminEmailIntro || defaultEmailTemplates.adminEmailIntro,
    smsProviderName: settings.smsProviderName || "",
    smsWebhookUrl: settings.smsWebhookUrl || "",
    smsFromNumber: settings.smsFromNumber || "",
    sendClientSms: settings.sendClientSms === "true",
    sendAdminSms: settings.sendAdminSms === "true",
  };
}

async function writeAdminSettings(settings: any) {
  if (hasOwn(settings, "emailNotificationsEnabled")) await setSetting("emailNotificationsEnabled", settings?.emailNotificationsEnabled ? "true" : "false");
  if (hasOwn(settings, "notificationEmail")) await setSetting("notificationEmail", cleanEmail(settings?.notificationEmail, ""));
  if (hasOwn(settings, "coachEmail")) await setSetting("coachEmail", cleanEmail(settings?.coachEmail, ""));
  if (hasOwn(settings, "replyToEmail")) await setSetting("replyToEmail", cleanEmail(settings?.replyToEmail, ""));
  if (hasOwn(settings, "notificationSubjectLine")) await setSetting("notificationSubjectLine", cleanString(settings?.notificationSubjectLine, "", 180));
  if (hasOwn(settings, "notificationDelaySeconds")) {
    const delaySeconds = Number(settings?.notificationDelaySeconds ?? 30);
    await setSetting("notificationDelaySeconds", String(Number.isFinite(delaySeconds) ? Math.max(30, Math.min(3600, delaySeconds)) : 30));
  }
  if (hasOwn(settings, "minBookingNoticeMinutes")) {
    await setSetting("minBookingNoticeMinutes", String(cleanMinBookingNoticeMinutes(settings?.minBookingNoticeMinutes)));
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

async function parseBody(req: Request) {
  const raw = await req.text();
  return raw ? JSON.parse(raw) : {};
}

export default async function handler(req: Request) {
  try {
    if (!(await requireAdmin(req))) return json({ error: "unauthorized", message: "Admin login required." }, 401);
    if (req.method === "GET") return json(await readAdminSettings());
    if (req.method === "PUT" || req.method === "POST") return json(await writeAdminSettings(await parseBody(req)));
    return json({ error: "method_not_allowed" }, 405);
  } catch (error) {
    console.error("admin_settings:failed", error);
    return json({ error: "admin_settings_error", message: error instanceof Error ? error.message : "Admin settings failed." }, 500);
  }
}

export const config: Config = { path: "/api/admin-settings" };
