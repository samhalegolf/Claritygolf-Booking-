import { t } from "./lib/i18n";
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

/**
 * The system that keeps this business's bays, as the card names it. Optix is
 * named only for a business that uses Optix; anyone else's is "your booking
 * system", because Clarity does not know what their software is called.
 */
export type ResourceSystem = { provider: "optix" | "webhook"; name: string };

const OPTIX_SYSTEM: ResourceSystem = { provider: "optix", name: "Optix" };
export const WEBHOOK_SYSTEM: ResourceSystem = { provider: "webhook", name: t("your booking system") };

export function resourceSystemFor(provider: string | null | undefined): ResourceSystem {
  return provider === "optix" ? OPTIX_SYSTEM : WEBHOOK_SYSTEM;
}

function cap(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

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
  needsSystemCheckFirst: boolean;
  /**
   * Set when the failure being described is old news rather than the current
   * state. The panel prefixes the date and drops the red: opening a lesson
   * whose last attempt failed weeks ago should say "no bay yet, press the
   * button", not lead with a red box about something that is not happening.
   */
  staleAttemptAt: string | null;
};

/** A ledger row as /api/resource-status returns it. */
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
  /** Which system made this hold, when there is one. */
  provider?: string;
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
function failures(system: ResourceSystem): Record<string, { title: string; line: string }> {
  const name = system.name;
  const Name = cap(name);
  const setUp =
    system.provider === "optix"
      ? t("Give this lesson type a resource profile in Integrations, then book the bay.")
      : t("Connect it in Settings › Booking › Bay & room system, then book the bay.");
  return {
    resource_conflict: {
      title: t("No bay free"),
      line: t("Every bay set for this lesson type is already booked at this time."),
    },
    resource_unavailable: {
      title: t("No bay free"),
      line: t("{Name} has no bay free at this time.", { Name }),
    },
    token_expired: {
      title: t("{Name} login expired", { Name }),
      line: t("Clarity's {name} access token is no longer valid. The details name which one to replace.", { name }),
    },
    unauthorized: {
      title: t("{Name} refused access", { Name }),
      line: t("The {name} account Clarity books with is not allowed to make this booking.", { name }),
    },
    validation_failed: {
      title: t("{Name} rejected the details", { Name }),
      line: t("{Name} would not accept this booking's times or fields.", { Name }),
    },
    timeout: {
      title: t("{Name} did not answer", { Name }),
      line: t("The result is unknown — {name} may still have taken the bay. Check {name} before booking again.", { name }),
    },
    network_error: {
      title: t("Could not reach {name}", { name }),
      line: t("Clarity could not connect to {name}. Check the address in Settings, then try again.", { name }),
    },
    invalid_reply: {
      title: t("{Name} answered oddly", { Name }),
      line: t("{Name} replied, but not in the shape Clarity expects. The details say what was wrong.", { Name }),
    },
    not_configured: {
      title: system.provider === "optix" ? t("No bays for this lesson type") : t("{Name} isn't connected", { Name }),
      line: setUp,
    },
    remote_error: {
      title: t("{Name} returned an error", { Name }),
      line: t("{Name} refused the request. Its own words are in the details.", { Name }),
    },
  };
}

export function bayLabel(record: ResourceStatusRecord | null | undefined): string {
  if (!record) return "";
  const name = String(record.bayName || "").trim();
  if (name) return name;
  const id = String(record.resourceId || "").trim();
  // Naming the id beats "Resource booked": it is what you type into the other
  // system to find the thing Clarity is talking about.
  return id ? t("Resource {id}", { id }) : "";
}

/**
 * Everything worth reading that is not already in the title or the line.
 * Returns "" when there is nothing, which is what stops the panel rendering a
 * Details disclosure that opens onto an empty box.
 */
export function buildDetails(
  record: ResourceStatusRecord | null | undefined,
  system: ResourceSystem = OPTIX_SYSTEM,
): string {
  if (!record) return "";
  const rows: Array<[string, string]> = [
    [t("Error code"), String(record.errorCode || "")],
    [t("{name} said", { name: cap(system.name) }), String(record.errorMessage || "")],
    [t("Booking ID"), String(record.optixBookingId || "")],
    [t("Session ID"), String(record.optixBookingSessionId || "")],
    [t("Bay tried"), String(record.resourceId || "")],
  ];
  return rows
    .filter(([, value]) => value.trim())
    .map(([label, value]) => `${label}: ${value.trim()}`)
    .join("\n");
}

function failure(
  code: string,
  record: ResourceStatusRecord | null,
  system: ResourceSystem,
  overrides: Partial<ResourceOutcome> = {},
): ResourceOutcome {
  // An HTTP status from a webhook system arrives as http_<status>.
  const known = failures(system)[code.startsWith("http_") ? "remote_error" : code];
  return {
    tone: "error",
    title: known?.title || (system.provider === "optix" ? t("Optix booking failed") : t("Bay booking failed")),
    line: known?.line || t("The attempt did not complete. The details carry what {name} returned.", { name: system.name }),
    details: buildDetails(record, system),
    canRetry: true,
    needsSystemCheckFirst: code === "timeout",
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
  system: ResourceSystem = resourceSystemFor(record?.provider || "optix"),
): ResourceOutcome {
  const base: ResourceOutcome = {
    tone: "idle",
    title: t("No bay booked"),
    line: t("No bay has been held for this lesson yet."),
    details: "",
    canRetry: true,
    needsSystemCheckFirst: false,
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
      title: label || t("Bay held"),
      line: label
        ? t("{label} is held in {name} for this lesson.", { label, name: system.name })
        : t("A bay is held in {name} for this lesson.", { name: system.name }),
      canRetry: false,
    };
  }

  if (status === "pending") {
    // Queued when the lesson was saved; Clarity books it in the background
    // and a scheduled sweep catches whatever the background did not answer.
    // The button stays: pressing it books the bay now and settles the row.
    return {
      ...base,
      title: t("Bay booking queued"),
      line: t("Clarity is booking a bay for this lesson in the background. Book bay does it right now instead."),
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
        title: t("Bays are off for this lesson type"),
        line:
          system.provider === "optix"
            ? t("Turn them on in Integrations → resource profiles if this lesson should hold a bay.")
            : t("Tick “Holds one of the location's resources” on the lesson type if it should hold a bay."),
        canRetry: false,
      };
    }
    return {
      ...base,
      title: t("No bay held"),
      line: t("The bay for this lesson was released. Book bay holds a new one."),
    };
  }

  if (status === "failed" || status === "token_expired") {
    const attemptedAt = record.lastAttemptedAt || record.updatedAt || null;
    const attemptAge = attemptedAt ? nowMs - Date.parse(String(attemptedAt)) : Number.NaN;
    const stale = Number.isFinite(attemptAge) && attemptAge > STALE_FAILURE_MS;
    return failure(code, record, system, stale ? { tone: "warn", staleAttemptAt: attemptedAt } : {});
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
export function describeBookAttempt(attempt: BookAttempt, system: ResourceSystem = OPTIX_SYSTEM): ResourceOutcome {
  if (attempt.kind === "unreachable") {
    return {
      tone: "error",
      title: t("Could not reach Clarity"),
      line: t("The request never got an answer. Check your connection, then press Book bay again."),
      details: attempt.error instanceof Error ? attempt.error.message : "",
      canRetry: true,
      needsSystemCheckFirst: false,
      staleAttemptAt: null,
    };
  }

  const { status, payload } = attempt;
  const record: ResourceStatusRecord | null = payload?.result || null;
  const serverMessage = String(payload?.message || "").trim();

  if (status === 401) {
    return {
      tone: "error",
      title: t("Signed out"),
      line: t("Your admin session expired. Sign in again, then book the bay."),
      details: "",
      canRetry: false,
      needsSystemCheckFirst: false,
      staleAttemptAt: null,
    };
  }

  if (status === 403) {
    return {
      tone: "error",
      title: t("Not allowed"),
      line: t("This login cannot book bays for this business."),
      details: serverMessage,
      canRetry: false,
      needsSystemCheckFirst: false,
      staleAttemptAt: null,
    };
  }

  if (status === 400) {
    return {
      tone: "error",
      title: t("Clarity sent a bad request"),
      line: t("{Name} was never asked. This is a Clarity bug, not a problem with {name}.", { Name: cap(system.name), name: system.name }),
      details: serverMessage || String(payload?.error || ""),
      canRetry: false,
      needsSystemCheckFirst: false,
      staleAttemptAt: null,
    };
  }

  // The env-level "not configured" and the lesson-type-level one share a code
  // but not a fix, and the status separates them: 503 is the system's
  // connection missing, 207 is this lesson type having no bays.
  if (status === 503) {
    return {
      tone: "error",
      title: t("{name} isn't set up", { name: cap(system.name) }),
      line: serverMessage || t("Clarity has no connection to {name} yet.", { name: system.name }),
      details: "",
      canRetry: false,
      needsSystemCheckFirst: false,
      staleAttemptAt: null,
    };
  }

  if (status === 200 && payload?.ok === true) {
    const label = bayLabel(record);
    if (payload?.alreadyBooked === true) {
      return {
        tone: "ok",
        title: t("Already booked"),
        line: label ? t("This lesson already holds {label}.", { label }) : t("This lesson already holds a bay."),
        details: "",
        canRetry: false,
        needsSystemCheckFirst: false,
        staleAttemptAt: null,
      };
    }
    return {
      tone: "ok",
      title: label || t("Bay held"),
      line: label ? t("{label} is now held in {name}.", { label, name: system.name }) : t("The bay is now held in {name}.", { name: system.name }),
      details: "",
      canRetry: false,
      needsSystemCheckFirst: false,
      staleAttemptAt: null,
    };
  }

  if (status === 207 || (status === 200 && payload?.ok === false)) {
    const code = String(record?.errorCode || payload?.error || "");
    // 207 not_configured is the lesson type having no bays, which is the
    // wording FAILURES already carries. Nothing to override.
    return failure(code, record, system);
  }

  if (status === 404 || String(payload?.error || "") === "appointment_not_found") {
    return {
      tone: "error",
      title: t("Lesson not found"),
      line: t("Clarity could not find this lesson to book a bay against. Reload the calendar."),
      details: serverMessage,
      canRetry: false,
      needsSystemCheckFirst: false,
      staleAttemptAt: null,
    };
  }

  return failure(String(payload?.error || record?.errorCode || ""), record, system, {
    details: [buildDetails(record, system), serverMessage].filter(Boolean).join("\n"),
  });
}
