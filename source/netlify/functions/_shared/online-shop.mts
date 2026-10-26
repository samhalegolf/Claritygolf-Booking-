/**
 * The public shop: packages and gift vouchers a stranger can buy online.
 *
 * WHAT AN ONLINE ORDER IS
 *
 * A till sale the customer rings up themselves. The shop creates a pending
 * billing_pos_transactions row (source 'online'), sends the buyer to Stripe
 * Checkout for it, and settles it through the same settlePosTransaction the
 * till's QR uses. Everything a paid sale already does follows from that: the
 * package issues its pass, the voucher gets its code, the sale is in takings,
 * a refund in Stripe refunds it. Nothing here is a second notion of "sold".
 *
 * WHAT IS FOR SALE
 *
 * Nothing new is catalogued for it. Packages are the ones the player portal
 * already sells (player-shop.mts decides which are sellable at all); gift
 * vouchers are the products ticked as vouchers under Billing. The coach turns
 * the shop on with one switch, and it sells what the business already sells.
 *
 * This module is the part with no I/O: what is on the shelf, and whether an
 * order form is complete. billing-api.mts does the reading and writing.
 */

import { playerShopItems } from "./player-shop.mts";

/** The switch, in `settings`. "true" when the coach has opened the shop. */
export const ONLINE_SHOP_SETTING = "onlineShopEnabled";

/**
 * How the till names a lesson type in a basket, as opposed to a product row.
 * A package is a lesson type, so it goes into an online order under this.
 */
export const LESSON_ITEM_PREFIX = "lesson:";

export function onlineShopSwitchedOn(value: unknown) {
  return String(value ?? "").trim() === "true";
}

export type OnlineShopItem = {
  /** The till's catalog id: a product id, or LESSON_ITEM_PREFIX + service id. */
  id: string;
  kind: "package" | "voucher";
  name: string;
  description: string;
  /** Major units, as the catalogue stores them. */
  price: number;
  currency: string;
  /** What a package adds to the buyer's balance. 0 for a voucher. */
  credits: number;
  /** A bundle's contents, as "5 × 1 Hour Lessons". */
  includes: string[];
};

const text = (value: unknown, max = 200) => String(value ?? "").trim().slice(0, max);

/**
 * What the shop sells.
 *
 * `services` is servicesJson; `products` are billing_products_services rows.
 * An archived package is left off as well as an inactive one: the till will not
 * ring up an archived lesson type, so a buyer would get as far as paying and be
 * refused.
 */
export function onlineShopItems(services: unknown, products: unknown, currency: string): OnlineShopItem[] {
  const listed = Array.isArray(services)
    ? services.filter((service) => (service as Record<string, unknown>)?.archived !== true)
    : [];
  const packages = playerShopItems(listed, currency)
    .filter((item) => item.kind === "package")
    .map((item) => ({
      id: `${LESSON_ITEM_PREFIX}${item.serviceId}`,
      kind: "package" as const,
      name: item.name,
      description: item.description,
      price: item.price,
      currency: item.currency,
      credits: item.credits,
      includes: item.includes,
    }));

  const vouchers = (Array.isArray(products) ? products : [])
    .map((row) => (row || {}) as Record<string, unknown>)
    .filter((row) => row.is_voucher === true && row.active !== false && Number(row.default_price) > 0)
    .map((row) => ({
      id: text(row.id, 160),
      kind: "voucher" as const,
      name: text(row.name, 180) || "Gift voucher",
      description: text(row.description, 300),
      price: Math.round(Number(row.default_price) * 100) / 100,
      currency: text(currency, 10) || "NZD",
      credits: 0,
      includes: [] as string[],
    }))
    .filter((item) => item.id)
    .sort((a, b) => a.price - b.price || a.name.localeCompare(b.name));

  return [...packages, ...vouchers];
}

export type OnlineOrderRequest = {
  itemId: string;
  name: string;
  email: string;
  /** Who a voucher is for. Empty for a package, or a voucher kept for oneself. */
  recipientName: string;
  message: string;
};

/**
 * The order form, or the reason it cannot be accepted.
 *
 * The email is required because it is where the voucher code or the receipt
 * goes: an order with nowhere to send its code is one the buyer can lose. A
 * recipient and message only mean something on a voucher, so a package drops
 * them rather than carrying a gift message nobody will read.
 */
export function readOnlineOrder(
  body: unknown,
  items: OnlineShopItem[],
): { order: OnlineOrderRequest; item: OnlineShopItem } | { error: string } {
  const raw = (body || {}) as Record<string, unknown>;
  const item = items.find((entry) => entry.id === text(raw.itemId, 160));
  if (!item) return { error: "That is not for sale." };
  const name = text(raw.name, 140);
  const email = text(raw.email, 180).toLowerCase();
  if (!name) return { error: "Add your name." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Add an email address we can send your receipt to." };
  const gift = item.kind === "voucher";
  return {
    item,
    order: {
      itemId: item.id,
      name,
      email,
      recipientName: gift ? text(raw.recipientName, 140) : "",
      message: gift ? text(raw.message, 500) : "",
    },
  };
}

/**
 * The client record an online buyer nobody knew yet is filed under.
 *
 * Derived from the sale rather than random, so the return page and the Stripe
 * webhook -- which can both be settling the same order at the same moment --
 * write the same row, and the second insert is a no-op instead of a duplicate
 * client.
 */
export function onlineBuyerPersonId(transactionId: string) {
  return `online-${text(transactionId, 120)}`;
}
