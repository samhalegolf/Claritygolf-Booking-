import { test } from "node:test";
import assert from "node:assert/strict";
import { financialYearStart, presetRange, buildReportCsv } from "./reportsMath.ts";
import type { BillingReportSummary } from "./types.ts";

const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

test("financial year starts 1 April, same year from April onward", () => {
  assert.equal(financialYearStart(utc("2026-07-18")).toISOString().slice(0, 10), "2026-04-01");
  assert.equal(financialYearStart(utc("2026-04-01")).toISOString().slice(0, 10), "2026-04-01");
});

test("financial year rolls back to previous April before April", () => {
  assert.equal(financialYearStart(utc("2026-03-31")).toISOString().slice(0, 10), "2025-04-01");
  assert.equal(financialYearStart(utc("2026-01-10")).toISOString().slice(0, 10), "2025-04-01");
});

test("this-month / last-month span whole months", () => {
  assert.deepEqual(presetRange("this-month", utc("2026-07-18")), { start: "2026-07-01", end: "2026-07-31" });
  assert.deepEqual(presetRange("last-month", utc("2026-01-15")), { start: "2025-12-01", end: "2025-12-31" });
});

test("this-quarter snaps to the calendar quarter", () => {
  assert.deepEqual(presetRange("this-quarter", utc("2026-07-18")), { start: "2026-07-01", end: "2026-09-30" });
  assert.deepEqual(presetRange("this-quarter", utc("2026-02-02")), { start: "2026-01-01", end: "2026-03-31" });
});

test("financial-year presets cover Apr 1 -> Mar 31", () => {
  assert.deepEqual(presetRange("this-financial-year", utc("2026-07-18")), { start: "2026-04-01", end: "2027-03-31" });
  assert.deepEqual(presetRange("last-financial-year", utc("2026-07-18")), { start: "2025-04-01", end: "2026-03-31" });
  // Before April, "this" FY is the one that began the previous April.
  assert.deepEqual(presetRange("this-financial-year", utc("2026-02-01")), { start: "2025-04-01", end: "2026-03-31" });
});

test("custom preset has no computed range", () => {
  assert.equal(presetRange("custom", utc("2026-07-18")), null);
});

function summary(): BillingReportSummary {
  return {
    currency: "NZD",
    taxName: "GST",
    taxRate: 15,
    rangeStart: "2026-04-01",
    rangeEnd: "2026-06-30",
    generatedAt: "2026-07-18T00:00:00.000Z",
    income: { total: 1000, invoiceCount: 3, byStatus: { sent: 400, paid: 500, overdue: 100 } },
    expenses: {
      total: 230,
      count: 2,
      byCategory: [{ categoryId: "c1", categoryName: "Travel, gear", total: 230, count: 2 }],
    },
    netProfit: 770,
    gst: { collected: 130.43, onExpenses: 30, net: 100.43 },
    months: [{ label: "Apr 26", monthStart: "2026-04-01", income: 1000, expenses: 230, net: 770 }],
    topCustomers: [{ customerName: "Golf HQ", total: 1000, invoiceCount: 3 }],
    aging: {
      asOf: "2026-07-18",
      current: 0,
      d1_30: 100,
      d31_60: 0,
      d61_90: 0,
      d90plus: 0,
      total: 100,
      invoices: [{ invoiceNumber: "SHG-0401", customerName: "Golf HQ", dueDate: "2026-06-20", daysOverdue: 28, outstanding: 100, bucket: "d1_30" }],
    },
  };
}

test("CSV includes every section and quotes cells with commas", () => {
  const csv = buildReportCsv(summary());
  assert.match(csv, /Profit & loss/);
  assert.match(csv, /Net profit,770\.00/);
  assert.match(csv, /GST summary \(15%\)/);
  assert.match(csv, /Top customers/);
  assert.match(csv, /Total outstanding,100\.00/);
  // A category name containing a comma must be quoted so columns don't shift.
  assert.match(csv, /"Travel, gear",2,230\.00/);
  assert.match(csv, /SHG-0401,Golf HQ,2026-06-20,28,100\.00/);
});

test("CSV only emits the selected sections", () => {
  const csv = buildReportCsv(summary(), ["pl", "aging"]);
  // Selected sections present...
  assert.match(csv, /Profit & loss/);
  assert.match(csv, /Total outstanding,100\.00/);
  // ...unselected ones omitted entirely.
  assert.doesNotMatch(csv, /GST summary/);
  assert.doesNotMatch(csv, /Top customers/);
  assert.doesNotMatch(csv, /Expenses by category/);
});

test("CSV with no sections still carries the header", () => {
  const csv = buildReportCsv(summary(), []);
  assert.match(csv, /Financial report/);
  assert.doesNotMatch(csv, /Profit & loss/);
});

test("CSV drops excluded expense categories from the by-category block", () => {
  const csv = buildReportCsv(summary(), ["expensesByCategory"], ["c1"]);
  // Header stays; the excluded category row is gone.
  assert.match(csv, /Expenses by category/);
  assert.doesNotMatch(csv, /"Travel, gear"/);
});

test("CSV annotates the filtered categories when the summary names them", () => {
  const filtered = summary();
  filtered.expenses.excludedCategoryNames = ["Personal", "Drawings"];
  const csv = buildReportCsv(filtered);
  assert.match(csv, /Filtered,Expenses exclude: Personal; Drawings/);
});
