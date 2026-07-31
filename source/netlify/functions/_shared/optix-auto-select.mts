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

function uniqueIds(values: unknown[]): string[] {
  return Array.from(new Set(values.flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => String(value || "").trim())
    .filter(Boolean)));
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
      const result = await syncOptixBooking(cancelRequest);
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
      const result = await syncOptixBooking(request);
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
