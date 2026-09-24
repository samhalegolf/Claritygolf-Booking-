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
import {
  autoBookResourceForNewBooking,
  bookOneResource,
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
