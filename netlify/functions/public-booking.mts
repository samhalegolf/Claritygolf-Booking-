import type { Config } from "@netlify/functions";
import { randomUUID } from "node:crypto";

import { notifyBookingEvent } from "./notification-engine.mts";

const defaultServices = [
  { id: "lesson-30", name: "30min Lesson", duration: 30, visibility: "public", active: true },
  { id: "lesson-60", name: "1 Hour Golf Lesson", duration: 60, visibility: "public", active: true },
];

const defaultAvailability = [
  [{ start: 990, end: 1200 }],
  [],
  [{ start: 840, end: 1200 }],
  [{ start: 420, end: 660 }, { start: 840, end: 990 }],
  [{ start: 840, end: 960 }],
  [],
  [{ start: 900, end: 1080 }],
];

function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function cleanText(value: unknown, fallback = "", max = 800) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;
}

function cleanEmail(value: unknown, fallback = "") {
  const email = cleanText(value, "", 180).toLowerCase();
  return email.includes("@") ? email : fallback;
}

function supabaseConfig() {
  const url = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
  if (!url || !key) throw new Error("Supabase is not configured for public booking.");
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

function parseJson(value: unknown, fallback: any) {
  try {
    return typeof value === "string" && value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function settingMap(rows: Array<{ key: string; value: string }>) {
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function rowToItem(row: any) {
  return {
    id: row.id,
    kind: row.kind,
    week: Number(row.week ?? 0),
    day: Number(row.day ?? 0),
    start: Number(row.start ?? 0),
    duration: Number(row.duration ?? 0),
    serviceId: row.service_id || "",
    client: row.client || "",
    title: row.title || row.client || "Booking",
    phone: row.phone || "",
    email: row.email || "",
    note: row.note || "",
  };
}

function itemRow(item: any) {
  return {
    id: cleanText(item.id, `appt-${Date.now()}`, 140),
    kind: "appointment",
    week: Number(item.week ?? 0),
    day: Number(item.day ?? 0),
    start: Number(item.start ?? 0),
    duration: Number(item.duration ?? 30),
    service_id: cleanText(item.serviceId, "", 140) || null,
    client: cleanText(item.client, "", 160) || null,
    title: cleanText(item.title, item.client || "Booking", 160),
    phone: cleanText(item.phone, "", 80) || null,
    email: cleanEmail(item.email, "") || null,
    note: cleanText(item.note, "", 1200) || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

async function readBookingState() {
  const [settingsRows, itemRows] = await Promise.all([
    supabase("settings", { query: "select=key,value" }),
    supabase("calendar_items", { query: "select=*&order=week.asc,day.asc,start.asc,id.asc" }),
  ]);
  const settings = settingMap(settingsRows);
  return {
    services: parseJson(settings.servicesJson, defaultServices),
    availability: parseJson(settings.availabilityJson, defaultAvailability),
    items: itemRows.map(rowToItem),
  };
}

function overlaps(a: any, b: any) {
  return a.week === b.week && a.day === b.day && a.start < b.start + b.duration && a.start + a.duration > b.start;
}

function isInsideAvailability(availability: any[][], day: number, start: number, duration: number) {
  const end = start + duration;
  return (availability[day] || []).some((window) => start >= Number(window.start) && end <= Number(window.end));
}

async function setUpdatedAt() {
  await supabase("settings", {
    method: "POST",
    query: "on_conflict=key",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: [{ key: "updatedAt", value: new Date().toISOString(), updated_at: new Date().toISOString() }],
  });
}

async function upsertPerson(appointment: any) {
  if (!appointment.email && !appointment.phone && !appointment.client) return;
  const id = appointment.email ? `email-${Buffer.from(appointment.email).toString("base64url")}` : `person-${randomUUID()}`;
  await supabase("people", {
    method: "POST",
    query: "on_conflict=id",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: [{
      id,
      name: appointment.client || appointment.email || appointment.phone || "Client",
      email: appointment.email || null,
      phone: appointment.phone || null,
      notes: appointment.note || null,
      source: "appointment",
      caddy_profile_id: null,
      caddy_profile_url: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }],
  }).catch((error) => console.error("public_booking:person_upsert_failed", error));
}

async function createPublicBooking(payload: any) {
  const state = await readBookingState();
  const service = state.services.find((candidate: any) => candidate.id === payload?.serviceId && candidate.active && candidate.visibility === "public");
  if (!service) throw Object.assign(new Error("Choose a public lesson type."), { status: 400 });

  const week = Number(payload.week ?? 0);
  const day = Number(payload.day);
  const start = Number(payload.start);
  const firstName = cleanText(payload.firstName, "", 80);
  const lastName = cleanText(payload.lastName, "", 80);
  const email = cleanEmail(payload.email, "");
  const phone = cleanText(payload.phone, "", 80);
  if (!firstName || !lastName || !email) throw Object.assign(new Error("First name, last name, and email are required."), { status: 400 });
  if (!Number.isInteger(week) || !Number.isInteger(day) || !Number.isInteger(start) || day < 0 || day > 6) throw Object.assign(new Error("Choose a valid appointment time."), { status: 400 });

  const slot = { week, day, start, duration: Number(service.duration || 30) };
  if (!isInsideAvailability(state.availability, day, start, slot.duration) || state.items.some((item) => overlaps(item, slot))) {
    throw Object.assign(new Error("That time is no longer available."), { status: 409 });
  }

  const client = `${firstName} ${lastName}`.trim();
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

  await supabase("calendar_items", {
    method: "POST",
    query: "on_conflict=id",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: [itemRow(appointment)],
  });
  await Promise.all([setUpdatedAt(), upsertPerson(appointment)]);
  const notifications = await notifyBookingEvent({ action: "booking", appointment, source: "public-booking" });
  return { appointment, notifications };
}

export default async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const result = await createPublicBooking(await req.json().catch(() => ({})));
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
    const status = (error as any)?.status || 500;
    return json({ error: status === 500 ? "public_booking_error" : "request_error", message: error instanceof Error ? error.message : "Unknown public booking error" }, status);
  }
};

export const config: Config = {
  path: "/api/public-booking",
};
