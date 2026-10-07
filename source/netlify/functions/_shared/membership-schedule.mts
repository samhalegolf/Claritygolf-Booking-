import { cleanString } from "./values.mts";
/**
 * The arithmetic of recurring billing, with no database and no Stripe.
 *
 * Everything here is a pure function of its arguments so the rules can fail a
 * test instead of a member: when a period ends, what it costs, when a failed
 * card is tried again, and what the billing job should do next. The engine in
 * memberships.mts only reads rows, asks this module, and writes the answer.
 *
 * Money is integer minor units throughout. Instants are Date objects in UTC;
 * a period boundary keeps the clock time of the moment the membership started,
 * so a monthly member who joined at 10:14 is billed at 10:14 on the day.
 */

export type BillingInterval = "week" | "month" | "year";
export type RolloverPolicy = "expire_each_period" | "rollover" | "rollover_capped";
export type BillingAnchor = "signup" | "day_of_month";
export type FailedPaymentAction = "pause" | "cancel";

export type MembershipEntitlement = {
  /** Stable within the plan; part of the pass's source_ref. */
  id: string;
  name: string;
  /** Services the credits may be spent on. Empty when allServices. */
  serviceIds: string[];
  /** Site wide: the credits pay for any service. */
  allServices?: boolean;
  /** Credits granted for each paid period. */
  credits: number;
  rollover: RolloverPolicy;
  /** Only for rollover_capped: the balance a top-up never pushes past. */
  maxBalance: number | null;
};

export type MembershipPlan = {
  id: string;
  name: string;
  description: string;
  active: boolean;
  sellOnline: boolean;
  priceCents: number;
  currency: string;
  interval: BillingInterval;
  intervalCount: number;
  anchor: BillingAnchor;
  anchorDay: number | null;
  prorateFirst: boolean;
  signupFeeCents: number;
  trialDays: number;
  /** null = until cancelled. */
  termCycles: number | null;
  minCycles: number;
  failedPaymentAction: FailedPaymentAction;
  entitlements: MembershipEntitlement[];
};

/** The parts of a plan a membership keeps for life. */
export type PlanSnapshot = Omit<MembershipPlan, "active" | "sellOnline">;

const INTERVALS: BillingInterval[] = ["week", "month", "year"];
const ROLLOVERS: RolloverPolicy[] = ["expire_each_period", "rollover", "rollover_capped"];
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long after a failed card payment each retry happens, in days. Three
 * retries over nine days, then the plan's failed_payment_action. Card issuers
 * decline on a bad day and approve on the next far more often than not, and
 * the first retry a day later recovers most of them.
 */
export const RETRY_DELAYS_DAYS = [1, 3, 5];

function fail(message: string): never {
  throw Object.assign(new Error(message), { status: 400, code: "invalid" });
}

function wholeNumber(value: unknown, fallback: number, min: number, max: number) {
  if (value === null || value === undefined || value === "") return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function cents(value: unknown, label: string) {
  if (value === null || value === undefined || value === "") return 0;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) fail(`${label} must be zero or more.`);
  if (!Number.isSafeInteger(Math.round(num))) fail(`${label} is too large.`);
  return Math.round(num);
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/**
 * Validate an entitlement list, or refuse it.
 *
 * `knownServiceIds`, when given, is the catalogue: an entitlement covering a
 * service that does not exist is a credit with nowhere to be spent, and a
 * member paying for one finds out at the counter.
 */
export function normaliseEntitlements(value: unknown, knownServiceIds?: Set<string>): MembershipEntitlement[] {
  if (!Array.isArray(value)) return [];
  if (value.length > 12) fail("A plan can grant at most 12 different entitlements.");
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const entry = (raw || {}) as Record<string, unknown>;
    let id = cleanString(entry.id, "", 60).replace(/[^A-Za-z0-9_-]/g, "") || `ent${index + 1}`;
    while (seen.has(id)) id = `${id}x`;
    seen.add(id);

    const allServices = entry.allServices === true;
    const serviceIds = allServices
      ? []
      : Array.isArray(entry.serviceIds)
        ? [...new Set(entry.serviceIds.map((sid) => cleanString(sid, "", 120)).filter(Boolean))].slice(0, 12)
        : [];
    if (!allServices && !serviceIds.length) fail("Each entitlement needs at least one lesson type it can be spent on.");
    if (knownServiceIds) {
      const missing = serviceIds.find((sid) => !knownServiceIds.has(sid));
      if (missing) fail("An entitlement covers a lesson type that no longer exists.");
    }

    const credits = wholeNumber(entry.credits, 0, 0, 100);
    if (credits < 1) fail("Each entitlement needs at least 1 credit per period.");

    const rollover = ROLLOVERS.includes(entry.rollover as RolloverPolicy)
      ? (entry.rollover as RolloverPolicy)
      : "expire_each_period";
    const maxBalance =
      rollover === "rollover_capped" ? wholeNumber(entry.maxBalance, credits * 2, credits, 1000) : null;

    return {
      id,
      name: cleanString(entry.name, "", 120),
      serviceIds,
      ...(allServices ? { allServices: true } : {}),
      credits,
      rollover,
      maxBalance,
    };
  });
}

/** Turn what an editor sent into a plan that can be stored, or refuse it. */
export function normalisePlan(
  input: Record<string, unknown>,
  defaults: { id: string; currency: string },
  knownServiceIds?: Set<string>,
): MembershipPlan {
  const name = cleanString(input.name, "", 120);
  if (!name) fail("Give the plan a name.");

  const interval = INTERVALS.includes(input.interval as BillingInterval)
    ? (input.interval as BillingInterval)
    : "month";
  const intervalCount = wholeNumber(input.intervalCount, 1, 1, interval === "week" ? 52 : interval === "month" ? 24 : 5);

  const anchor: BillingAnchor = input.anchor === "day_of_month" && interval === "month" ? "day_of_month" : "signup";
  const anchorDay = anchor === "day_of_month" ? wholeNumber(input.anchorDay, 1, 1, 28) : null;

  const currency = cleanString(input.currency, "", 3).toUpperCase() || defaults.currency;
  if (!/^[A-Z]{3}$/.test(currency)) fail("The plan needs a three-letter currency.");

  const termRaw = input.termCycles;
  const termCycles =
    termRaw === null || termRaw === undefined || termRaw === "" || Number(termRaw) === 0
      ? null
      : wholeNumber(termRaw, 1, 1, 520);
  const minCycles = wholeNumber(input.minCycles, 0, 0, 520);
  if (termCycles !== null && minCycles > termCycles) {
    fail("The minimum commitment cannot be longer than the plan itself.");
  }

  return {
    id: cleanString(input.id, "", 120) || defaults.id,
    name,
    description: cleanString(input.description, "", 600),
    active: input.active !== false,
    sellOnline: input.sellOnline === true,
    priceCents: cents(input.priceCents, "The price"),
    currency,
    interval,
    intervalCount,
    anchor,
    anchorDay,
    prorateFirst: input.prorateFirst !== false,
    signupFeeCents: cents(input.signupFeeCents, "The joining fee"),
    trialDays: wholeNumber(input.trialDays, 0, 0, 365),
    termCycles,
    minCycles,
    failedPaymentAction: input.failedPaymentAction === "cancel" ? "cancel" : "pause",
    entitlements: normaliseEntitlements(input.entitlements, knownServiceIds),
  };
}

export function planSnapshot(plan: MembershipPlan): PlanSnapshot {
  const { active: _active, sellOnline: _sellOnline, ...snapshot } = plan;
  return snapshot;
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

function daysInMonth(year: number, monthIndex: number) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * `from` moved by whole months, landing on `preferredDay` (clamped to the
 * month's length) at the same clock time.
 *
 * The preferred day is passed in rather than read off `from`, and that is the
 * whole point: a member who joined on the 31st is billed on the 28th in
 * February and back on the 31st in March. Stepping from February's date would
 * drift them to the 28th for good.
 */
export function addMonths(from: Date, months: number, preferredDay = from.getUTCDate()): Date {
  const total = from.getUTCFullYear() * 12 + from.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const day = Math.min(preferredDay, daysInMonth(year, month));
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}

export function addInterval(
  from: Date,
  interval: BillingInterval,
  count: number,
  preferredDay?: number,
): Date {
  if (interval === "week") return new Date(from.getTime() + count * 7 * DAY_MS);
  return addMonths(from, interval === "year" ? count * 12 : count, preferredDay);
}

/** The first anchor day strictly after `from`, at `from`'s clock time. */
export function nextAnchorDay(from: Date, anchorDay: number): Date {
  const sameMonth = addMonths(from, 0, anchorDay);
  return sameMonth.getTime() > from.getTime() ? sameMonth : addMonths(from, 1, anchorDay);
}

export type Period = {
  start: Date;
  end: Date;
  /** How long a whole period would have been; longer than end-start only when anchored short. */
  fullLengthMs: number;
};

/**
 * The billing period that starts at `start`.
 *
 * `preferredDay` is the day of month the membership bills on when it is not
 * anchored -- the day it started -- so monthly periods never drift.
 */
export function periodFrom(
  start: Date,
  plan: Pick<PlanSnapshot, "interval" | "intervalCount" | "anchor" | "anchorDay">,
  preferredDay: number,
): Period {
  if (plan.anchor === "day_of_month" && plan.anchorDay) {
    const onAnchor = addMonths(start, 0, plan.anchorDay).getTime() === start.getTime();
    if (onAnchor) {
      const end = addMonths(start, plan.intervalCount, plan.anchorDay);
      return { start, end, fullLengthMs: end.getTime() - start.getTime() };
    }
    // Off the anchor (joining mid-month, or resuming after a pause): a short
    // period up to the next anchor day, measured against a whole one so it can
    // be charged pro rata.
    const end = nextAnchorDay(start, plan.anchorDay);
    const fullStart = addMonths(end, -plan.intervalCount, plan.anchorDay);
    return { start, end, fullLengthMs: end.getTime() - fullStart.getTime() };
  }
  const end = addInterval(start, plan.interval, plan.intervalCount, preferredDay);
  return { start, end, fullLengthMs: end.getTime() - start.getTime() };
}

/**
 * What a period costs: the price, pro rata when the period is short and the
 * plan prorates. Rounded to the nearest minor unit -- a part-period is never
 * charged more than a whole one.
 */
export function periodAmountCents(
  plan: Pick<PlanSnapshot, "priceCents" | "prorateFirst">,
  period: Period,
): number {
  const length = period.end.getTime() - period.start.getTime();
  if (!plan.prorateFirst || length >= period.fullLengthMs || period.fullLengthMs <= 0) return plan.priceCents;
  return Math.min(plan.priceCents, Math.round((plan.priceCents * length) / period.fullLengthMs));
}

export type PlannedCharge = {
  cycleNumber: number;
  period: Period;
  amountCents: number;
  signupFeeCents: number;
};

/**
 * The first charge a new membership raises.
 *
 * A trial is cycle 0: a period that costs nothing (apart from a joining fee,
 * which is due at signup whether or not there is a trial) and still grants the
 * plan's entitlements, because a trial a member cannot use is not a trial.
 */
export function firstCharge(plan: PlanSnapshot, startedAt: Date): PlannedCharge {
  if (plan.trialDays > 0) {
    const end = new Date(startedAt.getTime() + plan.trialDays * DAY_MS);
    return {
      cycleNumber: 0,
      period: { start: startedAt, end, fullLengthMs: end.getTime() - startedAt.getTime() },
      amountCents: plan.signupFeeCents,
      signupFeeCents: plan.signupFeeCents,
    };
  }
  const period = periodFrom(startedAt, plan, startedAt.getUTCDate());
  return {
    cycleNumber: 1,
    period,
    amountCents: periodAmountCents(plan, period) + plan.signupFeeCents,
    signupFeeCents: plan.signupFeeCents,
  };
}

/** The charge for the period following one that ended at `previousEnd`. */
export function nextCharge(
  plan: PlanSnapshot,
  previousCycle: number,
  previousEnd: Date,
  preferredDay: number,
): PlannedCharge {
  const period = periodFrom(previousEnd, plan, preferredDay);
  return {
    cycleNumber: previousCycle + 1,
    period,
    amountCents: periodAmountCents(plan, period),
    signupFeeCents: 0,
  };
}

// ---------------------------------------------------------------------------
// Failed payments
// ---------------------------------------------------------------------------

/**
 * When to try a failed card again, or null when the retries are used up.
 * `attempts` counts the attempts already made, including the one that just
 * failed.
 */
export function nextRetryAt(attempts: number, failedAt: Date): Date | null {
  const delay = RETRY_DELAYS_DAYS[attempts - 1];
  return delay === undefined ? null : new Date(failedAt.getTime() + delay * DAY_MS);
}

// ---------------------------------------------------------------------------
// What the billing job should do
// ---------------------------------------------------------------------------

export type MembershipStatus =
  | "incomplete"
  | "trialing"
  | "active"
  | "past_due"
  | "paused"
  | "cancelled"
  | "ended";

export type ChargeStatus =
  | "pending"
  | "processing"
  | "paid"
  | "failed"
  | "requires_action"
  | "waived"
  | "void"
  | "refunded";

export type StepInput = {
  status: MembershipStatus;
  collection: "card" | "manual";
  currentPeriodEnd: Date | null;
  cyclesRaised: number;
  cancelAtPeriodEnd: boolean;
  termCycles: number | null;
  hasCard: boolean;
  /** The newest unpaid card charge, if one is waiting on a retry. */
  openCardCharge: { status: ChargeStatus; nextRetryAt: Date | null } | null;
};

export type Step =
  | { kind: "wait"; until: Date | null }
  | { kind: "retry" }
  | { kind: "raise" }
  | { kind: "finish"; reason: "cancelled" | "term_complete" };

/**
 * One decision for one membership at one instant. The engine runs it, acts,
 * and asks again -- so a job that was down for a week catches up a period at a
 * time rather than in one jump that could skip a charge.
 */
export function planStep(input: StepInput, now: Date): Step {
  if (!["trialing", "active", "past_due"].includes(input.status)) return { kind: "wait", until: null };

  // A failed card payment is settled before anything new is raised: billing
  // a member for October while September is still unpaid only doubles what
  // they owe at the moment their card is least likely to pay it.
  if (input.openCardCharge) {
    const retryAt = input.openCardCharge.nextRetryAt;
    if (input.openCardCharge.status === "processing") return { kind: "wait", until: null };
    if (!input.hasCard) return { kind: "wait", until: null };
    if (retryAt && retryAt.getTime() <= now.getTime()) return { kind: "retry" };
    return { kind: "wait", until: retryAt };
  }

  const end = input.currentPeriodEnd;
  if (!end) return { kind: "wait", until: null };
  if (now.getTime() < end.getTime()) return { kind: "wait", until: end };

  if (input.cancelAtPeriodEnd) return { kind: "finish", reason: "cancelled" };
  if (input.termCycles !== null && input.cyclesRaised >= input.termCycles) {
    return { kind: "finish", reason: "term_complete" };
  }
  return { kind: "raise" };
}

/**
 * Whether a member (not a coach) may cancel now, honouring the plan's minimum
 * commitment. `paidCycles` counts paid periods excluding the trial.
 */
export function memberMayCancel(minCycles: number, paidCycles: number) {
  return paidCycles >= minCycles;
}

/**
 * Credits to append for one period under a pass's rollover policy.
 *
 * Only rollover_capped depends on the balance: a member holding 5 of a
 * maximum 6 gets 1, not the plan's 4. Zero means "add nothing this period".
 */
export function creditsForPeriod(entitlement: MembershipEntitlement, currentBalance: number) {
  if (entitlement.rollover !== "rollover_capped" || entitlement.maxBalance === null) return entitlement.credits;
  return Math.max(0, Math.min(entitlement.credits, entitlement.maxBalance - Math.max(0, currentBalance)));
}

/** Monthly recurring revenue contribution of a plan price, in minor units. */
export function monthlyValueCents(plan: Pick<PlanSnapshot, "priceCents" | "interval" | "intervalCount">) {
  const perMonth =
    plan.interval === "week"
      ? (plan.priceCents * 52) / 12 / plan.intervalCount
      : plan.interval === "year"
        ? plan.priceCents / 12 / plan.intervalCount
        : plan.priceCents / plan.intervalCount;
  return Math.round(perMonth);
}
