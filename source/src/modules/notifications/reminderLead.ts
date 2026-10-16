// How far ahead a lesson reminder goes out, as the settings read and show it.
import { t } from "../../lib/i18n";
import { clamp } from "../../lib/number";

/** Days + hours from the reminder settings UI, combined and clamped to the
 *  backend's 1 hour – 14 days range (see admin-settings.mts). */
export function reminderLeadMinutesFrom(days: number, hours: number) {
  return clamp(Math.round(days) * 1440 + Math.round(hours) * 60, 60, 14 * 24 * 60);
}

export function reminderLeadLabel(minutes: number) {
  const days = Math.floor(minutes / 1440);
  const hours = Math.round((minutes % 1440) / 60);
  const parts = [
    days ? (days === 1 ? t("1 day") : t("{days} days", { days })) : "",
    hours ? (hours === 1 ? t("1 hour") : t("{hours} hours", { hours })) : "",
  ].filter(Boolean);
  return parts.join(" ") || t("1 hour");
}
