import assert from "node:assert/strict";
import test from "node:test";

import { mapAkahuTransaction } from "./akahu.mts";

function txn(overrides: Record<string, any> = {}) {
  return {
    _id: "trans_abc",
    _account: "acc_123",
    _connection: "conn_9",
    date: "2026-07-15T00:00:00.000Z",
    created_at: "2026-07-15T02:10:00.000Z",
    amount: -42.5,
    description: "COUNTDOWN THREE KINGS",
    type: "EFTPOS",
    merchant: { name: "Countdown" },
    category: { name: "Groceries" },
    meta: { particulars: "GROCERIES", code: "3KINGS", reference: "WK28", other_account: "12-3456-7890123-00" },
    ...overrides,
  };
}

test("negative amount maps to an outgoing (expense) row", () => {
  const row = mapAkahuTransaction(txn(), "sam-hale-golf");
  assert.equal(row.id, "trans_abc");
  assert.equal(row.account_id, "sam-hale-golf");
  assert.equal(row.akahu_account_id, "acc_123");
  assert.equal(row.amount, -42.5);
  assert.equal(row.direction, "out");
  assert.equal(row.date, "2026-07-15");
  assert.equal(row.merchant_name, "Countdown");
  assert.equal(row.category_name, "Groceries");
  assert.equal(row.type, "EFTPOS");
});

test("positive amount maps to an incoming (reconcile) row and carries NZ payment refs", () => {
  const row = mapAkahuTransaction(txn({ amount: 480, description: "TRANSFER FROM J HEATH" }), "sam-hale-golf");
  assert.equal(row.direction, "in");
  assert.equal(row.amount, 480);
  assert.equal(row.meta_particulars, "GROCERIES");
  assert.equal(row.meta_code, "3KINGS");
  assert.equal(row.meta_reference, "WK28");
  assert.equal(row.meta_other_account, "12-3456-7890123-00");
});

test("zero amount is treated as incoming, and missing fields are null not undefined", () => {
  const row = mapAkahuTransaction({ _id: "trans_z", date: "2026-01-02", amount: 0 }, "sam-hale-golf");
  assert.equal(row.direction, "in");
  assert.equal(row.merchant_name, null);
  assert.equal(row.meta_reference, null);
  assert.equal(row.akahu_account_id, null);
});
