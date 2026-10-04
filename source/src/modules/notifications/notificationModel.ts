import { activeLocale } from "../../lib/activeCountry";
import { t } from "../../lib/i18n";
import { safeText } from "../../lib/text";
import { defaultWorkspaceAccountFromCoachAccount } from "../workspace/workspaceModel";

/**
 * Sent-message records (booking confirmations, reminders and the rest) as the
 * coach app shows them: cleaning what the API returns, and the labels.
 */

function cleanNotificationRecord(notification: Partial<NotificationRecord> & { id?: unknown } = {}): NotificationRecord {
  return {
    id: safeText(notification.id),
    accountId: safeText(notification.accountId) || defaultWorkspaceAccountFromCoachAccount().id,
    personKey: safeText(notification.personKey),
    calendarItemId: safeText(notification.calendarItemId),
    recipient: safeText(notification.recipient),
    subject: safeText(notification.subject),
    kind: safeText(notification.kind),
    status: safeText(notification.status),
    provider: safeText(notification.provider),
    providerId: safeText(notification.providerId),
    notificationJobId: safeText(notification.notificationJobId),
    error: safeText(notification.error),
    createdAt: safeText(notification.createdAt),
  };
}

export function cleanNotificationRecords(notifications: unknown[]): NotificationRecord[] {
  return notifications.map((notification) => cleanNotificationRecord((notification ?? {}) as Partial<NotificationRecord>));
}

export type NotificationRecord = {
  id: string;
  accountId?: string;
  personKey: string;
  calendarItemId: string;
  recipient: string;
  subject: string;
  kind: string;
  status: string;
  provider: string;
  providerId: string;
  notificationJobId: string;
  error: string;
  createdAt: string;
};

export type EmailSendResult = {
  channel: string;
  sent?: boolean;
  id?: string;
  reason?: string;
  error?: string;
  recipient?: string;
  subject?: string;
  kind?: string;
  status?: string;
};

export function notificationKindLabel(kind = "") {
  if (kind.includes("coach")) return t("Coach notification");
  if (kind.includes("admin")) return t("Admin notification");
  if (kind.includes("client")) return t("Client email");
  if (kind.includes("reschedule")) return t("Reschedule email");
  if (kind.includes("test")) return t("Test email");
  return t("Email receipt");
}

export function notificationStatusLabel(notification: Pick<NotificationRecord, "status" | "error">) {
  if (notification.status === "delivered") return t("Delivered");
  if (notification.status === "opened") return t("Opened");
  if (notification.status === "clicked") return t("Clicked");
  if (notification.status === "sent") return t("Sent to provider");
  if (notification.status === "delayed") return notification.error ? t("Delayed · {error}", { error: notification.error.replaceAll("_", " ") }) : t("Delayed");
  if (notification.status === "bounced") return notification.error ? t("Bounced · {error}", { error: notification.error.replaceAll("_", " ") }) : t("Bounced");
  if (notification.status === "suppressed") return notification.error ? t("Suppressed · {error}", { error: notification.error.replaceAll("_", " ") }) : t("Suppressed");
  if (notification.status === "complained") return notification.error ? t("Complained · {error}", { error: notification.error.replaceAll("_", " ") }) : t("Complained");
  if (notification.status === "skipped") return notification.error ? t("Skipped · {error}", { error: notification.error.replaceAll("_", " ") }) : t("Skipped");
  if (notification.status === "failed") return notification.error ? t("Failed · {error}", { error: notification.error.replaceAll("_", " ") }) : t("Failed");
  return notification.status || t("Pending");
}

export function notificationTone(status = "") {
  if (["delivered", "opened", "clicked"].includes(status)) return "delivered";
  if (status === "sent") return "sent";
  if (["bounced", "failed", "complained", "suppressed"].includes(status)) return "failed";
  if (status === "skipped") return "skipped";
  if (status === "delayed") return "delayed";
  return "pending";
}

export function notificationTimeLabel(createdAt = "") {
  if (!createdAt) return "";
  const time = new Date(createdAt);
  return Number.isNaN(time.getTime()) ? "" : time.toLocaleString(activeLocale());
}
