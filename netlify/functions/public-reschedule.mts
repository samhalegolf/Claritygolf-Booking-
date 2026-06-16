import type { Config } from "@netlify/functions";

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

function normaliseContact(value: unknown) {
  return cleanText(value, "", 180).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function supabaseConfig() {
  const url = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
  if (!url || !key) throw new Error("Supabase is not configured for public reschedule.");
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

function rowToAppointment(row: any) {
  if (!row) return null;
  return {
    id: cleanText(row.id, "", 160),
    kind: row.kind || "appointment",
    week: Number(row.week ?? 0),
    day: Number(row.day ?? 0),
    start: Number(row.start ?? 0),
    duration: Number(row.duration ?? 30),
    serviceId: cleanText(row.service_id, "", 160),
    client: cleanText(row.client || row.title, "Client", 160),
    title: cleanText(row.title || row.client, "Client", 160),
    phone: cleanText(row.phone, "", 80),
    email: cleanEmail(row.email, ""),
    note: cleanText(row.note, "", 1200),
  };
}

function appointmentRow(item: any) {
  return {
    id: cleanText(item.id, "", 140),
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
    updated_at: new Date().toISOString(),
  };
}

async function readState() {
  const [settingsRows, itemRows] = await Promise.all([
    supabase("settings", { query: "select=key,value" }),
    supabase("calendar_items", { query: "select=*&order=week.asc,day.asc,start.asc,id.asc" }),
  ]);
  const settings = settingMap(settingsRows);
  return {
    services: parseJson(settings.servicesJson, defaultServices),
    availability: parseJson(settings.availabilityJson, defaultAvailability),
    items: itemRows.map(rowToAppointment).filter(Boolean),
  };
}

function overlaps(a: any, b: any) {
  return a.week === b.week && a.day === b.day && a.start < b.start + b.duration && a.start + a.duration > b.start;
}

function isInsideAvailability(availability: any[][], day: number, start: number, duration: number) {
  const end = start + duration;
  return (availability[day] || []).some((window) => start >= Number(window.start) && end <= Number(window.end));
}

function matchesContact(item: any, email: string, phone: string) {
  if (!item || item.kind !== "appointment") return false;
  return Boolean(
    normaliseContact(item.email) &&
      normaliseContact(item.phone) &&
      normaliseContact(item.email) === email &&
      normaliseContact(item.phone) === phone,
  );
}

async function setUpdatedAt() {
  await supabase("settings", {
    method: "POST",
    query: "on_conflict=key",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: [{ key: "updatedAt", value: new Date().toISOString(), updated_at: new Date().toISOString() }],
  });
}

async function reschedulePublicBooking(payload: any) {
  const appointmentId = cleanText(payload.appointmentId, "", 160);
  const email = normaliseContact(payload.email);
  const phone = normaliseContact(payload.phone);
  const week = Number(payload.week ?? 0);
  const day = Number(payload.day);
  const start = Number(payload.start);
  if (!appointmentId || !email || !phone) throw Object.assign(new Error("Choose the booking to reschedule."), { status: 400 });
  if (!Number.isInteger(week) || !Number.isInteger(day) || !Number.isInteger(start) || day < 0 || day > 6) throw Object.assign(new Error("Choose a valid new appointment time."), { status: 400 });

  const state = await readState();
  const previousAppointment = state.items.find((item: any) => item.id === appointmentId);
  if (!previousAppointment || !matchesContact(previousAppointment, email, phone)) {
    throw Object.assign(new Error("That booking could not be verified."), { status: 404 });
  }

  const service = state.services.find((candidate: any) => candidate.id === previousAppointment.serviceId);
  const duration = Number(service?.duration || previousAppointment.duration || 30);
  const candidate = { week, day, start, duration };
  const itemsWithoutOriginal = state.items.filter((item: any) => item.id !== previousAppointment.id);
  if (!isInsideAvailability(state.availability, day, start, duration) || itemsWithoutOriginal.some((item: any) => overlaps(item, candidate))) {
    throw Object.assign(new Error("That time is no longer available."), { status: 409 });
  }

  const appointment = {
    ...previousAppointment,
    ...candidate,
    note: previousAppointment.note || "Rescheduled from public booking page.",
  };

  await supabase("calendar_items", {
    method: "POST",
    query: "on_conflict=id",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: [appointmentRow(appointment)],
  });
  await setUpdatedAt();
  const notifications = await notifyBookingEvent({
    action: "rescheduled",
    appointment,
    previousAppointment,
    source: "public-reschedule",
  });
  return { appointment, previousAppointment, notifications };
}

export default async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const result = await reschedulePublicBooking(await req.json().catch(() => ({})));
    return json({
      ok: true,
      appointment: {
        id: result.appointment.id,
        week: result.appointment.week,
        day: result.appointment.day,
        start: result.appointment.start,
        duration: result.appointment.duration,
      },
      previousAppointment: result.previousAppointment,
      notifications: result.notifications,
    });
  } catch (error) {
    console.error("public_reschedule:failed", error);
    const status = (error as any)?.status || 500;
    return json({ error: status === 500 ? "public_reschedule_error" : "request_error", message: error instanceof Error ? error.message : "Unknown public reschedule error" }, status);
  }
};

export const config: Config = {
  path: "/api/public-reschedule",
};
