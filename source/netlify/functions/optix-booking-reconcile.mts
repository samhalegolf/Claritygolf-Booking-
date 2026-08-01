import { getDatabase } from "@netlify/database";

import {
  optixAppointmentFingerprint,
  readOptixReconcileConfig,
  type ClarityOptixAppointment,
  type OptixSyncRecord,
} from "./_shared/optix-reconcile.mts";
import { reconcileOptixAppointmentWithAutoSelect } from "./_shared/optix-auto-select.mts";
import { syncOptixBooking } from "./_shared/optix-client.mts";

function env(name: string): string {
  return (
    globalThis.Netlify?.env?.get(name) ||
    process.env[name] ||
    ""
  ).trim();
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
  await db().sql`
    CREATE INDEX IF NOT EXISTS idx_optix_booking_sync_status
    ON optix_booking_sync (sync_status, updated_at DESC)
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
    location:
      row.location && typeof row.location === "object"
        ? row.location
        : null,
    status: row.status || "booked",
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

async function readAppointments() {
  const rows = await db().sql`
    SELECT id, kind, week, day, start, duration, title, client, note,
           service_id, location_id, location, status
    FROM calendar_items
    WHERE kind = 'appointment'
    ORDER BY week, day, start, id
  `;
  return rows.map(rowToAppointment);
}

async function readSyncRecords() {
  const rows = await db().sql`
    SELECT *
    FROM optix_booking_sync
    ORDER BY updated_at DESC
  `;
  return rows.map(rowToSyncRecord);
}

async function readBookingTypeConfig(): Promise<Record<string, any>> {
  const rows = await db().sql`
    SELECT value
    FROM settings
    WHERE key = 'optixBookingTypeConfigJson'
    LIMIT 1
  `;
  try {
    const parsed = JSON.parse(rows[0]?.value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
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

async function cancelDeletedAppointment(
  record: OptixSyncRecord,
  config: ReturnType<typeof readOptixReconcileConfig>,
): Promise<OptixSyncRecord> {
  if (!record.optixBookingId || record.syncStatus === "cancelled") {
    return { ...record, syncStatus: "cancelled" };
  }
  const request = {
    memberId: config.memberId,
    ownerUserId: config.ownerUserId,
    bookingId: record.optixBookingId,
    bookingSessionId: record.optixBookingSessionId || null,
    resourceIds: [record.resourceId],
    startTimestamp: record.startTimestamp,
    endTimestamp: record.endTimestamp,
    externalId: `clarity:${record.calendarItemId}`,
    title: "Cancelled Clarity Booking",
    notes: `Clarity appointment removed: ${record.calendarItemId}`,
    source: "Clarity Booking",
    isCanceled: true,
  };

  try {
    const result = await syncOptixBooking(request);
    return {
      ...record,
      optixBookingId: result.bookingId || record.optixBookingId,
      optixBookingSessionId: result.bookingSessionId || record.optixBookingSessionId,
      fingerprint: optixAppointmentFingerprint(request),
      syncStatus: "cancelled",
      errorCode: "",
      errorMessage: "",
    };
  } catch (error: any) {
    const code = String(error?.code || "remote_error");
    return {
      ...record,
      syncStatus: code === "token_expired" ? "token_expired" : "failed",
      errorCode: code,
      errorMessage: error instanceof Error ? error.message : "Optix cancellation failed.",
    };
  }
}

export async function reconcileOptixBookings(options: { forceRetry?: boolean } = {}) {
  await ensureOptixSyncTable();
  const config = readOptixReconcileConfig(env);
  const [appointments, records, bookingTypes] = await Promise.all([
    readAppointments(),
    readSyncRecords(),
    readBookingTypeConfig(),
  ]);
  const recordById = new Map(records.map((record) => [record.calendarItemId, record]));
  const liveIds = new Set(appointments.map((appointment) => appointment.id));
  const results: OptixSyncRecord[] = [];

  for (const appointment of appointments) {
    const existing = recordById.get(appointment.id) || null;
    const serviceId = String(appointment.serviceId || appointment.service_id || "");
    const next = await reconcileOptixAppointmentWithAutoSelect({
      appointment,
      existing,
      config,
      bookingType: bookingTypes[serviceId] || null,
      forceRetry: options.forceRetry === true,
    });
    await saveSyncRecord(next);
    results.push(next);
    if (next.syncStatus === "token_expired") break;
  }

  if (!results.some((record) => record.syncStatus === "token_expired")) {
    for (const record of records) {
      if (liveIds.has(record.calendarItemId)) continue;
      const next = await cancelDeletedAppointment(record, config);
      await saveSyncRecord(next);
      results.push(next);
      if (next.syncStatus === "token_expired") break;
    }
  }

  return {
    ok: !results.some((record) => ["failed", "token_expired"].includes(record.syncStatus)),
    appointmentCount: appointments.length,
    attempted: results.length,
    synced: results.filter((record) => record.syncStatus === "synced").length,
    cancelled: results.filter((record) => record.syncStatus === "cancelled").length,
    failed: results.filter((record) => record.syncStatus === "failed").length,
    tokenExpired: results.some((record) => record.syncStatus === "token_expired"),
    results,
  };
}

export default async function handler(req: Request) {
  if (req.method !== "POST" && req.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405);
  }

  try {
    let forceRetry = false;
    if (req.method === "POST") {
      const raw = await req.text();
      if (raw) {
        try {
          forceRetry = JSON.parse(raw)?.forceRetry === true;
        } catch {
          forceRetry = false;
        }
      }
    }
    const result = await reconcileOptixBookings({ forceRetry });
    return json(result, result.ok ? 200 : 207);
  } catch (error: any) {
    const code = String(error?.code || "optix_reconcile_failed");
    return json(
      {
        ok: false,
        error: code,
        message: error instanceof Error ? error.message : "Optix reconciliation failed.",
        tokenExpired: code === "token_expired",
      },
      code === "not_configured" ? 503 : 500,
    );
  }
}

export const config = {
  schedule: "*/30 * * * *",
};
