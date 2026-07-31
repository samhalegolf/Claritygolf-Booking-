import { getDatabase } from "@netlify/database";
import type { Config } from "@netlify/functions";

const SESSION_COOKIE = "clarity_session";
const BAY_NAMES: Record<string, string> = {
  "600009": "Bay #1",
  "600004": "Bay #2",
  "600005": "Bay #3",
  "600006": "Bay #4",
  "600007": "Bay #5",
  "600008": "Bay #6",
  "600010": "Bay #7",
};

function db() {
  return getDatabase();
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function parseCookies(req: Request) {
  return Object.fromEntries(
    (req.headers.get("cookie") || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index < 0
          ? [decodeURIComponent(part), ""]
          : [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

async function requireAdmin(req: Request) {
  const token = parseCookies(req)[SESSION_COOKIE] || "";
  if (!token) return false;
  const { createHash } = await import("node:crypto");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const rows = await db().sql`
    SELECT id
    FROM admin_sessions
    WHERE token_hash = ${tokenHash}
      AND expires_at > NOW()
    LIMIT 1
  `;
  return rows.length > 0;
}

async function ensureTable() {
  await db().sql`
    CREATE TABLE IF NOT EXISTS optix_booking_sync (
      calendar_item_id TEXT PRIMARY KEY,
      optix_booking_id TEXT,
      optix_booking_session_id TEXT,
      resource_id TEXT,
      start_timestamp BIGINT,
      end_timestamp BIGINT,
      fingerprint TEXT,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      error_code TEXT,
      error_message TEXT,
      last_attempted_at TIMESTAMPTZ,
      last_synced_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

export default async function handler(req: Request) {
  if (!(await requireAdmin(req))) return json({ error: "unauthorized" }, 401);
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  await ensureTable();
  const rows = await db().sql`
    SELECT
      c.id,
      c.client,
      c.title,
      c.service_id,
      c.week,
      c.day,
      c.start,
      c.duration,
      s.optix_booking_id,
      s.optix_booking_session_id,
      s.resource_id,
      s.sync_status,
      s.error_code,
      s.error_message,
      s.last_attempted_at,
      s.last_synced_at,
      s.updated_at
    FROM calendar_items c
    LEFT JOIN optix_booking_sync s ON s.calendar_item_id = c.id
    WHERE c.kind = 'appointment'
    ORDER BY COALESCE(s.updated_at, c.updated_at) DESC
    LIMIT 100
  `;

  return json({
    records: rows.map((row: any) => ({
      calendarItemId: String(row.id || ""),
      client: String(row.client || ""),
      title: String(row.title || ""),
      serviceId: String(row.service_id || ""),
      week: Number(row.week || 0),
      day: Number(row.day || 0),
      start: Number(row.start || 0),
      duration: Number(row.duration || 0),
      optixBookingId: String(row.optix_booking_id || ""),
      optixBookingSessionId: String(row.optix_booking_session_id || ""),
      resourceId: String(row.resource_id || ""),
      bayName: BAY_NAMES[String(row.resource_id || "")] || "",
      syncStatus: String(row.sync_status || "pending"),
      errorCode: String(row.error_code || ""),
      errorMessage: String(row.error_message || ""),
      lastAttemptedAt: row.last_attempted_at || null,
      lastSyncedAt: row.last_synced_at || null,
      updatedAt: row.updated_at || null,
    })),
  });
}

export const config: Config = { path: "/api/optix-booking-status" };
