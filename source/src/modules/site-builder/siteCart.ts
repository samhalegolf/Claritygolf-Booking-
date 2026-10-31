// The visitor's cart: what they have picked from a business's shop, kept in
// the browser so it survives a page change and so the header's bag icon can
// show how many things are in it. One cart per business. Nothing in it is
// trusted: the server prices every line again when the order is placed.

import type { ShopOrderLine } from "./siteApi";

export type CartLine = ShopOrderLine;

/** Fired on window whenever a cart changes, so the header count can follow. */
export const CART_EVENT = "clarity-cart";
export const MAX_CART_LINES = 20;
export const MAX_LINE_QUANTITY = 20;

export function cartKey(business: string): string {
  return `clarity-cart:${business}`;
}

/** The lines of a cart, cleaned. Anything unreadable is an empty cart. */
export function parseCart(raw: unknown): CartLine[] {
  const list = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return []; } })() : raw;
  if (!Array.isArray(list)) return [];
  const lines: CartLine[] = [];
  for (const entry of list.slice(0, MAX_CART_LINES)) {
    const line = (entry || {}) as Record<string, unknown>;
    const itemId = String(line.itemId ?? "").slice(0, 160);
    const variantId = String(line.variantId ?? "").slice(0, 40);
    const quantity = Math.round(Number(line.quantity) || 0);
    if (!itemId || quantity < 1) continue;
    lines.push({ itemId, variantId, quantity: Math.min(MAX_LINE_QUANTITY, quantity) });
  }
  return lines;
}

/** Add to the cart: the same thing in the same option just grows its line. */
export function addToCart(lines: CartLine[], itemId: string, variantId: string, quantity = 1): CartLine[] {
  const existing = lines.find((line) => line.itemId === itemId && line.variantId === variantId);
  if (existing) {
    return lines.map((line) => (line === existing ? { ...line, quantity: Math.min(MAX_LINE_QUANTITY, line.quantity + quantity) } : line));
  }
  if (lines.length >= MAX_CART_LINES) return lines;
  return [...lines, { itemId, variantId, quantity: Math.min(MAX_LINE_QUANTITY, Math.max(1, quantity)) }];
}

/** Set a line's quantity; zero removes it. */
export function setCartQuantity(lines: CartLine[], index: number, quantity: number): CartLine[] {
  const next = Math.round(quantity);
  if (next < 1) return lines.filter((_, at) => at !== index);
  return lines.map((line, at) => (at === index ? { ...line, quantity: Math.min(MAX_LINE_QUANTITY, next) } : line));
}

export function cartCount(lines: CartLine[]): number {
  return lines.reduce((sum, line) => sum + line.quantity, 0);
}

export function readCart(business: string): CartLine[] {
  try {
    return parseCart(window.localStorage.getItem(cartKey(business)));
  } catch {
    return [];
  }
}

export function writeCart(business: string, lines: CartLine[]): void {
  try {
    if (lines.length) window.localStorage.setItem(cartKey(business), JSON.stringify(lines));
    else window.localStorage.removeItem(cartKey(business));
  } catch {
    // Private windows and blocked storage: the cart lives for this page only.
  }
  window.dispatchEvent(new CustomEvent(CART_EVENT, { detail: { business } }));
}
