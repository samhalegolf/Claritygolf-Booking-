/**
 * What the Resources section on a booking card should say.
 *
 * One place, no DOM, no React, so every outcome the server can produce has a
 * decided answer that can be tested. The panel this feeds used to write its own
 * error into a button's textContent and then re-render over the top of it, so
 * the coach was shown either nothing or the wrong thing:
 *
 *   - a 207 (the attempt ran and Optix refused) threw nothing and said nothing;
 *   - a thrown error was written to the button and wiped by the refresh in the
 *     same tick;
 *   - a 401 came back as an empty record list, which is indistinguishable from
 *     "this lesson has no bay yet" unless you know to look.
 *
 * Every branch below therefore ends in a title someone can act on, and details
 * are only offered when there is genuinely something more to read.
 */

export type ResourceTone = "ok" | "idle" | "warn" | "error";

export type ResourceOutcome = {
  tone: ResourceTone;
  /** Short. This is the red line when tone is "error". */
  title: string;
  /** One sentence: what it means, or what to do about it. */
  line: string;
  /** Empty when the title and line already say everything. */
  details: string;
  canRetry: boolean;
  /**
   * A timeout leaves the result genuinely unknown: Optix may have taken the bay
   * without Clarity hearing back, and the booking id was never saved, so a
   * plain retry can hold a second bay. The panel turns this into a deliberate
   * second press rather than a normal Book bay.
   */
  needsOptixCheckFirst: boolean;
  /**
   * Set when the failure being described is old news rather than the current
   * state. The panel prefixes the date and drops the red: opening a lesson
   * whose last attempt failed weeks ago should say "no bay yet, press the
   * button", not lead with a red box about something that is not happening.
   */
  staleAttemptAt: string | null;
};

/** A row of optix_booking_sync as /api/optix-booking-status returns it. */
export type ResourceStatusRecord = {
  calendarItemId?: string;
  resourceId?: string;
  bayName?: string;
  hasSyncRow?: boolean;
  syncStatus?: string;
  errorCode?: string;
  errorMessage?: string;
  optixBookingId?: string;
  optixBookingSessionId?: string;
  lastAttemptedAt?: string | null;
  lastSyncedAt?: string | null;
  updatedAt?: string | null;
};

export type BookAttempt =
  /** fetch itself rejected: the request never got an answer. */
  | { kind: "unreachable"; error?: unknown }
  | { kind: "response"; status: number; payload: any };

const STALE_FAILURE_MS = 60 * 60 * 1000;

/**
 * The failure vocabulary is OptixSyncFailureCode in optix-client.mts plus the
 * two states auto-select adds. Anything not listed still gets a title and
 * carries its raw code in the details -- an unknown code is a reason to say
 * less, never a reason to say nothing.
 */
const FAILURES: Record<string, { title: string; line: string }> = {
  resource_conflict: {
    title: "No bay free",
    line: "Every bay set for this lesson type is already booked at this time.",
  },
  token_expired: {
    title: "Optix login expired",
    line: "Clarity's Optix access token is no longer valid. The details name which one to replace.",
  },
  unauthorized: {
    title: "Optix refused access",
    line: "The Optix account Clarity books with is not allowed to make this booking.",
  },
  validation_failed: {
    title: "Optix rejected the details",
    line: "Optix would not accept this booking's times or fields.",
  },
  timeout: {
    title: "Optix did not answer",
    line: "The result is unknown — Optix may still have taken the bay. Check Optix before booking again.",
  },
  not_configured: {
    title: "No bays for this lesson type",
    line: "Give this lesson type a resource profile in Integrations, then book the bay.",
  },
  remote_error: {
    title: "Optix returned an error",
    line: "Optix refused the request. Its own words are in the details.",
  },
};

export function bayLabel(record: ResourceStatusRecord | null | undefined): string {
  if (!record) return "";
  const name = String(record.bayName || "").trim();
  if (name) return name;
  const id = String(record.resourceId || "").trim();
  // Naming the id beats "Resource booked": it is what you type into Optix to
  // find the thing Clarity is talking about.
  return id ? `Resource ${id}` : "";
}

/**
 * Everything worth reading that is not already in the title or the line.
 * Returns "" when there is nothing, which is what stops the panel rendering a
 * Details disclosure that opens onto an empty box.
 */
export function buildDetails(record: ResourceStatusRecord | null | undefined): string {
  if (!record) return "";
  const rows: Array<[string, string]> = [
    ["Error code", String(record.errorCode || "")],
    ["Optix said", String(record.errorMessage || "")],
    ["Booking ID", String(record.optixBookingId || "")],
    ["Session ID", String(record.optixBookingSessionId || "")],
    ["Bay tried", String(record.resourceId || "")],
  ];
  return rows
    .filter(([, value]) => value.trim())
    .map(([label, value]) => `${label}: ${value.trim()}`)
    .join("\n");
}

function failure(
  code: string,
  record: ResourceStatusRecord | null,
  overrides: Partial<ResourceOutcome> = {},
): ResourceOutcome {
  const known = FAILURES[code];
  return {
    tone: "error",
    title: known?.title || "Optix booking failed",
    line: known?.line || "The attempt did not complete. The details carry what Optix returned.",
    details: buildDetails(record),
    canRetry: true,
    needsOptixCheckFirst: code === "timeout",
    staleAttemptAt: null,
    ...overrides,
  };
}

/**
 * The state of a lesson's bay as stored, with no attempt in flight.
 *
 * `nowMs` is passed rather than read, so the stale-failure rule is testable
 * without waiting an hour.
 */
export function describeStatusRecord(
  record: ResourceStatusRecord | null | undefined,
  nowMs: number = Date.now(),
): ResourceOutcome {
  const base: ResourceOutcome = {
    tone: "idle",
    title: "No bay booked",
    line: "No bay has been held for this lesson yet.",
    details: "",
    canRetry: true,
    needsOptixCheckFirst: false,
    staleAttemptAt: null,
  };

  if (!record || record.hasSyncRow === false || !record.syncStatus || record.syncStatus === "none") {
    return base;
  }

  const status = String(record.syncStatus);
  const code = String(record.errorCode || "");

  if (status === "synced") {
    const label = bayLabel(record);
    return {
      ...base,
      tone: "ok",
      title: label || "Bay held",
      line: label ? `${label} is held in Optix for this lesson.` : "A bay is held in Optix for this lesson.",
      canRetry: false,
    };
  }

  if (status === "cancelled") {
    // Two very different things used to share this status. Bays being switched
    // off for a lesson type is a setting working as configured; a released bay
    // is the ordinary aftermath of a reschedule and is exactly when the coach
    // wants the button. The old card offered no button for either.
    if (code === "optix_disabled") {
      return {
        ...base,
        title: "Bays are off for this lesson type",
        line: "Turn them on in Integrations → resource profiles if this lesson should hold a bay.",
        canRetry: false,
      };
    }
    return {
      ...base,
      title: "No bay held",
      line: "The bay for this lesson was released. Book bay holds a new one.",
    };
  }

  if (status === "failed" || status === "token_expired") {
    const attemptedAt = record.lastAttemptedAt || record.updatedAt || null;
    const attemptAge = attemptedAt ? nowMs - Date.parse(String(attemptedAt)) : Number.NaN;
    const stale = Number.isFinite(attemptAge) && attemptAge > STALE_FAILURE_MS;
    return failure(code, record, stale ? { tone: "warn", staleAttemptAt: attemptedAt } : {});
  }

  return base;
}

/**
 * The result of pressing Book bay.
 *
 * 200 with `ok: true` is the only success: the server sets it solely when the
 * sync row reached 'synced'. A 207 means the attempt genuinely ran and Optix
 * said no, which is a real answer and gets a real message rather than silence.
 */
export function describeBookAttempt(attempt: BookAttempt): ResourceOutcome {
  if (attempt.kind === "unreachable") {
    return {
      tone: "error",
      title: "Could not reach Clarity",
      line: "The request never got an answer. Check your connection, then press Book bay again.",
      details: attempt.error instanceof Error ? attempt.error.message : "",
      canRetry: true,
      needsOptixCheckFirst: false,
      staleAttemptAt: null,
    };
  }

  const { status, payload } = attempt;
  const record: ResourceStatusRecord | null = payload?.result || null;
  const serverMessage = String(payload?.message || "").trim();

  if (status === 401) {
    return {
      tone: "error",
      title: "Signed out",
      line: "Your admin session expired. Sign in again, then book the bay.",
      details: "",
      canRetry: false,
      needsOptixCheckFirst: false,
      staleAttemptAt: null,
    };
  }

  if (status === 403) {
    return {
      tone: "error",
      title: "Not allowed",
      line: "This login cannot book bays for this business.",
      details: serverMessage,
      canRetry: false,
      needsOptixCheckFirst: false,
      staleAttemptAt: null,
    };
  }

  if (status === 400) {
    return {
      tone: "error",
      title: "Clarity sent a bad request",
      line: "Optix was never asked. This is a Clarity bug rather than an Optix one.",
      details: serverMessage || String(payload?.error || ""),
      canRetry: false,
      needsOptixCheckFirst: false,
      staleAttemptAt: null,
    };
  }

  // The env-level "not configured" and the lesson-type-level one share a code
  // but not a fix, and the status separates them: 503 is Clarity's Optix
  // credentials missing, 207 is this lesson type having no bays.
  if (status === 503) {
    return {
      tone: "error",
      title: "Optix isn't set up",
      line: serverMessage || "Clarity has no Optix credentials configured.",
      details: "",
      canRetry: false,
      needsOptixCheckFirst: false,
      staleAttemptAt: null,
    };
  }

  if (status === 200 && payload?.ok === true) {
    const label = bayLabel(record);
    if (payload?.alreadyBooked === true) {
      return {
        tone: "ok",
        title: "Already booked",
        line: label ? `This lesson already holds ${label}.` : "This lesson already holds a bay.",
        details: "",
        canRetry: false,
        needsOptixCheckFirst: false,
        staleAttemptAt: null,
      };
    }
    return {
      tone: "ok",
      title: label || "Bay held",
      line: label ? `${label} is now held in Optix.` : "The bay is now held in Optix.",
      details: "",
      canRetry: false,
      needsOptixCheckFirst: false,
      staleAttemptAt: null,
    };
  }

  if (status === 207 || (status === 200 && payload?.ok === false)) {
    const code = String(record?.errorCode || payload?.error || "");
    // 207 not_configured is the lesson type having no bays, which is the
    // wording FAILURES already carries. Nothing to override.
    return failure(code, record);
  }

  if (status === 404 || String(payload?.error || "") === "appointment_not_found") {
    return {
      tone: "error",
      title: "Lesson not found",
      line: "Clarity could not find this lesson to book a bay against. Reload the calendar.",
      details: serverMessage,
      canRetry: false,
      needsOptixCheckFirst: false,
      staleAttemptAt: null,
    };
  }

  return failure(String(payload?.error || record?.errorCode || ""), record, {
    details: [buildDetails(record), serverMessage].filter(Boolean).join("\n"),
  });
}
