import { createHash } from "node:crypto";
import { getDatabase } from "@netlify/database";
import type { Config } from "@netlify/functions";

import {
  readOptixReconcileConfig,
  type ClarityOptixAppointment,
  type OptixSyncRecord,
} from "./_shared/optix-reconcile.mts";
import { reconcileOptixAppointmentWithAutoSelect } from "./_shared/optix-auto-select.mts";
import { notifyBookingEvent } from "./notification-engine.mts";

const SESSION_COOKIE = "clarity_session";
const OVERALL_TIMEOUT_MS = 25_000;

function env(name: string): string {
  return (globalThis.Netlify?.env?.get(name) || process.env[name] || "").trim();
}

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

async function ensureOptixSyncTable() {
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

function rowToAppointment(row: any): ClarityOptixAppointment {
  return {
    id: String(row.id || ""),
    kind: row.kind || "",
    week: Number(row.week || 0),
    day: Number(row.day || 0),
    start: Number(row.start || 0),
    duration: Number(row.duration || 0),
    title: row.title || "",
    client: row.client || "",
    note: row.note || "",
    serviceId: row.service_id || "",
    locationId: row.location_id || "",
    location: row.location && typeof row.location === "object" ? row.location : null,
    status: row.status || "booked",
    email: row.email || "",
    phone: row.phone || "",
    coachId: row.coach_id || "",
    personId: row.person_id || "",
  };
}

function rowToSyncRecord(row: any): OptixSyncRecord {
  return {
    calendarItemId: String(row.calendar_item_id || ""),
    optixBookingId: String(row.optix_booking_id || ""),
    optixBookingSessionId: String(row.optix_booking_session_id || ""),
    resourceId: String(row.resource_id || ""),
    startTimestamp: Number(row.start_timestamp || 0),
    endTimestamp: Number(row.end_timestamp || 0),
    fingerprint: String(row.fingerprint || ""),
    syncStatus: ["synced", "failed", "token_expired", "cancelled"].includes(row.sync_status)
      ? row.sync_status
      : "failed",
    errorCode: String(row.error_code || ""),
    errorMessage: String(row.error_message || ""),
  } as OptixSyncRecord;
}

async function readAppointment(calendarItemId: string) {
  const rows = await db().sql`
    SELECT id, kind, week, day, start, duration, title, client, note,
           service_id, location_id, location, status, email, phone, coach_id, person_id
    FROM calendar_items
    WHERE id = ${calendarItemId}
      AND kind = 'appointment'
    LIMIT 1
  `;
  return rows[0] ? rowToAppointment(rows[0]) : null;
}

async function readSyncRecord(calendarItemId: string) {
  const rows = await db().sql`
    SELECT *
    FROM optix_booking_sync
    WHERE calendar_item_id = ${calendarItemId}
    LIMIT 1
  `;
  return rows[0] ? rowToSyncRecord(rows[0]) : null;
}

async function readBookingTypeConfig(serviceId: string): Promise<Record<string, any> | null> {
  const rows = await db().sql`
    SELECT value
    FROM settings
    WHERE key = 'optixBookingTypeConfigJson'
    LIMIT 1
  `;
  try {
    const parsed = JSON.parse(rows[0]?.value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed[serviceId] || null
      : null;
  } catch {
    return null;
  }
}

async function saveSyncRecord(record: OptixSyncRecord) {
  const lastSyncedAt = ["synced", "cancelled"].includes(record.syncStatus)
    ? new Date().toISOString()
    : null;
  await db().sql`
    INSERT INTO optix_booking_sync (
      calendar_item_id, optix_booking_id, optix_booking_session_id,
      resource_id, start_timestamp, end_timestamp, fingerprint,
      sync_status, error_code, error_message, last_attempted_at,
      last_synced_at, created_at, updated_at
    ) VALUES (
      ${record.calendarItemId}, ${record.optixBookingId},
      ${record.optixBookingSessionId}, ${record.resourceId},
      ${record.startTimestamp}, ${record.endTimestamp}, ${record.fingerprint},
      ${record.syncStatus}, ${record.errorCode}, ${record.errorMessage},
      NOW(), ${lastSyncedAt}, NOW(), NOW()
    )
    ON CONFLICT (calendar_item_id) DO UPDATE SET
      optix_booking_id = EXCLUDED.optix_booking_id,
      optix_booking_session_id = EXCLUDED.optix_booking_session_id,
      resource_id = EXCLUDED.resource_id,
      start_timestamp = EXCLUDED.start_timestamp,
      end_timestamp = EXCLUDED.end_timestamp,
      fingerprint = EXCLUDED.fingerprint,
      sync_status = EXCLUDED.sync_status,
      error_code = EXCLUDED.error_code,
      error_message = EXCLUDED.error_message,
      last_attempted_at = NOW(),
      last_synced_at = COALESCE(EXCLUDED.last_synced_at, optix_booking_sync.last_synced_at),
      updated_at = NOW()
  `;
}

function timeoutRecord(
  appointment: ClarityOptixAppointment,
  existing: OptixSyncRecord | null,
): OptixSyncRecord {
  return {
    calendarItemId: appointment.id,
    optixBookingId: existing?.optixBookingId || "",
    optixBookingSessionId: existing?.optixBookingSessionId || "",
    resourceId: existing?.resourceId || "",
    startTimestamp: existing?.startTimestamp || 0,
    endTimestamp: existing?.endTimestamp || 0,
    fingerprint: existing?.fingerprint || "manual-timeout",
    syncStatus: "failed",
    errorCode: "timeout",
    errorMessage: "Optix did not finish the resource booking within 25 seconds. Check Optix before pressing Book resource again.",
  };
}

async function bookOneResource(calendarItemId: string) {
  await ensureOptixSyncTable();
  const appointment = await readAppointment(calendarItemId);
  if (!appointment) {
    return { ok: false, error: "appointment_not_found", message: "Clarity appointment not found." };
  }

  const existing = await readSyncRecord(calendarItemId);
  if (existing?.syncStatus === "synced" && existing.optixBookingId) {
    return { ok: true, alreadyBooked: true, result: existing };
  }

  const config = readOptixReconcileConfig(env);
  const serviceId = String(appointment.serviceId || appointment.service_id || "");
  const bookingType = await readBookingTypeConfig(serviceId);

  const operation = reconcileOptixAppointmentWithAutoSelect({
    appointment,
    existing,
    config,
    bookingType,
    forceRetry: true,
  });

  let result: OptixSyncRecord;
  try {
    result = await Promise.race([
      operation,
      new Promise<OptixSyncRecord>((resolve) => {
        setTimeout(() => resolve(timeoutRecord(appointment, existing)), OVERALL_TIMEOUT_MS);
      }),
    ]);
  } catch (error: any) {
    result = {
      ...timeoutRecord(appointment, existing),
      errorCode: String(error?.code || "remote_error"),
      errorMessage: error instanceof Error ? error.message : "Optix resource booking failed.",
    };
  }

  await saveSyncRecord(result);
  if (result.syncStatus === "synced") {
    await db().sql`
      UPDATE calendar_items
      SET external_sync_state = 'bay_booked', updated_at = NOW()
      WHERE id = ${appointment.id} AND origin = 'optix'
    `;
    const emailRows = await db().sql`
      SELECT l.external_booking_id, l.email_status, m.email_behaviour
      FROM external_booking_links l
      JOIN external_booking_mappings m
        ON m.provider = l.provider AND m.workspace_id = l.workspace_id
      WHERE l.clarity_item_id = ${appointment.id}
        AND l.provider = 'optix' AND l.purpose = 'lesson'
      LIMIT 1
    `;
    const emailLink = emailRows[0];
    if (emailLink?.email_behaviour === "after_bay" && emailLink?.email_status !== "sent") {
      try {
        await notifyBookingEvent({ action: "booking", appointment, source: `optix-after-bay:${emailLink.external_booking_id}` });
        await db().sql`
          UPDATE external_booking_links
          SET processing_status = 'bay_booked', email_status = 'sent', confirmation_sent_at = NOW(), updated_at = NOW()
          WHERE provider = 'optix' AND purpose = 'lesson' AND external_booking_id = ${emailLink.external_booking_id}
        `;
      } catch (error) {
        await db().sql`
          UPDATE external_booking_links
          SET processing_status = 'bay_booked', email_status = 'failed', updated_at = NOW()
          WHERE provider = 'optix' AND purpose = 'lesson' AND external_booking_id = ${emailLink.external_booking_id}
        `;
        console.error("optix_after_bay_email_failed", { calendarItemId: appointment.id });
      }
    } else {
      await db().sql`
        UPDATE external_booking_links SET processing_status = 'bay_booked', updated_at = NOW()
        WHERE clarity_item_id = ${appointment.id} AND provider = 'optix' AND purpose = 'lesson'
      `;
    }
  }
  return {
    ok: result.syncStatus === "synced",
    attempted: 1,
    synced: result.syncStatus === "synced" ? 1 : 0,
    failed: result.syncStatus === "failed" ? 1 : 0,
    result,
  };
}

export default async function handler(req: Request) {
  if (!(await requireAdmin(req))) return json({ error: "unauthorized" }, 401);
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: any = null;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const calendarItemId = String(body?.calendarItemId || "").trim();
  const source = String(body?.source || "").trim();
  if (!calendarItemId || source !== "manual-book-resource") {
    return json(
      {
        ok: false,
        error: "manual_booking_required",
        message: "Optix resource bookings can only be created from the Book resource button on a Clarity booking card.",
      },
      400,
    );
  }

  try {
    const result = await bookOneResource(calendarItemId);
    return json(result, result.ok ? 200 : 207);
  } catch (error: any) {
    const code = String(error?.code || "optix_reconcile_failed");
    return json(
      {
        ok: false,
        error: code,
        message: error instanceof Error ? error.message : "Optix resource booking failed.",
      },
      code === "not_configured" ? 503 : 500,
    );
  }
}

export const config: Config = { path: "/api/optix-booking-reconcile" };
