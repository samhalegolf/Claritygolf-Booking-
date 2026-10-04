export type DiagnosticStatus = "started" | "success" | "failed" | "warning" | "skipped" | "verified";
export type DiagnosticSystem =
  | "supabase"
  | "auth"
  | "calendar"
  | "booking"
  | "publicBooking"
  | "save"
  | "email"
  | "notification"
  | "admin"
  | "ui"
  | "cache"
  | "reload";
export type DiagnosticTab = "overview" | "database" | "calendar" | "cache" | "errors" | "raw";
export type DiagnosticEvent = {
  id: string;
  timestamp: string;
  system: DiagnosticSystem;
  action: string;
  phase: string;
  status: DiagnosticStatus;
  durationMs?: number;
  route?: string;
  functionName?: string;
  errorCode?: string;
  humanMessage?: string;
  httpStatus?: number;
  expectedAccountId?: string;
  returnedAccountId?: string;
  objectType?: string;
  objectId?: string;
  details?: Record<string, string | number | boolean>;
};
export type DiagnosticEventInput = Omit<DiagnosticEvent, "id" | "timestamp" | "details"> & {
  id?: string;
  timestamp?: string;
  details?: Record<string, unknown>;
};
export type DiagnosticTimerInput = {
  system: DiagnosticSystem;
  action: string;
  phase?: string;
  route?: string;
  functionName?: string;
  expectedAccountId?: string;
  objectType?: string;
  objectId?: string;
  details?: Record<string, unknown>;
};
export type DiagnosticTimer = DiagnosticTimerInput & { id: string; startedAt: number };

export const DIAGNOSTIC_EVENT_LIMIT = 150;

export function createDiagnosticId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `diag-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function sanitizeDiagnosticDetails(details?: Record<string, unknown>): Record<string, string | number | boolean> | undefined {
  if (!details) return undefined;
  const sanitized: Record<string, string | number | boolean> = {};
  Object.entries(details).forEach(([key, value]) => {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes("token") ||
      lowerKey.includes("secret") ||
      lowerKey.includes("authorization") ||
      lowerKey.includes("password") ||
      lowerKey.includes("emailbody") ||
      lowerKey.includes("body")
    ) {
      return;
    }
    if (typeof value === "string") sanitized[key] = value.slice(0, 160);
    if (typeof value === "number" && Number.isFinite(value)) sanitized[key] = value;
    if (typeof value === "boolean") sanitized[key] = value;
  });
  return Object.keys(sanitized).length ? sanitized : undefined;
}

export function diagnosticDurationBand(event: Pick<DiagnosticEvent, "details" | "durationMs">) {
  const durationMs = event.durationMs;
  if (typeof durationMs !== "number") return "";
  if (event.details?.blockingCalendar === false || event.details?.backgroundRefresh === true) {
    return durationMs < 1000 ? "Okay" : "Background";
  }
  if (durationMs < 300) return "Fast";
  if (durationMs < 1000) return "Okay";
  if (durationMs < 3000) return "Slow";
  return "Problem";
}
