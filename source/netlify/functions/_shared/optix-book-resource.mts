import { getDatabase } from "@netlify/database";

import {
  type ClarityOptixAppointment,
  type OptixSyncRecord,
} from "./optix-reconcile.mts";
import {
  moveOptixBookingInPlace,
  reconcileOptixAppointmentWithAutoSelect,
} from "./optix-auto-select.mts";
import { cancelOptixBayForCalendarItem } from "./optix-cancel.mts";
import { optixConfigForAccount } from "./optix-credentials.mts";
import { notifyBookingEvent } from "../notification-engine.mts";

const OVERALL_TIMEOUT_MS = 25_000;

function db() {
  return getDatabase();
}

async function ensureOptixSyncTable() {
  await db().sql`
    CREATE TABLE IF NOT EXISTS optix_booking_sync (
      calendar_item_id TEXT PRIMARY KEY,
      optix_booking_id TEXT,
      optix_booking_session_id TEXT,
      resource_id TEXT,
      start_timestamp BIGINT,
      end_timestamp BIGINT,
      fingerprint TEXT,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      error_code TEXT,
      error_message TEXT,
      last_attempted_at TIMESTAMPTZ,
      last_synced_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  // How many times the background sweep has picked this row up. Added by the
  // 20260924000100 migration; repeated here so an environment whose migrations
  // have not run still has the column the sweep relies on.
  await db().sql`
    ALTER TABLE optix_booking_sync
      ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0
  `;
}

/**
 * Append-only history of bay bookings this lesson used to hold. See the
 * migration 20260826000200_create_optix_bay_bookings for why it exists;
 * created here too so the rebook path works on an environment whose
 * migrations have not run, matching ensureOptixSyncTable above.
 */
async function ensureOptixBayHistoryTable() {
  await db().sql`
    CREATE TABLE IF NOT EXISTS optix_bay_bookings (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      calendar_item_id TEXT NOT NULL,
      optix_booking_id TEXT NOT NULL DEFAULT '',
      optix_booking_session_id TEXT NOT NULL DEFAULT '',
      resource_id TEXT NOT NULL DEFAULT '',
      start_timestamp BIGINT NOT NULL DEFAULT 0,
      end_timestamp BIGINT NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT 'reschedule',
      cancelled BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

/**
 * Record a bay booking that is about to stop being this lesson's bay.
 *
 * Called immediately before the sync row's Optix IDs are cleared, because
 * after that UPDATE there is nothing left to record. Never throws: losing the
 * audit row must not abort a rebook that is already half done (the Optix
 * booking has been cancelled by this point).
 */
async function recordSupersededBayBooking(
  record: OptixSyncRecord,
  options: { reason: "reschedule" | "reschedule_failed"; cancelled: boolean },
) {
  try {
    await ensureOptixBayHistoryTable();
    await db().sql`
      INSERT INTO optix_bay_bookings (
        calendar_item_id, optix_booking_id, optix_booking_session_id,
        resource_id, start_timestamp, end_timestamp, reason, cancelled
      ) VALUES (
        ${record.calendarItemId}, ${record.optixBookingId},
        ${record.optixBookingSessionId}, ${record.resourceId},
        ${record.startTimestamp}, ${record.endTimestamp},
        ${options.reason}, ${options.cancelled}
      )
    `;
  } catch (error) {
    console.error("optix_bay_history_write_failed", {
      calendarItemId: record.calendarItemId,
      optixBookingId: record.optixBookingId,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error || "").slice(0, 300),
    });
  }
}

function rowToAppointment(row: any): ClarityOptixAppointment {
  return {
    id: String(row.id || ""),
    accountId: String(row.account_id || ""),
    kind: row.kind || "",
    week: Number(row.week || 0),
    day: Number(row.day || 0),
    start: Number(row.start || 0),
    duration: Number(row.duration || 0),
    title: row.title || "",
    client: row.client || "",
    note: row.note || "",
    serviceId: row.service_id || "",
    locationId: row.location_id || "",
    location: row.location && typeof row.location === "object" ? row.location : null,
    status: row.status || "booked",
    email: row.email || "",
    phone: row.phone || "",
    coachId: row.coach_id || "",
    personId: row.person_id || "",
  };
}

function rowToSyncRecord(row: any): OptixSyncRecord {
  return {
    calendarItemId: String(row.calendar_item_id || ""),
    optixBookingId: String(row.optix_booking_id || ""),
    optixBookingSessionId: String(row.optix_booking_session_id || ""),
    resourceId: String(row.resource_id || ""),
    startTimestamp: Number(row.start_timestamp || 0),
    endTimestamp: Number(row.end_timestamp || 0),
    fingerprint: String(row.fingerprint || ""),
    // 'pending' is a queued auto-book that no attempt has finished yet (see
    // queueAutoBookResource). It used to be read as 'failed', which would have
    // made reconcile treat a row nothing had tried as a terminal refusal.
    syncStatus: ["synced", "failed", "token_expired", "cancelled", "pending"].includes(row.sync_status)
      ? row.sync_status
      : "failed",
    errorCode: String(row.error_code || ""),
    errorMessage: String(row.error_message || ""),
  } as OptixSyncRecord;
}

// Scoped by account as well as id. Deriving the account from the row it found
// meant a booking id was on its own enough to act on another business's lesson:
// the caller supplied the id, and the row then supplied its own authority.
async function readAppointment(accountId: string, calendarItemId: string) {
  if (!accountId) return null;
  const rows = await db().sql`
    SELECT id, account_id, kind, week, day, start, duration, title, client, note,
           service_id, location_id, location, status, email, phone, coach_id, person_id
    FROM calendar_items
    WHERE id = ${calendarItemId}
      AND account_id = ${accountId}
      AND kind = 'appointment'
    LIMIT 1
  `;
  return rows[0] ? rowToAppointment(rows[0]) : null;
}

async function readSyncRecord(calendarItemId: string) {
  const rows = await db().sql`
    SELECT *
    FROM optix_booking_sync
    WHERE calendar_item_id = ${calendarItemId}
    LIMIT 1
  `;
  return rows[0] ? rowToSyncRecord(rows[0]) : null;
}

// The Optix booking-type mapping is per business: which Optix resource a
// lesson type books, and whether it books automatically. Read without an
// account filter it would return both businesses' rows and pick one.
export async function readBookingTypeConfig(
  accountId: string,
  serviceId: string,
): Promise<Record<string, any> | null> {
  if (!accountId) return null;
  const rows = await db().sql`
    SELECT value
    FROM settings
    WHERE account_id = ${accountId}
      AND key = 'optixBookingTypeConfigJson'
    LIMIT 1
  `;
  try {
    const parsed = JSON.parse(rows[0]?.value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed[serviceId] || null
      : null;
  } catch {
    return null;
  }
}

async function saveSyncRecord(record: OptixSyncRecord) {
  const lastSyncedAt = ["synced", "cancelled"].includes(record.syncStatus)
    ? new Date().toISOString()
    : null;
  await db().sql`
    INSERT INTO optix_booking_sync (
      calendar_item_id, optix_booking_id, optix_booking_session_id,
      resource_id, start_timestamp, end_timestamp, fingerprint,
      sync_status, error_code, error_message, last_attempted_at,
      last_synced_at, created_at, updated_at
    ) VALUES (
      ${record.calendarItemId}, ${record.optixBookingId},
      ${record.optixBookingSessionId}, ${record.resourceId},
      ${record.startTimestamp}, ${record.endTimestamp}, ${record.fingerprint},
      ${record.syncStatus}, ${record.errorCode}, ${record.errorMessage},
      NOW(), ${lastSyncedAt}, NOW(), NOW()
    )
    ON CONFLICT (calendar_item_id) DO UPDATE SET
      optix_booking_id = EXCLUDED.optix_booking_id,
      optix_booking_session_id = EXCLUDED.optix_booking_session_id,
      resource_id = EXCLUDED.resource_id,
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

function timeoutRecord(
  appointment: ClarityOptixAppointment,
  existing: OptixSyncRecord | null,
): OptixSyncRecord {
  return {
    calendarItemId: appointment.id,
    optixBookingId: existing?.optixBookingId || "",
    optixBookingSessionId: existing?.optixBookingSessionId || "",
    resourceId: existing?.resourceId || "",
    startTimestamp: existing?.startTimestamp || 0,
    endTimestamp: existing?.endTimestamp || 0,
    fingerprint: existing?.fingerprint || "manual-timeout",
    syncStatus: "failed",
    errorCode: "timeout",
    errorMessage: "Optix did not finish the resource booking within 25 seconds. Check Optix before pressing Book resource again.",
  };
}

/**
 * Books one Optix resource for a Clarity appointment and records the result in
 * optix_booking_sync. Shared by the admin Book resource button
 * (optix-booking-reconcile.mts) and the per-lesson-type auto-book that runs
 * after a client's public booking lands on the calendar (booking-core.mts).
 * Idempotent: an already-synced booking returns { alreadyBooked: true }.
 */
export async function bookOneResource(accountId: string, calendarItemId: string) {
  await ensureOptixSyncTable();
  const appointment = await readAppointment(accountId, calendarItemId);
  if (!appointment) {
    return { ok: false, error: "appointment_not_found", message: "Clarity appointment not found." };
  }

  const existing = await readSyncRecord(calendarItemId);
  if (existing?.syncStatus === "synced" && existing.optixBookingId) {
    return { ok: true, alreadyBooked: true, result: existing };
  }

  const config = await optixConfigForAccount(accountId);
  const serviceId = String(appointment.serviceId || appointment.service_id || "");
  const bookingType = await readBookingTypeConfig(accountId, serviceId);

  const operation = reconcileOptixAppointmentWithAutoSelect({
    appointment,
    existing,
    config,
    bookingType,
    forceRetry: true,
  });

  let result: OptixSyncRecord;
  try {
    result = await Promise.race([
      operation,
      new Promise<OptixSyncRecord>((resolve) => {
        setTimeout(() => resolve(timeoutRecord(appointment, existing)), OVERALL_TIMEOUT_MS);
      }),
    ]);
  } catch (error: any) {
    result = {
      ...timeoutRecord(appointment, existing),
      errorCode: String(error?.code || "remote_error"),
      errorMessage: error instanceof Error ? error.message : "Optix resource booking failed.",
    };
  }

  await saveSyncRecord(result);
  if (result.syncStatus === "synced") {
    await db().sql`
      UPDATE calendar_items
      SET external_sync_state = 'bay_booked', updated_at = NOW()
      WHERE id = ${appointment.id} AND origin = 'optix'
    `;
    const emailRows = await db().sql`
      SELECT l.external_booking_id, l.email_status, m.email_behaviour
      FROM external_booking_links l
      JOIN external_booking_mappings m
        ON m.provider = l.provider AND m.workspace_id = l.workspace_id
      WHERE l.clarity_item_id = ${appointment.id}
        AND l.provider = 'optix' AND l.purpose = 'lesson'
      LIMIT 1
    `;
    const emailLink = emailRows[0];
    if (emailLink?.email_behaviour === "after_bay" && emailLink?.email_status !== "sent") {
      try {
        await notifyBookingEvent({ action: "booking", appointment, source: `optix-after-bay:${emailLink.external_booking_id}` });
        await db().sql`
          UPDATE external_booking_links
          SET processing_status = 'bay_booked', email_status = 'sent', confirmation_sent_at = NOW(), updated_at = NOW()
          WHERE provider = 'optix' AND purpose = 'lesson' AND external_booking_id = ${emailLink.external_booking_id}
        `;
      } catch (error) {
        await db().sql`
          UPDATE external_booking_links
          SET processing_status = 'bay_booked', email_status = 'failed', updated_at = NOW()
          WHERE provider = 'optix' AND purpose = 'lesson' AND external_booking_id = ${emailLink.external_booking_id}
        `;
        console.error("optix_after_bay_email_failed", { calendarItemId: appointment.id });
      }
    } else {
      await db().sql`
        UPDATE external_booking_links SET processing_status = 'bay_booked', updated_at = NOW()
        WHERE clarity_item_id = ${appointment.id} AND provider = 'optix' AND purpose = 'lesson'
      `;
    }
  }
  return {
    ok: result.syncStatus === "synced",
    attempted: 1,
    synced: result.syncStatus === "synced" ? 1 : 0,
    failed: result.syncStatus === "failed" ? 1 : 0,
    result,
  };
}

export type BayRebookOutcome = {
  moved: boolean;
  /** How the bay got to the new slot, for logs and for the panel's wording. */
  method?: "amended" | "unchanged" | "rebooked";
  skipped?: "no_synced_bay";
  error?: string;
};

/**
 * Move a lesson's bay booking after the lesson itself was rescheduled.
 *
 * Two steps, cheapest first:
 *
 * 1. **Amend in place.** Send Optix the booking it already holds, with the new
 *    times and the same bay. One round trip, the bay is never let go, the
 *    customer keeps the same Optix booking reference, and a refusal changes
 *    nothing — there is no window in which the lesson has no bay.
 * 2. **Cancel and rebook.** Only when Optix refuses the amend, which in
 *    practice means that bay is taken at the new time. Releasing the bay first
 *    lets the rebook re-run auto-select, so the lesson lands in another free
 *    bay instead of failing outright. This is the slower path and the only one
 *    that can change which bay the lesson holds.
 *
 * Never throws — this runs as a deferred side effect after the reschedule
 * response has gone out. If the cancel is refused, the rebook is NOT
 * attempted (rebooking while the old booking stands would hold two bays); the
 * sync row is already marked failed and the Optix panel shows it. If the
 * rebook fails, the bay is released but not re-held — the lesson loses its
 * orange outline and Book resource on the card retries as usual.
 */
export async function rebookResourceAfterReschedule(
  accountId: string,
  calendarItemId: string,
): Promise<BayRebookOutcome> {
  const cleanId = String(calendarItemId || "").trim();
  try {
    await ensureOptixSyncTable();
    const existing = cleanId ? await readSyncRecord(cleanId) : null;
    if (!existing?.optixBookingId || existing.syncStatus !== "synced") {
      console.warn("optix_bay_rebook_after_reschedule_skipped", {
        calendarItemId: cleanId,
        reason: "no_synced_bay",
        syncRecordFound: Boolean(existing),
        syncStatus: existing?.syncStatus || "",
        hasOptixBookingId: Boolean(existing?.optixBookingId),
        resourceId: existing?.resourceId || "",
        errorCode: existing?.errorCode || "",
      });
      return { moved: false, skipped: "no_synced_bay" };
    }
    // Ask Optix to move the booking it already holds before releasing it.
    // An amend is one round trip, keeps the same bay and the same Optix
    // booking reference, and cannot strand the lesson with no bay at all --
    // if Optix refuses, nothing has changed yet. It refuses mainly when that
    // bay is taken at the new time, which is precisely the case where the
    // cancel-and-rebook below earns its two round trips by finding another.
    //
    // Wrapped whole: a failure reading the appointment, the environment or the
    // lesson-type config must degrade to the old behaviour, not replace a
    // working rebook with an exception.
    try {
      const appointment = await readAppointment(accountId, cleanId);
      if (appointment) {
        const moved = await moveOptixBookingInPlace({
          appointment,
          existing,
          config: await optixConfigForAccount(accountId),
          bookingType: await readBookingTypeConfig(
            accountId,
            String(appointment.serviceId || (appointment as any).service_id || ""),
          ),
        });
        if (moved.moved === true) {
          // `unchanged` means the lesson's slot produced the same Optix
          // request it already holds -- a save that touched something other
          // than the time. Nothing to write, nothing to tell Optix.
          if (!moved.unchanged) await saveSyncRecord(moved.record);
          console.info("optix_bay_moved_in_place", {
            calendarItemId: cleanId,
            optixBookingId: moved.record.optixBookingId,
            resourceId: moved.record.resourceId,
            unchanged: moved.unchanged,
          });
          return { moved: true, method: moved.unchanged ? "unchanged" : "amended" };
        }
        console.warn("optix_bay_move_in_place_refused", {
          calendarItemId: cleanId,
          resourceId: existing.resourceId,
          errorCode: moved.code,
          error: moved.message.slice(0, 300),
          next: "cancel_and_rebook",
        });
      }
    } catch (error) {
      console.error("optix_bay_move_in_place_errored", {
        calendarItemId: cleanId,
        error: error instanceof Error ? error.message.slice(0, 300) : String(error || "").slice(0, 300),
        next: "cancel_and_rebook",
      });
    }
    let cancelled = false;
    try {
      await cancelOptixBayForCalendarItem(cleanId);
      cancelled = true;
    } finally {
      // Write the history row here, not after the cancel succeeds: a refused
      // cancel is the case that most needs a record, because it leaves a bay
      // held in Optix at a time no lesson occupies any more. `cancelled` is
      // what separates "released cleanly" from "go and check Optix".
      await recordSupersededBayBooking(existing, {
        reason: cancelled ? "reschedule" : "reschedule_failed",
        cancelled,
      });
    }
    // The cancelled booking is dead. Clear its IDs so the rebook creates a
    // fresh booking — left in place, buildOptixAppointmentInput would reuse
    // them and try to resurrect the cancelled booking instead. The IDs now
    // live on in optix_bay_bookings, which is the only place they survive
    // this UPDATE.
    await db().sql`
      UPDATE optix_booking_sync
      SET optix_booking_id = '', optix_booking_session_id = '', updated_at = NOW()
      WHERE calendar_item_id = ${cleanId}
    `;
    const outcome = await bookOneResource(accountId, cleanId);
    const errorMessage =
      (outcome as { message?: string }).message ||
      (outcome as { result?: OptixSyncRecord }).result?.errorMessage ||
      "";
    if (outcome.ok === true) {
      console.info("optix_bay_rebook_after_reschedule_completed", {
        calendarItemId: cleanId,
        previousOptixBookingId: existing.optixBookingId,
        previousResourceId: existing.resourceId,
        newOptixBookingId: (outcome as { result?: OptixSyncRecord }).result?.optixBookingId || "",
        newResourceId: (outcome as { result?: OptixSyncRecord }).result?.resourceId || "",
      });
      return { moved: true, method: "rebooked" };
    }
    console.error("optix_bay_rebook_after_reschedule_failed", {
      calendarItemId: cleanId,
      stage: "book_new_bay",
      previousOptixBookingId: existing.optixBookingId,
      previousResourceId: existing.resourceId,
      errorCode:
        (outcome as { error?: string }).error ||
        (outcome as { result?: OptixSyncRecord }).result?.errorCode ||
        "",
      error: errorMessage.slice(0, 300),
    });
    return { moved: false, error: errorMessage };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "Optix bay rebook failed.");
    console.error("optix_bay_rebook_after_reschedule_failed", {
      calendarItemId: cleanId,
      stage: "cancel_or_prepare",
      error: message.slice(0, 300),
    });
    return { moved: false, error: message };
  }
}

/**
 * Auto-book hook for client (public) bookings. Fires only when the lesson
 * type's Resources config has both a resource profile (enabled) and the
 * Auto-book tick. Never throws: a failed bay booking must not break the
 * client's booking confirmation — the coach sees the missing outline and can
 * press Book resource on the card as before.
 */
export async function autoBookResourceForNewBooking(
  accountId: string,
  calendarItemId: string,
  serviceId: string,
): Promise<void> {
  try {
    const bookingType = await readBookingTypeConfig(accountId, String(serviceId || ""));
    if (bookingType?.enabled !== true || bookingType?.autoBook !== true) return;
    const outcome = await bookOneResource(accountId, calendarItemId);
    console.info("optix_auto_book_resource", {
      calendarItemId,
      serviceId,
      ok: outcome.ok === true,
      alreadyBooked: (outcome as { alreadyBooked?: boolean }).alreadyBooked === true,
      error: (outcome as { error?: string }).error || (outcome as { result?: OptixSyncRecord }).result?.errorCode || "",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : String(error || "").slice(0, 300);
    console.error("optix_auto_book_resource_failed", { calendarItemId, serviceId, error: message });
    // Leave the outcome on the row, not only in a log nobody reads. Only a
    // queued row is touched: a lesson that already holds a bay must not have
    // its synced row overwritten because a later lookup hiccuped.
    await markQueuedAutoBook(calendarItemId, "failed", "auto_book_exception", message).catch(() => undefined);
  }
}

/**
 * Bay bookings that were asked for but have not been answered.
 *
 * Both doors that create a lesson (the coach's calendar save and the public
 * booking page) hand the Optix round trip to a task that runs after the
 * response has gone out. In practice that task survives only a few seconds:
 * the live database showed four bays booked automatically out of twenty-three
 * lessons in September 2026, and the nineteen others left no row at all -- no
 * failure, no attempt, nothing for the coach to see.
 *
 * So the ask is now written down before the response: a 'pending' row in
 * optix_booking_sync, inserted only when the lesson type has Auto-book ticked.
 * The after-response attempt still runs and usually answers within seconds.
 * When it does not, sweepQueuedAutoBooks (a scheduled function) finds the row
 * and books the bay itself. Either way the row ends up 'synced' or 'failed',
 * and the card can say which.
 *
 * Never throws: a public booking must not fail because the queue could not
 * be written. Returns whether a row was queued.
 */
export async function queueAutoBookResource(
  accountId: string,
  calendarItemId: string,
  serviceId: string,
): Promise<boolean> {
  const cleanId = String(calendarItemId || "").trim();
  const cleanService = String(serviceId || "").trim();
  if (!accountId || !cleanId || !cleanService) return false;
  try {
    await ensureOptixSyncTable();
    // One statement: the Auto-book tick is read from the account's settings
    // inside the INSERT, so a lesson type without it never gets a row. An
    // existing row -- a bay already held, an earlier failure the coach can
    // see -- is left exactly as it is.
    const rows = await db().sql`
      INSERT INTO optix_booking_sync (
        calendar_item_id, optix_booking_id, optix_booking_session_id, resource_id,
        start_timestamp, end_timestamp, fingerprint, sync_status, error_code,
        error_message, last_attempted_at, last_synced_at, created_at, updated_at
      )
      SELECT ${cleanId}, '', '', '', 0, 0, '', 'pending', 'queued',
             'Waiting for Clarity to book a bay in the background.',
             NULL, NULL, NOW(), NOW()
      WHERE EXISTS (
        SELECT 1
        FROM settings
        WHERE account_id = ${accountId}
          AND key = 'optixBookingTypeConfigJson'
          AND COALESCE((NULLIF(value, '')::jsonb -> ${cleanService} ->> 'enabled')::boolean, FALSE)
          AND COALESCE((NULLIF(value, '')::jsonb -> ${cleanService} ->> 'autoBook')::boolean, FALSE)
      )
      ON CONFLICT (calendar_item_id) DO NOTHING
      RETURNING calendar_item_id
    `;
    const queued = rows.length > 0;
    console.info("optix_auto_book_queued", { calendarItemId: cleanId, serviceId: cleanService, queued });
    return queued;
  } catch (error) {
    console.error("optix_auto_book_queue_failed", {
      calendarItemId: cleanId,
      serviceId: cleanService,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error || "").slice(0, 300),
    });
    return false;
  }
}

/** Settle a queued row without touching one that has already been answered. */
async function markQueuedAutoBook(
  calendarItemId: string,
  status: "failed" | "cancelled",
  errorCode: string,
  errorMessage: string,
) {
  await db().sql`
    UPDATE optix_booking_sync
    SET sync_status = ${status},
        error_code = ${errorCode},
        error_message = ${errorMessage.slice(0, 600)},
        last_attempted_at = NOW(),
        updated_at = NOW()
    WHERE calendar_item_id = ${calendarItemId}
      AND sync_status = 'pending'
  `;
}

/** How long the after-response attempt gets before the sweep steps in. */
const SWEEP_GRACE_SECONDS = 90;
/** A claimed row is left alone this long, in case its attempt is still running. */
const SWEEP_CLAIM_SECONDS = 150;
/**
 * After this many sweep attempts a row that is still pending is given up on.
 * A finished attempt always writes synced or failed, so reaching this means
 * every attempt was cut off before it could answer -- the coach books by hand.
 */
const SWEEP_MAX_ATTEMPTS = 4;

export type AutoBookSweepOutcome = {
  claimed: number;
  synced: number;
  failed: number;
  settled: number;
  items: Array<{ calendarItemId: string; outcome: string }>;
};

/**
 * Book the bays that queued auto-book attempts never answered.
 *
 * Claims one pending row at a time, oldest first, and books it through the
 * same bookOneResource the Book bay button uses, so the result lands on the
 * row in the same shape. The claim is an UPDATE that stamps
 * last_attempted_at, so two overlapping runs cannot pick the same row and a
 * row whose attempt is still in flight is not picked again for a while.
 *
 * `budgetMs` bounds how late a NEW attempt may start: an attempt already
 * running is allowed its full 25 seconds, so the caller's function timeout
 * has to cover budgetMs plus that.
 *
 * The one thing this cannot rule out: an after-response attempt that Optix
 * accepted but that was cut off before the booking id was saved. The sweep
 * would then hold a second bay for the same lesson. The 90-second grace makes
 * that window small (the attempt either answered or died well within it),
 * and the Book bay card shows the bay that was recorded.
 */
export async function sweepQueuedAutoBooks(
  options: { budgetMs?: number; nowMs?: number } = {},
): Promise<AutoBookSweepOutcome> {
  const startedAt = options.nowMs ?? Date.now();
  const budgetMs = options.budgetMs ?? 5_000;
  const outcome: AutoBookSweepOutcome = { claimed: 0, synced: 0, failed: 0, settled: 0, items: [] };
  await ensureOptixSyncTable();

  while (Date.now() - startedAt < budgetMs) {
    const claimed = await db().sql`
      UPDATE optix_booking_sync s
      SET last_attempted_at = NOW(),
          attempt_count = s.attempt_count + 1,
          updated_at = NOW()
      WHERE s.calendar_item_id = (
        SELECT calendar_item_id
        FROM optix_booking_sync
        WHERE sync_status = 'pending'
          AND created_at < NOW() - (${SWEEP_GRACE_SECONDS}::int * INTERVAL '1 second')
          AND (last_attempted_at IS NULL
               OR last_attempted_at < NOW() - (${SWEEP_CLAIM_SECONDS}::int * INTERVAL '1 second'))
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING s.calendar_item_id, s.attempt_count
    `;
    if (!claimed[0]) break;
    outcome.claimed += 1;
    const calendarItemId = String(claimed[0].calendar_item_id || "");
    const attemptCount = Number(claimed[0].attempt_count || 0);
    const record = (label: string) => outcome.items.push({ calendarItemId, outcome: label });

    try {
      if (attemptCount > SWEEP_MAX_ATTEMPTS) {
        await markQueuedAutoBook(
          calendarItemId,
          "failed",
          "auto_book_abandoned",
          `Clarity tried ${SWEEP_MAX_ATTEMPTS} times to book a bay in the background and never got an answer. Press Book bay to book it now.`,
        );
        outcome.settled += 1;
        record("abandoned");
        continue;
      }

      const lessons = await db().sql`
        SELECT account_id, service_id, status
        FROM calendar_items
        WHERE id = ${calendarItemId} AND kind = 'appointment'
        LIMIT 1
      `;
      const lesson = lessons[0];
      if (!lesson) {
        await markQueuedAutoBook(calendarItemId, "cancelled", "lesson_deleted", "The lesson was removed before a bay was booked.");
        outcome.settled += 1;
        record("lesson_deleted");
        continue;
      }
      if (["cancelled", "no_show"].includes(String(lesson.status || ""))) {
        await markQueuedAutoBook(calendarItemId, "cancelled", "lesson_inactive", "The lesson was cancelled before a bay was booked.");
        outcome.settled += 1;
        record("lesson_inactive");
        continue;
      }
      const accountId = String(lesson.account_id || "");
      const serviceId = String(lesson.service_id || "");
      const bookingType = await readBookingTypeConfig(accountId, serviceId);
      if (bookingType?.enabled !== true || bookingType?.autoBook !== true) {
        await markQueuedAutoBook(calendarItemId, "cancelled", "optix_disabled", "Auto-book was switched off for this lesson type before a bay was booked.");
        outcome.settled += 1;
        record("optix_disabled");
        continue;
      }

      const result = await bookOneResource(accountId, calendarItemId);
      if (result.ok === true) {
        outcome.synced += 1;
        record((result as { alreadyBooked?: boolean }).alreadyBooked ? "already_booked" : "synced");
      } else {
        // bookOneResource has already written the failed row with Optix's
        // reason; only a refusal before it got that far leaves 'pending'.
        const reason =
          (result as { message?: string }).message ||
          (result as { result?: OptixSyncRecord }).result?.errorMessage ||
          "Optix did not book a bay.";
        await markQueuedAutoBook(calendarItemId, "failed", (result as { error?: string }).error || "auto_book_failed", reason);
        outcome.failed += 1;
        record("failed");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : String(error || "").slice(0, 300);
      console.error("optix_auto_book_sweep_item_failed", { calendarItemId, error: message });
      await markQueuedAutoBook(calendarItemId, "failed", "auto_book_exception", message).catch(() => undefined);
      outcome.failed += 1;
      record("exception");
    }
  }

  return outcome;
}