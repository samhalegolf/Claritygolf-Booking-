import { getDatabase } from "@netlify/database";

import {
  readOptixReconcileConfig,
  type ClarityOptixAppointment,
  type OptixSyncRecord,
} from "./optix-reconcile.mts";
import { reconcileOptixAppointmentWithAutoSelect } from "./optix-auto-select.mts";
import { cancelOptixBayForCalendarItem } from "./optix-cancel.mts";
import { notifyBookingEvent } from "../notification-engine.mts";

const OVERALL_TIMEOUT_MS = 25_000;

function env(name: string): string {
  return (globalThis.Netlify?.env?.get(name) || process.env[name] || "").trim();
}

function db() {
  return getDatabase();
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

/**
 * Append-only history of bay bookings this lesson used to hold. See the
 * migration 20260826000200_create_optix_bay_bookings for why it exists;
 * created here too so the rebook path works on an environment whose
 * migrations have not run, matching ensureOptixSyncTable above.
 */
async function ensureOptixBayHistoryTable() {
  await db().sql`
    CREATE TABLE IF NOT EXISTS optix_bay_bookings (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      calendar_item_id TEXT NOT NULL,
      optix_booking_id TEXT NOT NULL DEFAULT '',
      optix_booking_session_id TEXT NOT NULL DEFAULT '',
      resource_id TEXT NOT NULL DEFAULT '',
      start_timestamp BIGINT NOT NULL DEFAULT 0,
      end_timestamp BIGINT NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT 'reschedule',
      cancelled BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

/**
 * Record a bay booking that is about to stop being this lesson's bay.
 *
 * Called immediately before the sync row's Optix IDs are cleared, because
 * after that UPDATE there is nothing left to record. Never throws: losing the
 * audit row must not abort a rebook that is already half done (the Optix
 * booking has been cancelled by this point).
 */
async function recordSupersededBayBooking(
  record: OptixSyncRecord,
  options: { reason: "reschedule" | "reschedule_failed"; cancelled: boolean },
) {
  try {
    await ensureOptixBayHistoryTable();
    await db().sql`
      INSERT INTO optix_bay_bookings (
        calendar_item_id, optix_booking_id, optix_booking_session_id,
        resource_id, start_timestamp, end_timestamp, reason, cancelled
      ) VALUES (
        ${record.calendarItemId}, ${record.optixBookingId},
        ${record.optixBookingSessionId}, ${record.resourceId},
        ${record.startTimestamp}, ${record.endTimestamp},
        ${options.reason}, ${options.cancelled}
      )
    `;
  } catch (error) {
    console.error("optix_bay_history_write_failed", {
      calendarItemId: record.calendarItemId,
      optixBookingId: record.optixBookingId,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error || "").slice(0, 300),
    });
  }
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

export async function readBookingTypeConfig(serviceId: string): Promise<Record<string, any> | null> {
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

/**
 * Books one Optix resource for a Clarity appointment and records the result in
 * optix_booking_sync. Shared by the admin Book resource button
 * (optix-booking-reconcile.mts) and the per-lesson-type auto-book that runs
 * after a client's public booking lands on the calendar (booking-core.mts).
 * Idempotent: an already-synced booking returns { alreadyBooked: true }.
 */
export async function bookOneResource(calendarItemId: string) {
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

export type BayRebookOutcome = {
  moved: boolean;
  skipped?: "no_synced_bay";
  error?: string;
};

/**
 * Move a lesson's bay booking after the lesson itself was rescheduled:
 * cancel the old Optix bay booking, then book a fresh one at the new slot.
 *
 * Cancel-then-rebook rather than amending the live booking in place — cancel
 * and create are the two Optix operations Clarity already exercises in
 * production (the delete path and the Book resource button), and the rebook
 * re-runs bay auto-select, so a lesson moved to a time where its original bay
 * is busy lands in another free bay instead of failing.
 *
 * Never throws — this runs as a deferred side effect after the reschedule
 * response has gone out. If the cancel is refused, the rebook is NOT
 * attempted (rebooking while the old booking stands would hold two bays); the
 * sync row is already marked failed and the Optix panel shows it. If the
 * rebook fails, the bay is released but not re-held — the lesson loses its
 * orange outline and Book resource on the card retries as usual.
 */
export async function rebookResourceAfterReschedule(calendarItemId: string): Promise<BayRebookOutcome> {
  const cleanId = String(calendarItemId || "").trim();
  try {
    await ensureOptixSyncTable();
    const existing = cleanId ? await readSyncRecord(cleanId) : null;
    if (!existing?.optixBookingId || existing.syncStatus !== "synced") {
      return { moved: false, skipped: "no_synced_bay" };
    }
    let cancelled = false;
    try {
      await cancelOptixBayForCalendarItem(cleanId);
      cancelled = true;
    } finally {
      // Write the history row here, not after the cancel succeeds: a refused
      // cancel is the case that most needs a record, because it leaves a bay
      // held in Optix at a time no lesson occupies any more. `cancelled` is
      // what separates "released cleanly" from "go and check Optix".
      await recordSupersededBayBooking(existing, {
        reason: cancelled ? "reschedule" : "reschedule_failed",
        cancelled,
      });
    }
    // The cancelled booking is dead. Clear its IDs so the rebook creates a
    // fresh booking — left in place, buildOptixAppointmentInput would reuse
    // them and try to resurrect the cancelled booking instead. The IDs now
    // live on in optix_bay_bookings, which is the only place they survive
    // this UPDATE.
    await db().sql`
      UPDATE optix_booking_sync
      SET optix_booking_id = '', optix_booking_session_id = '', updated_at = NOW()
      WHERE calendar_item_id = ${cleanId}
    `;
    const outcome = await bookOneResource(cleanId);
    const errorMessage =
      (outcome as { message?: string }).message ||
      (outcome as { result?: OptixSyncRecord }).result?.errorMessage ||
      "";
    console.info("optix_bay_rebook_after_reschedule", {
      calendarItemId: cleanId,
      ok: outcome.ok === true,
      error: outcome.ok === true ? "" : errorMessage.slice(0, 300),
    });
    return outcome.ok === true ? { moved: true } : { moved: false, error: errorMessage };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "Optix bay rebook failed.");
    console.error("optix_bay_rebook_after_reschedule_failed", {
      calendarItemId: cleanId,
      error: message.slice(0, 300),
    });
    return { moved: false, error: message };
  }
}

/**
 * Auto-book hook for client (public) bookings. Fires only when the lesson
 * type's Resources config has both a resource profile (enabled) and the
 * Auto-book tick. Never throws: a failed bay booking must not break the
 * client's booking confirmation — the coach sees the missing outline and can
 * press Book resource on the card as before.
 */
export async function autoBookResourceForNewBooking(
  calendarItemId: string,
  serviceId: string,
): Promise<void> {
  try {
    const bookingType = await readBookingTypeConfig(String(serviceId || ""));
    if (bookingType?.enabled !== true || bookingType?.autoBook !== true) return;
    const outcome = await bookOneResource(calendarItemId);
    console.info("optix_auto_book_resource", {
      calendarItemId,
      serviceId,
      ok: outcome.ok === true,
      alreadyBooked: (outcome as { alreadyBooked?: boolean }).alreadyBooked === true,
      error: (outcome as { error?: string }).error || (outcome as { result?: OptixSyncRecord }).result?.errorCode || "",
    });
  } catch (error) {
    console.error("optix_auto_book_resource_failed", {
      calendarItemId,
      serviceId,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error || "").slice(0, 300),
    });
  }
}
