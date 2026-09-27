import { inferBookingAction } from "../notification-engine.mts";

export type DurableNotificationAction = "booking" | "rescheduled" | "updated" | "cancelled";

export type NotificationOutboxJob = {
  id: string;
  accountId: string;
  calendarItemId: string;
  action: DurableNotificationAction;
  status: "queued" | "processing" | "retry" | "sent" | "cancelled";
  source: string;
  appointment: any;
  previousAppointment: any | null;
  originalPositionSignature: string;
  targetSignature: string;
  queuedAt: string;
  dueAt: string;
  firstAttemptedAt?: string;
  attemptedAt?: string;
  sentAt?: string;
  attemptCount: number;
  nextAttemptAt?: string;
  claimToken?: string;
  claimExpiresAt?: string;
  providerResult?: any;
  lastError?: string;
};

export type PendingNotificationIntent = Pick<
  NotificationOutboxJob,
  "action" | "appointment" | "previousAppointment" | "originalPositionSignature" | "queuedAt" | "dueAt"
>;

export type NotificationIntentPlan =
  | { operation: "none" }
  | { operation: "cancel"; reason: string }
  | { operation: "upsert"; cancelExisting: boolean; intent: PendingNotificationIntent };

/**
 * Coalesce one calendar change into the booking's unsettled intent.
 *
 * The original state is retained across edits so a final reschedule can still
 * describe old -> new. A pending new-booking confirmation stays a booking as
 * the coach edits it. Returning to the original state cancels the noise.
 */
export function planBookingNotificationIntent(input: {
  existing?: NotificationOutboxJob | null;
  action: DurableNotificationAction;
  previous?: any;
  next?: any;
  queuedAt: string;
  dueAt: string;
  positionSignature: (appointment: any) => string;
}): NotificationIntentPlan {
  const { existing, action, previous, next, queuedAt, dueAt, positionSignature } = input;

  if (action === "booking" && next) {
    return {
      operation: "upsert",
      cancelExisting: false,
      intent: {
        action: "booking",
        appointment: next,
        previousAppointment: null,
        originalPositionSignature: "",
        queuedAt,
        dueAt,
      },
    };
  }

  if ((action === "rescheduled" || action === "updated") && next) {
    if (existing?.action === "booking") {
      return {
        operation: "upsert",
        cancelExisting: false,
        intent: {
          action: "booking",
          appointment: next,
          previousAppointment: null,
          originalPositionSignature: "",
          queuedAt,
          dueAt,
        },
      };
    }

    const original = existing?.previousAppointment || previous || null;
    const settledAction = inferBookingAction(original, next);
    if (!settledAction) return { operation: "cancel", reason: "change_reverted_during_debounce" };
    if (settledAction !== "rescheduled" && settledAction !== "updated") {
      return { operation: "none" };
    }
    return {
      operation: "upsert",
      cancelExisting: false,
      intent: {
        action: settledAction,
        appointment: next,
        previousAppointment: original,
        originalPositionSignature: original ? positionSignature(original) : "",
        queuedAt,
        dueAt,
      },
    };
  }

  if (action === "cancelled" && previous) {
    if (existing?.action === "booking") {
      return { operation: "cancel", reason: "created_then_cancelled_during_debounce" };
    }
    return {
      operation: "upsert",
      cancelExisting: Boolean(existing),
      intent: {
        action: "cancelled",
        appointment: previous,
        previousAppointment: previous,
        originalPositionSignature: positionSignature(previous),
        queuedAt,
        dueAt: queuedAt,
      },
    };
  }

  return { operation: "none" };
}

/** Retry forever, quickly at first and then at a bounded six-hour cadence. */
export function notificationRetryDelayMs(attemptCount: number) {
  const schedule = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
  return schedule[Math.min(Math.max(1, attemptCount) - 1, schedule.length - 1)];
}

export function notificationDeliveryError(results: any[]) {
  const failures = (results || []).filter((entry) => entry?.status === "failed");
  if (!failures.length) return "";
  return failures
    .map((entry) => [entry.channel || entry.kind || "email", entry.reason, entry.error].filter(Boolean).join(":"))
    .join("; ")
    .slice(0, 2000);
}

/**
 * Shared worker loop. The production claim callback is an atomic Postgres
 * FOR UPDATE SKIP LOCKED claim; tests can exercise the same delivery/retry
 * semantics with an in-memory claim implementation.
 */
export async function runNotificationOutboxWorker(deps: {
  claim: () => Promise<NotificationOutboxJob[]>;
  deliver: (job: NotificationOutboxJob) => Promise<any[]>;
  markSent: (job: NotificationOutboxJob, results: any[]) => Promise<void>;
  markRetry: (job: NotificationOutboxJob, error: string, results: any[]) => Promise<void>;
}) {
  const jobs = await deps.claim();
  const outcomes: Array<{ id: string; status: "sent" | "retry"; error?: string }> = [];
  for (const job of jobs) {
    try {
      const results = await deps.deliver(job);
      const error = notificationDeliveryError(results);
      if (error) {
        await deps.markRetry(job, error, results);
        outcomes.push({ id: job.id, status: "retry", error });
      } else {
        await deps.markSent(job, results);
        outcomes.push({ id: job.id, status: "sent" });
      }
    } catch (cause) {
      const error = (cause instanceof Error ? cause.message : String(cause || "notification delivery failed")).slice(0, 2000);
      await deps.markRetry(job, error, []);
      outcomes.push({ id: job.id, status: "retry", error });
    }
  }
  return { claimed: jobs.length, outcomes };
}
