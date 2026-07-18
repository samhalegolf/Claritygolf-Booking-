// Billing > Reports sub-view. Presentational: it renders the financial summary
// (P&L, GST, income vs expenses, top customers, A/R aging) from the payload it
// is given and reports user intent (range change, export) back through
// callbacks. It owns no fetching or range state - App.tsx does - so it stays
// decoupled from workspace state, matching the other billing slice components.

import { Download, FileText } from "lucide-react";
import type { BillingReportSummary } from "./types";
import { REPORT_PRESET_LABELS, type ReportRangePreset } from "./reportsMath";

const PRESET_ORDER: ReportRangePreset[] = [
  "this-month",
  "last-month",
  "this-quarter",
  "this-financial-year",
  "last-financial-year",
  "custom",
];

const AGING_BUCKETS: Array<{ key: "current" | "d1_30" | "d31_60" | "d61_90" | "d90plus"; label: string }> = [
  { key: "current", label: "Current" },
  { key: "d1_30", label: "1-30 days" },
  { key: "d31_60", label: "31-60 days" },
  { key: "d61_90", label: "61-90 days" },
  { key: "d90plus", label: "90+ days" },
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
  formatMoney,
}: BillingReportsPanelProps) {
  const currency = summary?.currency ?? "NZD";
  const money = (amount: number) => formatMoney(amount, currency);
  const chartMax = Math.max(1, ...(summary?.months.flatMap((month) => [month.income, month.expenses]) ?? [0]));
  const hasActivity =
    !!summary && (summary.income.total !== 0 || summary.expenses.total !== 0 || summary.aging.total !== 0);

  return (
    <div className="billing-reports">
      <article className="data-card report-controls">
        <div className="data-card-header">
          <div>
            <span>Reports</span>
            <h2>Financial summary</h2>
          </div>
          <div className="report-actions">
            <button className="outline-button" onClick={onExportCsv} disabled={!summary} type="button">
              <Download size={16} /> CSV
            </button>
            <button className="outline-button" onClick={onDownloadPdf} disabled={!summary} type="button">
              <FileText size={16} /> PDF
            </button>
          </div>
        </div>
        <div className="revenue-period-toggle report-preset-toggle" role="tablist" aria-label="Report period">
          {PRESET_ORDER.map((option) => (
            <button
              key={option}
              className={preset === option ? "active" : ""}
              onClick={() => onSelectPreset(option)}
              role="tab"
              aria-selected={preset === option}
              type="button"
            >
              {option === "custom" ? "Custom" : REPORT_PRESET_LABELS[option]}
            </button>
          ))}
        </div>
        {preset === "custom" && (
          <div className="report-custom-range">
            <label className="settings-field">
              <span>From</span>
              <input type="date" value={customStart} onChange={(event) => onCustomStartChange(event.target.value)} />
            </label>
            <label className="settings-field">
              <span>To</span>
              <input type="date" value={customEnd} onChange={(event) => onCustomEndChange(event.target.value)} />
            </label>
            <button className="outline-button" onClick={onApplyCustom} disabled={!customStart || !customEnd} type="button">
              Apply
            </button>
          </div>
        )}
        {summary && (
          <p className="field-help report-range-caption">
            {summary.rangeStart} to {summary.rangeEnd}
          </p>
        )}
      </article>

      {loadState === "error" ? (
        <article className="data-card">
          <p>Could not load reports.</p>
          <button className="outline-button" onClick={onRetry} type="button">
            Try again
          </button>
        </article>
      ) : loadState === "loading" && !summary ? (
        <article className="data-card">
          <p>Loading reports...</p>
        </article>
      ) : summary ? (
        <>
          <div className="report-stat-grid">
            <article className="data-card report-stat">
              <span>Income</span>
              <strong>{money(summary.income.total)}</strong>
              <small>{summary.income.invoiceCount} invoice{summary.income.invoiceCount === 1 ? "" : "s"}</small>
            </article>
            <article className="data-card report-stat">
              <span>Expenses</span>
              <strong>{money(summary.expenses.total)}</strong>
              <small>{summary.expenses.count} logged</small>
            </article>
            <article className="data-card report-stat">
              <span>Net profit</span>
              <strong className={summary.netProfit < 0 ? "report-negative" : "report-positive"}>{money(summary.netProfit)}</strong>
              <small>income minus expenses</small>
            </article>
            <article className="data-card report-stat">
              <span>Net {summary.taxName}</span>
              <strong>{money(Math.abs(summary.gst.net))}</strong>
              <small>{summary.gst.net >= 0 ? "payable" : "refund"} · {summary.taxRate}%</small>
            </article>
          </div>

          <article className="data-card">
            <div className="data-card-header">
              <div>
                <span>Income vs expenses</span>
                <h2>{money(summary.netProfit)} net</h2>
              </div>
              <div className="report-legend">
                <span className="report-legend-income">Income</span>
                <span className="report-legend-expense">Expenses</span>
              </div>
            </div>
            {summary.months.length ? (
              <div className="report-chart" aria-hidden="true">
                {summary.months.map((month) => (
                  <div key={month.monthStart} className="report-chart-track" title={`${month.label}: ${money(month.income)} in, ${money(month.expenses)} out`}>
                    <div className="report-chart-bars">
                      <div className="report-chart-bar report-chart-bar-income" style={{ height: `${Math.max(2, Math.round((month.income / chartMax) * 100))}%` }} />
                      <div className="report-chart-bar report-chart-bar-expense" style={{ height: `${Math.max(2, Math.round((month.expenses / chartMax) * 100))}%` }} />
                    </div>
                    <span>{month.label}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="field-help">No activity in this range.</p>
            )}
          </article>

          <div className="billing-dashboard-grid">
            <article className="data-card">
              <div className="data-card-header">
                <div>
                  <span>Expenses</span>
                  <h2>By category</h2>
                </div>
              </div>
              {summary.expenses.byCategory.length ? (
                <ul className="report-breakdown">
                  {summary.expenses.byCategory.map((category) => (
                    <li key={category.categoryId}>
                      <span>{category.categoryName}</span>
                      <strong>{money(category.total)}</strong>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="field-help">No expenses logged in this range.</p>
              )}
            </article>

            <article className="data-card">
              <div className="data-card-header">
                <div>
                  <span>Income</span>
                  <h2>Top customers</h2>
                </div>
              </div>
              {summary.topCustomers.length ? (
                <ul className="report-breakdown">
                  {summary.topCustomers.map((customer) => (
                    <li key={customer.customerName}>
                      <span>
                        {customer.customerName}
                        <small> · {customer.invoiceCount} invoice{customer.invoiceCount === 1 ? "" : "s"}</small>
                      </span>
                      <strong>{money(customer.total)}</strong>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="field-help">No income in this range.</p>
              )}
            </article>
          </div>

          <article className="data-card">
            <div className="data-card-header">
              <div>
                <span>Accounts receivable</span>
                <h2>{money(summary.aging.total)} outstanding</h2>
              </div>
              <small className="field-help">as of {summary.aging.asOf}</small>
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
                    <th>Invoice</th>
                    <th>Customer</th>
                    <th>Due</th>
                    <th className="report-num">Overdue</th>
                    <th className="report-num">Outstanding</th>
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

          {!hasActivity && (
            <p className="field-help">No invoices or expenses fall in this range yet. Pick a wider period or issue an invoice to see figures here.</p>
          )}
        </>
      ) : (
        <article className="data-card">
          <p>No report data yet.</p>
        </article>
      )}
    </div>
  );
}
