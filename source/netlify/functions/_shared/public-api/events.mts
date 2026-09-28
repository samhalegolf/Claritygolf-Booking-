/**
 * Events and webhooks.
 *
 *   change log  --(worker)-->  api_events  --(fan-out)-->  api_webhook_deliveries
 *                                   |                              |
 *                          GET /api/v1/events            POST to the business's URL,
 *                          (polling, replay)             signed, retried with backoff
 *
 * The event types, and what makes each one:
 *
 *   booking.created       a new booking
 *   booking.rescheduled   its start, end or length moved
 *   booking.cancelled     cancelled, or deleted outright (then `deleted: true`)
 *   booking.completed     marked as taught
 *   booking.no_show       marked as a no-show
 *   booking.updated       anything else about it changed
 *   client.created / client.updated / client.deleted
 *   pass.created          a pass issued to a client
 *   pass.redeemed         credits spent (a booking, a sale, or by hand)
 *   pass.voided           switched off
 *   pass.updated          credits added, a spend given back, or other change
 *   invoice.created / invoice.sent / invoice.paid / invoice.voided /
 *   invoice.updated / invoice.deleted
 *
 * Delivery follows Stripe's contract, which most receivers already handle:
 * POST JSON, `X-Clarity-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">`,
 * any 2xx within 10 seconds is success, anything else is retried -- after 1
 * minute, 5, 30, 2 hours, 6, 12, then daily for 3 days. An endpoint that has
 * failed for 3 days straight is switched off, and the settings screen says why.
 * Delivery is at-least-once: receivers should dedupe on the event id.
 */
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { getDatabase } from "@netlify/database";
import { openCredential, sealCredential } from "../integration-credentials.mts";
import {
  cleanResourceWebhookUrl,
  generateSigningSecret,
  signResourceWebhook,
  SIGNATURE_HEADER,
  EVENT_HEADER,
  DELIVERY_HEADER,
} from "../resource-webhook.mts";
import { bookingFromRow, clientFromRow, loadCatalog, previousAttributes, type Catalog } from "./serialize.mts";
import { API_VERSION, pruneApiWorkingTables } from "./http.mts";
import { invoiceObject, readInvoiceObject, readPassObject } from "./commerce.mts";

export const EVENT_TYPES = [
  "booking.created",
  "booking.rescheduled",
  "booking.cancelled",
  "booking.completed",
  "booking.no_show",
  "booking.updated",
  "client.created",
  "client.updated",
  "client.deleted",
  "pass.created",
  "pass.redeemed",
  "pass.voided",
  "pass.updated",
  "invoice.created",
  "invoice.sent",
  "invoice.paid",
  "invoice.voided",
  "invoice.updated",
  "invoice.deleted",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_ID_HEADER = "x-clarity-event-id";
export const WEBHOOK_TIMEOUT_MS = 10_000;

/** Minutes to wait before each retry. After the last, the delivery has failed for good. */
export const RETRY_SCHEDULE_MINUTES = [1, 5, 30, 120, 360, 720, 1440, 1440, 1440];

/** Failing continuously for this long switches an endpoint off. */
const DISABLE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

function db() {
  return getDatabase();
}

const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

// ---------------------------------------------------------------------------
// 1. Change log -> events
// ---------------------------------------------------------------------------

type ChangeRow = {
  id: number;
  account_id: string;
  table_name: string;
  op: string;
  row_id: string;
  old_row: any;
  new_row: any;
  changed_at: string;
};

/** One row's changes within a batch, collapsed to where it started and where it ended. */
export type CollapsedChange = {
  accountId: string;
  table: string;
  rowId: string;
  before: any | null;
  after: any | null;
  at: string;
};

/**
 * A booking made on the booking page is written, then gets its bay, then its
 * client link -- three writes in two seconds. Announcing that as one
 * `booking.created` (with the final state) rather than a created and two
 * updates is what a receiver actually wants.
 *
 * Only housekeeping folds in, though. A later change that means something on
 * its own -- cancelled, moved, completed -- starts a new event even inside the
 * same batch, so a booking made and cancelled within a minute is still two
 * events, not one "created" that happens to say cancelled. Pure; exported for
 * tests.
 */
export function collapseChanges(rows: ChangeRow[]): CollapsedChange[] {
  const out: CollapsedChange[] = [];
  const lastByRow = new Map<string, CollapsedChange>();
  for (const row of rows) {
    const key = `${row.account_id}\u0000${row.table_name}\u0000${row.row_id}`;
    const change: CollapsedChange = {
      accountId: row.account_id,
      table: row.table_name,
      rowId: row.row_id,
      before: row.old_row ?? null,
      after: row.new_row ?? null,
      at: row.changed_at,
    };
    const last = lastByRow.get(key);
    const housekeeping = last && change.before && change.after && eventTypeFor(change)?.endsWith(".updated");
    if (last && housekeeping) {
      last.after = change.after;
      last.at = change.at;
      continue;
    }
    out.push(change);
    lastByRow.set(key, change);
  }
  return out;
}

const moved = (a: any, b: any) =>
  ["week", "day", "start", "duration"].some((field) => Number(a?.[field]) !== Number(b?.[field]));

/** Which event a collapsed change is, or null for none. Pure; exported for tests. */
export function eventTypeFor(change: Pick<CollapsedChange, "table" | "before" | "after">): EventType | null {
  const { before, after } = change;
  if (!before && !after) return null;
  if (change.table === "people") {
    if (!before) return "client.created";
    if (!after) return "client.deleted";
    return "client.updated";
  }
  if (change.table === "passes") {
    if (!before) return "pass.created";
    if (!after || (before.status !== "void" && after.status === "void")) return "pass.voided";
    return "pass.updated";
  }
  if (change.table === "pass_allocations") return "pass.updated";
  if (change.table === "pass_redemptions") return !before && after ? "pass.redeemed" : "pass.updated";
  if (change.table === "billing_invoices") {
    if (!before) return "invoice.created";
    if (!after) return "invoice.deleted";
    if (before.status !== after.status) {
      if (after.status === "sent") return "invoice.sent";
      if (after.status === "paid") return "invoice.paid";
      if (after.status === "void") return "invoice.voided";
    }
    return "invoice.updated";
  }
  if (change.table !== "calendar_items") return null;
  if (!before) return "booking.created";
  if (!after) return "booking.cancelled";
  const was = String(before.status || "booked");
  const now = String(after.status || "booked");
  if (was !== now) {
    if (now === "cancelled") return "booking.cancelled";
    if (now === "completed") return "booking.completed";
    if (now === "no_show") return "booking.no_show";
  }
  if (moved(before, after)) return "booking.rescheduled";
  return "booking.updated";
}

const OBJECT_TYPE: Record<string, string> = {
  calendar_items: "booking",
  people: "client",
  passes: "pass",
  pass_allocations: "pass",
  pass_redemptions: "pass",
  billing_invoices: "invoice",
};

/** Which object an event is about. A spend or a top-up is news about its pass. */
export function objectIdFor(change: Pick<CollapsedChange, "table" | "rowId" | "before" | "after">) {
  if (change.table === "pass_allocations" || change.table === "pass_redemptions") {
    return String((change.after || change.before)?.pass_id || "");
  }
  return change.rowId;
}

/**
 * The event body for one change. Bookings and clients are rendered from the
 * row the trigger saw. Passes and invoices are read as they are now: a pass's
 * balance lives in a view over three tables, and an invoice's lines are
 * written just after the invoice itself, so neither is whole in one row.
 */
async function eventData(change: CollapsedChange, catalog: Catalog): Promise<Record<string, unknown> | null> {
  if (change.table === "calendar_items" || change.table === "people") {
    const render = (row: any, deleted = false) =>
      change.table === "people" ? clientFromRow(row, { deleted }) : bookingFromRow(row, catalog, { deleted });
    const object = change.after ? render(change.after) : render(change.before, true);
    const data: Record<string, unknown> = { object };
    if (change.before && change.after) {
      const previous = previousAttributes(render(change.before), object);
      if (Object.keys(previous).length) data.previous_attributes = previous;
    }
    return data;
  }
  if (OBJECT_TYPE[change.table] === "pass") {
    const passId = objectIdFor(change);
    const object = await readPassObject(change.accountId, passId);
    const data: Record<string, unknown> = { object: object || { id: passId, object: "pass", deleted: true } };
    if (change.table === "pass_redemptions") {
      const redemption = change.after || change.before;
      data.redemption = {
        id: String(redemption.id),
        credits: Number(redemption.credits) || 0,
        booking_id: redemption.booking_id || null,
        note: String(redemption.note || ""),
        reversed_at: redemption.reversed_at || null,
      };
    }
    return data;
  }
  if (change.table === "billing_invoices") {
    if (!change.after) return { object: { ...invoiceObject(change.before, null), deleted: true } };
    const object = (await readInvoiceObject(change.accountId, change.rowId)) || invoiceObject(change.after, null);
    const data: Record<string, unknown> = { object };
    if (change.before) {
      const previous = previousAttributes(invoiceObject(change.before, null), invoiceObject(change.after, null));
      if (Object.keys(previous).length) data.previous_attributes = previous;
    }
    return data;
  }
  return null;
}

/** The event body, as stored and as delivered. */
export function eventEnvelope(event: {
  id: string;
  type: string;
  accountId: string;
  livemode: boolean;
  createdAt: string;
  data: unknown;
}) {
  return {
    id: event.id,
    object: "event",
    type: event.type,
    api_version: API_VERSION,
    account_id: event.accountId,
    livemode: event.livemode,
    created_at: event.createdAt,
    data: event.data,
  };
}

async function livemodeFor(accountIds: string[]) {
  if (!accountIds.length) return new Map<string, boolean>();
  const rows = await db().sql`SELECT id, kind FROM accounts WHERE id = ANY(${accountIds})`;
  return new Map<string, boolean>(rows.map((row: any) => [String(row.id), row.kind !== "sandbox"] as [string, boolean]));
}

/**
 * Turn waiting change-log rows into events and queue their deliveries.
 *
 * One transaction per batch: the rows are locked (SKIP LOCKED, so two workers
 * never take the same ones), converted, and marked processed together. A crash
 * half way leaves them unprocessed for the next run rather than lost.
 */
export async function processChangeLog(options: { batchSize?: number; maxBatches?: number } = {}) {
  const batchSize = options.batchSize || 500;
  let processed = 0;
  let emitted = 0;
  for (let batch = 0; batch < (options.maxBatches || 5); batch += 1) {
    const client = await db().pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT id, account_id, table_name, op, row_id, old_row, new_row, changed_at
         FROM api_change_log
         WHERE processed_at IS NULL
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [batchSize],
      );
      if (!rows.length) {
        await client.query("COMMIT");
        break;
      }
      const changes = collapseChanges(rows as ChangeRow[]);
      const accountIds = [...new Set(changes.map((change) => change.accountId))];
      const livemode = await livemodeFor(accountIds);
      const catalogs = new Map<string, Catalog>();
      for (const accountId of accountIds) {
        catalogs.set(accountId, await loadCatalog(accountId, livemode.get(accountId) ?? true));
      }
      // A new pass arrives as its row and its first credits together. That is
      // one pass.created, not a created and an updated.
      const newPasses = new Set(
        changes.filter((change) => change.table === "passes" && !change.before).map((change) => change.rowId),
      );
      for (const change of changes) {
        const type = eventTypeFor(change);
        const catalog = catalogs.get(change.accountId);
        if (!type || !catalog) continue;
        if (change.table === "pass_allocations" && !change.before && newPasses.has(objectIdFor(change))) continue;
        const data = await eventData(change, catalog);
        if (!data) continue;
        const eventId = newId("evt");
        await client.query(
          `INSERT INTO api_events (id, account_id, type, object_type, object_id, data, source, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, '', $7)`,
          [
            eventId,
            change.accountId,
            type,
            OBJECT_TYPE[change.table] || change.table,
            objectIdFor(change),
            JSON.stringify(data),
            change.at,
          ],
        );
        // Fan out to every live endpoint subscribed to this type (or to all).
        await client.query(
          `INSERT INTO api_webhook_deliveries (id, account_id, endpoint_id, event_id)
           SELECT 'dlv_' || replace(gen_random_uuid()::text, '-', ''), account_id, id, $2
           FROM api_webhook_endpoints
           WHERE account_id = $1 AND enabled AND ('*' = ANY(events) OR $3 = ANY(events))
           ON CONFLICT (endpoint_id, event_id) DO NOTHING`,
          [change.accountId, eventId, type],
        );
        emitted += 1;
      }
      await client.query(
        `UPDATE api_change_log SET processed_at = NOW() WHERE id = ANY($1::bigint[])`,
        [rows.map((row: any) => row.id)],
      );
      await client.query("COMMIT");
      processed += rows.length;
      if (rows.length < batchSize) break;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  return { processed, emitted };
}

// ---------------------------------------------------------------------------
// 2. Deliveries
// ---------------------------------------------------------------------------

export type SendResult = { ok: boolean; status: number; error: string; excerpt: string; durationMs: number };

/** Loopback, private, link-local, CGNAT, multicast and reserved ranges, v4 and v6. Pure; exported for tests. */
export function isPrivateAddress(address: string) {
  const ip = address.toLowerCase().replace(/^::ffff:/, "");
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  return ip === "::" || ip === "::1" || /^(fc|fd|fe[89ab])/.test(ip);
}

/**
 * The URL check at save time reads the hostname as written. This one asks
 * what it actually resolves to, so a public-looking name pointing at an
 * internal address is still refused.
 */
async function assertPublicHost(url: string) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("The URL points at a private or internal address.");
  }
}

/** One signed POST. Never throws: a timeout or refused connection is a result. */
export async function postSigned(
  url: string,
  secret: string,
  body: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    if (fetchImpl === fetch) await assertPublicHost(url);
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Clarity-Webhooks/1.0",
        [SIGNATURE_HEADER]: signResourceWebhook(secret, body, Math.floor(Date.now() / 1000)),
        ...headers,
      },
      body,
      signal: controller.signal,
      redirect: "error",
    });
    const excerpt = (await response.text().catch(() => "")).slice(0, 500);
    const ok = response.status >= 200 && response.status < 300;
    return { ok, status: response.status, error: ok ? "" : `HTTP ${response.status}`, excerpt, durationMs: Date.now() - startedAt };
  } catch (error: any) {
    const timedOut = error?.name === "AbortError";
    return {
      ok: false,
      status: 0,
      error: timedOut ? `No answer within ${WEBHOOK_TIMEOUT_MS / 1000} seconds` : String(error?.message || "Network error").slice(0, 200),
      excerpt: "",
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** When to try again after `attempts` failures, or null when it is over. Pure; exported for tests. */
export function nextAttemptAt(attempts: number, now = Date.now()): Date | null {
  const minutes = RETRY_SCHEDULE_MINUTES[attempts - 1];
  return minutes === undefined ? null : new Date(now + minutes * 60_000);
}

function openSecret(sealed: string) {
  return openCredential(JSON.parse(sealed));
}

/**
 * Send what is due, until the budget runs out.
 *
 * Claimed with SKIP LOCKED and a two-minute lease, so an overlapping run skips
 * rows another is sending, and a run that dies mid-send hands its rows back
 * when the lease lapses.
 */
export async function deliverDueWebhooks(options: { budgetMs?: number; concurrency?: number; fetchImpl?: typeof fetch } = {}) {
  const deadline = Date.now() + (options.budgetMs ?? 20_000);
  const concurrency = options.concurrency ?? 6;
  let sent = 0;
  let failed = 0;
  while (Date.now() < deadline - WEBHOOK_TIMEOUT_MS) {
    const claimed = await db().sql`
      UPDATE api_webhook_deliveries
      SET status = 'processing', claim_expires_at = NOW() + INTERVAL '2 minutes'
      WHERE id IN (
        SELECT id FROM api_webhook_deliveries
        WHERE (status = 'pending' AND next_attempt_at <= NOW())
           OR (status = 'processing' AND claim_expires_at < NOW())
        ORDER BY next_attempt_at
        LIMIT ${concurrency}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, account_id, endpoint_id, event_id, attempt_count
    `;
    if (!claimed.length) break;
    const results: boolean[] = await Promise.all(claimed.map((row: any) => attemptDelivery(row, options.fetchImpl)));
    sent += results.filter(Boolean).length;
    failed += results.filter((ok) => !ok).length;
  }
  return { sent, failed };
}

async function attemptDelivery(row: any, fetchImpl?: typeof fetch): Promise<boolean> {
  const [endpoint] = await db().sql`
    SELECT id, url, secret_sealed, enabled, last_success_at, created_at
    FROM api_webhook_endpoints WHERE id = ${row.endpoint_id}
  `;
  const [event] = await db().sql`
    SELECT api_events.id, api_events.type, api_events.account_id, api_events.data, api_events.created_at,
           accounts.kind
    FROM api_events LEFT JOIN accounts ON accounts.id = api_events.account_id
    WHERE api_events.id = ${row.event_id}
  `;
  if (!endpoint || !event || !endpoint.enabled) {
    await db().sql`
      UPDATE api_webhook_deliveries
      SET status = 'failed', last_error = 'The endpoint was disabled or removed before this could be sent.'
      WHERE id = ${row.id}
    `;
    return false;
  }
  const body = JSON.stringify(
    eventEnvelope({
      id: event.id,
      type: event.type,
      accountId: event.account_id,
      livemode: event.kind !== "sandbox",
      createdAt: new Date(event.created_at).toISOString(),
      data: event.data,
    }),
  );
  let result: SendResult;
  try {
    result = await postSigned(endpoint.url, openSecret(endpoint.secret_sealed), body, {
      [EVENT_HEADER]: event.type,
      [EVENT_ID_HEADER]: event.id,
      [DELIVERY_HEADER]: row.id,
    }, fetchImpl);
  } catch (error: any) {
    // Only reachable if the secret cannot be opened (encryption key gone).
    result = { ok: false, status: 0, error: String(error?.message || error).slice(0, 200), excerpt: "", durationMs: 0 };
  }
  const attempts = Number(row.attempt_count || 0) + 1;
  if (result.ok) {
    await db().sql`
      UPDATE api_webhook_deliveries
      SET status = 'succeeded', attempt_count = ${attempts}, last_status_code = ${result.status},
          last_error = '', last_response_excerpt = ${result.excerpt}, last_attempt_at = NOW(),
          claim_expires_at = NULL
      WHERE id = ${row.id}
    `;
    await db().sql`
      UPDATE api_webhook_endpoints
      SET consecutive_failures = 0, last_success_at = NOW()
      WHERE id = ${endpoint.id}
    `;
    return true;
  }
  const retryAt = nextAttemptAt(attempts);
  await db().sql`
    UPDATE api_webhook_deliveries
    SET status = ${retryAt ? "pending" : "failed"}, attempt_count = ${attempts},
        next_attempt_at = ${(retryAt || new Date()).toISOString()},
        last_status_code = ${result.status || null}, last_error = ${result.error},
        last_response_excerpt = ${result.excerpt}, last_attempt_at = NOW(), claim_expires_at = NULL
    WHERE id = ${row.id}
  `;
  const failingSince = new Date(endpoint.last_success_at || endpoint.created_at).getTime();
  const giveUp = Date.now() - failingSince > DISABLE_AFTER_MS;
  await db().sql`
    UPDATE api_webhook_endpoints
    SET consecutive_failures = consecutive_failures + 1,
        last_failure_at = NOW(),
        enabled = CASE WHEN ${giveUp}::boolean THEN false ELSE enabled END,
        disabled_reason = CASE WHEN ${giveUp}::boolean
          THEN 'Switched off after 3 days of failed deliveries. Fix the URL, then turn it back on.'
          ELSE disabled_reason END,
        updated_at = NOW()
    WHERE id = ${endpoint.id}
  `;
  return false;
}

/** Events older than Stripe's 30-day window, and change rows already turned into events. */
export async function pruneEvents() {
  await db().sql`DELETE FROM api_change_log WHERE processed_at < NOW() - INTERVAL '3 days'`;
  await db().sql`DELETE FROM api_events WHERE created_at < NOW() - INTERVAL '30 days'`;
  await pruneApiWorkingTables();
}

// ---------------------------------------------------------------------------
// 3. Endpoints: what the settings screen and the API's REST hooks manage
// ---------------------------------------------------------------------------

export function cleanEventList(value: unknown): string[] {
  const list = Array.isArray(value) ? value.map((entry) => String(entry).trim()) : [];
  if (!list.length || list.includes("*")) return ["*"];
  return EVENT_TYPES.filter((type) => list.includes(type));
}

export function endpointObject(row: any) {
  const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
  return {
    id: String(row.id),
    object: "webhook_endpoint",
    url: String(row.url),
    description: String(row.description || ""),
    events: Array.isArray(row.events) ? row.events.map(String) : ["*"],
    enabled: row.enabled === true,
    disabled_reason: String(row.disabled_reason || "") || null,
    created_at: iso(row.created_at),
    last_success_at: iso(row.last_success_at),
    last_failure_at: iso(row.last_failure_at),
  };
}

const ENDPOINT_COLUMNS = `id, url, description, events, enabled, disabled_reason, created_at, last_success_at, last_failure_at`;

export async function listEndpoints(accountId: string) {
  const { rows } = await db().pool.query(
    `SELECT ${ENDPOINT_COLUMNS} FROM api_webhook_endpoints WHERE account_id = $1 ORDER BY created_at DESC`,
    [accountId],
  );
  return rows.map(endpointObject);
}

export async function readEndpoint(accountId: string, endpointId: string) {
  const { rows } = await db().pool.query(
    `SELECT ${ENDPOINT_COLUMNS} FROM api_webhook_endpoints WHERE account_id = $1 AND id = $2`,
    [accountId, endpointId],
  );
  return rows[0] ? endpointObject(rows[0]) : null;
}

export class EndpointInputError extends Error {
  param: string;
  constructor(message: string, param: string) {
    super(message);
    this.param = param;
  }
}

const MAX_ENDPOINTS = 20;

/** Makes an endpoint. `secret` is returned once, here, and never again. */
export async function createEndpoint(input: {
  accountId: string;
  url: unknown;
  events?: unknown;
  description?: unknown;
  createdBy: string;
  createdByKeyId?: string | null;
}) {
  const url = cleanResourceWebhookUrl(input.url);
  if (!url) throw new EndpointInputError("The URL must be a public https:// address.", "url");
  const [{ count }] = await db().sql`SELECT COUNT(*)::int AS count FROM api_webhook_endpoints WHERE account_id = ${input.accountId}`;
  if (Number(count) >= MAX_ENDPOINTS) {
    throw new EndpointInputError(`A business can have at most ${MAX_ENDPOINTS} webhook endpoints.`, "url");
  }
  const secret = generateSigningSecret();
  const id = newId("we");
  await db().sql`
    INSERT INTO api_webhook_endpoints (id, account_id, url, description, events, secret_sealed, created_by, created_by_key_id)
    VALUES (
      ${id}, ${input.accountId}, ${url}, ${String(input.description ?? "").trim().slice(0, 200)},
      ${cleanEventList(input.events)}, ${JSON.stringify(sealCredential(secret))},
      ${input.createdBy.slice(0, 180)}, ${input.createdByKeyId || null}
    )
  `;
  return { endpoint: (await readEndpoint(input.accountId, id))!, secret };
}

export async function updateEndpoint(
  accountId: string,
  endpointId: string,
  patch: { url?: unknown; events?: unknown; description?: unknown; enabled?: unknown },
) {
  const existing = await readEndpoint(accountId, endpointId);
  if (!existing) return null;
  const url = patch.url === undefined ? existing.url : cleanResourceWebhookUrl(patch.url);
  if (!url) throw new EndpointInputError("The URL must be a public https:// address.", "url");
  const events = patch.events === undefined ? existing.events : cleanEventList(patch.events);
  const description = patch.description === undefined ? existing.description : String(patch.description ?? "").trim().slice(0, 200);
  const enabled = patch.enabled === undefined ? existing.enabled : patch.enabled === true;
  await db().sql`
    UPDATE api_webhook_endpoints
    SET url = ${url}, events = ${events}, description = ${description}, enabled = ${enabled},
        -- Turning it back on is the owner saying it is fixed: start counting afresh.
        disabled_reason = CASE WHEN ${enabled}::boolean THEN '' ELSE disabled_reason END,
        consecutive_failures = CASE WHEN ${enabled}::boolean AND NOT enabled THEN 0 ELSE consecutive_failures END,
        last_success_at = CASE WHEN ${enabled}::boolean AND NOT enabled THEN NOW() ELSE last_success_at END,
        updated_at = NOW()
    WHERE id = ${endpointId} AND account_id = ${accountId}
  `;
  return readEndpoint(accountId, endpointId);
}

export async function deleteEndpoint(accountId: string, endpointId: string) {
  const rows = await db().sql`
    DELETE FROM api_webhook_endpoints WHERE id = ${endpointId} AND account_id = ${accountId} RETURNING id
  `;
  return rows.length > 0;
}

export async function rollEndpointSecret(accountId: string, endpointId: string) {
  const secret = generateSigningSecret();
  const rows = await db().sql`
    UPDATE api_webhook_endpoints
    SET secret_sealed = ${JSON.stringify(sealCredential(secret))}, updated_at = NOW()
    WHERE id = ${endpointId} AND account_id = ${accountId}
    RETURNING id
  `;
  return rows.length ? secret : null;
}

/** Reveal the signing secret to the business that owns it (settings screen only). */
export async function revealEndpointSecret(accountId: string, endpointId: string) {
  const [row] = await db().sql`
    SELECT secret_sealed FROM api_webhook_endpoints WHERE id = ${endpointId} AND account_id = ${accountId}
  `;
  return row ? openSecret(row.secret_sealed) : null;
}

export async function listDeliveries(accountId: string, endpointId: string, limit = 50) {
  const rows = await db().sql`
    SELECT d.id, d.status, d.attempt_count, d.next_attempt_at, d.last_status_code, d.last_error,
           d.last_response_excerpt, d.last_attempt_at, d.created_at, e.id AS event_id, e.type
    FROM api_webhook_deliveries d
    JOIN api_events e ON e.id = d.event_id
    WHERE d.account_id = ${accountId} AND d.endpoint_id = ${endpointId}
    ORDER BY d.created_at DESC
    LIMIT ${Math.min(Math.max(limit, 1), 100)}
  `;
  const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
  return rows.map((row: any) => ({
    id: String(row.id),
    event_id: String(row.event_id),
    event_type: String(row.type),
    status: String(row.status),
    attempts: Number(row.attempt_count || 0),
    next_attempt_at: row.status === "pending" ? iso(row.next_attempt_at) : null,
    last_status_code: row.last_status_code ?? null,
    last_error: String(row.last_error || "") || null,
    last_response: String(row.last_response_excerpt || "") || null,
    last_attempt_at: iso(row.last_attempt_at),
    created_at: iso(row.created_at),
  }));
}

/** Send a delivery again now, whatever state it is in. */
export async function retryDelivery(accountId: string, deliveryId: string) {
  const rows = await db().sql`
    UPDATE api_webhook_deliveries
    SET status = 'pending', next_attempt_at = NOW(), claim_expires_at = NULL
    WHERE id = ${deliveryId} AND account_id = ${accountId}
    RETURNING id
  `;
  return rows.length > 0;
}

/**
 * A `ping` sent straight away, so setting an endpoint up ends with a green
 * tick instead of waiting for somebody to book. Not stored as an event.
 */
export async function sendTestEvent(accountId: string, endpointId: string, fetchImpl?: typeof fetch) {
  const [row] = await db().sql`
    SELECT e.url, e.secret_sealed, a.kind
    FROM api_webhook_endpoints e LEFT JOIN accounts a ON a.id = e.account_id
    WHERE e.id = ${endpointId} AND e.account_id = ${accountId}
  `;
  if (!row) return null;
  const id = newId("evt_test");
  const body = JSON.stringify(
    eventEnvelope({
      id,
      type: "ping",
      accountId,
      livemode: row.kind !== "sandbox",
      createdAt: new Date().toISOString(),
      data: { object: { message: "This is a test event from Clarity. Reply 2xx to confirm it arrived." } },
    }),
  );
  return postSigned(row.url, openSecret(row.secret_sealed), body, {
    [EVENT_HEADER]: "ping",
    [EVENT_ID_HEADER]: id,
    [DELIVERY_HEADER]: newId("dlv_test"),
  }, fetchImpl);
}
