import assert from "node:assert/strict";
import test from "node:test";
import {
  computeDashboardMetric,
  dashboardToday,
  periodBuckets,
  periodRange,
  shiftYears,
  type DashboardItem,
  type DashboardRows,
} from "./dashboard-metrics.mts";

const week = periodRange("week", new Date(Date.UTC(2026, 9, 7))); // Wed 7 Oct 2026
const buckets = periodBuckets("week", week.start, week.end); // Mon 5 .. Sun 11 Oct
const previous = { start: "2025-10-05", end: "2025-10-11" };

function lesson(date: string, overrides: Partial<DashboardItem> = {}): DashboardItem {
  return { date, kind: "appointment", status: "booked", serviceId: "std", groupPrice: 0, personKey: "", origin: "clarity", note: "", ...overrides };
}

function rows(overrides: Partial<DashboardRows> = {}): DashboardRows {
  return {
    items: [],
    services: [{ id: "std", name: "Standard lesson", price: 80 }],
    invoices: [],
    transactions: [],
    productLines: [],
    today: "2026-10-07",
    ...overrides,
  };
}

test("a week is seven days starting Monday", () => {
  assert.equal(buckets.length, 7);
  assert.equal(buckets[0].rangeStart, "2026-10-05");
  assert.equal(buckets[6].rangeEnd, "2026-10-11");
});

test("lesson value splits at today: past or completed is done, the rest is booked ahead", () => {
  const data = rows({
    items: [
      lesson("2026-10-05"),
      lesson("2026-10-06", { status: "cancelled" }),
      lesson("2026-10-07", { status: "completed" }),
      lesson("2026-10-07"),
      lesson("2026-10-09", { groupPrice: 150 }),
      { ...lesson("2026-10-09"), kind: "block" },
    ],
  });
  const done = computeDashboardMetric("lesson-value-completed", data, buckets, previous);
  assert.equal(done.total, 160);
  assert.deepEqual(done.series[0].values, [80, 0, 80]);
  const ahead = computeDashboardMetric("lesson-value-future", data, buckets, previous);
  assert.equal(ahead.total, 230);
});

test("no-shows and cancellations count only their own status", () => {
  const data = rows({
    items: [lesson("2026-10-05", { status: "no_show" }), lesson("2026-10-05", { status: "cancelled" }), lesson("2026-10-06")],
  });
  assert.equal(computeDashboardMetric("no-shows", data, buckets, previous).total, 1);
  assert.equal(computeDashboardMetric("cancellations", data, buckets, previous).total, 1);
  assert.equal(computeDashboardMetric("bookings", data, buckets, previous).total, 1);
});

test("a person's first lesson ever is new, later ones are returning", () => {
  const data = rows({
    items: [
      lesson("2026-09-01", { personKey: "a" }),
      lesson("2026-10-05", { personKey: "a" }),
      lesson("2026-10-06", { personKey: "b" }),
      lesson("2026-10-08", { personKey: "b" }),
      lesson("2026-10-08"),
    ],
  });
  const result = computeDashboardMetric("returning-customers", data, buckets, previous);
  assert.deepEqual(result.series.map((line) => line.name), ["New", "Returning"]);
  assert.deepEqual(result.series[0].values, [0, 1, 0]);
  assert.deepEqual(result.series[1].values, [1, 0, 0]);
});

test("booking source reads Optix, the public page's note, and everything else as staff", () => {
  const data = rows({
    items: [
      lesson("2026-10-05", { origin: "optix" }),
      lesson("2026-10-05", { note: "Booked from public booking page." }),
      lesson("2026-10-06"),
      lesson("2026-10-06"),
    ],
  });
  const result = computeDashboardMetric("booking-source", data, buckets, previous);
  assert.deepEqual(result.slices, [
    { name: "Coach or staff", value: 2 },
    { name: "Optix", value: 1 },
    { name: "Online booking", value: 1 },
  ]);
});

test("money totals compare against the same range a year earlier", () => {
  const data = rows({
    invoices: [
      { date: "2026-10-05", total: 100 },
      { date: "2026-10-11", total: 50.5 },
      { date: "2026-10-12", total: 999 },
      { date: "2025-10-06", total: 75 },
    ],
  });
  const result = computeDashboardMetric("invoices", data, buckets, previous);
  assert.equal(result.total, 100);
  assert.equal(result.previousTotal, 75);
  assert.equal(computeDashboardMetric("transactions", data, buckets, previous).previousTotal, null);
});

test("top products keep the six biggest and fold the rest into Other", () => {
  const productLines = Array.from({ length: 8 }, (_, index) => ({
    date: "2026-10-06",
    productKey: `p${index}`,
    name: `Product ${index}`,
    quantity: 1,
    total: (index + 1) * 10,
  }));
  const result = computeDashboardMetric("top-products", rows({ productLines }), buckets, previous);
  assert.equal(result.slices.length, 7);
  assert.deepEqual(result.slices[0], { name: "Product 7", value: 80 });
  assert.deepEqual(result.slices[6], { name: "Other", value: 30 });
});

test("a saved layout keeps only real metrics, in their own group, and at most two to compare", async () => {
  const { normalizeDashboardConfig, defaultDashboardConfig } = await import("./dashboard-metrics.mts");
  assert.deepEqual(normalizeDashboardConfig(null), defaultDashboardConfig);
  const config = normalizeDashboardConfig({
    financial: ["invoices", "no-shows", "made-up"],
    bookings: ["no-shows"],
    compare: ["invoices", "booking-source", "bookings", "no-shows"],
    chartTypes: { invoices: "line", bookings: "radar", compare: "area", nonsense: "bar" },
    financialTotal: true,
  });
  assert.deepEqual(config.financial, ["invoices"]);
  assert.deepEqual(config.bookings, ["no-shows"]);
  assert.deepEqual(config.compare, ["invoices", "bookings"]);
  assert.deepEqual(config.chartTypes, { invoices: "line", compare: "area" });
  assert.equal(config.financialTotal, true);
});

test("historical metrics include today and real zero days, but no future days", () => {
  const data = rows({
    invoices: [
      { date: "2026-10-05", total: 100 },
      { date: "2026-10-07", total: 25 },
      { date: "2026-10-08", total: 999 },
      { date: "2025-10-07", total: 50 },
      { date: "2025-10-08", total: 999 },
    ],
  });
  const result = computeDashboardMetric("invoices", data, buckets, previous);
  assert.deepEqual(result.buckets.map((bucket) => bucket.label), ["Mon", "Tue", "Wed"]);
  assert.deepEqual(result.series[0].values, [100, 0, 25]);
  assert.equal(result.total, 125);
  assert.equal(result.previousTotal, 50);
  assert.equal(buckets.length, 7); // Other screens still need the full period.
});

test("a partial monthly bucket stops at today, including its label and totals", () => {
  const range = periodRange("month", new Date("2026-10-21T00:00:00Z"));
  const full = periodBuckets("month", range.start, range.end);
  const result = computeDashboardMetric("transactions", rows({
    today: "2026-10-16",
    transactions: [{ date: "2026-10-16", amount: 40 }, { date: "2026-10-17", amount: 999 }],
  }), full, { start: "2025-10-01", end: "2025-10-31" });
  assert.deepEqual(result.buckets.at(-1), { label: "15-16", rangeStart: "2026-10-15", rangeEnd: "2026-10-16" });
  assert.equal(result.buckets.length, 3);
  assert.deepEqual(result.series[0].values, [0, 0, 40]);
});

test("yearly history ends in the current month and excludes future dates within it", () => {
  const range = periodRange("year", new Date("2026-10-07T00:00:00Z"));
  const result = computeDashboardMetric("product-sales", rows({
    productLines: [
      { date: "2026-10-07", productKey: "p", name: "Ball", quantity: 1, total: 20 },
      { date: "2026-10-08", productKey: "p", name: "Ball", quantity: 1, total: 999 },
      { date: "2025-10-07", productKey: "p", name: "Ball", quantity: 1, total: 10 },
      { date: "2025-10-08", productKey: "p", name: "Ball", quantity: 1, total: 999 },
    ],
  }), periodBuckets("year", range.start, range.end), { start: "2025-01-01", end: "2025-12-31" });
  assert.equal(result.buckets.length, 10);
  assert.equal(result.buckets.at(-1)?.rangeEnd, "2026-10-07");
  assert.equal(result.total, 20);
  assert.equal(result.previousTotal, 10);
});

test("booking screens keep scheduled future lessons even with historical metrics loaded", () => {
  const data = rows({ items: [lesson("2026-10-09")] });
  for (const metric of ["lesson-value-future", "bookings", "booking-source", "lesson-types"] as const) {
    const result = computeDashboardMetric(metric, data, buckets, previous);
    assert.equal(result.buckets.length, 7);
    assert.ok(result.total > 0);
  }
  assert.equal(computeDashboardMetric("lesson-value-completed", data, buckets, previous).buckets.length, 3);
});

test("finished historical periods keep their full range and future-only ones are empty", () => {
  const data = rows({ today: "2026-10-12", invoices: [{ date: "2026-10-11", total: 50 }] });
  const finished = computeDashboardMetric("invoices", data, buckets, previous);
  assert.equal(finished.buckets.length, 7);
  assert.equal(finished.total, 50);
  const future = computeDashboardMetric("invoices", rows({ today: "2026-10-04" }), buckets, previous);
  assert.deepEqual(future.buckets, []);
  assert.deepEqual(future.series[0].values, []);
  assert.equal(future.previousTotal, null);
});

test("the first and last day of a year have one and twelve historical buckets", () => {
  const range = periodRange("year", new Date("2026-01-01T00:00:00Z"));
  const full = periodBuckets("year", range.start, range.end);
  assert.equal(computeDashboardMetric("invoices", rows({ today: "2026-01-01" }), full, previous).buckets.length, 1);
  assert.equal(computeDashboardMetric("invoices", rows({ today: "2026-12-31" }), full, previous).buckets.length, 12);
});

test("today follows the viewer's timezone around midnight and year boundaries", () => {
  const now = new Date("2026-12-31T12:00:00Z");
  assert.equal(dashboardToday("Pacific/Auckland", now), "2027-01-01");
  assert.equal(dashboardToday("America/Los_Angeles", now), "2026-12-31");
  assert.equal(dashboardToday("invalid-zone", now), "2026-12-31");
  assert.equal(dashboardToday(null, now), "2026-12-31");
});

test("a leap-day comparison ends on February 28 rather than spilling into March", () => {
  assert.equal(shiftYears(new Date("2024-02-29T00:00:00Z"), -1).toISOString().slice(0, 10), "2023-02-28");
  const range = periodRange("month", new Date("2024-02-29T00:00:00Z"));
  const result = computeDashboardMetric("invoices", rows({
    today: "2024-02-29",
    invoices: [{ date: "2023-02-28", total: 20 }, { date: "2023-03-01", total: 999 }],
  }), periodBuckets("month", range.start, range.end), { start: "2023-02-01", end: "2023-02-28" });
  assert.equal(result.previousTotal, 20);
});
