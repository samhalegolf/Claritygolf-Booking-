import { getDatabase } from "@netlify/database";
import type { Config } from "@netlify/functions";
import { requireCoachActor } from "./_shared/coach-auth.mts";

/**
 * Bay names come from Optix itself.
 *
 * Removed: a BAY_NAMES constant mapping seven literal Optix resource ids to
 * "Bay #1".."Bay #7". It was one business's bay list compiled into the server,
 * so any other resource -- another business's bay, a fitting room, a bay added
 * last week -- resolved to "" and the card fell back to "Resource booked".
 *
 * Every Optix webhook carries workspace_id and workspace_name, which is where
 * the Integrations screen already gets its bay list (observedWorkspaces in
 * external-bookings.mts). Newest sighting wins: a workspace can be renamed, and
 * one of Sam's has carried three names.
 *
 * optix_webhook_events has no account_id -- it is the shared inbound log. The
 * resource id being named always comes from the caller's own sync row, so this
 * names a bay the caller has already booked and nothing else.
 */
function db() {
  return getDatabase();
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/**
 * The old check proved a session row existed and nothing more, while the query
 * below read every business's appointments -- client names, emails and slots.
 */
async function requireAccountId(req: Request): Promise<string> {
  return (await requireCoachActor(req)).accountId;
}

async function ensureTable() {
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
}

/**
 * Newest name Optix has used for each of the given resource ids.
 *
 * Scoped to the ids actually on screen rather than every workspace ever seen,
 * so the cost does not grow with the inbound log. Never throws: an unnamed bay
 * shows its resource id, which is worse than a name and much better than the
 * panel failing to load.
 */
async function bayNamesFor(resourceIds: string[]): Promise<Map<string, string>> {
  const wanted = Array.from(new Set(resourceIds.filter(Boolean)));
  if (!wanted.length) return new Map();
  try {
    const rows = await db().sql`
      SELECT DISTINCT ON (payload_json->>'workspace_id')
        payload_json->>'workspace_id' AS workspace_id,
        payload_json->>'workspace_name' AS workspace_name
      FROM optix_webhook_events
      WHERE payload_json->>'workspace_id' = ANY(${wanted})
      ORDER BY payload_json->>'workspace_id', received_at DESC
    `;
    return new Map(
      rows
        .map((row: any) => [String(row.workspace_id || ""), String(row.workspace_name || "").trim()])
        .filter(([id, name]: string[]) => id && name) as Array<[string, string]>,
    );
  } catch (error) {
    console.warn("optix_booking_status:bay_names_unavailable", {
      error: error instanceof Error ? error.message.slice(0, 200) : String(error || "").slice(0, 200),
    });
    return new Map();
  }
}

/**
 * `syncStatus: "none"` means this lesson has no sync row -- no bay has ever
 * been attempted. It used to be reported as "pending", which read as an
 * attempt in flight, and a failed request reported the same thing by returning
 * nothing at all. Those are three different states and the card says so.
 */
function toRecord(row: any, bayNames: Map<string, string>) {
  const resourceId = String(row.resource_id || "");
  return {
    calendarItemId: String(row.id || ""),
    client: String(row.client || ""),
    title: String(row.title || ""),
    serviceId: String(row.service_id || ""),
    week: Number(row.week || 0),
    day: Number(row.day || 0),
    start: Number(row.start || 0),
    duration: Number(row.duration || 0),
    optixBookingId: String(row.optix_booking_id || ""),
    optixBookingSessionId: String(row.optix_booking_session_id || ""),
    resourceId,
    bayName: bayNames.get(resourceId) || "",
    hasSyncRow: Boolean(row.sync_status),
    syncStatus: row.sync_status ? String(row.sync_status) : "none",
    errorCode: String(row.error_code || ""),
    errorMessage: String(row.error_message || ""),
    lastAttemptedAt: row.last_attempted_at || null,
    lastSyncedAt: row.last_synced_at || null,
    updatedAt: row.updated_at || null,
  };
}

export default async function handler(req: Request) {
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  let accountId = "";
  try {
    accountId = await requireAccountId(req);
  } catch (error) {
    const status = (error as { status?: number })?.status === 403 ? 403 : 401;
    return json(
      {
        error: (error as { code?: string })?.code || "unauthorized",
        message: error instanceof Error ? error.message : "Admin login required.",
      },
      status,
    );
  }

  await ensureTable();

  // One booking, by id. The card asks for the lesson it is showing instead of
  // reading the account's newest 100 and hoping its own is in there -- an older
  // lesson simply fell off the end, and the card then showed "no bay attempted"
  // for a lesson that holds one.
  const calendarItemId = String(new URL(req.url).searchParams.get("calendarItemId") || "").trim();
  if (calendarItemId) {
    const rows = await db().sql`
      SELECT
        c.id, c.client, c.title, c.service_id, c.week, c.day, c.start, c.duration,
        s.optix_booking_id, s.optix_booking_session_id, s.resource_id, s.sync_status,
        s.error_code, s.error_message, s.last_attempted_at, s.last_synced_at, s.updated_at
      FROM calendar_items c
      LEFT JOIN optix_booking_sync s ON s.calendar_item_id = c.id
      WHERE c.id = ${calendarItemId}
        AND c.account_id = ${accountId}
        AND c.kind = 'appointment'
      LIMIT 1
    `;
    // found:false is "not an appointment on your account", which is a different
    // thing from "an appointment with no bay yet" -- the caller must be able to
    // tell them apart, because only one of them is worth a Book bay button.
    if (!rows[0]) return json({ found: false, record: null });
    const bayNames = await bayNamesFor([String(rows[0].resource_id || "")]);
    return json({ found: true, record: toRecord(rows[0], bayNames) });
  }

  const rows = await db().sql`
    SELECT
      c.id, c.client, c.title, c.service_id, c.week, c.day, c.start, c.duration,
      s.optix_booking_id, s.optix_booking_session_id, s.resource_id, s.sync_status,
      s.error_code, s.error_message, s.last_attempted_at, s.last_synced_at, s.updated_at
    FROM calendar_items c
    LEFT JOIN optix_booking_sync s ON s.calendar_item_id = c.id
    WHERE c.kind = 'appointment'
      AND c.account_id = ${accountId}
    ORDER BY COALESCE(s.updated_at, c.updated_at) DESC
    LIMIT 100
  `;
  const bayNames = await bayNamesFor(rows.map((row: any) => String(row.resource_id || "")));

  return json({ records: rows.map((row: any) => toRecord(row, bayNames)) });
}

export const config: Config = { path: "/api/optix-booking-status" };
