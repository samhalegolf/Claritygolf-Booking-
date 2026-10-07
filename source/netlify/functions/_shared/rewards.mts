/**
 * Rewards: pass credits earned by activity.
 *
 * A programme says what earns a reward (every N completed lessons, or every $X
 * paid at the till) and what a reward is (credits on a pass, covering some
 * services or all of them, expiring after so many months). It is the
 * membership engine's sibling: both top up passes over time according to
 * settings, and both do it through the same ledger -- one `passes` row per
 * (programme, person), one `pass_allocations` row per reward. Nothing here can
 * change how a credit behaves once it exists.
 *
 * The rule that keeps it honest is the same one the pass ledger runs on:
 * nothing stores a running total. Progress is recounted from the activity
 * itself every time, and the rewards already paid are the allocations already
 * written, each keyed `milestone:<n>` under a unique index. So the sweep can
 * run every half hour, a coach can press Run now, and two of them can overlap,
 * and each milestone still lands exactly once.
 *
 * Every query filters on account_id in the SQL.
 */

import { randomUUID } from "node:crypto";

import { getDatabase } from "./database.mts";
import { cleanString } from "./values.mts";

const db = getDatabase;

type Row = Record<string, any>;

export type RewardTrigger = "lessons_completed" | "amount_spent";

export type RewardProgram = {
  id: string;
  name: string;
  description: string;
  active: boolean;
  trigger: RewardTrigger;
  /** Lessons for lessons_completed; minor units for amount_spent. */
  threshold: number;
  countsServiceIds: string[];
  countsAllServices: boolean;
  /** ISO instant. Only activity on or after it counts. */
  countsFrom: string;
  rewardCredits: number;
  rewardCoversServiceIds: string[];
  rewardCoversAllServices: boolean;
  /** null = the credits never expire. */
  rewardExpiryMonths: number | null;
  /** null = no limit. */
  maxRewardsPerPerson: number | null;
};

export type RewardProgramView = RewardProgram & {
  createdAt: string;
  updatedAt: string;
  /** People who have earned at least one reward. */
  peopleRewarded: number;
  rewardsGranted: number;
  creditsGranted: number;
};

export type RewardActor = { accountId: string; actorId: string };

const TRIGGERS: RewardTrigger[] = ["lessons_completed", "amount_spent"];
const MAX_IDS = 12;

function fail(message: string, status = 400, code = "invalid"): never {
  throw Object.assign(new Error(message), { status, code });
}

function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => cleanString(entry, "", 120)).filter(Boolean))].slice(0, MAX_IDS);
}

function wholeNumber(value: unknown, min: number, max: number): number | null {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(min, Math.min(max, Math.round(number)));
}

/**
 * Turn what an editor sent into a programme that can be stored, or refuse it.
 *
 * `knownServiceIds`, when given, is the catalogue: a reward covering a service
 * that does not exist is a credit with nowhere to be spent.
 */
export function normaliseProgram(
  input: Record<string, unknown>,
  defaults: { id: string; now?: Date },
  knownServiceIds?: Set<string>,
): RewardProgram {
  const name = cleanString(input?.name, "", 120);
  if (!name) fail("Give the rewards programme a name.");

  const trigger = TRIGGERS.includes(input?.trigger as RewardTrigger)
    ? (input.trigger as RewardTrigger)
    : fail("Choose what earns a reward.");

  // Money arrives in minor units, like every other amount on the server.
  const threshold =
    trigger === "amount_spent"
      ? wholeNumber(input?.threshold, 0, 100_000_000)
      : wholeNumber(input?.threshold, 0, 500);
  if (!threshold || threshold < 1) {
    fail(trigger === "amount_spent" ? "Set how much has to be spent for a reward." : "Set how many lessons earn a reward.");
  }

  const countsAllServices = trigger === "amount_spent" || input?.countsAllServices !== false;
  const countsServiceIds = countsAllServices ? [] : idList(input?.countsServiceIds);
  if (!countsAllServices && !countsServiceIds.length) {
    fail("Choose which lessons count towards a reward, or count them all.");
  }

  const rewardCredits = wholeNumber(input?.rewardCredits, 0, 100) || 0;
  if (rewardCredits < 1) fail("A reward needs at least 1 credit.");

  const rewardCoversAllServices = input?.rewardCoversAllServices === true;
  const rewardCoversServiceIds = rewardCoversAllServices ? [] : idList(input?.rewardCoversServiceIds);
  if (!rewardCoversAllServices && !rewardCoversServiceIds.length) {
    fail("Choose what the reward credits can be spent on, or let them pay for anything.");
  }

  if (knownServiceIds) {
    const unknown = [...countsServiceIds, ...rewardCoversServiceIds].find((id) => !knownServiceIds.has(id));
    if (unknown) fail("That programme names a service that no longer exists.");
  }

  const expiry = wholeNumber(input?.rewardExpiryMonths, 0, 120);
  const max = wholeNumber(input?.maxRewardsPerPerson, 0, 1000);

  const now = defaults.now || new Date();
  const from = new Date(cleanString(input?.countsFrom, "", 40));
  const countsFrom = Number.isNaN(from.getTime()) ? now.toISOString() : from.toISOString();

  return {
    id: defaults.id,
    name,
    description: cleanString(input?.description, "", 600),
    active: input?.active !== false,
    trigger,
    threshold,
    countsServiceIds,
    countsAllServices,
    countsFrom,
    rewardCredits,
    rewardCoversServiceIds,
    rewardCoversAllServices,
    rewardExpiryMonths: expiry ? expiry : null,
    maxRewardsPerPerson: max ? max : null,
  };
}

/** How many rewards a level of activity has earned, under the programme's cap. */
export function milestonesEarned(
  progress: number,
  program: Pick<RewardProgram, "threshold" | "maxRewardsPerPerson">,
): number {
  if (!(program.threshold >= 1) || !(progress > 0)) return 0;
  const earned = Math.floor(progress / program.threshold);
  return program.maxRewardsPerPerson ? Math.min(earned, program.maxRewardsPerPerson) : earned;
}

/** Where somebody stands: what they have done, and how far to the next reward. */
export function progressTowardsNext(
  progress: number,
  program: Pick<RewardProgram, "threshold" | "maxRewardsPerPerson">,
) {
  const earned = milestonesEarned(progress, program);
  const capped = Boolean(program.maxRewardsPerPerson && earned >= program.maxRewardsPerPerson);
  const intoCurrent = capped ? program.threshold : Math.max(0, progress) % program.threshold;
  return {
    earned,
    capped,
    intoCurrent,
    remaining: capped ? 0 : program.threshold - intoCurrent,
  };
}

function monthsAfter(from: Date, months: number): string {
  const then = new Date(from);
  then.setMonth(then.getMonth() + months);
  return then.toISOString();
}

export function rewardPassRef(programId: string, personId: string) {
  return `reward:${programId}:${personId}`;
}

// ---------------------------------------------------------------------------
// Programmes
// ---------------------------------------------------------------------------

function iso(value: unknown): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function rowToProgram(row: Row): RewardProgramView {
  return {
    id: String(row.id),
    name: String(row.name || ""),
    description: String(row.description || ""),
    active: row.active === true,
    trigger: row.trigger === "amount_spent" ? "amount_spent" : "lessons_completed",
    threshold: Number(row.threshold) || 1,
    countsServiceIds: Array.isArray(row.counts_service_ids) ? row.counts_service_ids.map(String) : [],
    countsAllServices: row.counts_all_services === true,
    countsFrom: iso(row.counts_from),
    rewardCredits: Number(row.reward_credits) || 1,
    rewardCoversServiceIds: Array.isArray(row.reward_covers_service_ids)
      ? row.reward_covers_service_ids.map(String)
      : [],
    rewardCoversAllServices: row.reward_covers_all_services === true,
    rewardExpiryMonths: row.reward_expiry_months === null ? null : Number(row.reward_expiry_months) || null,
    maxRewardsPerPerson: row.max_rewards_per_person === null ? null : Number(row.max_rewards_per_person) || null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    peopleRewarded: Number(row.people_rewarded) || 0,
    rewardsGranted: Number(row.rewards_granted) || 0,
    creditsGranted: Number(row.credits_granted) || 0,
  };
}

export async function readPrograms(accountId: string): Promise<RewardProgramView[]> {
  if (!accountId) return [];
  const rows = (await db().sql`
    SELECT r.*,
      COALESCE(g.people_rewarded, 0) AS people_rewarded,
      COALESCE(g.rewards_granted, 0) AS rewards_granted,
      COALESCE(g.credits_granted, 0) AS credits_granted
    FROM public.reward_programs r
    LEFT JOIN (
      SELECT split_part(p.source_ref, ':', 2) AS program_id,
             COUNT(DISTINCT p.person_id) AS people_rewarded,
             COUNT(a.id) AS rewards_granted,
             COALESCE(SUM(a.credits), 0) AS credits_granted
      FROM public.passes p
      JOIN public.pass_allocations a
        ON a.pass_id = p.id AND a.account_id = p.account_id AND a.source = 'reward'
      WHERE p.account_id = ${accountId} AND p.source = 'reward'
      GROUP BY 1
    ) g ON g.program_id = r.id
    WHERE r.account_id = ${accountId} AND r.archived_at IS NULL
    ORDER BY r.sort_order, r.created_at
  `) as Row[];
  return rows.map(rowToProgram);
}

async function programExists(accountId: string, programId: string) {
  const rows = (await db().sql`
    SELECT 1 FROM public.reward_programs
    WHERE id = ${programId} AND account_id = ${accountId} AND archived_at IS NULL
    LIMIT 1
  `) as Row[];
  return rows.length > 0;
}

/**
 * Create or update a programme.
 *
 * Rewards already earned stay exactly as they were -- they are credits on a
 * pass, snapshotted when the pass was made. A change applies to rewards earned
 * from here on: raise the threshold and nobody loses what they have.
 */
export async function saveProgram(
  input: Record<string, unknown>,
  context: { serviceIds?: Set<string> },
  actor: RewardActor,
): Promise<RewardProgramView[]> {
  const { accountId } = actor;
  if (!accountId) fail("No account.", 403, "forbidden");
  const existingId = cleanString(input?.id, "", 120);
  if (existingId && !(await programExists(accountId, existingId))) {
    fail("That rewards programme was not found.", 404, "not_found");
  }
  const program = normaliseProgram(input || {}, { id: existingId || `reward-${randomUUID()}` }, context.serviceIds);
  await db().sql`
    INSERT INTO public.reward_programs (
      id, account_id, name, description, active, trigger, threshold,
      counts_service_ids, counts_all_services, counts_from,
      reward_credits, reward_covers_service_ids, reward_covers_all_services,
      reward_expiry_months, max_rewards_per_person, created_by, created_at, updated_at
    ) VALUES (
      ${program.id}, ${accountId}, ${program.name}, ${program.description}, ${program.active},
      ${program.trigger}, ${program.threshold}, ${program.countsServiceIds}, ${program.countsAllServices},
      ${program.countsFrom}, ${program.rewardCredits}, ${program.rewardCoversServiceIds},
      ${program.rewardCoversAllServices}, ${program.rewardExpiryMonths}, ${program.maxRewardsPerPerson},
      ${actor.actorId}, NOW(), NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      active = EXCLUDED.active,
      trigger = EXCLUDED.trigger,
      threshold = EXCLUDED.threshold,
      counts_service_ids = EXCLUDED.counts_service_ids,
      counts_all_services = EXCLUDED.counts_all_services,
      counts_from = EXCLUDED.counts_from,
      reward_credits = EXCLUDED.reward_credits,
      reward_covers_service_ids = EXCLUDED.reward_covers_service_ids,
      reward_covers_all_services = EXCLUDED.reward_covers_all_services,
      reward_expiry_months = EXCLUDED.reward_expiry_months,
      max_rewards_per_person = EXCLUDED.max_rewards_per_person,
      updated_at = NOW()
    WHERE public.reward_programs.account_id = ${accountId}
  `;
  return readPrograms(accountId);
}

/** Retire a programme. Rewards already earned stay spendable. */
export async function archiveProgram(programId: string, actor: RewardActor): Promise<RewardProgramView[]> {
  await db().sql`
    UPDATE public.reward_programs
    SET archived_at = NOW(), active = FALSE, updated_at = NOW()
    WHERE id = ${cleanString(programId, "", 120)} AND account_id = ${actor.accountId}
  `;
  return readPrograms(actor.accountId);
}

// ---------------------------------------------------------------------------
// Progress -- always recounted, never stored
// ---------------------------------------------------------------------------

/**
 * Each person's activity towards one programme, keyed by person id.
 *
 * Lessons: completed appointments of a counted service, completed on or after
 * counts_from, for someone who is still a client. Spend: paid till sales to a
 * named client since counts_from, not counting the $0 sales a pass or a coupon
 * settles -- spending a reward must not earn the next one.
 */
async function readActivity(
  accountId: string,
  program: RewardProgram,
  personId: string | null,
): Promise<Map<string, number>> {
  const rows = (program.trigger === "amount_spent"
    ? await db().sql`
        SELECT t.customer_id AS person_id, ROUND(SUM(t.amount) * 100)::bigint AS progress
        FROM public.billing_pos_transactions t
        JOIN public.people pe ON pe.id = t.customer_id AND pe.account_id = t.account_id
        WHERE t.account_id = ${accountId}
          AND t.status = 'paid'
          AND t.amount > 0
          AND COALESCE(t.payment_method_kind, '') NOT IN ('pass', 'coupon')
          AND COALESCE(t.paid_at, t.created_at) >= ${program.countsFrom}::timestamptz
          AND (${personId}::text IS NULL OR t.customer_id = ${personId})
        GROUP BY t.customer_id
      `
    : await db().sql`
        SELECT c.person_id, COUNT(*)::bigint AS progress
        FROM public.calendar_items c
        JOIN public.people pe ON pe.id = c.person_id AND pe.account_id = c.account_id
        WHERE c.account_id = ${accountId}
          AND c.kind = 'appointment'
          AND c.status = 'completed'
          AND c.completed_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
          AND (CASE WHEN c.completed_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN c.completed_at::timestamptz END)
              >= ${program.countsFrom}::timestamptz
          AND (${program.countsAllServices} OR c.service_id = ANY(${program.countsServiceIds}::text[]))
          AND (${personId}::text IS NULL OR c.person_id = ${personId})
        GROUP BY c.person_id
      `) as Row[];
  return new Map(rows.map((row) => [String(row.person_id), Number(row.progress) || 0]));
}

/** Rewards already paid under one programme, keyed by person id. */
async function readGranted(
  accountId: string,
  programId: string,
  personId: string | null,
): Promise<Map<string, { passId: string; status: string; granted: number }>> {
  const prefix = `reward:${programId}:`;
  const rows = (await db().sql`
    SELECT p.id, p.person_id, p.status, COUNT(a.id) AS granted
    FROM public.passes p
    LEFT JOIN public.pass_allocations a
      ON a.pass_id = p.id AND a.account_id = p.account_id AND a.source = 'reward'
    WHERE p.account_id = ${accountId}
      AND p.source = 'reward'
      AND left(p.source_ref, ${prefix.length}) = ${prefix}
      AND (${personId}::text IS NULL OR p.person_id = ${personId})
    GROUP BY p.id, p.person_id, p.status
  `) as Row[];
  return new Map(
    rows
      .filter((row) => row.person_id)
      .map((row) => [
        String(row.person_id),
        { passId: String(row.id), status: String(row.status || ""), granted: Number(row.granted) || 0 },
      ]),
  );
}

async function ensureRewardPass(accountId: string, program: RewardProgram, personId: string): Promise<{ id: string; status: string } | null> {
  const sourceRef = rewardPassRef(program.id, personId);
  await db().sql`
    INSERT INTO public.passes (
      id, account_id, person_id, name, template_service_id, covers_service_ids, covers_all_services,
      issued_at, expires_at, status, source, source_ref, allocation_mode,
      credits_per_period, rollover_policy, note, created_by, created_at, updated_at
    ) VALUES (
      ${`pass-${randomUUID()}`}, ${accountId}, ${personId}, ${program.name}, NULL,
      ${program.rewardCoversServiceIds}, ${program.rewardCoversAllServices},
      NOW(), NULL, 'active', 'reward', ${sourceRef}, 'one_off',
      ${program.rewardCredits}, 'rollover', ${`Rewards: ${program.name}`}, 'rewards', NOW(), NOW()
    )
    ON CONFLICT DO NOTHING
  `;
  const rows = (await db().sql`
    SELECT id, status FROM public.passes
    WHERE account_id = ${accountId} AND source = 'reward' AND source_ref = ${sourceRef}
    LIMIT 1
  `) as Row[];
  return rows[0] ? { id: String(rows[0].id), status: String(rows[0].status || "") } : null;
}

export type RewardRunResult = { programs: number; people: number; rewards: number; credits: number };

/**
 * Pay every reward that has been earned and not yet paid.
 *
 * Safe to run any number of times, from any number of places at once: each
 * milestone is an allocation keyed `milestone:<n>` on the person's reward pass,
 * and the unique index on (account_id, pass_id, source, source_ref) refuses a
 * second one. A voided reward pass is left alone -- a coach took it back.
 */
export async function runRewards(
  accountId: string,
  options: { personId?: string; programId?: string; now?: Date } = {},
): Promise<RewardRunResult> {
  const result: RewardRunResult = { programs: 0, people: 0, rewards: 0, credits: 0 };
  if (!accountId) return result;
  const personId = cleanString(options.personId, "", 160) || null;
  const programId = cleanString(options.programId, "", 120) || null;
  const now = options.now || new Date();
  const programs = (await readPrograms(accountId)).filter(
    (program) => program.active && (!programId || program.id === programId),
  );
  for (const program of programs) {
    result.programs += 1;
    const [activity, granted] = await Promise.all([
      readActivity(accountId, program, personId),
      readGranted(accountId, program.id, personId),
    ]);
    for (const [person, progress] of activity) {
      const earned = milestonesEarned(progress, program);
      const held = granted.get(person);
      if (earned <= (held?.granted || 0)) continue;
      if (held && held.status === "void") continue;
      const pass = held ? { id: held.passId, status: held.status } : await ensureRewardPass(accountId, program, person);
      if (!pass || pass.status === "void") continue;
      let paidHere = 0;
      for (let milestone = (held?.granted || 0) + 1; milestone <= earned; milestone += 1) {
        const inserted = (await db().sql`
          INSERT INTO public.pass_allocations (
            id, account_id, pass_id, credits, available_from, expires_at,
            source, source_ref, note, created_by, created_at, entitlement_service_id
          ) VALUES (
            ${`alloc-${randomUUID()}`}, ${accountId}, ${pass.id}, ${program.rewardCredits}, NOW(),
            ${program.rewardExpiryMonths ? monthsAfter(now, program.rewardExpiryMonths) : null},
            'reward', ${`milestone:${milestone}`},
            ${rewardNote(program, milestone)}, 'rewards', NOW(),
            ${program.rewardCoversServiceIds.length === 1 ? program.rewardCoversServiceIds[0] : null}
          )
          ON CONFLICT DO NOTHING
          RETURNING id
        `) as Row[];
        if (inserted.length) {
          paidHere += 1;
          result.rewards += 1;
          result.credits += program.rewardCredits;
        }
      }
      if (paidHere) result.people += 1;
    }
  }
  return result;
}

function rewardNote(program: RewardProgram, milestone: number) {
  const reached =
    program.trigger === "amount_spent"
      ? `${((program.threshold * milestone) / 100).toFixed(2)} spent`
      : `${program.threshold * milestone} lessons completed`;
  return `Reward ${milestone} · ${reached}`;
}

export type PersonRewardProgress = {
  programId: string;
  name: string;
  trigger: RewardTrigger;
  threshold: number;
  progress: number;
  earned: number;
  intoCurrent: number;
  remaining: number;
  capped: boolean;
  rewardCredits: number;
};

/** One client's standing in every live programme -- what the profile shows. */
export async function readPersonRewards(accountId: string, personId: string): Promise<PersonRewardProgress[]> {
  if (!accountId || !personId) return [];
  const programs = (await readPrograms(accountId)).filter((program) => program.active);
  const out: PersonRewardProgress[] = [];
  for (const program of programs) {
    const progress = (await readActivity(accountId, program, personId)).get(personId) || 0;
    const standing = progressTowardsNext(progress, program);
    out.push({
      programId: program.id,
      name: program.name,
      trigger: program.trigger,
      threshold: program.threshold,
      progress,
      earned: standing.earned,
      intoCurrent: standing.intoCurrent,
      remaining: standing.remaining,
      capped: standing.capped,
      rewardCredits: program.rewardCredits,
    });
  }
  return out;
}

/**
 * The sweep's clock: every account with a live programme, oldest first, inside
 * a time budget. Anything left over is picked up on the next run.
 */
export async function runAllRewards(options: { budgetMs: number }): Promise<RewardRunResult & { accounts: number }> {
  const started = Date.now();
  const totals = { accounts: 0, programs: 0, people: 0, rewards: 0, credits: 0 };
  const rows = (await db().sql`
    SELECT DISTINCT account_id FROM public.reward_programs
    WHERE active AND archived_at IS NULL
  `) as Row[];
  for (const row of rows) {
    if (Date.now() - started > options.budgetMs) break;
    try {
      const result = await runRewards(String(row.account_id));
      totals.accounts += 1;
      totals.programs += result.programs;
      totals.people += result.people;
      totals.rewards += result.rewards;
      totals.credits += result.credits;
    } catch (error) {
      console.error("rewards:account_failed", row.account_id, error instanceof Error ? error.message : error);
    }
  }
  return totals;
}
