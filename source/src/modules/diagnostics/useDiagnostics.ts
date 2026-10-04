import { useState } from "react";
import {
  createDiagnosticId,
  DIAGNOSTIC_EVENT_LIMIT,
  DiagnosticEvent,
  DiagnosticEventInput,
  DiagnosticStatus,
  DiagnosticTab,
  DiagnosticTimer,
  DiagnosticTimerInput,
  sanitizeDiagnosticDetails,
} from "./diagnosticsModel";

/**
 * The in-app diagnostics log: what the app tried, how long it took and what
 * failed, newest first and capped at DIAGNOSTIC_EVENT_LIMIT. Load, save and
 * auth code record into it; the Diagnostics panel reads the summaries below.
 */
export function useDiagnostics() {
  const [diagnosticEvents, setDiagnosticEvents] = useState<DiagnosticEvent[]>([]);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnosticsTab, setDiagnosticsTab] = useState<DiagnosticTab>("overview");

  function trackDiagnosticEvent(event: DiagnosticEventInput) {
    const next: DiagnosticEvent = {
      ...event,
      id: event.id || createDiagnosticId(),
      timestamp: event.timestamp || new Date().toISOString(),
      details: sanitizeDiagnosticDetails(event.details),
    };
    setDiagnosticEvents((current) => [next, ...current].slice(0, DIAGNOSTIC_EVENT_LIMIT));
  }

  function startDiagnosticTimer(input: DiagnosticTimerInput): DiagnosticTimer {
    const timer: DiagnosticTimer = {
      ...input,
      id: createDiagnosticId(),
      phase: input.phase || "request",
      startedAt: performance.now(),
    };
    trackDiagnosticEvent({
      ...timer,
      phase: timer.phase || "request",
      status: "started",
    });
    return timer;
  }

  function finishDiagnosticTimer(
    timer: DiagnosticTimer,
    status: DiagnosticStatus,
    extra: Partial<DiagnosticEventInput> = {},
  ) {
    trackDiagnosticEvent({
      system: timer.system,
      action: timer.action,
      phase: extra.phase || timer.phase || "request",
      status,
      route: extra.route || timer.route,
      functionName: extra.functionName || timer.functionName,
      errorCode: extra.errorCode,
      humanMessage: extra.humanMessage,
      httpStatus: extra.httpStatus,
      expectedAccountId: extra.expectedAccountId || timer.expectedAccountId,
      returnedAccountId: extra.returnedAccountId,
      objectType: extra.objectType || timer.objectType,
      objectId: extra.objectId || timer.objectId,
      durationMs: Math.max(0, Math.round(performance.now() - timer.startedAt)),
      details: { ...(timer.details ?? {}), ...(extra.details ?? {}) },
    });
  }

  function trackDiagnosticError(
    input: DiagnosticTimerInput & {
      errorCode: string;
      humanMessage: string;
      httpStatus?: number;
      returnedAccountId?: string;
    },
  ) {
    trackDiagnosticEvent({
      system: input.system,
      action: input.action,
      phase: input.phase || "request",
      status: "failed",
      route: input.route,
      functionName: input.functionName,
      errorCode: input.errorCode,
      humanMessage: input.humanMessage,
      httpStatus: input.httpStatus,
      expectedAccountId: input.expectedAccountId,
      returnedAccountId: input.returnedAccountId,
      objectType: input.objectType,
      objectId: input.objectId,
      details: input.details,
    });
  }

  function trackDiagnosticMilestone(input: DiagnosticEventInput & { startedAt?: number }) {
    const { startedAt, ...event } = input;
    trackDiagnosticEvent({
      ...event,
      durationMs:
        typeof startedAt === "number"
          ? Math.max(0, Math.round(performance.now() - startedAt))
          : input.durationMs,
    });
  }
  const failedDiagnosticEvents = diagnosticEvents.filter((event) => event.status === "failed");
  const latestDiagnosticEvent = diagnosticEvents[0];
  const latestDiagnosticError = failedDiagnosticEvents[0];
  const databaseDiagnosticEvents = diagnosticEvents.filter((event) =>
    ["supabase", "save", "calendar", "auth"].includes(event.system),
  );
  const calendarDiagnosticEvents = diagnosticEvents.filter(
    (event) =>
      event.system === "calendar" ||
      event.action.includes("CALENDAR") ||
      event.action.includes("BOOKING_CARDS") ||
      event.route?.includes("calendar"),
  );
  const cacheDiagnosticEvents = diagnosticEvents.filter((event) =>
    ["cache", "reload"].includes(event.system),
  );
  const diagnosticEventsForActiveTab =
    diagnosticsTab === "errors"
      ? failedDiagnosticEvents
      : diagnosticsTab === "database"
        ? databaseDiagnosticEvents
        : diagnosticsTab === "calendar"
          ? calendarDiagnosticEvents
          : diagnosticsTab === "cache"
            ? cacheDiagnosticEvents
            : diagnosticEvents;
  const averageDiagnosticDuration = Math.round(
    diagnosticEvents.reduce((total, event) => total + (event.durationMs ?? 0), 0) /
      Math.max(1, diagnosticEvents.filter((event) => typeof event.durationMs === "number").length),
  );
  const slowestDiagnosticEvent = diagnosticEvents.reduce<DiagnosticEvent | null>((slowest, event) => {
    if (typeof event.durationMs !== "number") return slowest;
    if (!slowest || (slowest.durationMs ?? 0) < event.durationMs) return event;
    return slowest;
  }, null);
  const latestReloadEvent = diagnosticEvents.find((event) => event.system === "reload");
  const diagnosticsBySystem = diagnosticEvents.reduce<Record<string, number>>((counts, event) => {
    counts[event.system] = (counts[event.system] ?? 0) + 1;
    return counts;
  }, {});

  return {
    diagnosticEvents,
    diagnosticsOpen,
    setDiagnosticsOpen,
    diagnosticsTab,
    setDiagnosticsTab,
    trackDiagnosticEvent,
    startDiagnosticTimer,
    finishDiagnosticTimer,
    trackDiagnosticError,
    trackDiagnosticMilestone,
    failedDiagnosticEvents,
    latestDiagnosticEvent,
    latestDiagnosticError,
    diagnosticEventsForActiveTab,
    averageDiagnosticDuration,
    slowestDiagnosticEvent,
    latestReloadEvent,
    diagnosticsBySystem,
  };
}

export type Diagnostics = ReturnType<typeof useDiagnostics>;
