import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addCustomSellLine,
  addSellLine,
  addToBasket,
  cashSuggestions,
  changeDue,
  basketTotal,
  describeBasket,
  isLowStock,
  lineTotal,
  sellTaxIncluded,
  sellTotal,
  setBasketQuantity,
  setSellPrice,
  setSellQuantity,
  stockAdjustmentDelta,
  stockAfterBasket,
} from "./stockMath.ts";
import type { BillingCatalogItem } from "./types.ts";

function product(partial: Partial<BillingCatalogItem> = {}): BillingCatalogItem {
  return {
    id: "p1",
    kind: "product",
    name: "Golf glove",
    description: "",
    price: 29.95,
    taxRate: 15,
    sku: "GL-01",
    supplier: "Titleist",
    costPrice: 14,
    trackStock: true,
    stockLevel: 10,
    lowStockThreshold: 3,
    ...partial,
  };
}

test("line and basket totals round per line, not at the end", () => {
  assert.equal(lineTotal({ quantity: 3, unitPrice: 0.335 }), 1.01);
  // Three lines that each round up must sum to the printed column, not to
  // 3 x 0.335 = 1.005 rounded once.
  assert.equal(basketTotal([
    { quantity: 1, unitPrice: 0.335 },
    { quantity: 1, unitPrice: 0.335 },
    { quantity: 1, unitPrice: 0.335 },
  ]), 1.02);
  assert.equal(basketTotal([]), 0);
});

test("adding the same product twice increases its quantity", () => {
  const once = addToBasket([], product());
  assert.equal(once.length, 1);
  assert.equal(once[0].quantity, 1);
  assert.equal(once[0].unitPrice, 29.95);

  const twice = addToBasket(once, product());
  assert.equal(twice.length, 1);
  assert.equal(twice[0].quantity, 2);

  const other = addToBasket(twice, product({ id: "p2", name: "Sleeve of balls" }));
  assert.equal(other.length, 2);
});

test("setting a quantity to zero removes the line", () => {
  const lines = addToBasket(addToBasket([], product()), product({ id: "p2", name: "Balls" }));
  assert.equal(setBasketQuantity(lines, "p1", 4)[0].quantity, 4);
  assert.deepEqual(setBasketQuantity(lines, "p1", 0).map((line) => line.productId), ["p2"]);
  assert.deepEqual(setBasketQuantity(lines, "p1", -2).map((line) => line.productId), ["p2"]);
});

test("basket description matches what the backend derives", () => {
  const lines = setBasketQuantity(addToBasket(addToBasket([], product()), product({ id: "p2", name: "Balls" })), "p1", 2);
  assert.equal(describeBasket(lines), "Golf glove x2, Balls");
});

test("low stock covers out-of-stock, at-threshold and threshold-off", () => {
  assert.equal(isLowStock(product({ stockLevel: 10 })), false);
  assert.equal(isLowStock(product({ stockLevel: 3 })), true);
  assert.equal(isLowStock(product({ stockLevel: 0 })), true);
  assert.equal(isLowStock(product({ stockLevel: -1 })), true);
  // Threshold 0 means "don't warn me" - only an empty shelf still counts.
  assert.equal(isLowStock(product({ stockLevel: 1, lowStockThreshold: 0 })), false);
  assert.equal(isLowStock(product({ stockLevel: 0, lowStockThreshold: 0 })), true);
  // A service has nothing to count, whatever the columns say.
  assert.equal(isLowStock(product({ trackStock: false, stockLevel: 0 })), false);
});

test("stock after a basket only moves for tracked products", () => {
  const lines = setBasketQuantity(addToBasket([], product()), "p1", 4);
  assert.equal(stockAfterBasket(product(), lines), 6);
  assert.equal(stockAfterBasket(product({ trackStock: false }), lines), 10);
  assert.equal(stockAfterBasket(product({ id: "p2" }), lines), 10);
});

test("a stocktake is stored as the correction, not the number typed", () => {
  assert.equal(stockAdjustmentDelta("setTo", 7, 4), -3);
  assert.equal(stockAdjustmentDelta("setTo", 4, 4), 0);
  assert.equal(stockAdjustmentDelta("delta", 7, 6), 6);
  assert.equal(stockAdjustmentDelta("delta", 7, -2), -2);
});

test("docket lines merge catalog items but never custom ones", () => {
  const once = addSellLine([], product());
  assert.equal(addSellLine(once, product())[0].quantity, 2);
  assert.equal(addSellLine(once, product({ id: "p2", name: "Balls" })).length, 2);

  // Two $10 "custom" lines are two different things the customer is paying for.
  const custom = addCustomSellLine(addCustomSellLine([], "Range balls", 10, 15), "Range balls", 10, 15);
  assert.equal(custom.length, 2);
  assert.equal(custom[0].productId, "");
  assert.notEqual(custom[0].key, custom[1].key);
});

test("docket quantity and price edits", () => {
  const lines = addSellLine([], product());
  assert.equal(setSellQuantity(lines, "p1", 3)[0].quantity, 3);
  assert.deepEqual(setSellQuantity(lines, "p1", 0), []);
  assert.equal(setSellPrice(lines, "p1", 19.5)[0].unitPrice, 19.5);
  // A negative price would be a refund by accident.
  assert.equal(setSellPrice(lines, "p1", -5)[0].unitPrice, 0);
});

test("tax is what is already inside the total, not added on top", () => {
  const lines = setSellQuantity(addSellLine([], product({ price: 23, taxRate: 15 })), "p1", 2);
  assert.equal(sellTotal(lines), 46);
  // 46 * 15 / 115 = 6.00
  assert.equal(sellTaxIncluded(lines), 6);
  // A zero-rated line contributes nothing.
  assert.equal(sellTaxIncluded(addSellLine([], product({ id: "p3", price: 50, taxRate: 0 }))), 0);
});

test("change due goes negative until enough is handed over", () => {
  assert.equal(changeDue(50, 46), 4);
  assert.equal(changeDue(46, 46), 0);
  assert.equal(changeDue(20, 46), -26);
});

test("cash suggestions offer the exact amount then the next round notes", () => {
  assert.deepEqual(cashSuggestions(46), [46, 50, 60, 100]);
  // Nothing between 20 and 50 is a note anyone carries, so it is skipped.
  assert.deepEqual(cashSuggestions(20), [20, 50, 100]);
  assert.deepEqual(cashSuggestions(0), []);
});
