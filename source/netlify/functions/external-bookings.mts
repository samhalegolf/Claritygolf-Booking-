import { createHash } from "node:crypto";
import { getDatabase } from "@netlify/database";
import type { Config } from "@netlify/functions";
import { optixOriginRequest, processStoredOptixEvent } from "./_shared/optix-origin.mts";

const SESSION_COOKIE = "clarity_session";
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
  const rows = await optixOriginRequest(`settings?key=in.(${keys})&select=key,value`).catch(() => []);
  const settings = Object.fromEntries((rows || []).map((row: any) => [row.key, row.value]));
  return {
    services: parse(settings.servicesJson, []), locations: parse(settings.locationsJson, []), coaches: parse(settings.coachProfilesJson, []),
  };
}

async function getState() {
  const [mappings, events, links, resources, catalog] = await Promise.all([
    optixOriginRequest("external_booking_mappings?provider=eq.optix&order=workspace_id.asc"),
    optixOriginRequest("optix_webhook_events?select=id,event_key,event_type,external_booking_id,received_at,processing_status,processed_at,failure_code,error_message,attempt_count,clarity_item_id,payload_json&order=received_at.desc&limit=50"),
    optixOriginRequest("external_booking_links?provider=eq.optix&purpose=eq.lesson&select=external_booking_id,clarity_item_id,processing_status,email_status,confirmation_sent_at,workspace_id&order=updated_at.desc&limit=100"),
    optixOriginRequest("optix_booking_sync?select=calendar_item_id,optix_booking_id,resource_id,sync_status,last_synced_at&order=updated_at.desc&limit=100").catch(() => []),
    catalogue(),
  ]);
  const linkByBooking = new Map((links || []).map((row: any) => [row.external_booking_id, row]));
  const resourceByItem = new Map((resources || []).map((row: any) => [row.calendar_item_id, row]));
  return {
    mappings, catalog,
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
      if (String(body.workspaceId) !== "637949") return json({ error: "unknown_mapping" }, 400);
      const emailBehaviour = ["none", "immediate", "after_bay"].includes(body.emailBehaviour) ? body.emailBehaviour : "none";
      // No service mapping: every inbound booking files under the reserved
      // External Booking lesson type, so the mapping only carries location,
      // default coach and email behaviour.
      await optixOriginRequest("external_booking_mappings?provider=eq.optix&workspace_id=eq.637949", {
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
      const rows = await optixOriginRequest(`optix_webhook_events?event_key=eq.${encodeURIComponent(eventKey)}&processing_status=eq.failed&select=event_key,payload_json&limit=1`);
      if (!rows?.[0]) return json({ error: "failed_event_not_found" }, 404);
      const result = await processStoredOptixEvent(eventKey, rows[0].payload_json);
      return json({ ok: true, result, state: await getState() });
    }
    return json({ error: "method_not_allowed" }, 405);
  } catch (error: any) {
    return json({ error: String(error?.code || "external_bookings_failed"), message: error instanceof Error ? error.message : "External bookings request failed." }, 500);
  }
}

export const config: Config = { path: "/api/external-bookings" };
