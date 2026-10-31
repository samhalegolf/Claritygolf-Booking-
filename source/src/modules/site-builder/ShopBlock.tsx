// The business's shop, on a page of its site.
//
// What is for sale comes from the server on every load and is priced again
// there when the order is placed; the page only says which things and how
// many. The visitor fills a cart (kept in the browser, see siteCart.ts), gives
// a name and email, and pays on Stripe's page, which also asks for a delivery
// address when something is posted. Back here, the order id in the address is
// confirmed with the server and the receipt shown: voucher codes, download
// links, where it is being posted. The same goes out by email, so a buyer who
// closes the tab has lost nothing.

import { useEffect, useMemo, useState } from "react";

import type { SiteShopBlock } from "../../../netlify/functions/_shared/site/document.mts";
import { t } from "../../lib/i18n";
import { cancelShopOrder, confirmShopOrder, fetchShop, startShopCheckout, type ShopItem, type ShopOrder, type ShopShelf } from "./siteApi";
import { addToCart, cartCount, readCart, setCartQuantity, writeCart, type CartLine } from "./siteCart";
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
  if (item.fulfilment === "ship") return t("Posted to you");
  if (item.fulfilment === "download") return t("Download");
  if (item.fulfilment === "collect") return t("Collect in person");
  return "";
}

/** A line of the cart with the thing it names, or null when the shelf no longer has it. */
function priced(line: CartLine, items: ShopItem[]) {
  const item = items.find((candidate) => candidate.id === line.itemId);
  if (!item) return null;
  const variant = item.variants.find((candidate) => candidate.id === line.variantId) || null;
  if (item.variants.length && !variant) return null;
  return { line, item, variant, unitPrice: variant?.price ?? item.price };
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
  const [shop, setShop] = useState<"loading" | "closed" | "error" | ShopShelf>("loading");
  const [cart, setCart] = useState<CartLine[]>(() => (preview ? [] : readCart(business.slug)));
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [stage, setStage] = useState<"shelf" | "cart" | "details">("shelf");
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
      .then((data) => !cancelled && setShop(data.open ? data : "closed"))
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
          // Paid for: the cart is done with.
          setCart([]);
          writeCart(business.slug, []);
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

  const shelf = typeof shop === "object" ? shop : null;
  const lines = useMemo(() => (shelf ? cart.map((line) => priced(line, shelf.items)).filter((line) => line !== null) : []), [cart, shelf]);
  const itemsTotal = lines.reduce((sum, line) => sum + line.unitPrice * line.line.quantity, 0);
  const needsShipping = lines.some((line) => line.item.fulfilment === "ship");
  const shipping = needsShipping && shelf ? shelf.shipping : 0;
  const total = itemsTotal + shipping;
  const gift = lines.some((line) => line.item.kind === "voucher");
  const count = cartCount(cart);

  function updateCart(next: CartLine[]) {
    setCart(next);
    if (!preview) writeCart(business.slug, next);
  }

  function add(item: ShopItem) {
    const variantId = item.variants.length ? choice[item.id] || item.variants[0].id : "";
    updateCart(addToCart(cart, item.id, variantId));
    setStage("cart");
  }

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
        {order.downloads.length ? (
          <ul className="site-shop-downloads">
            {order.downloads.map((download) => (
              <li key={download.url}>
                <a href={download.url} target="_blank" rel="noreferrer">
                  {download.name}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
        {order.shippingAddress ? <p className="site-shop-address">{t("We will post it to:")}{"\n"}{order.shippingAddress}</p> : null}
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

  const canPay = lines.length > 0 && details.name.trim().length > 0 && VALID_EMAIL.test(details.email.trim()) && !paying;

  async function pay() {
    if (preview || !canPay) return;
    setPaying(true);
    setError("");
    try {
      const url = await startShopCheckout(business.slug, {
        lines: lines.map((line) => line.line),
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

  const currency = shelf?.currency || "";

  return (
    <div className="site-shop-body">
      {cancelledOrder && stage === "shelf" ? <p className="site-shop-note">{t("Checkout was cancelled. Nothing has been charged.")}</p> : null}
      {shop === "loading" ? <div className="site-placeholder" /> : null}
      {shop === "closed" ? <p className="site-shop-note">{t("The shop is not open at the moment.")}</p> : null}
      {shop === "error" ? <p className="site-shop-note">{t("The shop is unavailable. Please try again shortly.")}</p> : null}

      {shelf && stage === "shelf" ? (
        <>
          {count > 0 ? (
            <div className="site-shop-bar">
              <span>{t("{count} in your cart", { count })}</span>
              <button type="button" className="site-button is-primary" onClick={() => setStage("cart")}>
                {t("View cart")}
              </button>
            </div>
          ) : null}
          <div className="site-shop-grid">
            {shelf.items.map((entry) => {
              const soldOut = entry.stock === 0;
              const chosen = entry.variants.find((variant) => variant.id === (choice[entry.id] || entry.variants[0]?.id)) || null;
              const price = chosen?.price ?? entry.price;
              return (
                <div className={`site-shop-card${entry.image ? " has-image" : ""}`} key={entry.id}>
                  {entry.image ? <img className="site-shop-image" src={entry.image} alt="" loading="lazy" /> : null}
                  <strong>{entry.name}</strong>
                  {itemDetail(entry) ? <span className="site-shop-detail">{itemDetail(entry)}</span> : null}
                  {entry.description ? <p>{entry.description}</p> : null}
                  {entry.variants.length ? (
                    <label className="site-shop-variant">
                      <span>{t("Option")}</span>
                      <select value={chosen?.id || ""} onChange={(event) => setChoice({ ...choice, [entry.id]: event.target.value })}>
                        {entry.variants.map((variant) => (
                          <option key={variant.id} value={variant.id}>
                            {variant.price !== null && variant.price !== entry.price ? `${variant.name} · ${money(variant.price, currency)}` : variant.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <span className="site-shop-price">{money(price, entry.currency || currency)}</span>
                  {soldOut ? (
                    <span className="site-shop-soldout">{t("Sold out")}</span>
                  ) : (
                    <button type="button" className="site-button is-primary" onClick={() => add(entry)} disabled={preview}>
                      {t("Add to cart")}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      ) : null}

      {shelf && stage !== "shelf" ? (
        <form
          className="site-shop-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (stage === "cart") setStage("details");
            else void pay();
          }}
        >
          <div className="site-shop-form-head">
            <strong>{stage === "cart" ? t("Your cart") : t("Your details")}</strong>
            <button type="button" className="site-shop-change" onClick={() => setStage(stage === "cart" ? "shelf" : "cart")}>
              {stage === "cart" ? t("Keep shopping") : t("Back to cart")}
            </button>
          </div>
          {lines.length ? (
            <ul className="site-shop-lines">
              {lines.map((line, index) => (
                <li key={`${line.item.id}-${line.variant?.id || ""}`}>
                  <span className="site-shop-line-name">
                    {line.item.name}
                    {line.variant ? <em> · {line.variant.name}</em> : null}
                  </span>
                  {stage === "cart" ? (
                    <span className="site-shop-qty">
                      <button type="button" aria-label={t("Fewer")} onClick={() => updateCart(setCartQuantity(cart, index, line.line.quantity - 1))}>
                        −
                      </button>
                      <span>{line.line.quantity}</span>
                      <button type="button" aria-label={t("More")} disabled={line.item.stock !== null && line.line.quantity >= line.item.stock} onClick={() => updateCart(setCartQuantity(cart, index, line.line.quantity + 1))}>
                        +
                      </button>
                    </span>
                  ) : (
                    <span className="site-shop-qty">×{line.line.quantity}</span>
                  )}
                  <span className="site-shop-line-total">{money(line.unitPrice * line.line.quantity, currency)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="site-shop-note">{t("Your cart is empty.")}</p>
          )}
          <dl className="site-shop-totals">
            {shipping > 0 ? (
              <>
                <dt>{t("Shipping")}</dt>
                <dd>{money(shipping, currency)}</dd>
              </>
            ) : null}
            <dt>{t("Total")}</dt>
            <dd>{money(total, currency)}</dd>
          </dl>
          {stage === "details" ? (
            <>
              <label>
                <span>{t("Your name *")}</span>
                <input value={details.name} maxLength={120} autoComplete="name" onChange={(event) => setDetails({ ...details, name: event.target.value })} />
              </label>
              <label>
                <span>{t("Email *")}</span>
                <input type="email" value={details.email} maxLength={180} autoComplete="email" onChange={(event) => setDetails({ ...details, email: event.target.value })} />
              </label>
              <p className="site-shop-note">
                {gift ? t("We email the voucher code to you, ready to pass on.") : t("Your receipt, and anything you download, goes to this email.")}
                {needsShipping ? ` ${t("The payment page asks where to post it.")}` : ""}
              </p>
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
            </>
          ) : null}
          {error ? <p className="site-shop-error">{error}</p> : null}
          <button type="submit" className="site-button is-primary" disabled={preview || !lines.length || (stage === "details" && !canPay)}>
            {stage === "cart" ? t("Checkout") : paying ? t("Taking you to secure payment…") : t("Pay {amount}", { amount: money(total, currency) })}
          </button>
        </form>
      ) : null}
    </div>
  );
}
