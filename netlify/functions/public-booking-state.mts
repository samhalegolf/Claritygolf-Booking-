import type { Config } from "@netlify/functions";
import { randomUUID } from "node:crypto";

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
function supabaseConfig() { const url = env("SUPABASE_URL").replace(/\/$/, ""); const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY"); if (!url || !key) throw new Error("Supabase is not configured."); return { url, key }; }
async function supabase(table: string, options: { method?: string; query?: string; body?: unknown; prefer?: string } = {}) { const { url, key } = supabaseConfig(); const response = await fetch(`${url}/rest/v1/${table}${options.query ? `?${options.query}` : ""}`, { method: options.method || "GET", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(options.prefer ? { Prefer: options.prefer } : {}) }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }); const text = await response.text(); if (!response.ok) throw new Error(`Supabase ${options.method || "GET"} ${table} failed ${response.status}: ${text.slice(0, 500)}`); return text ? JSON.parse(text) : []; }
function settingMap(rows: Array<{ key: string; value: string }>) { return Object.fromEntries(rows.map((row) => [row.key, row.value])); }
function parseJsonSetting<T>(settings: Record<string, string>, key: string, fallback: T): T { try { return settings[key] ? JSON.parse(settings[key]) : fallback; } catch { return fallback; } }
function rowToPublicItem(row: any) { return { id: row.id, kind: row.kind, week: Number(row.week ?? 0), day: Number(row.day ?? 0), start: Number(row.start ?? 0), duration: Number(row.duration ?? 0) }; }
async function setSetting(key: string, value: unknown) { await supabase("settings", { method: "POST", query: "on_conflict=key", prefer: "resolution=merge-duplicates,return=minimal", body: [{ key, value: String(value ?? ""), updated_at: nowIso() }] }); }

async function readPublicBookingState() {
  const [settingsRows, itemRows] = await Promise.all([
    supabase("settings", { query: "select=key,value" }),
    supabase("calendar_items", { query: "select=id,kind,week,day,start,duration&order=week.asc,day.asc,start.asc,id.asc" }),
  ]);
  const settings = settingMap(settingsRows);
  if (!settings.syncKey) await setSetting("syncKey", env("CLARITY_CALENDAR_SYNC_KEY") || `cg_${randomUUID().replaceAll("-", "")}`);
  const services = parseJsonSetting(settings, "servicesJson", defaultServices);
  return {
    updatedAt: settings.updatedAt || nowIso(),
    services: (services || []).filter((service: any) => service?.active && service?.visibility === "public"),
    availability: parseJsonSetting(settings, "availabilityJson", defaultAvailability),
    brand: {
      logoName: settings.brandLogoName || "",
      logoPreview: settings.brandLogoPreview || "",
      neutral: settings.brandNeutral || "#ffffff",
      primary: settings.brandPrimary || "#1fd36d",
      secondary: settings.brandSecondary || "#d7b06b",
      accent: settings.brandAccent || "#07100a",
      bookingTheme: settings.brandBookingTheme || "dark",
    },
    account: {
      id: settings.accountId || "sam-hale-golf",
      coachName: settings.accountCoachName || env("CLARITY_COACH_NAME", "Sam Hale"),
      businessName: settings.accountBusinessName || env("CLARITY_BUSINESS_NAME", "Sam Hale Golf"),
      venueName: settings.accountVenueName || env("CLARITY_VENUE_NAME", "The Range 24/7 - Three Kings"),
      venueShortName: settings.accountVenueShortName || env("CLARITY_VENUE_SHORT_NAME", "The Range 24/7"),
      timezone: settings.accountTimezone || env("CLARITY_TIMEZONE", "Pacific/Auckland"),
      contactEmail: settings.accountContactEmail || env("CLARITY_CONTACT_EMAIL", ""),
      bookingUrl: settings.accountBookingUrl || env("CLARITY_BOOKING_URL", "https://book.claritygolf.app"),
      calendarSlug: settings.accountCalendarSlug || "sam-hale-golf",
      caddyWorkspaceUrl: settings.accountCaddyWorkspaceUrl || env("CLARITY_CADDY_WORKSPACE_URL", "https://caddy.claritygolf.app"),
    },
    items: itemRows.map(rowToPublicItem),
  };
}

export default async function handler(req: Request) {
  try {
    const debug = new URL(req.url).searchParams.get("debug");
    if (debug === "ping") return json({ ok: true, function: "public-booking-state" });
    if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    return json(await readPublicBookingState());
  } catch (error) {
    console.error("public_booking_state:failed", error);
    return json({ error: "public_booking_state_error", message: error instanceof Error ? error.message : "Public booking state failed." }, 500);
  }
}
export const config: Config = { path: "/api/public-booking-state" };
