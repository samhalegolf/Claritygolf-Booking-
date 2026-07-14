import type { Config, Context } from "@netlify/functions";

import { handlePublicRescheduleRequest } from "./booking-core.mts";
import { activeLocale } from "./_shared/locale.mts";
import { setActivePhoneCountry } from "./_shared/phone.mts";

const baseWeekStart = new Date(Date.UTC(2026, 5, 1));
const millisecondsPerDay = 24 * 60 * 60 * 1000;
const minutesPerDay = 24 * 60;
const defaultTimezone = "Pacific/Auckland";
const defaultMinBookingNoticeMinutes = 240;

function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function cleanString(value: unknown, fallback = "", max = 600) {
  return typeof value === "string" ? value.trim().slice(0, max) : fallback;
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

function settingMap(rows: Array<{ key: string; value: string }>) {
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

async function readBookingRuleSettings() {
  const rows = await supabase("settings", { query: "select=key,value" });
  return settingMap(rows);
}

function cleanMinBookingNoticeMinutes(value: unknown) {
  const minutes = Number(value ?? defaultMinBookingNoticeMinutes);
  return Number.isFinite(minutes) ? Math.max(0, Math.min(7 * 24 * 60, Math.round(minutes))) : defaultMinBookingNoticeMinutes;
}

function bookingNoticeLabel(minutes: number) {
  if (minutes <= 0) return "a future time";
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"} ahead`;
  }
  return `${minutes} minutes ahead`;
}

function zonedNowParts(timezone: string) {
  const zone = cleanString(timezone, defaultTimezone, 80) || defaultTimezone;
  try {
    const parts = new Intl.DateTimeFormat(activeLocale(), {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date());
    const value = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
    return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute") };
  } catch {
    if (zone !== defaultTimezone) return zonedNowParts(defaultTimezone);
    throw new Error("Booking timezone could not be checked.");
  }
}

function localDayIndex(year: number, month: number, day: number) {
  return Math.floor((Date.UTC(year, month - 1, day) - Date.UTC(baseWeekStart.getUTCFullYear(), baseWeekStart.getUTCMonth(), baseWeekStart.getUTCDate())) / millisecondsPerDay);
}

function slotIsBeforeMinimumNotice(slot: { week: number; day: number; start: number }, timezone: string, minBookingNoticeMinutes: number) {
  const now = zonedNowParts(timezone);
  const nowTotal = localDayIndex(now.year, now.month, now.day) * minutesPerDay + now.hour * 60 + now.minute;
  const slotTotal = (slot.week * 7 + slot.day) * minutesPerDay + slot.start;
  return slotTotal <= nowTotal || slotTotal < nowTotal + cleanMinBookingNoticeMinutes(minBookingNoticeMinutes);
}

async function assertRescheduleIsFuture(req: Request) {
  if (req.method !== "POST") return;
  let payload: any = {};
  try {
    payload = await req.clone().json();
  } catch {
    return;
  }

  const week = Number(payload?.week ?? 0);
  const day = Number(payload?.day);
  const start = Number(payload?.start);
  if (!Number.isInteger(week) || !Number.isInteger(day) || !Number.isInteger(start) || day < 0 || day > 6) return;

  const settings = await readBookingRuleSettings();
  // Resolve the workspace's country before any date is formatted, so this
  // lambda formats dates the coach's way rather than New Zealand's.
  setActivePhoneCountry((settings as any).accountCountry);
  const minBookingNoticeMinutes = cleanMinBookingNoticeMinutes(settings.minBookingNoticeMinutes ?? env("CLARITY_MIN_BOOKING_NOTICE_MINUTES", String(defaultMinBookingNoticeMinutes)));
  const timezone = settings.accountTimezone || env("CLARITY_TIMEZONE", defaultTimezone);
  if (!slotIsBeforeMinimumNotice({ week, day, start }, timezone, minBookingNoticeMinutes)) return;
  throw Object.assign(new Error(`Choose a time at least ${bookingNoticeLabel(minBookingNoticeMinutes)}.`), { status: 400 });
}

export default async (req: Request, context: Context) => {
  try {
    await assertRescheduleIsFuture(req);
  } catch (error: any) {
    const status = error?.status || 400;
    return json(
      {
        error: "request_error",
        message: error instanceof Error ? error.message : "Choose a future appointment time.",
      },
      status,
    );
  }

  return handlePublicRescheduleRequest(req, context);
};

export const config: Config = {
  path: "/api/public-reschedule",
};
