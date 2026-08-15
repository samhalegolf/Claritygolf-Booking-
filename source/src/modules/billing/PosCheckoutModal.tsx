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
import { AlertTriangle, Check, CreditCard, ExternalLink, Minus, Plus, RotateCcw, X } from "lucide-react";
import type { BillingCatalogItem, PosCheckoutContext, PosPaymentMethod, PosTransaction } from "./types";
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
};

export function PosCheckoutModal({
  context,
  currency,
  formatMoney,
  onClose,
  onCompleted,
  onToast,
}: PosCheckoutModalProps) {
  const [methods, setMethods] = useState<PosPaymentMethod[]>([]);
  const [methodsLoaded, setMethodsLoaded] = useState(false);
  const [methodId, setMethodId] = useState("");

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

  const [stage, setStage] = useState<"form" | "qr" | "done">("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [transaction, setTransaction] = useState<PosTransaction | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState("");

  const descriptionTouched = useRef(false);

  const amount = Number(amountInput);
  const amountValid = Number.isFinite(amount) && amount > 0;
  const selectedMethod = methods.find((method) => method.id === methodId) || null;
  const linesTotal = basketTotal(lines);
  // Products are added *to* whatever opened the modal, not instead of it - a
  // lesson card with a glove rung up owes the lesson plus the glove.
  const baseAmount = context.amount > 0 ? context.amount : 0;
  const listedAmount = lines.length ? round2((context.listedAmount ?? 0) + linesTotal) : context.listedAmount;
  const amountChanged = listedAmount !== null && amountValid && Math.abs(amount - listedAmount) > 0.005;

  const productMatches = useMemo(() => {
    const needle = productSearch.trim().toLowerCase();
    const sellable = products.filter((product) => product.kind === "product" && product.active !== false);
    if (!needle) return sellable.slice(0, 6);
    return sellable
      .filter((product) =>
        [product.name, product.sku, product.supplier]
          .filter(Boolean)
          .some((field) => String(field).toLowerCase().includes(needle)),
      )
      .slice(0, 8);
  }, [products, productSearch]);

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
        setMethodId((current) => current || active[0]?.id || "");
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

  async function takePayment() {
    if (!selectedMethod) {
      setError("Choose a payment method.");
      return;
    }
    if (!description.trim()) {
      setError("Add a description so the receipt makes sense later.");
      return;
    }
    if (!amountValid) {
      setError("Enter an amount greater than zero.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      // If the sale was already created and only the Stripe step failed, reuse
      // it. Pressing Charge again must not mint a second receipt number.
      const sale =
        transaction ||
        (
          (await postPosJson("/api/billing/pos/transactions", {
            description: description.trim(),
            amount,
            listedAmount,
            items: lines.map((line) => ({
              productId: line.productId,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
            })),
            currency,
            paymentMethodId: selectedMethod.id,
            customerId: context.customerId || "",
            customerName: customerName.trim(),
            customerEmail: customerEmail.trim(),
            bookingId: context.bookingId || "",
            source: context.source,
            note: note.trim(),
          })) as { transaction?: PosTransaction }
        ).transaction;

      if (!sale) throw new Error("Payment could not be recorded.");
      setTransaction(sale);
      onCompleted(sale);

      if (selectedMethod.kind !== "clarity_pay") {
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
        <div className="panel-header">
          <span>Point of sale</span>
          <button className="icon-button small" onClick={closeModal} type="button" aria-label="Close checkout">
            <X size={17} />
          </button>
        </div>
        <h2 id="pos-checkout-title">{heading}</h2>

        {error && <p className="pos-error">{error}</p>}

        {stage === "form" && (
          <>
            <div className="settings-field">
              <label htmlFor="pos-product-search">Products</label>
              <input
                id="pos-product-search"
                value={productSearch}
                onChange={(event) => setProductSearch(event.target.value)}
                placeholder="Search by name, SKU or supplier"
              />
              <div className="pos-product-options">
                {productMatches.map((product) => (
                  <button
                    key={product.id}
                    className="pos-product-option"
                    onClick={() => applyLines(addToBasket(lines, product))}
                    type="button"
                  >
                    <span>
                      {product.name}
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
                    {productSearch.trim() ? "No product matches that." : "No products yet - add them under Billing > Products."}
                  </p>
                )}
              </div>
            </div>

            {lines.length > 0 && (
              <div className="pos-basket">
                {lines.map((line) => (
                  <div key={line.productId} className="pos-basket-line">
                    <span>
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
                    <strong>{formatMoney(lineTotal(line), currency)}</strong>
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
              </div>
            )}

            <div className="settings-field">
              <label htmlFor="pos-description">Description</label>
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

            <div className="settings-field pos-amount-field">
              <label htmlFor="pos-amount">Amount</label>
              <input
                id="pos-amount"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={amountInput}
                onChange={(event) => setAmountInput(event.target.value)}
              />
              {listedAmount !== null && (
                <p className="field-help">
                  Listed at {formatMoney(listedAmount, currency)}
                  {amountChanged && (
                    <button
                      className="pos-reset-amount"
                      type="button"
                      onClick={() => setAmountInput(String(listedAmount))}
                    >
                      <RotateCcw size={12} /> Reset
                    </button>
                  )}
                </p>
              )}
            </div>

            <div className="settings-field-row">
              <div className="settings-field">
                <label htmlFor="pos-customer-name">Customer</label>
                <input
                  id="pos-customer-name"
                  value={customerName}
                  onChange={(event) => setCustomerName(event.target.value)}
                  placeholder="Optional"
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

            <div className="settings-field">
              <label>Payment method</label>
              {!methodsLoaded && <p className="field-help">Loading methods...</p>}
              {methodsLoaded && !methods.length && (
                <p className="field-help">No payment methods yet - add one under Billing &gt; Settings.</p>
              )}
              <div className="pos-method-grid">
                {methods.map((method) => (
                  <button
                    key={method.id}
                    type="button"
                    className={`pos-method-button${method.id === methodId ? " active" : ""}`}
                    onClick={() => setMethodId(method.id)}
                  >
                    {method.kind === "clarity_pay" && <CreditCard size={15} />}
                    {method.name}
                    {!method.settlesImmediately && <span className="pos-method-tag">owed</span>}
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-field">
              <label htmlFor="pos-note">Note</label>
              <input
                id="pos-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Optional - shows on the POS list only"
              />
            </div>

            <div className="panel-actions">
              <button className="outline-button" onClick={closeModal} type="button">
                Cancel
              </button>
              <button className="primary-button" disabled={busy || !selectedMethod} onClick={takePayment} type="button">
                {busy
                  ? "Working..."
                  : selectedMethod?.kind === "clarity_pay"
                    ? `Charge ${amountValid ? formatMoney(amount, currency) : ""}`.trim()
                    : `Record ${amountValid ? formatMoney(amount, currency) : "payment"}`}
              </button>
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
            {transaction.status === "pending" && (
              <p className="field-help">
                Recorded as owed on {transaction.paymentMethodName}. Mark it paid from the POS list once it is settled.
              </p>
            )}
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
