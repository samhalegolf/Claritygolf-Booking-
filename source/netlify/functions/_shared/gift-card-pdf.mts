// A gift card as a PDF: the coach's artwork with each voucher's name, code
// and value written where gift-card.mts says. One page per voucher, so an
// order of three vouchers is one attachment the buyer can print in one go,
// and the artwork is stored in the file once however many pages use it.
//
// Isomorphic like gift-card.mts: the send path builds the real card, and the
// designer builds a sample from the same function, so "Preview PDF" is exactly
// what a buyer receives. It takes the picture's bytes rather than fetching
// them, because where the bytes may come from is the caller's decision.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage } from "pdf-lib";

import {
  GIFT_CARD_BASELINE_DROP,
  GIFT_CARD_FIELDS,
  type GiftCardDesign,
  type GiftCardField,
  type GiftCardText,
} from "./gift-card.mts";

/** The page's width in points. The height follows the artwork. A4 is 595 wide. */
const PAGE_WIDTH = 600;
/** Text is kept this far (a share of the page width) inside the edges. */
const EDGE = 0.02;

export type GiftCardImageKind = "png" | "jpg";

/** What a picture's first bytes say it is. The PDF format takes PNG and JPEG only. */
export function giftCardImageKind(bytes: Uint8Array): GiftCardImageKind | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  return null;
}

const FONT_NAMES = {
  sans: [StandardFonts.Helvetica, StandardFonts.HelveticaBold],
  serif: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold],
  mono: [StandardFonts.Courier, StandardFonts.CourierBold],
} as const;

function hexColor(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16) || 0;
  return rgb(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
}

/**
 * The text with anything the font cannot draw taken out. The built-in PDF
 * fonts cover Western European letters; a name in another script would
 * otherwise stop the whole card from being made. Accents are tried without
 * their mark first, so "Łukasz" prints as "Lukasz" rather than "ukasz".
 */
function drawable(font: PDFFont, text: string) {
  const supported = new Set(font.getCharacterSet());
  return [...text]
    .map((char) => {
      if (supported.has(char.codePointAt(0) ?? 0)) return char;
      const plain = char.normalize("NFD").replace(/[̀-ͯ]/g, "");
      if (plain && [...plain].every((part) => supported.has(part.codePointAt(0) ?? 0))) return plain;
      if (char === "ł") return "l";
      if (char === "Ł") return "L";
      return "";
    })
    .join("")
    .trim();
}

function drawField(
  page: ReturnType<PDFDocument["addPage"]>,
  field: GiftCardField,
  font: PDFFont,
  rawText: string,
  width: number,
  height: number,
) {
  const text = drawable(font, rawText);
  if (!field.show || !text) return;
  // The room the text has, from its anchor to the edge(s) it grows towards.
  const anchor = field.x * width;
  const edge = EDGE * width;
  const room =
    field.align === "left" ? width - edge - anchor : field.align === "right" ? anchor - edge : 2 * Math.min(anchor - edge, width - edge - anchor);
  let size = field.size * width;
  const natural = font.widthOfTextAtSize(text, size);
  // A long name shrinks to fit rather than running off the card.
  if (room > 0 && natural > room) size *= room / natural;
  const textWidth = font.widthOfTextAtSize(text, size);
  const left = field.align === "left" ? anchor : field.align === "right" ? anchor - textWidth : anchor - textWidth / 2;
  const baselineFromTop = field.y * height + GIFT_CARD_BASELINE_DROP * size;
  page.drawText(text, { x: left, y: height - baselineFromTop, size, font, color: hexColor(field.color) });
}

/**
 * The card for each voucher, as one PDF. Throws when the picture is not a
 * PNG or JPEG; the caller decides whether that stops anything.
 */
export async function buildGiftCardPdf(design: GiftCardDesign, image: Uint8Array, cards: GiftCardText[]): Promise<Uint8Array> {
  const kind = giftCardImageKind(image);
  if (!kind) throw Object.assign(new Error("The gift card picture must be a PNG or JPEG."), { code: "gift_card_image_type" });
  const pdf = await PDFDocument.create();
  pdf.setTitle("Gift voucher");
  const artwork: PDFImage = kind === "png" ? await pdf.embedPng(image) : await pdf.embedJpg(image);
  const width = PAGE_WIDTH;
  const height = Math.round((PAGE_WIDTH * artwork.height) / Math.max(1, artwork.width));
  const fonts = new Map<string, PDFFont>();
  const fontFor = async (field: GiftCardField) => {
    const name = FONT_NAMES[field.font][field.bold ? 1 : 0];
    if (!fonts.has(name)) fonts.set(name, await pdf.embedFont(name));
    return fonts.get(name)!;
  };
  for (const card of cards.length ? cards : [{ name: "", code: "", value: "" }]) {
    const page = pdf.addPage([width, height]);
    page.drawImage(artwork, { x: 0, y: 0, width, height });
    for (const id of GIFT_CARD_FIELDS) {
      const field = design.fields[id];
      drawField(page, field, await fontFor(field), card[id] || "", width, height);
    }
  }
  return pdf.save();
}
