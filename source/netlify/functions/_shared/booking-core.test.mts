import assert from "node:assert/strict";
import test from "node:test";

import {
  handlePublicBookingSlotsRequest,
  publicBookingSlots,
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
