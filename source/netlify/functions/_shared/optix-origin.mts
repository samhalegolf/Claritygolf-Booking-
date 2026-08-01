import { createHash, randomUUID } from "node:crypto";

export type NormalizedOptixBooking = {
  externalBookingId: string;
  externalBookingSessionId?: string;
  externalResourceId?: string;
  customerName: string;
  title?: string;
  startIso: string;
  endIso: string;
  status: "booked" | "cancelled";
  externalUpdatedAt?: string;
  externalPayloadVersion?: string;
};

type SupabaseConfig = { url: string; key: string };

function env(name: string) {
  return (globalThis.Netlify?.env?.get(name) || process.env[name] || "").trim();
}

function config(): SupabaseConfig {
  const url = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
  if (!url || !key) throw Object.assign(new Error("Supabase is not configured."), { code: "not_configured" });
  return { url, key };
}

async function request(path: string, init: RequestInit = {}) {
  const { url, key } = config();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      prefer: "return=representation",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = body?.message || body?.error || `Supabase request failed (${response.status}).`;
    throw Object.assign(new Error(message), { code: body?.code || "supabase_error", status: response.status });
  }
  return body;
}

function assertBooking(input: NormalizedOptixBooking) {
  if (!input.externalBookingId) throw new Error("externalBookingId is required.");
  if (!input.customerName) throw new Error("customerName is required.");
  if (!Number.isFinite(Date.parse(input.startIso)) || !Number.isFinite(Date.parse(input.endIso))) {
    throw new Error("Valid startIso and endIso values are required.");
  }
}

function calendarFields(input: NormalizedOptixBooking) {
  const start = new Date(input.startIso);
  const end = new Date(input.endIso);
  const duration = Math.max(1, Math.round((end.getTime() - start.getTime()) / 60_000));
  return {
    kind: "appointment",
    title: input.title || input.customerName,
    client: input.customerName,
    status: input.status === "cancelled" ? "cancelled" : "booked",
    duration,
    origin: "optix",
    external_provider: "optix",
    external_booking_id: input.externalBookingId,
    external_booking_session_id: input.externalBookingSessionId || null,
    external_resource_id: input.externalResourceId || null,
    external_updated_at: input.externalUpdatedAt || null,
    external_sync_state: input.status === "cancelled" ? "cancelled" : "synced",
    external_payload_version: input.externalPayloadVersion || null,
  };
}

export async function findOptixLink(externalBookingId: string) {
  const rows = await request(`external_booking_links?provider=eq.optix&external_booking_id=eq.${encodeURIComponent(externalBookingId)}&limit=1`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

export async function upsertNormalizedOptixBooking(input: NormalizedOptixBooking) {
  assertBooking(input);
  const existing = await findOptixLink(input.externalBookingId);
  const clarityItemId = existing?.clarity_item_id || `optix-${randomUUID()}`;
  const fields = calendarFields(input);

  await request("calendar_items?on_conflict=id", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([{ id: clarityItemId, ...fields }]),
  });

  const link = {
    provider: "optix",
    external_booking_id: input.externalBookingId,
    clarity_item_id: clarityItemId,
    origin: "optix",
    external_booking_session_id: input.externalBookingSessionId || null,
    external_resource_id: input.externalResourceId || null,
    external_updated_at: input.externalUpdatedAt || null,
    external_payload_version: input.externalPayloadVersion || null,
    updated_at: new Date().toISOString(),
  };
  await request("external_booking_links?on_conflict=provider,external_booking_id", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([link]),
  });
  return { clarityItemId, created: !existing, status: fields.external_sync_state };
}

export function webhookEventKey(rawBody: string, suppliedKey = "") {
  return suppliedKey.trim() || createHash("sha256").update(rawBody).digest("hex");
}

export async function storeOptixWebhookEvent(args: {
  eventKey: string;
  eventType?: string;
  externalBookingId?: string;
  payload: unknown;
}) {
  const rows = await request("optix_webhook_events?on_conflict=event_key", {
    method: "POST",
    headers: { prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify([{
      event_key: args.eventKey,
      event_type: args.eventType || null,
      external_booking_id: args.externalBookingId || null,
      payload_json: args.payload,
      processing_status: "stored",
    }]),
  });
  return { inserted: Array.isArray(rows) && rows.length > 0, eventKey: args.eventKey };
}
