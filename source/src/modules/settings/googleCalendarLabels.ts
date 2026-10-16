// What the Google Calendar sync says about itself: stage, trigger, failure and
// timing labels, and the debug view's formatting.
import { t } from "../../lib/i18n";
import { activeLocale } from "../../lib/activeCountry";
import type { GoogleCalendarDebugError, GoogleCalendarImportRule } from "./googleCalendarTypes";

// Human labels for the Google Calendar debug window. The trigger codes are the
// literals each server-side sync call site passes as its trigger.
export const googleCalendarTriggerLabels: Record<string, string> = {
  manual_sync_now: t("Sync now (coach profile)"),
  api_google_calendar_sync_post: "Sync via /api/google-calendar-sync",
  admin_calendar_save: t("Calendar saved (admin)"),
  admin_item_upsert: t("Booking edited / moved (admin)"),
  admin_calendar_delete: t("Booking deleted (admin)"),
  public_booking_created: t("Public booking created"),
  public_booking_state_write: t("Public booking state write"),
  public_booking_cancelled: t("Public booking cancelled"),
  auto_sync: t("Automatic sync"),
  availability_save: t("Availability saved"),
  scheduled_reconcile: t("Nightly check"),
};

export const googleCalendarStageLabels: Record<string, string> = {
  preflight: t("Before any request"),
  access_token: t("Refreshing access token"),
  changes: t("Resolving changed bookings"),
  upsert: t("Writing events"),
  upsert_update: "PUT event (update)",
  create_insert: "POST event (insert)",
  create_replace: "PUT event (409 recovery)",
  delete: t("Deleting event"),
  complete: t("Finished"),
};

export function googleSyncTimeLabel(createdAt = "") {
  if (!createdAt) return t("Not synced yet");
  const time = new Date(createdAt);
  return Number.isNaN(time.getTime()) ? t("Not synced yet") : time.toLocaleString(activeLocale());
}

export const googleCalendarSkipReasonLabels: Record<string, string> = {
  auto_sync_disabled: t("Auto-sync is switched off, so nothing was sent."),
  manual_sync_only: t("Build is pinned to manual-sync-only, so nothing was sent."),
  google_oauth_not_configured: t("GOOGLE_CALENDAR_CLIENT_ID / _SECRET are missing from the environment."),
  google_calendar_not_connected: t("No connected Google account with calendar scope."),
  no_google_relevant_changes: t("The save touched nothing Google Calendar cares about, so no request was sent."),
  unchanged: t("Every targeted booking already matched Google, so no request was needed."),
};

export function googleCalendarTriggerLabel(trigger: string) {
  return googleCalendarTriggerLabels[trigger] || trigger || t("Unknown trigger");
}

export function googleCalendarStageLabel(stage: string) {
  return googleCalendarStageLabels[stage] || stage || "—";
}

export function googleCalendarDebugTimestamp(value: string) {
  if (!value) return "—";
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString(activeLocale());
}

export function relativeTimeLabel(value: string) {
  const time = new Date(value || "");
  if (Number.isNaN(time.getTime())) return "";
  const seconds = Math.round((Date.now() - time.getTime()) / 1000);
  if (seconds < 60) return t("just now");
  if (seconds < 3600) return t("{n}m ago", { n: Math.floor(seconds / 60) });
  if (seconds < 86400) return t("{n}h ago", { n: Math.floor(seconds / 3600) });
  return t("{n}d ago", { n: Math.floor(seconds / 86400) });
}

/**
 * One-line "what actually went wrong" for a failed run: Google's own error
 * identifiers first (HTTP status + error.status + errors[0].reason), falling
 * back to the provider-level code when the failure happened before any
 * Calendar API call (token refresh, missing scopes).
 */
export function googleCalendarFailureCode(error: GoogleCalendarDebugError | null) {
  if (!error) return "";
  const parts = [
    error.httpStatus ? `HTTP ${error.httpStatus}` : "",
    error.googleStatus,
    error.googleReason,
    !error.httpStatus && !error.googleStatus ? error.providerCode : "",
  ].filter(Boolean);
  return parts.join(" · ") || error.providerCode || t("Unknown failure");
}

/** Plain-English follow-up for the Google failures that have a known cause. */
export function googleCalendarFailureHint(error: GoogleCalendarDebugError | null) {
  if (!error) return "";
  if (error.googleReason === "rateLimitExceeded" || error.googleReason === "userRateLimitExceeded") {
    return t("Google throttled the write burst. Clarity now retries these with backoff and skips bookings Google already matches, so a repeat sync should send far fewer requests. If it keeps happening, the calendar is being written to faster than Google allows.");
  }
  if (error.googleReason === "quotaExceeded") {
    return t("The daily Google Calendar quota is spent. Retrying will not help until it resets.");
  }
  if (error.googleStatus === "PERMISSION_DENIED" || error.httpStatus === 403) {
    return t("The connected Google account is not allowed to write to this calendar. Check the calendar ID and reconnect if the account changed.");
  }
  if (error.httpStatus === 401 || error.providerCode === "GOOGLE_TOKEN_REFRESH_FAILED") {
    return t("Google rejected the stored credentials. Disconnect and reconnect the Google account.");
  }
  if (error.providerCode === "GOOGLE_SCOPE_MISSING") {
    return t("The connection is missing the calendar scope. Reconnect and accept the calendar permission.");

  }
  return "";
}

export function formatDebugJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** A rule only imports once it has something to match on. */
export function importRuleIsActive(rule: GoogleCalendarImportRule) {
  return rule.enabled && rule.aliases.trim().length > 0;
}
