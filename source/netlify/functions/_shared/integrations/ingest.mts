import { createHash, randomUUID } from "node:crypto";

import { createExternalPerson, matchPersonByEmail, integrationRequest, rowsOf } from "./db.mts";
import { recordPassPurchase } from "./purchases.mts";
import { text } from "./payload.mts";
import { canonicalPhoneKey } from "../phone.mts";
import { adapterFor } from "./registry.mts";
import { isPurchaseKind } from "./types.mts";
import type {
  ExternalProvider,
  IntegrationEventKind,
  IntegrationMapping,
  NormalizedBookingEvent,
  ProviderAdapter,
} from "./types.mts";

/**
 * Every inbound external booking files under this one reserved lesson type.
 * External sources reuse the same workspace for different kinds of lesson, so
 * mapping a workspace onto a specific Clarity service mislabelled bookings.
 * The only per-booking variable Clarity needs is time, which comes from the
 * event's own timestamps; the source's wording goes into the lesson note.
 * booking-core's normalizeServices() guarantees the service exists.
 */
export const EXTERNAL_BOOKING_SERVICE_ID = "external-booking";

type ExistingOptixCalendarItem = {
  id: string;
  origin: string;
  external_provider: string;
  external_booking_id: string;
  person_id: string;
};

/**
 * Whether a normalized event carries enough to act on.
 *
 * Every check reads the canonical `kind`, never the provider's own event name,
 * so a new provider inherits these rules without touching this function. The
 * provider's wording is still quoted in the messages, because "Unsupported
 * event new_sale" is what an admin needs to see in the log.
 */
export function assertProcessableEvent(event: NormalizedBookingEvent) {
  const label = event.rawEventType || "unknown";
  if (!BOOKING_KINDS.includes(event.kind)) {
    throw Object.assign(new Error(`Unsupported event ${label}.`), { code: "unsupported_event" });
  }
  if (!event.bookingId) throw Object.assign(new Error("Booking ID is missing."), { code: "missing_booking_id" });
  if (!event.workspaceId) throw Object.assign(new Error("Workspace ID is missing."), { code: "missing_workspace_id" });
  if (event.kind !== "booking.cancelled" && (!event.startIso || !event.endIso)) {
    throw Object.assign(new Error("Booking timestamps are invalid."), { code: "invalid_timestamps" });
  }
  if (event.kind !== "booking.cancelled" && !event.firstName && !event.lastName && !event.email && !event.phone) {
    throw Object.assign(new Error("Customer identity is missing. The event was not allowed to create or update a lesson."), { code: "missing_customer_identity" });
  }
}

const BOOKING_KINDS: IntegrationEventKind[] = ["booking.created", "booking.updated", "booking.cancelled"];

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

function customerName(event: NormalizedBookingEvent) {
  return [event.firstName, event.lastName].filter(Boolean).join(" ").trim() || event.email || event.phone;
}

/**
 * The lesson note as written on first import: the booking as the external
 * source words it, e.g. "Optix: Sam Hale Golf · Golf Lessons". The booking
 * itself files under the reserved External Booking lesson type, so this note
 * is where the source's own label lives. Written on create only — the note is
 * Clarity-owned after import and an inbound update never touches it.
 */
export function externalBookingNote(event: NormalizedBookingEvent, mapping: IntegrationMapping) {
  const parts = [event.workspaceName || mapping.workspaceName, event.workspaceType]
    .map((part) => (part || "").trim())
    .filter(Boolean);
  const unique = parts.filter((part, index) => parts.indexOf(part) === index);
  return unique.length ? `Optix: ${unique.join(" · ")}` : "Optix booking";
}

function optixOwnedFields(event: NormalizedBookingEvent, mapping: IntegrationMapping) {
  const slot = calendarSlot(event.startIso, event.timezone);
  const derivedDuration = Math.max(1, Math.round((Date.parse(event.endIso) - Date.parse(event.startIso)) / 60_000));
  return {
    ...slot,
    duration: derivedDuration || mapping.expectedDuration || 60,
    status: event.kind === "booking.cancelled" ? "cancelled" : "booked",
    external_event_type: event.rawEventType,
    external_source: event.source,
    // A moved booking leaves any bay reservation at the old time, so the bay has
    // to be claimed again. This is the inbound lesson's state, never the
    // outbound bay's — that lives in optix_booking_sync.sync_status.
    external_sync_state: event.kind === "booking.cancelled" ? "cancelled" : "bay_required",
    external_updated_at: new Date().toISOString(),
  };
}

/**
 * Fields an inbound event is allowed to change on a booking that already exists.
 *
 * Optix owns when the booking is. Clarity owns everything an admin can edit
 * after import — coach, note, location, the lesson type, and the customer
 * link. Previously the whole item was rebuilt and PATCHed, so every reschedule
 * reset the coach to the mapping default and blanked the note.
 *
 * service_id is absent here by design: a booking imports under the reserved
 * External Booking type, and an inbound event may never reclassify it after
 * an admin has had the chance to touch it.
 */
export function updateCalendarItemFromOptixBooking(event: NormalizedBookingEvent, mapping: IntegrationMapping) {
  return { ...optixOwnedFields(event, mapping), updated_at: new Date().toISOString() };
}

export function createCalendarItemFromOptixBooking(event: NormalizedBookingEvent, mapping: IntegrationMapping, ids: { itemId: string; personId: string }) {
  const client = customerName(event);
  if (!client) throw Object.assign(new Error("Optix customer identity is missing."), { code: "missing_customer_identity" });
  return {
    ...optixOwnedFields(event, mapping),
    id: ids.itemId,
    account_id: mapping.accountId,
    kind: "appointment",
    coach_id: mapping.defaultCoachId || "",
    location_id: mapping.locationId,
    service_id: EXTERNAL_BOOKING_SERVICE_ID,
    client,
    title: client,
    phone: event.phone,
    email: event.email,
    person_id: ids.personId,
    note: externalBookingNote(event, mapping),
    coach: null,
    location: { locationId: mapping.locationId, timezone: event.timezone },
    custom_group: null,
    origin: mapping.provider,
    external_provider: mapping.provider,
    external_booking_id: event.bookingId,
    external_workspace_id: event.workspaceId,
    external_organisation_id: event.organisationId,
  };
}

export type ExistingBookingCandidate = {
  id?: unknown; client?: unknown; email?: unknown; phone?: unknown;
  start?: unknown; duration?: unknown; status?: unknown;
};

function normalisedName(value: unknown) {
  return text(value).toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The booking Clarity already holds for this lesson, if it has one.
 *
 * Idempotency on the external booking ID stops the same webhook creating two
 * records, but it cannot see that the coach already had the lesson on the
 * calendar, or that Optix cancelled a booking and issued a fresh ID for the
 * same slot. Both arrive looking like a brand-new booking, and both produced
 * duplicates sitting on top of real lessons.
 *
 * A booked lesson overlapping this one for the same customer is that lesson
 * arriving twice. Cancelled records are skipped: they are history, and the slot
 * is genuinely free again.
 */
export function findDuplicateBooking(
  candidates: ExistingBookingCandidate[],
  event: NormalizedBookingEvent,
  slot: { start: number; duration: number },
): string | null {
  const email = text(event.email).toLowerCase();
  const phoneKey = canonicalPhoneKey(event.phone);
  const name = normalisedName([event.firstName, event.lastName].filter(Boolean).join(" "));
  const end = slot.start + slot.duration;
  for (const row of rowsOf(candidates) as ExistingBookingCandidate[]) {
    if (text(row?.status).toLowerCase() === "cancelled") continue;
    const rowStart = Number(row?.start ?? NaN);
    if (!Number.isFinite(rowStart)) continue;
    const rowEnd = rowStart + Number(row?.duration ?? 0);
    if (rowStart >= end || slot.start >= rowEnd) continue;
    const rowEmail = text(row?.email).toLowerCase();
    const rowPhone = canonicalPhoneKey(row?.phone);
    const rowName = normalisedName(row?.client);
    // Name alone is enough here, unlike customer matching: the slot is already
    // taken, so this is "is this the same lesson", not "is this the same person
    // across the whole client list".
    const sameCustomer =
      (Boolean(email) && email === rowEmail) ||
      (Boolean(phoneKey) && phoneKey === rowPhone) ||
      (Boolean(name) && name === rowName);
    if (sameCustomer) return text(row?.id) || null;
  }
  return null;
}

async function findExistingBookingForEvent(event: NormalizedBookingEvent, mapping: IntegrationMapping) {
  const slot = calendarSlot(event.startIso, event.timezone);
  const duration = Math.max(1, Math.round((Date.parse(event.endIso) - Date.parse(event.startIso)) / 60_000));
  const rows = await integrationRequest(
    `calendar_items?account_id=eq.${encodeURIComponent(mapping.accountId)}&kind=eq.appointment&week=eq.${slot.week}&day=eq.${slot.day}&select=id,client,email,phone,start,duration,status&limit=200`,
  );
  return findDuplicateBooking(rowsOf(rows), event, { start: slot.start, duration: duration || 60 });
}

/**
 * A tombstone: the link row left behind when an admin deletes an imported
 * lesson. It has no calendar item, and its meaning is "never import this
 * booking again" — whatever event Optix sends about it later.
 */
export function isDeletedInClarityLink(link: any): boolean {
  return Boolean(link) && text(link?.processing_status) === "deleted_in_clarity";
}

export async function findExternalLink(provider: ExternalProvider, externalBookingId: string, purpose = "lesson") {
  const rows = await integrationRequest(`external_booking_links?provider=eq.${provider}&purpose=eq.${purpose}&external_booking_id=eq.${encodeURIComponent(externalBookingId)}&limit=1`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function readLinkedCalendarItem(itemId: string): Promise<ExistingOptixCalendarItem | null> {
  const rows = await integrationRequest(`calendar_items?id=eq.${encodeURIComponent(itemId)}&select=id,origin,external_provider,external_booking_id,person_id&limit=1`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function assertSafeExistingLink(existing: any, event: NormalizedBookingEvent, provider: ExternalProvider) {
  const itemId = text(existing?.clarity_item_id);
  if (!itemId) throw Object.assign(new Error("The Optix link has no Clarity appointment ID."), { code: "unsafe_existing_link" });
  const item = await readLinkedCalendarItem(itemId);
  const ownsItem = item && item.origin === provider && item.external_provider === provider && item.external_booking_id === event.bookingId;
  if (!ownsItem) {
    throw Object.assign(new Error("Blocked an Optix event from overwriting an appointment that Optix does not exclusively own."), { code: "unsafe_existing_link" });
  }
  return item;
}

async function findMapping(event: NormalizedBookingEvent, provider: ExternalProvider): Promise<IntegrationMapping | null> {
  const query = `external_booking_mappings?provider=eq.${provider}&organisation_id=eq.${encodeURIComponent(event.organisationId)}&workspace_id=eq.${encodeURIComponent(event.workspaceId)}&limit=1`;
  let rows = await integrationRequest(query);
  if (!Array.isArray(rows) || !rows.length) {
    rows = await integrationRequest(`external_booking_mappings?provider=eq.${provider}&workspace_id=eq.${encodeURIComponent(event.workspaceId)}&limit=1`);
  }
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  return {
    id: row.id,
    provider,
    organisationId: text(row.organisation_id),
    workspaceId: text(row.workspace_id),
    workspaceName: text(row.workspace_name),
    accountId: text(row.account_id),
    locationId: text(row.location_id),
    defaultCoachId: text(row.default_coach_id) || null,
    enabled: row.enabled === true,
    expectedDuration: Number.isFinite(Number(row.expected_duration)) ? Number(row.expected_duration) : null,
    bayProfileId: text(row.bay_profile_id) || null,
    emailBehaviour: ["immediate", "after_bay"].includes(row.email_behaviour) ? row.email_behaviour : "none",
  };
}

async function resolvePerson(event: NormalizedBookingEvent, accountId: string, provider: ExternalProvider) {
  const name = customerName(event);
  if (!name) throw Object.assign(new Error("Optix customer identity is missing."), { code: "missing_customer_identity" });
  const account = encodeURIComponent(accountId);

  // Email is the only auto-match. When it matches exactly one person —
  // external or main — the booking files under that client id; anything less
  // certain becomes a new external booking client for the admin to merge.
  if (event.email) {
    const rows = await integrationRequest(`people?account_id=eq.${account}&email=ilike.${encodeURIComponent(event.email)}&select=id,name,email,phone&limit=10`);
    const matched = matchPersonByEmail(rowsOf(rows), event.email);
    if (matched) return matched;
  }

  return createExternalPerson(accountId, provider, { name, email: event.email || null, phone: event.phone || null });
}

async function updateEvent(eventKey: string, values: Record<string, unknown>) {
  await integrationRequest(`optix_webhook_events?event_key=eq.${encodeURIComponent(eventKey)}`, { method: "PATCH", body: JSON.stringify({ ...values, updated_at: new Date().toISOString() }) });
}

/**
 * Turn one stored inbound event into whatever it means for Clarity.
 *
 * The provider is passed in rather than inferred: an event's payload is the
 * provider's business, and guessing who sent something from the shape of it is
 * how two integrations start stealing each other's traffic. The caller knows —
 * it is the endpoint the delivery arrived on.
 */
export async function processStoredExternalEvent(
  provider: ExternalProvider,
  eventKey: string,
  payload: unknown,
) {
  const adapter = adapterFor(provider);
  if (!adapter) {
    await updateEvent(eventKey, {
      processing_status: "ignored",
      failure_code: "unknown_provider",
      error_message: `Clarity has no adapter for "${provider}".`,
      processed_at: new Date().toISOString(),
    }).catch(() => undefined);
    return { status: "ignored", reason: "unknown_provider" };
  }

  // Some events are structurally fine but none of Clarity's business — a
  // mirror of a calendar Clarity does not own, say. Only the adapter can tell,
  // so it is asked first, before anything is normalised or written. This is a
  // stated result, not a failure: stored, ignored, never retried.
  const ignore = adapter.ignoreReason?.(payload);
  if (ignore) {
    await updateEvent(eventKey, {
      processing_status: "ignored",
      failure_code: ignore.code,
      error_message: ignore.message,
      processed_at: new Date().toISOString(),
    });
    return { status: "ignored", reason: ignore.code };
  }

  // Purchase events are a different shape entirely — no booking, no workspace,
  // no times — so they branch before the booking normaliser touches them.
  if (isPurchaseKind(adapter.eventKind(payload))) {
    try {
      const recorded = await recordPassPurchase(adapter, eventKey, payload);
      await updateEvent(eventKey, {
        processing_status: "processed",
        failure_code: recorded.isPass ? null : recorded.classification,
        error_message: null,
        processed_at: new Date().toISOString(),
      });
      return { status: "processed", purpose: "purchase", ...recorded };
    } catch (error: any) {
      await updateEvent(eventKey, {
        processing_status: "failed",
        failure_code: String(error?.code || "purchase_record_failed"),
        error_message: error instanceof Error ? error.message.slice(0, 1000) : "Purchase could not be recorded.",
      }).catch(() => undefined);
      throw error;
    }
  }

  // invoice_paid is deliberately unhandled: its payload holds no purchase
  // detail, and the real new_sale payload carries no invoice_id to join it to,
  // so there is nothing it could ever stamp. Sales are recorded as paid at
  // purchase instead (Optix takes the money when the sale is made). It falls
  // through here and is stored as ignored with the other unsupported events.

  const event = adapter.normalizeBooking(payload);
  try {
    assertProcessableEvent(event);
  } catch (error: any) {
    if (error?.code === "unsupported_event") {
      await updateEvent(eventKey, { processing_status: "ignored", failure_code: error.code, error_message: error.message, processed_at: new Date().toISOString() });
      return { status: "ignored", reason: error.code };
    }
    // Anything else (missing booking id, bad timestamps, no recoverable
    // identity) used to propagate straight out of this function with the row
    // still sitting at "received" — never marked failed, so it was invisible
    // to the retry UI and silently never processed. Every rejection now has to
    // land in a terminal, visible status before it's rethrown.
    await updateEvent(eventKey, { processing_status: "failed", failure_code: String(error?.code || "invalid_event"), error_message: error instanceof Error ? error.message.slice(0, 1000) : "Event failed validation." }).catch(() => undefined);
    throw error;
  }
  const attemptRows = await integrationRequest(`optix_webhook_events?event_key=eq.${encodeURIComponent(eventKey)}&select=attempt_count&limit=1`).catch(() => []);
  const attemptCount = Number(attemptRows?.[0]?.attempt_count || 0) + 1;
  await updateEvent(eventKey, { processing_status: "processing", attempt_count: attemptCount });
  try {
    const mapping = await findMapping(event, provider);
    // No service check: every inbound booking files under the reserved
    // External Booking lesson type, so only a location still needs choosing.
    if (!mapping || !mapping.enabled || !mapping.locationId) {
      const reason = !mapping ? "unmapped_workspace" : !mapping.enabled ? "disabled_mapping" : "incomplete_mapping";
      await updateEvent(eventKey, { processing_status: "ignored", failure_code: reason, error_message: null, processed_at: new Date().toISOString() });
      return { status: "ignored", reason };
    }
    const existing = await findExternalLink(provider, event.bookingId);
    // A tombstone means an admin deliberately deleted this booking in Clarity.
    // Whatever Optix says about it later — a redelivered creation, an update,
    // even its own cancellation — the booking is not allowed to reappear on
    // the calendar. Checked before assertSafeExistingLink, which would choke
    // on the tombstone's NULL clarity_item_id.
    if (isDeletedInClarityLink(existing)) {
      await updateEvent(eventKey, {
        processing_status: "ignored",
        failure_code: "deleted_in_clarity",
        error_message: "This booking was deleted in Clarity by an admin, so the event was not re-imported.",
        processed_at: new Date().toISOString(),
      });
      return { status: "ignored", reason: "deleted_in_clarity" };
    }
    if (!existing && event.kind !== "booking.created") {
      await updateEvent(eventKey, { processing_status: "ignored", failure_code: "missing_lesson_link", processed_at: new Date().toISOString() });
      return { status: "ignored", reason: "missing_lesson_link" };
    }
    const linkedItem = existing ? await assertSafeExistingLink(existing, event, provider) : null;
    const itemId = existing?.clarity_item_id || `${adapter.itemIdPrefix}-${randomUUID()}`;
    if (event.kind === "booking.cancelled" && existing) {
      await integrationRequest(`calendar_items?id=eq.${encodeURIComponent(itemId)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "cancelled", external_event_type: event.rawEventType, external_sync_state: "cancelled", external_updated_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
      });
      await integrationRequest(`external_booking_links?provider=eq.${provider}&purpose=eq.lesson&external_booking_id=eq.${encodeURIComponent(event.bookingId)}`, {
        method: "PATCH",
        body: JSON.stringify({ processing_status: "cancelled", updated_at: new Date().toISOString() }),
      });
      await updateEvent(eventKey, { processing_status: "processed", clarity_item_id: itemId, failure_code: null, error_message: null, processed_at: new Date().toISOString() });
      return { status: "processed", clarityItemId: itemId, created: false, mapping, item: { id: itemId, status: "cancelled" } };
    }
    // Only on first sight of a booking. An event for a booking Clarity already
    // tracks is an update, and belongs on its own record however the slot looks.
    if (!existing) {
      const duplicateOf = await findExistingBookingForEvent(event, mapping);
      if (duplicateOf) {
        await updateEvent(eventKey, {
          processing_status: "ignored",
          failure_code: "duplicate_existing_booking",
          error_message: `This lesson is already on the calendar as ${duplicateOf}, so no second copy was created.`,
          clarity_item_id: duplicateOf,
          processed_at: new Date().toISOString(),
        });
        return { status: "ignored", reason: "duplicate_existing_booking", clarityItemId: duplicateOf };
      }
    }
    const personId = existing?.person_id || linkedItem?.person_id || await resolvePerson(event, mapping.accountId, provider);
    const item = createCalendarItemFromOptixBooking(event, mapping, { itemId, personId });
    if (existing) {
      // Patch only what Optix owns. Rebuilding the whole item here is what used
      // to reset the coach and blank the note on every reschedule.
      await integrationRequest(`calendar_items?id=eq.${encodeURIComponent(itemId)}`, { method: "PATCH", body: JSON.stringify(updateCalendarItemFromOptixBooking(event, mapping)) });
    } else {
      await integrationRequest("calendar_items", { method: "POST", body: JSON.stringify([item]) });
    }
    await integrationRequest("external_booking_links?on_conflict=provider,purpose,external_booking_id", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify([{
        provider, purpose: "lesson", external_booking_id: event.bookingId,
        clarity_item_id: itemId, person_id: personId, origin: provider,
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
  const rows = await integrationRequest("optix_webhook_events?on_conflict=event_key", {
    method: "POST",
    headers: { prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify([{ event_key: args.eventKey, event_type: args.eventType || null, external_booking_id: args.externalBookingId || null, payload_json: args.payload, processing_status: "received" }]),
  });
  return { inserted: Array.isArray(rows) && rows.length > 0, eventKey: args.eventKey };
}
