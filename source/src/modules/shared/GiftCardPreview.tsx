// A gift card as it prints: the coach's artwork with the voucher's own words
// written on where the coach put them (Settings › Templates, or the voucher's
// own card under Billing). The designer edits on top of the same face, and the
// public shop shows it to a buyer before they pay.
//
// HTML over the picture, sized in container units so it scales with the
// picture the way the PDF does (_shared/gift-card-pdf.mts).

import type { CSSProperties, ReactNode, Ref } from "react";
import {
  GIFT_CARD_FIELDS,
  type GiftCardAlign,
  type GiftCardDesign,
  type GiftCardField,
  type GiftCardFieldId,
  type GiftCardFont,
  type GiftCardText,
} from "../../../netlify/functions/_shared/gift-card.mts";
import { t } from "../../lib/i18n";
import "./giftCardPreview.css";

const FONT_FAMILY: Record<GiftCardFont, string> = {
  sans: "Helvetica, Arial, sans-serif",
  serif: '"Times New Roman", Times, serif',
  mono: '"Courier New", Courier, monospace',
};

const SHIFT: Record<GiftCardAlign, string> = { left: "0%", center: "-50%", right: "-100%" };

/** Where and how one field sits on the card. */
export function giftCardFieldStyle(field: GiftCardField): CSSProperties {
  return {
    left: `${field.x * 100}%`,
    top: `${field.y * 100}%`,
    // A line-height: 1 box centred on y puts the baseline about
    // GIFT_CARD_BASELINE_DROP of the size below y, which is where the PDF draws it.
    transform: `translate(${SHIFT[field.align]}, -50%)`,
    fontSize: `${field.size * 100}cqw`,
    fontFamily: FONT_FAMILY[field.font],
    fontWeight: field.bold ? 700 : 400,
    color: field.color,
  };
}

/** The card's picture with something laid over it. */
export function GiftCardFace({
  imageUrl,
  className,
  children,
  label,
  ref,
}: {
  imageUrl: string;
  className?: string;
  children: ReactNode;
  label?: string;
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    <div ref={ref} className={`gift-card-face${className ? ` ${className}` : ""}`} role={label ? "img" : undefined} aria-label={label}>
      <img src={imageUrl} alt="" draggable={false} />
      {children}
    </div>
  );
}

/** A read-only card with these words on it. A blank field is left off, as the PDF leaves it. */
export function GiftCardPreview({ design, text, label, className }: { design: GiftCardDesign; text: GiftCardText; label: string; className?: string }) {
  if (!design.imageUrl) return null;
  return (
    <GiftCardFace imageUrl={design.imageUrl} label={label} className={className}>
      {GIFT_CARD_FIELDS.map((id: GiftCardFieldId) => {
        const field = design.fields[id];
        if (!field.show || !text[id]) return null;
        return (
          <span key={id} className="gift-card-face-text" style={giftCardFieldStyle(field)} aria-hidden="true">
            {text[id]}
          </span>
        );
      })}
    </GiftCardFace>
  );
}

/** Stands in for the code a voucher gets once it is paid for. */
const SAMPLE_CODE = "CG-XXXX-XXXX";

/**
 * What a voucher on sale would say on its card, before it is bought: the name
 * it is for so far, what it is for, a stand-in code, and the value when the
 * voucher prints one. `value` comes formatted, with its currency.
 */
export function shopGiftCardText(card: { item: string; showsValue: boolean }, name: string, value: string): GiftCardText {
  return { name: name.trim() || t("Their name"), item: card.item, code: SAMPLE_CODE, value: card.showsValue ? value : "" };
}
