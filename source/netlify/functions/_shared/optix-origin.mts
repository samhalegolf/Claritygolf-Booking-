import { createHash, randomUUID } from "node:crypto";

export type OptixEmailBehaviour = "none" | "immediate" | "after_bay";

export type OptixLessonMapping = {
  id?: string;
  provider: "optix";
  organisationId: string;
  workspaceId: string;
  workspaceName: string;
  accountId: string;
  serviceId: string;
  serviceName: string;
  locationId: string;
  defaultCoachId: string | null;
  enabled: boolean;
  expectedDuration: number | null;
  bayProfileId: string | null;
  emailBehaviour: OptixEmailBehaviour;
};

export type OptixLessonEvent = {
  eventType: "new_member_booking" | "member_booking_updated" | "member_booking_cancelled";
  bookingId: string;
  organisationId: string;
  workspaceId: string;
  workspaceName: string;
  startIso: string;
  endIso: string;
  timezone: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  source: string;
};

type SupabaseConfig = { url: string; key: string };

type ExistingOptixCalendarItem = {
  id: string;
  origin: string;
  external_provider: string;
  external_booking_id: string;
  person_id: string;
};

function env(name: string) {
  return (globalThis.Netlify?.env?.get(name) || process.env[name] || "").trim();
}

function config(): SupabaseConfig {
  const url = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
  if (!url || !key) throw Object.assign(new Error("Supabase is not configured."), { code: "not_configured" });
  return { url, key };
}

export async function optixOriginRequest(path: string, init: RequestInit = {}) {
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
  const raw = await response.text();
  const body = raw ? JSON.parse(raw) : null;
  if (!response.ok) {
    const message = body?.message || body?.error || `Supabase request failed (${response.status}).`;
    throw Object.assign(new Error(message), { code: body?.code || "supabase_error", status: response.status });
  }
  return body;
}

function text(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function pick(payload: any, ...paths: string[]) {
  for (const path of paths) {
    const value = path.split(".").reduce((item, key) => item?.[key], payload);
    if (value !== undefined && value !== null && text(value)) return value;
  }
  return "";
}

function iso(value: unknown) {
  const raw = text(value);
  if (!raw) return "";
  const numeric = Number(raw);
  const date = Number.isFinite(numeric) && /^\d+$/.test(raw)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

export function normalizeOptixLessonEvent(payload: any): OptixLessonEvent {
  const startIso = iso(pick(payload, "check_in_timestamp", "booking.check_in_timestamp", "start_timestamp", "start"));
  const endIso = iso(pick(payload, "check_out_timestamp", "booking.check_out_timestamp", "end_timestamp", "end"));
  const eventType = text(pick(payload, "event", "event_type")) as OptixLessonEvent["eventType"];
  return {
    eventType,
    bookingId: text(pick(payload, "booking_id", "booking.id", "id")),
    organisationId: text(pick(payload, "organization_id", "organisation_id", "booking.organization_id", "booking.organisation_id")),
    workspaceId: text(pick(payload, "workspace_id", "workspace.id", "booking.workspace_id", "booking.workspace.id")),
    workspaceName: text(pick(payload, "workspace_name", "workspace.name", "booking.workspace_name", "booking.workspace.name")),
    startIso,
    endIso,
    timezone: text(pick(payload, "timezone", "time_zone", "booking.timezone")) || "Pacific/Auckland",
    firstName: text(pick(payload, "member.first_name", "member_name", "member_first_name", "customer.first_name", "first_name")),
    lastName: text(pick(payload, "member.last_name", "member_last_name", "customer.last_name", "last_name")),
    email: text(pick(payload, "member.email", "member_email", "customer.email", "email")).toLowerCase(),
    phone: text(pick(payload, "member.phone", "member.phone_number", "member_phone", "customer.phone", "phone")),
    source: text(pick(payload, "source")) || "Optix webhook",
  };
}

export function assertProcessableEvent(event: OptixLessonEvent) {
  if (!["new_member_booking", "member_booking_updated", "member_booking_cancelled"].includes(event.eventType)) {
    throw Object.assign(new Error(`Unsupported Optix event ${event.eventType || "unknown"}.`), { code: "unsupported_event" });
  }
  if (!event.bookingId) throw Object.assign(new Error("Optix booking ID is missing."), { code: "missing_booking_id" });
  if (!event.workspaceId) throw Object.assign(new Error("Optix workspace ID is missing."), { code: "missing_workspace_id" });
  if (event.eventType !== "member_booking_cancelled" && (!event.startIso || !event.endIso)) {
    throw Object.assign(new Error("Optix booking timestamps are invalid."), { code: "invalid_timestamps" });
  }
  if (event.eventType !== "member_booking_cancelled" && !event.firstName && !event.lastName && !event.email && !event.phone) {
    throw Object.assign(new Error("Optix customer identity is missing. The event was not allowed to create or update a lesson."), { code: "missing_customer_identity" });
  }
}

const BASE_WEEK_START = Date.UTC(2026, 5, 1);

export function calendarSlot(startIso: string, timezone: string) {
  const date = new Date(startIso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
  const dayMap: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const localDate = Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")));
  return {
    week: Math.floor((localDate - BASE_WEEK_START) / (7 * 86_400_000)),
    day: dayMap[get("weekday")] ?? 0,
    start: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function customerName(event: OptixLessonEvent) {
  return [event.firstName, event.lastName].filter(Boolean).join(" ").trim() || event.email || event.phone;
}

export function createCalendarItemFromOptixBooking(event: OptixLessonEvent, mapping: OptixLessonMapping, ids: { itemId: string; personId: string }) {
  const slot = calendarSlot(event.startIso, event.timezone);
  const derivedDuration = Math.max(1, Math.round((Date.parse(event.endIso) - Date.parse(event.startIso)) / 60_000));
  const client = customerName(event);
  if (!client) throw Object.assign(new Error("Optix customer identity is missing."), { code: "missing_customer_identity" });
  return {
    id: ids.itemId,
    account_id: mapping.accountId,
    kind: "appointment",
    ...slot,
    duration: derivedDuration || mapping.expectedDuration || 60,
    coach_id: mapping.defaultCoachId || "",
    location_id: mapping.locationId,
    service_id: mapping.serviceId,
    client,
    title: client,
    phone: event.phone,
    email: event.email,
    person_id: ids.personId,
    note: "",
    status: event.eventType === "member_booking_cancelled" ? "cancelled" : "booked",
    coach: null,
    location: { locationId: mapping.locationId, timezone: event.timezone },
    custom_group: null,
    origin: "optix",
    external_provider: "optix",
    external_booking_id: event.bookingId,
    external_workspace_id: event.workspaceId,
    external_organisation_id: event.organisationId,
    external_event_type: event.eventType,
    external_source: event.source,
    external_sync_state: event.eventType === "member_booking_cancelled" ? "cancelled" : "bay_required",
    external_updated_at: new Date().toISOString(),
  };
}

export async function findOptixLink(externalBookingId: string, purpose = "lesson") {
  const rows = await optixOriginRequest(`external_booking_links?provider=eq.optix&purpose=eq.${purpose}&external_booking_id=eq.${encodeURIComponent(externalBookingId)}&limit=1`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function readLinkedCalendarItem(itemId: string): Promise<ExistingOptixCalendarItem | null> {
  const rows = await optixOriginRequest(`calendar_items?id=eq.${encodeURIComponent(itemId)}&select=id,origin,external_provider,external_booking_id,person_id&limit=1`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function assertSafeExistingLink(existing: any, event: OptixLessonEvent) {
  const itemId = text(existing?.clarity_item_id);
  if (!itemId) throw Object.assign(new Error("The Optix link has no Clarity appointment ID."), { code: "unsafe_existing_link" });
  const item = await readLinkedCalendarItem(itemId);
  const ownsItem = item && item.origin === "optix" && item.external_provider === "optix" && item.external_booking_id === event.bookingId;
  if (!ownsItem) {
    throw Object.assign(new Error("Blocked an Optix event from overwriting an appointment that Optix does not exclusively own."), { code: "unsafe_existing_link" });
  }
  return item;
}

async function findMapping(event: OptixLessonEvent): Promise<OptixLessonMapping | null> {
  const query = `external_booking_mappings?provider=eq.optix&organisation_id=eq.${encodeURIComponent(event.organisationId)}&workspace_id=eq.${encodeURIComponent(event.workspaceId)}&limit=1`;
  let rows = await optixOriginRequest(query);
  if (!Array.isArray(rows) || !rows.length) {
    rows = await optixOriginRequest(`external_booking_mappings?provider=eq.optix&workspace_id=eq.${encodeURIComponent(event.workspaceId)}&limit=1`);
  }
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  return {
    id: row.id,
    provider: "optix",
    organisationId: text(row.organisation_id),
    workspaceId: text(row.workspace_id),
    workspaceName: text(row.workspace_name),
    accountId: text(row.account_id),
    serviceId: text(row.service_id),
    serviceName: text(row.service_name),
    locationId: text(row.location_id),
    defaultCoachId: text(row.default_coach_id) || null,
    enabled: row.enabled === true,
    expectedDuration: Number.isFinite(Number(row.expected_duration)) ? Number(row.expected_duration) : null,
    bayProfileId: text(row.bay_profile_id) || null,
    emailBehaviour: ["immediate", "after_bay"].includes(row.email_behaviour) ? row.email_behaviour : "none",
  };
}

async function resolvePerson(event: OptixLessonEvent, accountId: string) {
  const name = customerName(event);
  if (!name) throw Object.assign(new Error("Optix customer identity is missing."), { code: "missing_customer_identity" });
  let rows: any[] = [];
  if (event.email) {
    rows = await optixOriginRequest(`people?account_id=eq.${encodeURIComponent(accountId)}&email=ilike.${encodeURIComponent(event.email)}&select=id,name,email,phone&limit=5`);
  } else if (event.phone) {
    rows = await optixOriginRequest(`people?account_id=eq.${encodeURIComponent(accountId)}&phone=eq.${encodeURIComponent(event.phone)}&select=id,name,email,phone&limit=5`);
  } else {
    rows = await optixOriginRequest(`people?account_id=eq.${encodeURIComponent(accountId)}&name=ilike.${encodeURIComponent(name)}&select=id,name,email,phone&limit=5`);
  }
  const match = Array.isArray(rows) ? rows[0] : null;
  if (match?.id) return String(match.id);
  const personId = randomUUID();
  await optixOriginRequest("people", { method: "POST", body: JSON.stringify([{ id: personId, account_id: accountId, name, email: event.email || null, phone: event.phone || null, source: "optix" }]) });
  return personId;
}

async function updateEvent(eventKey: string, values: Record<string, unknown>) {
  await optixOriginRequest(`optix_webhook_events?event_key=eq.${encodeURIComponent(eventKey)}`, { method: "PATCH", body: JSON.stringify({ ...values, updated_at: new Date().toISOString() }) });
}

export async function processStoredOptixEvent(eventKey: string, payload: unknown) {
  const event = normalizeOptixLessonEvent(payload);
  try {
    assertProcessableEvent(event);
  } catch (error: any) {
    if (error?.code === "unsupported_event") {
      await updateEvent(eventKey, { processing_status: "ignored", failure_code: error.code, error_message: error.message, processed_at: new Date().toISOString() });
      return { status: "ignored", reason: error.code };
    }
    throw error;
  }
  const attemptRows = await optixOriginRequest(`optix_webhook_events?event_key=eq.${encodeURIComponent(eventKey)}&select=attempt_count&limit=1`).catch(() => []);
  const attemptCount = Number(attemptRows?.[0]?.attempt_count || 0) + 1;
  await updateEvent(eventKey, { processing_status: "processing", attempt_count: attemptCount });
  try {
    const mapping = await findMapping(event);
    if (!mapping || !mapping.enabled || !mapping.serviceId || !mapping.locationId) {
      const reason = !mapping ? "unmapped_workspace" : !mapping.enabled ? "disabled_mapping" : "incomplete_mapping";
      await updateEvent(eventKey, { processing_status: "ignored", failure_code: reason, error_message: null, processed_at: new Date().toISOString() });
      return { status: "ignored", reason };
    }
    const existing = await findOptixLink(event.bookingId);
    if (!existing && event.eventType !== "new_member_booking") {
      await updateEvent(eventKey, { processing_status: "ignored", failure_code: "missing_lesson_link", processed_at: new Date().toISOString() });
      return { status: "ignored", reason: "missing_lesson_link" };
    }
    const linkedItem = existing ? await assertSafeExistingLink(existing, event) : null;
    const itemId = existing?.clarity_item_id || `optix-${randomUUID()}`;
    if (event.eventType === "member_booking_cancelled" && existing) {
      await optixOriginRequest(`calendar_items?id=eq.${encodeURIComponent(itemId)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "cancelled", external_event_type: event.eventType, external_sync_state: "cancelled", external_updated_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
      });
      await optixOriginRequest(`external_booking_links?provider=eq.optix&purpose=eq.lesson&external_booking_id=eq.${encodeURIComponent(event.bookingId)}`, {
        method: "PATCH",
        body: JSON.stringify({ processing_status: "cancelled", updated_at: new Date().toISOString() }),
      });
      await updateEvent(eventKey, { processing_status: "processed", clarity_item_id: itemId, failure_code: null, error_message: null, processed_at: new Date().toISOString() });
      return { status: "processed", clarityItemId: itemId, created: false, mapping, item: { id: itemId, status: "cancelled" } };
    }
    const personId = existing?.person_id || linkedItem?.person_id || await resolvePerson(event, mapping.accountId);
    const item = createCalendarItemFromOptixBooking(event, mapping, { itemId, personId });
    if (existing) {
      await optixOriginRequest(`calendar_items?id=eq.${encodeURIComponent(itemId)}`, { method: "PATCH", body: JSON.stringify(item) });
    } else {
      await optixOriginRequest("calendar_items", { method: "POST", body: JSON.stringify([item]) });
    }
    await optixOriginRequest("external_booking_links?on_conflict=provider,purpose,external_booking_id", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify([{
        provider: "optix", purpose: "lesson", external_booking_id: event.bookingId,
        clarity_item_id: itemId, person_id: personId, origin: "optix",
        workspace_id: event.workspaceId, organisation_id: event.organisationId,
        processing_status: item.status === "cancelled" ? "cancelled" : "bay_required",
        email_status: mapping.emailBehaviour === "immediate" ? "pending" : mapping.emailBehaviour === "after_bay" ? "waiting_for_bay" : "suppressed",
        updated_at: new Date().toISOString(),
      }]),
    });
    await updateEvent(eventKey, { processing_status: "processed", clarity_item_id: itemId, failure_code: null, error_message: null, processed_at: new Date().toISOString() });
    return { status: "processed", clarityItemId: itemId, created: !existing, mapping, item };
  } catch (error: any) {
    await updateEvent(eventKey, { processing_status: "failed", failure_code: String(error?.code || "processing_failed"), error_message: error instanceof Error ? error.message.slice(0, 1000) : "Processing failed." }).catch(() => undefined);
    throw error;
  }
}

export function webhookEventKey(rawBody: string, suppliedKey = "") {
  return suppliedKey.trim() || createHash("sha256").update(rawBody).digest("hex");
}

export async function storeOptixWebhookEvent(args: { eventKey: string; eventType?: string; externalBookingId?: string; payload: unknown }) {
  const rows = await optixOriginRequest("optix_webhook_events?on_conflict=event_key", {
    method: "POST",
    headers: { prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify([{ event_key: args.eventKey, event_type: args.eventType || null, external_booking_id: args.externalBookingId || null, payload_json: args.payload, processing_status: "received" }]),
  });
  return { inserted: Array.isArray(rows) && rows.length > 0, eventKey: args.eventKey };
}
