import type { Config } from "@netlify/functions";
import { requireCoachActor } from "./_shared/coach-auth.mts";
import {
  SETTINGS_UPSERT_QUERY,
  settingsSelectQuery,
  settingsUpsertRows,
} from "./_shared/settings-scope.mts";
import {
  cleanNotificationTemplates,
  DEFAULT_MAP_LINK_LABEL,
  parseNotificationTemplates,
} from "./_shared/notification-templates.mts";

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

function cleanString(value: unknown, fallback = "", max = 600) {
  return typeof value === "string" ? value.trim().slice(0, max) : fallback;
}

function cleanEmail(value: unknown, fallback = "") {
  return cleanString(value, fallback, 180).toLowerCase();
}

function cleanUrl(value: unknown, fallback = "") {
  const candidate = cleanString(value, "", 700);
  try {
    return new URL(candidate).toString();
  } catch {
    return fallback;
  }
}

function configuredSenderEmailFromEnv(value: unknown) {
  const source = cleanString(value, "", 500);
  if (!source) return "";
  const match = source.match(/<\s*([^>]+)\s*>/);
  const candidate = match ? match[1] : source;
  return cleanEmail(candidate, "");
}

function cleanMinBookingNoticeMinutes(value: unknown, fallback = defaultMinBookingNoticeMinutes) {
  const minutes = Number(value ?? fallback);
  return Number.isFinite(minutes) ? Math.max(0, Math.min(7 * 24 * 60, Math.round(minutes))) : fallback;
}

// Reminder lead time: 1 hour to 14 days before the lesson, default 24 hours.
function cleanReminderLeadMinutes(value: unknown, fallback = 24 * 60) {
  const minutes = Number(value ?? fallback);
  return Number.isFinite(minutes) ? Math.max(60, Math.min(14 * 24 * 60, Math.round(minutes))) : fallback;
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

/**
 * This used to be "the session token exists in admin_sessions", which said
 * nothing about *which* business the caller administers -- and this function
 * then read and wrote settings globally. It now goes through the same actor
 * resolution as Booking, so the answer is an account or a 401/403.
 */
async function requireAccountId(req: Request): Promise<string> {
  return (await requireCoachActor(req)).accountId;
}

function settingMap(rows: Array<{ key: string; value: string }>) {
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

async function setSetting(accountId: string, key: string, value: unknown) {
  await supabase("settings", {
    method: "POST",
    query: SETTINGS_UPSERT_QUERY,
    prefer: "resolution=merge-duplicates,return=minimal",
    body: settingsUpsertRows(accountId, { [key]: value }, nowIso()),
  });
}

async function readAdminSettings(accountId: string) {
  const rows = await supabase("settings", { query: settingsSelectQuery(accountId) });
  const settings = settingMap(rows);
  const delaySeconds = Number(settings.notificationDelaySeconds || 30);
  return {
    emailNotificationsEnabled: settings.emailNotificationsEnabled !== "false",
    notificationEmail: settings.notificationEmail || "",
    coachEmail: settings.coachEmail || "",
    replyToEmail: settings.replyToEmail || "",
    googleReviewUrl: cleanUrl(settings.googleReviewUrl, ""),
    notificationFromName: cleanString(settings.notificationFromName, "", 120),
    configuredSenderEmailAddress: configuredSenderEmailFromEnv(
      env("CLARITY_EMAIL_FROM", env("CLARITY_NOTIFICATION_EMAIL", settings.notificationEmail || "")),
    ),
    notificationSubjectLine: cleanString(settings.notificationSubjectLine, "", 180),
    notificationDelaySeconds: Number.isFinite(delaySeconds) ? Math.max(30, Math.min(3600, delaySeconds)) : 30,
    minBookingNoticeMinutes: cleanMinBookingNoticeMinutes(settings.minBookingNoticeMinutes ?? env("CLARITY_MIN_BOOKING_NOTICE_MINUTES", String(defaultMinBookingNoticeMinutes))),
    sendClientEmail: settings.sendClientEmail !== "false",
    sendCoachEmail: settings.sendCoachEmail !== "false",
    sendAdminEmail: settings.sendAdminEmail !== "false",
    sendLessonTypeChangeEmail: settings.sendLessonTypeChangeEmail === "true",
    reminderEnabled: settings.reminderEnabled === "true",
    reminderLeadMinutes: cleanReminderLeadMinutes(settings.reminderLeadMinutes),
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
    notificationTemplates: parseNotificationTemplates(settings.notificationTemplatesJson),
    mapLinkLabel: cleanString(settings.mapLinkLabel, DEFAULT_MAP_LINK_LABEL, 40) || DEFAULT_MAP_LINK_LABEL,
  };
}

async function writeAdminSettings(accountId: string, settings: any) {
  if (hasOwn(settings, "emailNotificationsEnabled")) await setSetting(accountId, "emailNotificationsEnabled", settings?.emailNotificationsEnabled ? "true" : "false");
  if (hasOwn(settings, "notificationEmail")) await setSetting(accountId, "notificationEmail", cleanEmail(settings?.notificationEmail, ""));
  if (hasOwn(settings, "coachEmail")) await setSetting(accountId, "coachEmail", cleanEmail(settings?.coachEmail, ""));
  if (hasOwn(settings, "replyToEmail")) await setSetting(accountId, "replyToEmail", cleanEmail(settings?.replyToEmail, ""));
  if (hasOwn(settings, "googleReviewUrl")) await setSetting(accountId, "googleReviewUrl", cleanUrl(settings?.googleReviewUrl, ""));
  if (hasOwn(settings, "notificationFromName")) await setSetting(accountId, "notificationFromName", cleanString(settings?.notificationFromName, "", 120));
  if (hasOwn(settings, "notificationSubjectLine")) await setSetting(accountId, "notificationSubjectLine", cleanString(settings?.notificationSubjectLine, "", 180));
  if (hasOwn(settings, "notificationDelaySeconds")) {
    const delaySeconds = Number(settings?.notificationDelaySeconds ?? 30);
    await setSetting(accountId, "notificationDelaySeconds", String(Number.isFinite(delaySeconds) ? Math.max(30, Math.min(3600, delaySeconds)) : 30));
  }
  if (hasOwn(settings, "minBookingNoticeMinutes")) {
    await setSetting(accountId, "minBookingNoticeMinutes", String(cleanMinBookingNoticeMinutes(settings?.minBookingNoticeMinutes)));
  }
  if (hasOwn(settings, "sendClientEmail")) await setSetting(accountId, "sendClientEmail", settings?.sendClientEmail ? "true" : "false");
  if (hasOwn(settings, "sendCoachEmail")) await setSetting(accountId, "sendCoachEmail", settings?.sendCoachEmail ? "true" : "false");
  if (hasOwn(settings, "sendAdminEmail")) await setSetting(accountId, "sendAdminEmail", settings?.sendAdminEmail ? "true" : "false");
  if (hasOwn(settings, "sendLessonTypeChangeEmail")) await setSetting(accountId, "sendLessonTypeChangeEmail", settings?.sendLessonTypeChangeEmail ? "true" : "false");
  if (hasOwn(settings, "reminderEnabled")) await setSetting(accountId, "reminderEnabled", settings?.reminderEnabled ? "true" : "false");
  if (hasOwn(settings, "reminderLeadMinutes")) await setSetting(accountId, "reminderLeadMinutes", String(cleanReminderLeadMinutes(settings?.reminderLeadMinutes)));
  if (hasOwn(settings, "clientEmailSubject")) await setSetting(accountId, "clientEmailSubject", cleanString(settings?.clientEmailSubject, defaultEmailTemplates.clientEmailSubject, 180));
  if (hasOwn(settings, "clientEmailIntro")) await setSetting(accountId, "clientEmailIntro", cleanString(settings?.clientEmailIntro, defaultEmailTemplates.clientEmailIntro, 900));
  if (hasOwn(settings, "clientEmailFooter")) await setSetting(accountId, "clientEmailFooter", modernClientEmailFooter(settings?.clientEmailFooter));
  if (hasOwn(settings, "adminEmailSubject")) await setSetting(accountId, "adminEmailSubject", cleanString(settings?.adminEmailSubject, defaultEmailTemplates.adminEmailSubject, 180));
  if (hasOwn(settings, "adminEmailIntro")) await setSetting(accountId, "adminEmailIntro", cleanString(settings?.adminEmailIntro, defaultEmailTemplates.adminEmailIntro, 900));
  if (hasOwn(settings, "smsProviderName")) await setSetting(accountId, "smsProviderName", cleanString(settings?.smsProviderName, "", 80));
  if (hasOwn(settings, "smsWebhookUrl")) await setSetting(accountId, "smsWebhookUrl", cleanString(settings?.smsWebhookUrl, "", 600));
  if (hasOwn(settings, "smsFromNumber")) await setSetting(accountId, "smsFromNumber", cleanString(settings?.smsFromNumber, "", 80));
  if (hasOwn(settings, "sendClientSms")) await setSetting(accountId, "sendClientSms", settings?.sendClientSms ? "true" : "false");
  if (hasOwn(settings, "sendAdminSms")) await setSetting(accountId, "sendAdminSms", settings?.sendAdminSms ? "true" : "false");
  if (hasOwn(settings, "notificationTemplates")) {
    await setSetting(accountId, "notificationTemplatesJson", JSON.stringify(cleanNotificationTemplates(settings?.notificationTemplates)));
  }
  if (hasOwn(settings, "mapLinkLabel")) {
    await setSetting(accountId, "mapLinkLabel", cleanString(settings?.mapLinkLabel, DEFAULT_MAP_LINK_LABEL, 40) || DEFAULT_MAP_LINK_LABEL);
  }
  await setSetting(accountId, "updatedAt", nowIso());
  return readAdminSettings(accountId);
}

async function parseBody(req: Request) {
  const raw = await req.text();
  return raw ? JSON.parse(raw) : {};
}

export default async function handler(req: Request) {
  try {
    const accountId = await requireAccountId(req);
    if (req.method === "GET") return json(await readAdminSettings(accountId));
    if (req.method === "PUT" || req.method === "POST") {
      return json(await writeAdminSettings(accountId, await parseBody(req)));
    }
    return json({ error: "method_not_allowed" }, 405);
  } catch (error) {
    const status = (error as { status?: number })?.status;
    if (status === 401 || status === 403) {
      return json(
        {
          error: (error as { code?: string })?.code || "unauthorized",
          message: error instanceof Error ? error.message : "Admin login required.",
        },
        status,
      );
    }
    console.error("admin_settings:failed", error);
    return json({ error: "admin_settings_error", message: error instanceof Error ? error.message : "Admin settings failed." }, 500);
  }
}

export const config: Config = { path: "/api/admin-settings" };
