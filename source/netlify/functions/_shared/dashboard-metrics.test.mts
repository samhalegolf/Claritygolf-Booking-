import assert from "node:assert/strict";
import test from "node:test";
import {
  computeDashboardMetric,
  periodBuckets,
  periodRange,
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
  assert.deepEqual(done.series[0].values, [80, 0, 80, 0, 0, 0, 0]);
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
  assert.deepEqual(result.series[0].values, [0, 1, 0, 0, 0, 0, 0]);
  assert.deepEqual(result.series[1].values, [1, 0, 0, 1, 0, 0, 0]);
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
  assert.equal(result.total, 150.5);
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
