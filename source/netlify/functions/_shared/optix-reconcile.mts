import { createHash } from "node:crypto";

import {
  OptixSyncError,
  syncOptixBooking,
  type OptixBookingInput,
} from "./optix-client.mts";

export type ClarityOptixAppointment = {
  id: string;
  kind?: string;
  week: number;
  day: number;
  start: number;
  duration: number;
  title?: string;
  client?: string;
  note?: string;
  serviceId?: string;
  service_id?: string;
  locationId?: string;
  location_id?: string;
  location?: { timezone?: string; locationId?: string } | null;
  status?: string;
  email?: string;
  phone?: string;
  coachId?: string;
  personId?: string;
};

export type OptixSyncRecord = {
  calendarItemId: string;
  optixBookingId: string;
  optixBookingSessionId: string;
  resourceId: string;
  startTimestamp: number;
  endTimestamp: number;
  fingerprint: string;
  syncStatus: "synced" | "failed" | "token_expired" | "cancelled";
  errorCode: string;
  errorMessage: string;
};

type ReconcileConfig = {
  memberId: string;
  ownerUserId: string;
  defaultResourceId: string;
  resourceMap: Record<string, string>;
  defaultTimeZone: string;
};

export function readOptixReconcileConfig(
  readEnv: (name: string) => string,
): ReconcileConfig {
  const resourceMapRaw = readEnv("OPTIX_RESOURCE_MAP_JSON");
  let resourceMap: Record<string, string> = {};
  if (resourceMapRaw) {
    try {
      const parsed = JSON.parse(resourceMapRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        resourceMap = Object.fromEntries(
          Object.entries(parsed)
            .map(([key, value]) => [String(key).trim(), String(value ?? "").trim()])
            .filter(([key, value]) => key && value),
        );
      }
    } catch {
      throw new OptixSyncError(
        "validation_failed",
        "OPTIX_RESOURCE_MAP_JSON is not valid JSON.",
      );
    }
  }

  return {
    memberId: readEnv("OPTIX_MEMBER_ID").trim(),
    ownerUserId: readEnv("OPTIX_OWNER_USER_ID").trim(),
    defaultResourceId: readEnv("OPTIX_RESOURCE_ID").trim(),
    resourceMap,
    defaultTimeZone:
      readEnv("CLARITY_TIMEZONE").trim() || "Pacific/Auckland",
  };
}

function datePartsForSlot(week: number, day: number) {
  const base = new Date(Date.UTC(2026, 5, 1));
  base.setUTCDate(base.getUTCDate() + Number(week || 0) * 7 + Number(day || 0));
  return {
    year: base.getUTCFullYear(),
    month: base.getUTCMonth() + 1,
    day: base.getUTCDate(),
  };
}

function zonedParts(timestamp: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(timestamp));
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value || 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

export function wallClockToUnixSeconds(input: {
  year: number;
  month: number;
  day: number;
  minutes: number;
  timeZone: string;
}): number {
  const hour = Math.floor(input.minutes / 60);
  const minute = input.minutes % 60;
  const targetUtc = Date.UTC(
    input.year,
    input.month - 1,
    input.day,
    hour,
    minute,
    0,
  );
  let candidate = targetUtc;

  // Iteratively correct the UTC candidate until formatting it in the venue's
  // timezone produces the requested local wall-clock value. This handles DST
  // without adding a timezone dependency to the Netlify function bundle.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(candidate, input.timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const correction = targetUtc - actualAsUtc;
    candidate += correction;
    if (Math.abs(correction) < 1000) break;
  }

  return Math.floor(candidate / 1000);
}

export function resolveOptixResourceId(
  appointment: ClarityOptixAppointment,
  config: ReconcileConfig,
): string {
  const locationId = String(
    appointment.locationId ||
      appointment.location_id ||
      appointment.location?.locationId ||
      "",
  ).trim();
  const serviceId = String(
    appointment.serviceId || appointment.service_id || "",
  ).trim();
  return (
    config.resourceMap[`location:${locationId}`] ||
    config.resourceMap[locationId] ||
    config.resourceMap[`service:${serviceId}`] ||
    config.resourceMap[serviceId] ||
    config.defaultResourceId
  );
}

export function buildOptixAppointmentInput(
  appointment: ClarityOptixAppointment,
  existing: OptixSyncRecord | null,
  config: ReconcileConfig,
): OptixBookingInput {
  if (!config.memberId || !config.ownerUserId) {
    throw new OptixSyncError(
      "not_configured",
      "OPTIX_MEMBER_ID and OPTIX_OWNER_USER_ID are required.",
    );
  }
  const resourceId = resolveOptixResourceId(appointment, config);
  if (!resourceId) {
    throw new OptixSyncError(
      "not_configured",
      `No Optix resource is mapped for Clarity appointment ${appointment.id}.`,
    );
  }

  const date = datePartsForSlot(appointment.week, appointment.day);
  const timeZone =
    String(appointment.location?.timezone || "").trim() ||
    config.defaultTimeZone;
  const startTimestamp = wallClockToUnixSeconds({
    ...date,
    minutes: appointment.start,
    timeZone,
  });
  const endTimestamp = wallClockToUnixSeconds({
    ...date,
    minutes: appointment.start + appointment.duration,
    timeZone,
  });

  return {
    memberId: config.memberId,
    ownerUserId: config.ownerUserId,
    bookingId: existing?.optixBookingId || null,
    bookingSessionId: existing?.optixBookingSessionId || null,
    resourceIds: [resourceId],
    startTimestamp,
    endTimestamp,
    externalId: `clarity:${appointment.id}`,
    title: appointment.client || appointment.title || "Clarity Booking",
    notes: [appointment.note, `Clarity appointment: ${appointment.id}`]
      .filter(Boolean)
      .join("\n"),
    source: "Clarity Booking",
    isCanceled:
      appointment.status === "cancelled" ||
      appointment.status === "no_show",
  };
}

export function optixAppointmentFingerprint(input: OptixBookingInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        resourceIds: input.resourceIds,
        startTimestamp: input.startTimestamp,
        endTimestamp: input.endTimestamp,
        title: input.title || "",
        notes: input.notes || "",
        isCanceled: input.isCanceled === true,
      }),
    )
    .digest("hex");
}

export async function reconcileOneOptixAppointment(input: {
  appointment: ClarityOptixAppointment;
  existing: OptixSyncRecord | null;
  config: ReconcileConfig;
}): Promise<OptixSyncRecord> {
  const request = buildOptixAppointmentInput(
    input.appointment,
    input.existing,
    input.config,
  );
  const fingerprint = optixAppointmentFingerprint(request);
  if (
    input.existing?.syncStatus === "synced" &&
    input.existing.fingerprint === fingerprint
  ) {
    return input.existing;
  }

  try {
    const result = await syncOptixBooking(request);
    return {
      calendarItemId: input.appointment.id,
      optixBookingId:
        result.bookingId || input.existing?.optixBookingId || "",
      optixBookingSessionId:
        result.bookingSessionId ||
        input.existing?.optixBookingSessionId ||
        "",
      resourceId: request.resourceIds[0],
      startTimestamp: request.startTimestamp,
      endTimestamp: request.endTimestamp,
      fingerprint,
      syncStatus: request.isCanceled ? "cancelled" : "synced",
      errorCode: "",
      errorMessage: "",
    };
  } catch (error) {
    const syncError =
      error instanceof OptixSyncError
        ? error
        : new OptixSyncError(
            "remote_error",
            error instanceof Error ? error.message : "Optix sync failed.",
          );
    return {
      calendarItemId: input.appointment.id,
      optixBookingId: input.existing?.optixBookingId || "",
      optixBookingSessionId:
        input.existing?.optixBookingSessionId || "",
      resourceId: request.resourceIds[0],
      startTimestamp: request.startTimestamp,
      endTimestamp: request.endTimestamp,
      fingerprint,
      syncStatus:
        syncError.code === "token_expired" ? "token_expired" : "failed",
      errorCode: syncError.code,
      errorMessage: syncError.message,
    };
  }
}
