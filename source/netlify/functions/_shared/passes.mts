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
};

export type PassView = {
  id: string;
  personId: string | null;
  name: string;
  templateServiceId: string | null;
  coversServiceIds: string[];
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
};

/** What a `lessonFormat: "package"` service says about the pass it sells. */
export type PassTemplate = {
  serviceId: string;
  name: string;
  credits: number;
  coversServiceIds: string[];
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
    });
  }
  return templates;
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
  pass: { templateServiceId: string | null; coversServiceIds: string[] },
  grant: { templateServiceId: string | null; coversServiceIds: string[] },
): boolean {
  if (!pass.templateServiceId || pass.templateServiceId !== grant.templateServiceId) return false;
  if (pass.coversServiceIds.length !== grant.coversServiceIds.length) return false;
  const held = new Set(pass.coversServiceIds);
  return grant.coversServiceIds.every((id) => held.has(id));
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
    merge: input?.merge !== false,
    source: PASS_SOURCES.includes(input?.source as PassSource) ? (input.source as PassSource) : "manual",
    sourceRef: text(input?.sourceRef, 200),
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
    id: String(row.id),
    credits: Number(row.credits) || 0,
    creditsRedeemed: Number(row.credits_redeemed) || 0,
    creditsAvailable: Number(row.credits_available) || 0,
    availableFrom: String(row.available_from || ""),
    expiresAt: (row.expires_at as string) || null,
    isLive: row.is_live === true,
    source: String(row.source || ""),
    note: (row.note as string) || "",
    createdAt: String(row.created_at || ""),
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
    SELECT id, person_id, template_service_id, covers_service_ids, status
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
           credits_per_period, rollover_policy, note, created_by, created_at, updated_at
         ) VALUES (
           $1, $2, NULLIF($3, ''), $4, $5, $6,
           NOW(), $7, 'active', $8, NULLIF($9, ''), 'one_off',
           $10, 'rollover', $11, $12, NOW(), NOW()
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
        ],
      );
    }

    await client.query(
      `INSERT INTO public.pass_allocations (
         id, account_id, pass_id, credits, available_from, expires_at,
         source, source_ref, note, created_by, created_at
       ) VALUES ($1, $2, $3, $4, NOW(), $5, $6, NULLIF($7, ''), $8, $9, NOW())`,
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
): PassOption[] {
  const wanted = text(serviceId, 120);
  return passes
    .filter((pass) => pass.status === "active" || pass.status === "exhausted")
    .map((pass) => {
      const covered = Boolean(wanted) && pass.coversServiceIds.includes(wanted);
      let reason = "";
      if (!pass.coversServiceIds.length) reason = "No covered service set";
      else if (!covered) reason = "Covers something else";
      else if (pass.creditsAvailable < 1) reason = "No credits left";
      return {
        passId: pass.id,
        name: pass.name,
        creditsAvailable: pass.creditsAvailable,
        creditsAllocated: pass.creditsAllocated,
        expiresAt: pass.expiresAt,
        nextExpiry: pass.nextExpiry,
        covered: covered && pass.creditsAvailable >= 1,
        reason: reason || (serviceName ? `Covers ${serviceName}` : ""),
      };
    });
}

export type ReservedCredit = { redemptionId: string; allocationId: string };

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
      AND (c.id IS NULL OR c.status = 'cancelled' OR c.kind <> 'appointment')
    RETURNING r.id
  `;
  return (rows as unknown[]).length;
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
  const result = await client.query(
    `UPDATE public.pass_redemptions
     SET reversed_at = NOW(), reversal_reason = $3, reversed_by = $4
     WHERE account_id = $1 AND booking_id = $2 AND reversed_at IS NULL
     RETURNING id`,
    [accountId, id, text(reason, 300) || "Booking deleted", text(actorId, 160)],
  );
  return result.rows.length;
}
