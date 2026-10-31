// The business's shop, on a page of its site.
//
// What is for sale comes from the server on every load and is priced again
// there when the order is placed; the page only says which thing. Paying
// happens on Stripe's page, and the buyer comes back to this page, where the
// order id in the address is confirmed with the server and the receipt (and
// any voucher code) shown. The same code goes out by email, so a buyer who
// closes the tab has lost nothing. Same bargain as the shop page
// (public-booking/PublicShop.tsx), drawn in the site's own clothes.

import { useEffect, useState } from "react";

import type { SiteShopBlock } from "../../../netlify/functions/_shared/site/document.mts";
import { t } from "../../lib/i18n";
import { cancelShopOrder, confirmShopOrder, fetchShop, startShopCheckout, type ShopItem, type ShopOrder } from "./siteApi";
import { shopPageUrl } from "./siteTheme";
import type { SiteBusiness } from "./SiteRenderer";

const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Stripe usually confirms within a few seconds of the buyer landing back here.
// Two minutes covers a slow one; past that the email is the buyer's receipt.
const CONFIRM_EVERY_MS = 2500;
const CONFIRM_FOR_MS = 2 * 60 * 1000;

export function money(value: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
      minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${value}`;
  }
}

function itemDetail(item: ShopItem) {
  if (item.kind === "voucher") return t("Gift voucher");
  if (item.includes.length) return item.includes.join(" + ");
  return "";
}

type Details = { name: string; email: string; recipientName: string; message: string };

export function ShopBlock({
  block,
  business,
  preview,
  previewLabel,
  returnPath,
  returnQuery,
}: {
  block: SiteShopBlock;
  business: SiteBusiness;
  preview: boolean;
  previewLabel: string;
  /** This page's path, where the buyer comes back to after paying. */
  returnPath: string;
  returnQuery?: URLSearchParams;
}) {
  const [shop, setShop] = useState<"loading" | "closed" | "error" | { items: ShopItem[]; currency: string }>("loading");
  const [item, setItem] = useState<ShopItem | null>(null);
  const [details, setDetails] = useState<Details>({ name: "", email: "", recipientName: "", message: "" });
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState("");
  const returningOrder = returnQuery?.get("order") || "";
  const cancelledOrder = returnQuery?.get("cancelled") || "";
  const [order, setOrder] = useState<ShopOrder | null>(null);
  const [confirming, setConfirming] = useState(Boolean(returningOrder));

  useEffect(() => {
    if (block.mode !== "cards" || !business.slug) return;
    let cancelled = false;
    fetchShop(business.slug)
      .then((data) => !cancelled && setShop(data.open ? { items: data.items, currency: data.currency } : "closed"))
      .catch(() => !cancelled && setShop("error"));
    return () => {
      cancelled = true;
    };
  }, [block.mode, business.slug]);

  // Back from Stripe: ask the server whether the order is paid, for a while.
  useEffect(() => {
    if (preview || !returningOrder || !business.slug) return;
    let cancelled = false;
    const started = Date.now();
    const tick = async () => {
      try {
        const summary = await confirmShopOrder(business.slug, returningOrder);
        if (cancelled) return;
        if (summary.status === "paid") {
          setOrder(summary);
          setConfirming(false);
          return;
        }
      } catch {
        // Keep asking: a brief server hiccup is not a failed payment.
      }
      if (!cancelled && Date.now() - started < CONFIRM_FOR_MS) window.setTimeout(() => void tick(), CONFIRM_EVERY_MS);
      else if (!cancelled) setConfirming(false);
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, [preview, returningOrder, business.slug]);

  useEffect(() => {
    if (preview || !cancelledOrder || !business.slug) return;
    void cancelShopOrder(business.slug, cancelledOrder).catch(() => undefined);
  }, [preview, cancelledOrder, business.slug]);

  if (block.mode === "embed") {
    if (preview) {
      return (
        <div className="site-placeholder is-embed" style={{ height: Math.min(block.height, 420) }}>
          <span>{previewLabel}</span>
        </div>
      );
    }
    return <iframe className="site-booking-frame" src={shopPageUrl(business.slug)} title={block.heading || "Shop"} allow="payment" style={{ height: block.height }} loading="lazy" />;
  }

  if (order) {
    return (
      <div className="site-shop-receipt">
        <h3 className="site-heading">{t("Thank you")}</h3>
        <p>{order.description}</p>
        <p>{t("Your receipt is on its way to {email}.", { email: order.email })}</p>
        {order.vouchers.map((voucher) => (
          <p className="site-shop-code" key={voucher.code}>
            <code>{voucher.code}</code>
          </p>
        ))}
      </div>
    );
  }
  if (confirming) {
    return (
      <div className="site-shop-receipt">
        <h3 className="site-heading">{t("Still confirming your payment")}</h3>
        <p>{t("If you paid, your receipt will arrive by email shortly. You do not need to pay again.")}</p>
      </div>
    );
  }

  const gift = item?.kind === "voucher";
  const canPay = details.name.trim().length > 0 && VALID_EMAIL.test(details.email.trim()) && !paying;

  async function pay() {
    if (!item || preview) return;
    setPaying(true);
    setError("");
    try {
      const url = await startShopCheckout(business.slug, {
        itemId: item.id,
        name: details.name.trim(),
        email: details.email.trim(),
        recipientName: gift ? details.recipientName.trim() : "",
        message: gift ? details.message.trim() : "",
        returnPath,
      });
      window.location.assign(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("The shop is unavailable. Please try again shortly."));
      setPaying(false);
    }
  }

  return (
    <div className="site-shop-body">
      {cancelledOrder && !item ? <p className="site-shop-note">{t("Checkout was cancelled. Nothing has been charged.")}</p> : null}
      {shop === "loading" ? <div className="site-placeholder" /> : null}
      {shop === "closed" ? <p className="site-shop-note">{t("The shop is not open at the moment.")}</p> : null}
      {shop === "error" ? <p className="site-shop-note">{t("The shop is unavailable. Please try again shortly.")}</p> : null}
      {typeof shop === "object" && !item ? (
        <div className="site-shop-grid">
          {shop.items.map((entry) => (
            <div className="site-shop-card" key={entry.id}>
              <strong>{entry.name}</strong>
              {itemDetail(entry) ? <span className="site-shop-detail">{itemDetail(entry)}</span> : null}
              {entry.description ? <p>{entry.description}</p> : null}
              <span className="site-shop-price">{money(entry.price, entry.currency || shop.currency)}</span>
              <button type="button" className="site-button is-primary" onClick={() => setItem(entry)}>
                {t("Buy")}
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {item ? (
        <form
          className="site-shop-form"
          onSubmit={(event) => {
            event.preventDefault();
            void pay();
          }}
        >
          <div className="site-shop-form-head">
            <strong>{item.name}</strong>
            <span className="site-shop-price">{money(item.price, item.currency)}</span>
            <button type="button" className="site-shop-change" onClick={() => setItem(null)}>
              {t("Change")}
            </button>
          </div>
          <label>
            <span>{t("Your name *")}</span>
            <input value={details.name} maxLength={120} autoComplete="name" onChange={(event) => setDetails({ ...details, name: event.target.value })} />
          </label>
          <label>
            <span>{t("Email *")}</span>
            <input type="email" value={details.email} maxLength={180} autoComplete="email" onChange={(event) => setDetails({ ...details, email: event.target.value })} />
          </label>
          <p className="site-shop-note">{gift ? t("We email the voucher code to you, ready to pass on.") : t("It goes on your account under this email.")}</p>
          {gift ? (
            <>
              <label>
                <span>{t("Who is it for? (optional)")}</span>
                <input value={details.recipientName} maxLength={120} onChange={(event) => setDetails({ ...details, recipientName: event.target.value })} />
              </label>
              <label>
                <span>{t("A message for them (optional)")}</span>
                <textarea value={details.message} rows={3} maxLength={400} onChange={(event) => setDetails({ ...details, message: event.target.value })} />
              </label>
            </>
          ) : null}
          {error ? <p className="site-shop-error">{error}</p> : null}
          <button type="submit" className="site-button is-primary" disabled={!canPay || preview}>
            {paying ? t("Taking you to secure payment…") : t("Pay {amount}", { amount: money(item.price, item.currency) })}
          </button>
        </form>
      ) : null}
    </div>
  );
}
