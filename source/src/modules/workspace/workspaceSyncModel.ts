import { CalendarItem } from "../calendar/calendarModel";
import { EmailSendResult, NotificationRecord } from "../notifications/notificationModel";

export type AdminWorkspaceLoadStatus = "idle" | "loading" | "loaded" | "error";
export type AdminSaveOwner = "lesson_complete" | "upsert_item" | "calendar_delete" | "locations" | "coaches" | "settings";
export type BookingDeleteDiagnostics = {
  code?: string;
  operationOwner?: string;
  route?: string;
  httpStatus?: number;
  bookingId?: string;
  calendarItemId?: string;
  personId?: string;
  email?: string;
  backendMessage?: string;
  verificationResult?: string;
  [key: string]: unknown;
};
export type CalendarStateSaveResponse = {
  message?: string;
  error?: string;
  detail?: string;
  details?: unknown;
  diagnostics?: BookingDeleteDiagnostics;
  expectedUpdatedAt?: string;
  backendUpdatedAt?: string;
  conflictSource?: string;
  notifications?: NotificationRecord[];
  notificationResults?: EmailSendResult[];
  updatedAt?: string;
  items?: CalendarItem[];
  // Whether the save's Google push was queued. The connection status itself is
  // per coach and read by the coach profile, not carried on a calendar save.
  googleCalendarSync?: { ok?: boolean; error?: string };
  syncKey?: string;
  warnings?: string[];
  /** Things that went right but the coach should know about -- a returned pass credit. */
  notices?: string[];
};

export type WorkspaceConfigRecord = {
  id?: string;
  accountId?: string;
  name?: string;
  displayName?: string;
};

export type WorkspaceConfigDiagnostic = {
  activeAccountId: string;
  expected: Array<{ id: string; name: string }>;
  putStatus?: number;
  putRecords?: WorkspaceConfigRecord[];
  getStatus?: number;
  getRecords?: WorkspaceConfigRecord[];
  calendarStatus?: number;
  calendarRecords?: WorkspaceConfigRecord[];
};

export type WorkspaceApiFailureDetail = {
  error?: string;
  message?: string;
  details?: string;
  failed?: string;
  text?: string;
  statusText?: string;
};

export function generateSyncKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `cg_${crypto.randomUUID().replaceAll("-", "")}`;
  }
  return `cg_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}
