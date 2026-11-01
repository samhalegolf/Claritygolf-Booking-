// The gift card a voucher bought online is printed on.
//
// The coach uploads their own artwork and says where on it the recipient's
// name, what the voucher is for (a lesson or product, when it is for one), the
// voucher code and its value go. When a voucher is bought, those are written
// onto the artwork and the result is attached to the gift
// voucher email as a PDF (gift-card-pdf.mts), one page per voucher.
//
// Positions are fractions of the picture, not pixels, so a design survives the
// picture being replaced with a bigger or smaller export of the same artwork,
// and the designer can show it at any width. Text size is a fraction of the
// picture's width for the same reason.
//
// Isomorphic: the settings screen and the send path both read it, so the card
// the coach lays out is the card that goes out. It must not touch `process` or
// any Node API.

/** "item": what a voucher for a lesson or product is for. Blank on an amount voucher. */
export type GiftCardFieldId = "name" | "item" | "code" | "value";
export type GiftCardFont = "sans" | "serif" | "mono";
export type GiftCardAlign = "left" | "center" | "right";

export type GiftCardField = {
  show: boolean;
  /** Where the text is anchored, 0 (left edge) to 1 (right edge). */
  x: number;
  /** The text's vertical middle, 0 (top) to 1 (bottom). */
  y: number;
  /** Text height as a fraction of the picture's width. */
  size: number;
  /** "#rrggbb". */
  color: string;
  /** Which side of the text sits on x. */
  align: GiftCardAlign;
  font: GiftCardFont;
  bold: boolean;
};

export type GiftCardDesign = {
  /** The artwork, in the site-media bucket. "" means no card is attached. */
  imageUrl: string;
  fields: Record<GiftCardFieldId, GiftCardField>;
};

export const GIFT_CARD_FIELDS: GiftCardFieldId[] = ["name", "item", "code", "value"];
export const GIFT_CARD_FONTS: GiftCardFont[] = ["sans", "serif", "mono"];
export const GIFT_CARD_ALIGNS: GiftCardAlign[] = ["left", "center", "right"];

export const GIFT_CARD_MIN_SIZE = 0.015;
export const GIFT_CARD_MAX_SIZE = 0.25;

/** The settings key the design is stored under, as JSON. */
export const GIFT_CARD_SETTING = "giftCardDesignJson";

/**
 * Where a field starts on a fresh design: stacked down the middle of the card.
 * A coach drags them onto their artwork from here.
 */
export function defaultGiftCardDesign(): GiftCardDesign {
  const base = { show: true, x: 0.5, color: "#1a1c1f", align: "center" as const, font: "sans" as const, bold: false };
  return {
    imageUrl: "",
    fields: {
      name: { ...base, y: 0.42, size: 0.06 },
      item: { ...base, y: 0.28, size: 0.05 },
      code: { ...base, y: 0.58, size: 0.065, font: "mono", bold: true },
      value: { ...base, y: 0.74, size: 0.05 },
    },
  };
}

const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(Math.min(max, Math.max(min, number)) * 10000) / 10000;
};

function cleanColor(value: unknown, fallback: string) {
  const text = String(value ?? "").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(text) ? text : fallback;
}

function cleanField(raw: unknown, fallback: GiftCardField): GiftCardField {
  const entry = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    show: typeof entry.show === "boolean" ? entry.show : fallback.show,
    x: clamp(entry.x, 0, 1, fallback.x),
    y: clamp(entry.y, 0, 1, fallback.y),
    size: clamp(entry.size, GIFT_CARD_MIN_SIZE, GIFT_CARD_MAX_SIZE, fallback.size),
    color: cleanColor(entry.color, fallback.color),
    align: GIFT_CARD_ALIGNS.find((known) => known === entry.align) ?? fallback.align,
    font: GIFT_CARD_FONTS.find((known) => known === entry.font) ?? fallback.font,
    bold: typeof entry.bold === "boolean" ? entry.bold : fallback.bold,
  };
}

/** Whatever storage or the wire holds, as a complete design. Unknown keys are dropped. */
export function cleanGiftCardDesign(raw?: unknown): GiftCardDesign {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const defaults = defaultGiftCardDesign();
  const fields = source.fields && typeof source.fields === "object" ? (source.fields as Record<string, unknown>) : {};
  const imageUrl = String(source.imageUrl ?? "").trim().slice(0, 600);
  return {
    // Only a web address: the send path fetches it, and checks it is one of ours.
    imageUrl: /^https:\/\//i.test(imageUrl) ? imageUrl : "",
    fields: {
      name: cleanField(fields.name, defaults.fields.name),
      item: cleanField(fields.item, defaults.fields.item),
      code: cleanField(fields.code, defaults.fields.code),
      value: cleanField(fields.value, defaults.fields.value),
    },
  };
}

/** The stored JSON. A corrupt value reads as a fresh design with no picture. */
export function parseGiftCardDesign(raw?: unknown): GiftCardDesign {
  if (typeof raw !== "string" || !raw.trim()) return defaultGiftCardDesign();
  try {
    return cleanGiftCardDesign(JSON.parse(raw));
  } catch {
    return defaultGiftCardDesign();
  }
}

/**
 * Where the baseline sits below a line's middle, as a share of the text size.
 * Shared by the PDF and the designer's preview (which sets line-height: 1), so
 * text lands at the same height in both.
 */
export const GIFT_CARD_BASELINE_DROP = 0.35;

/** What one voucher's card says. Already formatted: the value carries its currency. */
export type GiftCardText = Record<GiftCardFieldId, string>;
