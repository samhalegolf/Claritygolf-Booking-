import assert from "node:assert/strict";
import test from "node:test";

import {
  handlePublicBookingSlotsRequest,
  publicAppointmentContactQuery,
  publicAppointmentReadQuery,
  publicSlotCalendarItemsQuery,
  publicBookingSlots,
  readPublicSlotContext,
  readPublicSlotItemsForWeek,
} from "../booking-core.mts";

const accountId = "test-account";
const serviceId = "lesson-a";
const otherServiceId = "lesson-b";
const groupServiceId = "group-a";
const privateServiceId = "private-lesson";
const coachId = "coach-a";
const otherCoachId = "coach-b";
const locationId = "bay-a";
const otherLocationId = "bay-b";
const baseWeekStart = new Date(Date.UTC(2026, 5, 1));

function minutes(hour: number, minute: number) {
  return hour * 60 + minute;
}

function currentWeekOffsetForTest() {
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

const testWeek = currentWeekOffsetForTest() + 1;
const day = 1;
const firstSlot = minutes(9, 0);
const secondSlot = minutes(9, 30);
const thirdSlot = minutes(10, 0);

function availability() {
  const days = Array.from({ length: 7 }, () => []);
  days[day].push({
    accountId,
    coachId,
    start: firstSlot,
    end: minutes(10, 30),
  });
  return days;
}

function service(overrides = {}) {
  return {
    id: serviceId,
    accountId,
    name: "Lesson A",
    duration: 30,
    price: 100,
    visibility: "public",
    active: true,
    archived: false,
    capacity: 1,
    minParticipants: 1,
    lessonFormat: "private",
    priceMode: "session",
    coachId,
    locationId,
    ...overrides,
  };
}

function calendarState(overrides = {}) {
  return {
    syncKey: "sync-test",
    updatedAt: "2026-07-12T00:00:00.000Z",
    account: {
      id: coachId,
      businessName: "Test Golf",
      coachName: "Coach A",
      calendarSlug: accountId,
      timezone: "Pacific/Auckland",
    },
    workspaceAccounts: [
      {
        id: accountId,
        name: "Test Golf",
        slug: accountId,
        planKey: "founder",
        subscriptionStatus: "comped",
        active: true,
      },
    ],
    coaches: [
      {
        id: coachId,
        accountId,
        name: "Coach A",
        displayName: "Coach A",
        active: true,
        archived: false,
        bookable: true,
        isDefault: true,
        sortOrder: 0,
      },
      {
        id: otherCoachId,
        accountId,
        name: "Coach B",
        displayName: "Coach B",
        active: true,
        archived: false,
        bookable: true,
        isDefault: false,
        sortOrder: 1,
      },
    ],
    locations: [
      {
        id: locationId,
        accountId,
        name: "Bay A",
        shortName: "Bay A",
        active: true,
        archived: false,
        isDefault: true,
        sortOrder: 0,
      },
      {
        id: otherLocationId,
        accountId,
        name: "Bay B",
        shortName: "Bay B",
        active: true,
        archived: false,
        isDefault: false,
        sortOrder: 1,
      },
    ],
    services: [
      service(),
      service({
        id: otherServiceId,
        name: "Lesson B",
        coachId: otherCoachId,
        locationId: otherLocationId,
      }),
      service({
        id: privateServiceId,
        name: "Private Lesson",
        visibility: "private",
      }),
      service({
        id: groupServiceId,
        name: "Group A",
        duration: 60,
        capacity: 2,
        minParticipants: 1,
        lessonFormat: "group",
        groupSchedule: {
          active: true,
          dayOfWeek: 2,
          startMinutes: minutes(10, 0),
          occurrenceCount: 12,
        },
      }),
    ],
    availability: availability(),
    items: [],
    brand: {},
    ...overrides,
  };
}

function settingsSnapshotFromState(state = calendarState()) {
  return {
    syncKey: state.syncKey,
    updatedAt: state.updatedAt,
    settings: {
      syncKey: state.syncKey,
      updatedAt: state.updatedAt,
      accountId: state.account.id,
      accountCoachName: state.account.coachName,
      accountBusinessName: state.account.businessName,
      accountVenueName: "Test Range",
      accountVenueShortName: "Range",
      accountTimezone: state.account.timezone,
      accountContactEmail: "coach@example.test",
      accountBookingUrl: "",
      accountCalendarSlug: accountId,
      workspaceAccountsJson: JSON.stringify(state.workspaceAccounts),
      coachProfilesJson: JSON.stringify(state.coaches),
      locationsJson: JSON.stringify(state.locations),
      servicesJson: JSON.stringify(state.services),
      availabilityJson: JSON.stringify(state.availability),
    },
  };
}

function item(overrides = {}) {
  return {
    id: "item-1",
    accountId,
    kind: "appointment",
    serviceId,
    week: testWeek,
    day,
    start: firstSlot,
    duration: 30,
    coachId,
    locationId,
    ...overrides,
  };
}

function slotStarts(payload: any) {
  return payload.slots.map((slot: any) => slot.start).sort((left: number, right: number) => left - right);
}

function slotsFor(items = [], options = {}) {
  return publicBookingSlots(calendarState({ items }), {
    serviceId,
    week: testWeek,
    ...options,
  });
}

test("public booking slots endpoint requires serviceId", async () => {
  const originalInfo = console.info;
  console.info = () => undefined;
  try {
    const response = await handlePublicBookingSlotsRequest(
      new Request(`https://example.test/api/public-booking-slots?week=${testWeek}`),
    );
    const body = await response.json() as any;

    assert.equal(response.status, 400);
    assert.equal(body.error, "service_required");
    assert.equal(body.message, "Choose a public lesson type.");
  } finally {
    console.info = originalInfo;
  }
});

test("invalid or non-public public booking serviceId keeps the request error path", () => {
  for (const candidateServiceId of ["missing-service", privateServiceId]) {
    assert.throws(
      () => publicBookingSlots(calendarState(), { serviceId: candidateServiceId, week: testWeek }),
      (error: any) => error?.status === 404 && /choose a public lesson type/i.test(error.message),
    );
  }
});

test("public slot calendar item query scopes by account and requested week", () => {
  const query = publicSlotCalendarItemsQuery({ accountId, week: testWeek });

  assert.match(query, /select=\*/);
  assert.match(query, new RegExp(`(?:^|&)account_id=eq\\.${accountId}(?:&|$)`));
  assert.match(query, new RegExp(`(?:^|&)week=eq\\.${testWeek}(?:&|$)`));
  assert.doesNotMatch(query, /order=week\.asc/);
});

test("public appointment read query scopes by account and appointment only", () => {
  const query = publicAppointmentReadQuery({ appointmentId: "booking-123", accountId });
  const fallbackQuery = publicAppointmentReadQuery({
    appointmentId: "booking-123",
    accountId,
    useAccountScope: false,
  });

  assert.match(query, /select=\*/);
  assert.match(query, /(?:^|&)id=eq\.booking-123(?:&|$)/);
  assert.match(query, new RegExp(`(?:^|&)account_id=eq\\.${accountId}(?:&|$)`));
  assert.match(query, /(?:^|&)limit=1(?:&|$)/);
  assert.doesNotMatch(query, /week=eq\./);
  assert.doesNotMatch(query, /order=/);
  assert.doesNotMatch(fallbackQuery, /account_id=eq\./);
  assert.match(fallbackQuery, /(?:^|&)id=eq\.booking-123(?:&|$)/);
  assert.match(fallbackQuery, /(?:^|&)limit=1(?:&|$)/);
});

test("public appointment contact query scopes by account and customer email", () => {
  const query = publicAppointmentContactQuery({ accountId, email: "SAM@Example.test" });
  const fallbackQuery = publicAppointmentContactQuery({
    accountId,
    email: "SAM@Example.test",
    useAccountScope: false,
  });

  assert.match(query, /select=\*/);
  assert.match(query, /(?:^|&)kind=eq\.appointment(?:&|$)/);
  assert.match(query, /(?:^|&)email=ilike\.sam%40example\.test(?:&|$)/);
  assert.match(query, new RegExp(`(?:^|&)account_id=eq\\.${accountId}(?:&|$)`));
  assert.match(query, /(?:^|&)limit=50(?:&|$)/);
  assert.doesNotMatch(query, /week=eq\./);
  assert.doesNotMatch(fallbackQuery, /account_id=eq\./);
  assert.match(fallbackQuery, /(?:^|&)email=ilike\.sam%40example\.test(?:&|$)/);
});

test("public slot item read falls back to week-only when the account column is missing", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalInfo = console.warn;
  const requests: string[] = [];
  process.env.SUPABASE_URL = "https://supabase.example";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
  console.warn = () => undefined;
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("account_id=eq.")) {
      return Response.json(
        {
          code: "PGRST204",
          message: "Could not find the 'account_id' column of 'calendar_items' in the schema cache",
        },
        { status: 400 },
      );
    }
    assert.match(url, new RegExp(`(?:\\?|&)week=eq\\.${testWeek}(?:&|$)`));
    assert.doesNotMatch(url, /account_id=eq\./);
    return Response.json([
      {
        id: "legacy-week-row",
        kind: "block",
        week: testWeek,
        day,
        start: firstSlot,
        duration: 30,
        title: "Busy",
      },
    ]);
  };

  try {
    const result = await readPublicSlotItemsForWeek({ accountId, week: testWeek });

    assert.equal(result.usedLegacySchemaFallback, true);
    assert.equal(result.queryMode, "week_only_legacy_schema");
    assert.equal(result.rowsFetched, 1);
    assert.equal(result.items[0].id, "legacy-week-row");
    assert.equal(requests.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalInfo;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  }
});

test("public slot context keeps requested-week relevant resource records only", async () => {
  const metrics: any = {};
  let readArgs: any = null;
  const rows = [
    item({ id: "same-coach" }),
    item({
      id: "unrelated",
      serviceId: otherServiceId,
      coachId: otherCoachId,
      locationId: otherLocationId,
    }),
    item({
      id: "selected-location-block",
      kind: "block",
      serviceId: "",
      start: secondSlot,
      coachId: "",
      locationId,
    }),
    item({
      id: "selected-coach-block",
      kind: "block",
      serviceId: "",
      start: thirdSlot,
      coachId,
      locationId: "",
    }),
    item({
      id: "ambiguous-legacy-row",
      kind: "block",
      serviceId: "",
      coachId: "",
      locationId: "",
    }),
    item({
      id: "other-week",
      week: testWeek + 1,
    }),
    item({
      id: "cancelled",
      status: "cancelled",
    }),
    item({
      id: "no-show",
      status: "no_show",
      start: secondSlot,
    }),
  ];

  const context = await readPublicSlotContext(
    { serviceId, week: testWeek },
    {
      settingsSnapshot: settingsSnapshotFromState(),
      metrics,
      readItemsForWeek: async (args: any) => {
        readArgs = args;
        return {
          items: rows,
          rowsFetched: rows.length,
          query: "mock-week-query",
          queryMode: "mock_week",
        };
      },
    },
  );

  assert.equal(readArgs.accountId, accountId);
  assert.equal(readArgs.serviceId, serviceId);
  assert.equal(readArgs.week, testWeek);
  assert.deepEqual(
    context.items.map((candidate: any) => candidate.id).sort(),
    ["ambiguous-legacy-row", "same-coach", "selected-coach-block", "selected-location-block"],
  );
  assert.equal(metrics.rowsFetched, rows.length);
  assert.equal(metrics.requestedWeekItemCount, 5);
  assert.equal(metrics.relevantResourceItemCount, 4);
  assert.equal(metrics.queryMode, "mock_week");
});

test("public slot context retains same-service group bookings for capacity", async () => {
  const context = await readPublicSlotContext(
    { serviceId: groupServiceId, week: testWeek },
    {
      settingsSnapshot: settingsSnapshotFromState(),
      readItemsForWeek: async () => ({
        items: [
          item({
            id: "group-booking-1",
            serviceId: groupServiceId,
            day: 2,
            start: minutes(10, 0),
            duration: 60,
          }),
          item({
            id: "unrelated",
            serviceId: otherServiceId,
            coachId: otherCoachId,
            locationId: otherLocationId,
          }),
        ],
        rowsFetched: 2,
        query: "mock-week-query",
        queryMode: "mock_week",
      }),
    },
  );
  const payload = publicBookingSlots(context, {
    serviceId: groupServiceId,
    week: testWeek,
  });

  assert.deepEqual(context.items.map((candidate: any) => candidate.id), ["group-booking-1"]);
  assert.equal(payload.slots.length, 1);
  assert.equal(payload.slots[0].remainingSpots, 1);
});

test("public booking slots endpoint uses the narrow slot context reader", async () => {
  const originalInfo = console.info;
  let calls = 0;
  console.info = () => undefined;
  try {
    const response = await handlePublicBookingSlotsRequest(
      new Request(`https://example.test/api/public-booking-slots?serviceId=${serviceId}&week=${testWeek}`),
      {
        readPublicSlotContext: async (params: any) => {
          calls += 1;
          assert.deepEqual(params, { serviceId, week: testWeek });
          return calendarState();
        },
      },
    );
    const body = await response.json() as any;

    assert.equal(response.status, 200);
    assert.equal(calls, 1);
    assert.equal(body.week, testWeek);
    assert.equal(body.serviceId, serviceId);
    assert.ok(Array.isArray(body.slots));
    assert.deepEqual(body.services[serviceId].slots, body.slots);
  } finally {
    console.info = originalInfo;
  }
});

test("public slot context preserves invalid serviceId error behaviour", async () => {
  await assert.rejects(
    () =>
      readPublicSlotContext(
        { serviceId: "missing-service", week: testWeek },
        {
          settingsSnapshot: settingsSnapshotFromState(),
          readItemsForWeek: async () => {
            throw new Error("calendar items should not be read for an invalid service");
          },
        },
      ),
    (error: any) => error?.status === 404 && /choose a public lesson type/i.test(error.message),
  );
});

test("items from another week do not affect requested-week public slots", () => {
  const payload = slotsFor([
    item({
      id: "other-week",
      week: testWeek + 1,
    }),
  ]);

  assert.deepEqual(slotStarts(payload), [firstSlot, secondSlot, thirdSlot]);
});

test("a same-week booking for the relevant coach blocks the public slot", () => {
  const payload = slotsFor([
    item({
      id: "same-coach",
    }),
  ]);

  assert.deepEqual(slotStarts(payload), [secondSlot, thirdSlot]);
});

test("a same-week coach-only block blocks the relevant coach slot", () => {
  const payload = slotsFor([
    item({
      id: "coach-block",
      kind: "block",
      serviceId: "",
      start: secondSlot,
      coachId,
      locationId: "",
    }),
  ]);

  assert.deepEqual(slotStarts(payload), [firstSlot, thirdSlot]);
});

test("a same-week location-only block only blocks the matching public location", () => {
  const unrelatedLocation = slotsFor([
    item({
      id: "other-location-block",
      kind: "block",
      serviceId: "",
      start: thirdSlot,
      coachId: "",
      locationId: otherLocationId,
    }),
  ]);
  const selectedLocation = slotsFor([
    item({
      id: "selected-location-block",
      kind: "block",
      serviceId: "",
      start: thirdSlot,
      coachId: "",
      locationId,
    }),
  ]);

  assert.deepEqual(slotStarts(unrelatedLocation), [firstSlot, secondSlot, thirdSlot]);
  assert.deepEqual(slotStarts(selectedLocation), [firstSlot, secondSlot]);
});

test("an unrelated coach and location item does not block the selected public service", () => {
  const payload = slotsFor([
    item({
      id: "unrelated",
      serviceId: otherServiceId,
      coachId: otherCoachId,
      locationId: otherLocationId,
    }),
  ]);

  assert.deepEqual(slotStarts(payload), [firstSlot, secondSlot, thirdSlot]);
});

test("cancelled and no-show items do not block public availability", () => {
  const payload = slotsFor([
    item({
      id: "cancelled",
      status: "cancelled",
      start: firstSlot,
    }),
    item({
      id: "no-show",
      status: "no_show",
      start: secondSlot,
    }),
  ]);

  assert.deepEqual(slotStarts(payload), [firstSlot, secondSlot, thirdSlot]);
});

test("scheduled group capacity still controls public slots", () => {
  const oneBooked = publicBookingSlots(calendarState({
    items: [
      item({
        id: "group-booking-1",
        serviceId: groupServiceId,
        day: 2,
        start: minutes(10, 0),
        duration: 60,
      }),
    ],
  }), {
    serviceId: groupServiceId,
    week: testWeek,
  });
  const full = publicBookingSlots(calendarState({
    items: [
      item({
        id: "group-booking-1",
        serviceId: groupServiceId,
        day: 2,
        start: minutes(10, 0),
        duration: 60,
      }),
      item({
        id: "group-booking-2",
        serviceId: groupServiceId,
        day: 2,
        start: minutes(10, 0),
        duration: 60,
      }),
    ],
  }), {
    serviceId: groupServiceId,
    week: testWeek,
  });

  assert.equal(oneBooked.slots.length, 1);
  assert.equal(oneBooked.slots[0].remainingSpots, 1);
  assert.deepEqual(full.slots, []);
});

test("ignoreId preserves the rescheduling slot for the ignored booking", () => {
  const booking = item({ id: "reschedule-me" });
  const blocked = slotsFor([booking]);
  const ignored = slotsFor([booking], { ignoreId: booking.id });

  assert.deepEqual(slotStarts(blocked), [secondSlot, thirdSlot]);
  assert.deepEqual(slotStarts(ignored), [firstSlot, secondSlot, thirdSlot]);
});

test("successful public booking slots response shape stays frontend compatible", () => {
  const payload = slotsFor();

  assert.equal(payload.week, testWeek);
  assert.equal(payload.serviceId, serviceId);
  assert.equal(payload.ignoreId, "");
  assert.ok(Array.isArray(payload.slots));
  assert.ok(payload.services[serviceId]);
  assert.deepEqual(payload.services[serviceId].slots, payload.slots);
  assert.deepEqual(Object.keys(payload.services), [serviceId]);
});

const groupDay = 2;
const groupStart = minutes(10, 0);

function availabilityOverGroupSession() {
  const days = availability();
  days[groupDay].push({
    accountId,
    coachId,
    start: minutes(9, 30),
    end: minutes(11, 30),
  });
  return days;
}

function privateSlotsOverGroupSession(items = []) {
  return publicBookingSlots(
    calendarState({ availability: availabilityOverGroupSession(), items }),
    { serviceId, week: testWeek },
  );
}

function groupDaySlotStarts(payload: any) {
  return payload.slots
    .filter((slot: any) => slot.day === groupDay)
    .map((slot: any) => slot.start)
    .sort((left: number, right: number) => left - right);
}

test("an unbooked scheduled group session blocks overlapping private slots", () => {
  // Regression: group sessions have no calendar row until someone books one, so an empty
  // session used to be invisible to conflict checks and a private lesson could be booked over it.
  assert.deepEqual(groupDaySlotStarts(privateSlotsOverGroupSession()), [minutes(9, 30), minutes(11, 0)]);
});

test("a booked scheduled group session still blocks overlapping private slots", () => {
  const payload = privateSlotsOverGroupSession([
    item({
      id: "group-booking-1",
      serviceId: groupServiceId,
      day: groupDay,
      start: groupStart,
      duration: 60,
    }),
  ]);

  assert.deepEqual(groupDaySlotStarts(payload), [minutes(9, 30), minutes(11, 0)]);
});

test("a cancelled scheduled group session frees the slot for private bookings", () => {
  const payload = privateSlotsOverGroupSession([
    item({
      id: "group-cancellation",
      kind: "block",
      serviceId: groupServiceId,
      day: groupDay,
      start: groupStart,
      duration: 60,
      status: "cancelled",
      title: "Cancelled group session",
      note: "__cancelled_group_session__",
    }),
  ]);

  assert.deepEqual(groupDaySlotStarts(payload), [
    minutes(9, 30),
    minutes(10, 0),
    minutes(10, 30),
    minutes(11, 0),
  ]);
});

test("the group service can still be booked into its own session slot", () => {
  const payload = publicBookingSlots(
    calendarState({ availability: availabilityOverGroupSession() }),
    { serviceId: groupServiceId, week: testWeek },
  );

  assert.equal(payload.slots.length, 1);
  assert.equal(payload.slots[0].start, groupStart);
  assert.equal(payload.slots[0].remainingSpots, 2);
});

// "now" in the account's timezone, expressed as the {week, day, minutes} the
// slot grid uses. baseWeekStart is Mon 2026-06-01 UTC; day index 0 = Monday.
function accountNowSlotCoords(timeZone = "Pacific/Auckland") {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  const year = value("year");
  const month = value("month");
  const dayOfMonth = value("day");
  const nowMinutes = value("hour") * 60 + value("minute");
  const todayUtc = Date.UTC(year, month - 1, dayOfMonth);
  const baseUtc = Date.UTC(2026, 5, 1);
  const dayIndex = (new Date(todayUtc).getUTCDay() + 6) % 7; // 0 = Monday
  const offsetDays = Math.round((todayUtc - baseUtc) / (24 * 60 * 60 * 1000));
  const week = (offsetDays - dayIndex) / 7;
  return { week, dayIndex, nowMinutes };
}

test("public booking never offers times earlier than now today", () => {
  const timeZone = "Pacific/Auckland";
  const { week, dayIndex, nowMinutes } = accountNowSlotCoords(timeZone);
  // Skip the rare case where "now" leaves no whole 30-minute slot before or
  // after it inside a business day (very early / very late in the local day).
  const windowStart = nowMinutes - 90;
  const windowEnd = nowMinutes + 90;
  if (windowStart < 6 * 60 || windowEnd > 22 * 60) return;

  const availabilityDays = Array.from({ length: 7 }, () => [] as any[]);
  availabilityDays[dayIndex].push({ accountId, coachId, start: windowStart, end: windowEnd });

  const payload = publicBookingSlots(
    calendarState({ availability: availabilityDays }),
    { serviceId, week },
  );
  const starts = payload.slots.map((slot: any) => slot.start);

  // Every returned slot is strictly in the future.
  for (const start of starts) {
    assert.ok(start > nowMinutes, `slot at ${start} should be after now (${nowMinutes})`);
  }
  // A slot 60 minutes from now is inside the window and must still be offered.
  assert.ok(
    starts.some((start: number) => start >= nowMinutes + 30),
    "a clearly-future slot should remain bookable",
  );
});
