/**
 * Every /api/v1 route: what it needs, and what it does.
 *
 * Reads go straight to the tables, account-scoped in SQL. Writes go through
 * the same functions the booking page and the calendar use -- the API is a
 * new door into Clarity, not a second copy of it -- so availability rules,
 * confirmation emails, bay booking, Google sync and client matching all apply
 * to a booking made here exactly as to one made anywhere else.
 */
import { getDatabase } from "@netlify/database";
import {
  createPublicBooking,
  readCalendarState,
  readPublicSlotContext,
  publicBookingSlots,
  reschedulePublicBooking,
  upsertCalendarItemForAccount,
} from "../../booking-core.mts";
import { readPeople, updatePerson } from "../clients.mts";
import { primaryServiceLocationId } from "../service-scope.mts";
import {
  ApiError,
  decodeCursor,
  invalid,
  isoParam,
  listPage,
  notFound,
  pageLimit,
  requireStr,
  str,
} from "./http.mts";
import type { ApiPrincipal, ApiScope } from "./keys.mts";
import {
  bookingFromRow,
  clientFromRow,
  coachObject,
  isoToSlot,
  isoToSlotKey,
  locationObject,
  serviceObject,
  slotKey,
  slotToIso,
  zoneForLocation,
  type Catalog,
} from "./serialize.mts";
import {
  createEndpoint,
  deleteEndpoint,
  EndpointInputError,
  EVENT_TYPES,
  eventEnvelope,
  listEndpoints,
  readEndpoint,
  updateEndpoint,
} from "./events.mts";
import { commerceHandlers as commerce } from "./commerce.mts";
import { salesHandlers as sales } from "./sales.mts";

export type RouteContext = {
  principal: ApiPrincipal;
  url: URL;
  params: string[];
  body: Record<string, unknown>;
  netlifyContext: unknown;
  catalog: () => Promise<Catalog>;
};

export type Route = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** As written in the docs and the OpenAPI spec: `/bookings/:id/cancel`. */
  path: string;
  pattern: RegExp;
  scope: ApiScope | null;
  handler: (ctx: RouteContext) => Promise<{ status?: number; body: unknown }>;
};

function db() {
  return getDatabase();
}

/** A domain error (plain Error with .status) in the API's words. The handler applies it, so the original is still what gets logged. */
export function domainError(error: any): ApiError {
  if (error instanceof ApiError) return error;
  const status = Number(error?.status || 500);
  const message = error instanceof Error ? error.message : "Something went wrong.";
  if (status === 400) return invalid(String(error?.code || "invalid_request"), message);
  if (status === 403) return new ApiError("permission_error", String(error?.code || "not_permitted"), message);
  if (status === 404) return new ApiError("not_found_error", "resource_missing", message);
  if (status === 409) return new ApiError("conflict_error", String(error?.detail?.reason || "slot_unavailable"), message);
  return new ApiError("api_error", "internal_error", "Something went wrong on Clarity's side. Try again, and quote the request id if it persists.");
}

const ok = (body: unknown, status = 200) => ({ status, body });

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

async function getMe(ctx: RouteContext) {
  const catalog = await ctx.catalog();
  const [key] = await db().sql`SELECT id, name, mode, scopes FROM api_keys WHERE id = ${ctx.principal.keyId}`;
  return ok({
    object: "account",
    id: catalog.accountId,
    name: catalog.name,
    livemode: catalog.livemode,
    timezone: catalog.timezone,
    currency: catalog.currency,
    country: catalog.country,
    api_key: { id: key?.id, name: key?.name || "", scopes: [...ctx.principal.scopes] },
  });
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

function staticList(data: unknown[]) {
  return { object: "list", data, has_more: false, next_cursor: null };
}

async function listServices(ctx: RouteContext) {
  const catalog = await ctx.catalog();
  let services = catalog.services.map((service) => serviceObject(service, catalog));
  if (ctx.url.searchParams.get("bookable_online") === "true") services = services.filter((service) => service.bookable_online);
  return ok(staticList(services));
}

async function getService(ctx: RouteContext) {
  const catalog = await ctx.catalog();
  const service = catalog.services.find((entry) => entry?.id === ctx.params[0]);
  if (!service) throw notFound("service", ctx.params[0]);
  return ok(serviceObject(service, catalog));
}

async function listCoaches(ctx: RouteContext) {
  const catalog = await ctx.catalog();
  return ok(staticList(catalog.coaches.map(coachObject)));
}

async function getCoach(ctx: RouteContext) {
  const catalog = await ctx.catalog();
  const coach = catalog.coaches.find((entry) => entry?.id === ctx.params[0]);
  if (!coach) throw notFound("coach", ctx.params[0]);
  return ok(coachObject(coach));
}

async function listLocations(ctx: RouteContext) {
  const catalog = await ctx.catalog();
  return ok(staticList(catalog.locations.map((location) => locationObject(location, catalog))));
}

async function getLocation(ctx: RouteContext) {
  const catalog = await ctx.catalog();
  const location = catalog.locations.find((entry) => entry?.id === ctx.params[0]);
  if (!location) throw notFound("location", ctx.params[0]);
  return ok(locationObject(location, catalog));
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

const MAX_AVAILABILITY_DAYS = 31;

async function getAvailability(ctx: RouteContext) {
  const catalog = await ctx.catalog();
  const serviceId = str(ctx.url.searchParams.get("service_id"), 140);
  if (!serviceId) throw invalid("parameter_missing", "'service_id' is required.", "service_id");
  const fromIso = isoParam(ctx.url.searchParams.get("start"), "start") || new Date().toISOString();
  const toIso =
    isoParam(ctx.url.searchParams.get("end"), "end") ||
    new Date(Date.parse(fromIso) + 7 * 86_400_000).toISOString();
  const spanDays = (Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000;
  if (spanDays <= 0) throw invalid("parameter_invalid", "'end' must be after 'start'.", "end");
  if (spanDays > MAX_AVAILABILITY_DAYS) {
    throw invalid("parameter_invalid", `Ask for at most ${MAX_AVAILABILITY_DAYS} days at a time.`, "end");
  }
  const coachId = str(ctx.url.searchParams.get("coach_id"), 140);
  const locationId = str(ctx.url.searchParams.get("location_id"), 140);

  // The slot engine thinks in grid weeks. Read every week the range touches,
  // one day either side to cover a location in another zone.
  const firstWeek = isoToSlot(new Date(Date.parse(fromIso) - 86_400_000).toISOString(), catalog.timezone).week;
  const lastWeek = isoToSlot(new Date(Date.parse(toIso) + 86_400_000).toISOString(), catalog.timezone).week;
  const slots: Array<Record<string, unknown>> = [];
  for (let week = firstWeek; week <= lastWeek; week += 1) {
    let result: any;
    try {
      const context = await readPublicSlotContext({ accountId: ctx.principal.accountId, serviceId, week });
      result = publicBookingSlots(context, { week, serviceId });
    } catch (error: any) {
      if (Number(error?.status) === 404) {
        throw invalid("service_not_bookable", "That service does not exist or is not bookable online.", "service_id");
      }
      throw error;
    }
    const service = catalog.services.find((entry) => entry?.id === serviceId);
    for (const slot of result?.services?.[serviceId]?.slots || []) {
      if (coachId && slot.coachId !== coachId) continue;
      if (locationId && slot.locationId !== locationId) continue;
      const zone = zoneForLocation(catalog, slot.locationId || primaryServiceLocationId(service));
      const start = slotToIso(slot.week, slot.day, slot.start, zone);
      const startMs = Date.parse(start);
      if (startMs < Date.parse(fromIso) || startMs >= Date.parse(toIso)) continue;
      slots.push({
        object: "slot",
        start,
        end: slotToIso(slot.week, slot.day, slot.start + Number(service?.duration || 0), zone),
        timezone: zone,
        service_id: serviceId,
        coach_id: slot.coachId || null,
        location_id: slot.locationId || null,
        remaining_spots: Number(slot.remainingSpots ?? 1),
      });
    }
  }
  slots.sort((a, b) => Date.parse(String(a.start)) - Date.parse(String(b.start)));
  return ok(staticList(slots));
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

const BOOKING_STATUSES = ["booked", "completed", "cancelled", "no_show"];
const SLOT_KEY_SQL = "(week * 10080 + day * 1440 + start)";

async function listBookings(ctx: RouteContext) {
  const catalog = await ctx.catalog();
  const q = ctx.url.searchParams;
  const limit = pageLimit(ctx.url);
  const where = ["account_id = $1", "kind = 'appointment'"];
  const values: unknown[] = [ctx.principal.accountId];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    where.push(sql.replace("?", `$${values.length}`));
  };
  const startAfter = isoParam(q.get("start_after"), "start_after");
  const startBefore = isoParam(q.get("start_before"), "start_before");
  if (startAfter) add(`${SLOT_KEY_SQL} >= ?`, isoToSlotKey(startAfter, catalog.timezone));
  if (startBefore) add(`${SLOT_KEY_SQL} < ?`, isoToSlotKey(startBefore, catalog.timezone));
  const updatedSince = isoParam(q.get("updated_since"), "updated_since");
  if (updatedSince) add("updated_at >= ?", updatedSince);
  const status = str(q.get("status"), 20);
  if (status) {
    if (!BOOKING_STATUSES.includes(status)) {
      throw invalid("parameter_invalid", `'status' must be one of ${BOOKING_STATUSES.join(", ")}.`, "status");
    }
    add("COALESCE(status, 'booked') = ?", status);
  }
  for (const [param, column] of [
    ["client_id", "person_id"],
    ["coach_id", "coach_id"],
    ["service_id", "service_id"],
    ["location_id", "location_id"],
  ] as const) {
    const value = str(q.get(param), 140);
    if (value) add(`${column} = ?`, value);
  }
  const email = str(q.get("client_email"), 180).toLowerCase();
  if (email) add("lower(email) = ?", email);
  const cursor = decodeCursor(ctx.url);
  if (cursor) {
    values.push(Number(cursor[0]), String(cursor[1]));
    where.push(`(${SLOT_KEY_SQL}, id) > ($${values.length - 1}, $${values.length})`);
  }
  values.push(limit + 1);
  const { rows } = await db().pool.query(
    `SELECT * FROM calendar_items WHERE ${where.join(" AND ")}
     ORDER BY ${SLOT_KEY_SQL}, id LIMIT $${values.length}`,
    values,
  );
  return ok(
    listPage(
      rows,
      limit,
      (row: any) => [slotKey(Number(row.week), Number(row.day), Number(row.start)), row.id],
      (row: any) => bookingFromRow(row, catalog),
    ),
  );
}

async function readBookingRow(accountId: string, id: string) {
  const [row] = await db().sql`
    SELECT * FROM calendar_items WHERE id = ${id} AND account_id = ${accountId} AND kind = 'appointment'
  `;
  return row || null;
}

async function getBooking(ctx: RouteContext) {
  const row = await readBookingRow(ctx.principal.accountId, ctx.params[0]);
  if (!row) throw notFound("booking", ctx.params[0]);
  return ok(bookingFromRow(row, await ctx.catalog()));
}

function splitName(name: string) {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return { first: parts[0] || "", last: "" };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

/** Where a booking made for this service would sit, so its time is read in the right zone. */
function zoneForBooking(catalog: Catalog, serviceId: string, locationId: string) {
  const service = catalog.services.find((entry) => entry?.id === serviceId);
  return zoneForLocation(catalog, locationId || primaryServiceLocationId(service));
}

async function createBooking(ctx: RouteContext) {
  const catalog = await ctx.catalog();
  const serviceId = requireStr(ctx.body, "service_id", 140);
  const startIso = isoParam(requireStr(ctx.body, "start", 60), "start");
  if (Date.parse(startIso) <= Date.now()) throw invalid("parameter_invalid", "'start' must be in the future.", "start");
  const coachId = str(ctx.body.coach_id, 140);
  const locationId = str(ctx.body.location_id, 140);

  let client = (ctx.body.client && typeof ctx.body.client === "object" ? ctx.body.client : {}) as Record<string, unknown>;
  const clientId = str(ctx.body.client_id, 140);
  if (clientId) {
    const person = (await readPeople(ctx.principal.accountId)).find((entry: any) => entry.id === clientId);
    if (!person) throw notFound("client", clientId);
    const name = splitName(person.name || "");
    client = { first_name: name.first, last_name: name.last, email: person.email, phone: person.phone, ...client };
  }
  const firstName = str(client.first_name, 80);
  const lastName = str(client.last_name, 80);
  const email = str(client.email, 180);
  if (!firstName) throw invalid("parameter_missing", "'client.first_name' is required.", "client.first_name");
  if (!lastName) throw invalid("parameter_missing", "'client.last_name' is required.", "client.last_name");
  if (!email) throw invalid("parameter_missing", "'client.email' is required.", "client.email");

  const slot = isoToSlot(startIso, zoneForBooking(catalog, serviceId, locationId));
  const [key] = await db().sql`SELECT name FROM api_keys WHERE id = ${ctx.principal.keyId}`;
  let result: any;
  try {
    result = await createPublicBooking(
      ctx.principal.accountId,
      {
        serviceId,
        week: slot.week,
        day: slot.day,
        start: slot.start,
        coachId,
        locationId,
        firstName,
        lastName,
        email,
        phone: str(client.phone, 80),
        notes: str(ctx.body.notes, 800),
        handedness: str(ctx.body.handedness, 10),
        bookedVia: key?.name ? `the Clarity API (${String(key.name).slice(0, 60)})` : "the Clarity API",
      },
      ctx.netlifyContext as any,
    );
  } catch (error: any) {
    if (Number(error?.status) === 400 && /public lesson type/i.test(String(error?.message))) {
      throw invalid("service_not_bookable", "That service does not exist or is not bookable online.", "service_id");
    }
    throw error;
  }
  const row = await readBookingRow(ctx.principal.accountId, result.appointment.id);
  return ok(row ? bookingFromRow(row, catalog) : { id: result.appointment.id, object: "booking" }, 201);
}

async function cancelBooking(ctx: RouteContext) {
  const accountId = ctx.principal.accountId;
  const catalog = await ctx.catalog();
  const current: any = await readCalendarState(accountId);
  const item = (current.items || []).find((entry: any) => entry.id === ctx.params[0] && entry.kind === "appointment");
  if (!item) throw notFound("booking", ctx.params[0]);
  // Cancelling twice is not an error: the booking is in the state asked for.
  if (item.status !== "cancelled") {
    const reason = str(ctx.body.reason, 300);
    const next = {
      ...item,
      status: "cancelled",
      note: reason ? [item.note, `Cancelled through the Clarity API: ${reason}`].filter(Boolean).join("\n") : item.note,
    };
    await upsertCalendarItemForAccount(accountId, next, current, ctx.netlifyContext as any);
  }
  const row = await readBookingRow(accountId, ctx.params[0]);
  return ok(bookingFromRow(row, catalog));
}

async function rescheduleBooking(ctx: RouteContext) {
  const accountId = ctx.principal.accountId;
  const catalog = await ctx.catalog();
  const existing = await readBookingRow(accountId, ctx.params[0]);
  if (!existing) throw notFound("booking", ctx.params[0]);
  if (existing.status && existing.status !== "booked") {
    throw new ApiError("conflict_error", "booking_not_active", `A ${existing.status} booking cannot be rescheduled.`);
  }
  const startIso = isoParam(requireStr(ctx.body, "start", 60), "start");
  if (Date.parse(startIso) <= Date.now()) throw invalid("parameter_invalid", "'start' must be in the future.", "start");
  const current = bookingFromRow(existing, catalog);
  const slot = isoToSlot(startIso, String(current.timezone));
  await reschedulePublicBooking(
    accountId,
    { appointmentId: existing.id, week: slot.week, day: slot.day, start: slot.start },
    ctx.netlifyContext as any,
    { contactVerified: true },
  );
  return ok(bookingFromRow(await readBookingRow(accountId, existing.id), catalog));
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

async function listClients(ctx: RouteContext) {
  const q = ctx.url.searchParams;
  const limit = pageLimit(ctx.url);
  const where = ["account_id = $1"];
  const values: unknown[] = [ctx.principal.accountId];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    where.push(sql.replace("?", `$${values.length}`));
  };
  const email = str(q.get("email"), 180).toLowerCase();
  if (email) add("lower(email) = ?", email);
  const phone = str(q.get("phone"), 80).replace(/\D/g, "");
  if (phone) add("regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') LIKE ?", `%${phone}`);
  const search = str(q.get("q"), 80).toLowerCase();
  if (search) {
    values.push(`%${search}%`);
    where.push(`(lower(name) LIKE $${values.length} OR lower(COALESCE(email, '')) LIKE $${values.length})`);
  }
  const updatedSince = isoParam(q.get("updated_since"), "updated_since");
  if (updatedSince) add("updated_at >= ?", updatedSince);
  const cursor = decodeCursor(ctx.url);
  if (cursor) {
    values.push(String(cursor[0]), String(cursor[1]));
    where.push(`(created_at, id) > ($${values.length - 1}::timestamptz, $${values.length})`);
  }
  values.push(limit + 1);
  const { rows } = await db().pool.query(
    `SELECT * FROM people WHERE ${where.join(" AND ")} ORDER BY created_at, id LIMIT $${values.length}`,
    values,
  );
  return ok(
    listPage(
      rows,
      limit,
      (row: any) => [new Date(row.created_at).toISOString(), row.id],
      (row: any) => clientFromRow(row),
    ),
  );
}

async function readClientRow(accountId: string, id: string) {
  const [row] = await db().sql`SELECT * FROM people WHERE id = ${id} AND account_id = ${accountId}`;
  return row || null;
}

async function getClient(ctx: RouteContext) {
  const row = await readClientRow(ctx.principal.accountId, ctx.params[0]);
  if (!row) throw notFound("client", ctx.params[0]);
  return ok(clientFromRow(row));
}

function clientInput(body: Record<string, unknown>) {
  const joined = [str(body.first_name, 80), str(body.last_name, 80)].filter(Boolean).join(" ");
  return {
    name: str(body.name, 180) || joined,
    email: str(body.email, 180),
    phone: str(body.phone, 80),
    notes: str(body.notes, 1200),
  };
}

/**
 * Creating a client who is already on file returns that client (200) rather
 * than a duplicate (201). Same matching the booking page uses: a name plus a
 * compatible email or phone is the same person.
 */
async function createClient(ctx: RouteContext) {
  const input = clientInput(ctx.body);
  if (!input.name && !input.email) throw invalid("parameter_missing", "A client needs a 'name' or an 'email'.", "name");
  const known = await db().sql`SELECT id FROM people WHERE account_id = ${ctx.principal.accountId}`;
  const knownIds = new Set(known.map((entry: any) => String(entry.id)));
  const result: any = await updatePerson({ ...input, source: "api" }, ctx.principal.accountId);
  const created = !knownIds.has(String(result.person.id));
  const row = await readClientRow(ctx.principal.accountId, result.person.id);
  return ok(clientFromRow(row), created ? 201 : 200);
}

async function updateClient(ctx: RouteContext) {
  const existing = await readClientRow(ctx.principal.accountId, ctx.params[0]);
  if (!existing) throw notFound("client", ctx.params[0]);
  const input = clientInput(ctx.body);
  const has = (key: string) => Object.prototype.hasOwnProperty.call(ctx.body, key);
  const merged = {
    id: existing.id,
    name: has("name") || has("first_name") || has("last_name") ? input.name : existing.name,
    email: has("email") ? input.email : existing.email || "",
    phone: has("phone") ? input.phone : existing.phone || "",
    notes: has("notes") ? input.notes : existing.notes || "",
    source: existing.source || "",
    caddyProfileId: existing.caddy_profile_id || "",
    caddyProfileUrl: existing.caddy_profile_url || "",
  };
  await updatePerson(merged, ctx.principal.accountId);
  return ok(clientFromRow(await readClientRow(ctx.principal.accountId, existing.id)));
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function eventFromRow(row: any, livemode: boolean) {
  return eventEnvelope({
    id: row.id,
    type: row.type,
    accountId: row.account_id,
    livemode,
    createdAt: new Date(row.created_at).toISOString(),
    data: row.data,
  });
}

/**
 * The event feed, oldest first. Polling integrations (Zapier's polling
 * triggers, a nightly sync) page through it with `cursor`; the cursor of the
 * last page is where to resume next time. Kept for 30 days.
 */
async function listEvents(ctx: RouteContext) {
  const catalog = await ctx.catalog();
  const q = ctx.url.searchParams;
  const limit = pageLimit(ctx.url, 50);
  const where = ["account_id = $1"];
  const values: unknown[] = [ctx.principal.accountId];
  const types = (q.get("type") || "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (types.length) {
    values.push(types);
    where.push(`type = ANY($${values.length})`);
  }
  const objectId = str(q.get("object_id"), 140);
  if (objectId) {
    values.push(objectId);
    where.push(`object_id = $${values.length}`);
  }
  const createdAfter = isoParam(q.get("created_after"), "created_after");
  if (createdAfter) {
    values.push(createdAfter);
    where.push(`created_at > $${values.length}`);
  }
  const cursor = decodeCursor(ctx.url);
  if (cursor) {
    values.push(Number(cursor[0]));
    where.push(`seq > $${values.length}`);
  }
  values.push(limit + 1);
  const { rows } = await db().pool.query(
    `SELECT id, seq, account_id, type, data, created_at FROM api_events
     WHERE ${where.join(" AND ")} ORDER BY seq LIMIT $${values.length}`,
    values,
  );
  const page = listPage(rows, limit, (row: any) => [Number(row.seq)], (row: any) => eventFromRow(row, catalog.livemode));
  // Always hand back a resume point, even on the last page, so a poller can
  // come back later and get only what is new.
  const last = rows.slice(0, limit).pop();
  return ok({ ...page, next_cursor: page.next_cursor || (last ? Buffer.from(JSON.stringify([Number(last.seq)])).toString("base64url") : ctx.url.searchParams.get("cursor")) });
}

async function getEvent(ctx: RouteContext) {
  const catalog = await ctx.catalog();
  const [row] = await db().sql`
    SELECT id, account_id, type, data, created_at FROM api_events
    WHERE id = ${ctx.params[0]} AND account_id = ${ctx.principal.accountId}
  `;
  if (!row) throw notFound("event", ctx.params[0]);
  return ok(eventFromRow(row, catalog.livemode));
}

async function listEventTypes() {
  return ok(staticList(EVENT_TYPES.map((type) => ({ object: "event_type", type }))));
}

// ---------------------------------------------------------------------------
// Webhook endpoints (REST hooks: Zapier, Make and n8n subscribe through these)
// ---------------------------------------------------------------------------

function endpointError(error: unknown): never {
  if (error instanceof EndpointInputError) throw invalid("parameter_invalid", error.message, error.param);
  throw error;
}

async function listWebhookEndpoints(ctx: RouteContext) {
  return ok(staticList(await listEndpoints(ctx.principal.accountId)));
}

async function createWebhookEndpoint(ctx: RouteContext) {
  requireStr(ctx.body, "url", 500);
  try {
    const { endpoint, secret } = await createEndpoint({
      accountId: ctx.principal.accountId,
      url: ctx.body.url,
      events: ctx.body.events,
      description: ctx.body.description,
      createdBy: `api:${ctx.principal.keyId}`,
      createdByKeyId: ctx.principal.keyId,
    });
    return ok({ ...endpoint, secret }, 201);
  } catch (error) {
    endpointError(error);
  }
}

async function getWebhookEndpoint(ctx: RouteContext) {
  const endpoint = await readEndpoint(ctx.principal.accountId, ctx.params[0]);
  if (!endpoint) throw notFound("webhook endpoint", ctx.params[0]);
  return ok(endpoint);
}

async function patchWebhookEndpoint(ctx: RouteContext) {
  try {
    const endpoint = await updateEndpoint(ctx.principal.accountId, ctx.params[0], ctx.body);
    if (!endpoint) throw notFound("webhook endpoint", ctx.params[0]);
    return ok(endpoint);
  } catch (error) {
    endpointError(error);
  }
}

async function deleteWebhookEndpoint(ctx: RouteContext) {
  if (!(await deleteEndpoint(ctx.principal.accountId, ctx.params[0]))) throw notFound("webhook endpoint", ctx.params[0]);
  return ok({ id: ctx.params[0], object: "webhook_endpoint", deleted: true });
}

// ---------------------------------------------------------------------------

const ID = "([A-Za-z0-9_.:-]{1,160})";
const route = (method: Route["method"], path: string, scope: ApiScope | null, handler: Route["handler"]): Route => ({
  method,
  path,
  pattern: new RegExp(`^${path.replace(/:id/g, ID)}/?$`),
  scope,
  handler,
});

export const ROUTES: Route[] = [
  route("GET", "/me", null, getMe),

  route("GET", "/services", "catalog:read", listServices),
  route("GET", "/services/:id", "catalog:read", getService),
  route("GET", "/coaches", "catalog:read", listCoaches),
  route("GET", "/coaches/:id", "catalog:read", getCoach),
  route("GET", "/locations", "catalog:read", listLocations),
  route("GET", "/locations/:id", "catalog:read", getLocation),
  route("GET", "/availability", "catalog:read", getAvailability),

  route("GET", "/bookings", "bookings:read", listBookings),
  route("POST", "/bookings", "bookings:write", createBooking),
  route("GET", "/bookings/:id", "bookings:read", getBooking),
  route("POST", "/bookings/:id/cancel", "bookings:write", cancelBooking),
  route("POST", "/bookings/:id/reschedule", "bookings:write", rescheduleBooking),

  route("GET", "/clients", "clients:read", listClients),
  route("POST", "/clients", "clients:write", createClient),
  route("GET", "/clients/:id", "clients:read", getClient),
  route("PATCH", "/clients/:id", "clients:write", updateClient),

  route("GET", "/pass_types", "catalog:read", commerce.listPassTypes),
  route("GET", "/passes", "passes:read", commerce.listPasses),
  route("POST", "/passes", "passes:write", commerce.issuePass),
  route("GET", "/passes/:id", "passes:read", commerce.getPass),
  route("POST", "/passes/:id/redeem", "passes:write", commerce.redeemPass),
  route("POST", "/passes/:id/void", "passes:write", commerce.voidPass),

  route("GET", "/invoices", "invoices:read", commerce.listInvoices),
  route("POST", "/invoices", "invoices:write", commerce.createInvoice),
  route("GET", "/invoices/:id", "invoices:read", commerce.getInvoice),
  route("DELETE", "/invoices/:id", "invoices:write", commerce.deleteDraftInvoice),
  route("POST", "/invoices/:id/send", "invoices:write", commerce.sendInvoice),
  route("POST", "/invoices/:id/mark_paid", "invoices:write", commerce.markInvoicePaid),
  route("POST", "/invoices/:id/void", "invoices:write", commerce.voidInvoice),

  route("GET", "/products", "catalog:read", sales.listProducts),
  route("GET", "/payment_methods", "sales:read", sales.listPaymentMethods),
  route("GET", "/sales", "sales:read", sales.listSales),
  route("POST", "/sales", "sales:write", sales.createSale),
  route("GET", "/sales/:id", "sales:read", sales.getSale),
  route("POST", "/sales/:id/mark_paid", "sales:write", sales.markSalePaid),
  route("POST", "/sales/:id/refund", "sales:write", sales.refundSale),
  route("POST", "/sales/:id/void", "sales:write", sales.voidSale),
  route("POST", "/sales/:id/send_receipt", "sales:write", sales.sendReceipt),

  route("GET", "/events", "events:read", listEvents),
  route("GET", "/event_types", null, listEventTypes),
  route("GET", "/events/:id", "events:read", getEvent),

  route("GET", "/webhook_endpoints", "webhooks:manage", listWebhookEndpoints),
  route("POST", "/webhook_endpoints", "webhooks:manage", createWebhookEndpoint),
  route("GET", "/webhook_endpoints/:id", "webhooks:manage", getWebhookEndpoint),
  route("PATCH", "/webhook_endpoints/:id", "webhooks:manage", patchWebhookEndpoint),
  route("DELETE", "/webhook_endpoints/:id", "webhooks:manage", deleteWebhookEndpoint),
];

/** The route for a method + path, a 405 hint, or nothing. Pure; exported for tests. */
export function matchRoute(method: string, path: string) {
  let pathMatched = false;
  for (const route of ROUTES) {
    const match = route.pattern.exec(path);
    if (!match) continue;
    pathMatched = true;
    if (route.method === method) return { route, params: match.slice(1).map(decodeURIComponent) };
  }
  return pathMatched ? { methodNotAllowed: true as const } : null;
}
