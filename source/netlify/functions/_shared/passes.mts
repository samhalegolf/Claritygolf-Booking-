/**
 * The Pass engine: issuing entitlements, adding credits, and reading balances.
 *
 * This lives in its own module rather than in booking-core.mts on purpose.
 * booking-core is ~13k lines of untyped function parameters, where a reordered
 * argument or a wrong role is not a type error -- and the one thing this code
 * must never get wrong is how many credits somebody has. Everything here takes
 * a named, typed object.
 *
 * The rules it enforces, all of which come from the schema in
 * database/migrations/20260915000100_create_pass_system:
 *
 *   * Balance is never stored, only derived. Nothing in this file writes a
 *     remaining-credits number anywhere; reads go through the pass_balances
 *     view, which is the one place that arithmetic exists.
 *   * Credits are added by appending an allocation, never by editing one.
 *   * Every read and write filters on account_id in the SQL itself, not in a
 *     .filter() afterwards.
 *   * allocation_mode 'recurring' is refused. The schema can express it, but
 *     nothing yet can answer "is this still being paid for", and a recurring
 *     pass that nothing can switch off is a credit printer.
 */

import { randomUUID } from "node:crypto";

import { getDatabase } from "./database.mts";

const db = getDatabase;

/**
 * Where a pass came from, and what keeps it funded.
 *
 * The source never changes how a credit behaves -- that is the point of owning
 * one entitlement shape. It decides only what can be traced back, and (with
 * sourceRef) what makes issuing the same purchase twice impossible.
 */
export type PassSource =
  | "manual"
  | "clarity_pos"
  | "clarity_invoice"
  | "clarity_checkout"
  | "optix"
  | "stripe_subscription"
  | "promotion";

const PASS_SOURCES: PassSource[] = [
  "manual",
  "clarity_pos",
  "clarity_invoice",
  "clarity_checkout",
  "optix",
  "stripe_subscription",
  "promotion",
];

export type PassAllocationView = {
  id: string;
  credits: number;
  creditsRedeemed: number;
  creditsAvailable: number;
  availableFrom: string;
  expiresAt: string | null;
  isLive: boolean;
  source: string;
  note: string;
  createdAt: string;
  entitlementServiceId: string | null;
  totalValueCents: number | null;
  currency: string | null;
};

export type PassRedemptionView = {
  id: string;
  allocationId: string;
  bookingId: string | null;
  credits: number;
  redeemedAt: string;
  redeemedBy: string;
  reversedAt: string | null;
  reversalReason: string | null;
  /** Why the credit was spent, when no booking says so. */
  note: string;
  /** No booking behind it: written by hand to correct a count. */
  manual: boolean;
};

export type PassView = {
  id: string;
  personId: string | null;
  name: string;
  templateServiceId: string | null;
  coversServiceIds: string[];
  crossRedeemable: boolean;
  flexibleValueCents: number;
  currency: string | null;
  creditsAvailable: number;
  creditsAllocated: number;
  creditsRedeemed: number;
  nextExpiry: string | null;
  expiresAt: string | null;
  status: "active" | "exhausted" | "expired" | "scheduled" | "void";
  source: string;
  note: string;
  issuedAt: string;
  allocations: PassAllocationView[];
  redemptions: PassRedemptionView[];
};

export type PassGrantInput = {
  personId?: unknown;
  templateServiceId?: unknown;
  name?: unknown;
  credits?: unknown;
  coversServiceIds?: unknown;
  expiryMonths?: unknown;
  note?: unknown;
  /** Default true: fold into a compatible pass the person already holds. */
  merge?: unknown;
  source?: unknown;
  /**
   * What paid for this, as an id the source can be traced back to -- a receipt
   * number, an invoice line. Issuing is idempotent on it, so a retried webhook
   * or a double-tapped Mark paid cannot mint the same credits twice.
   */
  sourceRef?: unknown;
  /**
   * Allow a pass with no owner. A purchase always has one; an external sale may
   * not, and a pass sitting unassigned is better than one attached to a guess.
   */
  allowUnassigned?: unknown;
  /** Exact consideration for this allocation lot, in minor currency units. */
  totalValueCents?: unknown;
  currency?: unknown;
  crossRedeemable?: unknown;
  entitlementServiceId?: unknown;
};

/** What a `lessonFormat: "package"` service says about the pass it sells. */
export type PassTemplate = {
  serviceId: string;
  name: string;
  credits: number;
  coversServiceIds: string[];
  crossRedeemable: boolean;
  priceCents: number | null;
};

export type PassActor = {
  accountId: string;
  actorId: string;
};

const MAX_CREDITS = 100;
const DEFAULT_EXPIRY_MONTHS = 12;

function fail(message: string, status = 400, code = "invalid"): never {
  throw Object.assign(new Error(message), { status, code });
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function idList(value: unknown, max = 12): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    const id = text(entry, 120);
    if (id) seen.add(id);
    if (seen.size >= max) break;
  }
  return [...seen];
}

function cleanCurrency(value: unknown): string {
  const currency = text(value, 3).toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : "";
}

function cleanCents(value: unknown): number | null {
  const cents = Number(value);
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
}

/**
 * The credit count, clamped to the same 1-100 range the existing package
 * allowance editor already enforces (booking-core.mts:757). Keeping the two in
 * step matters because a package service is the template most grants come from.
 */
export function cleanCredits(value: unknown, fallback = 0): number {
  const count = Number(value);
  if (!Number.isFinite(count)) return fallback;
  return Math.max(1, Math.min(MAX_CREDITS, Math.round(count)));
}

/**
 * Read the pass templates out of the service catalogue.
 *
 * Services live in the settings blob, not a table, so this is the only place
 * that knows a `package` service is a pass template. `packageCoversServiceId`
 * is still singular in the stored shape; it is widened to a list here so that
 * nothing downstream has to care when it becomes an array for real.
 */
export function passTemplatesFromServices(services: unknown): PassTemplate[] {
  if (!Array.isArray(services)) return [];
  const templates: PassTemplate[] = [];
  for (const service of services) {
    const entry = service as Record<string, unknown>;
    const serviceId = text(entry?.id, 120);
    if (!serviceId) continue;
    const isPackage =
      entry?.lessonFormat === "package" ||
      (!entry?.lessonFormat && serviceId.startsWith("package-"));
    if (!isPackage) continue;
    const covers = idList(entry?.coversServiceIds);
    const single = text(entry?.packageCoversServiceId, 120);
    templates.push({
      serviceId,
      name: text(entry?.name, 180) || "Pass",
      credits: cleanCredits(entry?.packageAllowance, 5),
      coversServiceIds: covers.length ? covers : single ? [single] : [],
      crossRedeemable: entry?.crossRedeemable === true,
      priceCents: Number.isFinite(Number(entry?.price))
        ? Math.max(0, Math.round(Number(entry.price) * 100))
        : null,
    });
  }
  return templates;
}

/**
 * What a pass issued from an external sale is worth.
 *
 * The number matters beyond bookkeeping: cross-redemption values a credit at
 * what was paid for it, so a pass issued at zero is a pass that can pay for
 * nothing by value. And a value with no currency is refused outright, which is
 * how a 0.00 Optix line used to fail the issue with a message about
 * three-letter currencies that told the coach nothing about what to do.
 *
 * So the amount is taken from the first source that actually knows one:
 *
 *   1. what the coach typed -- they were looking at the sale, and a comped or
 *      discounted pass is a real thing the catalogue price would misstate
 *   2. what the external sale charged, when that is more than nothing
 *   3. the catalogue price of the package it was, times how many were bought
 *
 * A zero from the external system is treated as "no price given" rather than
 * "free", because that is overwhelmingly what it means: the pass was bundled
 * into a membership, or rung up outside the till. A coach who really means free
 * can type 0 -- which arrives as an explicit value and is kept.
 *
 * Returns undefined when nothing knows a price, so the caller sends neither
 * half and the pass is issued without a value rather than refused.
 */
export function resolveInboxPassValue(input: {
  typed?: unknown;
  purchaseCents?: unknown;
  purchaseCurrency?: unknown;
  templatePriceCents?: number | null;
  quantity?: number;
  accountCurrency?: unknown;
}): { cents: number; currency: string } | undefined {
  const quantity = Math.max(1, Math.round(Number(input.quantity) || 1));

  const typed =
    input.typed === undefined || input.typed === null || input.typed === ""
      ? null
      : Number(input.typed);
  const typedCents =
    typed !== null && Number.isFinite(typed) && typed >= 0 ? Math.round(typed) : null;

  const charged = Number(input.purchaseCents);
  const chargedCents = Number.isFinite(charged) && charged > 0 ? Math.round(charged) : null;

  const listed =
    input.templatePriceCents === null || input.templatePriceCents === undefined
      ? null
      : Math.max(0, Math.round(input.templatePriceCents)) * quantity;

  const cents = typedCents ?? chargedCents ?? listed;
  if (cents === null) return undefined;

  // The sale's own currency is the truth when it charged something; otherwise
  // the value came from this account's own catalogue, so its currency did too.
  const fromSale = chargedCents !== null ? cleanCurrency(input.purchaseCurrency) : null;
  const currency = fromSale || cleanCurrency(input.accountCurrency);
  if (!currency) return undefined;

  return { cents, currency };
}

/**
 * Credit consumption order: the allocation that expires first is spent first.
 *
 * The database already orders this way in pass_allocation_balances, and the
 * checkout will read it from there. This mirror exists so the rule can be
 * tested as a rule -- "newer credits are never spent while older ones expire"
 * is the kind of thing that should fail a test, not a customer.
 */
export function spendOrder<T extends { expiresAt: string | null; availableFrom: string }>(
  allocations: T[],
): T[] {
  return [...allocations].sort((a, b) => {
    if (a.expiresAt !== b.expiresAt) {
      if (!a.expiresAt) return 1;
      if (!b.expiresAt) return -1;
      return a.expiresAt.localeCompare(b.expiresAt);
    }
    return a.availableFrom.localeCompare(b.availableFrom);
  });
}

/** Exact value of a unit within an allocation lot.
 *
 * Integer division can leave a remainder (for example 100 cents across three
 * units). The earliest unit ordinals receive one extra cent. That makes the
 * rule deterministic and guarantees the values of all units add back to the
 * exact transaction total without floating point money.
 */
export function allocationUnitValueCents(
  totalValueCents: number,
  unitsAllocated: number,
  unitOrdinal: number,
): number {
  if (!Number.isSafeInteger(totalValueCents) || totalValueCents < 0) {
    fail("Allocation value must be whole minor currency units.");
  }
  if (!Number.isSafeInteger(unitsAllocated) || unitsAllocated < 1) {
    fail("An allocation must contain at least one unit.");
  }
  if (!Number.isSafeInteger(unitOrdinal) || unitOrdinal < 1 || unitOrdinal > unitsAllocated) {
    fail("Unit ordinal is outside the allocation.");
  }
  const base = Math.floor(totalValueCents / unitsAllocated);
  const remainder = totalValueCents % unitsAllocated;
  return base + (unitOrdinal <= remainder ? 1 : 0);
}

export type ExchangeAllocation = {
  allocationId: string;
  passId: string;
  unitsAllocated: number;
  unitsRedeemed: number;
  unitsAvailable: number;
  totalValueCents: number;
  expiresAt: string | null;
  availableFrom: string;
};

export type ExchangePlan = {
  flexibleUsedCents: number;
  entitlements: Array<{ allocationId: string; passId: string; unitOrdinal: number; valueCents: number }>;
  residualCents: number;
};

/** Plan a cross-redemption without mutating state. The caller supplies only
 * same-currency, live, cross-redeemable allocations. */
export function planCrossRedemption(
  targetValueCents: number,
  flexibleValueCents: number,
  allocations: ExchangeAllocation[],
): ExchangePlan | null {
  if (!Number.isSafeInteger(targetValueCents) || targetValueCents <= 0) return null;
  const flexibleUsedCents = Math.min(
    targetValueCents,
    Math.max(0, Math.trunc(flexibleValueCents)),
  );
  let available = flexibleUsedCents;
  let needed = targetValueCents - flexibleUsedCents;
  const entitlements: ExchangePlan["entitlements"] = [];

  for (const allocation of spendOrder(allocations)) {
    for (let offset = 1; offset <= allocation.unitsAvailable && needed > 0; offset += 1) {
      const unitOrdinal = allocation.unitsRedeemed + offset;
      const valueCents = allocationUnitValueCents(
        allocation.totalValueCents,
        allocation.unitsAllocated,
        unitOrdinal,
      );
      entitlements.push({
        allocationId: allocation.allocationId,
        passId: allocation.passId,
        unitOrdinal,
        valueCents,
      });
      available += valueCents;
      needed = Math.max(0, targetValueCents - available);
    }
    if (needed === 0) break;
  }

  if (available < targetValueCents) return null;
  return {
    flexibleUsedCents,
    entitlements,
    residualCents: available - targetValueCents,
  };
}

export type TenderAmount = { kind: string; amountCents: number };

/** Deterministic refund split across the original tenders.
 * Full refunds reproduce them exactly. Partial refunds are proportional, with
 * any indivisible cent assigned in original tender order.
 */
export function planTenderRefund(
  tenders: TenderAmount[],
  requestedCents?: number,
): TenderAmount[] {
  const clean = tenders
    .map((tender) => ({ kind: tender.kind, amountCents: Math.max(0, Math.trunc(tender.amountCents)) }))
    .filter((tender) => tender.amountCents > 0);
  const total = clean.reduce((sum, tender) => sum + tender.amountCents, 0);
  const refund = Math.min(total, Math.max(0, Math.trunc(requestedCents ?? total)));
  if (!total || !refund) return clean.map((tender) => ({ ...tender, amountCents: 0 }));
  const result = clean.map((tender) => ({
    kind: tender.kind,
    amountCents: Math.floor((refund * tender.amountCents) / total),
  }));
  let remainder = refund - result.reduce((sum, tender) => sum + tender.amountCents, 0);
  for (let index = 0; remainder > 0; index = (index + 1) % result.length) {
    if (result[index].amountCents < clean[index].amountCents) {
      result[index].amountCents += 1;
      remainder -= 1;
    }
  }
  return result;
}

/**
 * Two passes are the same entitlement -- and so a second purchase should top
 * the first one up rather than appear as another card -- only when they came
 * from the same template AND cover exactly the same things.
 *
 * The coverage half is not fussiness. Coverage is snapshotted at issue time so
 * that editing a template never re-scopes a pass someone already holds; folding
 * a new allocation into an older pass with different coverage would undo that
 * by the back door, silently widening or narrowing what the older credits buy.
 */
export function isCompatiblePass(
  pass: { templateServiceId: string | null; coversServiceIds: string[]; crossRedeemable?: boolean },
  grant: { templateServiceId: string | null; coversServiceIds: string[]; crossRedeemable?: boolean },
): boolean {
  if (!pass.templateServiceId || pass.templateServiceId !== grant.templateServiceId) return false;
  if (pass.coversServiceIds.length !== grant.coversServiceIds.length) return false;
  const held = new Set(pass.coversServiceIds);
  return (
    Boolean(pass.crossRedeemable) === Boolean(grant.crossRedeemable) &&
    grant.coversServiceIds.every((id) => held.has(id))
  );
}

export type NormalisedGrant = {
  personId: string;
  name: string;
  templateServiceId: string | null;
  coversServiceIds: string[];
  credits: number;
  expiresAt: string | null;
  note: string;
  merge: boolean;
  source: PassSource;
  sourceRef: string;
  totalValueCents: number | null;
  currency: string | null;
  crossRedeemable: boolean;
  entitlementServiceId: string | null;
};

/**
 * Turn what the client sent into something that can be written, or refuse it.
 *
 * A grant can name a template, in which case the template supplies the name,
 * the allowance and the coverage; or it can be free-form, for the pass someone
 * paid cash for before any of this existed. Free-form still needs a name and a
 * credit count -- a nameless entitlement is not something a coach can explain
 * to the person holding it.
 */
export function normaliseGrant(input: PassGrantInput, templates: PassTemplate[]): NormalisedGrant {
  const personId = text(input?.personId, 160);
  if (!personId && input?.allowUnassigned !== true) fail("A pass has to belong to somebody.");

  const templateServiceId = text(input?.templateServiceId, 120);
  const template = templateServiceId
    ? templates.find((entry) => entry.serviceId === templateServiceId)
    : undefined;
  if (templateServiceId && !template) {
    fail("That pass template no longer exists.", 404, "unknown_template");
  }

  const name = text(input?.name, 180) || template?.name || "";
  if (!name) fail("Give this pass a name.");

  const requestedCovers = idList(input?.coversServiceIds);
  const coversServiceIds = requestedCovers.length ? requestedCovers : template?.coversServiceIds || [];

  const credits = cleanCredits(input?.credits, template?.credits || 0);
  if (!credits) fail("How many credits is this pass worth?");

  const totalValueCents = cleanCents(input?.totalValueCents);
  const currency = cleanCurrency(input?.currency) || null;
  if ((totalValueCents === null) !== (currency === null)) {
    fail("Pass value needs both an exact amount and a three-letter currency.");
  }
  const crossRedeemable = totalValueCents !== null && (
    input?.crossRedeemable === undefined
      ? Boolean(template?.crossRedeemable)
      : input.crossRedeemable === true
  );
  const entitlementServiceId =
    text(input?.entitlementServiceId, 120) ||
    (coversServiceIds.length === 1 ? coversServiceIds[0] : "") ||
    null;

  const months = Number(input?.expiryMonths);
  const expiryMonths = Number.isFinite(months)
    ? Math.max(0, Math.min(120, Math.round(months)))
    : DEFAULT_EXPIRY_MONTHS;

  return {
    personId,
    name,
    templateServiceId: template?.serviceId || null,
    coversServiceIds,
    credits,
    // 0 months means never. An unbounded liability is a real choice a coach can
    // make; it just should not be the one nobody picked.
    expiresAt: expiryMonths ? monthsFromNow(expiryMonths) : null,
    note: text(input?.note, 600),
    // Paid lots stay separate so their purchase value, expiry and source can
    // never be blurred by a later purchase. Free/manual top-ups retain the
    // existing merge behaviour unless the caller opts out.
    merge: input?.merge !== false && totalValueCents === null,
    source: PASS_SOURCES.includes(input?.source as PassSource) ? (input.source as PassSource) : "manual",
    sourceRef: text(input?.sourceRef, 200),
    totalValueCents,
    currency,
    crossRedeemable,
    entitlementServiceId,
  };
}

function monthsFromNow(months: number): string {
  const now = new Date();
  const then = new Date(now);
  then.setMonth(then.getMonth() + months);
  return then.toISOString();
}

function rowToAllocation(row: Record<string, unknown>): PassAllocationView {
  return {
    id: String(row.allocation_id || row.id),
    credits: Number(row.credits) || 0,
    creditsRedeemed: Number(row.credits_redeemed) || 0,
    creditsAvailable: Number(row.credits_available) || 0,
    availableFrom: String(row.available_from || ""),
    expiresAt: (row.expires_at as string) || null,
    isLive: row.is_live === true,
    source: String(row.source || ""),
    note: (row.note as string) || "",
    createdAt: String(row.created_at || ""),
    entitlementServiceId: (row.entitlement_service_id as string) || null,
    totalValueCents:
      row.total_value_cents === null || row.total_value_cents === undefined
        ? null
        : Number(row.total_value_cents),
    currency: (row.currency as string) || null,
  };
}

function rowToRedemption(row: Record<string, unknown>): PassRedemptionView {
  return {
    id: String(row.id),
    allocationId: String(row.allocation_id),
    bookingId: (row.booking_id as string) || null,
    credits: Number(row.credits) || 0,
    redeemedAt: String(row.redeemed_at || ""),
    redeemedBy: (row.redeemed_by as string) || "",
    reversedAt: (row.reversed_at as string) || null,
    reversalReason: (row.reversal_reason as string) || null,
    note: (row.note as string) || "",
    // Derived from the absence of a booking rather than stored as a flag. The
    // two can then never disagree, and "manual" keeps meaning the one thing it
    // has to mean: nothing in the calendar explains this credit.
    manual: !row.booking_id,
  };
}

function rowToPass(row: Record<string, unknown>): PassView {
  const allocations = Array.isArray(row.allocations)
    ? (row.allocations as Record<string, unknown>[]).map(rowToAllocation)
    : [];
  const redemptions = Array.isArray(row.redemptions)
    ? (row.redemptions as Record<string, unknown>[]).map(rowToRedemption)
    : [];
  return {
    id: String(row.pass_id),
    personId: (row.person_id as string) || null,
    name: String(row.name || ""),
    templateServiceId: (row.template_service_id as string) || null,
    coversServiceIds: Array.isArray(row.covers_service_ids)
      ? (row.covers_service_ids as string[]).map(String)
      : [],
    crossRedeemable: row.cross_redeemable === true,
    flexibleValueCents: Number(row.flexible_value_cents) || 0,
    currency: (row.value_currency as string) || null,
    creditsAvailable: Number(row.credits_available) || 0,
    creditsAllocated: Number(row.credits_allocated_all_time) || 0,
    creditsRedeemed: Number(row.credits_redeemed_all_time) || 0,
    nextExpiry: (row.next_expiry as string) || null,
    expiresAt: (row.expires_at as string) || null,
    status: String(row.effective_status || "active") as PassView["status"],
    source: String(row.source || ""),
    note: (row.note as string) || "",
    issuedAt: String(row.issued_at || ""),
    allocations: spendOrder(allocations),
    redemptions,
  };
}

/**
 * Everything a person holds, with the ledger behind each one.
 *
 * One round trip rather than three. A cold Netlify instance pays roughly 217ms
 * per database round trip, and this runs every time a coach opens a profile --
 * so the allocations and redemptions come back as aggregated JSON beside their
 * pass instead of as two follow-up queries.
 */
export async function readPassesForPerson(accountId: string, personId: string): Promise<PassView[]> {
  if (!accountId || !personId) return [];
  // Before answering, give back anything whose booking has since gone. Every
  // surface that shows a balance goes through here, so this is the one place
  // that guarantees a cancelled lesson's credit is never shown as spent.
  await sweepReturnableCredits(accountId);
  const rows = await db().sql`
    SELECT
      b.*,
      p.source,
      p.note,
      p.issued_at,
      p.cross_redeemable,
      COALESCE((
        SELECT SUM(m.amount_cents)
        FROM public.pass_value_movements m
        WHERE m.pass_id = p.id AND m.account_id = ${accountId}
      ), 0) AS flexible_value_cents,
      (
        SELECT m.currency
        FROM public.pass_value_movements m
        WHERE m.pass_id = p.id AND m.account_id = ${accountId}
        ORDER BY m.created_at DESC
        LIMIT 1
      ) AS value_currency,
      COALESCE((
        SELECT json_agg(a ORDER BY a.expires_at NULLS LAST, a.available_from)
        FROM public.pass_allocation_balances a
        WHERE a.pass_id = b.pass_id AND a.account_id = ${accountId}
      ), '[]'::json) AS allocations,
      COALESCE((
        SELECT json_agg(r ORDER BY r.redeemed_at DESC)
        FROM public.pass_redemptions r
        WHERE r.pass_id = b.pass_id AND r.account_id = ${accountId}
      ), '[]'::json) AS redemptions
    FROM public.pass_balances b
    JOIN public.passes p ON p.id = b.pass_id AND p.account_id = ${accountId}
    WHERE b.account_id = ${accountId} AND b.person_id = ${personId}
    ORDER BY p.issued_at DESC
  `;
  return (rows as Record<string, unknown>[]).map(rowToPass);
}

async function readPassRow(accountId: string, passId: string) {
  const rows = await db().sql`
    SELECT id, person_id, template_service_id, covers_service_ids, status,
           cross_redeemable
    FROM public.passes
    WHERE id = ${passId} AND account_id = ${accountId}
    LIMIT 1
  `;
  return (rows as Record<string, unknown>[])[0] || null;
}

/**
 * Issue a pass, or top up one the person already holds.
 *
 * Both halves append an allocation; the only difference is whether a `passes`
 * row is written first. That is the whole point of the allocation table -- "buy
 * five more" and "here is your first five" are the same operation, and neither
 * one edits a number.
 */
export async function grantPass(
  input: PassGrantInput,
  templates: PassTemplate[],
  actor: PassActor,
): Promise<{ passes: PassView[]; merged: boolean; duplicate: boolean }> {
  const grant = normaliseGrant(input, templates);
  const { accountId } = actor;
  if (!accountId) fail("No account.", 403, "forbidden");

  const held = await readPassesForPerson(accountId, grant.personId);
  const compatible = grant.merge
    ? held.find(
        (pass) =>
          (pass.status === "active" || pass.status === "exhausted") &&
          isCompatiblePass(pass, grant),
      )
    : undefined;

  const client = await db().pool.connect();
  try {
    await client.query("BEGIN");

    let passId = compatible?.id || "";
    if (!passId) {
      passId = `pass-${randomUUID()}`;
      await client.query(
      `INSERT INTO public.passes (
           id, account_id, person_id, name, template_service_id, covers_service_ids,
           issued_at, expires_at, status, source, source_ref, allocation_mode,
           credits_per_period, rollover_policy, note, created_by, created_at, updated_at,
           cross_redeemable
         ) VALUES (
           $1, $2, NULLIF($3, ''), $4, $5, $6,
           NOW(), $7, 'active', $8, NULLIF($9, ''), 'one_off',
           $10, 'rollover', $11, $12, NOW(), NOW(), $13
         )`,
        [
          passId,
          accountId,
          grant.personId,
          grant.name,
          grant.templateServiceId,
          grant.coversServiceIds,
          grant.expiresAt,
          grant.source,
          grant.sourceRef,
          grant.credits,
          grant.note,
          actor.actorId,
          grant.crossRedeemable,
        ],
      );
    }

    await client.query(
      `INSERT INTO public.pass_allocations (
         id, account_id, pass_id, credits, available_from, expires_at,
         source, source_ref, note, created_by, created_at,
         entitlement_service_id, total_value_cents, currency
       ) VALUES ($1, $2, $3, $4, NOW(), $5, $6, NULLIF($7, ''), $8, $9, NOW(), $10, $11, $12)`,
      [
        `alloc-${randomUUID()}`,
        accountId,
        passId,
        grant.credits,
        // A top-up inherits the pass's own expiry rather than the grant form's,
        // so adding credits can never quietly extend or shorten what is already
        // there. A fresh pass and its first allocation share one date.
        compatible ? compatible.expiresAt : grant.expiresAt,
        grant.source,
        grant.sourceRef,
        grant.note,
        actor.actorId,
        grant.entitlementServiceId,
        grant.totalValueCents,
        grant.currency,
      ],
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    // 23505 on this path means the unique index on (account_id, pass_id, source,
    // source_ref) fired: these exact credits have already been issued for this
    // exact purchase. A Stripe webhook redelivered, a Mark paid double-tapped, a
    // sync re-run. Not an error -- the desired state already exists, and the
    // whole reason issuing carries a reference is so this is cheap to say.
    if ((error as { code?: string })?.code === "23505") {
      return {
        passes: await readPassesForPerson(accountId, grant.personId),
        merged: Boolean(compatible),
        duplicate: true,
      };
    }
    throw error;
  } finally {
    client.release();
  }

  return {
    passes: await readPassesForPerson(accountId, grant.personId),
    merged: Boolean(compatible),
    duplicate: false,
  };
}

/**
 * Void a pass.
 *
 * Voiding is the only stored state change a pass has, and it does not touch the
 * ledger: redemptions already taken stay exactly where they are, because those
 * lessons happened. What changes is that nothing more can be spent.
 */
export async function voidPass(
  passId: string,
  reason: string,
  actor: PassActor,
): Promise<{ passes: PassView[] }> {
  const { accountId } = actor;
  const id = text(passId, 120);
  if (!accountId) fail("No account.", 403, "forbidden");
  if (!id) fail("Which pass?");

  const existing = await readPassRow(accountId, id);
  if (!existing) fail("That pass was not found.", 404, "not_found");
  if (existing.status === "void") fail("That pass is already void.", 409, "already_void");

  await db().sql`
    UPDATE public.passes
    SET status = 'void',
        voided_at = NOW(),
        void_reason = ${text(reason, 300)},
        updated_at = NOW()
    WHERE id = ${id} AND account_id = ${accountId}
  `;

  return { passes: await readPassesForPerson(accountId, String(existing.person_id || "")) };
}

// ---------------------------------------------------------------------------
// The Pass Inbox -- passes with nobody to belong to
// ---------------------------------------------------------------------------

/**
 * Which package an external product is, if it can be said without guessing.
 *
 * An external sale names a product ("30 Minute Golf Lesson Package") and says
 * nothing about how many credits it is worth. The package Service of the same
 * name knows -- so the job here is only to decide whether two names are the
 * same product, and to refuse when that is a coin flip.
 *
 * The rule is the one the person matcher uses, for the same reason: exactly one
 * candidate or no answer. A wrong template does not fail loudly -- it issues a
 * real, spendable pass for the wrong number of lessons, and the first anyone
 * hears of it is at the counter. "unknown" costs a coach one dropdown; a wrong
 * match costs them an argument with a customer.
 *
 *   exact  the names are the same once case and punctuation are set aside.
 *   close  exactly one template's name is contained in the product's, which is
 *          what an external catalogue with a prefix or a suffix looks like.
 *   none   nothing matched, or more than one did.
 */
export type PassTemplateSuggestion = {
  template: PassTemplate | null;
  confidence: "exact" | "close" | "none";
};

function normaliseProductName(value: string) {
  return text(value, 200)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function suggestPassTemplate(
  itemName: string,
  templates: PassTemplate[],
): PassTemplateSuggestion {
  const wanted = normaliseProductName(itemName);
  if (!wanted) return { template: null, confidence: "none" };

  const named = templates.map((template) => ({
    template,
    name: normaliseProductName(template.name),
  }));

  const exact = named.filter((entry) => entry.name && entry.name === wanted);
  if (exact.length === 1) return { template: exact[0].template, confidence: "exact" };
  // Two templates sharing a name is a catalogue problem, not something to
  // resolve by picking one.
  if (exact.length > 1) return { template: null, confidence: "none" };

  const contained = named.filter(
    (entry) => entry.name && (wanted.includes(entry.name) || entry.name.includes(wanted)),
  );
  if (contained.length === 1) return { template: contained[0].template, confidence: "close" };
  return { template: null, confidence: "none" };
}

/**
 * Everything issued that has no owner.
 *
 * A pass reaches this state when whatever paid for it could not be tied to a
 * person with confidence -- an external sale carrying a display name and no
 * email, or cash over the counter before the buyer was ever a client. The
 * entitlement is real either way: somebody paid. So it is issued and it waits,
 * rather than being guessed at or dropped.
 *
 * Void ones are excluded. A voided unassigned pass is a refunded purchase that
 * never found an owner, and offering it for attachment invites attaching it.
 */
export async function readUnassignedPasses(accountId: string): Promise<PassView[]> {
  if (!accountId) return [];
  const rows = await db().sql`
    SELECT
      b.*,
      p.source,
      p.note,
      p.issued_at,
      COALESCE((
        SELECT json_agg(a ORDER BY a.expires_at NULLS LAST, a.available_from)
        FROM public.pass_allocation_balances a
        WHERE a.pass_id = b.pass_id AND a.account_id = ${accountId}
      ), '[]'::json) AS allocations,
      '[]'::json AS redemptions
    FROM public.pass_balances b
    JOIN public.passes p ON p.id = b.pass_id AND p.account_id = ${accountId}
    WHERE b.account_id = ${accountId}
      AND b.person_id IS NULL
      AND p.status <> 'void'
    ORDER BY p.issued_at DESC
    LIMIT 200
  `;
  return (rows as Record<string, unknown>[]).map(rowToPass);
}

export type IssuedPassView = PassView & { personName: string };

/**
 * Every pass the account has issued, newest first, with who holds it.
 *
 * The Billing view of the same ledger a profile shows one person of. Voided,
 * used-up and expired passes stay in the list: "what did I sell in August" and
 * "why can't he use his pass" are both answered here, and each row carries its
 * own state, so the screen filters rather than the query.
 */
export async function readIssuedPasses(accountId: string): Promise<IssuedPassView[]> {
  if (!accountId) return [];
  // Same sweep every balance surface runs, so a cancelled lesson's credit is
  // never shown as spent here either.
  await sweepReturnableCredits(accountId);
  const rows = await db().sql`
    SELECT
      b.*,
      p.source,
      p.note,
      p.issued_at,
      p.cross_redeemable,
      COALESCE(pe.name, '') AS person_name,
      COALESCE((
        SELECT json_agg(a ORDER BY a.expires_at NULLS LAST, a.available_from)
        FROM public.pass_allocation_balances a
        WHERE a.pass_id = b.pass_id AND a.account_id = ${accountId}
      ), '[]'::json) AS allocations,
      COALESCE((
        SELECT json_agg(r ORDER BY r.redeemed_at DESC)
        FROM public.pass_redemptions r
        WHERE r.pass_id = b.pass_id AND r.account_id = ${accountId}
      ), '[]'::json) AS redemptions
    FROM public.pass_balances b
    JOIN public.passes p ON p.id = b.pass_id AND p.account_id = ${accountId}
    LEFT JOIN public.people pe ON pe.id = b.person_id AND pe.account_id = ${accountId}
    WHERE b.account_id = ${accountId}
    ORDER BY p.issued_at DESC
    LIMIT 300
  `;
  return (rows as Record<string, unknown>[]).map((row) => ({
    ...rowToPass(row),
    personName: String(row.person_name || ""),
  }));
}

/**
 * Which purchases have already produced a pass.
 *
 * Issuing is idempotent on (account_id, source, source_ref), so this is the
 * same key the unique index uses -- which means the inbox and the insert can
 * never disagree about whether something has been issued. Asking the passes
 * table is deliberate: a flag on the purchase row would be a second record of
 * the same fact, and the two would drift the first time an issue half-failed.
 */
export async function issuedSourceRefs(
  accountId: string,
  source: PassSource,
  refs: string[],
): Promise<Set<string>> {
  const wanted = [...new Set(refs.map((ref) => text(ref, 200)).filter(Boolean))];
  if (!accountId || !wanted.length) return new Set();
  const rows = await db().sql`
    SELECT source_ref
    FROM public.passes
    WHERE account_id = ${accountId}
      AND source = ${source}
      AND source_ref = ANY(${wanted})
  `;
  return new Set((rows as Record<string, unknown>[]).map((row) => String(row.source_ref || "")));
}

/**
 * Give an unassigned pass an owner.
 *
 * One direction only. Attaching is how a pass that was issued without a person
 * finds one; moving a pass from one person to another is a different act with
 * different consequences -- credits already spent under the old owner stay
 * spent -- and it is not this. A pass that already belongs to somebody is
 * refused rather than quietly reassigned.
 */
export async function assignPass(
  passId: string,
  personId: string,
  actor: PassActor,
): Promise<{ pass: PassView | null }> {
  const { accountId } = actor;
  const id = text(passId, 120);
  const person = text(personId, 160);
  if (!accountId) fail("No account.", 403, "forbidden");
  if (!id) fail("Which pass?");
  if (!person) fail("Which person is this pass for?");

  const existing = await readPassRow(accountId, id);
  if (!existing) fail("That pass was not found.", 404, "not_found");
  if (existing.status === "void") fail("That pass is void.", 409, "void_pass");
  if (existing.person_id) {
    fail("That pass already belongs to somebody.", 409, "already_assigned");
  }

  await db().sql`
    UPDATE public.passes
    SET person_id = ${person},
        note = TRIM(BOTH ' ' FROM COALESCE(note, '') || ${` Attached by ${text(actor.actorId, 160) || "an admin"}.`}),
        updated_at = NOW()
    WHERE id = ${id} AND account_id = ${accountId} AND person_id IS NULL
  `;

  const passes = await readPassesForPerson(accountId, person);
  return { pass: passes.find((entry) => entry.id === id) || null };
}

// ---------------------------------------------------------------------------
// Spending
// ---------------------------------------------------------------------------

export type PassOption = {
  passId: string;
  name: string;
  creditsAvailable: number;
  creditsAllocated: number;
  expiresAt: string | null;
  nextExpiry: string | null;
  /** Does this pass cover the service being settled? */
  covered: boolean;
  /** Why it cannot pay, ready to show greyed beside it. */
  reason: string;
  paymentKind: "native" | "cross_redemption" | "unavailable";
  availableValueCents: number;
  flexibleValueCents: number;
  currency: string | null;
  remainingCreditsAfter: number | null;
  residualValueCentsAfter: number | null;
};

/**
 * What a checkout should offer, and what it should grey out.
 *
 * Passes that exist but do not cover this service are returned too, with the
 * reason attached. Hiding them turns "why isn't his pass showing up?" into a
 * support question with no answer on screen; showing them greyed answers it
 * before it is asked.
 *
 * A pass with no coverage at all covers nothing. That is deliberate: coverage
 * is what a pass *is*, and treating an empty list as "anything" would let a
 * swing-review credit quietly pay for a 60-minute lesson.
 */
export function passOptionsForService(
  passes: PassView[],
  serviceId: string,
  serviceName = "",
  value?: {
    serviceValueCents: number;
    currency: string;
    acceptsCrossRedemption: boolean;
    flexibleValueCents?: number;
  },
): PassOption[] {
  const wanted = text(serviceId, 120);
  const hasNativeEntitlement = passes.some(
    (pass) =>
      pass.status === "active" &&
      pass.creditsAvailable > 0 &&
      pass.coversServiceIds.includes(wanted),
  );
  const currency = cleanCurrency(value?.currency);
  const exchangeAllocations: ExchangeAllocation[] = passes.flatMap((pass) =>
    pass.crossRedeemable
      ? pass.allocations
          .filter(
            (allocation) =>
              allocation.isLive &&
              allocation.creditsAvailable > 0 &&
              allocation.totalValueCents !== null &&
              allocation.currency === currency,
          )
          .map((allocation) => ({
            allocationId: allocation.id,
            passId: pass.id,
            unitsAllocated: allocation.credits,
            unitsRedeemed: allocation.creditsRedeemed,
            unitsAvailable: allocation.creditsAvailable,
            totalValueCents: allocation.totalValueCents as number,
            expiresAt: allocation.expiresAt,
            availableFrom: allocation.availableFrom,
          }))
      : [],
  );
  const exchangePlan = value?.acceptsCrossRedemption && currency
    ? planCrossRedemption(
        Math.round(Number(value.serviceValueCents) || 0),
        Math.max(0, Math.round(Number(value.flexibleValueCents) || 0)),
        exchangeAllocations,
      )
    : null;
  const availableValueCents =
    Math.max(0, Math.round(Number(value?.flexibleValueCents) || 0)) +
    exchangeAllocations.reduce((sum, allocation) => {
      let remaining = 0;
      for (let offset = 1; offset <= allocation.unitsAvailable; offset += 1) {
        remaining += allocationUnitValueCents(
          allocation.totalValueCents,
          allocation.unitsAllocated,
          allocation.unitsRedeemed + offset,
        );
      }
      return sum + remaining;
    }, 0);
  return passes
    .filter((pass) => pass.status === "active" || pass.status === "exhausted")
    .map((pass) => {
      const covered = Boolean(wanted) && pass.coversServiceIds.includes(wanted);
      const crossCovered = Boolean(
        !hasNativeEntitlement && !covered && pass.crossRedeemable && exchangePlan,
      );
      let reason = "";
      if (!pass.coversServiceIds.length) reason = "No covered service set";
      else if (!covered && hasNativeEntitlement) reason = "A matching entitlement is used first";
      else if (!covered && !pass.crossRedeemable) reason = "Covers something else";
      else if (!covered && !value?.acceptsCrossRedemption) reason = "This service does not accept balance";
      else if (!covered && !currency) reason = "No currency set";
      else if (!covered && !exchangePlan) reason = "Not enough same-currency value";
      else if (covered && pass.creditsAvailable < 1) reason = "No credits left";
      return {
        passId: pass.id,
        name: pass.name,
        creditsAvailable: pass.creditsAvailable,
        creditsAllocated: pass.creditsAllocated,
        expiresAt: pass.expiresAt,
        nextExpiry: pass.nextExpiry,
        covered: (covered && pass.creditsAvailable >= 1) || crossCovered,
        reason: reason || (serviceName ? `Covers ${serviceName}` : ""),
        paymentKind: covered && pass.creditsAvailable >= 1
          ? "native"
          : crossCovered
            ? "cross_redemption"
            : "unavailable",
        availableValueCents,
        flexibleValueCents: Math.max(0, Math.round(Number(value?.flexibleValueCents) || 0)),
        currency: currency || null,
        remainingCreditsAfter: crossCovered
          ? Math.max(0, passes.reduce((sum, entry) => sum + entry.creditsAvailable, 0) - exchangePlan!.entitlements.length)
          : covered
            ? pass.creditsAvailable - 1
            : null,
        residualValueCentsAfter: crossCovered ? exchangePlan!.residualCents : null,
      };
    });
}

export async function readFlexibleValueForPerson(
  accountId: string,
  personId: string,
  currency: string,
): Promise<number> {
  const code = cleanCurrency(currency);
  if (!accountId || !personId || !code) return 0;
  const expired = await db().sql`
    SELECT id
    FROM public.pass_value_transactions
    WHERE account_id = ${accountId}
      AND person_id = ${personId}
      AND kind = 'purchase_tender'
      AND settled_at IS NULL
      AND reversed_at IS NULL
      AND expires_at IS NOT NULL
      AND expires_at <= NOW()
  `;
  for (const row of expired as Record<string, unknown>[]) {
    await reversePassValueTransaction(
      accountId,
      String(row.id),
      "Purchase reservation expired",
      "system",
    );
  }
  const rows = await db().sql`
    SELECT COALESCE(SUM(amount_cents), 0)::BIGINT AS value_cents
    FROM public.pass_value_movements
    WHERE account_id = ${accountId}
      AND person_id = ${personId}
      AND currency = ${code}
  `;
  return Math.max(0, Number((rows as Record<string, unknown>[])[0]?.value_cents || 0));
}

/** Reserve existing flexible credit as one tender toward a new purchase. */
export async function reserveFlexibleValueForPurchase(input: {
  accountId: string;
  personId: string;
  purchaseValueCents: number;
  currency: string;
  sourceRef: string;
  actorId?: string;
}): Promise<{ transactionId: string; creditUsedCents: number } | null> {
  const accountId = text(input.accountId, 120);
  const personId = text(input.personId, 160);
  const currency = cleanCurrency(input.currency);
  const purchaseValueCents = cleanCents(input.purchaseValueCents);
  const sourceRef = text(input.sourceRef, 200);
  if (!accountId || !personId || !currency || purchaseValueCents === null || purchaseValueCents <= 0) {
    fail("The purchase needs a player, exact value and currency.");
  }
  const client = await db().pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`pass-value:${accountId}:${personId}:${currency}`],
    );
    const balanceRows = await client.query(
      `SELECT COALESCE(SUM(amount_cents), 0)::BIGINT AS value_cents
       FROM public.pass_value_movements
       WHERE account_id = $1 AND person_id = $2 AND currency = $3`,
      [accountId, personId, currency],
    );
    const available = Math.max(0, Number((balanceRows.rows[0] as Record<string, unknown>)?.value_cents || 0));
    const creditUsedCents = Math.min(available, purchaseValueCents);
    if (creditUsedCents <= 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const transactionId = `pvtx-${randomUUID()}`;
    await client.query(
      `INSERT INTO public.pass_value_transactions (
         id, account_id, person_id, kind, target_value_cents, currency,
         source_ref, expires_at, created_by, created_at
       ) VALUES ($1, $2, $3, 'purchase_tender', $4, $5, NULLIF($6, ''),
                 NOW() + INTERVAL '25 hours', $7, NOW())`,
      [transactionId, accountId, personId, creditUsedCents, currency, sourceRef, text(input.actorId, 160)],
    );
    await client.query(
      `INSERT INTO public.pass_value_movements (
         id, account_id, person_id, transaction_id, amount_cents, currency,
         movement_kind, note, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'flexible_spent', 'Purchase tender', NOW())`,
      [`pvm-${randomUUID()}`, accountId, personId, transactionId, -creditUsedCents, currency],
    );
    await client.query("COMMIT");
    return { transactionId, creditUsedCents };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
}

export async function settleFlexibleValuePurchase(
  accountId: string,
  transactionId: string,
): Promise<boolean> {
  const rows = await db().sql`
    UPDATE public.pass_value_transactions
    SET settled_at = COALESCE(settled_at, NOW()), expires_at = NULL
    WHERE id = ${text(transactionId, 160)}
      AND account_id = ${text(accountId, 120)}
      AND kind = 'purchase_tender'
      AND reversed_at IS NULL
    RETURNING id
  `;
  return (rows as unknown[]).length > 0;
}

/* --- What a player is allowed to see -----------------------------------
 *
 * A PassView is the coach's object: it carries the note ("comped after the
 * rained-out session"), the source, and a redeemed_by naming an admin user.
 * None of that is the player's business, and two of the three would be
 * actively awkward to hand over.
 *
 * So the portal gets its own shape rather than a filtered version of the
 * coach's -- a filter is a list of things to remember to remove, and the day
 * someone adds a field to PassView the portal starts leaking it. This is the
 * opposite: an allow-list, where a new field on PassView reaches a player only
 * when somebody writes it in here on purpose.
 */

export type PlayerPassView = {
  id: string;
  name: string;
  creditsAvailable: number;
  creditsAllocated: number;
  creditsRedeemed: number;
  /** The soonest any of these credits goes off, which is the one that matters. */
  expiresAt: string | null;
  status: PassView["status"];
  /** Service names, not ids -- the player has no catalogue to look ids up in. */
  covers: string[];
  issuedAt: string;
  /** Live redemptions only, newest first. A reversed one is a credit they got
   *  back, and showing it as spent would be a lie about their balance. */
  history: Array<{ id: string; redeemedAt: string; bookingId: string | null }>;
};

/**
 * One pass, as its holder should see it.
 *
 * A voided pass is dropped by the caller rather than here -- see
 * playerPassViews -- because "which passes exist for this player" is a
 * different question from "what does this pass look like to them".
 */
export function playerPassView(pass: PassView, serviceNames: Map<string, string>): PlayerPassView {
  return {
    id: pass.id,
    name: pass.name,
    creditsAvailable: pass.creditsAvailable,
    creditsAllocated: pass.creditsAllocated,
    creditsRedeemed: pass.creditsRedeemed,
    expiresAt: pass.nextExpiry || pass.expiresAt,
    status: pass.status,
    covers: pass.coversServiceIds
      .map((id) => serviceNames.get(id) || "")
      .filter((name) => Boolean(name)),
    issuedAt: pass.issuedAt,
    history: pass.redemptions
      .filter((entry) => !entry.reversedAt)
      .map((entry) => ({
        id: entry.id,
        redeemedAt: entry.redeemedAt,
        bookingId: entry.bookingId,
      })),
  };
}

/**
 * Everything a player holds, in the order they would ask about it.
 *
 * Spendable first, then what is merely waiting, then what is finished --
 * because the question a player opens this to answer is almost always "how
 * many have I got left", and a pass with credits on it is the answer.
 *
 * Void passes are not here at all. A voided pass is one that was refunded or
 * taken back; it is the coach's audit trail, not the player's entitlement, and
 * showing it invites "why does it say I have a pass I can't use?".
 */
export function playerPassViews(
  passes: PassView[],
  serviceNames: Map<string, string>,
): PlayerPassView[] {
  const rank: Record<string, number> = { active: 0, scheduled: 1, exhausted: 2, expired: 3 };
  return passes
    .filter((pass) => pass.status !== "void")
    .map((pass) => playerPassView(pass, serviceNames))
    .sort(
      (left, right) =>
        (rank[left.status] ?? 9) - (rank[right.status] ?? 9) ||
        right.issuedAt.localeCompare(left.issuedAt),
    );
}

export type ReservedCredit = { redemptionId: string; allocationId: string };

export type ReservedValue = {
  transactionId: string;
  redemptionIds: string[];
  flexibleUsedCents: number;
  residualCents: number;
};

/**
 * Take a credit for a booking, or refuse.
 *
 * Three things have to be true at once and none of them can be decided by the
 * browser: the pass is still spendable, it still has a credit, and this booking
 * has not already taken one. So the balance the till was showing is never
 * trusted -- it is recomputed here, inside a transaction, and the pass row is
 * locked first.
 *
 * The lock is what makes two tills safe. Without it both could read "1 credit
 * left" from the balances view, both insert, and the allocation goes negative
 * with nothing to say which sale was the wrong one. Locking the pass serialises
 * every redemption against it; the contention is one row, held for one insert.
 *
 * Choosing the allocation is the server's job too, and it always takes the one
 * that expires first -- otherwise a fresh month's credits get spent while
 * August's quietly expire unused.
 */
export async function reservePassCredit(input: {
  accountId: string;
  passId: string;
  bookingId: string;
  credits?: number;
  actorId?: string;
}): Promise<ReservedCredit> {
  const accountId = text(input.accountId, 120);
  const passId = text(input.passId, 120);
  const bookingId = text(input.bookingId, 160);
  const credits = Math.max(1, Math.min(MAX_CREDITS, Math.round(Number(input.credits) || 1)));
  if (!accountId) fail("No account.", 403, "forbidden");
  if (!passId) fail("Which pass?");
  if (!bookingId) fail("A pass can only settle a booking.", 400, "booking_required");

  const client = await db().pool.connect();
  try {
    await client.query("BEGIN");

    const held = await client.query(
      `SELECT id FROM public.passes WHERE id = $1 AND account_id = $2 FOR UPDATE`,
      [passId, accountId],
    );
    if (!held.rows.length) {
      await client.query("ROLLBACK");
      fail("That pass was not found.", 404, "not_found");
    }

    // One statement, so the allocation that is chosen is the allocation that is
    // written. The unique index on (booking_id) where reversed_at is null is
    // what catches the same booking being settled twice.
    const reserved = await client.query(
      `INSERT INTO public.pass_redemptions (
         id, account_id, pass_id, allocation_id, booking_id, credits, redeemed_at, redeemed_by, created_at
       )
       SELECT $1, $2, $3, a.allocation_id, $4, $5, NOW(), $6, NOW()
       FROM public.pass_allocation_balances a
       JOIN public.passes p ON p.id = a.pass_id AND p.account_id = a.account_id
       WHERE a.pass_id = $3
         AND a.account_id = $2
         AND a.is_live
         AND a.credits_available >= $5
         AND p.status = 'active'
         AND (p.expires_at IS NULL OR p.expires_at > NOW())
         AND (p.starts_at IS NULL OR p.starts_at <= NOW())
       ORDER BY a.expires_at NULLS LAST, a.available_from
       LIMIT 1
       RETURNING id, allocation_id`,
      [`red-${randomUUID()}`, accountId, passId, bookingId, credits, text(input.actorId, 160)],
    );

    if (!reserved.rows.length) {
      await client.query("ROLLBACK");
      fail("That pass has no credits left to spend.", 409, "no_credits");
    }

    await client.query("COMMIT");
    return {
      redemptionId: String(reserved.rows[0].id),
      allocationId: String(reserved.rows[0].allocation_id),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    // 23505 is a unique violation: the partial index on booking_id fired, so
    // this booking already holds a live credit. That is a double-tap or a
    // second till, not an error worth a stack trace.
    if ((error as { code?: string })?.code === "23505") {
      fail("That booking has already been settled with a pass.", 409, "already_redeemed");
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Settle an unrelated service from flexible value plus the minimum whole
 * entitlements required. The service eligibility and authoritative price are
 * supplied by the server-side catalogue caller; this function never accepts a
 * browser-calculated balance.
 */
export async function reserveCrossRedemption(input: {
  accountId: string;
  passId: string;
  bookingId: string;
  serviceId: string;
  serviceValueCents: number;
  currency: string;
  acceptsCrossRedemption: boolean;
  actorId?: string;
}): Promise<ReservedValue> {
  const accountId = text(input.accountId, 120);
  const selectedPassId = text(input.passId, 120);
  const bookingId = text(input.bookingId, 160);
  const serviceId = text(input.serviceId, 120);
  const currency = cleanCurrency(input.currency);
  const serviceValueCents = cleanCents(input.serviceValueCents);
  if (!accountId) fail("No account.", 403, "forbidden");
  if (!selectedPassId) fail("Which pass?");
  if (!bookingId) fail("A balance can only settle a booking.", 400, "booking_required");
  if (!serviceId || serviceValueCents === null || serviceValueCents <= 0 || !currency) {
    fail("The service needs an exact value and currency.");
  }
  if (!input.acceptsCrossRedemption) {
    fail("That service does not accept cross redemption.", 409, "cross_redemption_disabled");
  }

  const client = await db().pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query(
      `SELECT id, person_id, cross_redeemable
       FROM public.passes
       WHERE id = $1 AND account_id = $2 AND status = 'active'
       FOR UPDATE`,
      [selectedPassId, accountId],
    );
    const pass = selected.rows[0] as Record<string, unknown> | undefined;
    if (!pass) fail("That pass was not found.", 404, "not_found");
    if (pass.cross_redeemable !== true || !pass.person_id) {
      fail("That pass can only be used for its covered services.", 409, "cross_redemption_disabled");
    }
    const personId = String(pass.person_id);

    const native = await client.query(
      `SELECT b.pass_id
       FROM public.pass_balances b
       WHERE b.account_id = $1
         AND b.person_id = $2
         AND $3 = ANY(b.covers_service_ids)
         AND b.effective_status = 'active'
         AND b.credits_available > 0
       LIMIT 1`,
      [accountId, personId, serviceId],
    );
    if (native.rows.length) {
      fail("Use the matching service entitlement before flexible value.", 409, "native_entitlement_available");
    }

    // Serialise every flexible-value spend for this person/currency, including
    // the case where there are no movement rows yet (which row locks cannot do).
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`pass-value:${accountId}:${personId}:${currency}`],
    );

    const flexibleRows = await client.query(
      `SELECT COALESCE(SUM(amount_cents), 0)::BIGINT AS value_cents
       FROM public.pass_value_movements
       WHERE account_id = $1 AND person_id = $2 AND currency = $3`,
      [accountId, personId, currency],
    );
    const flexibleValueCents = Number((flexibleRows.rows[0] as Record<string, unknown>)?.value_cents || 0);

    // Lock all candidate pass rows before reading their derived balances. This
    // prevents a native redemption racing the cross-redemption planner.
    await client.query(
      `SELECT id FROM public.passes
       WHERE account_id = $1 AND person_id = $2 AND cross_redeemable = TRUE
       ORDER BY id FOR UPDATE`,
      [accountId, personId],
    );
    const rows = await client.query(
      `SELECT a.allocation_id, a.pass_id, a.credits_allocated,
              a.credits_redeemed, a.credits_available, a.total_value_cents,
              a.expires_at, a.available_from
       FROM public.pass_allocation_balances a
       JOIN public.passes p ON p.id = a.pass_id AND p.account_id = a.account_id
       WHERE a.account_id = $1
         AND p.person_id = $2
         AND p.status = 'active'
         AND p.cross_redeemable = TRUE
         AND a.currency = $3
         AND a.total_value_cents IS NOT NULL
         AND a.is_live
         AND a.credits_available > 0
       ORDER BY a.expires_at NULLS LAST, a.available_from, a.allocation_id`,
      [accountId, personId, currency],
    );
    const plan = planCrossRedemption(
      serviceValueCents,
      flexibleValueCents,
      (rows.rows as Record<string, unknown>[]).map((row) => ({
        allocationId: String(row.allocation_id),
        passId: String(row.pass_id),
        unitsAllocated: Number(row.credits_allocated),
        unitsRedeemed: Number(row.credits_redeemed),
        unitsAvailable: Number(row.credits_available),
        totalValueCents: Number(row.total_value_cents),
        expiresAt: (row.expires_at as string) || null,
        availableFrom: String(row.available_from || ""),
      })),
    );
    if (!plan) fail("That Clarity balance is not enough for this service.", 409, "insufficient_value");

    const transactionId = `pvtx-${randomUUID()}`;
    await client.query(
      `INSERT INTO public.pass_value_transactions (
         id, account_id, person_id, booking_id, target_service_id, kind,
         target_value_cents, currency, created_by, created_at
       ) VALUES ($1, $2, $3, $4, $5, 'cross_redemption', $6, $7, $8, NOW())`,
      [transactionId, accountId, personId, bookingId, serviceId, serviceValueCents, currency, text(input.actorId, 160)],
    );

    if (plan.flexibleUsedCents > 0) {
      await client.query(
        `INSERT INTO public.pass_value_movements (
           id, account_id, person_id, transaction_id, amount_cents, currency,
           movement_kind, note, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'flexible_spent', $7, NOW())`,
        [`pvm-${randomUUID()}`, accountId, personId, transactionId, -plan.flexibleUsedCents, currency, `Used for ${serviceId}`],
      );
    }

    const redemptionIds: string[] = [];
    for (const [unitIndex, unit] of plan.entitlements.entries()) {
      const redemptionId = `red-${randomUUID()}`;
      // Only the first row carries booking_id. The value transaction groups
      // every unit, while the original global booking index still arbitrates
      // native versus cross-redemption races across two tills.
      const redemptionBookingId = unitIndex === 0 ? bookingId : null;
      await client.query(
        `INSERT INTO public.pass_redemptions (
           id, account_id, pass_id, allocation_id, booking_id, credits,
           redeemed_at, redeemed_by, created_at, value_cents,
           redemption_kind, value_transaction_id
         ) VALUES ($1, $2, $3, $4, $5, 1, NOW(), $6, NOW(), $7,
                   'cross_redemption', $8)`,
        [redemptionId, accountId, unit.passId, unit.allocationId, redemptionBookingId, text(input.actorId, 160), unit.valueCents, transactionId],
      );
      redemptionIds.push(redemptionId);
    }

    if (plan.residualCents > 0) {
      await client.query(
        `INSERT INTO public.pass_value_movements (
           id, account_id, person_id, transaction_id, pass_id, allocation_id,
           redemption_id, amount_cents, currency, movement_kind, note, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'residual_created', $10, NOW())`,
        [`pvm-${randomUUID()}`, accountId, personId, transactionId,
          plan.entitlements[0]?.passId || selectedPassId,
          plan.entitlements[0]?.allocationId || null,
          redemptionIds[0] || null,
          plan.residualCents, currency,
          `Change from ${serviceId}`],
      );
    }

    await client.query("COMMIT");
    return {
      transactionId,
      redemptionIds,
      flexibleUsedCents: plan.flexibleUsedCents,
      residualCents: plan.residualCents,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    if ((error as { code?: string })?.code === "23505") {
      fail("That booking has already been settled with a pass.", 409, "already_redeemed");
    }
    throw error;
  } finally {
    client.release();
  }
}

export type ReservedPassPayment =
  | ({ kind: "native" } & ReservedCredit)
  | ({ kind: "cross_redemption" } & ReservedValue);

/** Server-owned switch between native entitlement use and value exchange. */
export async function reservePassForService(input: {
  accountId: string;
  passId: string;
  bookingId: string;
  serviceId: string;
  serviceValueCents: number;
  currency: string;
  acceptsCrossRedemption: boolean;
  actorId?: string;
}): Promise<ReservedPassPayment> {
  const rows = await db().sql`
    SELECT covers_service_ids
    FROM public.passes
    WHERE id = ${text(input.passId, 120)}
      AND account_id = ${text(input.accountId, 120)}
    LIMIT 1
  `;
  const pass = (rows as Record<string, unknown>[])[0];
  if (!pass) fail("That pass was not found.", 404, "not_found");
  const covers = Array.isArray(pass.covers_service_ids)
    ? (pass.covers_service_ids as unknown[]).map(String)
    : [];
  if (covers.includes(text(input.serviceId, 120))) {
    return {
      kind: "native",
      ...(await reservePassCredit({
        accountId: input.accountId,
        passId: input.passId,
        bookingId: input.bookingId,
        actorId: input.actorId,
      })),
    };
  }
  return { kind: "cross_redemption", ...(await reserveCrossRedemption(input)) };
}

/** Record which $0 sale a redemption settled, once that sale exists. */
export async function attachRedemptionToSale(
  accountId: string,
  redemptionId: string,
  posTransactionId: string,
): Promise<void> {
  await db().sql`
    UPDATE public.pass_redemptions
    SET pos_transaction_id = ${text(posTransactionId, 160)}
    WHERE id = ${text(redemptionId, 120)} AND account_id = ${text(accountId, 120)}
  `;
}

/** Attach every entitlement movement in a value settlement to its POS row. */
export async function attachValueTransactionToSale(
  accountId: string,
  transactionId: string,
  posTransactionId: string,
): Promise<void> {
  await db().sql`
    UPDATE public.pass_redemptions
    SET pos_transaction_id = ${text(posTransactionId, 160)}
    WHERE value_transaction_id = ${text(transactionId, 160)}
      AND account_id = ${text(accountId, 120)}
  `;
}

/** Restore the exact allocation units and append inverse monetary movements. */
export async function reversePassValueTransaction(
  accountId: string,
  transactionId: string,
  reason: string,
  actorId = "",
): Promise<boolean> {
  const client = await db().pool.connect();
  try {
    await client.query("BEGIN");
    const held = await client.query(
      `SELECT * FROM public.pass_value_transactions
       WHERE id = $1 AND account_id = $2 AND reversed_at IS NULL
       FOR UPDATE`,
      [text(transactionId, 160), text(accountId, 120)],
    );
    const original = held.rows[0] as Record<string, unknown> | undefined;
    if (!original) {
      await client.query("ROLLBACK");
      return false;
    }
    const personId = String(original.person_id);
    const currency = String(original.currency);
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`pass-value:${accountId}:${personId}:${currency}`],
    );
    const movements = await client.query(
      `SELECT id, pass_id, allocation_id, redemption_id, amount_cents
       FROM public.pass_value_movements
       WHERE account_id = $1 AND transaction_id = $2
       ORDER BY created_at, id`,
      [accountId, transactionId],
    );
    const balanceRows = await client.query(
      `SELECT COALESCE(SUM(amount_cents), 0)::BIGINT AS value_cents
       FROM public.pass_value_movements
       WHERE account_id = $1 AND person_id = $2 AND currency = $3`,
      [accountId, personId, currency],
    );
    const balance = Number((balanceRows.rows[0] as Record<string, unknown>)?.value_cents || 0);
    const inverseTotal = -(movements.rows as Record<string, unknown>[])
      .reduce((sum, row) => sum + Number(row.amount_cents || 0), 0);
    if (balance + inverseTotal < 0) {
      fail("Later spending must be reversed before this transaction.", 409, "dependent_value_spent");
    }

    const reversalId = `pvtx-${randomUUID()}`;
    await client.query(
      `INSERT INTO public.pass_value_transactions (
         id, account_id, person_id, kind, target_value_cents, currency,
         source_ref, created_by, created_at
       ) VALUES ($1, $2, $3, 'reversal', $4, $5, $6, $7, NOW())`,
      [reversalId, accountId, personId, Number(original.target_value_cents) || 0,
        currency, `reversal:${transactionId}`, text(actorId, 160)],
    );
    for (const movement of movements.rows as Record<string, unknown>[]) {
      await client.query(
        `INSERT INTO public.pass_value_movements (
           id, account_id, person_id, transaction_id, pass_id, allocation_id,
           redemption_id, amount_cents, currency, movement_kind, note, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'reversal', $10, NOW())`,
        [`pvm-${randomUUID()}`, accountId, personId, reversalId,
          movement.pass_id || null, movement.allocation_id || null, movement.redemption_id || null,
          -Number(movement.amount_cents), currency, text(reason, 300) || "Transaction reversed"],
      );
    }
    await client.query(
      `UPDATE public.pass_redemptions
       SET reversed_at = NOW(), reversal_reason = $3, reversed_by = $4
       WHERE account_id = $1 AND value_transaction_id = $2 AND reversed_at IS NULL`,
      [accountId, transactionId, text(reason, 300), text(actorId, 160)],
    );
    await client.query(
      `UPDATE public.pass_value_transactions
       SET reversed_at = NOW(), reversal_reason = $3, reversed_by = $4
       WHERE account_id = $1 AND id = $2 AND reversed_at IS NULL`,
      [accountId, transactionId, text(reason, 300), text(actorId, 160)],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Give a credit back.
 *
 * Reversal, never deletion: the credit returns because the row stops counting,
 * and the row itself stays as the record that it was once taken. That is what
 * lets a balance explain a refund instead of just being smaller.
 *
 * Used both when a sale fails after the credit was reserved, and when a lesson
 * that was settled on a pass is later cancelled.
 */
/**
 * Spend a credit on something that was never booked.
 *
 * The honest correction for the commonest way a pass drifts out of true: the
 * lesson happened, nobody put it in the calendar, and the balance has said one
 * too many ever since. Before this the only fix was to void the pass and grant
 * a smaller one -- rewriting what somebody was given in order to correct what
 * they have since used, which loses the history that made the ledger worth
 * keeping.
 *
 * It takes the same allocation in the same order as a booking would, through
 * the same one-statement insert, so a hand-written spend and a booked one come
 * out of the same lot and expire on the same terms. The differences are that
 * booking_id is null and a reason is required.
 *
 * WHY THE SWEEP CANNOT TOUCH IT
 *
 * sweepReturnableCredits hands a credit back when the booking behind it is
 * gone, and it finds those with `booking_id IS NOT NULL`. A manual redemption
 * has no booking, so it is outside that filter by construction -- not by an
 * exception somebody has to remember. Were it not, every one of these would be
 * reversed by the very next balance read, labelled "Booking deleted".
 *
 * No idempotency key, and that is deliberate: a coach correcting a count may
 * genuinely mean to spend two credits in two clicks, and there is no second
 * record that could tell a repeat from an intention. The undo is a reversal,
 * which leaves both facts on the ledger.
 */
export async function redeemPassManually(input: {
  accountId: string;
  passId: string;
  credits?: number;
  note: string;
  actorId?: string;
}): Promise<{ redemptionId: string; allocationId: string }> {
  const accountId = text(input.accountId, 120);
  const passId = text(input.passId, 120);
  const note = text(input.note, 300);
  const credits = Math.max(1, Math.min(MAX_CREDITS, Math.round(Number(input.credits) || 1)));
  if (!accountId) fail("No account.", 403, "forbidden");
  if (!passId) fail("Which pass?");
  // Required rather than optional. A credit that vanished with no booking and
  // no reason is precisely what gets argued about at a counter months later,
  // and the ledger is the only place that argument can be settled.
  if (!note) fail("Say what this credit was used for.", 400, "note_required");

  const client = await db().pool.connect();
  try {
    await client.query("BEGIN");

    const held = await client.query(
      `SELECT id FROM public.passes WHERE id = $1 AND account_id = $2 FOR UPDATE`,
      [passId, accountId],
    );
    if (!held.rows.length) {
      await client.query("ROLLBACK");
      fail("That pass was not found.", 404, "not_found");
    }

    const spent = await client.query(
      `INSERT INTO public.pass_redemptions (
         id, account_id, pass_id, allocation_id, booking_id, credits, note,
         redeemed_at, redeemed_by, created_at
       )
       SELECT $1, $2, $3, a.allocation_id, NULL, $4, $5, NOW(), $6, NOW()
       FROM public.pass_allocation_balances a
       JOIN public.passes p ON p.id = a.pass_id AND p.account_id = a.account_id
       WHERE a.pass_id = $3
         AND a.account_id = $2
         AND a.is_live
         AND a.credits_available >= $4
         AND p.status = 'active'
         AND (p.expires_at IS NULL OR p.expires_at > NOW())
         AND (p.starts_at IS NULL OR p.starts_at <= NOW())
       ORDER BY a.expires_at NULLS LAST, a.available_from
       LIMIT 1
       RETURNING id, allocation_id`,
      [`red-${randomUUID()}`, accountId, passId, credits, note, text(input.actorId, 160)],
    );

    if (!spent.rows.length) {
      await client.query("ROLLBACK");
      fail("That pass has no credits left to spend.", 409, "no_credits");
    }

    await client.query("COMMIT");
    const row = spent.rows[0] as Record<string, unknown>;
    return { redemptionId: String(row.id), allocationId: String(row.allocation_id) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
}

export async function reversePassRedemption(
  accountId: string,
  redemptionId: string,
  reason: string,
  actorId = "",
): Promise<boolean> {
  const rows = await db().sql`
    UPDATE public.pass_redemptions
    SET reversed_at = NOW(),
        reversal_reason = ${text(reason, 300)},
        reversed_by = ${text(actorId, 160)}
    WHERE id = ${text(redemptionId, 120)}
      AND account_id = ${text(accountId, 120)}
      AND reversed_at IS NULL
    RETURNING id
  `;
  return (rows as unknown[]).length > 0;
}

// ---------------------------------------------------------------------------
// Giving credits back
// ---------------------------------------------------------------------------

/** A pg client, so a reversal can join a transaction that is already open. */
type SqlClient = { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> };

/**
 * Return every credit whose booking no longer deserves it.
 *
 * A live redemption should not outlive the thing it paid for. Three states mean
 * it has:
 *
 *   * the booking row is gone      -- deleted outright
 *   * status = 'cancelled'         -- called off
 *   * kind is no longer 'appointment'
 *
 * The third covers cancelling a group session, which does not set a status: the
 * session row becomes a block (isCancelledGroupSessionLike, booking-core.mts:
 * 3100). A credit against something that is no longer a lesson is a credit
 * against nothing.
 *
 * A no-show is deliberately NOT in that list. Charging for one is standard, and
 * defaulting to "credit returned" quietly costs the coach money; making that a
 * choice is a settings question rather than a code branch, and not this step's.
 *
 * Run on read rather than hooked onto each way a booking can end. There are
 * several of those -- the admin delete, the player's own cancel, a status
 * change, a bulk state write that drops a row -- and the failure mode of
 * missing one is a credit the customer paid for and cannot spend, discovered at
 * the counter weeks later. A sweep cannot be bypassed by a write path nobody
 * remembered, and it is the same lazy-on-read shape practice blocks already use
 * for expiry (expirePracticeBlocksDue, booking-core.mts:4001).
 *
 * The cost is one UPDATE that normally matches nothing, on a path that was
 * already going to query.
 */
export async function sweepReturnableCredits(accountId: string): Promise<number> {
  if (!accountId) return 0;
  const valueRows = await db().sql`
    SELECT t.id,
      CASE
        WHEN c.id IS NULL THEN 'Booking deleted'
        WHEN c.status = 'cancelled' THEN 'Lesson cancelled'
        ELSE 'Booking is no longer a lesson'
      END AS reason
    FROM public.pass_value_transactions t
    LEFT JOIN public.calendar_items c
      ON c.id = t.booking_id AND c.account_id = t.account_id
    WHERE t.account_id = ${accountId}
      AND t.reversed_at IS NULL
      AND t.booking_id IS NOT NULL
      AND (c.id IS NULL OR c.status = 'cancelled' OR c.kind <> 'appointment')
  `;
  let valueReturned = 0;
  for (const row of valueRows as Record<string, unknown>[]) {
    if (await reversePassValueTransaction(
      accountId,
      String(row.id),
      String(row.reason || "Booking cancelled"),
      "system",
    )) valueReturned += 1;
  }
  const rows = await db().sql`
    UPDATE public.pass_redemptions r
    SET reversed_at = NOW(),
        reversal_reason = CASE
          WHEN c.id IS NULL THEN 'Booking deleted'
          WHEN c.status = 'cancelled' THEN 'Lesson cancelled'
          ELSE 'Booking is no longer a lesson'
        END,
        reversed_by = 'system'
    FROM public.pass_redemptions self
    LEFT JOIN public.calendar_items c
      ON c.id = self.booking_id AND c.account_id = self.account_id
    WHERE r.id = self.id
      AND r.account_id = ${accountId}
      AND r.reversed_at IS NULL
      AND r.booking_id IS NOT NULL
      AND r.value_transaction_id IS NULL
      AND (c.id IS NULL OR c.status = 'cancelled' OR c.kind <> 'appointment')
    RETURNING r.id
  `;
  return valueReturned + (rows as unknown[]).length;
}

/**
 * Give back whatever one booking took, now rather than on the next read.
 *
 * Takes an open client so the credit returns in the same transaction as the
 * delete that caused it: a delete that commits while the reversal fails would
 * leave a credit stranded against a booking that no longer exists, which is
 * precisely what the sweep above then has to clean up. Doing both at once means
 * it never has to.
 */
export async function reverseRedemptionsForBooking(
  client: SqlClient,
  accountId: string,
  bookingId: string,
  reason: string,
  actorId = "",
): Promise<number> {
  const id = text(bookingId, 160);
  if (!accountId || !id) return 0;
  const valueTransactions = await client.query(
    `SELECT id, person_id, currency, target_value_cents
     FROM public.pass_value_transactions
     WHERE account_id = $1 AND booking_id = $2 AND reversed_at IS NULL
     FOR UPDATE`,
    [accountId, id],
  );
  let reversed = 0;
  for (const transaction of valueTransactions.rows as Record<string, unknown>[]) {
    const transactionId = String(transaction.id);
    const personId = String(transaction.person_id);
    const currency = String(transaction.currency);
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`pass-value:${accountId}:${personId}:${currency}`],
    );
    const movements = await client.query(
      `SELECT pass_id, allocation_id, redemption_id, amount_cents
       FROM public.pass_value_movements
       WHERE account_id = $1 AND transaction_id = $2
       ORDER BY created_at, id`,
      [accountId, transactionId],
    );
    const balanceRows = await client.query(
      `SELECT COALESCE(SUM(amount_cents), 0)::BIGINT AS value_cents
       FROM public.pass_value_movements
       WHERE account_id = $1 AND person_id = $2 AND currency = $3`,
      [accountId, personId, currency],
    );
    const inverseTotal = -(movements.rows as Record<string, unknown>[])
      .reduce((sum, movement) => sum + Number(movement.amount_cents || 0), 0);
    if (Number((balanceRows.rows[0] as Record<string, unknown>)?.value_cents || 0) + inverseTotal < 0) {
      fail("Later spending must be reversed before this booking can be reversed.", 409, "dependent_value_spent");
    }
    const reversalId = `pvtx-${randomUUID()}`;
    await client.query(
      `INSERT INTO public.pass_value_transactions (
         id, account_id, person_id, kind, target_value_cents, currency,
         source_ref, created_by, created_at
       ) VALUES ($1, $2, $3, 'reversal', $4, $5, $6, $7, NOW())`,
      [reversalId, accountId, personId, Number(transaction.target_value_cents) || 0,
        currency, `reversal:${transactionId}`, text(actorId, 160)],
    );
    for (const movement of movements.rows as Record<string, unknown>[]) {
      await client.query(
        `INSERT INTO public.pass_value_movements (
           id, account_id, person_id, transaction_id, pass_id, allocation_id,
           redemption_id, amount_cents, currency, movement_kind, note, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'reversal', $10, NOW())`,
        [`pvm-${randomUUID()}`, accountId, personId, reversalId,
          movement.pass_id || null, movement.allocation_id || null, movement.redemption_id || null,
          -Number(movement.amount_cents), currency, text(reason, 300) || "Booking reversed"],
      );
    }
    await client.query(
      `UPDATE public.pass_redemptions
       SET reversed_at = NOW(), reversal_reason = $3, reversed_by = $4
       WHERE account_id = $1 AND value_transaction_id = $2 AND reversed_at IS NULL`,
      [accountId, transactionId, text(reason, 300), text(actorId, 160)],
    );
    await client.query(
      `UPDATE public.pass_value_transactions
       SET reversed_at = NOW(), reversal_reason = $3, reversed_by = $4
       WHERE account_id = $1 AND id = $2 AND reversed_at IS NULL`,
      [accountId, transactionId, text(reason, 300), text(actorId, 160)],
    );
    reversed += 1;
  }
  const result = await client.query(
    `UPDATE public.pass_redemptions
     SET reversed_at = NOW(), reversal_reason = $3, reversed_by = $4
     WHERE account_id = $1 AND booking_id = $2 AND reversed_at IS NULL
       AND value_transaction_id IS NULL
     RETURNING id`,
    [accountId, id, text(reason, 300) || "Booking deleted", text(actorId, 160)],
  );
  return reversed + result.rows.length;
}
