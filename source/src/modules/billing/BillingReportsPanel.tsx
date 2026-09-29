import { Loading } from "../shared/Loading";
// Billing > Reports sub-view. Presentational: it renders the financial summary
// (P&L, GST, income vs expenses, top customers, A/R aging) from the payload it
// is given and reports user intent (range change, export) back through
// callbacks. It owns no fetching or range state - App.tsx does - so it stays
// decoupled from workspace state, matching the other billing slice components.

import { Download } from "lucide-react";
import { ClarityBookingPages } from "../shared/ClarityIcons";
import type { BillingReportSummary } from "./types";
import {
  REPORT_PRESET_LABELS,
  REPORT_SECTIONS,
  type ReportRangePreset,
  type ReportSectionKey,
} from "./reportsMath";
import { t, tn } from "../../lib/i18n";

const PRESET_ORDER: ReportRangePreset[] = [
  "this-month",
  "last-month",
  "this-quarter",
  "this-financial-year",
  "last-financial-year",
  "custom",
];

const AGING_BUCKETS: Array<{ key: "current" | "d1_30" | "d31_60" | "d61_90" | "d90plus"; label: string }> = [
  { key: "current", label: t("Current") },
  { key: "d1_30", label: t("1-30 days") },
  { key: "d31_60", label: t("31-60 days") },
  { key: "d61_90", label: t("61-90 days") },
  { key: "d90plus", label: t("90+ days") },
];

export type BillingReportsPanelProps = {
  summary: BillingReportSummary | null;
  loadState: "idle" | "loading" | "loaded" | "error";
  preset: ReportRangePreset;
  onSelectPreset: (preset: ReportRangePreset) => void;
  customStart: string;
  customEnd: string;
  onCustomStartChange: (value: string) => void;
  onCustomEndChange: (value: string) => void;
  onApplyCustom: () => void;
  onExportCsv: () => void;
  onDownloadPdf: () => void;
  onRetry: () => void;
  enabledSections: readonly ReportSectionKey[];
  onToggleSection: (key: ReportSectionKey) => void;
  excludedCategories: readonly string[];
  onToggleCategory: (categoryId: string) => void;
  onClearCategories: () => void;
  formatMoney: (amount: number, currency: string) => string;
};

export function BillingReportsPanel({
  summary,
  loadState,
  preset,
  onSelectPreset,
  customStart,
  customEnd,
  onCustomStartChange,
  onCustomEndChange,
  onApplyCustom,
  onExportCsv,
  onDownloadPdf,
  onRetry,
  enabledSections,
  onToggleSection,
  excludedCategories,
  onToggleCategory,
  onClearCategories,
  formatMoney,
}: BillingReportsPanelProps) {
  const currency = summary?.currency ?? "";
  const money = (amount: number) => formatMoney(amount, currency);
  const chartMax = Math.max(1, ...(summary?.months.flatMap((month) => [month.income, month.expenses]) ?? [0]));
  const hasActivity =
    !!summary && (summary.income.total !== 0 || summary.expenses.total !== 0 || summary.aging.total !== 0);
  const shown = new Set(enabledSections);
  const sectionLabel = (key: ReportSectionKey, fallback: string) =>
    key === "gst" && summary ? `${summary.taxName} summary` : fallback;
  const showStatGrid = shown.has("pl") || shown.has("gst");
  // Expense-category filter (in the by-category section): excluded ids drop out
  // of the breakdown list + exports; the headline Expenses total stays the true
  // total, and a subtotal line makes the filtered view explicit.
  const excludedCategorySet = new Set(excludedCategories);
  const shownExpenseCategories = summary
    ? summary.expenses.byCategory.filter((category) => !excludedCategorySet.has(category.categoryId))
    : [];

  return (
    <div className="billing-reports">
      <article className="data-card report-controls">
        <div className="data-card-header">
          <div>
            <span>{t("Reports")}</span>
            <h2>{t("Financial summary")}</h2>
          </div>
          <div className="report-actions">
            <button className="outline-button" onClick={onExportCsv} disabled={!summary} type="button">
              <Download size={16} />{" "}{t("CSV")}</button>
            <button className="outline-button" onClick={onDownloadPdf} disabled={!summary} type="button">
              <ClarityBookingPages size={16} />{" "}{t("PDF")}</button>
          </div>
        </div>
        <div className="revenue-period-toggle report-preset-toggle" role="tablist" aria-label={t("Report period")}>
          {PRESET_ORDER.map((option) => (
            <button
              key={option}
              className={preset === option ? "active" : ""}
              onClick={() => onSelectPreset(option)}
              role="tab"
              aria-selected={preset === option}
              type="button"
            >
              {option === "custom" ? t("Custom") : REPORT_PRESET_LABELS[option]}
            </button>
          ))}
        </div>
        {preset === "custom" && (
          <div className="report-custom-range">
            <label className="settings-field">
              <span>{t("From")}</span>
              <input className="w-date" type="date" value={customStart} onChange={(event) => onCustomStartChange(event.target.value)} />
            </label>
            <label className="settings-field">
              <span>{t("To")}</span>
              <input className="w-date" type="date" value={customEnd} onChange={(event) => onCustomEndChange(event.target.value)} />
            </label>
            <button className="outline-button" onClick={onApplyCustom} disabled={!customStart || !customEnd} type="button">{t("Apply")}</button>
          </div>
        )}
        {summary && (
          <p className="field-help report-range-caption">{t("{rangeStart} to {rangeEnd}", { rangeStart: summary.rangeStart, rangeEnd: summary.rangeEnd })}</p>
        )}
        {summary && (
          <div className="report-section-toggle" role="group" aria-label={t("Include sections")}>
            <span className="report-toggle-label">{t("Include:")}</span>
            {REPORT_SECTIONS.map((section) => {
              const on = shown.has(section.key);
              return (
                <button
                  key={section.key}
                  type="button"
                  className={on ? "active" : ""}
                  aria-pressed={on}
                  onClick={() => onToggleSection(section.key)}
                >
                  {sectionLabel(section.key, section.label)}
                </button>
              );
            })}
          </div>
        )}
      </article>

      {loadState === "error" ? (
        <article className="data-card">
          <p>{t("Could not load reports.")}</p>
          <button className="outline-button" onClick={onRetry} type="button">{t("Try again")}</button>
        </article>
      ) : loadState === "loading" && !summary ? (
        <article className="data-card">
          <Loading what={t("reports")} />
        </article>
      ) : summary ? (
        <>
          {summary.expenses.excludedCategoryNames && summary.expenses.excludedCategoryNames.length > 0 && (
            <div className="report-filter-banner" role="status">
              <span>
                <strong>{t("Filtered report")}</strong>{" "}{t("— expense figures (total, net profit, {taxName}, chart) exclude: {excludedCategoryNames}. Income, top customers and A/R are unaffected.", { taxName: summary.taxName, excludedCategoryNames: summary.expenses.excludedCategoryNames.join(", ") })}</span>
              <button className="text-button" type="button" onClick={onClearCategories}>{t("Show all categories")}</button>
            </div>
          )}
          {showStatGrid && (
            <div className="report-stat-grid">
              {shown.has("pl") && (
                <>
                  <article className="data-card report-stat">
                    <span>{t("Income")}</span>
                    <strong>{money(summary.income.total)}</strong>
                    <small>{tn(summary.income.invoiceCount, "{count} invoice", "{count} invoices")}</small>
                  </article>
                  <article className="data-card report-stat">
                    <span>{t("Expenses")}</span>
                    <strong>{money(summary.expenses.total)}</strong>
                    <small>{t("{count} logged", { count: summary.expenses.count })}</small>
                  </article>
                  <article className="data-card report-stat">
                    <span>{t("Net profit")}</span>
                    <strong className={summary.netProfit < 0 ? "report-negative" : "report-positive"}>{money(summary.netProfit)}</strong>
                    <small>{t("income minus expenses")}</small>
                  </article>
                </>
              )}
              {shown.has("gst") && (
                <article className="data-card report-stat">
                  <span>{t("Net {taxName}", { taxName: summary.taxName })}</span>
                  <strong>{money(Math.abs(summary.gst.net))}</strong>
                  <small>{summary.gst.net >= 0 ? "payable" : "refund"} · {summary.taxRate}%</small>
                </article>
              )}
            </div>
          )}

          {shown.has("chart") && (
          <article className="data-card">
            <div className="data-card-header">
              <div>
                <span>{t("Income vs expenses")}</span>
                <h2>{t("{netProfit} net", { netProfit: money(summary.netProfit) })}</h2>
              </div>
              <div className="report-legend">
                <span className="report-legend-income">{t("Income")}</span>
                <span className="report-legend-expense">{t("Expenses")}</span>
              </div>
            </div>
            {summary.months.length ? (
              <div className="report-chart" aria-hidden="true">
                {summary.months.map((month) => (
                  <div key={month.monthStart} className="report-chart-track" title={t("{label}: {income} in, {expenses} out", { label: month.label, income: money(month.income), expenses: money(month.expenses) })}>
                    <div className="report-chart-bars">
                      <div className="report-chart-bar report-chart-bar-income" style={{ height: `${Math.max(2, Math.round((month.income / chartMax) * 100))}%` }} />
                      <div className="report-chart-bar report-chart-bar-expense" style={{ height: `${Math.max(2, Math.round((month.expenses / chartMax) * 100))}%` }} />
                    </div>
                    <span>{month.label}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="field-help">{t("No activity in this range.")}</p>
            )}
          </article>
          )}

          {(shown.has("expensesByCategory") || shown.has("topCustomers")) && (
          <div className="billing-dashboard-grid">
            {shown.has("expensesByCategory") && (
            <article className="data-card">
              <div className="data-card-header">
                <div>
                  <span>{t("Expenses")}</span>
                  <h2>{t("By category")}</h2>
                </div>
              </div>
              {summary.expenses.byCategory.length ? (
                <>
                  {summary.expenses.byCategory.length > 1 && (
                    <div className="report-category-toggle" role="group" aria-label={t("Include expense categories")}>
                      <span className="report-toggle-label">{t("Categories:")}</span>
                      {summary.expenses.byCategory.map((category) => {
                        const on = !excludedCategorySet.has(category.categoryId);
                        return (
                          <button
                            key={category.categoryId}
                            type="button"
                            className={on ? "active" : ""}
                            aria-pressed={on}
                            onClick={() => onToggleCategory(category.categoryId)}
                          >
                            {category.categoryName}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {shownExpenseCategories.length ? (
                    <ul className="report-breakdown">
                      {shownExpenseCategories.map((category) => (
                        <li key={category.categoryId}>
                          <span>{category.categoryName}</span>
                          <strong>{money(category.total)}</strong>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="field-help">{t("No categories selected.")}</p>
                  )}
                </>
              ) : (
                <p className="field-help">{t("No expenses logged in this range.")}</p>
              )}
            </article>
            )}

            {shown.has("topCustomers") && (
            <article className="data-card">
              <div className="data-card-header">
                <div>
                  <span>{t("Income")}</span>
                  <h2>{t("Top customers")}</h2>
                </div>
              </div>
              {summary.topCustomers.length ? (
                <ul className="report-breakdown">
                  {summary.topCustomers.map((customer) => (
                    <li key={customer.customerName}>
                      <span>
                        {customer.customerName}
                        <small>{" "}{tn(customer.invoiceCount, "· {count} invoice", "· {count} invoices")}</small>
                      </span>
                      <strong>{money(customer.total)}</strong>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="field-help">{t("No income in this range.")}</p>
              )}
            </article>
            )}
          </div>
          )}

          {shown.has("aging") && (
          <article className="data-card">
            <div className="data-card-header">
              <div>
                <span>{t("Accounts receivable")}</span>
                <h2>{t("{total} outstanding", { total: money(summary.aging.total) })}</h2>
              </div>
              <small className="field-help">{t("as of {asOf}", { asOf: summary.aging.asOf })}</small>
            </div>
            <div className="report-aging-grid">
              {AGING_BUCKETS.map((bucket) => (
                <div key={bucket.key} className={`report-aging-cell${bucket.key === "d90plus" && summary.aging.d90plus > 0 ? " report-aging-danger" : ""}`}>
                  <span>{bucket.label}</span>
                  <strong>{money(summary.aging[bucket.key])}</strong>
                </div>
              ))}
            </div>
            {summary.aging.invoices.length > 0 && (
              <table className="report-aging-table">
                <thead>
                  <tr>
                    <th>{t("Invoice")}</th>
                    <th>{t("Customer")}</th>
                    <th>{t("Due")}</th>
                    <th className="report-num">{t("Overdue")}</th>
                    <th className="report-num">{t("Outstanding")}</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.aging.invoices.map((invoice) => (
                    <tr key={invoice.invoiceNumber}>
                      <td>{invoice.invoiceNumber}</td>
                      <td>{invoice.customerName}</td>
                      <td>{invoice.dueDate}</td>
                      <td className="report-num">{invoice.daysOverdue === 0 ? "-" : `${invoice.daysOverdue}d`}</td>
                      <td className="report-num">{money(invoice.outstanding)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </article>
          )}

          {enabledSections.length === 0 && (
            <p className="field-help">{t("No sections selected. Use the “Include” buttons above to add sections to the report.")}</p>
          )}
          {!hasActivity && enabledSections.length > 0 && (
            <p className="field-help">{t("No invoices or expenses fall in this range yet. Pick a wider period or issue an invoice to see figures here.")}</p>
          )}
        </>
      ) : (
        <article className="data-card">
          <p>{t("No report data yet.")}</p>
        </article>
      )}
    </div>
  );
}
