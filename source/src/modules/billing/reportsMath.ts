// Pure helpers for the Billing > Reports tab: date-range presets and CSV
// export. Kept side-effect-free and unit-tested (reportsMath.test.ts) so the
// financial-year boundaries and the exported figures can't silently drift.
// All dates are handled in UTC and formatted YYYY-MM-DD to match the backend
// (billing-api.mts formatDateOnly), which keys invoices/expenses by date only.

import type { BillingReportSummary } from "./types";
import { t } from "../../lib/i18n";

export type ReportRangePreset =
  | "this-month"
  | "last-month"
  | "this-quarter"
  | "this-financial-year"
  | "last-financial-year"
  | "custom";

export type ReportRange = { start: string; end: string };

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utc(year: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex, day));
}

// NZ financial year runs 1 April -> 31 March. The start-of-FY for a reference
// date is 1 April of the same calendar year if we're in April or later,
// otherwise 1 April of the previous year.
export function financialYearStart(ref: Date): Date {
  const year = ref.getUTCFullYear();
  return ref.getUTCMonth() >= 3 ? utc(year, 3, 1) : utc(year - 1, 3, 1);
}

// Resolve a preset to a concrete { start, end }. "custom" has no computable
// range (the caller supplies the dates), so it returns null.
export function presetRange(preset: ReportRangePreset, ref: Date): ReportRange | null {
  const year = ref.getUTCFullYear();
  const month = ref.getUTCMonth();

  switch (preset) {
    case "this-month":
      return { start: ymd(utc(year, month, 1)), end: ymd(utc(year, month + 1, 0)) };
    case "last-month":
      return { start: ymd(utc(year, month - 1, 1)), end: ymd(utc(year, month, 0)) };
    case "this-quarter": {
      const quarterStartMonth = Math.floor(month / 3) * 3;
      return { start: ymd(utc(year, quarterStartMonth, 1)), end: ymd(utc(year, quarterStartMonth + 3, 0)) };
    }
    case "this-financial-year": {
      const fyStart = financialYearStart(ref);
      return { start: ymd(fyStart), end: ymd(utc(fyStart.getUTCFullYear() + 1, 2, 31)) };
    }
    case "last-financial-year": {
      const fyStart = financialYearStart(ref);
      return { start: ymd(utc(fyStart.getUTCFullYear() - 1, 3, 1)), end: ymd(utc(fyStart.getUTCFullYear(), 2, 31)) };
    }
    case "custom":
    default:
      return null;
  }
}

export const REPORT_PRESET_LABELS: Record<Exclude<ReportRangePreset, "custom">, string> = {
  "this-month": t("This month"),
  "last-month": t("Last month"),
  "this-quarter": t("This quarter"),
  "this-financial-year": t("This financial year"),
  "last-financial-year": t("Last financial year"),
};

// The report is a set of toggleable sections: the same keys gate the live
// display (BillingReportsPanel), the CSV (buildReportCsv), and the server PDF
// (billing-api renderReportPdf), so all three always agree on what's included.
export type ReportSectionKey =
  | "pl"
  | "gst"
  | "chart"
  | "expensesByCategory"
  | "topCustomers"
  | "aging";

export const REPORT_SECTIONS: ReadonlyArray<{ key: ReportSectionKey; label: string }> = [
  { key: "pl", label: t("Profit & Loss") },
  { key: "gst", label: t("Tax summary") },
  { key: "chart", label: t("Income vs expenses") },
  { key: "expensesByCategory", label: t("Expenses by category") },
  { key: "topCustomers", label: t("Top customers") },
  { key: "aging", label: t("Accounts receivable") },
];

export const ALL_REPORT_SECTIONS: readonly ReportSectionKey[] = REPORT_SECTIONS.map((section) => section.key);

// Escape a single CSV cell: wrap in quotes and double any embedded quotes when
// the value contains a comma, quote, or newline. Numbers are passed raw.
function csvCell(value: string | number): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRow(cells: Array<string | number>): string {
  return cells.map(csvCell).join(",");
}

// Build a multi-section CSV of the summary: P&L, GST, income by status,
// expenses by category, the month series, top customers, and A/R aging. Blank
// lines separate sections so it stays readable when opened in a spreadsheet.
// `sections` gates which blocks are emitted (defaults to all), so the CSV
// matches whatever the user has toggled on in the live report.
export function buildReportCsv(
  summary: BillingReportSummary,
  sections: readonly ReportSectionKey[] = ALL_REPORT_SECTIONS,
  excludedCategoryIds: readonly string[] = [],
): string {
  const money = (value: number) => value.toFixed(2);
  const shown = new Set(sections);
  const excludedCategories = new Set(excludedCategoryIds);
  const lines: string[] = [];

  lines.push(csvRow([t("Financial report")]));
  lines.push(csvRow([t("Range"), t("{start} to {end}", { start: summary.rangeStart, end: summary.rangeEnd })]));
  lines.push(csvRow([t("Currency"), summary.currency]));
  lines.push(csvRow([t("Generated"), summary.generatedAt]));
  // Whole-report filter annotation so an exported CSV is never mistaken for the
  // full picture. Totals here already exclude these categories.
  if (summary.expenses.excludedCategoryNames && summary.expenses.excludedCategoryNames.length) {
    lines.push(csvRow([t("Filtered"), t("Expenses exclude: {categories}", { categories: summary.expenses.excludedCategoryNames.join("; ") })]));
  }
  lines.push("");

  if (shown.has("pl")) {
    lines.push(csvRow([t("Profit & loss"), t("Amount")]));
    lines.push(csvRow([t("Income"), money(summary.income.total)]));
    lines.push(csvRow([t("Expenses"), money(summary.expenses.total)]));
    lines.push(csvRow([t("Net profit"), money(summary.netProfit)]));
    lines.push("");

    lines.push(csvRow([t("Income by status"), t("Amount")]));
    lines.push(csvRow([t("Paid"), money(summary.income.byStatus.paid)]));
    lines.push(csvRow([t("Sent"), money(summary.income.byStatus.sent)]));
    lines.push(csvRow([t("Overdue"), money(summary.income.byStatus.overdue)]));
    lines.push("");
  }

  if (shown.has("gst")) {
    lines.push(csvRow([t("{taxName} summary ({taxRate}%)", { taxName: summary.taxName, taxRate: summary.taxRate }), t("Amount")]));
    lines.push(csvRow([t("{taxName} collected on income", { taxName: summary.taxName }), money(summary.gst.collected)]));
    lines.push(csvRow([t("{taxName} on expenses (est.)", { taxName: summary.taxName }), money(summary.gst.onExpenses)]));
    lines.push(csvRow([t("Net {taxName}", { taxName: summary.taxName }), money(summary.gst.net)]));
    lines.push("");
  }

  if (shown.has("expensesByCategory")) {
    lines.push(csvRow([t("Expenses by category"), t("Count"), t("Amount")]));
    for (const category of summary.expenses.byCategory) {
      if (excludedCategories.has(category.categoryId)) continue;
      lines.push(csvRow([category.categoryName, category.count, money(category.total)]));
    }
    lines.push("");
  }

  if (shown.has("chart")) {
    lines.push(csvRow([t("Month"), t("Income"), t("Expenses"), t("Net")]));
    for (const month of summary.months) {
      lines.push(csvRow([month.label, money(month.income), money(month.expenses), money(month.net)]));
    }
    lines.push("");
  }

  if (shown.has("topCustomers")) {
    lines.push(csvRow([t("Top customers"), t("Invoices"), t("Income")]));
    for (const customer of summary.topCustomers) {
      lines.push(csvRow([customer.customerName, customer.invoiceCount, money(customer.total)]));
    }
    lines.push("");
  }

  if (shown.has("aging")) {
    lines.push(csvRow([t("Accounts receivable (as of {date})", { date: summary.aging.asOf }), t("Amount")]));
    lines.push(csvRow([t("Current"), money(summary.aging.current)]));
    lines.push(csvRow([t("1-30 days"), money(summary.aging.d1_30)]));
    lines.push(csvRow([t("31-60 days"), money(summary.aging.d31_60)]));
    lines.push(csvRow([t("61-90 days"), money(summary.aging.d61_90)]));
    lines.push(csvRow([t("90+ days"), money(summary.aging.d90plus)]));
    lines.push(csvRow([t("Total outstanding"), money(summary.aging.total)]));
    lines.push("");

    lines.push(csvRow([t("Outstanding invoice"), t("Customer"), t("Due"), t("Days overdue"), t("Outstanding")]));
    for (const invoice of summary.aging.invoices) {
      lines.push(csvRow([invoice.invoiceNumber, invoice.customerName, invoice.dueDate, invoice.daysOverdue, money(invoice.outstanding)]));
    }
  }

  return lines.join("\n").replace(/\n+$/, "");
}
