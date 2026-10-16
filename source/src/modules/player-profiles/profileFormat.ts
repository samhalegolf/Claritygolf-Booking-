// Dates, durations and titles as the player profile rows print them.
import { t } from "../../lib/i18n";
import { activeLocale } from "../../lib/activeCountry";
import { safeText } from "../../lib/text";

export function profileRecordDateLabel(createdAt = "") {
  if (!createdAt) return "";
  const time = new Date(createdAt);
  if (Number.isNaN(time.getTime())) return "";
  return new Intl.DateTimeFormat(activeLocale(), {
    day: "2-digit",
    month: "short",
    year: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(time)
    .replace(",", "")
    .replace(/\s(am|pm)$/i, (match) => match.toUpperCase());
}

export function profileRecordTitle(playerName = "", createdAt = "") {
  const name = safeText(playerName).trim() || t("Player");
  const date = profileRecordDateLabel(createdAt);
  return date ? `${name} - ${date}` : name;
}

export function formatVideoDurationLabel(seconds?: number) {
  if (!Number.isFinite(seconds ?? NaN) || !seconds) return t("Duration unknown");
  const totalSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function savedVideoCloudErrorLabel(code?: string, fallback?: string) {
  switch (code) {
    case "CLOUD_OAUTH_NOT_CONFIGURED":
      return t("Clarity Cloud is not configured for this environment.");
    case "PROVIDER_STORAGE_UNAVAILABLE":
      return t("Clarity Cloud setup is incomplete.");
    case "DRIVE_API_DISABLED":
      return t("Clarity Cloud is not enabled for this connection.");
    case "DRIVE_UPLOAD_PROXY_FAILED":
      return t("Clarity Cloud could not complete the upload.");
    case "DRIVE_UPLOAD_TOO_LARGE":
      return t("This transfer chunk was too large.");
    case "DRIVE_SCOPE_MISSING":
      return t("Clarity Cloud permission is required.");
    case "GOOGLE_RECONNECT_REQUIRED":
      return t("Reconnect Clarity Cloud to continue.");
    case "GOOGLE_TOKEN_REFRESH_FAILED":
      return t("Clarity Cloud could not refresh the Google connection.");
    case "DRIVE_TRANSFER_FOLDER_FAILED":
    case "DRIVE_FOLDER_PROVISION_FAILED":
      return t("Clarity Cloud could not prepare the transfer folder.");
    case "DRIVE_UPLOAD_SESSION_EXPIRED":
      return t("Start a new upload session before retrying.");
    case "DRIVE_UPLOAD_SESSION_FAILED":
      return t("Clarity Cloud could not start the video upload.");
    case "DRIVE_TRANSFER_STATE_FAILED":
      return t("Clarity Cloud could not store the upload session.");
    case "DRIVE_UPLOAD_VERIFY_FAILED":
      return t("Clarity Cloud could not verify the uploaded video.");
    case "DRIVE_UPLOAD_INTERRUPTED":
      return t("Video upload was interrupted.");
    case "SAVED_VIDEO_SOURCE_MISSING":
      return t("Source unavailable.");
    case "CLARITY_CLOUD_IMPORT_NOT_READY":
      return t("This video is not ready to download from Clarity Cloud.");
    case "CLARITY_CLOUD_IMPORT_VERIFY_FAILED":
      return t("Imported video did not match the Clarity Cloud catalogue.");
    case "CLARITY_CLOUD_IMPORT_RECEIPT_FAILED":
      return t("Local import was verified, but the receipt could not be recorded.");
    case "CLARITY_CLOUD_PROVIDER_FAILED":
      return t("Your local video is safe. The cloud transfer service could not be reached.");
    case "TRANSFER_PAUSED":
      return t("Transfer paused.");
    default:
      return fallback && !/[{}<>]|https?:\/\//i.test(fallback) && fallback.length < 140
        ? fallback
        : t("Clarity Cloud could not complete the upload.");
  }
}

// An ISO timestamp -> "15 Jul 2026". Used where only the day matters.
export function formatTimestampForDisplay(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(activeLocale(), { day: "numeric", month: "short", year: "numeric" });
}

/** Seconds to "m:ss", for the duration badge on a shelf card. */
export function formatClipDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/* The two-line date cell every player profile row leads with: the day on top,
 * the clock time under it. Returns both parts rather than a formatted string
 * because the row prints them at different weights. `time` is empty for a
 * record that only has a date, and the cell then shows the day on its own. */
export function profileWhenParts(value?: string | null) {
  if (!value) return { day: "", time: "" };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { day: "", time: "" };
  return {
    day: date.toLocaleDateString(activeLocale(), { day: "numeric", month: "short" }),
    time: date.toLocaleTimeString(activeLocale(), { hour: "2-digit", minute: "2-digit", hour12: false }),
  };
}
