// Pure helpers for the Billing > Reports tab: date-range presets and CSV
// export. Kept side-effect-free and unit-tested (reportsMath.test.ts) so the
// financial-year boundaries and the exported figures can't silently drift.
// All dates are handled in UTC and formatted YYYY-MM-DD to match the backend
// (billing-api.mts formatDateOnly), which keys invoices/expenses by date only.

import type { BillingReportSummary } from "./types";

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
  "this-month": "This month",
  "last-month": "Last month",
  "this-quarter": "This quarter",
  "this-financial-year": "This financial year",
  "last-financial-year": "Last financial year",
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
  { key: "pl", label: "Profit & Loss" },
  { key: "gst", label: "Tax summary" },
  { key: "chart", label: "Income vs expenses" },
  { key: "expensesByCategory", label: "Expenses by category" },
  { key: "topCustomers", label: "Top customers" },
  { key: "aging", label: "Accounts receivable" },
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

  lines.push(csvRow(["Financial report"]));
  lines.push(csvRow(["Range", `${summary.rangeStart} to ${summary.rangeEnd}`]));
  lines.push(csvRow(["Currency", summary.currency]));
  lines.push(csvRow(["Generated", summary.generatedAt]));
  // Whole-report filter annotation so an exported CSV is never mistaken for the
  // full picture. Totals here already exclude these categories.
  if (summary.expenses.excludedCategoryNames && summary.expenses.excludedCategoryNames.length) {
    lines.push(csvRow(["Filtered", `Expenses exclude: ${summary.expenses.excludedCategoryNames.join("; ")}`]));
  }
  lines.push("");

  if (shown.has("pl")) {
    lines.push(csvRow(["Profit & loss", "Amount"]));
    lines.push(csvRow(["Income", money(summary.income.total)]));
    lines.push(csvRow(["Expenses", money(summary.expenses.total)]));
    lines.push(csvRow(["Net profit", money(summary.netProfit)]));
    lines.push("");

    lines.push(csvRow(["Income by status", "Amount"]));
    lines.push(csvRow(["Paid", money(summary.income.byStatus.paid)]));
    lines.push(csvRow(["Sent", money(summary.income.byStatus.sent)]));
    lines.push(csvRow(["Overdue", money(summary.income.byStatus.overdue)]));
    lines.push("");
  }

  if (shown.has("gst")) {
    lines.push(csvRow([`${summary.taxName} summary (${summary.taxRate}%)`, "Amount"]));
    lines.push(csvRow([`${summary.taxName} collected on income`, money(summary.gst.collected)]));
    lines.push(csvRow([`${summary.taxName} on expenses (est.)`, money(summary.gst.onExpenses)]));
    lines.push(csvRow([`Net ${summary.taxName}`, money(summary.gst.net)]));
    lines.push("");
  }

  if (shown.has("expensesByCategory")) {
    lines.push(csvRow(["Expenses by category", "Count", "Amount"]));
    for (const category of summary.expenses.byCategory) {
      if (excludedCategories.has(category.categoryId)) continue;
      lines.push(csvRow([category.categoryName, category.count, money(category.total)]));
    }
    lines.push("");
  }

  if (shown.has("chart")) {
    lines.push(csvRow(["Month", "Income", "Expenses", "Net"]));
    for (const month of summary.months) {
      lines.push(csvRow([month.label, money(month.income), money(month.expenses), money(month.net)]));
    }
    lines.push("");
  }

  if (shown.has("topCustomers")) {
    lines.push(csvRow(["Top customers", "Invoices", "Income"]));
    for (const customer of summary.topCustomers) {
      lines.push(csvRow([customer.customerName, customer.invoiceCount, money(customer.total)]));
    }
    lines.push("");
  }

  if (shown.has("aging")) {
    lines.push(csvRow([`Accounts receivable (as of ${summary.aging.asOf})`, "Amount"]));
    lines.push(csvRow(["Current", money(summary.aging.current)]));
    lines.push(csvRow(["1-30 days", money(summary.aging.d1_30)]));
    lines.push(csvRow(["31-60 days", money(summary.aging.d31_60)]));
    lines.push(csvRow(["61-90 days", money(summary.aging.d61_90)]));
    lines.push(csvRow(["90+ days", money(summary.aging.d90plus)]));
    lines.push(csvRow(["Total outstanding", money(summary.aging.total)]));
    lines.push("");

    lines.push(csvRow(["Outstanding invoice", "Customer", "Due", "Days overdue", "Outstanding"]));
    for (const invoice of summary.aging.invoices) {
      lines.push(csvRow([invoice.invoiceNumber, invoice.customerName, invoice.dueDate, invoice.daysOverdue, money(invoice.outstanding)]));
    }
  }

  return lines.join("\n").replace(/\n+$/, "");
}
