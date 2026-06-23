import type { Config } from "@netlify/functions";
import { createHash, randomUUID } from "node:crypto";

import { syncGoogleCalendarIfEnabled } from "./google-calendar-sync.mts";
import { notifyBookingEvent } from "./notification-engine.mts";

const defaultServices = [
  { id: "lesson-30", name: "30min Lesson", duration: 30, price: 100, description: "Price Includes Bay Hire", visibility: "public", active: true, capacity: 1, minParticipants: 1, lessonFormat: "private", priceMode: "session", location: "Bay hire included" },
  { id: "lesson-60", name: "1 Hour Golf Lesson", duration: 60, price: 180, description: "Price Includes Bay Hire", visibility: "public", active: true, capacity: 1, minParticipants: 1, lessonFormat: "private", priceMode: "session", location: "Bay hire included" },
  { id: "lesson-pair", name: "2 Person Golf Lesson", duration: 60, price: 200, description: "Two-player coaching session", visibility: "public", active: true, capacity: 2, minParticipants: 1, lessonFormat: "private", priceMode: "session", location: "Bay hire included" },
  { id: "group-clinic", name: "Group Golf Clinic", duration: 90, price: 55, description: "Small-group coaching session with shared practice goals", visibility: "public", active: true, capacity: 6, minParticipants: 3, lessonFormat: "group", priceMode: "per-person", location: "Group coaching bay" },
  { id: "member-30", name: "30min Golf Lesson (Range 24/7 Member)", duration: 30, price: 90, description: "Bay hire is deducted from membership account", visibility: "public", active: true, capacity: 1, minParticipants: 1, lessonFormat: "private", priceMode: "session", location: "Range 24/7 member bay" },
  { id: "member-60", name: "1 Hour Golf Lesson (Range 24/7 Member)", duration: 60, price: 160, description: "Bay hire is deducted from membership account", visibility: "public", active: true, capacity: 1, minParticipants: 1, lessonFormat: "private", priceMode: "session", location: "Range 24/7 member bay" },
  { id: "package-60", name: "1 hour Lesson - 5 Lesson Package", duration: 60, price: 130, description: "Private package redemption rate", visibility: "private", active: true, capacity: 1, minParticipants: 1, lessonFormat: "private", priceMode: "session", location: "Package redemption" },
];
const defaultAvailability = [[{ start: 990, end: 1200 }], [], [{ start: 840, end: 1200 }], [{ start: 420, end: 660 }, { start: 840, end: 990 }], [{ start: 840, end: 960 }], [], [{ start: 900, end: 1080 }]];
function env(name: string, fallback = "") { return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback; }
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } }); }
function nowIso() { return new Date().toISOString(); }
function cleanString(value: unknown, fallback = "", max = 600) { return typeof value === "string" ? value.trim().slice(0, max) : fallback; }
function cleanEmail(value: unknown, fallback = "") { return cleanString(value, fallback, 180).toLowerCase(); }
function supabaseConfig() { const url = env("SUPABASE_URL").replace(/\/$/, ""); const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY"); if (!url || !key) throw new Error("Supabase is not configured."); return { url, key }; }
async function supabase(table: string, options: { method?: string; query?: string; body?: unknown; prefer?: string } = {}) { const { url, key } = supabaseConfig(); const response = await fetch(`${url}/rest/v1/${table}${options.query ? `?${options.query}` : ""}`, { method: options.method || "GET", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(options.prefer ? { Prefer: options.prefer } : {}) }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }); const text = await response.text(); if (!response.ok) throw new Error(`Supabase ${options.method || "GET"} ${table} failed ${response.status}: ${text.slice(0, 500)}`); return text ? JSON.parse(text) : []; }
function settingMap(rows: Array<{ key: string; value: string }>) { return Object.fromEntries(rows.map((row) => [row.key, row.value])); }
function parseJsonSetting<T>(settings: Record<string, string>, key: string, fallback: T): T { try { return settings[key] ? JSON.parse(settings[key]) : fallback; } catch { return fallback; } }
function rowToItem(row: any) { return { id: row.id, kind: row.kind, week: Number(row.week ?? 0), day: Number(row.day ?? 0), start: Number(row.start ?? 0), duration: Number(row.duration ?? 0) }; }
function slotOverlaps(a: any, b: any) { return a.week === b.week && a.day === b.day && a.start < b.start + b.duration && a.start + a.duration > b.start; }
function isInsideAvailability(availability: any[], day: number, start: number, duration: number) { const end = start + duration; return availability[day]?.some((window: any) => start >= window.start && end <= window.end) ?? false; }
async function parseBody(req: Request) { const raw = await req.text(); return raw ? JSON.parse(raw) : {}; }

async function createPublicBooking(payload: any) {
  const [settingsRows, itemRows] = await Promise.all([
    supabase("settings", { query: "select=key,value" }),
    supabase("calendar_items", { query: "select=id,kind,week,day,start,duration&order=week.asc,day.asc,start.asc,id.asc" }),
  ]);
  const settings = settingMap(settingsRows);
  const services = parseJsonSetting(settings, "servicesJson", defaultServices);
  const availability = parseJsonSetting(settings, "availabilityJson", defaultAvailability);
  const items = itemRows.map(rowToItem);
  const service = services.find((candidate: any) => candidate?.id === payload?.serviceId && candidate?.active && candidate?.visibility === "public");
  if (!service) throw Object.assign(new Error("Choose a public lesson type."), { status: 400 });
  const week = Number(payload.week ?? 0), day = Number(payload.day), start = Number(payload.start);
  const firstName = cleanString(payload.firstName, "", 80), lastName = cleanString(payload.lastName, "", 80);
  const email = cleanEmail(payload.email, ""), phone = cleanString(payload.phone, "", 80);
  if (!firstName || !lastName || !email) throw Object.assign(new Error("First name, last name, and email are required."), { status: 400 });
  if (!Number.isInteger(week) || !Number.isInteger(day) || !Number.isInteger(start) || day < 0 || day > 6) throw Object.assign(new Error("Choose a valid appointment time."), { status: 400 });
  const slot = { week, day, start, duration: Number(service.duration || 30) };
  if (!isInsideAvailability(availability, day, start, slot.duration) || items.some((item: any) => slotOverlaps(item, slot))) throw Object.assign(new Error("That time is no longer available."), { status: 409 });

  const client = `${firstName} ${lastName}`.trim();
  const id = `appt-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const appointment = {
    id,
    kind: "appointment",
    ...slot,
    serviceId: service.id,
    client,
    title: client,
    phone,
    email,
    note: "Booked from public booking page.",
    status: "booked",
  };
  const row = {
    id,
    kind: "appointment",
    ...slot,
    service_id: service.id,
    client,
    title: client,
    phone: phone || null,
    email,
    note: appointment.note,
    status: "booked",
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  // The calendar item is authoritative. Client-directory sync and email are
  // secondary jobs and must never roll back a valid booking.
  await supabase("calendar_items", { method: "POST", query: "on_conflict=id", prefer: "resolution=merge-duplicates,return=minimal", body: [row] });

  const personIdentity = `${client.toLowerCase().replace(/\s+/g, " ")}|${email}|${phone.replace(/\D/g, "")}`;
  const personId = `person-${createHash("sha256").update(personIdentity).digest("hex").slice(0, 32)}`;
  try {
    await supabase("people", {
      method: "POST",
      query: "on_conflict=id",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: [{
        id: personId,
        name: client,
        email,
        phone: phone || null,
        notes: row.note,
        source: "appointment",
        caddy_profile_id: null,
        caddy_profile_url: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      }],
    });
  } catch (error) {
    console.warn("public_booking:client_sync_skipped", error);
  }

  await supabase("settings", { method: "POST", query: "on_conflict=key", prefer: "resolution=merge-duplicates,return=minimal", body: [{ key: "updatedAt", value: nowIso(), updated_at: nowIso() }] });
  await syncGoogleCalendarIfEnabled().catch((error) => console.error("public_booking:google_calendar_sync_failed", error));

  let notifications: any[] = [];
  try {
    notifications = await notifyBookingEvent({ action: "booking", appointment, source: "public-booking" });
  } catch (error) {
    console.error("public_booking:notification_failed", error);
  }

  return { appointment, notifications };
}

export default async function handler(req: Request) {
  try {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const result = await createPublicBooking(await parseBody(req));
    return json({
      ok: true,
      appointment: {
        id: result.appointment.id,
        week: result.appointment.week,
        day: result.appointment.day,
        start: result.appointment.start,
        duration: result.appointment.duration,
      },
      notifications: result.notifications.filter((notification: any) => notification?.channel === "client"),
    });
  } catch (error: any) {
    console.error("public_booking:failed", error);
    const status = error?.status || 500;
    return json({ error: status === 500 ? "public_booking_error" : "request_error", message: error instanceof Error ? error.message : "Unknown public booking error" }, status);
  }
}
export const config: Config = { path: "/api/public-booking" };
