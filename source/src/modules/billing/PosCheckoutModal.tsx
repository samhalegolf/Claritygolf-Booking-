import { Loading } from "../shared/Loading";
// POS checkout modal - the "mini invoice" that opens from a lesson card, a
// client profile, or the New Sale button in Billing.
//
// Unlike the other billing slice components (which are presentational, with
// App.tsx owning the fetching), this one owns its own requests. The checkout
// flow is a self-contained conversation with /api/billing/pos/* - create the
// sale, open a Stripe session, poll it until it settles - and threading four
// pieces of transient state plus a poll timer back through App.tsx would add
// noise there without making anything reusable. It talks to no other endpoint,
// so nothing else in the app depends on that state.
//
// A sale is never an invoice: it lands in billing_pos_transactions with its own
// POS-#### receipt number and is never summed into invoice revenue or aging.

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronUp, ExternalLink, Minus, Pencil, Plus, RotateCcw, Ticket, X } from "lucide-react";
import type {
  BillingCatalogItem,
  BillingCoupon,
  PassOption,
  PosCheckoutContext,
  PosPaymentMethod,
  PosTransaction,
} from "./types";
import { couponApplyAmount, remainingAfterCoupon } from "./couponMath";
import { CouponPicker, useSpendableCoupons } from "./CouponPicker";
import { ReceiptEmailPrompt } from "./ReceiptEmailPrompt";
import { postPosJson, renderQrSvg, usePosPaymentPoll } from "./posCheckoutPoll";
import { addToBasket, basketTotal, describeBasket, isLowStock, lineTotal, round2, setBasketQuantity } from "./stockMath";
import type { BasketLine } from "./stockMath";

export type PosCheckoutModalProps = {
  context: PosCheckoutContext;
  currency: string;
  formatMoney: (amount: number, currency?: string) => string;
  onClose: () => void;
  // Fired once a sale exists (paid or pending) so the caller can refresh its
  // lists. May fire twice for a Clarity Pay sale: once on create, once on paid.
  onCompleted: (transaction: PosTransaction) => void;
  onToast: (message: string) => void;
  // customerId -> name, so the coupon search finds a voucher by its client.
  clientNames?: ReadonlyMap<string, string>;
  // An emailed receipt saved a new address to the client's profile.
  onClientEmailSaved?: (clientId: string, email: string) => void;
};

const NO_CLIENT_NAMES: ReadonlyMap<string, string> = new Map();

function initialsOf(name: string) {
  const parts = name.trim().split(/[\s@.]+/).filter(Boolean);
  return ((parts[0]?.[0] || "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export function PosCheckoutModal({
  context,
  currency,
  formatMoney,
  onClose,
  onCompleted,
  onToast,
  clientNames = NO_CLIENT_NAMES,
  onClientEmailSaved,
}: PosCheckoutModalProps) {
  const [methods, setMethods] = useState<PosPaymentMethod[]>([]);
  const [methodsLoaded, setMethodsLoaded] = useState(false);
  const [methodId, setMethodId] = useState("");

  // Passes this customer holds. Only ever fetched for a booking: a pass settles
  // a lesson, and there is no booking to settle on a counter sale.
  const [passOptions, setPassOptions] = useState<PassOption[]>([]);
  const [passId, setPassId] = useState("");

  const [description, setDescription] = useState(context.description);
  // Held as a string so the field can be cleared and retyped without the value
  // snapping back to 0 on every keystroke.
  const [amountInput, setAmountInput] = useState(context.amount > 0 ? String(context.amount) : "");
  const [customerName, setCustomerName] = useState(context.customerName || "");
  const [customerEmail, setCustomerEmail] = useState(context.customerEmail || "");
  const [note, setNote] = useState("");

  // The basket. Empty for a lesson or a free-form sale; a lesson can still have
  // a glove added to it, which is why this sits alongside the amount rather
  // than replacing it.
  const [lines, setLines] = useState<BasketLine[]>([]);
  const [products, setProducts] = useState<BillingCatalogItem[]>([]);
  const [productSearch, setProductSearch] = useState("");

  // A held gift voucher, exactly as on the Sell screen: held until "Pay with
  // coupon" is chosen, then either the whole payment or credit put down before
  // the rest is taken on another method.
  const couponBook = useSpendableCoupons();
  const [coupon, setCoupon] = useState<BillingCoupon | null>(null);
  const [couponApplied, setCouponApplied] = useState(false);
  const [payByCoupon, setPayByCoupon] = useState(false);
  const [confirmingCoupon, setConfirmingCoupon] = useState(false);

  const [stage, setStage] = useState<"form" | "qr" | "done">("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [transaction, setTransaction] = useState<PosTransaction | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState("");

  const descriptionTouched = useRef(false);

  // What the form keeps folded away until asked. A lesson arrives priced, so
  // its amount reads as a total; a free-form sale has nothing to show yet, so
  // its amount field starts ready to type into.
  const [editingCustomer, setEditingCustomer] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [editingAmount, setEditingAmount] = useState(!(context.amount > 0));
  const [extrasOpen, setExtrasOpen] = useState(false);

  const amount = Number(amountInput);
  const amountValid = Number.isFinite(amount) && amount > 0;
  const selectedMethod = methods.find((method) => method.id === methodId) || null;
  const couponMethod = methods.find((method) => method.kind === "coupon") || null;
  const couponAmount = coupon && amountValid ? couponApplyAmount(coupon, amount) : 0;
  const couponCovers = couponAmount > 0 && couponAmount >= amount;
  const appliedCoupon = couponApplied ? couponAmount : 0;
  const dueNow = amountValid ? remainingAfterCoupon(amount, appliedCoupon) : 0;
  const selectedPassOption = passOptions.find((option) => option.passId === passId) || null;
  const linesTotal = basketTotal(lines);
  // Products are added *to* whatever opened the modal, not instead of it - a
  // lesson card with a glove rung up owes the lesson plus the glove.
  const baseAmount = context.amount > 0 ? context.amount : 0;
  const listedAmount = lines.length ? round2((context.listedAmount ?? 0) + linesTotal) : context.listedAmount;
  const amountChanged = listedAmount !== null && amountValid && Math.abs(amount - listedAmount) > 0.005;

  const productMatches = useMemo(() => {
    const needle = productSearch.trim().toLowerCase();
    // Packages belong here as well as on the shelf: a customer in for a lesson
    // buying a block of them is the most ordinary way one gets sold, and until
    // now this picker filtered them out, so the only route was the counter.
    //
    // Unshown by default though -- with no search this is the "add a glove"
    // shortcut, and a package is not an impulse buy.
    const sellable = products.filter(
      (product) => (product.kind === "product" || product.kind === "package") && product.active !== false,
    );
    if (!needle) return sellable.filter((product) => product.kind === "product").slice(0, 6);
    return sellable
      .filter((product) =>
        [product.name, product.sku, product.supplier]
          .filter(Boolean)
          .some((field) => String(field).toLowerCase().includes(needle)),
      )
      .slice(0, 8);
  }, [products, productSearch]);

  // With nothing on the order yet (a free-form sale), what it is for is the
  // first thing to type, so the description sits in the order itself. Once a
  // lesson or a product names the sale it moves under the extras row.
  const describeInline = !context.description && !lines.length;
  const extrasSummary = [
    !passId && coupon ? coupon.code : "",
    note.trim() ? "Note" : "",
    !describeInline && descriptionTouched.current ? "Receipt text" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const ctaHint = passId || payByCoupon
    ? ""
    : selectedMethod?.kind === "clarity_pay"
      ? "Shows a QR code the customer scans to pay."
      : selectedMethod && !selectedMethod.settlesImmediately
        ? "Recorded as owed. Mark it paid from the POS list once settled."
        : "";

  const qrMarkup = useMemo(() => (checkoutUrl ? renderQrSvg(checkoutUrl) : ""), [checkoutUrl]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/billing/pos/payment-methods", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Could not load payment methods.");
        const data = (await response.json()) as { paymentMethods?: PosPaymentMethod[] };
        if (cancelled) return;
        const active = (data.paymentMethods || []).filter((method) => method.active);
        setMethods(active);
        // The pass method is never picked from the grid -- it is what the Use
        // pass block selects -- so it is not offered as a way to pay by hand.
        // Choosing it without a pass would write a $0 sale settled by nothing.
        setMethodId(
          (current) => current || active.find((method) => method.kind !== "pass" && method.kind !== "coupon")?.id || "",
        );
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Could not load payment methods.");
      } finally {
        if (!cancelled) setMethodsLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // What this customer could pay with instead of money. The server decides
  // which passes cover this service -- the till is not allowed an opinion about
  // what a credit may buy.
  useEffect(() => {
    const personId = context.customerId || "";
    if (!personId || !context.bookingId || !context.serviceId) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(
          `/api/passes?personId=${encodeURIComponent(personId)}&serviceId=${encodeURIComponent(context.serviceId || "")}`,
          { credentials: "same-origin", cache: "no-store" },
        );
        if (!response.ok) return;
        const data = (await response.json()) as { options?: PassOption[] };
        if (!cancelled) setPassOptions(Array.isArray(data.options) ? data.options : []);
      } catch {
        // No passes offered this time; paying by any other method still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [context.customerId, context.bookingId, context.serviceId]);

  // Products are optional to the flow, so a failed load leaves the picker empty
  // rather than blocking a sale that may not involve any stock at all.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/billing/products", { credentials: "same-origin", cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { products?: BillingCatalogItem[] };
        if (!cancelled) setProducts(Array.isArray(data.products) ? data.products : []);
      } catch {
        // No products picker this time; the amount field still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Ringing an item up rewrites the amount. Anything typed afterwards stays put
  // until the basket changes again - that is how a counter discount is given.
  // The description follows the basket the same way, until someone types their
  // own, at which point it is theirs and we stop touching it.
  function applyLines(next: BasketLine[]) {
    setLines(next);
    const total = round2(baseAmount + basketTotal(next));
    setAmountInput(total > 0 ? String(total) : "");
    if (!descriptionTouched.current) {
      setDescription([context.description, describeBasket(next)].filter(Boolean).join(", "));
    }
  }

  // Poll Stripe while the QR is on screen. The hook holds both callbacks in refs
  // - onCompleted is a plain function from App.tsx and gets a new identity on
  // every App render, which would otherwise rebuild the interval every few
  // seconds and reset the timeout clock.
  usePosPaymentPoll(
    stage === "qr" ? transaction?.id || "" : "",
    (paid) => {
      setTransaction(paid);
      setStage("done");
      onCompleted(paid);
    },
    () => setError("Stopped checking for payment. Cancel the sale and start it again."),
  );

  function releaseCoupon() {
    setCoupon(null);
    setCouponApplied(false);
    setPayByCoupon(false);
    setConfirmingCoupon(false);
  }

  async function takePayment() {
    // Paying with a pass swaps the method out from under the grid: the sale is
    // recorded against the Pass method, not whatever was highlighted before.
    // A coupon that covers the whole sale does the same with the Coupon method.
    const passMethod = methods.find((method) => method.kind === "pass") || null;
    if (payByCoupon && coupon && !couponCovers) {
      // Not enough on it: confirm before anything is recorded.
      setExtrasOpen(true);
      setConfirmingCoupon(true);
      return;
    }
    const payingMethod = passId ? passMethod : payByCoupon ? couponMethod : selectedMethod;
    if (passId && !passMethod) {
      setError("This account has no Pass payment method yet. Reopen the checkout and try again.");
      return;
    }
    if (payByCoupon && !couponMethod) {
      setError("This account has no Coupon payment method yet. Reopen the checkout and try again.");
      return;
    }
    const spendCoupon = !passId && Boolean(coupon) && (payByCoupon || couponApplied);
    if (!payingMethod) {
      setError("Choose a payment method.");
      return;
    }
    if (!description.trim()) {
      if (!describeInline) setExtrasOpen(true);
      setError("Add a description so the receipt makes sense later.");
      return;
    }
    if (!amountValid) {
      setEditingAmount(true);
      setError("Enter an amount greater than zero.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      // If the sale was already created and only the Stripe step failed, reuse
      // it. Pressing Charge again must not mint a second receipt number.
      //
      // The response carries more than the sale: ringing a package up issues a
      // pass, and the coach should hear that from the till rather than find out
      // later on the client's profile.
      const created = transaction
        ? null
        : ((await postPosJson("/api/billing/pos/transactions", {
            description: description.trim(),
            amount,
            listedAmount,
            items: lines.map((line) => ({
              productId: line.productId,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
            })),
            currency,
            paymentMethodId: payingMethod.id,
            couponId: spendCoupon ? coupon?.id || "" : "",
            couponAmount: spendCoupon ? couponAmount : 0,
            passId,
            serviceId: context.serviceId || "",
            customerId: context.customerId || "",
            customerName: customerName.trim(),
            customerEmail: customerEmail.trim(),
            bookingId: context.bookingId || "",
            source: context.source,
            note: note.trim(),
          })) as { transaction?: PosTransaction; issuedPasses?: string[] });

      const sale = transaction || created?.transaction;
      if (!sale) throw new Error("Payment could not be recorded.");
      setTransaction(sale);
      onCompleted(sale);
      if (spendCoupon) couponBook.reload();
      if (created?.issuedPasses?.length) {
        onToast(
          created.issuedPasses.length === 1
            ? `${created.issuedPasses[0]} added to their profile.`
            : `${created.issuedPasses.join(", ")} added to their profile.`,
        );
      }

      if (payingMethod.kind !== "clarity_pay") {
        setStage("done");
        return;
      }

      const checkout = (await postPosJson(`/api/billing/pos/transactions/${encodeURIComponent(sale.id)}/checkout`, {})) as {
        url?: string;
      };
      if (!checkout.url) throw new Error("Stripe did not return a checkout link.");
      setCheckoutUrl(checkout.url);
      setStage("qr");
    } catch (paymentError) {
      setError(paymentError instanceof Error ? paymentError.message : "Payment could not be recorded.");
    } finally {
      setBusy(false);
    }
  }

  // Abandoning a Clarity Pay sale voids the pending record rather than leaving
  // an orphan in the transaction list.
  async function cancelPendingSale() {
    if (!transaction) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/billing/pos/transactions/${encodeURIComponent(transaction.id)}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "void" }),
      });
      if (response.ok) {
        const data = (await response.json()) as { transaction?: PosTransaction };
        if (data.transaction) onCompleted(data.transaction);
      }
      onToast(`${transaction.receiptNumber} cancelled.`);
    } catch {
      onToast("Could not cancel the sale - check the POS list.");
    } finally {
      setBusy(false);
      onClose();
    }
  }

  // A Clarity Pay sale that never cleared has to be voided on the way out,
  // otherwise a pending row and a live Stripe session are left behind with
  // nothing watching them. This covers both walking away from the QR and
  // abandoning after the Stripe step failed. A pending "On account" sale is the
  // opposite case - that record is the whole point, so it stays.
  const abandonable =
    Boolean(transaction) && transaction?.status === "pending" && transaction?.paymentMethodKind === "clarity_pay";

  function closeModal() {
    if (abandonable) {
      void cancelPendingSale();
      return;
    }
    onClose();
  }

  const heading = stage === "done" ? "Payment recorded" : stage === "qr" ? "Waiting for payment" : "Checkout";

  // Backdrop dismissal is disabled while the QR is up so a stray tap on a till
  // screen can't void a payment the customer is mid-way through.
  return (
    <div className="details-overlay" role="presentation" onPointerDown={stage === "qr" ? undefined : closeModal}>
      <aside
        className="details-panel details-modal pos-checkout-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pos-checkout-title"
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") closeModal();
        }}
      >
        <div className="pos-checkout-head">
          <h2 id="pos-checkout-title">{heading}</h2>
          <button className="icon-button small" onClick={closeModal} type="button" aria-label="Close checkout">
            <X size={17} />
          </button>
        </div>

        {error && <p className="pos-error">{error}</p>}

        {stage === "form" && (
          <>
            {/* Who is paying. On a lesson this is already known, so it reads as
                one line and only turns into fields when someone asks to change it. */}
            {editingCustomer ? (
              <div className="settings-field-row pos-customer-edit">
                <div className="settings-field">
                  <label htmlFor="pos-customer-name">Customer</label>
                  <input
                    id="pos-customer-name"
                    value={customerName}
                    onChange={(event) => setCustomerName(event.target.value)}
                    placeholder="Optional"
                    autoFocus
                  />
                </div>
                <div className="settings-field">
                  <label htmlFor="pos-customer-email">Email</label>
                  <input
                    id="pos-customer-email"
                    type="email"
                    value={customerEmail}
                    onChange={(event) => setCustomerEmail(event.target.value)}
                    placeholder="Optional"
                  />
                </div>
              </div>
            ) : customerName.trim() || customerEmail.trim() ? (
              <div className="pos-customer">
                <span className="pos-customer-initials" aria-hidden="true">
                  {initialsOf(customerName || customerEmail)}
                </span>
                <span className="pos-customer-text">
                  <strong>{customerName.trim() || customerEmail.trim()}</strong>
                  {customerName.trim() && customerEmail.trim() && <em>{customerEmail.trim()}</em>}
                </span>
                <button className="pos-text-button" onClick={() => setEditingCustomer(true)} type="button">
                  Change
                </button>
              </div>
            ) : (
              <button className="pos-text-button pos-add-customer" onClick={() => setEditingCustomer(true)} type="button">
                <Plus size={14} /> Add customer
              </button>
            )}

            {/* The order: what opened the checkout, anything rung up on top of
                it, and the total. Search and the amount field stay folded away
                until they are wanted. */}
            <div className="pos-order">
              {context.description ? (
                <div className="pos-order-line">
                  <span className="pos-order-name">
                    <strong>{context.serviceName || context.description}</strong>
                    {context.serviceName && customerName.trim() && <em>{customerName.trim()}</em>}
                  </span>
                  {baseAmount > 0 && <strong className="pos-order-price">{formatMoney(baseAmount, currency)}</strong>}
                </div>
              ) : (
                describeInline && (
                  <div className="settings-field pos-order-describe">
                    <label htmlFor="pos-description">What is being paid for</label>
                    <input
                      id="pos-description"
                      value={description}
                      onChange={(event) => {
                        descriptionTouched.current = true;
                        setDescription(event.target.value);
                      }}
                      placeholder="e.g. Club fitting"
                    />
                  </div>
                )
              )}

              {lines.map((line) => (
                <div key={line.productId} className="pos-order-line">
                  <span className="pos-order-name">
                    <strong>{line.name}</strong>
                    <em>{formatMoney(line.unitPrice, currency)} each</em>
                  </span>
                  <div className="pos-basket-qty">
                    <button
                      className="icon-button small"
                      onClick={() => applyLines(setBasketQuantity(lines, line.productId, line.quantity - 1))}
                      type="button"
                      aria-label={`One fewer ${line.name}`}
                    >
                      <Minus size={14} />
                    </button>
                    <b>{line.quantity}</b>
                    <button
                      className="icon-button small"
                      onClick={() => applyLines(setBasketQuantity(lines, line.productId, line.quantity + 1))}
                      type="button"
                      aria-label={`One more ${line.name}`}
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                  <strong className="pos-order-price">{formatMoney(lineTotal(line), currency)}</strong>
                  <button
                    className="icon-button small"
                    onClick={() => applyLines(setBasketQuantity(lines, line.productId, 0))}
                    type="button"
                    aria-label={`Remove ${line.name}`}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}

              {searchOpen ? (
                <div className="pos-order-search">
                  <div className="pos-order-search-bar">
                    <input
                      aria-label="Search products and packages"
                      value={productSearch}
                      onChange={(event) => setProductSearch(event.target.value)}
                      placeholder="Search products and packages"
                      autoFocus
                    />
                    <button
                      className="pos-text-button"
                      onClick={() => {
                        setSearchOpen(false);
                        setProductSearch("");
                      }}
                      type="button"
                    >
                      Done
                    </button>
                  </div>
                  <div className="pos-product-options">
                    {productMatches.map((product) => (
                      <button
                        key={product.id}
                        className="pos-product-option"
                        onClick={() => {
                          applyLines(addToBasket(lines, product));
                          setSearchOpen(false);
                          setProductSearch("");
                        }}
                        type="button"
                      >
                        <span>
                          {product.name}
                          {product.kind === "package" && <Ticket size={12} />}
                          {isLowStock(product) && <AlertTriangle size={12} />}
                        </span>
                        <em>
                          {formatMoney(product.price, currency)}
                          {product.trackStock ? ` - ${product.stockLevel ?? 0} left` : ""}
                        </em>
                      </button>
                    ))}
                    {!productMatches.length && (
                      <p className="field-help">
                        {productSearch.trim()
                          ? "Nothing matches that. Packages are found by name -- try the package's own name."
                          : "Nothing on the shelf yet? Add items under Billing > Products."}
                      </p>
                    )}
                  </div>
                </div>
              ) : (
                <button className="pos-order-add" onClick={() => setSearchOpen(true)} type="button">
                  <Plus size={15} /> Add product or package
                </button>
              )}

              <div className="pos-order-total">
                <span className="pos-order-total-label">
                  Total
                  {amountChanged && listedAmount !== null && (
                    <button
                      className="pos-text-button"
                      type="button"
                      onClick={() => setAmountInput(String(listedAmount))}
                    >
                      <RotateCcw size={12} /> Reset to {formatMoney(listedAmount, currency)}
                    </button>
                  )}
                </span>
                {editingAmount ? (
                  <input
                    className="pos-order-amount"
                    aria-label="Amount"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={amountInput}
                    onChange={(event) => setAmountInput(event.target.value)}
                    onBlur={() => {
                      if (amountValid) setEditingAmount(false);
                    }}
                    autoFocus={context.amount > 0}
                    placeholder="0.00"
                  />
                ) : (
                  <button
                    className="pos-order-amount-button"
                    type="button"
                    onClick={() => setEditingAmount(true)}
                    aria-label={`Total ${amountValid ? formatMoney(amount, currency) : ""}. Change amount`}
                  >
                    {amountValid ? formatMoney(amount, currency) : "Set amount"}
                    <Pencil size={13} />
                  </button>
                )}
              </div>
              {appliedCoupon > 0 && (
                <div className="pos-order-coupon">
                  <span>Coupon {coupon?.code}</span>
                  <span>
                    -{formatMoney(appliedCoupon, currency)} · {formatMoney(dueNow, currency)} due
                  </span>
                </div>
              )}
            </div>

            <div className="pos-pay">
              <span className="pos-section-label">
                {passId ? "Paying with a pass" : appliedCoupon > 0 ? `Remaining ${formatMoney(dueNow, currency)} paid by` : "Pay with"}
              </span>

              {passOptions.length > 0 && (
                <div className="pos-pass-list">
                  {passOptions.map((option) => (
                    <button
                      key={option.passId}
                      type="button"
                      className={`pos-pass-option${option.passId === passId ? " active" : ""}`}
                      disabled={!option.covered}
                      aria-pressed={option.passId === passId}
                      onClick={() => {
                        setPassId((current) => (current === option.passId ? "" : option.passId));
                        // A lesson is settled by a pass or by money, not both.
                        releaseCoupon();
                      }}
                    >
                      <span className="pos-pass-name">
                        <Ticket size={15} />
                        {option.name}
                      </span>
                      <span className="pos-pass-meta">
                        {option.covered
                          ? (option.paymentKind === "cross_redemption"
                              ? `Use Clarity balance · ${formatMoney(option.availableValueCents / 100, option.currency || currency)} available`
                              : `${option.creditsAvailable} of ${option.creditsAllocated} left`) +
                            (option.nextExpiry
                              ? ` · expires ${new Date(option.nextExpiry).toLocaleDateString(undefined, {
                                  day: "numeric",
                                  month: "short",
                                  year: "numeric",
                                })}`
                              : "")
                          : option.reason}
                      </span>
                    </button>
                  ))}
                  {passId ? (
                    <p className="field-help">
                      {selectedPassOption?.paymentKind === "cross_redemption" ? (
                        <>
                          Using balance will leave {selectedPassOption.remainingCreditsAfter ?? 0} whole entitlement
                          {(selectedPassOption.remainingCreditsAfter ?? 0) === 1 ? "" : "s"}
                          {selectedPassOption.residualValueCentsAfter
                            ? ` and ${formatMoney(selectedPassOption.residualValueCentsAfter / 100, selectedPassOption.currency || currency)} credit`
                            : ""}
                          .
                        </>
                      ) : (
                        <>One native entitlement will be used. Flexible credit stays untouched.</>
                      )}
                    </p>
                  ) : null}
                </div>
              )}

              {!methodsLoaded && <Loading what="payment methods" className="field-help" />}
              {methodsLoaded && !methods.length && (
                <p className="field-help">No payment methods yet - add one under Billing &gt; Settings.</p>
              )}
              <div className="pos-method-grid">
                {coupon && !couponApplied && !passId && couponAmount > 0 && (
                  <button
                    type="button"
                    className={`pos-method-button${payByCoupon ? " active" : ""}`}
                    onClick={() => {
                      setPayByCoupon(true);
                      setConfirmingCoupon(false);
                    }}
                  >
                    <span>Coupon</span>
                    <span className="pos-method-tag">{coupon.code}</span>
                  </button>
                )}
                {methods.filter((method) => method.kind !== "pass" && method.kind !== "coupon").map((method) => (
                  <button
                    key={method.id}
                    type="button"
                    className={`pos-method-button${method.id === methodId && !passId && !payByCoupon ? " active" : ""}`}
                    onClick={() => {
                      setPassId("");
                      setPayByCoupon(false);
                      setConfirmingCoupon(false);
                      setMethodId(method.id);
                    }}
                  >
                    <span>{method.name}</span>
                    {method.kind === "clarity_pay" ? (
                      <span className="pos-method-tag">Card / QR</span>
                    ) : (
                      !method.settlesImmediately && <span className="pos-method-tag">Owed</span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* Everything a sale rarely needs, folded into one row. The row says
                what is set inside it so nothing hides unnoticed. */}
            <div className="pos-extras">
              <button
                className="pos-extras-toggle"
                type="button"
                aria-expanded={extrasOpen}
                aria-controls="pos-extras-body"
                onClick={() => setExtrasOpen((current) => !current)}
              >
                <span>{passId ? "Note & receipt text" : "Coupon, note & receipt text"}</span>
                <em>{extrasOpen ? "" : extrasSummary || "Optional"}</em>
                {extrasOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
              {extrasOpen && (
                <div className="pos-extras-body" id="pos-extras-body">
                  {!passId && (
                    <div className="settings-field">
                      <label>Coupon</label>
                      <CouponPicker
                        book={couponBook}
                        held={coupon}
                        applyAmount={couponAmount}
                        applied={couponApplied}
                        clientNames={clientNames}
                        formatMoney={formatMoney}
                        onHold={(picked) => {
                          setCoupon(picked);
                          setCouponApplied(false);
                          setPayByCoupon(false);
                        }}
                        onRelease={releaseCoupon}
                        disabled={busy}
                      />
                      {confirmingCoupon && coupon && (
                        <div className="pos-coupon-confirm">
                          <p>
                            {coupon.code} has {formatMoney(coupon.remainingValue, coupon.currency)} on it, which covers{" "}
                            {formatMoney(couponAmount, currency)} of {formatMoney(amount, currency)}. Put it down as paid
                            credit and choose how the remaining {formatMoney(amount - couponAmount, currency)} is paid?
                          </p>
                          <div className="panel-actions">
                            <button className="outline-button" onClick={() => setConfirmingCoupon(false)} type="button">
                              Back
                            </button>
                            <button
                              className="primary-button"
                              onClick={() => {
                                setCouponApplied(true);
                                setPayByCoupon(false);
                                setConfirmingCoupon(false);
                              }}
                              type="button"
                            >
                              Use {formatMoney(couponAmount, currency)} credit
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {!describeInline && (
                    <div className="settings-field">
                      <label htmlFor="pos-description">Receipt description</label>
                      <input
                        id="pos-description"
                        value={description}
                        onChange={(event) => {
                          descriptionTouched.current = true;
                          setDescription(event.target.value);
                        }}
                        placeholder="What is being paid for"
                      />
                    </div>
                  )}

                  <div className="settings-field">
                    <label htmlFor="pos-note">Note</label>
                    <input
                      id="pos-note"
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      placeholder="Optional - shows on the POS list only"
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="pos-checkout-footer">
              <button
                className="primary-button"
                disabled={busy || confirmingCoupon || (!selectedMethod && !passId && !payByCoupon)}
                onClick={takePayment}
                type="button"
              >
                {busy
                  ? "Working..."
                  : passId
                    ? "Use pass"
                    : payByCoupon
                      ? couponCovers
                        ? `Pay ${formatMoney(amount, currency)} with coupon`
                        : "Pay with coupon"
                      : selectedMethod?.kind === "clarity_pay"
                        ? `Charge ${amountValid ? formatMoney(dueNow, currency) : ""}`.trim()
                        : selectedMethod && !selectedMethod.settlesImmediately
                          ? `Record ${amountValid ? formatMoney(dueNow, currency) : "payment"} as owed`
                          : `Record ${amountValid ? formatMoney(dueNow, currency) : "payment"}`}
              </button>
              {ctaHint && <p className="field-help">{ctaHint}</p>}
            </div>
          </>
        )}

        {stage === "qr" && transaction && (
          <>
            <p className="muted">
              {formatMoney(transaction.amount, transaction.currency)} - {transaction.receiptNumber}
            </p>
            <p className="field-help">
              Customer scans this with their phone camera and pays with Apple Pay, Google Pay or a card. This screen
              updates on its own the moment it clears.
            </p>
            {qrMarkup && <div className="pos-qr" aria-label="Payment QR code" dangerouslySetInnerHTML={{ __html: qrMarkup }} />}
            <div className="panel-actions">
              <button className="outline-button" disabled={busy} onClick={cancelPendingSale} type="button">
                Cancel sale
              </button>
              <a className="outline-button" href={checkoutUrl} target="_blank" rel="noreferrer noopener">
                <ExternalLink size={15} /> Pay on this device
              </a>
            </div>
          </>
        )}

        {stage === "done" && transaction && (
          <>
            <div className="pos-done">
              <Check size={22} />
              <div>
                <strong>{formatMoney(transaction.amount, transaction.currency)}</strong>
                <span>
                  {transaction.paymentMethodName} - {transaction.receiptNumber}
                </span>
              </div>
            </div>
            {(transaction.couponAmount ?? 0) > 0 && (
              <p className="field-help">
                {formatMoney(transaction.couponAmount ?? 0, transaction.currency)} of it paid by coupon
                {coupon ? ` ${coupon.code}` : ""}.
              </p>
            )}
            {transaction.status === "pending" && (
              <p className="field-help">
                Recorded as owed on {transaction.paymentMethodName}. Mark it paid from the POS list once it is settled.
              </p>
            )}
            <ReceiptEmailPrompt
              key={transaction.id}
              transactionId={transaction.id}
              email={customerEmail.trim() || transaction.customerEmail || ""}
              clientId={context.customerId || ""}
              clientName={customerName.trim()}
              onClientEmailSaved={onClientEmailSaved}
            />
            <div className="panel-actions">
              <button className="primary-button" onClick={onClose} type="button">
                Done
              </button>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
