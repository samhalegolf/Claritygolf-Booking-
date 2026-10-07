import { calendarSlot, MINUTES_IN_DAY } from "./calendar-slot.mts";
import { defaultCoachAccount, defaultTimeZone, FALLBACK_TIME_ZONE } from "./coach-account.mts";
import { recordBelongsToAccountStrict } from "./coach-auth.mts";
import { handednessFromNote } from "./handedness.mts";
import { bayBookingMatchesSlot } from "./optix-reconcile.mts";
import { hasPermission, missingAccountScope, permissionDenied } from "./permissions.mts";
import { clarityResourcesApply, pickFreeResource, serviceResourceMode } from "./resources.mts";
import { primaryServiceCoachId, primaryServiceLocationId, serviceIncludesCoach } from "./service-scope.mts";
import {
  cleanReviewTurnaroundDays,
  defaultServices,
  isScheduledGroupService,
  isVideoReviewService,
  MAX_GROUP_OCCURRENCE_COUNT,
  serviceLocation,
} from "./services.mts";
import { db, queryRows } from "./settings-store.mts";
import {
  cleanEmail,
  cleanPositiveInteger,
  cleanSlug,
  cleanString,
  cleanUrl,
  safeJsonParse,
} from "./values.mts";
import {
  coachById,
  coachSnapshot,
  defaultCoachProfileFromAccount,
  defaultLocationId,
  firstCoachId,
  locationById,
  locationSnapshot,
} from "./workspace.mts";

/**
 * Bookings: everything on the calendar (lessons, blocks, group sessions,
 * video reviews).
 *
 * Reading and writing calendar_items, cleaning an item into one shape, who may
 * see or change an item, and whether a new item collides with one already
 * there. What a save sets off (emails, Google sync, bay booking) is not here:
 * that is still the route's job in booking-core.mts.
 */

export const baseWeekStart = new Date(Date.UTC(2026, 5, 1));
const CANCELLED_GROUP_SESSION_TITLE = "Cancelled group session";
export const CANCELLED_GROUP_SESSION_NOTE = "__cancelled_group_session__";
/**
 * Where a review sits when the coach has no availability that day. 8pm is the
 * calendar's own default end hour, so the card lands inside the rendered grid
 * rather than below it.
 */
const VIDEO_REVIEW_FALLBACK_DAY_END_MINUTES = 20 * 60;

/**
 * Where a review's deadline lands on the calendar grid.
 *
 * The date is the booking moment plus the turnaround. The time is the end of
 * that day's work, so the card reads as "owed by close of play" rather than
 * pretending to be an appointment at some invented hour -- and it ends exactly
 * where the coach's day does.
 *
 * Reviews already due that day stack backwards from there, one duration at a
 * time, so a day with three of them shows three cards in a row instead of one
 * card with two hidden underneath it.
 */
export function videoReviewDueSlot(service, accountState, coachId, timezone) {
  const duration = Math.max(15, Math.round(Number(service?.duration) || 30));
  const turnaround = cleanReviewTurnaroundDays(service?.reviewTurnaroundDays);
  const dueAt = new Date(Date.now() + turnaround * 86_400_000);
  // Same rule the rest of the clock maths follows: an unusable timezone falls
  // back to UTC loudly rather than throwing inside a booking the player has
  // already paid attention to.
  let grid;
  try {
    grid = calendarSlot(dueAt.toISOString(), timezone);
  } catch {
    console.warn("booking_core:invalid_timezone_falling_back_to_utc", { timeZone: timezone });
    grid = calendarSlot(dueAt.toISOString(), FALLBACK_TIME_ZONE);
  }
  const { week, day } = grid;
  const fallbackCoachId = defaultCoachProfileFromAccount().id;
  const windows = (accountState?.availability?.[day] || []).filter(
    (window) => (window.coachId || fallbackCoachId) === (coachId || fallbackCoachId),
  );
  const dayEnd = windows.length
    ? Math.max(...windows.map((window) => Number(window.end) || 0))
    : VIDEO_REVIEW_FALLBACK_DAY_END_MINUTES;
  // Count what is already owed on this day so the next one sits beside it.
  const reviewServiceIds = new Set(
    (accountState?.services || []).filter(isVideoReviewService).map((entry) => entry.id),
  );
  const alreadyDue = (accountState?.items || []).filter(
    (item) =>
      Number(item.week ?? 0) === week &&
      Number(item.day) === day &&
      !isInactiveForConflict(item) &&
      reviewServiceIds.has(item.serviceId),
  ).length;
  const start = Math.max(
    0,
    Math.min(MINUTES_IN_DAY - duration, dayEnd - duration * (alreadyDue + 1)),
  );
  return { week, day, start, duration, dueAt: dueAt.toISOString() };
}

export function cleanCustomGroupAttendee(raw, index = 0) {
  if (!raw || typeof raw !== "object") return null;
  const name = cleanString(raw.name, "", 120);
  const email = cleanEmail(raw.email, "");
  if (!name && !email) return null;
  const rawStatus = ["booker", "manual", "invited", "confirmed"].includes(raw.status)
    ? raw.status
    : "";
  const status = rawStatus
    ? rawStatus === "invited" && !email
      ? "manual"
      : rawStatus
    : email
      ? "invited"
      : "manual";
  return {
    id: cleanString(raw.id, `attendee-${index + 1}`, 120),
    name: name || email,
    ...(email ? { email } : {}),
    status,
    ...(raw.token ? { token: cleanString(raw.token, "", 180) } : {}),
  };
}

function cleanCustomGroupData(value) {
  const source = typeof value === "string" ? safeJsonParse(value, null) : value;
  if (!source || typeof source !== "object") return null;
  const attendees = Array.isArray(source.attendees)
    ? source.attendees.map(cleanCustomGroupAttendee).filter(Boolean)
    : [];
  if (!source.customGroup && !attendees.length) return null;
  return {
    customGroup: true,
    attendees,
    calculatedPrice: cleanPositiveInteger(source.calculatedPrice, 0, 0, 100000),
  };
}

export function bookingCoachSnapshotFor(coachId, coaches) {
  const profile = coachById(coaches, coachId) || coachById(coaches, firstCoachId(coaches));
  return profile ? coachSnapshot(profile) : undefined;
}

export function cleanBookingCoachSnapshot(raw, fallback) {
  const source = raw?.name ? raw : fallback;
  if (!source?.name) return undefined;
  return {
    coachId: cleanSlug(source.coachId, "") || undefined,
    name: cleanString(source.name, "", 120),
    displayName: cleanString(source.displayName, "", 120) || undefined,
    email: cleanEmail(source.email, "") || undefined,
    phone: cleanString(source.phone, "", 80) || undefined,
  };
}

export function cleanBookingLocationSnapshot(raw, fallback) {
  const source = raw?.name ? raw : fallback;
  if (!source?.name) return undefined;
  return {
    locationId: cleanString(source.locationId, "", 120) || undefined,
    name: cleanString(source.name, "", 140),
    shortName: cleanString(source.shortName, "", 80) || undefined,
    address: cleanString(source.address, "", 240) || undefined,
    mapUrl: cleanUrl(source.mapUrl, "", 300) || undefined,
    arrivalInstructions: cleanString(source.arrivalInstructions, "", 500) || undefined,
    publicNotes: cleanString(source.publicNotes, "", 500) || undefined,
    timezone: cleanString(source.timezone, "", 80) || undefined,
  };
}

function bookingLocationSnapshotFor(service, locations, account) {
  return locationSnapshot(serviceLocation(service, locations, account));
}

export function calendarItemLocation(item, service, locations, account) {
  return (
    cleanBookingLocationSnapshot(item?.location) ||
    cleanBookingLocationSnapshot(
      item?.locationId
        ? locationSnapshot(locationById(locations, item.locationId) || serviceLocation(service, locations, account))
        : undefined,
    ) ||
    bookingLocationSnapshotFor(service, locations, account)
  );
}

function calendarItemCoach(item, coaches) {
  return (
    cleanBookingCoachSnapshot(item?.coach) ||
    bookingCoachSnapshotFor(item?.coachId, coaches)
  );
}

export function resolvedCalendarItemCoachId(item, service, coaches) {
  return item?.coachId || item?.coach?.coachId || primaryServiceCoachId(service) || calendarItemCoach(item, coaches)?.coachId || firstCoachId(coaches);
}

export function resolvedCalendarItemLocationId(item, service, locations, account) {
  return item?.locationId || item?.location?.locationId || primaryServiceLocationId(service) || calendarItemLocation(item, service, locations, account).locationId || defaultLocationId(locations);
}

export function serviceForCalendarItem(item, services = []) {
  return (services || []).find((service) => service.id && service.id === item?.serviceId) || null;
}


export function calendarItemBelongsToAccount(item, accountId) {
  return recordBelongsToAccountStrict(item, accountId);
}

function calendarItemBelongsToCoach(item, coachId, services = [], coaches = []) {
  if (!coachId) return false;
  if (isLocationOnlyBlock(item)) return true;
  return resolvedCalendarItemCoachId(item, serviceForCalendarItem(item, services), coaches) === coachId;
}

export function canReadCalendarItem(context, item, state) {
  if (!calendarItemBelongsToAccount(item, context.accountId)) return false;
  if (context.isAdmin) return true;
  return calendarItemBelongsToCoach(item, context.coachId, state.services, state.coaches);
}

export function assertCanWriteCalendarItem(context, item, previousItem, state) {
  if (!calendarItemBelongsToAccount(item, context.accountId)) {
    throw permissionDenied("This booking does not belong to your workspace.");
  }
  if (context.isAdmin) return;
  if (!hasPermission(context.user, "bookings", "own")) {
    throw permissionDenied("You do not have permission to edit bookings.");
  }
  if (isLocationOnlyBlock(item)) {
    throw permissionDenied("You do not have permission to block an entire location.");
  }
  if (previousItem && !calendarItemBelongsToCoach(previousItem, context.coachId, state.services, state.coaches)) {
    throw permissionDenied("You do not have permission to edit another coach's calendar.");
  }
  if (!calendarItemBelongsToCoach(item, context.coachId, state.services, state.coaches)) {
    throw permissionDenied("You do not have permission to move bookings to another coach.");
  }
}

export function normalizeCalendarItemsForContext(items, context) {
  return normalizeItems(items).map((item) => ({ ...item, accountId: context.accountId }));
}

export function filterCalendarStateForContext(state, context) {
  const filteredItems = (state.items || []).filter((item) => canReadCalendarItem(context, item, state));
  const visibleItemIds = new Set(filteredItems.map((item) => item.id));
  return {
    ...state,
    items: filteredItems,
    services: context.isAdmin
      ? (state.services || []).filter((service) => recordBelongsToAccountStrict(service, context.accountId))
      : (state.services || []).filter((service) => recordBelongsToAccountStrict(service, context.accountId) && serviceIncludesCoach(service, context.coachId, firstCoachId(state.coaches))),
    availability: context.isAdmin
      ? (state.availability || []).map((day) => day.filter((window) => recordBelongsToAccountStrict(window, context.accountId)))
      : (state.availability || []).map((day) => day.filter((window) => recordBelongsToAccountStrict(window, context.accountId) && (window.coachId || firstCoachId(state.coaches)) === context.coachId)),
    notifications: context.isAdmin
      ? state.notifications
      : (state.notifications || []).filter((notification) => visibleItemIds.has(notification.calendarItemId)),
    people: context.isAdmin
      ? state.people
      : (state.people || []).filter((person) => filteredItems.some((item) => item.email && person.email && item.email === person.email)),
  };
}

export function filterNotificationsForContext(notifications, context, state) {
  if (context.isAdmin) return notifications || [];
  const visibleItemIds = new Set((state.items || []).filter((item) => canReadCalendarItem(context, item, state)).map((item) => item.id));
  return (notifications || []).filter((notification) => visibleItemIds.has(notification.calendarItemId));
}

export function isLocationOnlyBlock(item) {
  return item?.kind === "block" && Boolean(item.locationId || item.location?.locationId) && !item.coachId && !item.coach?.coachId;
}

export function isCoachOnlyBlock(item) {
  return item?.kind === "block" && Boolean(item.coachId || item.coach?.coachId) && !item.locationId && !item.location?.locationId;
}

export function isCoachLocationBlock(item) {
  return item?.kind === "block" && Boolean(item.coachId || item.coach?.coachId) && Boolean(item.locationId || item.location?.locationId);
}

export function isInactiveForConflict(item) {
  return item?.status === "cancelled" || item?.status === "no_show";
}

export function bookingLocationDisplay(location) {
  return [location?.name, location?.address].filter(Boolean).join(" · ");
}

export function rowToItem(row) {
  const updatedAt = cleanString(typeof row?.updated_at === "string" ? row.updated_at : String(row?.updated_at || ""), "", 120);
  const completedAt = cleanString(typeof row?.completed_at === "string" ? row.completed_at : String(row?.completed_at || ""), "", 120);
  const status = ["completed", "cancelled", "no_show"].includes(row.status)
    ? row.status
    : "booked";
  const customGroup = cleanCustomGroupData(row.custom_group);
  const cancelledGroupSession = isCancelledGroupSessionLike(row);
  const location = cleanBookingLocationSnapshot(row.location);
  // A synced sync row is not on its own proof of a bay: it can be left over
  // from before the lesson was moved. See bayBookingMatchesSlot.
  const bayBooked =
    row.bay_booked === true &&
    bayBookingMatchesSlot(
      { week: Number(row.week ?? 0), day: Number(row.day ?? 0), start: Number(row.start ?? 0), location },
      // The lesson's own location timezone wins inside; this is only reached
      // when it has none. A deployment constant, not another business's clock.
      Number(row.bay_start_timestamp ?? 0),
      defaultTimeZone(),
    );
  return {
    id: row.id,
    // No owner means no owner. Migration C made the column NOT NULL, so this
    // only bites genuinely malformed data -- which should be invisible, not
    // adopted by whichever business is reading.
    accountId: cleanSlug(row.accountId || row.account_id, ""),
    kind: row.kind,
    week: Number(row.week ?? 0),
    day: Number(row.day ?? 0),
    start: Number(row.start ?? 0),
    duration: Number(row.duration ?? 0),
    coachId: row.coach_id || defaultCoachProfileFromAccount().id,
    locationId: row.location_id || cleanBookingLocationSnapshot(row.location)?.locationId || "",
    serviceId: row.service_id || "",
    client: row.client || "",
    title: row.title,
    phone: row.phone || "",
    email: row.email || "",
    personId: row.person_id || "",
    note: row.note || "",
    coach: cleanBookingCoachSnapshot(row.coach),
    location,
    status: cancelledGroupSession ? "cancelled" : status,
    // Who owns this booking. The calendar needs this to tell a native lesson
    // from one an external system owns -- without it the UI cannot label an
    // Optix booking, and worse, cannot stop a gesture that would silently
    // convert one. Read-only: writeItems() never updates these columns, so a
    // client cannot claim a booking for a provider by echoing them back.
    origin: row.origin || "clarity",
    externalProvider: row.external_provider || "",
    externalBookingId: row.external_booking_id || "",
    bayBooked,
    bayResourceId: row.bay_resource_id || "",
    // The Clarity resource this lesson holds. Server-owned: writeItems never
    // writes it, assignClarityResources does.
    resourceId: row.resource_id || "",
    updatedAt,
    completedAt,
    ...(cancelledGroupSession ? { readOnly: true, groupSlot: true } : {}),
    ...(customGroup || {}),
	  };
	}

export function isCancelledGroupSessionLike(item) {
  return (
    item?.kind === "block" &&
    Boolean(item?.service_id || item?.serviceId) &&
    (item?.note === CANCELLED_GROUP_SESSION_NOTE || item?.title === CANCELLED_GROUP_SESSION_TITLE)
  );
}

export function cleanCalendarItem(item) {
  if (!item || typeof item !== "object") return null;
  const kind =
    item.kind === "block"
      ? "block"
      : item.kind === "appointment"
        ? "appointment"
        : null;
  if (!kind) return null;

  const day = Number(item.day);
  const start = Number(item.start);
  const duration = Number(item.duration);
  if (!Number.isInteger(day) || day < 0 || day > 6) return null;
  if (!Number.isInteger(start) || start < 0 || start > 24 * 60) return null;
  if (!Number.isInteger(duration) || duration <= 0 || duration > 12 * 60)
    return null;

  const customGroup = cleanCustomGroupData({
    customGroup: item.customGroup,
    attendees: item.attendees,
    calculatedPrice: item.calculatedPrice,
  });
  const cancelledGroupSession = isCancelledGroupSessionLike({ ...item, kind });
  return {
    id: cleanString(item.id, `${kind}-${Date.now()}`),
    // Whatever the client claimed, or nothing. The authoritative stamp happens
    // in calendarItemParams from server context.
    accountId: cleanSlug(item.accountId, ""),
    kind,
    week: Number.isInteger(Number(item.week)) ? Number(item.week) : 0,
    day,
    start,
    duration,
    coachId: cleanSlug(item.coachId || item.coach?.coachId, kind === "appointment" ? defaultCoachProfileFromAccount().id : "") || undefined,
    locationId: cleanSlug(item.locationId || item.location?.locationId, ""),
    serviceId: cleanString(item.serviceId),
    client: cancelledGroupSession ? "" : cleanString(item.client),
    title: cancelledGroupSession
      ? CANCELLED_GROUP_SESSION_TITLE
      : cleanString(item.title, kind === "block" ? "Busy" : "Appointment"),
    phone: cancelledGroupSession ? "" : cleanString(item.phone),
    email: cancelledGroupSession ? "" : cleanString(item.email),
    personId: cancelledGroupSession ? "" : cleanString(item.personId, "", 120),
    note: cancelledGroupSession ? CANCELLED_GROUP_SESSION_NOTE : cleanString(item.note),
    coach: cancelledGroupSession ? undefined : cleanBookingCoachSnapshot(item.coach),
    location: cancelledGroupSession ? undefined : cleanBookingLocationSnapshot(item.location),
    status:
      cancelledGroupSession
        ? "cancelled"
        : item.status === "completed" ||
            item.status === "cancelled" ||
            item.status === "no_show"
          ? item.status
          : "booked",
    ...(cancelledGroupSession ? {} : customGroup || {}),
  };
}

function normalizeItems(items) {
  return Array.isArray(items)
    ? items.map(cleanCalendarItem).filter(Boolean)
    : [];
}

// Applies the per-index results of importPeople(items.map(personFromAppointment))
// back onto the appointments they came from. Must run before writeItems so the
// resolved id is persisted in the same write instead of a second round trip.
export function stampResolvedPersonIds(items, resolvedIds = []) {
  return items.map((item, index) => {
    if (item.kind !== "appointment") return item;
    const resolvedId = resolvedIds[index];
    if (!resolvedId || resolvedId === item.personId) return item;
    return { ...item, personId: resolvedId };
  });
}

// The account filter is in the SQL, not in a .filter() afterwards. Reading
// every business's calendar and then discarding the rows that do not belong to
// the caller made the tenant boundary a JavaScript predicate -- one wrong
// comparison and another business's day was on screen. It was also the whole
// table over the wire on every load.
export async function readItems(accountId: string) {
  if (!accountId) return [];
  // The bay comes along with the lesson so the calendar can show which ones are
  // covered without a second request and without matching on rendered text.
  // Only a live booking counts: a failed or cancelled sync row means no bay.
  const rows = await db().sql`
    SELECT ci.*,
           (s.optix_booking_id IS NOT NULL AND s.optix_booking_id <> ''
            AND s.sync_status = 'synced') AS bay_booked,
           s.resource_id AS bay_resource_id,
           s.start_timestamp AS bay_start_timestamp
    FROM calendar_items ci
    LEFT JOIN optix_booking_sync s ON s.calendar_item_id = ci.id
    WHERE ci.account_id = ${accountId}
    ORDER BY ci.week, ci.day, ci.start, ci.id
  `;
  return rows.map(rowToItem);
}

// Same shape as readItems() but for a single booking. Used by paths that act on
// one item and have no reason to pull the whole calendar first.
export async function readCalendarItemById(accountId: string, itemId) {
  const cleanId = cleanString(itemId, "", 140);
  if (!cleanId || !accountId) return null;
  // Scoped by id AND account: knowing another business's booking id must not be
  // enough to read it.
  const rows = await db().sql`
    SELECT ci.*,
           (s.optix_booking_id IS NOT NULL AND s.optix_booking_id <> ''
            AND s.sync_status = 'synced') AS bay_booked,
           s.resource_id AS bay_resource_id,
           s.start_timestamp AS bay_start_timestamp
    FROM calendar_items ci
    LEFT JOIN optix_booking_sync s ON s.calendar_item_id = ci.id
    WHERE ci.id = ${cleanId}
      AND ci.account_id = ${accountId}
    LIMIT 1
  `;
  return rows.length ? rowToItem(rows[0]) : null;
}

// The columns every calendar item write sets, in the order calendarItemParams
// builds them. created_at/updated_at come from NOW() rather than a parameter.
const CALENDAR_ITEM_WRITE_COLUMNS = [
  "id",
  "account_id",
  "kind",
  "week",
  "day",
  "start",
  "duration",
  "coach_id",
  "location_id",
  "service_id",
  "client",
  "title",
  "phone",
  "email",
  "person_id",
  "note",
  "status",
  "custom_group",
  "coach",
  "location",
];
const CALENDAR_ITEM_JSON_WRITE_COLUMNS = new Set(["custom_group", "coach", "location"]);
// Postgres caps a statement at 65535 parameters, which at twenty columns would
// allow far more rows than this. The smaller chunk keeps any single statement
// modest enough to stay well inside statement_timeout.
const CALENDAR_ITEM_WRITE_CHUNK = 250;

/**
 * The column values for one calendar row.
 *
 * accountId is passed in from server context, never read off the item. The
 * item arrives from the client, and `item.accountId || <default workspace>`
 * meant a write that lost or omitted its tenant was stamped into the original
 * business. Any account id on the item is ignored.
 */
export function calendarItemParams(item, accountId: string) {
  if (!accountId) throw missingAccountScope("calendar_item_write");
  return [
    item.id,
    accountId,
    item.kind,
    item.week ?? 0,
    item.day,
    item.start,
    item.duration,
    item.coachId || defaultCoachProfileFromAccount().id,
    item.locationId || item.location?.locationId || "",
    item.serviceId || "",
    item.client || "",
    item.title,
    item.phone || "",
    item.email || "",
    item.personId || "",
    item.note || "",
    item.status || "booked",
    item.customGroup ? JSON.stringify(cleanCustomGroupData(item)) : null,
    item.coach ? JSON.stringify(cleanBookingCoachSnapshot(item.coach)) : null,
    item.location ? JSON.stringify(cleanBookingLocationSnapshot(item.location)) : null,
  ];
}

/**
 * Upsert a batch of calendar items in one statement.
 *
 * A full calendar save replaces the whole item array, so this used to run one
 * INSERT per item. Every one of those is a round trip to Postgres, and the
 * calendar only grows: a coach with a season of history behind them was paying
 * hundreds of sequential round trips to move a single lesson, which is what
 * eventually pushed the save past the function timeout and surfaced as
 * "Calendar save failed" on a booking that had nothing wrong with it.
 */
export async function upsertCalendarItemChunk(client, chunk, accountId: string) {
  const params = [];
  const rows = chunk.map((item) => {
    const placeholders = calendarItemParams(item, accountId).map((value, column) => {
      params.push(value);
      return CALENDAR_ITEM_JSON_WRITE_COLUMNS.has(CALENDAR_ITEM_WRITE_COLUMNS[column])
        ? `$${params.length}::jsonb`
        : `$${params.length}`;
    });
    return `(${placeholders.join(", ")}, NOW(), NOW())`;
  });
  const assignments = CALENDAR_ITEM_WRITE_COLUMNS
    .filter((column) => column !== "id")
    .map((column) => `${column} = EXCLUDED.${column}`)
    .concat("updated_at = NOW()")
    .join(", ");
  const result = await client.query(
    `INSERT INTO calendar_items (${CALENDAR_ITEM_WRITE_COLUMNS.join(", ")}, created_at, updated_at)
     VALUES ${rows.join(", ")}
     ON CONFLICT (id) DO UPDATE SET ${assignments}
     RETURNING *`,
    params,
  );
  return queryRows(result);
}

/**
 * Write calendar items for exactly one business.
 *
 * options.accountId is required. It used to be optional, and without it both
 * the clear and the replace-stale-rows paths ran against the whole table --
 * `DELETE FROM calendar_items` with no predicate, and a stale-id scan that
 * loaded every business's rows and filtered them in JavaScript. Both are now
 * scoped in the SQL.
 */
export async function writeItems(items, options = {}) {
  const accountId = cleanSlug(options.accountId, "");
  if (!accountId) throw missingAccountScope("calendar_write");
  // ON CONFLICT DO UPDATE cannot touch the same row twice in one statement, so
  // a repeated id has to collapse before the insert. Last write wins, which is
  // what the row-at-a-time loop did.
  const cleanItems = Array.from(
    new Map(normalizeItems(items).map((item) => [item.id, item])).values(),
  );
  const returnedRows = [];
  const client = await db().pool.connect();
  try {
    await client.query("BEGIN");
    if (options.clearItems === true) {
      await client.query("DELETE FROM calendar_items WHERE account_id = $1", [accountId]);
    }
    for (let offset = 0; offset < cleanItems.length; offset += CALENDAR_ITEM_WRITE_CHUNK) {
      returnedRows.push(
        ...(await upsertCalendarItemChunk(
          client,
          cleanItems.slice(offset, offset + CALENDAR_ITEM_WRITE_CHUNK),
          accountId,
        )),
      );
    }
    // A patch save names the bookings it removed rather than sending every
    // booking it kept. Same transaction as the upserts, and scoped to the
    // account so an id from another business deletes nothing.
    const deleteIds = Array.isArray(options.deleteIds)
      ? Array.from(new Set(options.deleteIds.map((id) => cleanString(id, "", 140)).filter(Boolean)))
      : [];
    if (deleteIds.length) {
      await client.query(
        "DELETE FROM calendar_items WHERE account_id = $1 AND id = ANY($2::text[])",
        [accountId, deleteIds],
      );
    }
    if (options.replaceItems === true && cleanItems.length) {
      const keepIds = Array.from(new Set(cleanItems.map((item) => item.id)));
      // One scoped statement instead of "read every row, filter in JS, delete
      // by id list". Rows belonging to other businesses are not read, let alone
      // considered for deletion.
      const deleted = queryRows(
        await client.query(
          "DELETE FROM calendar_items WHERE account_id = $1 AND NOT (id = ANY($2::text[])) RETURNING id",
          [accountId, keepIds],
        ),
      );
      if (deleted.length) {
        console.info("CALENDAR_STATE_REPLACE_STALE_CLEANUP", {
          action: "replace_stale_cleanup",
          route: "/api/calendar-state",
          accountId,
          targetedDelete: true,
          staleCount: deleted.length,
        });
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  if (
    options.returnMode === "single" &&
    cleanItems.length === 1 &&
    options.clearItems !== true &&
    options.replaceItems !== true
  ) {
    // The Supabase REST adapter ignores `INSERT ... RETURNING` and always
    // resolves with no rows, so returnedRows can be empty even though the write
    // committed. Fall back to the item we just wrote instead of calling
    // rowToItem(undefined), which threw *after* the commit -- surfacing to the
    // client as a failed save that then rolled the optimistic edit back (a
    // dragged lesson visibly jumped to its original slot, and the reschedule
    // notification that runs after this write never fired).
    return returnedRows[0] ? rowToItem(returnedRows[0]) : cleanItems[0];
  }
  return readItems(accountId);
}

export function itemWeek(item) {
  return item.week ?? 0;
}

export function slotOverlaps(a, b) {
  return (
    a.week === b.week &&
    a.day === b.day &&
    a.start < b.start + b.duration &&
    a.start + a.duration > b.start
  );
}

export function currentWeekOffset() {
  const today = new Date();
  const day = today.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const weekStart = new Date(today);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() + mondayOffset);
  const weekStartUtc = Date.UTC(
    weekStart.getFullYear(),
    weekStart.getMonth(),
    weekStart.getDate(),
  );
  const baseWeekStartUtc = Date.UTC(
    baseWeekStart.getFullYear(),
    baseWeekStart.getMonth(),
    baseWeekStart.getDate(),
  );
  return Math.round((weekStartUtc - baseWeekStartUtc) / (7 * 24 * 60 * 60 * 1000));
}

export function isGroupServiceSlotMatch(service, candidate) {
  if (!isScheduledGroupService(service)) return false;
  if (!service.groupSchedule || service.groupSchedule.active === false) return false;
  const schedule = service.groupSchedule;
  if (candidate.day !== schedule.dayOfWeek) return false;
  if (candidate.start !== schedule.startMinutes) return false;
  if (!Number.isInteger(candidate.week)) return false;
  const minWeek = currentWeekOffset();
  const occurrenceCount = Math.max(1, Math.min(MAX_GROUP_OCCURRENCE_COUNT, Math.round(schedule.occurrenceCount || 1)));
  if (candidate.week < minWeek || candidate.week >= minWeek + occurrenceCount) return false;
  return true;
}

function isCancelledGroupSessionRecord(item, serviceId, session) {
  return (
    isCancelledGroupSessionLike(item) &&
    (item.serviceId || item.service_id) === serviceId &&
    itemWeek(item) === session.week &&
    Number(item.day) === session.day &&
    Number(item.start) === session.start
  );
}

// Scheduled group sessions are recurring service definitions, not stored calendar rows.
// They only become rows once someone books one, so conflict checks must synthesise a
// "hold" for every live occurrence — otherwise a private lesson can be booked on top of
// an empty group session.
function scheduledGroupSessionHolds(items = [], candidate, state = {}) {
  const services = state.services || defaultServices;
  const coaches = state.coaches || [];
  const locations = state.locations || [];
  const account = state.account || defaultCoachAccount();
  if (!Number.isInteger(candidate?.week)) return [];
  // Cancelled-session rows are stripped from some conflict item lists (they are status
  // "cancelled"), so callers can supply them separately to keep cancelled occurrences bookable.
  const cancellations = Array.isArray(state.cancelledGroupSessions) ? state.cancelledGroupSessions : items;
  const holds = [];
  for (const groupService of services) {
    if (!groupService?.active || groupService.archived === true) continue;
    if (!isScheduledGroupService(groupService)) continue;
    const schedule = groupService.groupSchedule;
    if (!schedule?.active) continue;
    const session = {
      week: candidate.week,
      day: schedule.dayOfWeek,
      start: schedule.startMinutes,
      duration: groupService.duration,
    };
    if (!isGroupServiceSlotMatch(groupService, session)) continue;
    if (!slotOverlaps(session, candidate)) continue;
    if (cancellations.some((item) => isCancelledGroupSessionRecord(item, groupService.id, session))) continue;
    const holdSeed = { serviceId: groupService.id };
    holds.push({
      ...session,
      id: `group-session-hold-${groupService.id}-${session.week}`,
      kind: "appointment",
      status: "booked",
      serviceId: groupService.id,
      coachId: resolvedCalendarItemCoachId(holdSeed, groupService, coaches),
      locationId: resolvedCalendarItemLocationId(holdSeed, groupService, locations, account),
      title: `${groupService.name} (group session)`,
      syntheticGroupSlot: true,
      readOnly: true,
    });
  }
  return holds;
}

function itemsWithGroupSessionHolds(items = [], candidate, service, state = {}) {
  const holds = scheduledGroupSessionHolds(items, candidate, state).filter((hold) => hold.serviceId !== service?.id);
  return holds.length ? [...items, ...holds] : items;
}

export function conflictItemSummary(item, state = {}) {
  if (!item) return null;
  const services = state.services || defaultServices;
  const coaches = state.coaches || [];
  const locations = state.locations || [];
  const account = state.account || defaultCoachAccount();
  const service = services.find((candidateService) => candidateService.id === item.serviceId);
  return {
    id: item.id,
    kind: item.kind,
    status: item.status || "booked",
    serviceId: item.serviceId || "",
    serviceName: service?.name || "",
    week: itemWeek(item),
    day: item.day,
    start: item.start,
    duration: item.duration,
    coachId: resolvedCalendarItemCoachId(item, service, coaches),
    locationId: resolvedCalendarItemLocationId(item, service, locations, account),
  };
}

/**
 * The lessons at a location that hold, or are owed, one of its Clarity
 * resources, in the shape pickFreeResource wants. A lesson type that only
 * uses a resource when one is free is owed nothing, so its lessons count
 * only while they actually hold one.
 */
function clarityResourceHolders(items, locationId, state = {}) {
  const services = state.services || defaultServices;
  const locations = state.locations || [];
  const account = state.account || defaultCoachAccount();
  return (items || [])
    .filter((item) => {
      if (item.kind !== "appointment" || isInactiveForConflict(item)) return false;
      const itemService = services.find((candidateService) => candidateService.id === item.serviceId);
      const mode = serviceResourceMode(itemService);
      if (mode === "none" || (mode === "usable" && !item.resourceId)) return false;
      return resolvedCalendarItemLocationId(item, itemService, locations, account) === locationId;
    })
    .map((item) => ({
      id: item.id,
      week: itemWeek(item),
      day: Number(item.day),
      start: Number(item.start),
      duration: Number(item.duration),
      resourceId: item.resourceId || "",
    }));
}

/**
 * Which of the location's resources this booking would hold. `applies` is
 * false when the location or lesson type does not use Clarity resources, so
 * the caller can tell "no resource needed" from "none free". `required` says
 * whether "none free" means the booking cannot go ahead.
 */
export function clarityResourceFor(items, candidate, service, state = {}, { ignoreId = "", preferResourceId = "" } = {}) {
  const location = candidate.locationId
    ? (state.locations || []).find((entry) => entry.id === candidate.locationId)
    : serviceLocation(service, state.locations || [], state.account || defaultCoachAccount());
  if (!clarityResourcesApply(location, service) || isScheduledGroupService(service)) {
    return { applies: false, required: false, resource: null };
  }
  const handedness =
    candidate.handedness === "left" || candidate.handedness === "right"
      ? candidate.handedness
      : handednessFromNote(candidate.note);
  const resource = pickFreeResource({
    location,
    service,
    slot: {
      week: Number(candidate.week ?? 0),
      day: Number(candidate.day),
      start: Number(candidate.start),
      duration: Number(candidate.duration),
    },
    holders: clarityResourceHolders(items, location.id, state),
    handedness,
    ignoreId: ignoreId || candidate.id || "",
    preferResourceId,
  });
  return { applies: true, required: serviceResourceMode(service) === "required", resource };
}

export function findCollision(items, candidate, service, state = {}) {
  const services = state.services || defaultServices;
  const coaches = state.coaches || [];
  const locations = state.locations || [];
  const account = state.account || defaultCoachAccount();
  // The coach and location this booking would be with. A lesson type offered
  // by several says which one on the candidate; otherwise it is the first.
  const candidateCoachId = candidate.coachId || primaryServiceCoachId(service, firstCoachId(coaches));
  const candidateLocationId = candidate.locationId || serviceLocation(service, locations, account).id;
  const candidateItem = {
    kind: "appointment",
    coachId: candidateCoachId,
    locationId: candidateLocationId,
    ...candidate,
  };
  const existingService = (item) => services.find((candidateService) => candidateService.id === item.serviceId);
  const isCoachConflict = (item) => {
    if (isInactiveForConflict(item) || isLocationOnlyBlock(item)) return false;
    const itemCoachId = resolvedCalendarItemCoachId(item, existingService(item), coaches);
    return Boolean(candidateCoachId && itemCoachId && candidateCoachId === itemCoachId);
  };
  const isLocationConflict = (item) => {
    if (isInactiveForConflict(item)) return false;
    const itemLocationId = resolvedCalendarItemLocationId(item, existingService(item), locations, account);
    if (!candidateLocationId || !itemLocationId || candidateLocationId !== itemLocationId) return false;
    if (isLocationOnlyBlock(item)) return true;
    if (isCoachOnlyBlock(item)) return false;
    if (isCoachLocationBlock(item)) return isCoachConflict(item);
    return candidateItem.kind === "block" && isLocationOnlyBlock(candidateItem);
  };
  const isAppointmentConflict = (item) => isCoachConflict(item) || isLocationConflict(item);
  const conflictItems = itemsWithGroupSessionHolds(items, candidate, service, state);
  const overlapping = conflictItems.filter((item) =>
    slotOverlaps(
      {
        week: itemWeek(item),
        day: item.day,
        start: item.start,
        duration: item.duration,
      },
      candidate,
    ),
  );
  if (!isScheduledGroupService(service)) {
    const item = overlapping.find(isAppointmentConflict);
    if (item) return { reason: "blocking_item", item, candidateCoachId, candidateLocationId };
    // Every bay or room this lesson must have is held for some of the time.
    const held = clarityResourceFor(conflictItems, { ...candidate, locationId: candidateLocationId }, service, state);
    if (held.required && !held.resource) {
      return { reason: "resource_full", item: null, candidateCoachId, candidateLocationId };
    }
    return null;
  }
  const blockingItem = overlapping.find(
    (item) => (item.kind !== "appointment" || item.serviceId !== service.id) && isAppointmentConflict(item),
  );
  if (blockingItem) return { reason: "blocking_item", item: blockingItem, candidateCoachId, candidateLocationId };
  const sameService = overlapping.filter((item) => item.serviceId === service.id && !isInactiveForConflict(item));
  if (sameService.length >= service.capacity) {
    return { reason: "capacity_full", item: sameService[0], candidateCoachId, candidateLocationId };
  }
  return null;
}

export function hasCollision(items, candidate, service, state = {}) {
  return Boolean(findCollision(items, candidate, service, state));
}
