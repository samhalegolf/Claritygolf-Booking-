import type { Config } from "@netlify/functions";

import { syncGoogleCalendarIfEnabled } from "./google-calendar-sync.mts";
import { notifyBookingEvent } from "./notification-engine.mts";

function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function cleanString(value: unknown, fallback = "", max = 500) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : fallback;
}

function normalizeContact(value: unknown) {
  return cleanString(value, "", 180)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function parseBody(req: Request) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function supabaseConfig() {
  const url = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
  if (!url || !key) throw new Error("Supabase is not configured.");
  return { url, key };
}

async function supabase(
  table: string,
  options: {
    method?: string;
    query?: string;
    body?: unknown;
    prefer?: string;
  } = {},
) {
  const { url, key } = supabaseConfig();
  const response = await fetch(
    `${url}/rest/v1/${table}${options.query ? `?${options.query}` : ""}`,
    {
      method: options.method || "GET",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(options.prefer ? { Prefer: options.prefer } : {}),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Supabase ${options.method || "GET"} ${table} failed ${response.status}: ${text.slice(0, 500)}`,
    );
  }
  return text ? JSON.parse(text) : [];
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
    client: row.client || row.title || "Client",
    title: row.title || row.client || "Booking",
    phone: row.phone || "",
    email: row.email || "",
    note: row.note || "",
    status:
      row.status === "completed" ||
      row.status === "cancelled" ||
      row.status === "no_show"
        ? row.status
        : "booked",
  };
}

async function cancelPublicBooking(payload: any) {
  const appointmentId = cleanString(payload?.appointmentId, "", 140);
  const email = normalizeContact(payload?.email);
  const phone = normalizeContact(payload?.phone);

  if (!appointmentId || !email || !phone) {
    throw Object.assign(new Error("Choose the booking to cancel."), {
      status: 400,
    });
  }

  const rows = await supabase("calendar_items", {
    query: `select=*&id=eq.${encodeURIComponent(appointmentId)}&limit=1`,
  });
  const row = rows[0];
  if (
    !row ||
    row.kind !== "appointment" ||
    normalizeContact(row.email) !== email ||
    normalizeContact(row.phone) !== phone
  ) {
    throw Object.assign(new Error("That booking could not be verified."), {
      status: 404,
    });
  }

  const appointment = rowToItem(row);

  // The booking deletion is authoritative. Settings, Google Calendar and
  // notification updates are secondary and must not turn a completed
  // cancellation into a misleading failure response.
  await supabase("calendar_items", {
    method: "DELETE",
    query: `id=eq.${encodeURIComponent(appointmentId)}`,
    prefer: "return=minimal",
  });

  await supabase("settings", {
    method: "POST",
    query: "on_conflict=key",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: [{ key: "updatedAt", value: nowIso(), updated_at: nowIso() }],
  }).catch((error) => console.error("public_cancel:updated_at_failed", error));

  await syncGoogleCalendarIfEnabled().catch((error) =>
    console.error("public_cancel:google_calendar_sync_failed", error),
  );

  let notifications: any[] = [];
  try {
    notifications = await notifyBookingEvent({
      action: "cancelled",
      appointment,
      previousAppointment: appointment,
      source: "public-cancel",
    });
  } catch (error) {
    console.error("public_cancel:notification_failed", error);
  }

  let stateItems: any[] | null = null;
  try {
    const remainingRows = await supabase("calendar_items", {
      query: "select=*&order=week.asc,day.asc,start.asc,id.asc",
    });
    stateItems = remainingRows.map(rowToItem);
  } catch (error) {
    console.error("public_cancel:state_refresh_failed", error);
  }

  return { appointment, notifications, stateItems };
}

export default async function handler(req: Request) {
  try {
    if (req.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }

    const result = await cancelPublicBooking(await parseBody(req));
    return json({
      ok: true,
      appointment: {
        id: result.appointment.id,
        week: result.appointment.week,
        day: result.appointment.day,
        start: result.appointment.start,
        duration: result.appointment.duration,
      },
      ...(result.stateItems ? { state: { items: result.stateItems } } : {}),
      notifications: result.notifications.filter((notification: any) => notification?.channel === "client"),
    });
  } catch (error: any) {
    console.error("public_cancel:failed", error);
    const status = error?.status || 500;
    return json(
      {
        error: status === 500 ? "public_cancel_error" : "request_error",
        message:
          error instanceof Error
            ? error.message
            : "Unknown public cancellation error",
      },
      status,
    );
  }
}

export const config: Config = {
  path: "/api/public-cancel",
};
