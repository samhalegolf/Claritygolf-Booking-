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
import {
  cleanPlayerBookingEmbedHeight,
  cleanPlayerBookingEmbedIntro,
  cleanPlayerBookingEmbedLabel,
  cleanPlayerBookingEmbedUrl,
  playerBookingEmbedFromSettings,
} from "./_shared/player-booking-embed.mts";

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

/**
 * One upsert for every key in `values`.
 *
 * This used to be a `setSetting(accountId, key, value)` called once per key,
 * awaited in series. A Settings save sends the whole object, so a single PUT
 * became ~30 sequential Netlify->Supabase round trips at ~217 ms each (the
 * figure booking-core measures): comfortably past the 10 s function limit, and
 * the failure mode was the worst possible one -- the rows written before the
 * timeout stayed written, while the caller got an HTML error page instead of
 * the new settings and so never refreshed. A toggle would take effect on the
 * send path while the screen still read "Off".
 *
 * settingsUpsertRows already takes a whole key/value object, so the batch is
 * one request and the write is all-or-nothing.
 */
async function writeSettings(accountId: string, values: Record<string, unknown>) {
  const rows = settingsUpsertRows(accountId, values, nowIso());
  if (!rows.length) return;
  await supabase("settings", {
    method: "POST",
    query: SETTINGS_UPSERT_QUERY,
    prefer: "resolution=merge-duplicates,return=minimal",
    body: rows,
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
    // The player portal's slot for someone else's booking widget. Flattened
    // into this object rather than nested, so it saves through the same PUT as
    // everything else on the Settings screen.
    ...playerBookingEmbedFromSettings(settings),
  };
}

async function writeAdminSettings(accountId: string, settings: any) {
  // Collected, then written in one upsert below. Staging is deliberate: a
  // partial save is what let the reminder toggle fire without the screen ever
  // agreeing that it was on.
  const pending: Record<string, unknown> = {};
  const stage = (key: string, value: unknown) => {
    pending[key] = value;
  };
  if (hasOwn(settings, "emailNotificationsEnabled")) stage("emailNotificationsEnabled", settings?.emailNotificationsEnabled ? "true" : "false");
  if (hasOwn(settings, "notificationEmail")) stage("notificationEmail", cleanEmail(settings?.notificationEmail, ""));
  if (hasOwn(settings, "coachEmail")) stage("coachEmail", cleanEmail(settings?.coachEmail, ""));
  if (hasOwn(settings, "replyToEmail")) stage("replyToEmail", cleanEmail(settings?.replyToEmail, ""));
  if (hasOwn(settings, "googleReviewUrl")) stage("googleReviewUrl", cleanUrl(settings?.googleReviewUrl, ""));
  if (hasOwn(settings, "notificationFromName")) stage("notificationFromName", cleanString(settings?.notificationFromName, "", 120));
  if (hasOwn(settings, "notificationSubjectLine")) stage("notificationSubjectLine", cleanString(settings?.notificationSubjectLine, "", 180));
  if (hasOwn(settings, "notificationDelaySeconds")) {
    const delaySeconds = Number(settings?.notificationDelaySeconds ?? 30);
    stage("notificationDelaySeconds", String(Number.isFinite(delaySeconds) ? Math.max(30, Math.min(3600, delaySeconds)) : 30));
  }
  if (hasOwn(settings, "minBookingNoticeMinutes")) {
    stage("minBookingNoticeMinutes", String(cleanMinBookingNoticeMinutes(settings?.minBookingNoticeMinutes)));
  }
  if (hasOwn(settings, "sendClientEmail")) stage("sendClientEmail", settings?.sendClientEmail ? "true" : "false");
  if (hasOwn(settings, "sendCoachEmail")) stage("sendCoachEmail", settings?.sendCoachEmail ? "true" : "false");
  if (hasOwn(settings, "sendAdminEmail")) stage("sendAdminEmail", settings?.sendAdminEmail ? "true" : "false");
  if (hasOwn(settings, "sendLessonTypeChangeEmail")) stage("sendLessonTypeChangeEmail", settings?.sendLessonTypeChangeEmail ? "true" : "false");
  if (hasOwn(settings, "reminderEnabled")) stage("reminderEnabled", settings?.reminderEnabled ? "true" : "false");
  if (hasOwn(settings, "reminderLeadMinutes")) stage("reminderLeadMinutes", String(cleanReminderLeadMinutes(settings?.reminderLeadMinutes)));
  if (hasOwn(settings, "clientEmailSubject")) stage("clientEmailSubject", cleanString(settings?.clientEmailSubject, defaultEmailTemplates.clientEmailSubject, 180));
  if (hasOwn(settings, "clientEmailIntro")) stage("clientEmailIntro", cleanString(settings?.clientEmailIntro, defaultEmailTemplates.clientEmailIntro, 900));
  if (hasOwn(settings, "clientEmailFooter")) stage("clientEmailFooter", modernClientEmailFooter(settings?.clientEmailFooter));
  if (hasOwn(settings, "adminEmailSubject")) stage("adminEmailSubject", cleanString(settings?.adminEmailSubject, defaultEmailTemplates.adminEmailSubject, 180));
  if (hasOwn(settings, "adminEmailIntro")) stage("adminEmailIntro", cleanString(settings?.adminEmailIntro, defaultEmailTemplates.adminEmailIntro, 900));
  if (hasOwn(settings, "smsProviderName")) stage("smsProviderName", cleanString(settings?.smsProviderName, "", 80));
  if (hasOwn(settings, "smsWebhookUrl")) stage("smsWebhookUrl", cleanString(settings?.smsWebhookUrl, "", 600));
  if (hasOwn(settings, "smsFromNumber")) stage("smsFromNumber", cleanString(settings?.smsFromNumber, "", 80));
  if (hasOwn(settings, "sendClientSms")) stage("sendClientSms", settings?.sendClientSms ? "true" : "false");
  if (hasOwn(settings, "sendAdminSms")) stage("sendAdminSms", settings?.sendAdminSms ? "true" : "false");
  if (hasOwn(settings, "notificationTemplates")) {
    stage("notificationTemplatesJson", JSON.stringify(cleanNotificationTemplates(settings?.notificationTemplates)));
  }
  if (hasOwn(settings, "mapLinkLabel")) {
    stage("mapLinkLabel", cleanString(settings?.mapLinkLabel, DEFAULT_MAP_LINK_LABEL, 40) || DEFAULT_MAP_LINK_LABEL);
  }
  // Written key by key like everything above rather than in a loop: the
  // "every setting the API accepts is editable somewhere" test in
  // src/uiRules.test.ts finds accepted keys by scanning for these hasOwn
  // calls, and a loop would hide these four from it.
  if (hasOwn(settings, "playerBookingEmbedUrl")) stage("playerBookingEmbedUrl", cleanPlayerBookingEmbedUrl(settings?.playerBookingEmbedUrl));
  if (hasOwn(settings, "playerBookingEmbedLabel")) stage("playerBookingEmbedLabel", cleanPlayerBookingEmbedLabel(settings?.playerBookingEmbedLabel));
  if (hasOwn(settings, "playerBookingEmbedIntro")) stage("playerBookingEmbedIntro", cleanPlayerBookingEmbedIntro(settings?.playerBookingEmbedIntro));
  if (hasOwn(settings, "playerBookingEmbedHeight")) stage("playerBookingEmbedHeight", String(cleanPlayerBookingEmbedHeight(settings?.playerBookingEmbedHeight)));
  stage("updatedAt", nowIso());
  await writeSettings(accountId, pending);
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
