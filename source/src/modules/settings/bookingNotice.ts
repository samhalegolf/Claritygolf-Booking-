// How much notice a booking needs: the default, the ceiling and the presets
// the Booking page settings offer.
import { clamp } from "../../lib/number";

export const DEFAULT_MIN_BOOKING_NOTICE_MINUTES = 240;

export const MAX_MIN_BOOKING_NOTICE_MINUTES = 7 * 24 * 60;

export const MIN_BOOKING_NOTICE_PRESETS_HOURS = [0, 1, 2, 4, 24] as const;

export function cleanMinBookingNoticeMinutes(value: number) {
  return Number.isFinite(value) ? clamp(Math.round(value), 0, MAX_MIN_BOOKING_NOTICE_MINUTES) : DEFAULT_MIN_BOOKING_NOTICE_MINUTES;
}
