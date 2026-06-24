import type { Config, Context } from "@netlify/functions";

import { handlePublicRescheduleRequest } from "./booking-core.mts";

const baseWeekStart = new Date(Date.UTC(2026, 5, 1));
const millisecondsPerDay = 24 * 60 * 60 * 1000;
const defaultTimezone = "Pacific/Auckland";

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

function zonedNowParts(timezone: string) {
  const zone = cleanString(timezone, defaultTimezone, 80) || defaultTimezone;
  try {
    const parts = new Intl.DateTimeFormat("en-NZ", {
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

function slotIsInPast(slot: { week: number; day: number; start: number }, timezone: string) {
  const now = zonedNowParts(timezone);
  const todayIndex = localDayIndex(now.year, now.month, now.day);
  const slotIndex = slot.week * 7 + slot.day;
  if (slotIndex < todayIndex) return true;
  if (slotIndex > todayIndex) return false;
  return slot.start <= now.hour * 60 + now.minute;
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

  if (!slotIsInPast({ week, day, start }, env("CLARITY_TIMEZONE", defaultTimezone))) return;
  throw Object.assign(new Error("Choose a future appointment time."), { status: 400 });
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
