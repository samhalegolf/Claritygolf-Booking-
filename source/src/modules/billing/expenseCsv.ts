// Bank-CSV expense import: pure parsing + candidate building. No React, no
// state - the expenses UI feeds it raw file text and a column mapping and gets
// back rows to preview/import. Extracted verbatim from App.tsx (see
// expenseCsv.test.ts); logic unchanged.

import { dateInputValue } from "../../lib/date";

export type ExpenseCsvField = "" | "date" | "description" | "debit" | "credit" | "reference";

// Which column index holds each mapped field.
export type ExpenseCsvMappingByField = Partial<Record<ExpenseCsvField, number>>;

export type ExpenseCandidate = {
  index: number;
  date: string;
  description: string;
  amount: number;
  reference: string;
  valid: boolean;
};

export function guessExpenseCsvDelimiter(text: string) {
  const sample = text.split(/\r?\n/).slice(0, 8).join("\n");
  return (
    [",", "\t", ";"]
      .map((delimiter) => ({ delimiter, count: [...sample].filter((char) => char === delimiter).length }))
      .sort((a, b) => b.count - a.count)[0]?.delimiter || ","
  );
}

export function parseExpenseCsv(text: string): string[][] {
  const delimiter = guessExpenseCsvDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const input = text.replace(/^﻿/, "");

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

// Bank column names vary a lot; this only needs to get close, since the
// mapping UI always lets the user correct it before anything imports.
export function inferExpenseCsvField(header: string): ExpenseCsvField {
  const key = header.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!key) return "";
  if (key.includes("date")) return "date";
  if (key.includes("debit")) return "debit";
  if (key.includes("credit")) return "credit";
  if (key.includes("reference") || key === "uniqueid" || key === "id") return "reference";
  if (key.includes("payee") || key.includes("description") || key.includes("memo") || key.includes("particulars") || key.includes("narrative") || key.includes("details")) {
    return "description";
  }
  if (key === "amount") return "debit";
  return "";
}

// NZ bank exports are typically dd/mm/yyyy. ISO strings pass through
// untouched; anything unrecognised returns "" so the row is flagged invalid
// rather than silently imported with a wrong date.
export function parseExpenseCsvDate(value: string): string {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const dmy = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    const [, day, month, year] = dmy;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? "" : dateInputValue(parsed);
}

// Strips currency symbols/thousands separators; treats parenthesised values
// as negative (some exports show debits that way) but always returns a
// positive magnitude, since the caller already knows this is the debit
// (money-out) column - the sign convention lives in which column was picked,
// not in the value itself.
export function parseExpenseCsvAmount(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const numeric = Number(trimmed.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(numeric) ? Math.abs(numeric) : 0;
}

// Collapses the per-column mapping ({ colIndex: field }) into a lookup keyed by
// field, so candidate building can find the column for each field directly.
export function expenseMappingByField(mapping: Record<number, ExpenseCsvField>): ExpenseCsvMappingByField {
  const map: ExpenseCsvMappingByField = {};
  Object.entries(mapping).forEach(([colIndex, field]) => {
    if (field) map[field] = Number(colIndex);
  });
  return map;
}

// Turns parsed rows + a field mapping into preview candidates. A row is valid
// (importable) only when it has a date, a description, and a positive amount.
export function buildExpenseCandidates(
  rows: string[][],
  mappingByField: ExpenseCsvMappingByField,
): ExpenseCandidate[] {
  const cell = (row: string[], field: ExpenseCsvField) => {
    const colIndex = mappingByField[field];
    return colIndex === undefined ? "" : (row[colIndex] || "").trim();
  };
  return rows.map((row, index) => {
    const date = parseExpenseCsvDate(cell(row, "date"));
    const description = cell(row, "description");
    const amount = parseExpenseCsvAmount(cell(row, "debit"));
    const reference = cell(row, "reference");
    return { index, date, description, amount, reference, valid: Boolean(date) && Boolean(description) && amount > 0 };
  });
}
