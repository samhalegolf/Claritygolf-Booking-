import { syncOptixBooking, OptixSyncError } from "./optix-client.mts";
import {
  buildOptixAppointmentInput,
  optixAppointmentFingerprint,
  type ClarityOptixAppointment,
  type OptixSyncRecord,
} from "./optix-reconcile.mts";

type BookingTypeConfig = {
  enabled?: boolean;
  leftHanded?: boolean;
  preferredResourceIds?: string[];
  leftHandedResourceIds?: string[];
};

type ReconcileConfig = Parameters<typeof buildOptixAppointmentInput>[2];

const OPTIX_OVERALL_TIMEOUT_MS = 25_000;

function uniqueIds(values: unknown[]): string[] {
  return Array.from(new Set(values.flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => String(value || "").trim())
    .filter(Boolean)));
}

async function withOverallTimeout<T>(operation: () => Promise<T>, stage: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new OptixSyncError(
            "timeout",
            `Optix ${stage} did not complete within ${Math.round(OPTIX_OVERALL_TIMEOUT_MS / 1000)} seconds. The result is unknown; check Optix before retrying.`,
            { retryable: false },
          ));
        }, OPTIX_OVERALL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function candidateOptixResourceIds(input: {
  bookingType?: BookingTypeConfig | null;
  existing?: OptixSyncRecord | null;
  legacyResourceId?: string;
}) {
  const type = input.bookingType || {};
  const preferred = type.leftHanded
    ? [type.leftHandedResourceIds, type.preferredResourceIds]
    : [type.preferredResourceIds];
  return uniqueIds([
    input.existing?.resourceId,
    ...preferred,
    input.legacyResourceId,
  ]);
}

export async function reconcileOptixAppointmentWithAutoSelect(input: {
  appointment: ClarityOptixAppointment;
  existing: OptixSyncRecord | null;
  config: ReconcileConfig;
  bookingType?: BookingTypeConfig | null;
  forceRetry?: boolean;
}): Promise<OptixSyncRecord> {
  const bookingType = input.bookingType || {};
  const baseRequest = buildOptixAppointmentInput(input.appointment, input.existing, input.config);

  if (bookingType.enabled !== true) {
    if (!input.existing?.optixBookingId) {
      return {
        calendarItemId: input.appointment.id,
        optixBookingId: "",
        optixBookingSessionId: "",
        resourceId: "",
        startTimestamp: baseRequest.startTimestamp,
        endTimestamp: baseRequest.endTimestamp,
        fingerprint: "disabled",
        syncStatus: "cancelled",
        errorCode: "optix_disabled",
        errorMessage: "Optix booking is disabled for this booking type.",
      };
    }
    const cancelRequest = { ...baseRequest, resourceIds: [input.existing.resourceId], isCanceled: true };
    try {
      const result = await withOverallTimeout(() => syncOptixBooking(cancelRequest), "cancellation");
      return {
        ...input.existing,
        optixBookingId: result.bookingId || input.existing.optixBookingId,
        optixBookingSessionId: result.bookingSessionId || input.existing.optixBookingSessionId,
        fingerprint: optixAppointmentFingerprint(cancelRequest),
        syncStatus: "cancelled",
        errorCode: "",
        errorMessage: "",
      };
    } catch (error: any) {
      const code = String(error?.code || "remote_error");
      return {
        ...input.existing,
        syncStatus: code === "token_expired" ? "token_expired" : "failed",
        errorCode: code,
        errorMessage: error instanceof Error ? error.message : "Optix cancellation failed.",
      };
    }
  }

  // Any failed booking is terminal until a coach explicitly retries this exact
  // appointment. Appointment edits, scheduled reconciliation, page loads and
  // unrelated booking saves must never unlock another Optix create request.
  if (!input.forceRetry && input.existing?.syncStatus === "failed") {
    return input.existing;
  }

  const candidates = candidateOptixResourceIds({
    bookingType,
    existing: input.existing,
    legacyResourceId: baseRequest.resourceIds[0],
  });
  if (!candidates.length) {
    throw new OptixSyncError("not_configured", `No Optix bays are configured for booking type ${input.appointment.serviceId || input.appointment.service_id || "unknown"}.`);
  }

  let lastConflict: unknown = null;
  for (const resourceId of candidates) {
    const request = { ...baseRequest, resourceIds: [resourceId] };
    const fingerprint = optixAppointmentFingerprint(request);
    if (input.existing?.syncStatus === "synced" && input.existing.fingerprint === fingerprint) {
      return input.existing;
    }
    try {
      const result = await withOverallTimeout(() => syncOptixBooking(request), `booking for resource ${resourceId}`);
      return {
        calendarItemId: input.appointment.id,
        optixBookingId: result.bookingId || input.existing?.optixBookingId || "",
        optixBookingSessionId: result.bookingSessionId || input.existing?.optixBookingSessionId || "",
        resourceId,
        startTimestamp: request.startTimestamp,
        endTimestamp: request.endTimestamp,
        fingerprint,
        syncStatus: request.isCanceled ? "cancelled" : "synced",
        errorCode: "",
        errorMessage: "",
      };
    } catch (error: any) {
      if (String(error?.code || "") === "resource_conflict") {
        lastConflict = error;
        continue;
      }
      const code = String(error?.code || "remote_error");
      return {
        calendarItemId: input.appointment.id,
        optixBookingId: input.existing?.optixBookingId || "",
        optixBookingSessionId: input.existing?.optixBookingSessionId || "",
        resourceId,
        startTimestamp: request.startTimestamp,
        endTimestamp: request.endTimestamp,
        fingerprint,
        syncStatus: code === "token_expired" ? "token_expired" : "failed",
        errorCode: code,
        errorMessage: error instanceof Error ? error.message : "Optix sync failed.",
      };
    }
  }

  return {
    calendarItemId: input.appointment.id,
    optixBookingId: input.existing?.optixBookingId || "",
    optixBookingSessionId: input.existing?.optixBookingSessionId || "",
    resourceId: candidates.at(-1) || "",
    startTimestamp: baseRequest.startTimestamp,
    endTimestamp: baseRequest.endTimestamp,
    fingerprint: "all-resources-conflicted",
    syncStatus: "failed",
    errorCode: "resource_conflict",
    errorMessage: lastConflict instanceof Error ? lastConflict.message : "All preferred Optix bays are unavailable.",
  };
}

export type OptixMoveInPlaceOutcome =
  | { moved: true; unchanged: boolean; record: OptixSyncRecord }
  | { moved: false; code: string; message: string };

/**
 * Move an existing Optix bay booking to the lesson's current slot, keeping the
 * same booking and the same bay.
 *
 * This is the first thing a reschedule tries. Optix's BookingSetInput carries
 * the booking_id and booking_session_id it was created with, so sending it
 * again with new timestamps amends the booking rather than creating a second
 * one -- one round trip, the bay never leaves the coach's hands, and the
 * customer keeps the same Optix booking reference. Only when Optix refuses
 * (usually because that bay is taken at the new time) does the caller fall
 * back to cancelling and booking a fresh bay, which is the slower path but can
 * land the lesson in a different bay.
 *
 * Returns rather than throws: every refusal here is expected and recoverable,
 * and the caller needs the reason to decide what to try next, not a stack.
 *
 * `sync` is injectable so the decision logic can be tested without Optix.
 */
export async function moveOptixBookingInPlace(input: {
  appointment: ClarityOptixAppointment;
  existing: OptixSyncRecord | null;
  config: ReconcileConfig;
  bookingType?: BookingTypeConfig | null;
  sync?: typeof syncOptixBooking;
}): Promise<OptixMoveInPlaceOutcome> {
  const existing = input.existing;
  // Nothing to amend. A booking with no Optix ids, or one Optix has already
  // released, has to be created afresh -- there is no booking to move.
  if (!existing?.optixBookingId || existing.syncStatus !== "synced") {
    return { moved: false, code: "no_synced_bay", message: "This lesson holds no live Optix bay booking." };
  }
  // The bay to keep has to be known. A synced row with no resource id predates
  // auto-select; let the cancel-and-rebook path choose a bay properly.
  if (!existing.resourceId) {
    return { moved: false, code: "no_resource_id", message: "The existing bay booking does not record which bay it holds." };
  }
  // Bays turned off for this lesson type: the bay should be released, not
  // moved. reconcileOptixAppointmentWithAutoSelect already does exactly that.
  if (input.bookingType && input.bookingType.enabled !== true) {
    return { moved: false, code: "optix_disabled", message: "Optix booking is disabled for this booking type." };
  }

  let request;
  try {
    request = {
      ...buildOptixAppointmentInput(input.appointment, existing, input.config),
      resourceIds: [existing.resourceId],
    };
  } catch (error: any) {
    // Missing identity or an unmapped resource. The caller's cancel-and-rebook
    // fallback reports the same problem through the panel; refusing here keeps
    // this function's contract that it never throws.
    return {
      moved: false,
      code: String(error?.code || "validation_failed"),
      message: error instanceof Error ? error.message : "The Optix bay move could not be prepared.",
    };
  }
  // A cancelled lesson is a release, not a move. Amending one would re-assert
  // the booking at a new time for a lesson nobody is attending.
  if (request.isCanceled) {
    return { moved: false, code: "appointment_cancelled", message: "The lesson is cancelled, so its bay is released rather than moved." };
  }

  const fingerprint = optixAppointmentFingerprint(request);
  // The lesson did not actually move (or moved and moved back). Sending this
  // to Optix would be a no-op round trip on a path that runs after every save.
  if (existing.fingerprint === fingerprint) {
    return { moved: true, unchanged: true, record: existing };
  }

  try {
    const result = await withOverallTimeout(
      () => (input.sync || syncOptixBooking)(request),
      `bay move for resource ${existing.resourceId}`,
    );
    return {
      moved: true,
      unchanged: false,
      record: {
        calendarItemId: input.appointment.id,
        optixBookingId: result.bookingId || existing.optixBookingId,
        optixBookingSessionId: result.bookingSessionId || existing.optixBookingSessionId,
        resourceId: existing.resourceId,
        startTimestamp: request.startTimestamp,
        endTimestamp: request.endTimestamp,
        fingerprint,
        syncStatus: "synced",
        errorCode: "",
        errorMessage: "",
      },
    };
  } catch (error: any) {
    return {
      moved: false,
      code: String(error?.code || "remote_error"),
      message: error instanceof Error ? error.message : "Optix refused to move the bay booking.",
    };
  }
}
