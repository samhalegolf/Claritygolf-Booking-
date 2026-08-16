import { getDatabase } from "@netlify/database";

import {
  buildOptixAppointmentInput,
  datePartsForSlot,
  optixAppointmentFingerprint,
  readOptixReconcileConfig,
  wallClockToUnixSeconds,
  type ClarityOptixAppointment,
  type OptixSyncRecord,
} from "./optix-reconcile.mts";
import { OptixSyncError, syncOptixBooking } from "./optix-client.mts";

function env(name: string): string {
  return (globalThis.Netlify?.env?.get(name) || process.env[name] || "").trim();
}

function db() {
  return getDatabase();
}

function rowToAppointment(row: any): ClarityOptixAppointment {
  return {
    id: String(row.id || ""),
    kind: row.kind || "appointment",
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
    status: "cancelled",
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

export type OptixBayCancellationResult = {
  ok: true;
  skipped: boolean;
  reason?: "no_bay_booking" | "already_cancelled";
  optixBookingId?: string;
};

/**
 * Cancel a bay booking before its Clarity lesson is removed.
 *
 * No sync row means no Clarity-created bay booking exists, so deletion may
 * continue. Once a bay booking ID exists, failure is deliberately surfaced and
 * the Clarity lesson must remain present for a safe retry.
 */
export type OptixCustomerCancellationInput = {
  /** The Optix booking_id from calendar_items.external_booking_id. */
  externalBookingId: string;
  week: number;
  day: number;
  start: number;
  duration: number;
  timezone?: string;
  clientName?: string;
};

/**
 * Cancel a booking the CUSTOMER made in Optix, identified by the booking_id an
 * inbound webhook delivered. This is the counterpart of the bay release above,
 * which only covers bookings Clarity itself created (tracked in
 * optix_booking_sync). An imported lesson has no sync row — its Optix side is
 * the customer's own booking, and cancelling it is the same bookingsCommit
 * mutation as booking, carrying booking_id + is_canceled and nothing that
 * could reassign the booking (no identity, no resource, no external id).
 *
 * Callers treat failure as a warning, not a blocker: the Clarity delete
 * proceeds either way, so a refusal here must be surfaced to the admin rather
 * than thrown away.
 */
export async function cancelOptixCustomerBooking(
  input: OptixCustomerCancellationInput,
): Promise<{ ok: true; optixBookingId: string }> {
  const bookingId = String(input.externalBookingId || "").trim();
  if (!bookingId) {
    throw new OptixSyncError("validation_failed", "An Optix booking ID is required to cancel the customer's booking.");
  }
  const config = readOptixReconcileConfig(env);
  const timeZone = String(input.timezone || "").trim() || config.defaultTimeZone;
  const date = datePartsForSlot(input.week, input.day);
  const startTimestamp = wallClockToUnixSeconds({ ...date, minutes: input.start, timeZone });
  const endTimestamp = wallClockToUnixSeconds({ ...date, minutes: input.start + input.duration, timeZone });
  // Draft-then-commit, the same sequence the production bay cancellation uses.
  await syncOptixBooking({
    memberId: "",
    ownerUserId: "",
    bookingId,
    resourceIds: [],
    startTimestamp,
    endTimestamp,
    externalId: "",
    title: input.clientName || "Clarity Booking",
    source: "Clarity Booking",
    isCanceled: true,
  });
  return { ok: true, optixBookingId: bookingId };
}

export async function cancelOptixBayForCalendarItem(
  calendarItemId: string,
): Promise<OptixBayCancellationResult> {
  const cleanId = String(calendarItemId || "").trim();
  if (!cleanId) {
    throw new OptixSyncError("validation_failed", "A Clarity appointment ID is required to cancel its Optix bay booking.");
  }

  const syncRows = await db().sql`
    SELECT *
    FROM optix_booking_sync
    WHERE calendar_item_id = ${cleanId}
    LIMIT 1
  `;
  const existing = syncRows[0] ? rowToSyncRecord(syncRows[0]) : null;
  if (!existing?.optixBookingId) {
    return { ok: true, skipped: true, reason: "no_bay_booking" };
  }
  if (existing.syncStatus === "cancelled") {
    return {
      ok: true,
      skipped: true,
      reason: "already_cancelled",
      optixBookingId: existing.optixBookingId,
    };
  }

  const appointmentRows = await db().sql`
    SELECT id, kind, week, day, start, duration, title, client, note,
           service_id, location_id, location, email, phone, coach_id, person_id
    FROM calendar_items
    WHERE id = ${cleanId}
      AND kind = 'appointment'
    LIMIT 1
  `;
  if (!appointmentRows[0]) {
    throw new OptixSyncError(
      "validation_failed",
      "The Clarity lesson was not found, so its Optix bay booking could not be cancelled safely.",
    );
  }

  const appointment = rowToAppointment(appointmentRows[0]);
  const config = readOptixReconcileConfig(env);
  const request = buildOptixAppointmentInput(appointment, existing, config);
  request.isCanceled = true;

  try {
    const result = await syncOptixBooking(request);
    const fingerprint = optixAppointmentFingerprint(request);
    await db().sql`
      UPDATE optix_booking_sync
      SET optix_booking_id = ${result.bookingId || existing.optixBookingId},
          optix_booking_session_id = ${result.bookingSessionId || existing.optixBookingSessionId},
          fingerprint = ${fingerprint},
          sync_status = 'cancelled',
          error_code = '',
          error_message = '',
          last_attempted_at = NOW(),
          last_synced_at = NOW(),
          updated_at = NOW()
      WHERE calendar_item_id = ${cleanId}
    `;
    return {
      ok: true,
      skipped: false,
      optixBookingId: result.bookingId || existing.optixBookingId,
    };
  } catch (error) {
    const syncError = error instanceof OptixSyncError
      ? error
      : new OptixSyncError(
          "remote_error",
          error instanceof Error ? error.message : "Optix bay cancellation failed.",
        );
    await db().sql`
      UPDATE optix_booking_sync
      SET sync_status = ${syncError.code === "token_expired" ? "token_expired" : "failed"},
          error_code = ${syncError.code},
          error_message = ${syncError.message},
          last_attempted_at = NOW(),
          updated_at = NOW()
      WHERE calendar_item_id = ${cleanId}
    `;
    throw new OptixSyncError(
      syncError.code,
      `The lesson was not cancelled because its Optix bay booking could not be released: ${syncError.message}`,
      { status: syncError.status, retryable: syncError.retryable, cause: syncError },
    );
  }
}
