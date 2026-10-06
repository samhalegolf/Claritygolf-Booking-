/**
 * The Billing dashboard's metrics: every number a dashboard screen can show,
 * computed from rows the caller has already read.
 *
 * Each metric is a list of dated events -- "$80 on 3 Oct", "one no-show on
 * 5 Oct" -- that are then summed into the period's buckets. That one shape
 * covers money and counts, single lines and split ones (new vs returning),
 * and the same events summed over last year's range give the comparison.
 *
 * Pure module: no network, no database. billing-api.mts reads the rows.
 */

export type DashboardPeriod = "week" | "month" | "year";

export const DASHBOARD_METRICS = {
  // Financial
  "lesson-value-completed": { unit: "money", shape: "series" },
  "lesson-value-future": { unit: "money", shape: "series" },
  invoices: { unit: "money", shape: "series" },
  transactions: { unit: "money", shape: "series" },
  // Bookings
  bookings: { unit: "count", shape: "series" },
  "no-shows": { unit: "count", shape: "series" },
  cancellations: { unit: "count", shape: "series" },
  "returning-customers": { unit: "count", shape: "series" },
  "booking-source": { unit: "count", shape: "breakdown" },
  "lesson-types": { unit: "count", shape: "breakdown" },
  // Products
  "product-sales": { unit: "money", shape: "series" },
  "units-sold": { unit: "count", shape: "series" },
  "top-products": { unit: "money", shape: "breakdown" },
} as const;

export type DashboardMetricId = keyof typeof DASHBOARD_METRICS;

export function isDashboardMetricId(value: unknown): value is DashboardMetricId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(DASHBOARD_METRICS, value);
}

/** Which tables a metric needs, so the caller reads only those. */
export function metricSources(metric: DashboardMetricId): Array<"items" | "invoices" | "transactions" | "productLines"> {
  if (metric === "invoices") return ["invoices"];
  if (metric === "transactions") return ["transactions"];
  if (metric === "product-sales" || metric === "units-sold" || metric === "top-products") return ["productLines"];
  return ["items"];
}

/** A calendar item as the metrics need it. `date` is YYYY-MM-DD. */
export type DashboardItem = {
  date: string;
  kind: string;
  status: string;
  serviceId: string;
  /** A custom group's own price, when it has one. */
  groupPrice: number;
  /** Who the lesson was with: person id, else email, else name. Empty when unknown. */
  personKey: string;
  origin: string;
  note: string;
};

export type DashboardService = { id: string; name: string; price: number };
export type DashboardInvoice = { date: string; total: number };
export type DashboardTransaction = { date: string; amount: number };
export type DashboardProductLine = { date: string; productKey: string; name: string; quantity: number; total: number };

export type DashboardRows = {
  items: DashboardItem[];
  services: DashboardService[];
  invoices: DashboardInvoice[];
  transactions: DashboardTransaction[];
  productLines: DashboardProductLine[];
  /** YYYY-MM-DD. Splits completed lesson value from future. */
  today: string;
};

export type DashboardBucket = { label: string; rangeStart: string; rangeEnd: string };

export type DashboardMetricResult = {
  id: DashboardMetricId;
  unit: "money" | "count";
  shape: "series" | "breakdown";
  /** Series metrics: one value per bucket for each named line. */
  series: Array<{ name: string; values: number[] }>;
  /** Breakdown metrics: the period's total for each slice, largest first. */
  slices: Array<{ name: string; value: number }>;
  total: number;
  /** The same metric over the same range a year earlier. Null when nothing happened then. */
  previousTotal: number | null;
};

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 86400000);
}

export function parseDateOnly(value: unknown): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ""));
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

export function periodRange(period: DashboardPeriod, refDate: Date) {
  if (period === "week") {
    const day = refDate.getUTCDay();
    const start = addDays(refDate, (day === 0 ? -6 : 1) - day);
    return { start, end: addDays(start, 6) };
  }
  if (period === "year") {
    const year = refDate.getUTCFullYear();
    return { start: new Date(Date.UTC(year, 0, 1)), end: new Date(Date.UTC(year, 11, 31)) };
  }
  return {
    start: new Date(Date.UTC(refDate.getUTCFullYear(), refDate.getUTCMonth(), 1)),
    end: new Date(Date.UTC(refDate.getUTCFullYear(), refDate.getUTCMonth() + 1, 0)),
  };
}

export function shiftYears(date: Date, years: number) {
  return new Date(Date.UTC(date.getUTCFullYear() + years, date.getUTCMonth(), date.getUTCDate()));
}

/** Days for a week, months for a year, and week-long chunks for a month so it stays readable. */
export function periodBuckets(period: DashboardPeriod, start: Date, end: Date): DashboardBucket[] {
  if (period === "week") {
    return Array.from({ length: 7 }, (_, index) => {
      const key = dateOnly(addDays(start, index));
      return { label: WEEKDAY_LABELS[index], rangeStart: key, rangeEnd: key };
    });
  }
  if (period === "year") {
    const year = start.getUTCFullYear();
    return Array.from({ length: 12 }, (_, index) => ({
      label: MONTH_LABELS[index],
      rangeStart: dateOnly(new Date(Date.UTC(year, index, 1))),
      rangeEnd: dateOnly(new Date(Date.UTC(year, index + 1, 0))),
    }));
  }
  const buckets: DashboardBucket[] = [];
  let cursor = start;
  while (cursor.getTime() <= end.getTime()) {
    const bucketEnd = new Date(Math.min(addDays(cursor, 6).getTime(), end.getTime()));
    buckets.push({ label: `${cursor.getUTCDate()}-${bucketEnd.getUTCDate()}`, rangeStart: dateOnly(cursor), rangeEnd: dateOnly(bucketEnd) });
    cursor = addDays(bucketEnd, 1);
  }
  return buckets;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

const isLesson = (item: DashboardItem) => item.kind === "appointment";
const isLive = (item: DashboardItem) => item.status !== "cancelled" && item.status !== "no_show";

function lessonValue(item: DashboardItem, services: Map<string, DashboardService>) {
  return item.groupPrice > 0 ? item.groupPrice : services.get(item.serviceId)?.price ?? 0;
}

/**
 * Where a booking came from. Optix imports carry their origin; the public
 * booking page writes "Booked from ..." into the note; anything else was made
 * by the coach or staff in Clarity.
 */
function bookingSource(item: DashboardItem) {
  if (item.origin === "optix") return "Optix";
  if (item.origin && item.origin !== "clarity") return item.origin.charAt(0).toUpperCase() + item.origin.slice(1);
  if (/^(video review )?booked from /i.test(item.note.trim())) return "Online booking";
  return "Coach or staff";
}

type MetricEvent = { date: string; value: number; name: string };

function metricEvents(metric: DashboardMetricId, rows: DashboardRows): MetricEvent[] {
  const services = new Map(rows.services.map((service) => [service.id, service]));
  const lessons = rows.items.filter(isLesson);
  switch (metric) {
    case "lesson-value-completed":
      // Done: marked completed, or in the past and neither cancelled nor a no-show.
      return lessons
        .filter((item) => item.status === "completed" || (isLive(item) && item.date < rows.today))
        .map((item) => ({ date: item.date, value: lessonValue(item, services), name: "Completed" }));
    case "lesson-value-future":
      return lessons
        .filter((item) => isLive(item) && item.status !== "completed" && item.date >= rows.today)
        .map((item) => ({ date: item.date, value: lessonValue(item, services), name: "Booked ahead" }));
    case "invoices":
      return rows.invoices.map((invoice) => ({ date: invoice.date, value: invoice.total, name: "Invoiced" }));
    case "transactions":
      return rows.transactions.map((sale) => ({ date: sale.date, value: sale.amount, name: "Taken" }));
    case "bookings":
      return lessons.filter(isLive).map((item) => ({ date: item.date, value: 1, name: "Bookings" }));
    case "no-shows":
      return lessons.filter((item) => item.status === "no_show").map((item) => ({ date: item.date, value: 1, name: "No-shows" }));
    case "cancellations":
      return lessons.filter((item) => item.status === "cancelled").map((item) => ({ date: item.date, value: 1, name: "Cancellations" }));
    case "returning-customers": {
      // A person's first ever lesson is new; every one after it is a return.
      // Lessons with nobody identifiable are left out rather than guessed.
      const firstLesson = new Map<string, string>();
      for (const item of lessons.filter(isLive)) {
        if (!item.personKey) continue;
        const seen = firstLesson.get(item.personKey);
        if (!seen || item.date < seen) firstLesson.set(item.personKey, item.date);
      }
      const counted = new Set<string>();
      return lessons
        .filter((item) => isLive(item) && item.personKey)
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((item) => {
          const isFirst = firstLesson.get(item.personKey) === item.date && !counted.has(item.personKey);
          counted.add(item.personKey);
          return { date: item.date, value: 1, name: isFirst ? "New" : "Returning" };
        });
    }
    case "booking-source":
      return lessons.filter(isLive).map((item) => ({ date: item.date, value: 1, name: bookingSource(item) }));
    case "lesson-types":
      return lessons
        .filter(isLive)
        .map((item) => ({ date: item.date, value: 1, name: services.get(item.serviceId)?.name || "Other" }));
    case "product-sales":
      return rows.productLines.map((line) => ({ date: line.date, value: line.total, name: "Product sales" }));
    case "units-sold":
      return rows.productLines.map((line) => ({ date: line.date, value: line.quantity, name: "Units sold" }));
    case "top-products":
      return rows.productLines.map((line) => ({ date: line.date, value: line.total, name: line.name || "Unnamed product" }));
  }
}

/** The fixed order a split series is drawn in, so "New" is always the first colour. */
const SERIES_ORDER: Partial<Record<DashboardMetricId, string[]>> = {
  "returning-customers": ["New", "Returning"],
};

const BREAKDOWN_LIMIT = 6;

export function computeDashboardMetric(
  metric: DashboardMetricId,
  rows: DashboardRows,
  buckets: DashboardBucket[],
  previous: { start: string; end: string },
): DashboardMetricResult {
  const { unit, shape } = DASHBOARD_METRICS[metric];
  const events = metricEvents(metric, rows);
  const rangeStart = buckets[0]?.rangeStart ?? "";
  const rangeEnd = buckets[buckets.length - 1]?.rangeEnd ?? "";
  const inRange = events.filter((event) => event.date >= rangeStart && event.date <= rangeEnd);
  const sum = (list: MetricEvent[]) => round2(list.reduce((total, event) => total + event.value, 0));
  const previousEvents = events.filter((event) => event.date >= previous.start && event.date <= previous.end);
  const result = {
    id: metric,
    unit,
    shape,
    total: sum(inRange),
    previousTotal: previousEvents.length ? sum(previousEvents) : null,
  };

  if (shape === "breakdown") {
    const totals = new Map<string, number>();
    for (const event of inRange) totals.set(event.name, (totals.get(event.name) ?? 0) + event.value);
    const sorted = [...totals].map(([name, value]) => ({ name, value: round2(value) })).sort((a, b) => b.value - a.value);
    // A pie with thirty slivers says nothing: the long tail becomes "Other".
    const slices = sorted.slice(0, BREAKDOWN_LIMIT);
    const rest = sorted.slice(BREAKDOWN_LIMIT).reduce((total, slice) => total + slice.value, 0);
    if (rest > 0) slices.push({ name: "Other", value: round2(rest) });
    return { ...result, series: [], slices };
  }

  const names = SERIES_ORDER[metric] ?? [...new Set(events.map((event) => event.name))];
  const series = (names.length ? names : [metric]).map((name) => ({
    name,
    values: buckets.map((bucket) =>
      sum(inRange.filter((event) => event.name === name && event.date >= bucket.rangeStart && event.date <= bucket.rangeEnd)),
    ),
  }));
  return { ...result, series, slices: [] };
}

// --- The dashboard's saved layout ---------------------------------------------

export const DASHBOARD_CHART_TYPES = ["bar", "line", "area", "pie"] as const;
export type DashboardChartType = (typeof DASHBOARD_CHART_TYPES)[number];

const FINANCIAL_METRICS: DashboardMetricId[] = ["lesson-value-completed", "lesson-value-future", "invoices", "transactions"];
const BOOKING_METRICS: DashboardMetricId[] = ["bookings", "no-shows", "cancellations", "returning-customers", "booking-source", "lesson-types"];
const PRODUCT_METRICS: DashboardMetricId[] = ["product-sales", "units-sold", "top-products"];

/**
 * Which screens the dashboard shows. Every metric switched on is a screen of
 * its own; `financialTotal` adds one that adds the financial ones together,
 * and two metrics in `compare` add one that plots them on the same chart.
 * `chartTypes` overrides a screen's default chart, keyed by metric id, or
 * "financial-total" and "compare".
 */
export type DashboardConfig = {
  financial: DashboardMetricId[];
  bookings: DashboardMetricId[];
  products: DashboardMetricId[];
  financialTotal: boolean;
  compare: DashboardMetricId[];
  chartTypes: Record<string, DashboardChartType>;
};

/** No saved layout shows what the dashboard always showed: invoiced revenue. */
export const defaultDashboardConfig: DashboardConfig = {
  financial: ["invoices"],
  bookings: [],
  products: [],
  financialTotal: false,
  compare: [],
  chartTypes: {},
};

export function normalizeDashboardConfig(raw: unknown): DashboardConfig {
  if (!raw || typeof raw !== "object") return { ...defaultDashboardConfig, financial: [...defaultDashboardConfig.financial] };
  const value = raw as Record<string, unknown>;
  const pick = (list: unknown, allowed: DashboardMetricId[]) =>
    Array.isArray(list) ? allowed.filter((id) => list.includes(id)) : [];
  const compare = Array.isArray(value.compare)
    ? [...new Set(value.compare.filter((id): id is DashboardMetricId => isDashboardMetricId(id) && DASHBOARD_METRICS[id].shape === "series"))].slice(0, 2)
    : [];
  const chartTypes: Record<string, DashboardChartType> = {};
  if (value.chartTypes && typeof value.chartTypes === "object") {
    for (const [key, type] of Object.entries(value.chartTypes as Record<string, unknown>)) {
      if ((isDashboardMetricId(key) || key === "financial-total" || key === "compare") && DASHBOARD_CHART_TYPES.includes(type as DashboardChartType)) {
        chartTypes[key] = type as DashboardChartType;
      }
    }
  }
  return {
    financial: pick(value.financial, FINANCIAL_METRICS),
    bookings: pick(value.bookings, BOOKING_METRICS),
    products: pick(value.products, PRODUCT_METRICS),
    financialTotal: value.financialTotal === true,
    compare,
    chartTypes,
  };
}
