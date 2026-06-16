import type { Config, Context } from "@netlify/functions";

import { handlePublicRescheduleRequest } from "./booking-core.mts";
import { notifyBookingEvent } from "./notification-engine.mts";

function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
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
  if (!url || !key) throw new Error("Supabase is not configured for public reschedule notifications.");
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

function rowToAppointment(row: any, fallback: any = {}) {
  if (!row) return null;
  return {
    id: cleanText(row.id, cleanText(fallback.appointmentId, "", 160), 160),
    kind: "appointment",
    week: Number(row.week ?? fallback.previousWeek ?? fallback.week ?? 0),
    day: Number(row.day ?? fallback.previousDay ?? fallback.day ?? 0),
    start: Number(row.start ?? fallback.previousStart ?? fallback.start ?? 0),
    duration: Number(row.duration ?? fallback.previousDuration ?? fallback.duration ?? 30),
    serviceId: cleanText(row.service_id || fallback.serviceId, "", 160),
    client: cleanText(row.client || row.title || fallback.client || fallback.name, "Client", 160),
    title: cleanText(row.title || row.client || fallback.client || fallback.name, "Client", 160),
    phone: cleanText(row.phone || fallback.phone, "", 80),
    email: cleanEmail(row.email || fallback.email, ""),
    note: cleanText(row.note || fallback.note, "", 1200),
  };
}

async function readExistingAppointment(appointmentId: string, fallback: any = {}) {
  if (!appointmentId) return null;
  const rows = await supabase("calendar_items", {
    query: `select=*&id=eq.${encodeURIComponent(appointmentId)}&limit=1`,
  }).catch((error) => {
    console.error("public_reschedule:previous_lookup_failed", error);
    return [];
  });
  return rowToAppointment(rows[0], fallback);
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export default async (req: Request, context: Context) => {
  const body = req.method === "POST" ? await req.clone().json().catch(() => ({})) : {};
  const appointmentId = cleanText(body.appointmentId, "", 160);
  const previousAppointment = req.method === "POST" ? await readExistingAppointment(appointmentId, body) : null;

  const response = await handlePublicRescheduleRequest(req, context);
  if (req.method !== "POST" || !response.ok) return response;

  try {
    const result = await response.clone().json();
    const appointment = {
      ...(previousAppointment || {}),
      ...result.appointment,
      id: cleanText(result.appointment?.id, appointmentId, 160),
      serviceId: cleanText(result.appointment?.serviceId || body.serviceId || previousAppointment?.serviceId, "", 160),
      client: cleanText(body.client || body.name || previousAppointment?.client, "Client", 160),
      title: cleanText(body.client || body.name || previousAppointment?.title, "Client", 160),
      email: cleanEmail(body.email || previousAppointment?.email, ""),
      phone: cleanText(body.phone || previousAppointment?.phone, "", 80),
    };

    const task = notifyBookingEvent({
      action: "rescheduled",
      appointment,
      previousAppointment: previousAppointment || undefined,
      source: "public-reschedule",
    });
    const notifications = context?.waitUntil ? await task : await task;
    console.log("public_reschedule:notifications", JSON.stringify(notifications));

    return json({
      ...result,
      appointment,
      previousAppointment,
      notifications,
    });
  } catch (error) {
    console.error("public_reschedule:notification_failed", error);
    return response;
  }
};

export const config: Config = {
  path: "/api/public-reschedule",
};
