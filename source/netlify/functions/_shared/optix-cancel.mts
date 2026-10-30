import { getDatabase } from "./database.mts";

import {
  datePartsForSlot,
  optixAppointmentFingerprint,
  wallClockToUnixSeconds,
  type OptixSyncRecord,
} from "./optix-reconcile.mts";
import { OptixSyncError, syncOptixBooking, type OptixBookingInput } from "./optix-client.mts";
import { optixConfigForAccount } from "./optix-credentials.mts";

function db() {
  return getDatabase();
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

export type OptixCustomerCancellationInput = {
  /** The Optix booking_id from calendar_items.external_booking_id. */
  externalBookingId: string;
  week: number;
  day: number;
  start: number;
  duration: number;
  timezone?: string;
  clientName?: string;
  /** The business the booking belongs to -- whose Optix token cancels it. */
  accountId: string;
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
  const config = await optixConfigForAccount(input.accountId);
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
  }, config.read);
  return { ok: true, optixBookingId: bookingId };
}

/**
 * Release the bay booking Clarity made for a lesson.
 *
 * No sync row, or one without a booking id, means Clarity never booked a bay,
 * so there is nothing to release. Once a booking id exists a refusal is
 * thrown, with the row marked failed, and the caller decides whether that
 * blocks what it was doing.
 *
 * The request is built from the ledger row alone: the booking Optix gave
 * Clarity, which bay, and the times it was last confirmed at. The lesson is
 * read only for a title, and for whose Optix token to use on rows that
 * predate account scoping. So a refused release can be retried after the
 * lesson has been deleted -- which is exactly when it most needs retrying,
 * because the delete goes ahead on a refusal (see deleteCalendarItemById).
 */
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

  const lessonRows = await db().sql`
    SELECT account_id, client, title
    FROM calendar_items
    WHERE id = ${cleanId}
    LIMIT 1
  `;
  const lesson = lessonRows[0] || null;
  // The business the bay was booked for decides whose Optix token releases it.
  const accountId = String(syncRows[0].account_id || lesson?.account_id || "");
  if (!accountId) {
    throw new OptixSyncError(
      "validation_failed",
      "Neither the bay record nor the lesson says which business this bay booking belongs to, so it could not be released.",
    );
  }
  const config = await optixConfigForAccount(accountId);
  // The same booking set a move sends, plus is_canceled. Clarity's identity
  // goes with it: this is Clarity's own booking.
  const request: OptixBookingInput = {
    memberId: config.memberId,
    ownerUserId: config.ownerUserId,
    bookingId: existing.optixBookingId,
    bookingSessionId: existing.optixBookingSessionId || null,
    resourceIds: existing.resourceId ? [existing.resourceId] : [],
    startTimestamp: existing.startTimestamp,
    endTimestamp: existing.endTimestamp,
    externalId: `clarity:${cleanId}`,
    title: String(lesson?.client || lesson?.title || "").trim() || "Clarity Booking",
    source: "Clarity Booking",
    isCanceled: true,
  };

  try {
    const result = await syncOptixBooking(request, config.read);
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
      `Optix did not release the bay booking: ${syncError.message}`,
      { status: syncError.status, retryable: syncError.retryable, cause: syncError },
    );
  }
}
