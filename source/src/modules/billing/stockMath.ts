// Pure maths for products, stock and the counter basket.
//
// Kept out of the components for the same reason invoiceMath is: these are the
// rules that decide what a customer is charged and what the shelf count becomes,
// and they are worth testing without a browser. Nothing here fetches or renders.

import type { BillingCatalogItem } from "./types";

export type BasketLine = {
  productId: string;
  name: string;
  sku: string;
  quantity: number;
  unitPrice: number;
};

export function round2(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export function lineTotal(line: Pick<BasketLine, "quantity" | "unitPrice">) {
  return round2((Number(line.quantity) || 0) * (Number(line.unitPrice) || 0));
}

export function basketTotal(lines: Array<Pick<BasketLine, "quantity" | "unitPrice">>) {
  // Each line is rounded before summing, so the total always equals the column
  // of numbers printed on the receipt rather than being a cent out from it.
  return round2(lines.reduce((total, line) => total + lineTotal(line), 0));
}

// "Golf glove x2, Sleeve of balls" - the default description for a basket sale
// when nothing was typed. Matches what the backend derives, so a sale looks the
// same whether it was named at the till or not.
export function describeBasket(lines: Array<Pick<BasketLine, "name" | "quantity">>) {
  return lines
    .map((line) => (line.quantity > 1 ? `${line.name} x${line.quantity}` : line.name))
    .filter(Boolean)
    .join(", ");
}

// Adding the same product twice bumps the quantity instead of producing a
// second line - a till that lists "Glove, Glove" is harder to read back to a
// customer than one that says "Glove x2".
export function addToBasket(lines: BasketLine[], product: BillingCatalogItem, quantity = 1): BasketLine[] {
  const step = Math.max(1, Math.round(quantity));
  const index = lines.findIndex((line) => line.productId === product.id);
  if (index === -1) {
    return [
      ...lines,
      {
        productId: product.id,
        name: product.name,
        sku: product.sku || "",
        quantity: step,
        unitPrice: round2(product.price),
      },
    ];
  }
  const next = lines.slice();
  next[index] = { ...next[index], quantity: next[index].quantity + step };
  return next;
}

// Quantity 0 (or less) removes the line - that is what pressing minus down to
// nothing means at a counter.
export function setBasketQuantity(lines: BasketLine[], productId: string, quantity: number): BasketLine[] {
  const rounded = Math.round(Number(quantity) || 0);
  if (rounded <= 0) return lines.filter((line) => line.productId !== productId);
  return lines.map((line) => (line.productId === productId ? { ...line, quantity: rounded } : line));
}

// Mirrors the backend's `lowStock` so the checkout picker can flag an item
// without waiting for a refreshed product list. A threshold of 0 means "don't
// warn me", leaving only out-of-stock.
export function isLowStock(product: Pick<BillingCatalogItem, "trackStock" | "stockLevel" | "lowStockThreshold">) {
  if (!product.trackStock) return false;
  const level = Number(product.stockLevel) || 0;
  const threshold = Number(product.lowStockThreshold) || 0;
  return level <= 0 || (threshold > 0 && level <= threshold);
}

// What the shelf count becomes if this basket is paid for. Only tracked
// products move; everything else stays where it is.
export function stockAfterBasket(product: BillingCatalogItem, lines: BasketLine[]) {
  const level = Number(product.stockLevel) || 0;
  if (!product.trackStock) return level;
  const sold = lines
    .filter((line) => line.productId === product.id)
    .reduce((total, line) => total + (Number(line.quantity) || 0), 0);
  return level - sold;
}

// The Products tab offers two ways to change a count: "add/remove this many"
// and "the shelf actually says this". Both end up as a signed delta, which is
// what the ledger records - so a stocktake that corrects 7 down to 4 is stored
// as -3 with its reason, not as the number 4.
export function stockAdjustmentDelta(mode: "delta" | "setTo", currentLevel: number, value: number) {
  const current = Math.round(Number(currentLevel) || 0);
  const entered = Math.round(Number(value) || 0);
  return mode === "setTo" ? entered - current : entered;
}
