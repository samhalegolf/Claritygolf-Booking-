/**
 * What a player is allowed to buy, and what buying it gives them.
 *
 * Everything on this list resolves to the same thing: a pass. That is not a
 * shortcut, it is the pass system's whole premise -- one shape of entitlement,
 * many sources -- and it means a card payment in the portal lands in exactly
 * the ledger a counter sale or a comped credit lands in, spends through the
 * same checkout, and reverses through the same reversal. 'clarity_checkout'
 * was already a PassSource before any of this existed.
 *
 * Two kinds of thing are for sale, and the difference is only how many credits
 * come out:
 *
 *   package       what the coach already sells as a multi-lesson package. The
 *                 credits and the coverage come from the package itself, so
 *                 changing the catalogue changes the shop.
 *   video-review  one review, one credit, covering itself. Worth selling
 *                 singly because it is the one thing a player wants to buy on
 *                 impulse -- they have just filmed a swing and want it looked
 *                 at -- and making them buy a block of five to do that is how
 *                 you sell none.
 *
 * Nothing else is purchasable. A normal lesson is a booking against a calendar
 * with availability, a coach and a room; selling one as a credit would let a
 * player pay for a slot that does not exist.
 */

export type PlayerShopItem = {
  serviceId: string;
  name: string;
  description: string;
  /** Major units, as the catalogue stores them. */
  price: number;
  currency: string;
  /** What the purchase adds to their balance. */
  credits: number;
  /** Service ids the resulting credits may be spent on. */
  coversServiceIds: string[];
  kind: "package" | "video-review";
  crossRedeemable: boolean;
};

const text = (value: unknown, max = 200) => String(value ?? "").trim().slice(0, max);
const idList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((entry) => text(entry, 120)).filter(Boolean) : [];

/**
 * The catalogue, filtered to what a player may buy for themselves.
 *
 * An inactive service is not sold. Nor is a free one: "Buy" on a $0 item is a
 * button that takes a card and charges nothing, and Stripe refuses a zero
 * amount anyway -- if a coach wants to give something away, a manual grant is
 * the honest way to do it and it already exists.
 */
export function playerShopItems(services: unknown, currency: string): PlayerShopItem[] {
  if (!Array.isArray(services)) return [];
  const items: PlayerShopItem[] = [];

  for (const service of services) {
    const entry = service as Record<string, unknown>;
    const serviceId = text(entry?.id, 120);
    if (!serviceId) continue;
    if (entry?.active === false) continue;
    // "free" is a deliberate price, not a missing one, and neither is sellable.
    if (text(entry?.priceMode, 40) === "free") continue;

    const price = Number(entry?.price);
    if (!Number.isFinite(price) || price <= 0) continue;

    const format = text(entry?.lessonFormat, 40);
    if (format !== "package" && format !== "video-review") continue;

    const covers = idList(entry?.coversServiceIds);
    const single = text(entry?.packageCoversServiceId, 120);
    const coversServiceIds =
      format === "video-review"
        ? [serviceId]
        : covers.length
          ? covers
          : single
            ? [single]
            : [];

    // A package covering nothing can never be spent. Selling it would take
    // money for a credit with nowhere to go, so it is left off the shelf
    // rather than sold and argued about later.
    if (!coversServiceIds.length) continue;

    const credits =
      format === "video-review"
        ? 1
        : Math.max(1, Math.min(100, Math.round(Number(entry?.packageAllowance) || 5)));

    items.push({
      serviceId,
      name: text(entry?.name, 180) || (format === "video-review" ? "Video review" : "Pass"),
      description: text(entry?.description, 300),
      price,
      currency: text(currency, 10) || "NZD",
      credits,
      coversServiceIds,
      kind: format === "video-review" ? "video-review" : "package",
      crossRedeemable: entry?.crossRedeemable === true,
    });
  }

  // Cheapest first: the impulse buy is the one that should be easiest to find,
  // and it is almost always the single review rather than the block.
  return items.sort((a, b) => a.price - b.price || a.name.localeCompare(b.name));
}

export function findPlayerShopItem(items: PlayerShopItem[], serviceId: unknown) {
  const wanted = text(serviceId, 120);
  return items.find((item) => item.serviceId === wanted) || null;
}

/**
 * The reference that makes a purchase impossible to bank twice.
 *
 * Keyed on the Stripe session, not on the player or the item: confirming is a
 * poll, it runs every few seconds while the player is coming back from Stripe,
 * and it must be safe to run a hundred times. The unique index on
 * (account_id, source, source_ref) is what actually enforces it.
 */
export function checkoutSourceRef(sessionId: string) {
  return `checkout:${text(sessionId, 180)}`;
}
