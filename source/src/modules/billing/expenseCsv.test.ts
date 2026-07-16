import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseExpenseCsv,
  inferExpenseCsvField,
  parseExpenseCsvDate,
  parseExpenseCsvAmount,
  expenseMappingByField,
  buildExpenseCandidates,
} from "./expenseCsv.ts";

test("parseExpenseCsv handles quotes, embedded delimiters and CRLF", () => {
  const rows = parseExpenseCsv('a,b,c\r\n1,"two, still two",3\n');
  assert.deepEqual(rows, [
    ["a", "b", "c"],
    ["1", "two, still two", "3"],
  ]);
});

test("parseExpenseCsv auto-detects a semicolon delimiter", () => {
  assert.deepEqual(parseExpenseCsv("x;y\n1;2"), [
    ["x", "y"],
    ["1", "2"],
  ]);
});

test("inferExpenseCsvField maps common bank headers", () => {
  assert.equal(inferExpenseCsvField("Transaction Date"), "date");
  assert.equal(inferExpenseCsvField("Particulars"), "description");
  assert.equal(inferExpenseCsvField("Debit Amount"), "debit");
  assert.equal(inferExpenseCsvField("Amount"), "debit");
  assert.equal(inferExpenseCsvField("Balance"), "");
});

test("parseExpenseCsvDate normalises dd/mm/yyyy and rejects junk", () => {
  assert.equal(parseExpenseCsvDate("2026-07-16"), "2026-07-16");
  assert.equal(parseExpenseCsvDate("5/3/2026"), "2026-03-05");
  assert.equal(parseExpenseCsvDate("not a date"), "");
});

test("parseExpenseCsvAmount strips symbols and returns a positive magnitude", () => {
  assert.equal(parseExpenseCsvAmount("$1,234.50"), 1234.5);
  assert.equal(parseExpenseCsvAmount("(45.00)"), 45);
  assert.equal(parseExpenseCsvAmount(""), 0);
});

test("buildExpenseCandidates flags only rows with date + description + positive amount", () => {
  const rows = [
    ["16/07/2026", "Coffee beans", "25.00"],
    ["", "No date", "10.00"],
    ["16/07/2026", "Zero amount", "0"],
  ];
  const byField = expenseMappingByField({ 0: "date", 1: "description", 2: "debit" });
  const candidates = buildExpenseCandidates(rows, byField);
  assert.equal(candidates.length, 3);
  assert.deepEqual(
    candidates.map((c) => c.valid),
    [true, false, false],
  );
  assert.equal(candidates[0].date, "2026-07-16");
  assert.equal(candidates[0].amount, 25);
});
