/**
 * The one door every external resource booking goes through.
 *
 * A lesson can hold a resource (a hitting bay, a room) in one of two ways:
 *
 * - **Clarity's own resources** (_shared/resources.mts). Clarity keeps the
 *   availability, so the resource is picked and written in the same save as
 *   the lesson (booking-core's assignClarityResources). Nothing to call out to.
 * - **Another system's resources.** Some other booking system keeps the
 *   availability, and Clarity asks it to hold, move and release a resource for
 *   the lesson. That is what this module is for.
 *
 * Callers never name the other system. They ask this module to hold, move or
 * release, and it routes to the provider the business uses. The rules every
 * provider keeps:
 *
 * - `hold` waits for the other system's answer. A refusal means the resource
 *   is taken, and the provider may try the next one before giving up. This is
 *   the business's choice, made on 2026-09-25: a bay only counts as booked
 *   once the system that owns it says so.
 * - `move` keeps the same resource when it can, and never leaves a lesson
 *   holding two.
 * - `release` refuses loudly when the other system says no. The caller decides
 *   whether that blocks what it was doing.
 * - Anything that runs after the response has gone out must be queued first,
 *   because deferred work on this platform often dies (see
 *   queueHold / sweepQueuedHolds).
 *
 * Today there is one provider. The Optix-specific code sits behind it
 * unchanged, in optix-book-resource.mts and optix-cancel.mts. A generic webhook
 * provider is the next one to join.
 */
import { getDatabase } from "@netlify/database";

import {
  autoBookResourceForNewBooking,
  bookOneResource,
  ensureOptixSyncTable,
  queueAutoBookResource,
  rebookResourceAfterReschedule,
  sweepQueuedAutoBooks,
  type AutoBookSweepOutcome,
  type BayRebookOutcome,
} from "./optix-book-resource.mts";
import { cancelOptixBayForCalendarItem, type OptixBayCancellationResult } from "./optix-cancel.mts";
import { bayFollowsReschedule } from "./optix-reconcile.mts";

export type ExternalResourceProviderId = "optix";

export type ResourceHoldOutcome = Awaited<ReturnType<typeof bookOneResource>>;
export type ResourceMoveOutcome = BayRebookOutcome;
export type ResourceReleaseOutcome = OptixBayCancellationResult;
export type ResourceSweepOutcome = AutoBookSweepOutcome;

export type ExternalResourceProvider = {
  id: ExternalResourceProviderId;
  /** Hold a resource for the lesson now, and wait for the answer. */
  hold(accountId: string, calendarItemId: string): Promise<ResourceHoldOutcome>;
  /**
   * Hold one only if the lesson type is set to hold one automatically. Never
   * throws: a new booking must not fail because its resource did not.
   */
  holdIfAutomatic(accountId: string, calendarItemId: string, serviceId: string): Promise<void>;
  /**
   * Write down that a hold is owed, before the response goes out, so the sweep
   * can finish it if the after-response attempt dies. Never throws. Returns
   * whether anything was queued (false when the lesson type holds nothing).
   */
  queueHold(accountId: string, calendarItemId: string, serviceId: string): Promise<boolean>;
  /** Follow a lesson that moved. Never throws. */
  move(accountId: string, calendarItemId: string): Promise<ResourceMoveOutcome>;
  /** Let go of the lesson's resource. Throws when the other system refuses. */
  release(accountId: string, calendarItemId: string): Promise<ResourceReleaseOutcome>;
  /** Finish queued holds that no attempt answered. */
  sweepQueuedHolds(options?: { budgetMs?: number; nowMs?: number }): Promise<ResourceSweepOutcome>;
};

const optixProvider: ExternalResourceProvider = {
  id: "optix",
  hold: (accountId, calendarItemId) => bookOneResource(accountId, calendarItemId),
  holdIfAutomatic: (accountId, calendarItemId, serviceId) =>
    autoBookResourceForNewBooking(accountId, calendarItemId, serviceId),
  queueHold: (accountId, calendarItemId, serviceId) => queueAutoBookResource(accountId, calendarItemId, serviceId),
  move: (accountId, calendarItemId) => rebookResourceAfterReschedule(accountId, calendarItemId),
  // The lesson's own row decides whose credentials release it, so the account
  // is not passed on. It stays in the signature for providers that need it.
  release: (_accountId, calendarItemId) => cancelOptixBayForCalendarItem(calendarItemId),
  sweepQueuedHolds: (options) => sweepQueuedAutoBooks(options),
};

const PROVIDERS: Record<ExternalResourceProviderId, ExternalResourceProvider> = {
  optix: optixProvider,
};

/**
 * The provider that keeps this business's external resources.
 *
 * Every business routes to the same one today. Each provider's own setting
 * still decides whether a lesson type holds anything (for Optix, the lesson
 * type's Resources config), so a business that connected nothing gets a
 * no-op, exactly as before this module existed. When a second provider joins,
 * this reads which one the business chose.
 */
export function externalResourceProviderFor(_accountId: string): ExternalResourceProvider {
  return PROVIDERS.optix;
}

/** Every provider, for work that is not tied to one business (the sweep). */
export function allExternalResourceProviders(): ExternalResourceProvider[] {
  return Object.values(PROVIDERS);
}

export function holdResource(accountId: string, calendarItemId: string) {
  return externalResourceProviderFor(accountId).hold(accountId, calendarItemId);
}

export function holdResourceIfAutomatic(accountId: string, calendarItemId: string, serviceId: string) {
  return externalResourceProviderFor(accountId).holdIfAutomatic(accountId, calendarItemId, serviceId);
}

export function queueResourceHold(accountId: string, calendarItemId: string, serviceId: string) {
  return externalResourceProviderFor(accountId).queueHold(accountId, calendarItemId, serviceId);
}

export function moveResource(accountId: string, calendarItemId: string) {
  return externalResourceProviderFor(accountId).move(accountId, calendarItemId);
}

export function releaseResource(accountId: string, calendarItemId: string) {
  return externalResourceProviderFor(accountId).release(accountId, calendarItemId);
}

export async function sweepQueuedResourceHolds(options: { budgetMs?: number; nowMs?: number } = {}) {
  const outcomes: Array<{ provider: ExternalResourceProviderId; outcome: ResourceSweepOutcome }> = [];
  for (const provider of allExternalResourceProviders()) {
    outcomes.push({ provider: provider.id, outcome: await provider.sweepQueuedHolds(options) });
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Queued moves and releases
//
// A move (the lesson was rescheduled) and a release (the lesson was cancelled)
// both run after the save's response has gone out, and on this platform that
// work is often cut short (see optix-deferred-work-dies-after-response). A new
// hold was already protected by a 'pending' row the sweep finishes. These
// weren't: a cut-off move left the bay at the old time, and a cut-off release
// left a bay held for a lesson nobody was coming to.
//
// So the save marks the ledger row with the action it owes before responding;
// the after-response attempt clears the mark when it finishes; and the sweep
// finishes any mark that is still there a little later. Only rows that hold a
// bay are marked, so a lesson with nothing held costs one no-op UPDATE.
// ---------------------------------------------------------------------------

export type ResourceAction = "move" | "release";

function db() {
  return getDatabase();
}

/** How long the after-response attempt gets before the sweep steps in. */
const ACTION_GRACE_SECONDS = 90;
/** A claimed row is left alone this long, in case its attempt is still running. */
const ACTION_CLAIM_SECONDS = 150;
/** Past this many sweep attempts the mark is dropped and the row shows the failure. */
const ACTION_MAX_ATTEMPTS = 4;

/**
 * Write down that these lessons owe their resource a move or a release. Awaited
 * inside the save, before the response. A release outranks a move: a lesson
 * moved and then cancelled only needs letting go.
 *
 * Returns the ids to attempt: the ones actually marked (the lessons holding
 * something), or every id when the mark could not be written -- an unqueued
 * attempt is still better than none. Never throws: the save already happened.
 *
 * No table check here. This sits on every drag-to-reschedule save, the
 * columns come with the 20260925000300 migration, and a missing column lands
 * in the fallback above.
 */
export async function queueResourceAction(
  accountId: string,
  calendarItemIds: string[],
  action: ResourceAction,
): Promise<string[]> {
  const ids = [...new Set((calendarItemIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!accountId || !ids.length) return [];
  const marked: string[] = [];
  try {
    for (const id of ids) {
      const rows = await db().sql`
        UPDATE optix_booking_sync
        SET pending_action = CASE WHEN pending_action = 'release' THEN 'release' ELSE ${action}::text END,
            pending_since = NOW(),
            pending_claimed_at = NULL,
            pending_attempts = 0,
            updated_at = NOW()
        WHERE calendar_item_id = ${id}
          AND (account_id = ${accountId} OR account_id IS NULL)
          AND COALESCE(optix_booking_id, '') <> ''
          AND (
            (${action}::text = 'move' AND sync_status = 'synced')
            OR (${action}::text = 'release' AND sync_status <> 'cancelled')
          )
        RETURNING calendar_item_id
      `;
      if (rows[0]) marked.push(id);
    }
  } catch (error) {
    console.error("resource_action_queue_failed", {
      accountId,
      action,
      calendarItemIds: ids,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error || "").slice(0, 300),
    });
    return ids;
  }
  if (marked.length) console.info("resource_action_queued", { accountId, action, calendarItemIds: marked });
  return marked;
}

async function settleResourceAction(calendarItemId: string, action: ResourceAction) {
  // Only the action this attempt ran. A release queued while a move was in
  // flight must survive the move finishing.
  await db().sql`
    UPDATE optix_booking_sync
    SET pending_action = NULL, pending_since = NULL, pending_claimed_at = NULL, updated_at = NOW()
    WHERE calendar_item_id = ${calendarItemId}
      AND pending_action = ${action}
  `;
}

/**
 * Run one owed action and clear its mark when it is done.
 *
 * A move always counts as done once it returns: it never throws, and it has
 * its own fallback (amend, then cancel and rebook) that leaves the ledger row
 * saying what happened. A release that the other system refuses stays marked,
 * so the sweep tries again; the refusal is already on the row for the coach.
 * Never throws.
 */
export async function runResourceAction(
  accountId: string,
  calendarItemId: string,
  action: ResourceAction,
): Promise<{ done: boolean; error?: string }> {
  try {
    if (action === "move") {
      const outcome = await moveResource(accountId, calendarItemId);
      await settleResourceAction(calendarItemId, action);
      return { done: true, ...(outcome.error ? { error: outcome.error } : {}) };
    }
    const outcome = await releaseResource(accountId, calendarItemId);
    await settleResourceAction(calendarItemId, action);
    console.info("resource_released", { calendarItemId, ...outcome });
    return { done: true };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : String(error || "").slice(0, 300);
    console.error("resource_action_failed", { calendarItemId, action, error: message });
    return { done: false, error: message };
  }
}

export type ResourceActionSweepOutcome = {
  claimed: number;
  done: number;
  retrying: number;
  settled: number;
  items: Array<{ calendarItemId: string; action: string; outcome: string }>;
};

/**
 * Finish moves and releases whose after-response attempt never cleared its
 * mark. Same shape as the hold sweep: oldest first, one claimed row at a time,
 * and `budgetMs` bounds when a NEW attempt may start, counted from `nowMs` so
 * the scheduled function can share one budget across both sweeps.
 */
export async function sweepQueuedResourceActions(
  options: { budgetMs?: number; nowMs?: number } = {},
): Promise<ResourceActionSweepOutcome> {
  const startedAt = options.nowMs ?? Date.now();
  const budgetMs = options.budgetMs ?? 5_000;
  const outcome: ResourceActionSweepOutcome = { claimed: 0, done: 0, retrying: 0, settled: 0, items: [] };
  if (Date.now() - startedAt >= budgetMs) return outcome;
  await ensureOptixSyncTable();

  while (Date.now() - startedAt < budgetMs) {
    const claimed = await db().sql`
      UPDATE optix_booking_sync s
      SET pending_claimed_at = NOW(),
          pending_attempts = s.pending_attempts + 1,
          updated_at = NOW()
      WHERE s.calendar_item_id = (
        SELECT calendar_item_id
        FROM optix_booking_sync
        WHERE pending_action IS NOT NULL
          AND pending_since < NOW() - (${ACTION_GRACE_SECONDS}::int * INTERVAL '1 second')
          AND (pending_claimed_at IS NULL
               OR pending_claimed_at < NOW() - (${ACTION_CLAIM_SECONDS}::int * INTERVAL '1 second'))
        ORDER BY pending_since
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING s.calendar_item_id, s.account_id, s.pending_action, s.pending_attempts
    `;
    if (!claimed[0]) break;
    outcome.claimed += 1;
    const calendarItemId = String(claimed[0].calendar_item_id || "");
    const action: ResourceAction = claimed[0].pending_action === "release" ? "release" : "move";
    const attempts = Number(claimed[0].pending_attempts || 0);
    const record = (label: string) => outcome.items.push({ calendarItemId, action, outcome: label });

    try {
      const lessons = await db().sql`
        SELECT account_id FROM calendar_items WHERE id = ${calendarItemId} LIMIT 1
      `;
      const accountId = String(claimed[0].account_id || lessons[0]?.account_id || "");
      if (!lessons[0] || attempts > ACTION_MAX_ATTEMPTS) {
        // Deleted lessons release their bay in the delete itself; a lesson
        // that is gone has nothing left to move. After the last attempt the
        // row keeps the refusal the coach can see, without the mark.
        await settleResourceAction(calendarItemId, action);
        outcome.settled += 1;
        record(!lessons[0] ? "lesson_deleted" : "abandoned");
        if (lessons[0]) console.error("resource_action_abandoned", { calendarItemId, action, attempts });
        continue;
      }
      const result = await runResourceAction(accountId, calendarItemId, action);
      if (result.done) {
        outcome.done += 1;
        record("done");
      } else {
        outcome.retrying += 1;
        record("retrying");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : String(error || "").slice(0, 300);
      console.error("resource_action_sweep_item_failed", { calendarItemId, action, error: message });
      outcome.retrying += 1;
      record("exception");
    }
  }
  return outcome;
}

type LessonState = {
  id?: string;
  kind?: string;
  status?: string;
  week?: number | null;
  day?: number | null;
  start?: number | null;
  duration?: number | null;
  location?: { timezone?: string } | null;
};

/**
 * Whether this change cancelled a lesson whose resource should be let go.
 *
 * Only a real cancellation, from booked, while the lesson has not ended. A
 * no-show was a bay that got used, or at least paid for; and releasing a bay
 * for time that has passed frees nothing. The "has it ended" rule is the one a
 * moved bay follows, asked of the lesson as it stood before it was cancelled.
 */
export function cancellationFreesResource(
  previous: LessonState | null | undefined,
  next: LessonState | null | undefined,
  options: { nowMs: number; defaultTimeZone: string },
) {
  if (!previous || !next || (next.kind || "appointment") !== "appointment") return false;
  if ((previous.status || "booked") !== "booked" || next.status !== "cancelled") return false;
  return bayFollowsReschedule({ ...next, status: "booked" }, options);
}
