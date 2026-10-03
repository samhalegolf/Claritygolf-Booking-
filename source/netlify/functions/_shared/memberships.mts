/**
 * Memberships: the recurring payments engine.
 *
 * A plan says what something costs, how often, for how long, and what each
 * paid period grants. A membership is a person on a plan, with the plan
 * snapshotted. Each billing period is one membership_charges row, and the only
 * thing that grants credits is that row becoming paid -- see the migration
 * 20261003000100_create_memberships for why that matters.
 *
 * Two ways to collect:
 *
 *   card    The member saves a card through Stripe Checkout on the business's
 *           Clarity Pay account, and each period is charged off-session.
 *           Failures are retried (RETRY_DELAYS_DAYS), then the plan's
 *           failed_payment_action pauses or cancels the membership.
 *   manual  Each period raises a charge a coach marks paid -- cash, bank
 *           transfer. Credits for the period land when it is marked.
 *
 * The decisions (when a period ends, what it costs, what to do next) are pure
 * functions in membership-schedule.mts. This file reads rows, asks, and writes.
 * Every query filters on account_id in the SQL.
 */

import { randomUUID } from "node:crypto";

import { getDatabase } from "./database.mts";
import { deliverEmail } from "./email-delivery.mts";
import {
  creditsForPeriod,
  firstCharge,
  memberMayCancel,
  monthlyValueCents,
  nextCharge,
  nextRetryAt,
  normalisePlan,
  planSnapshot,
  planStep,
  type ChargeStatus,
  type MembershipPlan,
  type MembershipStatus,
  type PlanSnapshot,
  type PlannedCharge,
} from "./membership-schedule.mts";
import {
  applicationFeeCents,
  requireStripeFeature,
  resolveStripeCredential,
  stripeHeaders,
  stripeRequest,
  STRIPE_CONNECTION_SETTING,
  type StripeCredential,
} from "./stripe.mts";

const db = getDatabase;

type Row = Record<string, any>;
type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: Row[] }> };

export type MembershipActor = { accountId: string; actorId: string };

function fail(message: string, status = 400, code = "invalid"): never {
  throw Object.assign(new Error(message), { status, code });
}

function text(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function iso(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function asDate(value: unknown): Date | null {
  const out = iso(value);
  return out ? new Date(out) : null;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export type MembershipPlanView = MembershipPlan & {
  memberCount: number;
  createdAt: string;
};

export type MembershipChargeView = {
  id: string;
  cycleNumber: number;
  periodStart: string;
  periodEnd: string;
  amountCents: number;
  signupFeeCents: number;
  currency: string;
  description: string;
  status: ChargeStatus;
  attempts: number;
  lastError: string;
  paidAt: string | null;
  paidVia: string;
  note: string;
};

export type MembershipView = {
  id: string;
  personId: string;
  personName: string;
  personEmail: string;
  planId: string;
  plan: PlanSnapshot;
  status: MembershipStatus;
  collection: "card" | "manual";
  cardLabel: string;
  startedAt: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  /** When the next charge will be raised, or null when none will. */
  nextChargeAt: string | null;
  cancelAtPeriodEnd: boolean;
  cancelReason: string;
  endedAt: string | null;
  pausedAt: string | null;
  failedAttempts: number;
  /** Paid periods, not counting a trial. */
  paidCycles: number;
  /** Whether the member may cancel themselves yet (minimum commitment). */
  memberMayCancel: boolean;
  /** Owed and not yet paid, in minor units. */
  outstandingCents: number;
  note: string;
  createdAt: string;
  charges: MembershipChargeView[];
};

function rowToPlan(row: Row): MembershipPlanView {
  return {
    id: String(row.id),
    name: String(row.name || ""),
    description: String(row.description || ""),
    active: row.active === true,
    sellOnline: row.sell_online === true,
    priceCents: Number(row.price_cents) || 0,
    currency: String(row.currency || ""),
    interval: row.billing_interval,
    intervalCount: Number(row.billing_interval_count) || 1,
    anchor: row.billing_anchor === "day_of_month" ? "day_of_month" : "signup",
    anchorDay: row.anchor_day === null || row.anchor_day === undefined ? null : Number(row.anchor_day),
    prorateFirst: row.prorate_first !== false,
    signupFeeCents: Number(row.signup_fee_cents) || 0,
    trialDays: Number(row.trial_days) || 0,
    termCycles: row.term_cycles === null || row.term_cycles === undefined ? null : Number(row.term_cycles),
    minCycles: Number(row.min_cycles) || 0,
    failedPaymentAction: row.failed_payment_action === "cancel" ? "cancel" : "pause",
    entitlements: Array.isArray(row.entitlements) ? row.entitlements : [],
    memberCount: Number(row.member_count) || 0,
    createdAt: iso(row.created_at) || "",
  };
}

function rowToCharge(row: Row): MembershipChargeView {
  return {
    id: String(row.id),
    cycleNumber: Number(row.cycle_number) || 0,
    periodStart: iso(row.period_start) || "",
    periodEnd: iso(row.period_end) || "",
    amountCents: Number(row.amount_cents) || 0,
    signupFeeCents: Number(row.signup_fee_cents) || 0,
    currency: String(row.currency || ""),
    description: String(row.description || ""),
    status: row.status,
    attempts: Number(row.attempts) || 0,
    lastError: String(row.last_error || ""),
    paidAt: iso(row.paid_at),
    paidVia: String(row.paid_via || ""),
    note: String(row.note || ""),
  };
}

const LIVE: MembershipStatus[] = ["trialing", "active", "past_due"];

function rowToMembership(row: Row): MembershipView {
  const charges = Array.isArray(row.charges) ? (row.charges as Row[]).map(rowToCharge) : [];
  const plan = row.plan_snapshot as PlanSnapshot;
  const paidCycles = charges.filter(
    (charge) => charge.cycleNumber > 0 && (charge.status === "paid" || charge.status === "waived"),
  ).length;
  const status = row.status as MembershipStatus;
  const outstandingCents = charges
    .filter((charge) => ["pending", "failed", "requires_action", "processing"].includes(charge.status))
    .reduce((sum, charge) => sum + charge.amountCents, 0);
  const willCharge =
    LIVE.includes(status) &&
    !row.cancel_at_period_end &&
    !(plan.termCycles !== null && Number(row.cycles_raised) >= plan.termCycles);
  return {
    id: String(row.id),
    personId: String(row.person_id),
    personName: String(row.person_name || ""),
    personEmail: String(row.person_email || ""),
    planId: String(row.plan_id),
    plan,
    status,
    collection: row.collection === "card" ? "card" : "manual",
    cardLabel: String(row.card_label || ""),
    startedAt: iso(row.started_at) || "",
    currentPeriodStart: iso(row.current_period_start),
    currentPeriodEnd: iso(row.current_period_end),
    nextChargeAt: willCharge ? iso(row.current_period_end) : null,
    cancelAtPeriodEnd: row.cancel_at_period_end === true,
    cancelReason: String(row.cancel_reason || ""),
    endedAt: iso(row.ended_at),
    pausedAt: iso(row.paused_at),
    failedAttempts: Number(row.failed_attempts) || 0,
    paidCycles,
    memberMayCancel: memberMayCancel(plan.minCycles || 0, paidCycles),
    outstandingCents,
    note: String(row.note || ""),
    createdAt: iso(row.created_at) || "",
    charges,
  };
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export async function readPlans(accountId: string): Promise<MembershipPlanView[]> {
  if (!accountId) return [];
  const rows = (await db().sql`
    SELECT p.*,
      (SELECT COUNT(*) FROM public.memberships m
        WHERE m.account_id = ${accountId} AND m.plan_id = p.id
          AND m.status IN ('trialing', 'active', 'past_due', 'paused')) AS member_count
    FROM public.membership_plans p
    WHERE p.account_id = ${accountId} AND p.archived_at IS NULL
    ORDER BY p.sort_order, p.created_at
  `) as Row[];
  return rows.map(rowToPlan);
}

async function readPlan(accountId: string, planId: string): Promise<MembershipPlanView | null> {
  const rows = (await db().sql`
    SELECT p.*, 0 AS member_count FROM public.membership_plans p
    WHERE p.account_id = ${accountId} AND p.id = ${planId} AND p.archived_at IS NULL
    LIMIT 1
  `) as Row[];
  return rows[0] ? rowToPlan(rows[0]) : null;
}

/**
 * Create or update a plan. Editing never touches existing members -- they
 * hold a snapshot -- so a price rise applies to people who join after it.
 */
export async function savePlan(
  input: Record<string, unknown>,
  context: { currency: string; serviceIds?: Set<string> },
  actor: MembershipActor,
): Promise<MembershipPlanView[]> {
  const { accountId } = actor;
  if (!accountId) fail("No account.", 403, "forbidden");
  const existingId = text(input?.id, 120);
  if (existingId && !(await readPlan(accountId, existingId))) fail("That plan was not found.", 404, "not_found");
  const plan = normalisePlan(
    input || {},
    { id: existingId || `plan-${randomUUID()}`, currency: context.currency },
    context.serviceIds,
  );
  const entitlements = JSON.stringify(plan.entitlements);
  await db().sql`
    INSERT INTO public.membership_plans (
      id, account_id, name, description, active, sell_online, price_cents, currency,
      billing_interval, billing_interval_count, billing_anchor, anchor_day, prorate_first,
      signup_fee_cents, trial_days, term_cycles, min_cycles, failed_payment_action,
      entitlements, created_by, created_at, updated_at
    ) VALUES (
      ${plan.id}, ${accountId}, ${plan.name}, ${plan.description}, ${plan.active}, ${plan.sellOnline},
      ${plan.priceCents}, ${plan.currency}, ${plan.interval}, ${plan.intervalCount}, ${plan.anchor},
      ${plan.anchorDay}, ${plan.prorateFirst}, ${plan.signupFeeCents}, ${plan.trialDays},
      ${plan.termCycles}, ${plan.minCycles}, ${plan.failedPaymentAction}, ${entitlements}::jsonb,
      ${actor.actorId}, NOW(), NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      active = EXCLUDED.active,
      sell_online = EXCLUDED.sell_online,
      price_cents = EXCLUDED.price_cents,
      currency = EXCLUDED.currency,
      billing_interval = EXCLUDED.billing_interval,
      billing_interval_count = EXCLUDED.billing_interval_count,
      billing_anchor = EXCLUDED.billing_anchor,
      anchor_day = EXCLUDED.anchor_day,
      prorate_first = EXCLUDED.prorate_first,
      signup_fee_cents = EXCLUDED.signup_fee_cents,
      trial_days = EXCLUDED.trial_days,
      term_cycles = EXCLUDED.term_cycles,
      min_cycles = EXCLUDED.min_cycles,
      failed_payment_action = EXCLUDED.failed_payment_action,
      entitlements = EXCLUDED.entitlements,
      updated_at = NOW()
    WHERE public.membership_plans.account_id = ${accountId}
  `;
  return readPlans(accountId);
}

/** Retire a plan. Its members keep billing on their snapshot. */
export async function archivePlan(planId: string, actor: MembershipActor): Promise<MembershipPlanView[]> {
  await db().sql`
    UPDATE public.membership_plans
    SET archived_at = NOW(), active = FALSE, sell_online = FALSE, updated_at = NOW()
    WHERE id = ${text(planId, 120)} AND account_id = ${actor.accountId}
  `;
  return readPlans(actor.accountId);
}

// ---------------------------------------------------------------------------
// Reading memberships
// ---------------------------------------------------------------------------

export async function readMemberships(
  accountId: string,
  filter: { personId?: string; membershipId?: string } = {},
): Promise<MembershipView[]> {
  if (!accountId) return [];
  const personId = filter.personId || null;
  const membershipId = filter.membershipId || null;
  const rows = (await db().sql`
    SELECT m.*,
      p.name AS person_name,
      p.email AS person_email,
      COALESCE((
        SELECT json_agg(c ORDER BY c.cycle_number DESC)
        FROM (
          SELECT * FROM public.membership_charges c
          WHERE c.membership_id = m.id AND c.account_id = ${accountId}
          ORDER BY c.cycle_number DESC
          LIMIT 24
        ) c
      ), '[]'::json) AS charges
    FROM public.memberships m
    LEFT JOIN public.people p ON p.id = m.person_id AND p.account_id = ${accountId}
    WHERE m.account_id = ${accountId}
      AND (${personId}::text IS NULL OR m.person_id = ${personId})
      AND (${membershipId}::text IS NULL OR m.id = ${membershipId})
    ORDER BY
      CASE WHEN m.status IN ('trialing', 'active', 'past_due', 'paused', 'incomplete') THEN 0 ELSE 1 END,
      m.created_at DESC
    LIMIT 1000
  `) as Row[];
  return rows.map(rowToMembership);
}

async function readMembership(accountId: string, membershipId: string) {
  const found = (await readMemberships(accountId, { membershipId: text(membershipId, 120) }))[0];
  if (!found) fail("That membership was not found.", 404, "not_found");
  return found;
}

export type MembershipSummary = {
  members: number;
  trialing: number;
  pastDue: number;
  paused: number;
  /** Monthly recurring revenue across live, non-trial memberships, by currency. */
  mrr: Array<{ currency: string; cents: number }>;
  /** Manual charges waiting for a coach to mark them paid. */
  awaitingPayment: number;
  collected30d: Array<{ currency: string; cents: number }>;
};

export function summariseMemberships(memberships: MembershipView[], now = new Date()): MembershipSummary {
  const live = memberships.filter((m) => LIVE.includes(m.status));
  const mrr = new Map<string, number>();
  for (const m of live) {
    if (m.status === "trialing" || m.cancelAtPeriodEnd) continue;
    mrr.set(m.plan.currency, (mrr.get(m.plan.currency) || 0) + monthlyValueCents(m.plan));
  }
  const since = now.getTime() - 30 * 24 * 60 * 60 * 1000;
  const collected = new Map<string, number>();
  let awaitingPayment = 0;
  for (const m of memberships) {
    for (const charge of m.charges) {
      if (charge.status === "paid" && charge.paidAt && new Date(charge.paidAt).getTime() >= since) {
        collected.set(charge.currency, (collected.get(charge.currency) || 0) + charge.amountCents);
      }
      if (m.collection === "manual" && charge.status === "pending" && charge.amountCents > 0) awaitingPayment += 1;
    }
  }
  const list = (map: Map<string, number>) => [...map].map(([currency, cents]) => ({ currency, cents }));
  return {
    members: live.length,
    trialing: live.filter((m) => m.status === "trialing").length,
    pastDue: live.filter((m) => m.status === "past_due").length,
    paused: memberships.filter((m) => m.status === "paused").length,
    mrr: list(mrr),
    awaitingPayment,
    collected30d: list(collected),
  };
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

async function readSetting(accountId: string, key: string) {
  const rows = (await db().sql`
    SELECT value FROM settings WHERE account_id = ${accountId} AND key = ${key} LIMIT 1
  `) as Row[];
  return String(rows[0]?.value || "");
}

/** The business's Clarity Pay account. Saved cards need it; own Stripe cannot. */
export async function cardCredential(accountId: string): Promise<StripeCredential> {
  const credential = resolveStripeCredential(await readSetting(accountId, STRIPE_CONNECTION_SETTING));
  requireStripeFeature(credential, "portal");
  return credential;
}

/**
 * A POST that hands back Stripe's error body instead of throwing it away. An
 * off-session charge that is declined is an ordinary answer, and the decline
 * code and the PaymentIntent it left behind are the parts worth keeping.
 */
async function stripePost(
  credential: StripeCredential,
  path: string,
  params: URLSearchParams,
  idempotencyKey: string,
): Promise<{ ok: boolean; status: number; body: Row }> {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      ...stripeHeaders(credential),
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": idempotencyKey,
    },
    body: params.toString(),
  });
  const raw = await response.text();
  let body: Row = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = { error: { message: raw.slice(0, 200) } };
  }
  return { ok: response.ok, status: response.status, body };
}

function cardLabelOf(paymentMethod: Row | null | undefined) {
  const card = paymentMethod?.card;
  if (!card) return "";
  const brand = String(card.brand || "card");
  return `${brand.charAt(0).toUpperCase()}${brand.slice(1)} •••• ${String(card.last4 || "")}`.trim();
}

async function ensureStripeCustomer(credential: StripeCredential, membership: MembershipView, accountId: string) {
  const rows = (await db().sql`
    SELECT stripe_customer_id FROM public.memberships WHERE id = ${membership.id} AND account_id = ${accountId}
  `) as Row[];
  const existing = String(rows[0]?.stripe_customer_id || "");
  if (existing) return existing;
  const params = new URLSearchParams();
  if (membership.personName) params.set("name", membership.personName);
  if (membership.personEmail.includes("@")) params.set("email", membership.personEmail);
  params.set("metadata[clarity_account_id]", accountId);
  params.set("metadata[clarity_person_id]", membership.personId);
  const customer = await stripeRequest(credential, "customers", {
    method: "POST",
    params,
    idempotencyKey: `membership-customer-${membership.id}`,
  });
  const id = String(customer?.id || "");
  if (!id.startsWith("cus_")) fail("Stripe did not create a customer.", 502, "stripe_error");
  await db().sql`
    UPDATE public.memberships SET stripe_customer_id = ${id}, updated_at = NOW()
    WHERE id = ${membership.id} AND account_id = ${accountId}
  `;
  return id;
}

/** Where a finished card form sends the browser. */
export type CheckoutReturnTo = "portal" | "link";

/**
 * A Stripe Checkout page that saves the member's card -- taking the first
 * charge with it when one is due now, or saving it alone for a trial, a free
 * first period, or a card change.
 */
export async function createCardCheckout(
  accountId: string,
  membershipId: string,
  origin: string,
  returnTo: CheckoutReturnTo,
): Promise<string> {
  const credential = await cardCredential(accountId);
  const membership = await readMembership(accountId, membershipId);
  if (membership.status === "cancelled" || membership.status === "ended") {
    fail("That membership has ended.", 409, "ended");
  }
  const customer = await ensureStripeCustomer(credential, membership, accountId);
  const joining = membership.status === "incomplete";
  const firstDue = joining
    ? membership.charges.find((charge) => charge.status === "pending" && charge.amountCents > 0)
    : undefined;

  const params = new URLSearchParams();
  params.set("customer", customer);
  const back = `${origin}/api/memberships/checkout/return?account=${encodeURIComponent(accountId)}&to=${returnTo}`;
  // {CHECKOUT_SESSION_ID} is filled in by Stripe and must reach it unencoded.
  params.set("success_url", `${back}&session_id={CHECKOUT_SESSION_ID}`);
  params.set("cancel_url", returnTo === "portal" ? `${origin}/?membership=cancelled` : `${back}&cancelled=1`);
  params.set("metadata[clarity_account_id]", accountId);
  params.set("metadata[clarity_membership_id]", membership.id);
  params.set("metadata[purpose]", joining ? "join" : "card");

  if (firstDue) {
    params.set("mode", "payment");
    params.set("line_items[0][quantity]", "1");
    params.set("line_items[0][price_data][currency]", firstDue.currency.toLowerCase());
    params.set("line_items[0][price_data][unit_amount]", String(firstDue.amountCents));
    params.set("line_items[0][price_data][product_data][name]", membership.plan.name);
    if (firstDue.description) {
      params.set("line_items[0][price_data][product_data][description]", firstDue.description);
    }
    params.set("payment_intent_data[setup_future_usage]", "off_session");
    params.set("payment_intent_data[description]", firstDue.description || membership.plan.name);
    params.set("payment_intent_data[metadata][clarity_account_id]", accountId);
    params.set("payment_intent_data[metadata][clarity_membership_id]", membership.id);
    params.set("payment_intent_data[metadata][clarity_membership_charge_id]", firstDue.id);
    const fee = applicationFeeCents(credential, firstDue.amountCents);
    if (fee > 0) params.set("payment_intent_data[application_fee_amount]", String(fee));
    params.set("metadata[clarity_membership_charge_id]", firstDue.id);
  } else {
    params.set("mode", "setup");
    params.set("payment_method_types[0]", "card");
    params.set("setup_intent_data[metadata][clarity_account_id]", accountId);
    params.set("setup_intent_data[metadata][clarity_membership_id]", membership.id);
  }

  const session = await stripeRequest(credential, "checkout/sessions", { method: "POST", params });
  if (!session?.url) fail("Stripe did not return a checkout page.", 502, "stripe_error");
  await db().sql`
    UPDATE public.memberships SET checkout_session_id = ${String(session.id)}, updated_at = NOW()
    WHERE id = ${membership.id} AND account_id = ${accountId}
  `;
  return String(session.url);
}

/**
 * Bank a finished card form. Called from the return URL and from the
 * checkout.session.completed webhook; whichever arrives second finds the work
 * done. Whose membership it is comes from the session Stripe returns, never
 * from the caller.
 */
export async function completeCardCheckout(
  accountId: string,
  sessionId: string,
): Promise<{ status: "saved" | "pending" | "not_found"; membershipId: string }> {
  const credential = await cardCredential(accountId);
  const params = new URLSearchParams();
  params.append("expand[]", "payment_intent.payment_method");
  params.append("expand[]", "setup_intent.payment_method");
  const session = await stripeRequest(credential, `checkout/sessions/${encodeURIComponent(sessionId)}`, { params });
  const metadata = (session?.metadata || {}) as Record<string, string>;
  const membershipId = text(metadata.clarity_membership_id, 120);
  if (metadata.clarity_account_id !== accountId || !membershipId) return { status: "not_found", membershipId: "" };

  const rows = (await db().sql`
    SELECT id, status, stripe_customer_id FROM public.memberships
    WHERE id = ${membershipId} AND account_id = ${accountId} LIMIT 1
  `) as Row[];
  const membership = rows[0];
  if (!membership) return { status: "not_found", membershipId: "" };

  const intent = (session?.payment_intent || session?.setup_intent || null) as Row | null;
  const complete =
    session?.status === "complete" &&
    (session?.mode === "setup" || session?.payment_status === "paid") &&
    intent &&
    (intent.status === "succeeded" || intent.status === "processing");
  if (!complete) return { status: "pending", membershipId };

  const paymentMethod = (typeof intent.payment_method === "object" ? intent.payment_method : null) as Row | null;
  const paymentMethodId = String(paymentMethod?.id || intent.payment_method || "");
  const customer = String(session.customer?.id || session.customer || membership.stripe_customer_id || "");

  await db().sql`
    UPDATE public.memberships
    SET stripe_customer_id = ${customer},
        stripe_payment_method_id = ${paymentMethodId},
        card_label = ${cardLabelOf(paymentMethod)},
        collection = 'card',
        checkout_session_id = NULL,
        updated_at = NOW()
    WHERE id = ${membershipId} AND account_id = ${accountId}
  `;

  if (membership.status === "incomplete") {
    await db().sql`
      UPDATE public.memberships
      SET status = CASE WHEN cycles_raised = 0 THEN 'trialing' ELSE 'active' END,
          next_action_at = current_period_end,
          updated_at = NOW()
      WHERE id = ${membershipId} AND account_id = ${accountId} AND status = 'incomplete'
    `;
  }

  // The first period: paid by this checkout, or free (a trial with no joining
  // fee) and only waiting on the card.
  const chargeId = text(metadata.clarity_membership_charge_id, 120);
  if (chargeId && session.mode === "payment" && intent.status === "succeeded") {
    await settleCharge(accountId, chargeId, { status: "paid", via: "card", paymentIntentId: String(intent.id) }, "");
  } else if (chargeId && session.mode === "payment") {
    await db().sql`
      UPDATE public.membership_charges
      SET status = 'processing', stripe_payment_intent_id = ${String(intent.id)}, updated_at = NOW()
      WHERE id = ${chargeId} AND account_id = ${accountId} AND status = 'pending'
    `;
  } else {
    const freeFirst = (await db().sql`
      SELECT id, cycle_number FROM public.membership_charges
      WHERE membership_id = ${membershipId} AND account_id = ${accountId}
        AND status = 'pending' AND amount_cents = 0
    `) as Row[];
    for (const charge of freeFirst) {
      await settleCharge(
        accountId,
        String(charge.id),
        { status: "paid", via: Number(charge.cycle_number) === 0 ? "trial" : "free" },
        "",
      );
    }
  }

  // A new card on a membership that is behind: try it now rather than at the
  // next scheduled retry. A member who has just fixed their card expects it
  // to be used.
  if (metadata.purpose === "card") {
    await db().sql`
      UPDATE public.memberships
      SET failed_attempts = 0,
          status = CASE WHEN status = 'paused' AND paused_at IS NOT NULL AND cancel_reason = 'payment_failed'
                        THEN 'past_due' ELSE status END,
          cancel_reason = CASE WHEN cancel_reason = 'payment_failed' THEN NULL ELSE cancel_reason END,
          next_action_at = NOW(),
          updated_at = NOW()
      WHERE id = ${membershipId} AND account_id = ${accountId}
        AND status IN ('past_due', 'paused')
        AND EXISTS (
          SELECT 1 FROM public.membership_charges c
          WHERE c.membership_id = ${membershipId} AND c.status IN ('failed', 'requires_action')
        )
    `;
    await processMembership(accountId, membershipId).catch((error) =>
      console.error("memberships:retry_after_card_failed", membershipId, error),
    );
  }

  return { status: "saved", membershipId };
}

type ChargeAttempt =
  | { outcome: "succeeded"; paymentIntentId: string }
  | { outcome: "processing"; paymentIntentId: string }
  | { outcome: "failed" | "requires_action"; paymentIntentId: string; message: string };

async function chargeSavedCard(
  credential: StripeCredential,
  input: {
    accountId: string;
    membershipId: string;
    chargeId: string;
    attempt: number;
    amountCents: number;
    currency: string;
    customer: string;
    paymentMethod: string;
    description: string;
  },
): Promise<ChargeAttempt> {
  const params = new URLSearchParams();
  params.set("amount", String(input.amountCents));
  params.set("currency", input.currency.toLowerCase());
  params.set("customer", input.customer);
  params.set("payment_method", input.paymentMethod);
  params.set("off_session", "true");
  params.set("confirm", "true");
  params.set("description", input.description);
  params.set("metadata[clarity_account_id]", input.accountId);
  params.set("metadata[clarity_membership_id]", input.membershipId);
  params.set("metadata[clarity_membership_charge_id]", input.chargeId);
  const fee = applicationFeeCents(credential, input.amountCents);
  if (fee > 0) params.set("application_fee_amount", String(fee));

  // One key per attempt: re-sending the same attempt (after a timeout, say)
  // returns Stripe's first answer instead of charging twice; the next retry is
  // a new attempt and a new key.
  const { ok, body } = await stripePost(
    credential,
    "payment_intents",
    params,
    `membership-charge-${input.chargeId}-${input.attempt}`,
  );
  if (ok) {
    const id = String(body.id || "");
    if (body.status === "succeeded") return { outcome: "succeeded", paymentIntentId: id };
    if (body.status === "processing") return { outcome: "processing", paymentIntentId: id };
    if (body.status === "requires_action") {
      return { outcome: "requires_action", paymentIntentId: id, message: "The bank asked the member to confirm this payment." };
    }
    return { outcome: "failed", paymentIntentId: id, message: "The card was not charged." };
  }
  const error = (body.error || {}) as Row;
  const paymentIntentId = String(error.payment_intent?.id || "");
  const message = text(error.message, 300) || "The card was declined.";
  if (error.code === "authentication_required" || error.payment_intent?.status === "requires_action") {
    return { outcome: "requires_action", paymentIntentId, message };
  }
  return { outcome: "failed", paymentIntentId, message };
}

// ---------------------------------------------------------------------------
// Settling a period, and what it grants
// ---------------------------------------------------------------------------

/**
 * Append one period's credits to the member's passes. Idempotent at three
 * levels: granted_at on the charge, the pass's unique source_ref, and the
 * allocation's unique (pass_id, allocation_period_start).
 */
async function grantChargeEntitlements(client: Queryable, accountId: string, chargeId: string) {
  const { rows } = await client.query(
    `SELECT c.id, c.status, c.granted_at, c.period_start, c.period_end, c.cycle_number,
            m.id AS membership_id, m.person_id, m.plan_snapshot
     FROM public.membership_charges c
     JOIN public.memberships m ON m.id = c.membership_id AND m.account_id = c.account_id
     WHERE c.id = $1 AND c.account_id = $2
     FOR UPDATE OF c`,
    [chargeId, accountId],
  );
  const charge = rows[0];
  if (!charge || charge.granted_at || !["paid", "waived"].includes(charge.status)) return;
  const plan = charge.plan_snapshot as PlanSnapshot;

  for (const entitlement of plan.entitlements || []) {
    const sourceRef = `membership:${charge.membership_id}:${entitlement.id}`;
    const passName =
      entitlement.name && plan.entitlements.length > 1 ? `${plan.name} · ${entitlement.name}` : entitlement.name || plan.name;
    await client.query(
      `INSERT INTO public.passes (
         id, account_id, person_id, name, template_service_id, covers_service_ids,
         issued_at, expires_at, status, source, source_ref, allocation_mode,
         allocation_interval, allocation_interval_count, credits_per_period,
         rollover_policy, max_balance, note, created_by, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, NULL, $5, NOW(), NULL, 'active', 'membership', $6, 'recurring',
         $7, $8, $9, $10, $11, $12, 'membership', NOW(), NOW()
       )
       ON CONFLICT DO NOTHING`,
      [
        `pass-${randomUUID()}`,
        accountId,
        charge.person_id,
        passName,
        entitlement.serviceIds,
        sourceRef,
        plan.interval,
        plan.intervalCount,
        entitlement.credits,
        entitlement.rollover,
        entitlement.rollover === "rollover_capped" ? entitlement.maxBalance : null,
        `Membership: ${plan.name}`,
      ],
    );
    const passRows = (
      await client.query(
        `SELECT p.id, p.status, COALESCE(b.credits_available, 0) AS credits_available
         FROM public.passes p
         LEFT JOIN public.pass_balances b ON b.pass_id = p.id AND b.account_id = p.account_id
         WHERE p.account_id = $1 AND p.source = 'membership' AND p.source_ref = $2
         LIMIT 1`,
        [accountId, sourceRef],
      )
    ).rows;
    const pass = passRows[0];
    if (!pass || pass.status === "void") continue;

    const credits = creditsForPeriod(entitlement, Number(pass.credits_available) || 0);
    if (credits <= 0) continue;
    await client.query(
      `INSERT INTO public.pass_allocations (
         id, account_id, pass_id, credits, credits_requested, available_from, expires_at,
         allocation_period_start, allocation_period_end, source, source_ref, note,
         created_by, created_at, entitlement_service_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $6, $8, 'membership', $9, $10, 'membership', NOW(), $11)
       ON CONFLICT DO NOTHING`,
      [
        `alloc-${randomUUID()}`,
        accountId,
        pass.id,
        credits,
        entitlement.rollover === "rollover_capped" ? entitlement.credits : null,
        charge.period_start,
        entitlement.rollover === "expire_each_period" ? charge.period_end : null,
        charge.period_end,
        charge.id,
        Number(charge.cycle_number) === 0 ? "Trial" : `Period ${charge.cycle_number}`,
        entitlement.serviceIds.length === 1 ? entitlement.serviceIds[0] : null,
      ],
    );
  }
  await client.query(
    `UPDATE public.membership_charges SET granted_at = NOW(), updated_at = NOW() WHERE id = $1 AND account_id = $2`,
    [chargeId, accountId],
  );
}

/**
 * Mark a period paid (or waived) and grant what it buys, as one transaction.
 * Safe to call again: a settled charge is left alone, and granting is
 * idempotent.
 */
export async function settleCharge(
  accountId: string,
  chargeId: string,
  how: { status: "paid" | "waived"; via: string; paymentIntentId?: string; note?: string },
  actorId: string,
) {
  const client = await db().pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE public.membership_charges
       SET status = $3, paid_at = NOW(), paid_via = $4,
           stripe_payment_intent_id = COALESCE(NULLIF($5, ''), stripe_payment_intent_id),
           note = CASE WHEN $6 = '' THEN note ELSE $6 END,
           last_error = NULL, updated_at = NOW()
       WHERE id = $1 AND account_id = $2
         AND status IN ('pending', 'processing', 'failed', 'requires_action')
       RETURNING membership_id`,
      [chargeId, accountId, how.status, text(how.via, 60) || "manual", how.paymentIntentId || "", text(how.note, 300)],
    );
    if (rows[0]) {
      // Paying the oldest debt brings a past-due member back; a paused or
      // cancelled one stays as a coach left it.
      await client.query(
        `UPDATE public.memberships m
         SET failed_attempts = 0,
             status = CASE
               WHEN m.status IN ('past_due', 'active', 'trialing') AND NOT EXISTS (
                 SELECT 1 FROM public.membership_charges c
                 WHERE c.membership_id = m.id AND c.status IN ('failed', 'requires_action')
               ) THEN (CASE WHEN m.cycles_raised = 0 THEN 'trialing' ELSE 'active' END)
               ELSE m.status END,
             next_action_at = CASE
               WHEN m.status IN ('past_due', 'active', 'trialing') THEN m.current_period_end
               ELSE m.next_action_at END,
             updated_at = NOW()
         WHERE m.id = $1 AND m.account_id = $2`,
        [rows[0].membership_id, accountId],
      );
    }
    await grantChargeEntitlements(client, accountId, chargeId);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Credits from a membership stop when it does. */
async function expireMembershipPasses(accountId: string, membershipId: string, at: Date) {
  await db().sql`
    UPDATE public.passes
    SET expires_at = ${at.toISOString()}, updated_at = NOW()
    WHERE account_id = ${accountId}
      AND source = 'membership'
      AND source_ref LIKE ${`membership:${membershipId}:%`}
      AND (expires_at IS NULL OR expires_at > ${at.toISOString()})
  `;
}

async function finishMembership(
  accountId: string,
  membershipId: string,
  status: "cancelled" | "ended",
  at: Date,
  reason: string,
) {
  await db().sql`
    UPDATE public.memberships
    SET status = ${status}, ended_at = ${at.toISOString()}, next_action_at = NULL,
        cancel_reason = COALESCE(NULLIF(${reason}, ''), cancel_reason), updated_at = NOW()
    WHERE id = ${membershipId} AND account_id = ${accountId}
  `;
  // Nothing more is owed for periods that will never be delivered.
  await db().sql`
    UPDATE public.membership_charges
    SET status = 'void', updated_at = NOW()
    WHERE membership_id = ${membershipId} AND account_id = ${accountId}
      AND status IN ('pending', 'failed', 'requires_action')
      AND period_start >= ${at.toISOString()}
  `;
  await expireMembershipPasses(accountId, membershipId, at);
}

// ---------------------------------------------------------------------------
// Enrolling
// ---------------------------------------------------------------------------

function chargeDescription(plan: PlanSnapshot, planned: PlannedCharge) {
  const day = (date: Date) => date.toISOString().slice(0, 10);
  const label = planned.cycleNumber === 0 ? `${plan.name} trial` : plan.name;
  return `${label} ${day(planned.period.start)} to ${day(planned.period.end)}`;
}

async function insertCharge(
  client: Queryable,
  accountId: string,
  membershipId: string,
  personId: string,
  plan: PlanSnapshot,
  planned: PlannedCharge,
  actorId: string,
): Promise<string | null> {
  const id = `mcharge-${randomUUID()}`;
  const { rows } = await client.query(
    `INSERT INTO public.membership_charges (
       id, account_id, membership_id, person_id, cycle_number, period_start, period_end,
       amount_cents, signup_fee_cents, currency, description, status, created_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12)
     ON CONFLICT (membership_id, cycle_number) DO NOTHING
     RETURNING id`,
    [
      id,
      accountId,
      membershipId,
      personId,
      planned.cycleNumber,
      planned.period.start.toISOString(),
      planned.period.end.toISOString(),
      planned.amountCents,
      planned.signupFeeCents,
      plan.currency,
      chargeDescription(plan, planned),
      actorId,
    ],
  );
  return rows[0]?.id || null;
}

export type EnrolInput = {
  personId: unknown;
  planId: unknown;
  /** yyyy-mm-dd; today or later. Defaults to now. */
  startDate?: unknown;
  collection?: unknown;
  note?: unknown;
};

/**
 * Put a person on a plan.
 *
 * Manual memberships start straight away and raise their first charge for a
 * coach to mark paid. Card memberships start 'incomplete' and stay that way
 * until the member finishes the card form -- nothing is granted and nothing is
 * billed for somebody who never gave a card.
 */
export async function enrolMembership(
  input: EnrolInput,
  actor: MembershipActor,
  options: { onlineOnly?: boolean; now?: Date } = {},
): Promise<MembershipView> {
  const { accountId } = actor;
  const now = options.now || new Date();
  const personId = text(input.personId, 160);
  const planId = text(input.planId, 120);
  if (!personId) fail("Who is joining?");
  const plan = planId ? await readPlan(accountId, planId) : null;
  if (!plan || !plan.active) fail("That plan is not available.", 404, "not_found");
  if (options.onlineOnly && !plan.sellOnline) fail("That plan is not available.", 404, "not_found");
  if (!plan.entitlements.length && plan.priceCents === 0) fail("That plan has nothing to give or charge.");

  const people = (await db().sql`
    SELECT id FROM public.people WHERE id = ${personId} AND account_id = ${accountId} LIMIT 1
  `) as Row[];
  if (!people.length) fail("That client was not found.", 404, "not_found");

  const collection = input.collection === "card" ? "card" : "manual";
  if (collection === "card") await cardCredential(accountId);

  // One live membership per plan per person. An unfinished card signup is
  // replaced rather than refused, so going back and trying again works.
  const existing = (await db().sql`
    SELECT id, status FROM public.memberships
    WHERE account_id = ${accountId} AND person_id = ${personId} AND plan_id = ${planId}
      AND status IN ('incomplete', 'trialing', 'active', 'past_due', 'paused')
  `) as Row[];
  for (const row of existing) {
    if (row.status !== "incomplete") fail("They are already on this plan.", 409, "already_member");
    await finishMembership(accountId, String(row.id), "cancelled", now, "Replaced by a new signup");
  }

  const startText = text(input.startDate, 10);
  let startedAt = now;
  if (/^\d{4}-\d{2}-\d{2}$/.test(startText) && startText > now.toISOString().slice(0, 10)) {
    startedAt = new Date(`${startText}T${now.toISOString().slice(11)}`);
    if (Number.isNaN(startedAt.getTime())) startedAt = now;
  }

  const snapshot = planSnapshot(plan);
  const planned = firstCharge(snapshot, startedAt);
  const membershipId = `mem-${randomUUID()}`;
  const status: MembershipStatus = collection === "card" ? "incomplete" : planned.cycleNumber === 0 ? "trialing" : "active";

  let chargeId: string | null = null;
  const client = await db().pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.memberships (
         id, account_id, person_id, plan_id, plan_snapshot, status, collection,
         started_at, trial_ends_at, current_period_start, current_period_end,
         next_action_at, cycles_raised, note, created_by
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        membershipId,
        accountId,
        personId,
        plan.id,
        JSON.stringify(snapshot),
        status,
        collection,
        startedAt.toISOString(),
        planned.cycleNumber === 0 ? planned.period.end.toISOString() : null,
        planned.period.start.toISOString(),
        planned.period.end.toISOString(),
        collection === "manual" ? planned.period.end.toISOString() : null,
        planned.cycleNumber,
        text(input.note, 300),
        actor.actorId,
      ],
    );
    chargeId = await insertCharge(client, accountId, membershipId, personId, snapshot, planned, actor.actorId);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  if (collection === "manual" && chargeId && planned.amountCents === 0) {
    await settleCharge(accountId, chargeId, { status: "paid", via: planned.cycleNumber === 0 ? "trial" : "free" }, actor.actorId);
  }
  return readMembership(accountId, membershipId);
}

// ---------------------------------------------------------------------------
// The billing job
// ---------------------------------------------------------------------------

const LOCK_SECONDS = 120;
const PROCESSING_RECHECK_MS = 10 * 60 * 1000;

async function claim(accountId: string, membershipId: string): Promise<Row | null> {
  const rows = (await db().sql`
    UPDATE public.memberships
    SET locked_until = NOW() + make_interval(secs => ${LOCK_SECONDS})
    WHERE id = ${membershipId} AND account_id = ${accountId}
      AND (locked_until IS NULL OR locked_until < NOW())
    RETURNING id
  `) as Row[];
  return rows[0] || null;
}

async function release(accountId: string, membershipId: string) {
  await db().sql`
    UPDATE public.memberships SET locked_until = NULL WHERE id = ${membershipId} AND account_id = ${accountId}
  `;
}

async function readEngineRow(accountId: string, membershipId: string) {
  const rows = (await db().sql`
    SELECT m.*, (p.id IS NOT NULL) AS person_exists, p.name AS person_name, p.email AS person_email
    FROM public.memberships m
    LEFT JOIN public.people p ON p.id = m.person_id AND p.account_id = m.account_id
    WHERE m.id = ${membershipId} AND m.account_id = ${accountId}
    LIMIT 1
  `) as Row[];
  return rows[0] || null;
}

async function readOpenCardCharge(accountId: string, membershipId: string) {
  const rows = (await db().sql`
    SELECT * FROM public.membership_charges
    WHERE membership_id = ${membershipId} AND account_id = ${accountId}
      AND status IN ('failed', 'requires_action', 'processing')
    ORDER BY cycle_number ASC
    LIMIT 1
  `) as Row[];
  return rows[0] || null;
}

function siteOrigin() {
  return String(globalThis.Netlify?.env?.get("URL") || process.env.URL || "").replace(/\/$/, "");
}

/** Best effort: a member whose card failed is told, once per charge. */
async function notifyPaymentFailed(accountId: string, row: Row, charge: Row, message: string) {
  const email = String(row.person_email || "");
  if (!email.includes("@")) return;
  const plan = row.plan_snapshot as PlanSnapshot;
  const origin = siteOrigin();
  const amount = `${(Number(charge.amount_cents) / 100).toFixed(2)} ${String(charge.currency)}`;
  const lines = [
    `Hi ${String(row.person_name || "there")},`,
    "",
    `We could not take your ${plan.name} payment of ${amount}.`,
    message ? `The bank said: ${message}` : "",
    "",
    "We will try again over the next few days. To use a different card, sign in and update it under Membership:",
    origin ? `${origin}/` : "",
  ].filter((line, index, all) => line !== "" || all[index - 1] !== "");
  await deliverEmail({
    accountId,
    to: email,
    subject: `Your ${plan.name} payment did not go through`,
    text: lines.join("\n"),
    idempotencyKey: `membership-failed-${charge.id}`,
  }).catch(() => null);
}

async function attemptCardCharge(accountId: string, row: Row, charge: Row, now: Date, recheck = false) {
  const membershipId = String(row.id);
  if (!row.stripe_customer_id || !row.stripe_payment_method_id) {
    await recordFailure(accountId, row, charge, "No card is saved for this membership.", null, now, "failed");
    return;
  }
  let attempt = Number(charge.attempts) || 0;
  if (!recheck) {
    const bumped = (await db().sql`
      UPDATE public.membership_charges
      SET attempts = attempts + 1, last_attempt_at = NOW(), status = 'processing', updated_at = NOW()
      WHERE id = ${String(charge.id)} AND account_id = ${accountId}
        AND status IN ('pending', 'failed', 'requires_action')
      RETURNING attempts
    `) as Row[];
    if (!bumped[0]) return;
    attempt = Number(bumped[0].attempts);
  }
  const credential = await cardCredential(accountId);
  const result = await chargeSavedCard(credential, {
    accountId,
    membershipId,
    chargeId: String(charge.id),
    attempt,
    amountCents: Number(charge.amount_cents),
    currency: String(charge.currency),
    customer: String(row.stripe_customer_id),
    paymentMethod: String(row.stripe_payment_method_id),
    description: String(charge.description || (row.plan_snapshot as PlanSnapshot).name),
  });

  if (result.outcome === "succeeded") {
    await settleCharge(accountId, String(charge.id), { status: "paid", via: "card", paymentIntentId: result.paymentIntentId }, "");
    return;
  }
  if (result.outcome === "processing") {
    await db().sql`
      UPDATE public.membership_charges
      SET stripe_payment_intent_id = ${result.paymentIntentId || null}, last_attempt_at = NOW(), updated_at = NOW()
      WHERE id = ${String(charge.id)} AND account_id = ${accountId}
    `;
    return;
  }
  await recordFailure(accountId, row, charge, result.message, result.paymentIntentId, now, result.outcome);
}

async function recordFailure(
  accountId: string,
  row: Row,
  charge: Row,
  message: string,
  paymentIntentId: string | null,
  now: Date,
  status: "failed" | "requires_action",
) {
  const membershipId = String(row.id);
  await db().sql`
    UPDATE public.membership_charges
    SET status = ${status}, last_error = ${message},
        stripe_payment_intent_id = COALESCE(${paymentIntentId || null}, stripe_payment_intent_id),
        updated_at = NOW()
    WHERE id = ${String(charge.id)} AND account_id = ${accountId}
  `;
  const failedAttempts = (Number(row.failed_attempts) || 0) + 1;
  const retryAt = nextRetryAt(failedAttempts, now);
  if (retryAt) {
    await db().sql`
      UPDATE public.memberships
      SET status = 'past_due', failed_attempts = ${failedAttempts},
          next_action_at = ${retryAt.toISOString()}, updated_at = NOW()
      WHERE id = ${membershipId} AND account_id = ${accountId}
    `;
    if (failedAttempts === 1) await notifyPaymentFailed(accountId, row, charge, message);
    return;
  }
  const plan = row.plan_snapshot as PlanSnapshot;
  if (plan.failedPaymentAction === "cancel") {
    await finishMembership(accountId, membershipId, "cancelled", now, "payment_failed");
    return;
  }
  await db().sql`
    UPDATE public.memberships
    SET status = 'paused', paused_at = NOW(), failed_attempts = ${failedAttempts},
        cancel_reason = 'payment_failed', next_action_at = NULL, updated_at = NOW()
    WHERE id = ${membershipId} AND account_id = ${accountId}
  `;
}

/**
 * Bring one membership up to date: raise periods that have started, charge
 * what is due, retry what failed, finish what has ended. Runs a step at a time
 * under a short lock, so a job that was down catches up period by period.
 */
export async function processMembership(accountId: string, membershipId: string, now = new Date()) {
  if (!(await claim(accountId, membershipId))) return { busy: true, steps: 0 };
  let steps = 0;
  try {
    for (; steps < 24; steps += 1) {
      const row = await readEngineRow(accountId, membershipId);
      if (!row) break;
      if (!row.person_exists && LIVE.includes(row.status)) {
        await finishMembership(accountId, membershipId, "cancelled", now, "Client deleted");
        break;
      }
      const plan = row.plan_snapshot as PlanSnapshot;
      const open = row.collection === "card" ? await readOpenCardCharge(accountId, membershipId) : null;

      if (open?.status === "processing") {
        const last = asDate(open.last_attempt_at)?.getTime() || 0;
        if (now.getTime() - last >= PROCESSING_RECHECK_MS && Number(open.attempts) > 0) {
          // Same attempt, same idempotency key: Stripe answers with what
          // actually happened instead of charging again.
          await attemptCardCharge(accountId, row, open, now, true);
          continue;
        }
        await db().sql`
          UPDATE public.memberships
          SET next_action_at = ${new Date(Math.max(now.getTime(), last) + PROCESSING_RECHECK_MS).toISOString()}
          WHERE id = ${membershipId} AND account_id = ${accountId}
        `;
        break;
      }

      const step = planStep(
        {
          status: row.status,
          collection: row.collection,
          currentPeriodEnd: asDate(row.current_period_end),
          cyclesRaised: Number(row.cycles_raised) || 0,
          cancelAtPeriodEnd: row.cancel_at_period_end === true,
          termCycles: plan.termCycles ?? null,
          hasCard: Boolean(row.stripe_payment_method_id),
          openCardCharge: open ? { status: open.status, nextRetryAt: asDate(row.next_action_at) } : null,
        },
        now,
      );

      if (step.kind === "wait") {
        await db().sql`
          UPDATE public.memberships SET next_action_at = ${step.until ? step.until.toISOString() : null}
          WHERE id = ${membershipId} AND account_id = ${accountId}
        `;
        break;
      }
      if (step.kind === "finish") {
        const end = asDate(row.current_period_end) || now;
        await finishMembership(
          accountId,
          membershipId,
          step.reason === "cancelled" ? "cancelled" : "ended",
          end,
          step.reason === "cancelled" ? "" : "term_complete",
        );
        break;
      }
      if (step.kind === "retry" && open) {
        await attemptCardCharge(accountId, row, open, now);
        continue;
      }
      if (step.kind === "raise") {
        const previousEnd = asDate(row.current_period_end) || now;
        const preferredDay = plan.anchor === "day_of_month" && plan.anchorDay ? plan.anchorDay : asDate(row.started_at)!.getUTCDate();
        const planned = nextCharge(plan, Number(row.cycles_raised) || 0, previousEnd, preferredDay);
        let chargeId: string | null = null;
        const client = await db().pool.connect();
        try {
          await client.query("BEGIN");
          chargeId = await insertCharge(client, accountId, membershipId, String(row.person_id), plan, planned, "billing");
          await client.query(
            `UPDATE public.memberships
             SET current_period_start = $3, current_period_end = $4, cycles_raised = $5,
                 status = CASE WHEN status = 'trialing' THEN 'active' ELSE status END,
                 next_action_at = $4, updated_at = NOW()
             WHERE id = $1 AND account_id = $2`,
            [
              membershipId,
              accountId,
              planned.period.start.toISOString(),
              planned.period.end.toISOString(),
              planned.cycleNumber,
            ],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
        if (!chargeId) continue;
        if (planned.amountCents === 0) {
          await settleCharge(accountId, chargeId, { status: "paid", via: "free" }, "billing");
        } else if (row.collection === "card") {
          const charge = (await db().sql`
            SELECT * FROM public.membership_charges WHERE id = ${chargeId} AND account_id = ${accountId}
          `) as Row[];
          if (charge[0]) await attemptCardCharge(accountId, row, charge[0], now);
        }
        continue;
      }
      break;
    }
  } finally {
    await release(accountId, membershipId).catch(() => null);
  }
  return { busy: false, steps };
}

/**
 * The scheduled run: every membership with something due, across every
 * business. Each one is processed under its own account id, so nothing here
 * reads or writes across the tenant boundary.
 */
export async function runDueMemberships(options: { budgetMs: number; now?: Date }) {
  const started = Date.now();
  const now = options.now || new Date();

  // Card signups nobody finished. Checkout links die after a day; two is
  // generous, and leaving them would show phantom members forever.
  const abandoned = (await db().sql`
    SELECT id, account_id FROM public.memberships
    WHERE status = 'incomplete' AND created_at < NOW() - INTERVAL '2 days'
    LIMIT 50
  `) as Row[];
  for (const row of abandoned) {
    await finishMembership(String(row.account_id), String(row.id), "cancelled", now, "Card never added");
  }

  const due = (await db().sql`
    SELECT id, account_id FROM public.memberships
    WHERE status IN ('trialing', 'active', 'past_due')
      AND next_action_at IS NOT NULL AND next_action_at <= NOW()
      AND (locked_until IS NULL OR locked_until < NOW())
    ORDER BY next_action_at
    LIMIT 50
  `) as Row[];
  let processed = 0;
  let failed = 0;
  for (const row of due) {
    if (Date.now() - started > options.budgetMs) break;
    try {
      await processMembership(String(row.account_id), String(row.id), now);
      processed += 1;
    } catch (error) {
      failed += 1;
      console.error("memberships:process_failed", row.id, error instanceof Error ? error.message : error);
    }
  }
  return { due: due.length, processed, failed, abandoned: abandoned.length };
}

// ---------------------------------------------------------------------------
// Stripe webhook
// ---------------------------------------------------------------------------

/**
 * The webhook's half. Returns null for events that are not a membership's, so
 * the caller can hand them on to whatever else listens.
 */
export async function handleMembershipStripeEvent(accountId: string, type: string, object: Row) {
  const metadata = (object?.metadata || {}) as Record<string, string>;
  if (type === "checkout.session.completed" && metadata.clarity_membership_id) {
    if (metadata.clarity_account_id !== accountId) return { ignored: "other_account" };
    return completeCardCheckout(accountId, String(object.id));
  }
  if (type === "payment_intent.succeeded" && metadata.clarity_membership_charge_id) {
    if (metadata.clarity_account_id !== accountId) return { ignored: "other_account" };
    const chargeId = text(metadata.clarity_membership_charge_id, 120);
    const rows = (await db().sql`
      SELECT amount_cents FROM public.membership_charges WHERE id = ${chargeId} AND account_id = ${accountId}
    `) as Row[];
    if (!rows[0]) return { ignored: "unknown_charge" };
    if (Number(object.amount_received ?? object.amount) !== Number(rows[0].amount_cents)) {
      console.error("memberships:amount_mismatch", accountId, chargeId, object.id);
      return { ignored: "amount_mismatch" };
    }
    await settleCharge(accountId, chargeId, { status: "paid", via: "card", paymentIntentId: String(object.id) }, "");
    return { settled: chargeId };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type MembershipAction =
  | "cancel_at_period_end"
  | "undo_cancel"
  | "end_now"
  | "pause"
  | "resume"
  | "retry"
  | "use_manual";

/**
 * Change a membership. `byMember` is true when the member asked from the
 * portal: they may only cancel (honouring the minimum commitment) or undo it.
 */
export async function membershipAction(
  membershipId: string,
  action: MembershipAction,
  actor: MembershipActor,
  options: { byMember?: boolean; personId?: string; reason?: string; now?: Date } = {},
): Promise<MembershipView> {
  const { accountId } = actor;
  const now = options.now || new Date();
  const membership = await readMembership(accountId, membershipId);
  if (options.byMember) {
    if (membership.personId !== options.personId) fail("That membership was not found.", 404, "not_found");
    if (action !== "cancel_at_period_end" && action !== "undo_cancel") fail("Ask your coach to do that.", 403, "forbidden");
    if (action === "cancel_at_period_end" && !membership.memberMayCancel) {
      fail(
        `This plan has a minimum of ${membership.plan.minCycles} payments. You can cancel after that.`,
        409,
        "minimum_term",
      );
    }
  }
  const id = membership.id;
  const reason = text(options.reason, 300);

  switch (action) {
    case "cancel_at_period_end": {
      if (membership.status === "incomplete") {
        await finishMembership(accountId, id, "cancelled", now, reason || "Cancelled before it started");
        break;
      }
      if (!LIVE.includes(membership.status) && membership.status !== "paused") fail("That membership has already ended.", 409, "ended");
      if (membership.status === "paused") {
        await finishMembership(accountId, id, "cancelled", now, reason || "Cancelled while paused");
        break;
      }
      await db().sql`
        UPDATE public.memberships
        SET cancel_at_period_end = TRUE, cancel_requested_at = NOW(),
            cancel_reason = ${reason || (options.byMember ? "Cancelled by member" : "Cancelled by coach")},
            updated_at = NOW()
        WHERE id = ${id} AND account_id = ${accountId}
      `;
      break;
    }
    case "undo_cancel":
      await db().sql`
        UPDATE public.memberships
        SET cancel_at_period_end = FALSE, cancel_requested_at = NULL, cancel_reason = NULL, updated_at = NOW()
        WHERE id = ${id} AND account_id = ${accountId}
          AND status IN ('trialing', 'active', 'past_due')
      `;
      break;
    case "end_now":
      if (membership.status === "cancelled" || membership.status === "ended") fail("That membership has already ended.", 409, "ended");
      await finishMembership(accountId, id, "cancelled", now, reason || "Ended by coach");
      break;
    case "pause":
      if (!LIVE.includes(membership.status)) fail("Only a running membership can be paused.", 409, "not_live");
      await db().sql`
        UPDATE public.memberships
        SET status = 'paused', paused_at = NOW(), next_action_at = NULL, updated_at = NOW()
        WHERE id = ${id} AND account_id = ${accountId}
      `;
      break;
    case "resume": {
      if (membership.status !== "paused") fail("That membership is not paused.", 409, "not_paused");
      const owes = membership.charges.some((charge) => charge.status === "failed" || charge.status === "requires_action");
      // Resuming re-starts the clock from today: the paused weeks are neither
      // billed nor granted. A membership paused part-way through a period it
      // already paid for keeps the rest of that period.
      await db().sql`
        UPDATE public.memberships
        SET status = ${owes ? "past_due" : "active"},
            paused_at = NULL, failed_attempts = 0,
            cancel_reason = CASE WHEN cancel_reason = 'payment_failed' THEN NULL ELSE cancel_reason END,
            current_period_end = GREATEST(current_period_end, NOW()),
            next_action_at = NOW(), updated_at = NOW()
        WHERE id = ${id} AND account_id = ${accountId}
      `;
      await processMembership(accountId, id, now);
      break;
    }
    case "retry":
      if (!LIVE.includes(membership.status)) fail("That membership is not running.", 409, "not_live");
      await db().sql`
        UPDATE public.memberships SET next_action_at = NOW(), updated_at = NOW()
        WHERE id = ${id} AND account_id = ${accountId}
      `;
      await processMembership(accountId, id, now);
      break;
    case "use_manual":
      await db().sql`
        UPDATE public.memberships
        SET collection = 'manual', stripe_payment_method_id = NULL, card_label = NULL,
            status = CASE WHEN status = 'incomplete' THEN (CASE WHEN cycles_raised = 0 THEN 'trialing' ELSE 'active' END) ELSE status END,
            next_action_at = COALESCE(next_action_at, current_period_end),
            updated_at = NOW()
        WHERE id = ${id} AND account_id = ${accountId}
      `;
      // Failed card charges become ordinary bills for a coach to collect.
      await db().sql`
        UPDATE public.membership_charges SET status = 'pending', updated_at = NOW()
        WHERE membership_id = ${id} AND account_id = ${accountId} AND status IN ('failed', 'requires_action')
      `;
      await db().sql`
        UPDATE public.memberships
        SET status = CASE WHEN status = 'past_due' THEN 'active' ELSE status END, failed_attempts = 0
        WHERE id = ${id} AND account_id = ${accountId}
      `;
      break;
    default:
      fail("Unknown action.");
  }
  return readMembership(accountId, id);
}

/** A coach recording money taken outside Clarity Pay, or letting a period go. */
export async function chargeAction(
  chargeId: string,
  action: "mark_paid" | "waive" | "void",
  actor: MembershipActor,
  options: { via?: string; note?: string } = {},
): Promise<MembershipView> {
  const { accountId } = actor;
  const rows = (await db().sql`
    SELECT id, membership_id, status FROM public.membership_charges
    WHERE id = ${text(chargeId, 120)} AND account_id = ${accountId} LIMIT 1
  `) as Row[];
  const charge = rows[0];
  if (!charge) fail("That charge was not found.", 404, "not_found");
  if (!["pending", "failed", "requires_action"].includes(charge.status)) {
    fail("That charge is already settled.", 409, "settled");
  }
  if (action === "void") {
    await db().sql`
      UPDATE public.membership_charges
      SET status = 'void', note = ${text(options.note, 300)}, updated_at = NOW()
      WHERE id = ${String(charge.id)} AND account_id = ${accountId}
    `;
    await db().sql`
      UPDATE public.memberships m
      SET status = CASE WHEN m.status = 'past_due' AND NOT EXISTS (
            SELECT 1 FROM public.membership_charges c
            WHERE c.membership_id = m.id AND c.status IN ('failed', 'requires_action')
          ) THEN 'active' ELSE m.status END,
          failed_attempts = 0,
          next_action_at = CASE WHEN m.status = 'past_due' THEN m.current_period_end ELSE m.next_action_at END
      WHERE m.id = ${String(charge.membership_id)} AND m.account_id = ${accountId}
    `;
  } else {
    await settleCharge(
      accountId,
      String(charge.id),
      action === "waive"
        ? { status: "waived", via: "waived", note: options.note }
        : { status: "paid", via: text(options.via, 60) || "Cash", note: options.note },
      actor.actorId,
    );
  }
  return readMembership(accountId, String(charge.membership_id));
}

// ---------------------------------------------------------------------------
// The player portal
// ---------------------------------------------------------------------------

export type PlayerMembershipView = {
  id: string;
  name: string;
  description: string;
  status: MembershipStatus;
  priceCents: number;
  currency: string;
  interval: PlanSnapshot["interval"];
  intervalCount: number;
  collection: "card" | "manual";
  cardLabel: string;
  currentPeriodEnd: string | null;
  nextChargeAt: string | null;
  cancelAtPeriodEnd: boolean;
  mayCancel: boolean;
  minCycles: number;
  outstandingCents: number;
  entitlements: Array<{ name: string; credits: number }>;
};

export type PlayerPlanView = {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  interval: PlanSnapshot["interval"];
  intervalCount: number;
  signupFeeCents: number;
  trialDays: number;
  termCycles: number | null;
  minCycles: number;
  entitlements: Array<{ name: string; credits: number }>;
};

function entitlementLabels(plan: PlanSnapshot, serviceNames: Map<string, string>) {
  return plan.entitlements.map((entitlement) => ({
    name:
      entitlement.name ||
      entitlement.serviceIds.map((sid) => serviceNames.get(sid) || "").filter(Boolean).join(", ") ||
      plan.name,
    credits: entitlement.credits,
  }));
}

/** What a member sees: no ids from the catalogue, no Stripe ids, no notes. */
export async function readPlayerMemberships(
  accountId: string,
  personId: string,
  serviceNames: Map<string, string>,
  canSell: boolean,
): Promise<{ memberships: PlayerMembershipView[]; plans: PlayerPlanView[] }> {
  if (!accountId) return { memberships: [], plans: [] };
  const mine = personId
    ? (await readMemberships(accountId, { personId })).filter((m) => m.status !== "incomplete" && m.status !== "ended" && m.status !== "cancelled")
    : [];
  const plans = canSell ? (await readPlans(accountId)).filter((plan) => plan.active && plan.sellOnline) : [];
  const held = new Set(mine.map((m) => m.planId));
  return {
    memberships: mine.map((m) => ({
      id: m.id,
      name: m.plan.name,
      description: m.plan.description,
      status: m.status,
      priceCents: m.plan.priceCents,
      currency: m.plan.currency,
      interval: m.plan.interval,
      intervalCount: m.plan.intervalCount,
      collection: m.collection,
      cardLabel: m.cardLabel,
      currentPeriodEnd: m.currentPeriodEnd,
      nextChargeAt: m.nextChargeAt,
      cancelAtPeriodEnd: m.cancelAtPeriodEnd,
      mayCancel: m.memberMayCancel,
      minCycles: m.plan.minCycles,
      outstandingCents: m.outstandingCents,
      entitlements: entitlementLabels(m.plan, serviceNames),
    })),
    plans: plans
      .filter((plan) => !held.has(plan.id))
      .map((plan) => ({
        id: plan.id,
        name: plan.name,
        description: plan.description,
        priceCents: plan.priceCents,
        currency: plan.currency,
        interval: plan.interval,
        intervalCount: plan.intervalCount,
        signupFeeCents: plan.signupFeeCents,
        trialDays: plan.trialDays,
        termCycles: plan.termCycles,
        minCycles: plan.minCycles,
        entitlements: entitlementLabels(plan, serviceNames),
      })),
  };
}
