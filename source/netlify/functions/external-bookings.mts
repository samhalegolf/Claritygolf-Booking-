import { createHash } from "node:crypto";
import { getDatabase } from "@netlify/database";
import type { Config } from "@netlify/functions";
import { processStoredExternalEvent } from "./_shared/integrations/ingest.mts";
import { integrationRequest } from "./_shared/integrations/db.mts";

const SESSION_COOKIE = "clarity_session";
/**
 * The provider this endpoint serves.
 *
 * One constant rather than the eight string literals that used to be scattered
 * through the queries below. When a second provider needs this endpoint it
 * becomes a route parameter; until then, having one place to change is the
 * whole point.
 */
const PROVIDER = "optix";
/** Stored but never concluded: still safe to run through processing. */
const UNPROCESSED_STATUSES = "received,stored,failed";
/** One replay pass stays inside the function timeout; run it again for more. */
const PENDING_REPLAY_LIMIT = 150;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

function cookies(req: Request) {
  return Object.fromEntries((req.headers.get("cookie") || "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const at = part.indexOf("=");
    return at < 0 ? [decodeURIComponent(part), ""] : [decodeURIComponent(part.slice(0, at)), decodeURIComponent(part.slice(at + 1))];
  }));
}

async function requireAdmin(req: Request) {
  const token = cookies(req)[SESSION_COOKIE] || "";
  if (!token) return false;
  const hash = createHash("sha256").update(token).digest("hex");
  const rows = await getDatabase().sql`SELECT id FROM admin_sessions WHERE token_hash = ${hash} AND expires_at > NOW() LIMIT 1`;
  return rows.length > 0;
}

function parse(value: unknown, fallback: any) {
  try { return typeof value === "string" ? JSON.parse(value) : fallback; } catch { return fallback; }
}

async function catalogue() {
  const keys = "servicesJson,locationsJson,coachProfilesJson";
  const rows = await integrationRequest(`settings?key=in.(${keys})&select=key,value`).catch(() => []);
  const settings = Object.fromEntries((rows || []).map((row: any) => [row.key, row.value]));
  return {
    services: parse(settings.servicesJson, []), locations: parse(settings.locationsJson, []), coaches: parse(settings.coachProfilesJson, []),
  };
}

/**
 * Every external workspace Clarity has actually seen, newest name wins.
 *
 * The panel used to carry a hardcoded list of seven bay ids and their names —
 * literally one range's bays, compiled into the product. They are discoverable
 * instead: a bay is a workspace, and every webhook carries its id, name and
 * type, so the list can be read out of traffic already received rather than
 * guessed at or asked of an API whose schema we would have to assume.
 *
 * The trade-off worth knowing: a workspace that has never had a booking cannot
 * appear here. That is honest — "these are the ones we have seen" — and it is
 * why the panel says so rather than presenting the list as complete.
 */
function observedWorkspaces(rows: any[]) {
  const seen = new Map<string, any>();
  // rows arrive newest first, so the first sighting of an id is its current
  // name. Sam's lesson workspace has been called three different things.
  for (const row of rows || []) {
    const id = String(row?.workspace_id || "").trim();
    if (!id) continue;
    const existing = seen.get(id);
    if (existing) {
      existing.events += 1;
      existing.firstSeen = row.received_at || existing.firstSeen;
      continue;
    }
    seen.set(id, {
      id,
      name: String(row?.workspace_name || "").trim() || id,
      type: String(row?.workspace_type || "").trim(),
      events: 1,
      lastSeen: row?.received_at || null,
      firstSeen: row?.received_at || null,
    });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

async function getState() {
  const [mappings, events, pending, purchases, links, resources, workspaceRows, catalog] = await Promise.all([
    integrationRequest(`external_booking_mappings?provider=eq.${PROVIDER}&order=workspace_id.asc`),
    integrationRequest("optix_webhook_events?select=id,event_key,event_type,external_booking_id,received_at,processing_status,processed_at,failure_code,error_message,attempt_count,clarity_item_id,payload_json&order=received_at.desc&limit=50"),
    // Just the keys, so the panel can show how many events are still waiting
    // without pulling their payloads.
    integrationRequest(`optix_webhook_events?processing_status=in.(${UNPROCESSED_STATUSES})&select=event_key,received_at&order=received_at.asc&limit=2000`).catch(() => []),
    // Recorded pass purchases, newest first. Absent until the migration runs.
    integrationRequest("optix_pass_purchases?select=id,event_type,external_purchase_id,sale_number,member_email,member_name,person_id,item_name,quantity,amount_cents,currency,purchased_at,paid_at,is_pass,classification,payload_json&order=purchased_at.desc&limit=100").catch(() => []),
    integrationRequest(`external_booking_links?provider=eq.${PROVIDER}&purpose=eq.lesson&select=external_booking_id,clarity_item_id,processing_status,email_status,confirmation_sent_at,workspace_id&order=updated_at.desc&limit=100`),
    integrationRequest("optix_booking_sync?select=calendar_item_id,optix_booking_id,resource_id,sync_status,last_synced_at&order=updated_at.desc&limit=100").catch(() => []),
    // Slim projection: three JSON fields, not the payloads. Enough to build the
    // workspace list without pulling 1,300 full webhook bodies across the wire.
    integrationRequest(
      "optix_webhook_events?select=received_at,workspace_id:payload_json->>workspace_id," +
      "workspace_name:payload_json->>workspace_name,workspace_type:payload_json->>workspace_type" +
      "&order=received_at.desc&limit=3000",
    ).catch(() => []),
    catalogue(),
  ]);
  const linkByBooking = new Map((links || []).map((row: any) => [row.external_booking_id, row]));
  const resourceByItem = new Map((resources || []).map((row: any) => [row.calendar_item_id, row]));
  return {
    mappings, catalog,
    workspaces: observedWorkspaces(workspaceRows || []),
    pending: {
      count: (pending || []).length,
      oldest: (pending || [])[0]?.received_at || null,
      newest: (pending || []).at(-1)?.received_at || null,
    },
    purchases: (purchases || []).map((row: any) => ({ ...row, payload_json: undefined, rawPayload: row.payload_json })),
    events: (events || []).map((event: any) => {
      const link: any = linkByBooking.get(event.external_booking_id) || {};
      const resource: any = resourceByItem.get(event.clarity_item_id || link.clarity_item_id) || {};
      const payload = event.payload_json || {};
      return {
        ...event, payload_json: undefined, rawPayload: event.payload_json,
        customer: [payload?.member?.first_name || payload?.first_name, payload?.member?.last_name || payload?.last_name].filter(Boolean).join(" ") || payload?.member?.email || payload?.email || "",
        workspaceName: payload?.workspace_name || payload?.workspace?.name || "",
        workspaceId: String(payload?.workspace_id || payload?.workspace?.id || ""),
        start: payload?.check_in_timestamp || payload?.start_timestamp || null,
        end: payload?.check_out_timestamp || payload?.end_timestamp || null,
        emailStatus: link.email_status || "",
        bayStatus: resource.sync_status === "synced" ? "booked" : "required",
        outboundBayBookingId: resource.optix_booking_id || "",
      };
    }),
  };
}

export default async function handler(req: Request) {
  if (!(await requireAdmin(req))) return json({ error: "unauthorized" }, 401);
  try {
    if (req.method === "GET") return json(await getState());
    const body: any = await req.json().catch(() => ({}));
    if (req.method === "PUT") {
      // Was: a literal check against one workspace id. A saved mapping is the
      // only thing that makes a workspace ours, so ask the table.
      const workspaceId = String(body.workspaceId || "").trim();
      const known = await integrationRequest(
        `external_booking_mappings?provider=eq.${PROVIDER}&workspace_id=eq.${encodeURIComponent(workspaceId)}&select=workspace_id&limit=1`,
      ).catch(() => []);
      if (!workspaceId || !known?.[0]) return json({ error: "unknown_mapping" }, 400);
      const emailBehaviour = ["none", "immediate", "after_bay"].includes(body.emailBehaviour) ? body.emailBehaviour : "none";
      // No service mapping: every inbound booking files under the reserved
      // External Booking lesson type, so the mapping only carries location,
      // default coach and email behaviour.
      await integrationRequest(`external_booking_mappings?provider=eq.${PROVIDER}&workspace_id=eq.${encodeURIComponent(workspaceId)}`, {
        method: "PATCH", body: JSON.stringify({
          enabled: body.enabled === true,
          location_id: String(body.locationId || ""), default_coach_id: String(body.defaultCoachId || "") || null,
          email_behaviour: emailBehaviour, updated_at: new Date().toISOString(),
        }),
      });
      return json({ ok: true, state: await getState() });
    }
    if (req.method === "POST" && body.action === "retry") {
      const eventKey = String(body.eventKey || "").trim();
      // Any event that never reached a conclusion is retryable, not just a
      // failed one. Restricting this to 'failed' left the 804 events stranded
      // at 'received' by the receipt-only period with no button at all.
      const rows = await integrationRequest(`optix_webhook_events?event_key=eq.${encodeURIComponent(eventKey)}&processing_status=in.(${UNPROCESSED_STATUSES})&select=event_key,payload_json&limit=1`);
      if (!rows?.[0]) return json({ error: "retryable_event_not_found" }, 404);
      const result = await processStoredExternalEvent(PROVIDER, eventKey, rows[0].payload_json);
      return json({ ok: true, result, state: await getState() });
    }
    // Replays every event still waiting, oldest first, from a cutoff date.
    // Sequential by design: two events for one booking must not race, and the
    // duplicate guard reads calendar_items that the previous event just wrote.
    if (req.method === "POST" && body.action === "process-pending") {
      const sinceIso = new Date(String(body.since || "")).toISOString();
      const rows = await integrationRequest(
        `optix_webhook_events?processing_status=in.(${UNPROCESSED_STATUSES})&received_at=gte.${encodeURIComponent(sinceIso)}&select=event_key,payload_json&order=received_at.asc&limit=${PENDING_REPLAY_LIMIT}`,
      );
      const summary: Record<string, number> = {};
      for (const row of rows || []) {
        try {
          const result: any = await processStoredExternalEvent(PROVIDER, row.event_key, row.payload_json);
          const key = result?.status === "ignored" ? `ignored:${result?.reason || "unknown"}` : String(result?.status || "unknown");
          summary[key] = (summary[key] || 0) + 1;
        } catch (error: any) {
          const key = `failed:${String(error?.code || "processing_failed")}`;
          summary[key] = (summary[key] || 0) + 1;
        }
      }
      return json({ ok: true, attempted: (rows || []).length, summary, state: await getState() });
    }
    return json({ error: "method_not_allowed" }, 405);
  } catch (error: any) {
    return json({ error: String(error?.code || "external_bookings_failed"), message: error instanceof Error ? error.message : "External bookings request failed." }, 500);
  }
}

export const config: Config = { path: "/api/external-bookings" };
