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
import { Check, CreditCard, ExternalLink, RotateCcw, X } from "lucide-react";
import qrcode from "qrcode-generator";
import type { PosCheckoutContext, PosPaymentMethod, PosTransaction } from "./types";

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

// Stripe checkout sessions live for 24h, but a customer standing at a counter
// either pays within a couple of minutes or does not. Stop polling after that
// rather than leaving a timer running behind a forgotten tab.
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

function renderQrSvg(value: string) {
  // Error correction M: enough redundancy for a phone camera at counter
  // distance without inflating the module count. Type 0 = auto-size.
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();
  return qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
}

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

  const [stage, setStage] = useState<"form" | "qr" | "done">("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [transaction, setTransaction] = useState<PosTransaction | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState("");

  const pollStartedAt = useRef(0);

  const amount = Number(amountInput);
  const amountValid = Number.isFinite(amount) && amount > 0;
  const selectedMethod = methods.find((method) => method.id === methodId) || null;
  const listedAmount = context.listedAmount;
  const amountChanged = listedAmount !== null && amountValid && Math.abs(amount - listedAmount) > 0.005;

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

  // onCompleted is a plain function from App.tsx, so it gets a new identity on
  // every App render - and App re-renders on a timer (notification refresh,
  // calendar clock). Holding it in a ref keeps it out of the poll effect's
  // dependencies; otherwise the interval below is torn down and rebuilt every
  // few seconds, which resets the timeout clock and delays each poll.
  const onCompletedRef = useRef(onCompleted);
  useEffect(() => {
    onCompletedRef.current = onCompleted;
  }, [onCompleted]);

  // Poll Stripe while the QR is on screen. Asking our backend to re-read the
  // session (rather than waiting on a webhook) means the till flips to Paid even
  // if webhook delivery is slow or the endpoint was never configured.
  const pollTransactionId = stage === "qr" ? transaction?.id || "" : "";
  useEffect(() => {
    if (!pollTransactionId) return;
    pollStartedAt.current = Date.now();
    let cancelled = false;

    const timer = setInterval(async () => {
      if (Date.now() - pollStartedAt.current > POLL_TIMEOUT_MS) {
        clearInterval(timer);
        if (!cancelled) setError("Stopped checking for payment. Cancel the sale and start it again.");
        return;
      }
      try {
        const response = await fetch(
          `/api/billing/pos/transactions/${encodeURIComponent(pollTransactionId)}/checkout-status`,
          { credentials: "same-origin", cache: "no-store" },
        );
        if (!response.ok) return;
        const data = (await response.json()) as { transaction?: PosTransaction; paid?: boolean };
        if (cancelled || !data.paid || !data.transaction) return;
        clearInterval(timer);
        setTransaction(data.transaction);
        setStage("done");
        onCompletedRef.current(data.transaction);
      } catch {
        // Transient network blips are expected on a till; the next tick retries.
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollTransactionId]);

  async function postJson(path: string, body: unknown) {
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(body ?? {}),
    });
    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      throw new Error(typeof data?.message === "string" ? data.message : "Payment could not be recorded.");
    }
    return data || {};
  }

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
          (await postJson("/api/billing/pos/transactions", {
            description: description.trim(),
            amount,
            listedAmount,
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

      const checkout = (await postJson(`/api/billing/pos/transactions/${encodeURIComponent(sale.id)}/checkout`, {})) as {
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
              <label htmlFor="pos-description">Description</label>
              <input
                id="pos-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
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
