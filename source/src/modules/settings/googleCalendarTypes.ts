// What the Google Calendar sync reports: its rules, status, import rules and
// the debug log the Developer section shows.

/** What goes from Clarity to this coach's Google Calendar. Mirrors google-calendar-export-rules.mts. */
export type GoogleCalendarExportRules = {
  lessons: boolean;
  blocks: boolean;
  unavailable: boolean;
  excludedServiceIds: string[];
  clientDetails: boolean;
};
export type GoogleCalendarSyncStatus = {
  configured: boolean;
  connected: boolean;
  accountId?: string;
  calendarId: string;
  autoSync: boolean;
  accountEmail: string;
  lastSyncAt: string;
  lastSyncStatus: string;
  lastSyncError: string;
  manualOnly?: boolean;
  connectedAt: string;
  redirectUri: string;
  scope: string;
  grantedScopes?: string[];
  missingScopes?: string[];
  connectionStatus?: string;
  /** Whose calendar this is. Google Calendar is connected per coach. */
  coachId?: string;
  sources?: GoogleCalendarSourceStatus[];
  sourceListError?: string;
  importRules?: GoogleCalendarImportRule[];
  exportRules?: GoogleCalendarExportRules;
  ok?: boolean;
  skipped?: boolean;
};
/** A calendar on the connected Google account, offered as a scope for a rule. */
export type GoogleCalendarSourceStatus = {
  id: string;
  name: string;
  primary: boolean;
  hidden: boolean;
  accessRole: string;
};
/**
 * One external source the coach wants pulled in — "Golf HQ Portal" and the
 * spellings that identify it. Keywords narrow further; empty means everything
 * from that source. See netlify/functions/_shared/google-calendar-import-rules.
 */
export type GoogleCalendarImportRule = {
  id: string;
  name: string;
  /**
   * Held as the raw text the coach typed, not a parsed list.
   *
   * Splitting on every keystroke made the field unusable: trimming ate the
   * space in "Golf HQ" and the split ate the comma the moment it was typed, so
   * neither could ever be entered. The backend already accepts a comma or
   * newline separated string and does the splitting once, on save.
   */
  aliases: string;
  keywords: string;
  /** Calendars to scan. Empty means every calendar on the account. */
  calendarIds: string[];
  showLabel: boolean;
  enabled: boolean;
};
export type GoogleCalendarDebugRequest = {
  method: string;
  url: string;
  calendarId: string;
  eventId: string;
  itemId: string;
  itemLabel: string;
  payload: unknown;
};
export type GoogleCalendarDebugError = {
  stage: string;
  message: string;
  httpStatus: number;
  httpStatusText: string;
  googleCode: string;
  googleStatus: string;
  googleReason: string;
  googleDomain: string;
  googleMessage: string;
  googleErrors: unknown[];
  providerCode: string;
  rawBody: string;
};
export type GoogleCalendarDebugEntry = {
  id: string;
  trigger: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outcome: "success" | "failed" | "skipped";
  reason: string;
  stage: string;
  mode: "full" | "targeted";
  calendarId: string;
  accountEmail: string;
  itemCount: number;
  upserted: number;
  deleted: number;
  unchanged: number;
  retries: number;
  changes: Array<{ id: string; action: string }>;
  request: GoogleCalendarDebugRequest | null;
  requestIsSample: boolean;
  error: GoogleCalendarDebugError | null;
};
export type GoogleCalendarDebugLog = {
  enabled: boolean;
  maxEntries: number;
  autoSync: boolean;
  manualOnly: boolean;
  calendarId: string;
  entries: GoogleCalendarDebugEntry[];
};
export type GoogleCalendarActionState = "idle" | "connecting" | "saving" | "syncing" | "disconnecting";

export type GoogleDriveActionState = "idle" | "connecting" | "testing" | "disconnecting";
