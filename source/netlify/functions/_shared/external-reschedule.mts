import {
  canRescheduleExternally,
  providerCapabilities,
  type ExternalProvider,
} from "./integrations/registry.mts";

export type ExternalSlot = { week: number; day: number; start: number; duration: number };

export type ExternalBooking = {
  id: string;
  origin: string;
  externalProvider: string;
  externalBookingId: string;
  week: number;
  day: number;
  start: number;
  duration: number;
};

export class ExternalRescheduleError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "ExternalRescheduleError";
    this.code = code;
    this.status = status;
  }
}

export function isExternallyOwned(booking: Pick<ExternalBooking, "origin">) {
  const origin = String(booking?.origin || "clarity").trim().toLowerCase();
  return origin !== "" && origin !== "clarity";
}

export function sameSlot(a: ExternalSlot, b: ExternalSlot) {
  return a.week === b.week && a.day === b.day && a.start === b.start && a.duration === b.duration;
}

/**
 * Decide what a reschedule request should do before anything is written.
 *
 * Separated from the I/O so the ordering rule can be tested directly: Clarity
 * only ever records a new time *after* the external system confirms it. A
 * provider that cannot be asked is refused outright rather than applied
 * locally and reconciled later -- a booking that moved here but not there is
 * worse than one that did not move at all, because nothing signals the gap.
 */
export function planExternalReschedule(
  booking: ExternalBooking,
  nextSlot: ExternalSlot,
):
  | { action: "noop" }
  | { action: "native" }
  | { action: "call_provider"; provider: ExternalProvider; externalBookingId: string }
  | { action: "refuse"; code: string; message: string } {
  if (!isExternallyOwned(booking)) return { action: "native" };

  const current: ExternalSlot = {
    week: booking.week,
    day: booking.day,
    start: booking.start,
    duration: booking.duration,
  };
  // Nothing to ask the provider for. This also keeps a put-it-back inside the
  // grace window from turning into a needless external write.
  if (sameSlot(current, nextSlot)) return { action: "noop" };

  const check = canRescheduleExternally(booking.externalProvider);
  if (!check.allowed) return { action: "refuse", code: check.code, message: check.message };

  if (!String(booking.externalBookingId || "").trim()) {
    return {
      action: "refuse",
      code: "EXTERNAL_BOOKING_ID_MISSING",
      message: `This booking has no ${check.capabilities.label} ID, so the change cannot be sent there.`,
    };
  }

  return {
    action: "call_provider",
    provider: booking.externalProvider as ExternalProvider,
    externalBookingId: booking.externalBookingId,
  };
}

/**
 * The failure record left on a booking whose external move was attempted and
 * did not succeed. The lesson keeps its original time; this is what tells the
 * calendar to say so rather than showing a move that never happened.
 */
export function externalRescheduleFailure(provider: unknown, error: unknown, attemptedAt: string) {
  const capabilities = providerCapabilities(provider);
  return {
    external_sync_state: "reschedule_failed",
    external_sync_error: error instanceof Error ? error.message.slice(0, 1000) : String(error || "").slice(0, 1000),
    external_sync_attempted_at: attemptedAt,
    external_sync_provider_label: capabilities.label,
  };
}
