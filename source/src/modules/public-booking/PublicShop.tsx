import "../../appStyles";
import "./publicShop.css";
import { useEffect, useState } from "react";
import { Check, Gift } from "lucide-react";
import { apiFetch } from "../auth/apiFetch";
import { Loading, loadingLabel } from "../shared/Loading";
import { BookingFrame, money, type Account, type Brand } from "./BookingFrame";
import { publicApi, publicBookingPath, publicShopBusiness } from "./bookingScreen";
import { t, tn } from "../../lib/i18n";
import { resolvedMarketFromWire } from "../../../netlify/functions/_shared/market-profile.mts";
import type { BusinessTerminology } from "../../../netlify/functions/_shared/business-terminology.mts";

/**
 * The shop beside a business's booking page: packages and gift vouchers,
 * bought by anyone, paid on Stripe's page.
 *
 * The page owns nothing. What is for sale, and at what price, comes from the
 * server on every load and is priced again there when the order is placed;
 * the browser only says which thing. Coming back from Stripe it asks the
 * server whether the order is paid -- the server asks Stripe -- and shows the
 * voucher code once it is. The same code goes out by email, so a buyer who
 * closes this tab has lost nothing.
 */

type ShopItem = {
  id: string;
  kind: "package" | "voucher" | "product";
  name: string;
  description: string;
  price: number;
  credits: number;
  includes: string[];
  fulfilment: "collect" | "ship" | "download" | "";
  variants: Array<{ id: string; name: string; price: number | null }>;
  stock: number | null;
};

type OrderSummary = {
  status: string;
  receiptNumber: string;
  description: string;
  amount: number;
  email: string;
  recipientName: string;
  vouchers: Array<{ code: string; value: number }>;
  downloads: Array<{ name: string; url: string }>;
};

type Details = { name: string; email: string; recipientName: string; message: string };

const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Stripe usually confirms within a few seconds of the buyer landing back here.
// Two minutes covers a slow one; past that the email is the buyer's receipt.
const CONFIRM_EVERY_MS = 2500;
const CONFIRM_FOR_MS = 2 * 60 * 1000;

async function shopCall<T>(path: string, body?: unknown): Promise<T> {
  const response = await apiFetch(publicApi(path), body === undefined
    ? undefined
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data?.message === "string" ? data.message : t("The shop is unavailable. Please try again shortly."));
  return data as T;
}

function itemDetail(item: ShopItem, terms: BusinessTerminology) {
  if (item.kind === "voucher") return t("Gift voucher");
  if (item.kind === "product") return item.fulfilment === "ship" ? t("Posted to you") : item.fulfilment === "download" ? t("Download") : t("Collect in person");
  if (item.includes.length) return item.includes.join(" + ");
  return tn(item.credits, "{count} {serviceSingular}", "{count} {servicePlural}", {
    serviceSingular: terms.serviceSingular.toLowerCase(),
    servicePlural: terms.servicePlural.toLowerCase(),
  });
}

export default function PublicShop() {
  const business = publicShopBusiness();
  const query = new URLSearchParams(window.location.search);
  const returningOrder = query.get("order") || "";
  const cancelledOrder = query.get("cancelled") || "";

  const [brand, setBrand] = useState<Brand>({});
  const [account, setAccount] = useState<Account>({});
  const [items, setItems] = useState<ShopItem[]>([]);
  const [shopState, setShopState] = useState<"loading" | "open" | "closed" | "error">("loading");
  const [itemId, setItemId] = useState("");
  const [variantId, setVariantId] = useState("");
  const [details, setDetails] = useState<Details>({ name: "", email: "", recipientName: "", message: "" });
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [order, setOrder] = useState<OrderSummary | null>(null);
  const [orderState, setOrderState] = useState<"none" | "checking" | "paid" | "waiting" | "unpaid">(returningOrder ? "checking" : "none");

  useEffect(() => {
    let cancelled = false;
    // The brand is the booking page's. A business whose booking page is off
    // still has a shop, so a failed catalogue only costs the colours.
    apiFetch(publicApi("/api/public-booking-catalog"))
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => { if (!cancelled && data) { setBrand(data.brand ?? {}); setAccount(data.account ?? {}); } })
      .catch(() => undefined);
    shopCall<{ open: boolean; businessName: string; items: ShopItem[] }>("/api/public-shop")
      .then((data) => {
        if (cancelled) return;
        setItems(Array.isArray(data.items) ? data.items : []);
        setAccount((current) => (current.businessName ? current : { ...current, businessName: data.businessName }));
        setShopState(data.open ? "open" : "closed");
      })
      .catch(() => { if (!cancelled) setShopState("error"); });
    return () => { cancelled = true; };
  }, []);

  // Back from Stripe without paying: let the order go, so it is not left
  // pending on the business's sales list.
  useEffect(() => {
    if (!cancelledOrder) return;
    void shopCall("/api/public-shop/cancel", { orderId: cancelledOrder }).catch(() => undefined);
    setNotice(t("Checkout was cancelled. Nothing has been charged."));
  }, [cancelledOrder]);

  // Back from Stripe having paid: ask until the server has settled it.
  useEffect(() => {
    if (!returningOrder) return;
    let stopped = false;
    const startedAt = Date.now();
    const check = async () => {
      try {
        const summary = await shopCall<OrderSummary>("/api/public-shop/order", { orderId: returningOrder });
        if (stopped) return;
        setOrder(summary);
        if (summary.status === "paid") { setOrderState("paid"); return; }
        if (summary.status !== "pending") { setOrderState("unpaid"); return; }
      } catch {
        // A blip; the next try asks again.
      }
      if (stopped) return;
      if (Date.now() - startedAt > CONFIRM_FOR_MS) { setOrderState("waiting"); return; }
      window.setTimeout(check, CONFIRM_EVERY_MS);
    };
    void check();
    return () => { stopped = true; };
  }, [returningOrder]);

  const item = items.find((entry) => entry.id === itemId) || null;
  const gift = item?.kind === "voucher";
  const variant = item?.variants.find((entry) => entry.id === variantId) || item?.variants[0] || null;
  const price = variant?.price ?? item?.price ?? 0;
  const canPay = Boolean(item) && item?.stock !== 0 && details.name.trim() !== "" && VALID_EMAIL.test(details.email.trim()) && !paying;
  const theme = brand.bookingTheme === "dark" ? "dark" : "light";
  const terms = resolvedMarketFromWire(account.market, account.terminology).terminology;
  const brandName = account.businessName || account.coachName || "";
  const bookingHref = `${publicBookingPath(business, "main")}${window.location.search.includes("embed=booking") ? "?embed=booking" : ""}`;
  const set = (key: keyof Details) => (event: { target: { value: string } }) =>
    setDetails((current) => ({ ...current, [key]: event.target.value }));

  async function pay() {
    if (!item || !canPay) return;
    setPaying(true);
    setError("");
    try {
      const { url } = await shopCall<{ url: string }>("/api/public-shop/checkout", {
        lines: [{ itemId: item.id, variantId: variant?.id || "", quantity: 1 }],
        name: details.name.trim(),
        email: details.email.trim(),
        recipientName: gift ? details.recipientName.trim() : "",
        message: gift ? details.message.trim() : "",
      });
      window.location.assign(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("The shop is unavailable. Please try again shortly."));
      setPaying(false);
    }
  }

  const header = (
    <>
      <div className="booking-brand">
        {brand.showLogo && brand.logoPreview ? <img src={brand.logoPreview} alt={t("{brandName} logo", { brandName })} /> : <strong>{brandName}</strong>}
        <em>{account.venueShortName}</em>
      </div>
      <div className="booking-toolbar">
        <a className="booking-login-trigger" href={bookingHref}>{t("Book a {serviceSingular}", { serviceSingular: terms.serviceSingular.toLowerCase() })}</a>
      </div>
    </>
  );

  if (returningOrder && orderState !== "none") {
    return (
      <BookingFrame brand={brand}>
        <main className={`public-booking booking-theme-${theme}`}>
          {header}
          <div className="booking-card booking-confirmation">
            {orderState === "checking" ? <Loading what={t("your payment")} /> : null}
            {orderState === "paid" && order ? (
              <>
                <Check size={24} />
                <h1>{t("Thank you")}</h1>
                {order.vouchers.map((voucher) => (
                  <div className="shop-voucher" key={voucher.code}>
                    <span>{order.recipientName ? t("Gift voucher for {name}", { name: order.recipientName }) : t("Gift voucher")}</span>
                    <strong>{voucher.code}</strong>
                    <small>{t("Worth {amount}", { amount: money(voucher.value, account) })}</small>
                  </div>
                ))}
                {order.downloads.length ? (
                  <ul className="shop-downloads">
                    {order.downloads.map((download) => (
                      <li key={download.url}><a href={download.url} target="_blank" rel="noreferrer">{download.name}</a></li>
                    ))}
                  </ul>
                ) : null}
                {!order.vouchers.length && !order.downloads.length ? <p>{t("{item} is on your account.", { item: order.description })}</p> : null}
                <p>{t("Your receipt is on its way to {email}.", { email: order.email })}</p>
              </>
            ) : null}
            {orderState === "waiting" ? (
              <>
                <h1>{t("Still confirming your payment")}</h1>
                <p>{t("If you paid, your receipt will arrive by email shortly. You do not need to pay again.")}</p>
              </>
            ) : null}
            {orderState === "unpaid" ? (
              <>
                <h1>{t("This order was not paid")}</h1>
                <p>{t("Nothing has been charged.")}</p>
              </>
            ) : null}
            {orderState !== "checking" ? (
              <a className="primary-button" href={window.location.pathname + (query.get("embed") ? "?embed=booking" : "")}>
                {t("Back to the shop")}
              </a>
            ) : null}
          </div>
        </main>
      </BookingFrame>
    );
  }

  return (
    <BookingFrame brand={brand}>
      <main className={`public-booking booking-theme-${theme}`}>
        {header}
        {notice ? <p className="email-status" role="status">{notice}</p> : null}
        {shopState === "loading" ? <Loading what={t("the shop")} /> : null}
        {shopState === "error" ? <p className="email-status failed" role="alert">{t("The shop is unavailable. Please try again shortly.")}</p> : null}
        {shopState === "closed" ? (
          <div className="booking-card booking-confirmation">
            <h1>{t("The shop is not open at the moment.")}</h1>
          </div>
        ) : null}
        {shopState === "open" ? (
          <div className="booking-columns booking-progressive-flow">
            <section className="booking-progressive-section is-open">
              <div className="booking-progressive-title">
                <span className="booking-progressive-title-label">{t("1. Choose")}</span>
                <span className="booking-progressive-title-state">
                  {item ? <button className="booking-progressive-change" onClick={() => setItemId("")} type="button">{t("Change")}</button> : t("In progress")}
                </span>
              </div>
              <div className="booking-progressive-body">
                <div className="service-picker">
                  {(item ? [item] : items).map((candidate) => (
                    <button
                      className={candidate.id === itemId ? "selected-service" : ""}
                      key={candidate.id}
                      disabled={candidate.stock === 0}
                      onClick={() => { setItemId(candidate.id === itemId ? "" : candidate.id); setVariantId(""); }}
                      type="button"
                    >
                      <strong>{candidate.kind === "voucher" ? <Gift size={15} aria-hidden="true" /> : null}{candidate.name}</strong>
                      <em>{candidate.stock === 0 ? t("Sold out") : `${money(candidate.price, account)} · ${itemDetail(candidate, terms)}`}</em>
                      {candidate.description ? <small>{candidate.description}</small> : null}
                    </button>
                  ))}
                </div>
              </div>
            </section>
            <section className={`booking-progressive-section ${item ? "is-open" : ""}`}>
              <div className="booking-progressive-title">
                <span className="booking-progressive-title-label">{t("2. Your details")}</span>
                <span className="booking-progressive-title-state">{item ? (paying ? loadingLabel() : t("In progress")) : t("Locked")}</span>
              </div>
              {item ? (
                <div className="booking-progressive-body">
                  <div className="booking-form">
                    {item.variants.length ? (
                      <select aria-label={t("Option")} className="w-name" onChange={(event) => setVariantId(event.target.value)} value={variant?.id || ""}>
                        {item.variants.map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.price !== null && entry.price !== item.price ? `${entry.name} · ${money(entry.price, account)}` : entry.name}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    <input autoComplete="name" className="w-name" onChange={set("name")} placeholder={t("Your name *")} value={details.name} />
                    <input autoComplete="email" className="w-email" onChange={set("email")} placeholder={t("Email *")} type="email" value={details.email} />
                    {gift ? (
                      <>
                        <input autoComplete="off" className="w-name" maxLength={140} onChange={set("recipientName")} placeholder={t("Who is it for? (optional)")} value={details.recipientName} />
                        <textarea aria-label={t("A message for them (optional)")} className="booking-notes" maxLength={500} onChange={set("message")} placeholder={t("A message for them (optional)")} rows={3} value={details.message} />
                      </>
                    ) : null}
                    <p className="shop-fine-print">
                      {gift
                        ? t("We email the voucher code to you, ready to pass on.")
                        : item.kind === "product"
                          ? item.fulfilment === "ship"
                            ? t("Your receipt goes to this email. The payment page asks where to post it.")
                            : t("Your receipt, and anything you download, goes to this email.")
                          : t("It goes on your account under this email.")}
                    </p>
                    {error ? <p className="email-status failed" role="alert">{error}</p> : null}
                    <button className="primary-button confirm-booking" disabled={!canPay} onClick={() => void pay()} type="button">
                      {paying ? t("Taking you to secure payment…") : t("Pay {amount}", { amount: money(price, account) })}
                    </button>
                  </div>
                </div>
              ) : null}
            </section>
          </div>
        ) : null}
      </main>
    </BookingFrame>
  );
}
