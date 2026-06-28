import type { Config } from "@netlify/functions";

const baseWeekStart = new Date(Date.UTC(2026, 5, 1));

function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function cleanText(value: unknown, fallback = "", max = 700) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;
}

function cleanEmail(value: unknown, fallback = "") {
  const email = cleanText(value, "", 180).toLowerCase();
  return email.includes("@") ? email : fallback;
}

function cleanUrl(value: unknown, fallback = "") {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString().replace(/\/$/, "") : fallback;
  } catch {
    return fallback;
  }
}

function cleanBookingLocationSnapshot(raw: any, fallback: any = {}) {
  let source = raw;
  if (typeof raw === "string") {
    try {
      source = JSON.parse(raw);
    } catch {
      source = null;
    }
  }
  const base = source?.name ? source : fallback;
  if (!base?.name) return null;
  return {
    name: cleanText(base.name, fallback.name || "", 140),
    shortName: cleanText(base.shortName, fallback.shortName || base.name || "", 80),
    address: cleanText(base.address, "", 240),
    mapUrl: cleanUrl(base.mapUrl, ""),
    arrivalInstructions: cleanText(base.arrivalInstructions, "", 500),
    publicNotes: cleanText(base.publicNotes, "", 500),
    timezone: cleanText(base.timezone, fallback.timezone || "", 80),
  };
}

function bookingLocationDisplay(location: any) {
  return [location?.name, location?.address].filter(Boolean).join(" · ");
}

function normalizePhone(value: unknown) {
  return cleanText(value, "", 80).replace(/\D/g, "");
}

function supabaseConfig() {
  const url = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
  if (!url || !key) throw new Error("Supabase is not configured.");
  return { url, key };
}

async function supabase(table: string, query: string) {
  const { url, key } = supabaseConfig();
  const response = await fetch(`${url}/rest/v1/${table}?${query}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase GET ${table} failed ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : [];
}

async function readSettings() {
  const rows = await supabase("settings", "select=key,value");
  const settings = Object.fromEntries(rows.map((row: any) => [row.key, row.value]));
  let services: any[] = [];
  try {
    services = settings.servicesJson ? JSON.parse(settings.servicesJson) : [];
  } catch {
    services = [];
  }
  return {
    services,
    businessName: settings.accountBusinessName || env("CLARITY_BUSINESS_NAME", "Sam Hale Golf"),
    coachName: settings.accountCoachName || env("CLARITY_COACH_NAME", "Sam Hale"),
    venueName: settings.accountVenueName || env("CLARITY_VENUE_NAME", "The Range 24/7 - Three Kings"),
    timezone: settings.accountTimezone || env("CLARITY_TIMEZONE", "Pacific/Auckland"),
    contactEmail: cleanEmail(settings.accountContactEmail, env("CLARITY_CONTACT_EMAIL", "")),
    bookingUrl: settings.accountBookingUrl || env("CLARITY_BOOKING_URL", "https://book.claritygolf.app"),
  };
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function slotDate(week = 0, day = 0) {
  const date = new Date(baseWeekStart);
  date.setUTCDate(baseWeekStart.getUTCDate() + Number(week || 0) * 7 + Number(day || 0));
  return date;
}

function formatLocalDateTime(week = 0, day = 0, minutes = 0) {
  const date = slotDate(week, day);
  const hour = Math.floor(Number(minutes || 0) / 60);
  const minute = Number(minutes || 0) % 60;
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(hour)}${pad(minute)}00`;
}

function formatUtcStamp(date = new Date()) {
  return date.toISOString().replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}Z$/, "Z");
}

function escapeIcs(value: unknown) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function foldLine(line: string) {
  const chunks: string[] = [];
  let remaining = line;
  while (remaining.length > 75) {
    chunks.push(remaining.slice(0, 75));
    remaining = remaining.slice(75);
  }
  chunks.push(remaining);
  return chunks.join("\r\n ");
}

function manageUrl(appointment: any, settings: any) {
  try {
    const url = new URL(settings.bookingUrl || "https://book.claritygolf.app");
    url.searchParams.set("embed", "booking");
    url.searchParams.set("mode", "reschedule");
    url.searchParams.set("booking", appointment.id);
    if (appointment.email) url.searchParams.set("email", appointment.email);
    if (appointment.phone) url.searchParams.set("phone", appointment.phone);
    return url.toString();
  } catch {
    return "";
  }
}

function generateInvite(appointment: any, settings: any) {
  const service = settings.services.find((candidate: any) => candidate.id === appointment.service_id);
  const serviceName = cleanText(service?.name, "Golf Lesson", 160);
  const client = cleanText(appointment.client || appointment.title, "Client", 160);
  const location = cleanBookingLocationSnapshot(appointment.location, {
    name: settings.venueName,
    timezone: settings.timezone,
  });
  const manage = manageUrl(appointment, settings);
  const description = [
    `${serviceName} for ${client}.`,
    location?.address ? `Address: ${location.address}` : "",
    location?.arrivalInstructions ? `Arrival: ${location.arrivalInstructions}` : "",
    location?.mapUrl ? `Map: ${location.mapUrl}` : "",
    manage ? `Manage / Reschedule: ${manage}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Clarity Golf//Booking Invite//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-TIMEZONE:${escapeIcs(settings.timezone)}`,
    "BEGIN:VEVENT",
    `UID:${escapeIcs(appointment.id)}@claritygolf.app`,
    `DTSTAMP:${formatUtcStamp()}`,
    `DTSTART;TZID=${escapeIcs(settings.timezone)}:${formatLocalDateTime(appointment.week, appointment.day, appointment.start)}`,
    `DTEND;TZID=${escapeIcs(settings.timezone)}:${formatLocalDateTime(appointment.week, appointment.day, Number(appointment.start || 0) + Number(appointment.duration || 0))}`,
    `SUMMARY:${escapeIcs(`${serviceName} with ${settings.coachName || settings.businessName}`)}`,
    `DESCRIPTION:${escapeIcs(description)}`,
    `LOCATION:${escapeIcs(bookingLocationDisplay(location))}`,
    settings.contactEmail ? `ORGANIZER;CN=${escapeIcs(settings.businessName)}:MAILTO:${escapeIcs(settings.contactEmail)}` : "",
    manage ? `URL:${escapeIcs(manage)}` : "",
    "CATEGORIES:Golf Lesson",
    "STATUS:CONFIRMED",
    "TRANSP:OPAQUE",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean);
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export default async function handler(req: Request) {
  try {
    if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    const url = new URL(req.url);
    const bookingId = cleanText(url.searchParams.get("booking"), "", 160);
    const email = cleanEmail(url.searchParams.get("email"), "");
    const phone = normalizePhone(url.searchParams.get("phone"));
    if (!bookingId || (!email && !phone)) {
      return json({ error: "invalid_invite", message: "Booking verification is required." }, 400);
    }

    const rows = await supabase(
      "calendar_items",
      `select=*&id=eq.${encodeURIComponent(bookingId)}&limit=1`,
    );
    const appointment = rows[0];
    if (!appointment || appointment.kind !== "appointment") {
      return json({ error: "not_found", message: "Booking not found." }, 404);
    }

    const emailMatches = email && cleanEmail(appointment.email, "") === email;
    const phoneMatches = phone && normalizePhone(appointment.phone) === phone;
    if (!emailMatches && !phoneMatches) {
      return json({ error: "not_found", message: "Booking could not be verified." }, 404);
    }

    const settings = await readSettings();
    const ics = generateInvite(appointment, settings);
    return new Response(ics, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'attachment; filename="clarity-golf-booking.ics"',
        "Cache-Control": "private, no-store, max-age=0",
      },
    });
  } catch (error) {
    console.error("public_calendar_invite:failed", error);
    return json(
      {
        error: "public_calendar_invite_error",
        message: error instanceof Error ? error.message : "Calendar invite could not be created.",
      },
      500,
    );
  }
}

export const config: Config = {
  path: "/api/public-calendar-invite",
};
