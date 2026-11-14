/**
 * The public shop: packages, gift vouchers and goods a stranger can buy online.
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
 * Nothing new is catalogued for it. Each thing the business sells says for
 * itself whether it is on the website: a pass or bundle by its `sellOnline`
 * (and player-shop.mts deciding it is sellable at all), a gift voucher or a
 * product by its sell_online column under Billing. There is no shop-wide
 * switch: the shop is open whenever something is ticked and cards can be
 * taken. An order is a cart: several lines, one payment.
 *
 * This module is the part with no I/O: what is on the shelf, and whether an
 * order form is complete. billing-api.mts does the reading and writing.
 */

import { cleanOwnGiftCardDesign, type GiftCardDesign } from "./gift-card.mts";
import { playerShopItems } from "./player-shop.mts";

/** The flat fee charged on an order with something to post, in major units. "" or 0: posted free. */
export const ONLINE_SHOP_SHIPPING_SETTING = "onlineShopShippingFee";

/**
 * How the till names a lesson type in a basket, as opposed to a product row.
 * A package is a lesson type, so it goes into an online order under this.
 */
export const LESSON_ITEM_PREFIX = "lesson:";

/** Whether a pass or bundle in servicesJson is ticked to show on the website store. */
function onWebsite(services: unknown[], serviceId: string) {
  return services.some((service) => {
    const entry = (service || {}) as Record<string, unknown>;
    return text(entry.id, 120) === serviceId && entry.sellOnline === true;
  });
}

/** How a product reaches its buyer. Packages and vouchers are delivered by email and have none. */
export type OnlineFulfilment = "collect" | "ship" | "download";
export const ONLINE_FULFILMENTS: readonly OnlineFulfilment[] = ["collect", "ship", "download"];

/**
 * One choice of a product or voucher: a size, a pack, a $50 or $100 voucher.
 * A null price is the item's own; a blank description says nothing extra.
 */
export type OnlineVariant = { id: string; name: string; price: number | null; description: string };

/**
 * The card a voucher is printed on, for the shop to preview: its own card, or
 * else the business's standard one. `item` is what a voucher for a lesson or
 * product is for ("" on an amount voucher); `showsValue` is whether its value
 * is printed. The same three the send path prints (billing-api giftCardAttachment).
 */
export type OnlineGiftCard = { design: GiftCardDesign; item: string; showsValue: boolean };

export type OnlineShopItem = {
  /** The till's catalog id: a product id, or LESSON_ITEM_PREFIX + service id. */
  id: string;
  kind: "package" | "voucher" | "product";
  name: string;
  description: string;
  /** Major units, as the catalogue stores them. A product with priced variants: the cheapest. */
  price: number;
  currency: string;
  /** What a package adds to the buyer's balance. 0 for a voucher or a product. */
  credits: number;
  /** A bundle's contents, as "5 × 1 Hour Lessons". */
  includes: string[];
  /** A product's picture, or "". */
  image: string;
  /** How a product reaches its buyer. "" for a package or voucher: they go by email. */
  fulfilment: OnlineFulfilment | "";
  variants: OnlineVariant[];
  /** What is on the shelf when the product counts stock; null when it does not. */
  stock: number | null;
  /** A voucher's gift card, when one with artwork is set up. Null otherwise, and on anything else. */
  giftCard: OnlineGiftCard | null;
};

export type OnlineShopCards = {
  /** The business's standard gift card, from Settings › Templates. */
  standard: GiftCardDesign | null;
  /** What a voucher can be for, by its till id: lesson types and products, named as they are now. */
  itemNames: Map<string, string>;
};

const text = (value: unknown, max = 200) => String(value ?? "").trim().slice(0, max);
const round2 = (value: number) => Math.round(value * 100) / 100;

/** The variants column, or anything the coach's form sends: a list of named choices, each priced or not. */
export function cleanVariants(value: unknown): OnlineVariant[] {
  const list = typeof value === "string" ? (() => { try { return JSON.parse(value); } catch { return []; } })() : value;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  return list
    .slice(0, 20)
    .map((entry, index) => {
      const raw = (entry || {}) as Record<string, unknown>;
      const name = text(raw.name, 80);
      const price = raw.price === null || raw.price === undefined || raw.price === "" ? null : Number(raw.price);
      const id = text(raw.id, 40).replace(/[^A-Za-z0-9_-]/g, "") || `v${index + 1}`;
      return {
        id,
        name,
        price: price !== null && Number.isFinite(price) && price >= 0 ? round2(price) : null,
        description: text(raw.description, 300),
      };
    })
    .filter((variant) => variant.name && !seen.has(variant.id) && seen.add(variant.id));
}

export function cleanFulfilment(value: unknown): OnlineFulfilment {
  return ONLINE_FULFILMENTS.find((known) => known === value) ?? "collect";
}

/**
 * What the shop sells.
 *
 * `services` is servicesJson; `products` are billing_products_services rows.
 * An archived package is left off as well as an inactive one: the till will not
 * ring up an archived lesson type, so a buyer would get as far as paying and be
 * refused. A pass or bundle is on the shelf when the coach ticked it to show on
 * the website; so is a voucher or product, by its sell_online. A bundle still
 * reads the whole list, so a pass inside it need not be on the shelf itself.
 * A voucher with options ($50, $100, $200) is one card on the shelf; every
 * option shares the voucher's gift card and email.
 * one that counts stock and has none is listed as sold out, not hidden, so a
 * page does not lose a card the moment the last one goes.
 */
export function onlineShopItems(
  services: unknown,
  products: unknown,
  currency: string,
  cards: OnlineShopCards = { standard: null, itemNames: new Map() },
): OnlineShopItem[] {
  const listed = Array.isArray(services)
    ? services.filter((service) => (service as Record<string, unknown>)?.archived !== true)
    : [];
  const money = text(currency, 10) || "NZD";
  const packages = playerShopItems(listed, currency)
    .filter((item) => item.kind === "package" && onWebsite(listed, item.serviceId))
    .map((item) => ({
      id: `${LESSON_ITEM_PREFIX}${item.serviceId}`,
      kind: "package" as const,
      name: item.name,
      description: item.description,
      price: item.price,
      currency: item.currency,
      credits: item.credits,
      includes: item.includes,
      image: "",
      fulfilment: "" as const,
      variants: [],
      stock: null,
      giftCard: null,
    }));
  const rows = (Array.isArray(products) ? products : []).map((row) => (row || {}) as Record<string, unknown>).filter((row) => row.active !== false);
  const priced = (row: Record<string, unknown>) => {
    const variants = cleanVariants(row.variants);
    const own = round2(Number(row.default_price) || 0);
    const prices = variants.map((variant) => variant.price ?? own);
    return { variants, price: prices.length ? Math.min(...prices) : own };
  };
  const vouchers = rows
    .filter((row) => row.is_voucher === true && row.sell_online === true)
    .map((row) => {
      const { variants, price } = priced(row);
      const design = cleanOwnGiftCardDesign(row.gift_card_design) || cards.standard;
      // Named as the send path names it: a lesson or product that is gone makes it an amount voucher.
      const item = cards.itemNames.get(text(row.voucher_item_id, 160)) || "";
      return {
        id: text(row.id, 160),
        kind: "voucher" as const,
        name: text(row.name, 180) || "Gift voucher",
        description: text(row.description, 300),
        price,
        currency: money,
        credits: 0,
        includes: [] as string[],
        image: text(row.image_url, 600),
        fulfilment: "" as const,
        variants,
        stock: null,
        giftCard: design?.imageUrl ? { design, item, showsValue: !item || row.voucher_shows_value !== false } : null,
      };
    })
    .filter((item) => item.id && item.price > 0)
    .sort((a, b) => a.price - b.price || a.name.localeCompare(b.name));
  const goods = rows
    .filter((row) => row.is_voucher !== true && row.sell_online === true)
    .map((row) => {
      const { variants, price } = priced(row);
      return {
        id: text(row.id, 160),
        kind: "product" as const,
        name: text(row.name, 180),
        description: text(row.description, 600),
        price,
        currency: money,
        credits: 0,
        includes: [] as string[],
        image: text(row.image_url, 600),
        fulfilment: cleanFulfilment(row.fulfilment),
        variants,
        stock: row.track_stock === true ? Math.max(0, Math.round(Number(row.stock_level) || 0)) : null,
        giftCard: null,
      };
    })
    .filter((item) => item.id && item.name && item.price > 0);

  return [...packages, ...vouchers, ...goods];
}

/** A line of a cart as the browser sends it, before it is priced. */
export type OnlineCartLine = { itemId: string; variantId: string; quantity: number };

export type OnlineOrderLine = {
  itemId: string;
  item: OnlineShopItem;
  variant: OnlineVariant | null;
  quantity: number;
  /** Major units: the item's own price, or the variant's. */
  unitPrice: number;
};

export type OnlineOrderRequest = {
  lines: OnlineOrderLine[];
  name: string;
  email: string;
  /** Who a voucher is for. Empty unless a voucher is in the order, or when kept for oneself. */
  recipientName: string;
  message: string;
  /** Something in the order is posted, so Stripe's page asks for an address and shipping is charged. */
  needsShipping: boolean;
  /** Major units. */
  itemsTotal: number;
  shipping: number;
  total: number;
};

export const MAX_ORDER_LINES = 20;
export const MAX_LINE_QUANTITY = 20;

/**
 * The order form, or the reason it cannot be accepted.
 *
 * The email is required because it is where the voucher code, the receipt and
 * any download go: an order with nowhere to send its code is one the buyer
 * can lose. Prices are read off the shelf, never off the request. A recipient
 * and message only mean something on a voucher, so an order without one drops
 * them rather than carrying a gift message nobody will read.
 */
export function readOnlineOrder(
  body: unknown,
  items: OnlineShopItem[],
  shippingFee = 0,
): { order: OnlineOrderRequest } | { error: string } {
  const raw = (body || {}) as Record<string, unknown>;
  const rawLines = Array.isArray(raw.lines) ? raw.lines.slice(0, MAX_ORDER_LINES + 1) : [];
  if (!rawLines.length) return { error: "Nothing is in the order." };
  if (rawLines.length > MAX_ORDER_LINES) return { error: `An order can hold up to ${MAX_ORDER_LINES} lines.` };
  const lines: OnlineOrderLine[] = [];
  for (const entry of rawLines) {
    const line = (entry || {}) as Record<string, unknown>;
    const item = items.find((candidate) => candidate.id === text(line.itemId, 160));
    if (!item) return { error: "Something in the order is no longer for sale." };
    const variantId = text(line.variantId, 40);
    const variant = item.variants.find((candidate) => candidate.id === variantId) || null;
    if (item.variants.length && !variant) return { error: `Choose an option for ${item.name}.` };
    const quantity = Math.round(Number(line.quantity) || 1);
    if (quantity < 1 || quantity > MAX_LINE_QUANTITY) return { error: `Up to ${MAX_LINE_QUANTITY} of one thing per order.` };
    // The same product twice (two sizes) adds up against one shelf.
    const already = lines.filter((other) => other.itemId === item.id).reduce((sum, other) => sum + other.quantity, 0);
    if (item.stock !== null && already + quantity > item.stock) {
      return { error: item.stock > 0 ? `Only ${item.stock} of ${item.name} left.` : `${item.name} is sold out.` };
    }
    lines.push({ itemId: item.id, item, variant, quantity, unitPrice: variant?.price ?? item.price });
  }
  const name = text(raw.name, 140);
  const email = text(raw.email, 180).toLowerCase();
  if (!name) return { error: "Add your name." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Add an email address we can send your receipt to." };
  const gift = lines.some((line) => line.item.kind === "voucher");
  const needsShipping = lines.some((line) => line.item.fulfilment === "ship");
  const itemsTotal = round2(lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0));
  const shipping = needsShipping ? round2(Math.max(0, Number(shippingFee) || 0)) : 0;
  return {
    order: {
      lines,
      name,
      email,
      recipientName: gift ? text(raw.recipientName, 140) : "",
      message: gift ? text(raw.message, 500) : "",
      needsShipping,
      itemsTotal,
      shipping,
      total: round2(itemsTotal + shipping),
    },
  };
}

/** How a line is named on the receipt and the sale: the product, and its option when it has one. */
export function orderLineName(line: Pick<OnlineOrderLine, "item" | "variant">): string {
  return line.variant ? `${line.item.name} - ${line.variant.name}` : line.item.name;
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

/** A package offered while booking a lesson it covers: buy it, and the lesson takes its first credit. */
export type LessonPackageOffer = {
  /** The till's catalog id, as an online order names it. */
  id: string;
  serviceId: string;
  name: string;
  /** Major units, as the catalogue stores them. */
  price: number;
  /** Lessons it covers in all, this one included. */
  credits: number;
  /** How long the credits last from purchase. Null: they don't expire. */
  expiryMonths: number | null;
  /** A bundle's contents ("5 × 1 Hour Lessons"); empty for a plain package. */
  includes: string[];
  /**
   * What it saves against buying `credits` of this lesson one by one. 0 when it
   * doesn't, or can't be said: a bundle mixes in other things, so "per lesson"
   * means nothing for it.
   */
  saving: number;
};

/**
 * The packages a lesson could be paid with: the ones the shop sells (the same
 * rule, so the booking page never offers what the shop would refuse) whose
 * credits cover this lesson. Cheapest first.
 */
export function packageOffersForLesson(services: unknown, currency: string, lessonServiceId: string): LessonPackageOffer[] {
  const listed = Array.isArray(services)
    ? (services as Array<Record<string, unknown>>).filter((service) => service?.archived !== true)
    : [];
  const lesson = listed.find((service) => text(service?.id, 120) === lessonServiceId);
  if (!lesson || text(lesson.lessonFormat, 40) === "package") return [];
  const lessonPrice = text(lesson.priceMode, 40) === "free" ? 0 : Number(lesson.price) || 0;
  return playerShopItems(listed, currency)
    .filter((item) => item.kind === "package" && item.credits > 0 && onWebsite(listed, item.serviceId))
    .filter((item) => item.coversAllServices || item.coversServiceIds.includes(lessonServiceId))
    .map((item) => {
      const source = listed.find((service) => text(service?.id, 120) === item.serviceId);
      const months = Number(source?.passExpiryMonths);
      const bundle = item.includes.length > 0;
      const saving = !bundle && lessonPrice > 0 ? Math.round((lessonPrice * item.credits - item.price) * 100) / 100 : 0;
      return {
        id: `${LESSON_ITEM_PREFIX}${item.serviceId}`,
        serviceId: item.serviceId,
        name: item.name,
        price: item.price,
        credits: item.credits,
        expiryMonths: Number.isFinite(months) && months > 0 ? Math.round(months) : null,
        includes: item.includes,
        saving: saving > 0 ? saving : 0,
      };
    })
    .sort((a, b) => a.price - b.price || a.name.localeCompare(b.name));
}
