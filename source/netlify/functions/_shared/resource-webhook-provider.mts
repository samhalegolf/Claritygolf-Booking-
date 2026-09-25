/**
 * The generic webhook provider: hold, move and release a business's bays in
 * whatever system keeps them, by the contract in resource-webhook.mts.
 *
 * Which lessons it acts for is set in Clarity, not in the other system: a
 * lesson type that needs a resource, at a physical location whose resources
 * are kept by "another booking system" (Settings › Locations). Everything else
 * is a no-op, so a business that has not set this up is untouched.
 *
 * Writes to the same ledger table as the Optix provider (optix_booking_sync,
 * provider = 'webhook'), so the calendar's bay outline, the queue and the
 * sweep all work the same way. The column names are Optix's for now; the
 * reference their system gives back lives in optix_booking_id.
 */
import { getDatabase } from "@netlify/database";

import { handednessFromNote } from "./handedness.mts";
import { ensureOptixSyncTable } from "./optix-book-resource.mts";
import { datePartsForSlot, wallClockToUnixSeconds } from "./optix-reconcile.mts";
import { readStoredCredentials } from "./integration-credentials.mts";
import { cleanLocationKind, cleanResourceSource } from "./resources.mts";
import {
  cleanResourceWebhookUrl,
  sendResourceWebhook,
  type ResourceWebhookEvent,
  type ResourceWebhookPayload,
} from "./resource-webhook.mts";

export const RESOURCE_WEBHOOK_SETTINGS_KEY = "resourceWebhookJson";
export const RESOURCE_WEBHOOK_INTEGRATION_ID = "resource-webhook";
export const RESOURCE_WEBHOOK_SECRET_FIELD = "signingSecret";

function db() {
  return getDatabase();
}

export type ResourceWebhookConfig = { url: string; enabled: boolean; secret: string };

/** The URL and on/off switch, without the secret. One settings read. */
export async function readResourceWebhookSettings(accountId: string): Promise<{ url: string; enabled: boolean }> {
  const rows = await db().sql`
    SELECT value FROM settings WHERE account_id = ${accountId} AND key = ${RESOURCE_WEBHOOK_SETTINGS_KEY} LIMIT 1
  `;
  let stored: any = {};
  try {
    stored = JSON.parse(rows[0]?.value || "{}") || {};
  } catch {
    stored = {};
  }
  return { url: cleanResourceWebhookUrl(stored.url), enabled: stored.enabled === true };
}

export async function readResourceWebhookConfig(accountId: string): Promise<ResourceWebhookConfig> {
  const settings = await readResourceWebhookSettings(accountId);
  // The secret only matters once there is somewhere to send to.
  if (!settings.enabled || !settings.url) return { ...settings, secret: "" };
  const secrets = await readStoredCredentials(accountId, RESOURCE_WEBHOOK_INTEGRATION_ID);
  return { ...settings, secret: String(secrets[RESOURCE_WEBHOOK_SECRET_FIELD] || "") };
}

function configured(config: ResourceWebhookConfig) {
  return config.enabled && Boolean(config.url) && Boolean(config.secret);
}

// ---------------------------------------------------------------------------
// What the lesson is, in the contract's words
// ---------------------------------------------------------------------------

type Lesson = {
  id: string;
  accountId: string;
  week: number;
  day: number;
  start: number;
  duration: number;
  status: string;
  serviceId: string;
  locationId: string;
  coachId: string;
  client: string;
  email: string;
  phone: string;
  note: string;
  locationTimezone: string;
};

async function readLesson(accountId: string, calendarItemId: string): Promise<Lesson | null> {
  const rows = await db().sql`
    SELECT id, account_id, week, day, start, duration, status, service_id, location_id,
           coach_id, client, email, phone, note, location
    FROM calendar_items
    WHERE id = ${calendarItemId} AND account_id = ${accountId} AND kind = 'appointment'
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  let location: any = row.location;
  if (typeof location === "string") {
    try {
      location = JSON.parse(location);
    } catch {
      location = null;
    }
  }
  return {
    id: String(row.id),
    accountId: String(row.account_id || ""),
    week: Number(row.week || 0),
    day: Number(row.day || 0),
    start: Number(row.start || 0),
    duration: Number(row.duration || 0),
    status: String(row.status || "booked"),
    serviceId: String(row.service_id || ""),
    locationId: String(row.location_id || location?.locationId || ""),
    coachId: String(row.coach_id || ""),
    client: String(row.client || ""),
    email: String(row.email || ""),
    phone: String(row.phone || ""),
    note: String(row.note || ""),
    locationTimezone: String(location?.timezone || ""),
  };
}

type Business = {
  name: string;
  timezone: string;
  services: any[];
  locations: any[];
  coaches: any[];
};

async function readBusiness(accountId: string): Promise<Business> {
  const rows = await db().sql`
    SELECT key, value FROM settings
    WHERE account_id = ${accountId}
      AND key IN ('servicesJson', 'locationsJson', 'coachProfilesJson', 'accountBusinessName', 'accountTimezone')
  `;
  const byKey = new Map(rows.map((row: any) => [String(row.key), String(row.value ?? "")]));
  const list = (key: string) => {
    try {
      const parsed = JSON.parse(byKey.get(key) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  return {
    name: byKey.get("accountBusinessName") || "",
    timezone: byKey.get("accountTimezone") || "",
    services: list("servicesJson"),
    locations: list("locationsJson"),
    coaches: list("coachProfilesJson"),
  };
}

function lessonLocation(lesson: Lesson, service: any, business: Business) {
  const id = lesson.locationId || service?.locationId || "";
  return (
    business.locations.find((location) => location?.id === id) ||
    business.locations.find((location) => location?.isDefault) ||
    business.locations[0] ||
    null
  );
}

/** A lesson this provider holds for: needs a resource, at a place whose resources another system keeps. */
function appliesTo(lesson: Lesson, business: Business) {
  const service = business.services.find((entry) => entry?.id === lesson.serviceId);
  if (service?.needsResource !== true) return false;
  const location = lessonLocation(lesson, service, business);
  return (
    Boolean(location) &&
    cleanLocationKind(location.kind) === "physical" &&
    cleanResourceSource(location.resourceSource) === "external"
  );
}

/** A slot as unix seconds and as ISO 8601 with the location's offset. Exported for tests. */
export function slotWallClock(week: number, day: number, minutes: number, timeZone: string) {
  const date = datePartsForSlot(week, day);
  const unix = wallClockToUnixSeconds({ ...date, minutes, timeZone });
  // The offset is whatever separates the wall clock from UTC at that moment.
  const wallAsUtc = Date.UTC(date.year, date.month - 1, date.day, 0, minutes) / 1000;
  const offsetMinutes = Math.round((wallAsUtc - unix) / 60);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return { unix, iso: `${new Date(wallAsUtc * 1000).toISOString().slice(0, 19)}${offset}` };
}

function isoFromUnix(unix: number, timeZone: string) {
  if (!unix) return "";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(unix * 1000))
      .map((part) => [part.type, part.value]),
  );
  const wallAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) / 1000;
  const offsetMinutes = Math.round((wallAsUtc - unix) / 60);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${String(
    Math.floor(abs / 60),
  ).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

function buildPayload(
  event: ResourceWebhookEvent,
  accountId: string,
  lesson: Lesson,
  business: Business,
  existing: LedgerRow | null,
) {
  const service = business.services.find((entry) => entry?.id === lesson.serviceId);
  const location = lessonLocation(lesson, service, business);
  const coach = business.coaches.find((entry) => entry?.id === lesson.coachId);
  const timeZone = lesson.locationTimezone || location?.timezone || business.timezone || "UTC";
  const start = slotWallClock(lesson.week, lesson.day, lesson.start, timeZone);
  const end = slotWallClock(lesson.week, lesson.day, lesson.start + lesson.duration, timeZone);
  const payload: ResourceWebhookPayload = {
    event,
    id: `dlv_${crypto.randomUUID()}`,
    sentAt: new Date().toISOString(),
    account: { id: accountId, name: business.name },
    booking: {
      id: lesson.id,
      status: lesson.status,
      start: start.iso,
      end: end.iso,
      timezone: timeZone,
      durationMinutes: lesson.duration,
      service: { id: lesson.serviceId, name: String(service?.name || "") },
      coach: { id: lesson.coachId, name: String(coach?.displayName || coach?.name || "") },
      location: { id: String(location?.id || ""), name: String(location?.name || "") },
      client: { name: lesson.client, email: lesson.email, phone: lesson.phone },
      handedness: handednessFromNote(lesson.note),
      notes: lesson.note.slice(0, 800),
    },
    hold:
      existing?.reference && event !== "resource.hold"
        ? { reference: existing.reference, resource: { id: existing.resourceId, name: existing.resourceName } }
        : null,
    previous:
      event === "resource.move" && existing?.startTimestamp
        ? { start: isoFromUnix(existing.startTimestamp, timeZone), end: isoFromUnix(existing.endTimestamp, timeZone) }
        : null,
  };
  return { payload, startUnix: start.unix, endUnix: end.unix };
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

type LedgerRow = {
  reference: string;
  resourceId: string;
  resourceName: string;
  startTimestamp: number;
  endTimestamp: number;
  status: string;
};

async function readLedger(accountId: string, calendarItemId: string): Promise<LedgerRow | null> {
  const rows = await db().sql`
    SELECT optix_booking_id, resource_id, resource_name, start_timestamp, end_timestamp, sync_status
    FROM optix_booking_sync
    WHERE calendar_item_id = ${calendarItemId}
      AND provider = 'webhook'
      AND (account_id = ${accountId} OR account_id IS NULL)
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    reference: String(row.optix_booking_id || ""),
    resourceId: String(row.resource_id || ""),
    resourceName: String(row.resource_name || ""),
    startTimestamp: Number(row.start_timestamp || 0),
    endTimestamp: Number(row.end_timestamp || 0),
    status: String(row.sync_status || ""),
  };
}

async function writeLedger(
  accountId: string,
  calendarItemId: string,
  entry: {
    reference: string;
    resourceId: string;
    resourceName: string;
    startTimestamp: number;
    endTimestamp: number;
    status: "synced" | "failed" | "cancelled";
    errorCode?: string;
    errorMessage?: string;
  },
) {
  await db().sql`
    INSERT INTO optix_booking_sync (
      calendar_item_id, account_id, provider, optix_booking_id, optix_booking_session_id,
      resource_id, resource_name, start_timestamp, end_timestamp, fingerprint,
      sync_status, error_code, error_message, last_attempted_at, last_synced_at, created_at, updated_at
    ) VALUES (
      ${calendarItemId}, ${accountId}, 'webhook', ${entry.reference}, '',
      ${entry.resourceId}, ${entry.resourceName}, ${entry.startTimestamp}, ${entry.endTimestamp},
      ${`${entry.startTimestamp}-${entry.endTimestamp}`},
      ${entry.status}, ${entry.errorCode || ""}, ${(entry.errorMessage || "").slice(0, 600)},
      NOW(), ${entry.status === "failed" ? null : new Date().toISOString()}, NOW(), NOW()
    )
    ON CONFLICT (calendar_item_id) DO UPDATE SET
      account_id = COALESCE(optix_booking_sync.account_id, EXCLUDED.account_id),
      provider = 'webhook',
      optix_booking_id = EXCLUDED.optix_booking_id,
      resource_id = EXCLUDED.resource_id,
      resource_name = EXCLUDED.resource_name,
      start_timestamp = EXCLUDED.start_timestamp,
      end_timestamp = EXCLUDED.end_timestamp,
      fingerprint = EXCLUDED.fingerprint,
      sync_status = EXCLUDED.sync_status,
      error_code = EXCLUDED.error_code,
      error_message = EXCLUDED.error_message,
      last_attempted_at = NOW(),
      last_synced_at = COALESCE(EXCLUDED.last_synced_at, optix_booking_sync.last_synced_at),
      updated_at = NOW()
  `;
}

// ---------------------------------------------------------------------------
// Provider operations
// ---------------------------------------------------------------------------

export async function webhookHold(accountId: string, calendarItemId: string) {
  await ensureOptixSyncTable();
  const lesson = await readLesson(accountId, calendarItemId);
  if (!lesson) return { ok: false, error: "appointment_not_found", message: "Clarity appointment not found." };
  const existing = await readLedger(accountId, calendarItemId);
  if (existing?.status === "synced" && existing.reference) return { ok: true, alreadyBooked: true, result: existing };
  const config = await readResourceWebhookConfig(accountId);
  if (!configured(config)) {
    return { ok: false, error: "not_configured", message: "Connect your bay system in Settings before holding bays." };
  }
  const business = await readBusiness(accountId);
  const { payload, startUnix, endUnix } = buildPayload("resource.hold", accountId, lesson, business, existing);
  const reply = await sendResourceWebhook({ url: config.url, secret: config.secret, payload });
  const held = reply.ok && reply.status === "held";
  await writeLedger(accountId, calendarItemId, {
    reference: held ? reply.reference : "",
    resourceId: held ? reply.resource.id : "",
    resourceName: held ? reply.resource.name : "",
    startTimestamp: startUnix,
    endTimestamp: endUnix,
    status: held ? "synced" : "failed",
    errorCode: reply.ok ? "" : reply.code,
    errorMessage: reply.ok ? "" : reply.message,
  });
  console.info("resource_webhook_hold", { accountId, calendarItemId, ok: held, ms: reply.durationMs, code: reply.ok ? "" : reply.code });
  return held
    ? { ok: true, attempted: 1, synced: 1, failed: 0 }
    : { ok: false, attempted: 1, synced: 0, failed: 1, error: reply.ok ? "invalid_reply" : reply.code, message: reply.ok ? "" : reply.message };
}

export async function webhookHoldIfAutomatic(accountId: string, calendarItemId: string, _serviceId: string) {
  try {
    // Cheapest check first: most businesses have connected nothing.
    const settings = await readResourceWebhookSettings(accountId);
    if (!settings.enabled || !settings.url) return;
    const lesson = await readLesson(accountId, calendarItemId);
    if (!lesson || !appliesTo(lesson, await readBusiness(accountId))) return;
    await webhookHold(accountId, calendarItemId);
  } catch (error) {
    console.error("resource_webhook_auto_hold_failed", {
      calendarItemId,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error || ""),
    });
  }
}

export async function webhookQueueHold(accountId: string, calendarItemId: string, _serviceId: string) {
  try {
    // Cheapest check first: this runs inside every save that creates a lesson.
    const settings = await readResourceWebhookSettings(accountId);
    if (!settings.enabled || !settings.url) return false;
    const lesson = await readLesson(accountId, calendarItemId);
    if (!lesson || !appliesTo(lesson, await readBusiness(accountId))) return false;
    await ensureOptixSyncTable();
    const rows = await db().sql`
      INSERT INTO optix_booking_sync (
        calendar_item_id, account_id, provider, optix_booking_id, optix_booking_session_id, resource_id,
        start_timestamp, end_timestamp, fingerprint, sync_status, error_code, error_message,
        created_at, updated_at
      ) VALUES (
        ${calendarItemId}, ${accountId}, 'webhook', '', '', '', 0, 0, '', 'pending', 'queued',
        'Waiting for Clarity to hold a bay in the background.', NOW(), NOW()
      )
      ON CONFLICT (calendar_item_id) DO NOTHING
      RETURNING calendar_item_id
    `;
    return rows.length > 0;
  } catch (error) {
    console.error("resource_webhook_queue_failed", {
      calendarItemId,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error || ""),
    });
    return false;
  }
}

export async function webhookMove(accountId: string, calendarItemId: string) {
  try {
    const existing = await readLedger(accountId, calendarItemId);
    if (!existing?.reference || existing.status !== "synced") return { moved: false, skipped: "no_synced_bay" as const };
    const lesson = await readLesson(accountId, calendarItemId);
    const config = await readResourceWebhookConfig(accountId);
    if (!lesson || !configured(config)) return { moved: false, error: "Bay system not connected." };
    const business = await readBusiness(accountId);
    const { payload, startUnix, endUnix } = buildPayload("resource.move", accountId, lesson, business, existing);
    if (startUnix === existing.startTimestamp && endUnix === existing.endTimestamp) {
      return { moved: true, method: "unchanged" as const };
    }
    const reply = await sendResourceWebhook({ url: config.url, secret: config.secret, payload });
    if (reply.ok && reply.status === "held") {
      await writeLedger(accountId, calendarItemId, {
        reference: reply.reference,
        resourceId: reply.resource.id,
        resourceName: reply.resource.name,
        startTimestamp: startUnix,
        endTimestamp: endUnix,
        status: "synced",
      });
      return { moved: true, method: "amended" as const };
    }
    // Could not move. The old reference stays on the row so a later cancel
    // still releases whatever their system kept; the row reads as failed so
    // the lesson no longer shows a bay.
    const message = reply.ok ? "Your system did not confirm the move." : reply.message;
    await writeLedger(accountId, calendarItemId, {
      ...existing,
      status: "failed",
      errorCode: reply.ok ? "invalid_reply" : reply.code,
      errorMessage: message,
    });
    return { moved: false, error: message };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "Move failed.");
    console.error("resource_webhook_move_failed", { calendarItemId, error: message.slice(0, 300) });
    return { moved: false, error: message };
  }
}

export async function webhookRelease(accountId: string, calendarItemId: string) {
  const existing = await readLedger(accountId, calendarItemId);
  if (!existing?.reference) return { ok: true as const, skipped: true, reason: "no_bay_booking" as const };
  if (existing.status === "cancelled") {
    return { ok: true as const, skipped: true, reason: "already_cancelled" as const, optixBookingId: existing.reference };
  }
  const lesson = await readLesson(accountId, calendarItemId);
  const config = await readResourceWebhookConfig(accountId);
  if (!lesson || !configured(config)) {
    throw Object.assign(new Error("The bay could not be released because the bay system is not connected."), {
      code: "not_configured",
    });
  }
  const business = await readBusiness(accountId);
  const { payload } = buildPayload("resource.release", accountId, { ...lesson, status: "cancelled" }, business, existing);
  const reply = await sendResourceWebhook({ url: config.url, secret: config.secret, payload });
  if (reply.ok) {
    await writeLedger(accountId, calendarItemId, { ...existing, status: "cancelled" });
    return { ok: true as const, skipped: false, optixBookingId: existing.reference };
  }
  await writeLedger(accountId, calendarItemId, {
    ...existing,
    status: "failed",
    errorCode: reply.code,
    errorMessage: reply.message,
  });
  throw Object.assign(new Error(`The bay was not released: ${reply.message}`), { code: reply.code });
}

const SWEEP_GRACE_SECONDS = 90;
const SWEEP_CLAIM_SECONDS = 150;
const SWEEP_MAX_ATTEMPTS = 4;

/** Finish queued holds nothing answered. Same shape as the Optix sweep, for provider = 'webhook' rows. */
export async function webhookSweepQueuedHolds(options: { budgetMs?: number; nowMs?: number } = {}) {
  const startedAt = options.nowMs ?? Date.now();
  const budgetMs = options.budgetMs ?? 5_000;
  const outcome = { claimed: 0, synced: 0, failed: 0, settled: 0, items: [] as Array<{ calendarItemId: string; outcome: string }> };
  if (Date.now() - startedAt >= budgetMs) return outcome;
  await ensureOptixSyncTable();
  while (Date.now() - startedAt < budgetMs) {
    const claimed = await db().sql`
      UPDATE optix_booking_sync s
      SET last_attempted_at = NOW(), attempt_count = s.attempt_count + 1, updated_at = NOW()
      WHERE s.calendar_item_id = (
        SELECT calendar_item_id FROM optix_booking_sync
        WHERE sync_status = 'pending' AND provider = 'webhook'
          AND created_at < NOW() - (${SWEEP_GRACE_SECONDS}::int * INTERVAL '1 second')
          AND (last_attempted_at IS NULL
               OR last_attempted_at < NOW() - (${SWEEP_CLAIM_SECONDS}::int * INTERVAL '1 second'))
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING s.calendar_item_id, s.account_id, s.attempt_count
    `;
    if (!claimed[0]) break;
    outcome.claimed += 1;
    const calendarItemId = String(claimed[0].calendar_item_id || "");
    const accountId = String(claimed[0].account_id || "");
    const settle = async (status: string, code: string, message: string, label: string) => {
      await db().sql`
        UPDATE optix_booking_sync
        SET sync_status = ${status}, error_code = ${code}, error_message = ${message}, updated_at = NOW()
        WHERE calendar_item_id = ${calendarItemId} AND sync_status = 'pending'
      `;
      outcome.settled += 1;
      outcome.items.push({ calendarItemId, outcome: label });
    };
    try {
      const lesson = accountId ? await readLesson(accountId, calendarItemId) : null;
      if (!lesson) {
        await settle("cancelled", "lesson_deleted", "The lesson was removed before a bay was held.", "lesson_deleted");
        continue;
      }
      if (["cancelled", "no_show"].includes(lesson.status)) {
        await settle("cancelled", "lesson_inactive", "The lesson was cancelled before a bay was held.", "lesson_inactive");
        continue;
      }
      if (Number(claimed[0].attempt_count || 0) > SWEEP_MAX_ATTEMPTS) {
        await settle(
          "failed",
          "auto_hold_abandoned",
          `Clarity tried ${SWEEP_MAX_ATTEMPTS} times to hold a bay and never got an answer.`,
          "abandoned",
        );
        continue;
      }
      const result = await webhookHold(accountId, calendarItemId);
      if (result.ok) outcome.synced += 1;
      else outcome.failed += 1;
      outcome.items.push({ calendarItemId, outcome: result.ok ? "synced" : "failed" });
    } catch (error) {
      console.error("resource_webhook_sweep_item_failed", {
        calendarItemId,
        error: error instanceof Error ? error.message.slice(0, 300) : String(error || ""),
      });
      outcome.failed += 1;
      outcome.items.push({ calendarItemId, outcome: "exception" });
    }
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Changes their system makes on its own side (inbound)
// ---------------------------------------------------------------------------

/**
 * Apply resource.released or resource.updated from their system. Scoped to the
 * business the signature proved, and to rows this provider wrote.
 */
export async function applyInboundResourceEvent(
  accountId: string,
  event: string,
  body: any,
): Promise<{ ok: boolean; status: number; message: string }> {
  const calendarItemId = String(body?.booking?.id || "").trim().slice(0, 140);
  if (!calendarItemId) return { ok: false, status: 400, message: "booking.id is required." };
  const existing = await readLedger(accountId, calendarItemId);
  if (!existing) return { ok: false, status: 404, message: "No bay hold for that booking." };
  if (event === "resource.released") {
    await writeLedger(accountId, calendarItemId, {
      ...existing,
      status: "cancelled",
      errorCode: "released_by_provider",
      errorMessage: String(body?.message || "Released in your bay system.").slice(0, 300),
    });
    return { ok: true, status: 200, message: "released" };
  }
  if (event === "resource.updated") {
    const reference = String(body?.hold?.reference || existing.reference).trim().slice(0, 160);
    const resourceId = String(body?.hold?.resource?.id ?? existing.resourceId).trim().slice(0, 120);
    const resourceName = String(body?.hold?.resource?.name ?? existing.resourceName).trim().slice(0, 120) || resourceId;
    await writeLedger(accountId, calendarItemId, {
      ...existing,
      reference,
      resourceId,
      resourceName,
      status: "synced",
    });
    return { ok: true, status: 200, message: "updated" };
  }
  return { ok: false, status: 400, message: `Unknown event "${event}".` };
}
