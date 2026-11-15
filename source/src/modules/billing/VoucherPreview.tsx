// One voucher in full: the gift card as it was sent, and what is known about
// it -- who bought it, who it is for, how it reached them, the message with it,
// the coach's own note, and where it has been spent.
//
// Two ways in. Clicking a voucher code (on the voucher list or on a sale in
// Transactions) opens VoucherPreviewModal, card first. Opening a row on the
// voucher list shows VoucherDetails in place, without the card.

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { GiftCardPreview } from "../shared/GiftCardPreview";
import { Loading } from "../shared/Loading";
import { t, readerLocale } from "../../lib/i18n";
import type { CouponDetails } from "./types";

type FormatMoney = (amount: number, currency?: string) => string;

/** Fetches one voucher's details. A blank id fetches nothing. */
export function useVoucherDetails(couponId: string) {
  const [details, setDetails] = useState<CouponDetails | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "loaded" | "error">("idle");

  useEffect(() => {
    if (!couponId) {
      setDetails(null);
      setState("idle");
      return;
    }
    let cancelled = false;
    setState("loading");
    fetch(`/api/billing/coupons/${encodeURIComponent(couponId)}`, { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("voucher");
        const data = (await response.json()) as CouponDetails;
        if (cancelled) return;
        setDetails(data);
        setState("loaded");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [couponId]);

  return { details, state };
}

function dateLabel(value: string, withTime = false) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return withTime ? date.toLocaleString(readerLocale()) : date.toLocaleDateString(readerLocale());
}

function statusLabel(coupon: CouponDetails["coupon"]) {
  if (coupon.status === "void") return t("Cancelled");
  if (coupon.expired) return t("Expired");
  if (coupon.status === "redeemed" || coupon.remainingValue <= 0) return t("Used");
  return t("Active");
}

/** "Name <email>", either half optional. */
function person(name: string, email: string) {
  if (name && email) return `${name} (${email})`;
  return name || email;
}

/** How the voucher reached whoever holds it, in a sentence. */
function howGiven(details: CouponDetails) {
  const { coupon, sale } = details;
  if (coupon.source === "online") {
    return sale?.customerEmail
      ? t("Emailed to {email} with the gift card attached", { email: sale.customerEmail })
      : t("Bought in your online shop");
  }
  if (coupon.source === "pos") return t("Sold at the till - the code was shown on screen to write on the card");
  if (coupon.source === "stripe") return t("Bought online through Stripe and brought in here");
  return t("Issued by hand");
}

/** The facts and the history. The card is the modal's to show. */
export function VoucherDetails({ details, formatMoney }: { details: CouponDetails; formatMoney: FormatMoney }) {
  const { coupon, sale, redemptions } = details;
  // An imported Stripe voucher has no sale here: whoever paid Stripe is the
  // name on the voucher. A till or online sale knows its buyer.
  const boughtBy = sale
    ? person(sale.customerName, sale.customerEmail)
    : coupon.source === "stripe"
      ? person(coupon.issuedToName, coupon.issuedToEmail)
      : "";
  const forWhom = sale?.recipientName || (coupon.source === "stripe" ? "" : coupon.issuedToName);
  const message = coupon.giftMessage || sale?.giftMessage || "";

  const rows: Array<[string, string]> = [
    [t("Bought by"), boughtBy],
    [t("For"), forWhom],
    [t("Sent"), howGiven(details)],
    [t("Redeemable for"), coupon.coversItemName || ""],
    [t("Value"), formatMoney(coupon.originalValue, coupon.currency)],
    [t("Left to spend"), `${formatMoney(coupon.remainingValue, coupon.currency)} - ${statusLabel(coupon)}`],
    [t("Issued"), dateLabel(coupon.issuedAt)],
    [t("Expires"), coupon.expiresAt ? dateLabel(coupon.expiresAt) : t("Never")],
    [t("Receipt"), sale ? [sale.receiptNumber, sale.paidAt ? dateLabel(sale.paidAt) : "", formatMoney(sale.amount, sale.currency)].filter(Boolean).join(" - ") : ""],
  ];

  return (
    <div className="voucher-details">
      <dl className="voucher-details-facts">
        {rows
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
      {message && (
        <div className="voucher-details-words">
          <span>{t("Their message")}</span>
          <blockquote>{message}</blockquote>
        </div>
      )}
      {coupon.note && (
        <div className="voucher-details-words">
          <span>{t("Note")}</span>
          <p>{coupon.note}</p>
        </div>
      )}
      <div className="voucher-details-words">
        <span>{t("History")}</span>
        {!redemptions.length && <p className="field-help">{t("Not used yet.")}</p>}
        {redemptions.length > 0 && (
          <div className="product-movement-list">
            {redemptions.map((entry) => (
              <div key={entry.id} className="product-movement">
                <strong className={entry.amount > 0 ? "negative" : "positive"}>
                  {entry.amount > 0 ? `-${entry.amount}` : `+${Math.abs(entry.amount)}`}
                </strong>
                <span>{entry.note || (entry.amount > 0 ? t("Redeemed") : t("Put back"))}</span>
                <em>
                  {dateLabel(entry.createdAt, true)}
                  {entry.resultingBalance === null ? "" : ` - left ${entry.resultingBalance}`}
                </em>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** The card as it was sent. A design with no artwork gets a plain card with the same words. */
function VoucherCard({ details }: { details: CouponDetails }) {
  const { design, text } = details.giftCard;
  const label = t("Gift voucher {code}", { code: details.coupon.code });
  if (design.imageUrl) return <GiftCardPreview design={design} text={text} label={label} className="voucher-preview-card" />;
  return (
    <div className="voucher-preview-plain" role="img" aria-label={label}>
      <span>{t("Gift voucher")}</span>
      {text.name && <strong>{text.name}</strong>}
      {text.item && <em>{text.item}</em>}
      <b className="coupon-code">{text.code}</b>
      {text.value && <em>{text.value}</em>}
    </div>
  );
}

/** The voucher a code belongs to, card first, over whatever screen it was clicked on. */
export function VoucherPreviewModal({ couponId, formatMoney, onClose }: { couponId: string; formatMoney: FormatMoney; onClose: () => void }) {
  const { details, state } = useVoucherDetails(couponId);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="details-overlay" role="presentation" onPointerDown={onClose}>
      <aside
        className="details-panel details-modal voucher-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="voucher-preview-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="panel-header">
          <span>{t("Gift voucher")}</span>
          <button className="icon-button small" onClick={onClose} aria-label={t("Close")} type="button">
            <X size={17} />
          </button>
        </div>
        {state === "loading" && <Loading what={t("voucher")} />}
        {state === "error" && <p>{t("Could not load this voucher.")}</p>}
        {details && (
          <>
            <h2 id="voucher-preview-title" className="coupon-code">
              {details.coupon.code}
            </h2>
            <VoucherCard details={details} />
            <VoucherDetails details={details} formatMoney={formatMoney} />
          </>
        )}
      </aside>
    </div>
  );
}
