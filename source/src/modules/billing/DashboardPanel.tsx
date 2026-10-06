// The Billing dashboard's chart card: one screen per metric the coach has
// switched on, a combined financial total, and a comparison of two.
//
// The gear at the top right turns the card into its own settings: Financial,
// Bookings and Products are boards of switches, each switch a screen; Custom
// picks two metrics to plot together; Settings chooses each screen's chart.
// The layout is saved per business (billingDashboardJson), and the numbers
// come from /api/billing/reports/dashboard -- dashboard-metrics.mts on the
// server is the one place they are worked out.

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, X } from "lucide-react";
import { ClaritySettings } from "../shared/ClarityIcons";
import { Loading } from "../shared/Loading";
import { t } from "../../lib/i18n";

type Unit = "money" | "count";
type Shape = "series" | "breakdown";
type Group = "financial" | "bookings" | "products";
export type ChartType = "bar" | "line" | "area" | "pie";
type Period = "week" | "month" | "year";

type MetricMeta = { id: string; group: Group; label: string; help: string; unit: Unit; shape: Shape };

/** Mirrors DASHBOARD_METRICS in netlify/functions/_shared/dashboard-metrics.mts. */
const METRICS: MetricMeta[] = [
  { id: "lesson-value-completed", group: "financial", unit: "money", shape: "series", label: t("Lesson value: completed"), help: t("What lessons already taught are worth at their lesson type's price.") },
  { id: "lesson-value-future", group: "financial", unit: "money", shape: "series", label: t("Lesson value: booked ahead"), help: t("What upcoming booked lessons are worth.") },
  { id: "invoices", group: "financial", unit: "money", shape: "series", label: t("Invoices"), help: t("Sent, paid and overdue invoices, by issue date.") },
  { id: "transactions", group: "financial", unit: "money", shape: "series", label: t("Transaction stream"), help: t("Payments taken at the till and online.") },
  { id: "bookings", group: "bookings", unit: "count", shape: "series", label: t("Bookings"), help: t("Lessons booked, not counting cancellations or no-shows.") },
  { id: "no-shows", group: "bookings", unit: "count", shape: "series", label: t("No-shows"), help: t("Lessons marked as a no-show.") },
  { id: "cancellations", group: "bookings", unit: "count", shape: "series", label: t("Cancellations"), help: t("Lessons cancelled.") },
  { id: "returning-customers", group: "bookings", unit: "count", shape: "series", label: t("Returning customers"), help: t("Each lesson split into a client's first ever lesson and their returns.") },
  { id: "booking-source", group: "bookings", unit: "count", shape: "breakdown", label: t("Booking source"), help: t("Where bookings came from: online, Optix, or made by you or your staff.") },
  { id: "lesson-types", group: "bookings", unit: "count", shape: "breakdown", label: t("Lesson types"), help: t("Bookings by lesson type.") },
  { id: "product-sales", group: "products", unit: "money", shape: "series", label: t("Product sales"), help: t("What products sold for.") },
  { id: "units-sold", group: "products", unit: "count", shape: "series", label: t("Units sold"), help: t("How many products sold.") },
  { id: "top-products", group: "products", unit: "money", shape: "breakdown", label: t("Top products"), help: t("The best-selling products by value.") },
];
const META = new Map(METRICS.map((metric) => [metric.id, metric]));

/** Series names the server sends, in words. */
const SERIES_LABELS: Record<string, string> = {
  New: t("New"),
  Returning: t("Returning"),
  "Online booking": t("Online booking"),
  "Coach or staff": t("Coach or staff"),
  Other: t("Other"),
};

type DashboardConfig = {
  financial: string[];
  bookings: string[];
  products: string[];
  financialTotal: boolean;
  compare: string[];
  chartTypes: Record<string, ChartType>;
};

const DEFAULT_CONFIG: DashboardConfig = { financial: ["invoices"], bookings: [], products: [], financialTotal: false, compare: [], chartTypes: {} };

type MetricResult = {
  id: string;
  unit: Unit;
  shape: Shape;
  series: Array<{ name: string; values: number[] }>;
  slices: Array<{ name: string; value: number }>;
  total: number;
  previousTotal: number | null;
};

type DashboardReport = {
  currency: string;
  buckets: Array<{ label: string; rangeStart: string; rangeEnd: string }>;
  metrics: MetricResult[];
};

type Screen = {
  key: string;
  title: string;
  kind: "single" | "total" | "compare";
  metricIds: string[];
  types: ChartType[];
  defaultType: ChartType;
};

function screensFor(config: DashboardConfig): Screen[] {
  const single = (id: string): Screen | null => {
    const meta = META.get(id);
    if (!meta) return null;
    const breakdown = meta.shape === "breakdown";
    return {
      key: id,
      title: meta.label,
      kind: "single",
      metricIds: [id],
      types: breakdown ? ["pie", "bar"] : ["bar", "line", "area", "pie"],
      // Money reads as amounts per period, so bars; counts over time read as a trend.
      defaultType: breakdown ? "pie" : meta.unit === "money" || id === "returning-customers" ? "bar" : "line",
    };
  };
  const screens: Screen[] = [];
  for (const id of config.financial) {
    const screen = single(id);
    if (screen) screens.push(screen);
  }
  if (config.financialTotal && config.financial.length) {
    screens.push({ key: "financial-total", title: t("Financial total"), kind: "total", metricIds: config.financial, types: ["bar", "line", "area", "pie"], defaultType: "bar" });
  }
  for (const id of [...config.bookings, ...config.products]) {
    const screen = single(id);
    if (screen) screens.push(screen);
  }
  if (config.compare.length === 2) {
    screens.push({
      key: "compare",
      title: `${META.get(config.compare[0])?.label} ${t("vs")} ${META.get(config.compare[1])?.label}`,
      kind: "compare",
      metricIds: config.compare,
      types: ["line", "bar", "area"],
      defaultType: "line",
    });
  }
  return screens;
}

function chartTypeFor(screen: Screen, config: DashboardConfig) {
  const chosen = config.chartTypes[screen.key];
  return chosen && screen.types.includes(chosen) ? chosen : screen.defaultType;
}

const CHART_TYPE_LABELS: Record<ChartType, string> = { bar: t("Bar"), line: t("Line"), area: t("Area"), pie: t("Pie") };

/** A metric's lines summed into one, for a total or a comparison. */
function combined(result: MetricResult | undefined, length: number) {
  return Array.from({ length }, (_, index) => (result?.series ?? []).reduce((sum, line) => sum + (line.values[index] ?? 0), 0));
}

export function DashboardPanel({
  formatMoney,
  fallbackCurrency,
}: {
  formatMoney: (amount: number, currency?: string) => string;
  fallbackCurrency: string;
}) {
  const [config, setConfig] = useState<DashboardConfig>(DEFAULT_CONFIG);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [period, setPeriod] = useState<Period>("month");
  const [report, setReport] = useState<DashboardReport | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "error">("loading");
  const [screenIndex, setScreenIndex] = useState(0);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/billing/reports/dashboard-config", { credentials: "same-origin", cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { config?: DashboardConfig } | null) => {
        if (!cancelled && data?.config) setConfig(data.config);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setConfigLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const screens = useMemo(() => screensFor(config), [config]);
  const metricIds = useMemo(() => [...new Set(screens.flatMap((screen) => screen.metricIds))].sort(), [screens]);
  const metricKey = metricIds.join(",");

  const load = useCallback(async () => {
    if (!metricKey) {
      setReport(null);
      setLoadState("loaded");
      return;
    }
    setLoadState("loading");
    try {
      const response = await fetch(`/api/billing/reports/dashboard?period=${period}&metrics=${encodeURIComponent(metricKey)}`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error(String(response.status));
      setReport((await response.json()) as DashboardReport);
      setLoadState("loaded");
    } catch {
      setLoadState("error");
    }
  }, [metricKey, period]);

  useEffect(() => {
    if (configLoaded) void load();
  }, [configLoaded, load]);

  useEffect(() => {
    if (screenIndex >= screens.length) setScreenIndex(Math.max(0, screens.length - 1));
  }, [screenIndex, screens.length]);

  const screen = screens[screenIndex];
  const currency = report?.currency || fallbackCurrency;

  if (editing) {
    return (
      <DashboardSettings
        config={config}
        onCancel={() => setEditing(false)}
        onSaved={(next) => {
          setConfig(next);
          setScreenIndex(0);
          setEditing(false);
        }}
      />
    );
  }

  return (
    <article className="data-card dash-card">
      <div className="data-card-header dash-head">
        <div>
          <span>{screen ? screen.title : t("Dashboard")}</span>
          <h2>{screen && report ? <ScreenHeadline screen={screen} report={report} currency={currency} formatMoney={formatMoney} /> : "—"}</h2>
        </div>
        <div className="dash-head-actions">
          <div className="revenue-period-toggle" role="tablist" aria-label={t("Dashboard period")}>
            {(["week", "month", "year"] as const).map((option) => (
              <button
                key={option}
                className={period === option ? "active" : ""}
                onClick={() => setPeriod(option)}
                role="tab"
                aria-selected={period === option}
                type="button"
              >
                {option === "week" ? t("Weekly") : option === "month" ? t("Monthly") : t("Yearly")}
              </button>
            ))}
          </div>
          <button className="bh-gear" onClick={() => setEditing(true)} title={t("Choose what the dashboard shows")} aria-label={t("Dashboard settings")} type="button">
            <ClaritySettings size={16} />
          </button>
        </div>
      </div>

      {!screens.length ? (
        <p className="dash-empty">
          {t("Nothing is switched on yet. Use the settings button to choose what this dashboard shows.")}
        </p>
      ) : loadState === "loading" && !report ? (
        <Loading what={t("the dashboard")} />
      ) : loadState === "error" ? (
        <p className="dash-empty">
          {t("The dashboard could not be loaded.")}{" "}
          <button className="text-button" onClick={() => void load()} type="button">{t("Try again")}</button>
        </p>
      ) : screen && report ? (
        <ScreenBody screen={screen} type={chartTypeFor(screen, config)} report={report} currency={currency} formatMoney={formatMoney} />
      ) : null}

      {screens.length > 1 ? (
        <div className="dash-pager">
          <button
            className="icon-button"
            onClick={() => setScreenIndex((index) => (index - 1 + screens.length) % screens.length)}
            aria-label={t("Previous screen")}
            type="button"
          >
            <ChevronLeft size={16} />
          </button>
          <div className="dash-dots">
            {screens.map((entry, index) => (
              <button
                key={entry.key}
                className={index === screenIndex ? "is-active" : ""}
                onClick={() => setScreenIndex(index)}
                aria-label={entry.title}
                aria-current={index === screenIndex ? "true" : undefined}
                title={entry.title}
                type="button"
              />
            ))}
          </div>
          <button
            className="icon-button"
            onClick={() => setScreenIndex((index) => (index + 1) % screens.length)}
            aria-label={t("Next screen")}
            type="button"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      ) : null}
    </article>
  );
}

// --- One screen ---------------------------------------------------------------

type Formatter = (amount: number, currency?: string) => string;

function formatValue(value: number, unit: Unit, currency: string, formatMoney: Formatter) {
  return unit === "money" ? formatMoney(value, currency) : String(Math.round(value * 100) / 100);
}

function ScreenHeadline({ screen, report, currency, formatMoney }: { screen: Screen; report: DashboardReport; currency: string; formatMoney: Formatter }) {
  const results = screen.metricIds.map((id) => report.metrics.find((metric) => metric.id === id));
  if (screen.kind === "compare") {
    return (
      <>
        {results
          .map((result) => (result ? formatValue(result.total, result.unit, currency, formatMoney) : "—"))
          .join(" · ")}
      </>
    );
  }
  const total = results.reduce((sum, result) => sum + (result?.total ?? 0), 0);
  return <>{formatValue(total, results[0]?.unit ?? "money", currency, formatMoney)}</>;
}

function ScreenBody({
  screen,
  type,
  report,
  currency,
  formatMoney,
}: {
  screen: Screen;
  type: ChartType;
  report: DashboardReport;
  currency: string;
  formatMoney: Formatter;
}) {
  const labels = report.buckets.map((bucket) => bucket.label);
  const results = screen.metricIds.map((id) => report.metrics.find((metric) => metric.id === id));
  const first = results[0];
  const unit: Unit = first?.unit ?? "money";

  let series: ChartSeries[] = [];
  let slices: Array<{ name: string; value: number }> = [];
  let indexed = false;
  let note = "";
  let previous: number | null = null;
  let current = 0;

  if (screen.kind === "single" && first) {
    if (first.shape === "breakdown") {
      slices = first.slices.map((slice) => ({ name: SERIES_LABELS[slice.name] ?? slice.name, value: slice.value }));
    } else {
      series = first.series.map((line) => ({
        name: first.series.length > 1 ? SERIES_LABELS[line.name] ?? line.name : screen.title,
        values: line.values,
        unit,
      }));
    }
    previous = first.previousTotal;
    current = first.total;
  } else if (screen.kind === "total") {
    series = [
      {
        name: screen.title,
        values: labels.map((_, index) => results.reduce((sum, result) => sum + combined(result, labels.length)[index], 0)),
        unit: "money",
      },
    ];
    current = results.reduce((sum, result) => sum + (result?.total ?? 0), 0);
    previous = results.every((result) => result?.previousTotal !== null && result?.previousTotal !== undefined)
      ? results.reduce((sum, result) => sum + (result?.previousTotal ?? 0), 0)
      : null;
    if (screen.metricIds.length > 1) {
      note = t("These can overlap. One lesson can count as lesson value, appear on an invoice and be paid at the till, so this total may count it more than once.");
    }
  } else if (screen.kind === "compare") {
    series = results.map((result, index) => ({
      name: META.get(screen.metricIds[index])?.label ?? "",
      values: combined(result, labels.length),
      unit: result?.unit ?? "count",
    }));
    // Never two y-axes. Money and counts share no scale, so each line is
    // drawn as a share of its own busiest bucket; the tooltip keeps the real numbers.
    indexed = series[0]?.unit !== series[1]?.unit;
  }

  const format = (value: number, lineUnit: Unit) => formatValue(value, lineUnit, currency, formatMoney);
  const delta = previous && previous > 0 ? Math.round(((current - previous) / previous) * 100) : null;

  return (
    <>
      {note ? (
        <p className="dash-warning" role="note">
          <AlertTriangle size={16} />
          {note}
        </p>
      ) : null}
      {slices.length || (screen.kind === "single" && first?.shape === "breakdown") ? (
        <BreakdownChart type={type} slices={slices} format={(value) => format(value, unit)} />
      ) : (
        <SeriesChart type={type} labels={labels} series={series} indexed={indexed} format={format} />
      )}
      {indexed ? <p className="dash-footnote">{t("Each line is scaled to its own busiest point, so their shapes can be compared. Hover for the real numbers.")}</p> : null}
      {screen.kind !== "compare" && !(first?.shape === "breakdown") ? (
        <p className="revenue-comparison">
          {previous === null
            ? t("No data from the same period last year yet.")
            : delta === null
              ? t("Same period last year: {previousYearTotal}", { previousYearTotal: format(previous, unit) })
              : delta >= 0
                ? t("Up {pct}% vs. same period last year ({total})", { pct: Math.abs(delta), total: format(previous, unit) })
                : t("Down {pct}% vs. same period last year ({total})", { pct: Math.abs(delta), total: format(previous, unit) })}
        </p>
      ) : null}
    </>
  );
}

// --- Charts -------------------------------------------------------------------
// Plain SVG: a handful of marks does not earn a charting library. Colours are
// the --c-series-* slots, assigned in order and never cycled.

type ChartSeries = { name: string; values: number[]; unit: Unit };

const PLOT_W = 600;
const PLOT_H = 180;

function SeriesChart({
  type,
  labels,
  series,
  indexed,
  format,
}: {
  type: ChartType;
  labels: string[];
  series: ChartSeries[];
  indexed: boolean;
  format: (value: number, unit: Unit) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (type === "pie") {
    // A pie of a series is each period's share of the whole.
    const totals = labels.map((label, index) => ({ name: label, value: series.reduce((sum, line) => sum + (line.values[index] ?? 0), 0) }));
    return <BreakdownChart type="pie" slices={totals} format={(value) => format(value, series[0]?.unit ?? "money")} />;
  }
  const peaks = series.map((line) => Math.max(0, ...line.values));
  const sharedPeak = Math.max(1, ...peaks);
  const y = (value: number, lineIndex: number) => {
    const peak = indexed ? Math.max(1e-9, peaks[lineIndex]) : sharedPeak;
    return PLOT_H - (Math.max(0, value) / (peak || 1)) * (PLOT_H - 8);
  };
  const step = PLOT_W / Math.max(1, labels.length);
  const centre = (index: number) => step * index + step / 2;

  return (
    <div className="dash-chart">
      {series.length > 1 ? (
        <ul className="dash-legend">
          {series.map((line, index) => (
            <li key={line.name}>
              <span className={`dash-swatch series-${index + 1}`} />
              {line.name}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="dash-plot">
        <svg viewBox={`0 0 ${PLOT_W} ${PLOT_H}`} preserveAspectRatio="none" aria-hidden="true">
          <line className="dash-baseline" x1={0} x2={PLOT_W} y1={PLOT_H - 0.5} y2={PLOT_H - 0.5} />
          {type === "bar"
            ? series.map((line, lineIndex) => {
                const groupWidth = Math.min(step * 0.7, 34 * series.length);
                const barWidth = groupWidth / series.length;
                return line.values.map((value, index) => {
                  const top = y(value, lineIndex);
                  return (
                    <rect
                      key={`${lineIndex}-${index}`}
                      className={`dash-bar series-${lineIndex + 1}`}
                      x={centre(index) - groupWidth / 2 + barWidth * lineIndex + 1}
                      y={Math.min(top, PLOT_H - 2)}
                      width={Math.max(1, barWidth - 2)}
                      height={Math.max(2, PLOT_H - top)}
                      rx={3}
                    />
                  );
                });
              })
            : series.map((line, lineIndex) => {
                const points = line.values.map((value, index) => `${centre(index)},${y(value, lineIndex)}`);
                return (
                  <g key={line.name}>
                    {type === "area" ? (
                      <path
                        className={`dash-area series-${lineIndex + 1}`}
                        d={`M${centre(0)},${PLOT_H} L${points.join(" L")} L${centre(line.values.length - 1)},${PLOT_H} Z`}
                      />
                    ) : null}
                    <polyline className={`dash-line series-${lineIndex + 1}`} points={points.join(" ")} />
                  </g>
                );
              })}
          {hover !== null && type !== "bar" ? <line className="dash-crosshair" x1={centre(hover)} x2={centre(hover)} y1={0} y2={PLOT_H} /> : null}
        </svg>
        <div className="dash-hits" onMouseLeave={() => setHover(null)}>
          {labels.map((label, index) => (
            <div
              key={`${label}-${index}`}
              className={`dash-hit${hover === index ? " is-hover" : ""}`}
              onMouseEnter={() => setHover(index)}
              onFocus={() => setHover(index)}
              onBlur={() => setHover(null)}
              tabIndex={0}
              aria-label={`${label}: ${series.map((line) => `${line.name} ${format(line.values[index] ?? 0, line.unit)}`).join(", ")}`}
            >
              {hover === index ? (
                <div className={`dash-tooltip${index > labels.length / 2 ? " is-left" : ""}`} role="tooltip">
                  <strong>{label}</strong>
                  {series.map((line, lineIndex) => (
                    <span key={line.name}>
                      {series.length > 1 ? <i className={`dash-swatch series-${lineIndex + 1}`} /> : null}
                      {series.length > 1 ? `${line.name}: ` : ""}
                      {format(line.values[index] ?? 0, line.unit)}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
      <div className="dash-axis">
        {labels.map((label, index) => (
          <span key={`${label}-${index}`}>{label}</span>
        ))}
      </div>
    </div>
  );
}

function BreakdownChart({
  type,
  slices,
  format,
}: {
  type: ChartType;
  slices: Array<{ name: string; value: number }>;
  format: (value: number) => string;
}) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  if (!total) return <p className="dash-empty">{t("Nothing in this period yet.")}</p>;
  const share = (value: number) => `${Math.round((value / total) * 100)}%`;

  if (type === "bar") {
    const peak = Math.max(...slices.map((slice) => slice.value));
    return (
      <ul className="dash-hbars">
        {slices.map((slice, index) => (
          <li key={slice.name}>
            <span className="dash-hbar-name">{slice.name}</span>
            <span className="dash-hbar-track">
              <span className={`dash-hbar series-${(index % 7) + 1}`} style={{ width: `${Math.max(2, (slice.value / peak) * 100)}%` }} />
            </span>
            <span className="dash-hbar-value">{format(slice.value)}</span>
          </li>
        ))}
      </ul>
    );
  }

  // Donut: arcs drawn as stroked circles, each offset by the ones before it.
  const radius = 70;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div className="dash-donut">
      <svg viewBox="0 0 200 200" role="img" aria-label={slices.map((slice) => `${slice.name} ${share(slice.value)}`).join(", ")}>
        {slices.map((slice, index) => {
          const length = (slice.value / total) * circumference;
          const arc = (
            <circle
              key={slice.name}
              className={`dash-arc series-${(index % 7) + 1}`}
              cx={100}
              cy={100}
              r={radius}
              strokeDasharray={`${Math.max(0, length - 2)} ${circumference}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 100 100)"
            >
              <title>{`${slice.name}: ${format(slice.value)} (${share(slice.value)})`}</title>
            </circle>
          );
          offset += length;
          return arc;
        })}
      </svg>
      <ul className="dash-legend is-column">
        {slices.map((slice, index) => (
          <li key={slice.name}>
            <span className={`dash-swatch series-${(index % 7) + 1}`} />
            <span className="dash-legend-name">{slice.name}</span>
            <span className="dash-legend-value">
              {format(slice.value)} · {share(slice.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- Settings -----------------------------------------------------------------

type SettingsTab = Group | "custom" | "settings";

function DashboardSettings({
  config,
  onCancel,
  onSaved,
}: {
  config: DashboardConfig;
  onCancel: () => void;
  onSaved: (config: DashboardConfig) => void;
}) {
  const [draft, setDraft] = useState<DashboardConfig>(config);
  const [tab, setTab] = useState<SettingsTab>("financial");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const screens = screensFor(draft);

  function toggleMetric(group: Group, id: string, on: boolean) {
    setDraft((current) => {
      const list = current[group].filter((entry) => entry !== id);
      // Keep the catalogue's order, so screens appear in the order they are listed here.
      const next = on ? METRICS.filter((metric) => metric.group === group && (list.includes(metric.id) || metric.id === id)).map((metric) => metric.id) : list;
      return { ...current, [group]: next };
    });
  }

  function toggleCompare(id: string, on: boolean) {
    setDraft((current) => ({
      ...current,
      compare: on ? [...current.compare.filter((entry) => entry !== id), id].slice(-2) : current.compare.filter((entry) => entry !== id),
    }));
  }

  function setChartType(key: string, type: ChartType) {
    setDraft((current) => ({ ...current, chartTypes: { ...current.chartTypes, [key]: type } }));
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/billing/reports/dashboard-config", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ config: draft }),
      });
      const data = (await response.json().catch(() => null)) as { config?: DashboardConfig; message?: string } | null;
      if (!response.ok || !data?.config) throw new Error(data?.message || t("The dashboard settings did not save."));
      onSaved(data.config);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t("The dashboard settings did not save."));
      setSaving(false);
    }
  }

  const tabs: Array<[SettingsTab, string]> = [
    ["financial", t("Financial")],
    ["bookings", t("Bookings")],
    ["products", t("Products")],
    ["custom", t("Custom")],
    ["settings", t("Settings")],
  ];
  const overlapRisk = draft.financial.length > 1;

  return (
    <article className="data-card dash-card dash-settings">
      <div className="data-card-header dash-head">
        <div>
          <span>{t("Dashboard")}</span>
          <h2>{t("Choose what it shows")}</h2>
        </div>
        <button className="icon-button" onClick={onCancel} aria-label={t("Close dashboard settings")} type="button">
          <X size={18} />
        </button>
      </div>

      <div className="dash-tabs" role="tablist" aria-label={t("Dashboard settings")}>
        {tabs.map(([key, label]) => (
          <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)} role="tab" aria-selected={tab === key} type="button">
            {label}
          </button>
        ))}
      </div>

      {tab === "financial" || tab === "bookings" || tab === "products" ? (
        <div className="dash-toggles">
          <p className="dash-hint">{t("Each one you switch on gets its own screen.")}</p>
          {METRICS.filter((metric) => metric.group === tab).map((metric) => (
            <label className="dash-toggle" key={metric.id}>
              <span>
                <strong>{metric.label}</strong>
                <em>{metric.help}</em>
              </span>
              <input type="checkbox" checked={draft[tab].includes(metric.id)} onChange={(event) => toggleMetric(tab, metric.id, event.target.checked)} />
            </label>
          ))}
          {tab === "financial" ? (
            <>
              <label className="dash-toggle">
                <span>
                  <strong>{t("Financial total")}</strong>
                  <em>{t("One more screen adding together everything switched on above.")}</em>
                </span>
                <input
                  type="checkbox"
                  checked={draft.financialTotal}
                  onChange={(event) => setDraft((current) => ({ ...current, financialTotal: event.target.checked }))}
                />
              </label>
              {draft.financialTotal && overlapRisk ? (
                <p className="dash-warning" role="note">
                  <AlertTriangle size={16} />
                  {t("These can overlap. One lesson can count as lesson value, appear on an invoice and be paid at the till, so this total may count it more than once.")}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {tab === "custom" ? (
        <div className="dash-toggles">
          <p className="dash-hint">
            <strong>{t("Comparison")}</strong> · {t("Pick two to plot on the same chart.")}
          </p>
          {METRICS.filter((metric) => metric.shape === "series").map((metric) => {
            const on = draft.compare.includes(metric.id);
            return (
              <label className="dash-toggle" key={metric.id}>
                <span>
                  <strong>{metric.label}</strong>
                </span>
                <input type="checkbox" checked={on} disabled={!on && draft.compare.length >= 2} onChange={(event) => toggleCompare(metric.id, event.target.checked)} />
              </label>
            );
          })}
          {draft.compare.length === 2 ? (
            <ChartTypePicker types={["line", "bar", "area"]} value={draft.chartTypes.compare ?? "line"} onChange={(type) => setChartType("compare", type)} />
          ) : (
            <p className="dash-hint">{t("{count} of 2 picked.", { count: draft.compare.length })}</p>
          )}
        </div>
      ) : null}

      {tab === "settings" ? (
        <div className="dash-toggles">
          {!screens.length ? <p className="dash-hint">{t("Switch something on first, then choose its chart here.")}</p> : null}
          {screens.map((screen) => (
            <div className="dash-screen-type" key={screen.key}>
              <strong>{screen.title}</strong>
              <ChartTypePicker types={screen.types} value={chartTypeFor(screen, draft)} onChange={(type) => setChartType(screen.key, type)} />
            </div>
          ))}
        </div>
      ) : null}

      {error ? <p className="dash-error" role="alert">{error}</p> : null}
      <div className="dash-settings-actions">
        <button className="outline-button" onClick={onCancel} type="button">{t("Cancel")}</button>
        <button className="primary-button" disabled={saving} onClick={() => void save()} type="button">
          {saving ? t("Saving") : t("Save")}
        </button>
      </div>
    </article>
  );
}

/** Small drawings of each chart type, to pick by look rather than by name. */
function ChartTypePicker({ types, value, onChange }: { types: ChartType[]; value: ChartType; onChange: (type: ChartType) => void }) {
  return (
    <div className="dash-type-picker" role="radiogroup" aria-label={t("Chart type")}>
      {types.map((type) => (
        <button key={type} className={value === type ? "is-active" : ""} onClick={() => onChange(type)} role="radio" aria-checked={value === type} type="button">
          <svg viewBox="0 0 40 24" aria-hidden="true">
            {type === "bar" ? (
              <>
                <rect x={4} y={12} width={7} height={12} rx={1.5} />
                <rect x={16} y={5} width={7} height={19} rx={1.5} />
                <rect x={28} y={9} width={7} height={15} rx={1.5} />
              </>
            ) : type === "pie" ? (
              <>
                <circle cx={20} cy={12} r={9} className="is-ring" />
                <path d="M20 3 A9 9 0 0 1 28.2 15.7" className="is-arc" />
              </>
            ) : (
              <>
                {type === "area" ? <path d="M2 20 L12 11 L22 15 L38 4 L38 24 L2 24 Z" className="is-fill" /> : null}
                <polyline points="2,20 12,11 22,15 38,4" className="is-stroke" />
              </>
            )}
          </svg>
          <span>{CHART_TYPE_LABELS[type]}</span>
        </button>
      ))}
    </div>
  );
}
