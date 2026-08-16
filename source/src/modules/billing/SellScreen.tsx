// Sell - the full-screen till.
//
// Two panes: the catalog on the left (search, category tabs, tiles) taking the
// room, the docket on the right (what is being bought, the customer, and the Pay
// button) as a fixed column. The small PosCheckoutModal still exists and
// still makes sense from a lesson card or a client profile, where the sale is
// already defined and a modal is less disruptive than changing screens. This is
// for walk-ups, where nothing is known until someone puts a glove on the counter.
//
// Like PosCheckoutModal, this owns its own fetching: it is a self-contained
// conversation with /api/billing/pos/* and /api/billing/products, and threading
// a docket plus a payment state machine plus a poll timer through App.tsx would
// add noise there without making anything reusable.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CreditCard,
  ExternalLink,
  Minus,
  Package,
  Plus,
  Search,
  Ticket,
  Trash2,
  User,
  X,
} from "lucide-react";
import type { BillingCatalogItem, BillingCatalogKind, BillingCoupon, PosPaymentMethod, PosTransaction } from "./types";
import { couponApplyAmount, couponBlockedReason, remainingAfterCoupon } from "./couponMath";
import {
  addCustomSellLine,
  addSellLine,
  cashSuggestions,
  changeDue,
  isLowStock,
  lineTotal,
  sellTaxIncluded,
  sellTotal,
  setSellPrice,
  setSellQuantity,
} from "./stockMath";
import type { SellLine } from "./stockMath";
import { postPosJson, renderQrSvg, usePosPaymentPoll } from "./posCheckoutPoll";

export type SellScreenProps = {
  currency: string;
  taxName: string;
  defaultTaxRate: number;
  // The catalog comes from App, which already fetches and owns it. The till
  // used to fetch its own copy on mount and then never refresh it, so a lesson
  // price changed elsewhere left the counter selling the old one until the tab
  // was reloaded. One copy, one refresh.
  catalog: BillingCatalogItem[];
  catalogState: "idle" | "loading" | "loaded" | "error";
  onReloadCatalog: () => void;
  formatMoney: (amount: number, currency?: string) => string;
  clients: Array<{ id: string; name: string; email?: string }>;
  // Creates a client record from the till and returns it attached. Null means
  // the write failed and the caller has already said so.
  onCreateClient: (name: string) => Promise<{ id: string; name: string; email?: string } | null>;
  onSaleCompleted: (transaction: PosTransaction) => void;
  onToast: (message: string) => void;
};

type TabKey = "all" | BillingCatalogKind;

const TAB_LABELS: Record<TabKey, string> = {
  all: "All",
  product: "Products",
  service: "Services",
  package: "Packages",
};

const TAB_ORDER: TabKey[] = ["all", "product", "service", "package"];

// Parked dockets live on the till, not in the database. A parked sale is a
// half-finished thought belonging to whoever is standing at this counter right
// now; it does not need to survive a device change, and keeping it local means
// no schema and no way for a stale park to reappear on someone else's screen.
const PARKED_KEY = "clarity.sell.parked.v1";

type ParkedSale = {
  id: string;
  label: string;
  parkedAt: string;
  lines: SellLine[];
  customerName: string;
  customerEmail: string;
  customerId: string;
};

function readParked(): ParkedSale[] {
  try {
    const raw = window.localStorage.getItem(PARKED_KEY);
    const parsed = raw ? (JSON.parse(raw) as ParkedSale[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeParked(sales: ParkedSale[]) {
  try {
    window.localStorage.setItem(PARKED_KEY, JSON.stringify(sales));
  } catch {
    // A full or disabled localStorage shouldn't take the till down; the sale on
    // screen is unaffected, only the parking of it.
  }
}

export function SellScreen({
  currency,
  taxName,
  defaultTaxRate,
  catalog,
  catalogState,
  onReloadCatalog,
  formatMoney,
  clients,
  onCreateClient,
  onSaleCompleted,
  onToast,
}: SellScreenProps) {
  const [methods, setMethods] = useState<PosPaymentMethod[]>([]);

  const [lines, setLines] = useState<SellLine[]>([]);
  const [tab, setTab] = useState<TabKey>("product");
  const [search, setSearch] = useState("");

  const [customerId, setCustomerId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerSaving, setCustomerSaving] = useState(false);

  const [customName, setCustomName] = useState("");
  const [customAmount, setCustomAmount] = useState("");
  const [customOpen, setCustomOpen] = useState(false);

  const [parked, setParked] = useState<ParkedSale[]>(() => (typeof window === "undefined" ? [] : readParked()));

  // A voucher put against this sale. It pays the total down; whatever is left
  // is taken on a normal method, which is why it lives outside payStage.
  const [coupon, setCoupon] = useState<BillingCoupon | null>(null);
  const [couponCode, setCouponCode] = useState("");
  const [couponError, setCouponError] = useState("");
  const [couponBusy, setCouponBusy] = useState(false);

  // Payment overlay. "closed" -> "method" -> ("cash" for tendering) -> "qr" -> "done".
  const [payStage, setPayStage] = useState<"closed" | "method" | "cash" | "qr" | "done">("closed");
  const [methodId, setMethodId] = useState("");
  const [tendered, setTendered] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sale, setSale] = useState<PosTransaction | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState("");
  // Codes minted by this sale (a voucher product was rung up). Read out on the
  // done screen so they can be written on the card before it leaves.
  const [issuedCoupons, setIssuedCoupons] = useState<BillingCoupon[]>([]);

  const searchRef = useRef<HTMLInputElement | null>(null);

  const total = sellTotal(lines);
  const taxIncluded = sellTaxIncluded(lines);
  const itemCount = lines.reduce((count, line) => count + line.quantity, 0);
  const selectedMethod = methods.find((method) => method.id === methodId) || null;
  // Capped by the balance and by the sale: a $100 voucher against a $40 sale
  // spends $40 and keeps $60, it does not hand out change.
  const couponAmount = coupon ? couponApplyAmount(coupon, total) : 0;
  const dueNow = remainingAfterCoupon(total, couponAmount);
  const tenderedValue = Number(tendered);
  const change = changeDue(tenderedValue, dueNow);

  // Opening the till is a good moment to make sure the prices on the tiles are
  // the ones in the database - somebody may have changed a lesson price while
  // this tab sat on the counter.
  useEffect(() => {
    onReloadCatalog();
    // Deliberately on mount only; onReloadCatalog is a plain function from App
    // and gets a new identity on every App render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/billing/pos/payment-methods", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (cancelled || !response.ok) return;
        const methodData = (await response.json()) as { paymentMethods?: PosPaymentMethod[] };
        setMethods((methodData.paymentMethods || []).filter((method) => method.active));
      } catch {
        // No methods means the Pay button explains itself; nothing to do here.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const tiles = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return catalog
      .filter((item) => item.active !== false)
      .filter((item) => (tab === "all" ? true : item.kind === tab))
      .filter((item) =>
        needle
          ? [item.name, item.sku, item.supplier].filter(Boolean).some((field) => String(field).toLowerCase().includes(needle))
          : true,
      )
      .slice(0, 120);
  }, [catalog, tab, search]);

  const clientMatches = useMemo(() => {
    const needle = customerSearch.trim().toLowerCase();
    if (!needle) return [];
    return clients
      .filter((client) => !client.id.startsWith("appointment-"))
      .filter((client) =>
        [client.name, client.email].filter(Boolean).some((field) => String(field).toLowerCase().includes(needle)),
      )
      .slice(0, 6);
  }, [clients, customerSearch]);

  function attachCustomer(client: { id: string; name: string; email?: string }) {
    setCustomerId(client.id);
    setCustomerName(client.name);
    setCustomerEmail(client.email || "");
    setCustomerSearch("");
  }

  // The "+ Add" row under the suggestions. Creates a real client record rather
  // than pinning a loose name to the sale, so the next visit finds them.
  async function addCustomer() {
    const name = customerSearch.trim();
    if (!name) return;
    setCustomerSaving(true);
    try {
      const created = await onCreateClient(name);
      if (created) attachCustomer(created);
    } finally {
      setCustomerSaving(false);
    }
  }

  function resetSale() {
    setLines([]);
    setCustomerId("");
    setCustomerName("");
    setCustomerEmail("");
    setCustomerSearch("");
    setSale(null);
    setCheckoutUrl("");
    setTendered("");
    setError("");
    setCoupon(null);
    setCouponCode("");
    setCouponError("");
    setIssuedCoupons([]);
    setPayStage("closed");
    searchRef.current?.focus();
  }

  function addItem(item: BillingCatalogItem) {
    setLines((current) => addSellLine(current, item));
    setSearch("");
    searchRef.current?.focus();
  }

  function addCustom() {
    const amount = Number(customAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      onToast("Enter an amount for the custom item.");
      return;
    }
    setLines((current) => addCustomSellLine(current, customName, amount, defaultTaxRate));
    setCustomName("");
    setCustomAmount("");
    setCustomOpen(false);
  }

  // --- Parking ---------------------------------------------------------------

  function parkSale() {
    if (!lines.length) return;
    const entry: ParkedSale = {
      id: `park-${Date.now()}`,
      label: customerName.trim() || lines.map((line) => line.name).join(", ").slice(0, 40),
      parkedAt: new Date().toISOString(),
      lines,
      customerId,
      customerName,
      customerEmail,
    };
    const next = [entry, ...parked].slice(0, 12);
    setParked(next);
    writeParked(next);
    resetSale();
    onToast("Sale parked.");
  }

  function resumeSale(entry: ParkedSale) {
    // Anything already on screen would be silently thrown away, so it gets
    // parked first rather than lost.
    if (lines.length) parkSale();
    setLines(entry.lines);
    setCustomerId(entry.customerId);
    setCustomerName(entry.customerName);
    setCustomerEmail(entry.customerEmail);
    const next = parked.filter((item) => item.id !== entry.id);
    setParked(next);
    writeParked(next);
  }

  function discardParked(entry: ParkedSale) {
    const next = parked.filter((item) => item.id !== entry.id);
    setParked(next);
    writeParked(next);
  }

  // --- Payment ---------------------------------------------------------------

  async function applyCoupon() {
    const code = couponCode.trim();
    if (!code) return;
    setCouponBusy(true);
    setCouponError("");
    try {
      const response = await fetch(`/api/billing/coupons/lookup?code=${encodeURIComponent(code)}`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = (await response.json().catch(() => null)) as { coupon?: BillingCoupon; message?: string } | null;
      if (!response.ok || !data?.coupon) {
        setCouponError(data?.message || "No coupon with that code.");
        return;
      }
      // The balance shown here is a read; the SQL guard at pay time is what
      // actually stops a voucher being spent twice.
      const blocked = couponBlockedReason(data.coupon);
      if (blocked) {
        setCouponError(blocked);
        return;
      }
      setCoupon(data.coupon);
      setCouponCode("");
    } catch {
      setCouponError("Could not check that code.");
    } finally {
      setCouponBusy(false);
    }
  }

  function openPayment() {
    if (!lines.length) return;
    setError("");
    setTendered("");
    // Nothing left to tender: the sale is settled entirely by the voucher, so
    // asking which card machine to use would be a question with no answer. It
    // still lands on a payment method - the seeded "Coupon" one - so the
    // takings report has somewhere to put it.
    const couponMethod = methods.find((method) => method.name.toLowerCase() === "coupon");
    if (coupon && dueNow <= 0 && couponMethod) {
      setMethodId(couponMethod.id);
      void takePayment(couponMethod);
      setPayStage("method");
      return;
    }
    setMethodId((current) => current || methods[0]?.id || "");
    setPayStage("method");
  }

  function chooseMethod(method: PosPaymentMethod) {
    setMethodId(method.id);
    setError("");
    // Cash is the only method where the till needs to work out change, so it is
    // the only one that gets a tender step.
    if (method.kind === "custom" && /cash/i.test(method.name) && dueNow > 0) {
      setTendered("");
      setPayStage("cash");
      return;
    }
    void takePayment(method);
  }

  async function takePayment(method: PosPaymentMethod) {
    setBusy(true);
    setError("");
    try {
      const description = lines
        .map((line) => (line.quantity > 1 ? `${line.name} x${line.quantity}` : line.name))
        .join(", ")
        .slice(0, 300);

      // Reuse an already-created sale if only the Stripe step failed - pressing
      // Pay again must not mint a second receipt number.
      const response =
        sale
          ? null
          : ((await postPosJson("/api/billing/pos/transactions", {
            description,
            amount: total,
            listedAmount: total,
            couponId: coupon?.id || "",
            couponAmount,
            items: lines
              .filter((line) => line.productId)
              .map((line) => ({ productId: line.productId, quantity: line.quantity, unitPrice: line.unitPrice })),
            currency,
            paymentMethodId: method.id,
            customerId,
            customerName: customerName.trim(),
            customerEmail: customerEmail.trim(),
            source: "counter",
          })) as { transaction?: PosTransaction; issuedCoupons?: BillingCoupon[] });

      const created = sale || response?.transaction;
      if (!created) throw new Error("The sale could not be recorded.");
      if (response?.issuedCoupons?.length) setIssuedCoupons(response.issuedCoupons);
      setSale(created);
      onSaleCompleted(created);

      if (method.kind !== "clarity_pay") {
        setPayStage("done");
        return;
      }

      const checkout = (await postPosJson(
        `/api/billing/pos/transactions/${encodeURIComponent(created.id)}/checkout`,
        {},
      )) as { url?: string };
      if (!checkout.url) throw new Error("Stripe did not return a checkout link.");
      setCheckoutUrl(checkout.url);
      setPayStage("qr");
    } catch (paymentError) {
      setError(paymentError instanceof Error ? paymentError.message : "The sale could not be recorded.");
    } finally {
      setBusy(false);
    }
  }

  usePosPaymentPoll(
    payStage === "qr" ? sale?.id || "" : "",
    (paid) => {
      setSale(paid);
      setPayStage("done");
      onSaleCompleted(paid);
    },
    () => setError("Stopped checking for payment. Cancel the sale and start it again."),
  );

  // A Clarity Pay sale that never cleared has to be voided on the way out,
  // otherwise a pending row and a live Stripe session are left behind with
  // nothing watching them.
  async function cancelPendingSale() {
    if (!sale) {
      setPayStage("closed");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/billing/pos/transactions/${encodeURIComponent(sale.id)}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "void" }),
      });
      if (response.ok) {
        const data = (await response.json()) as { transaction?: PosTransaction };
        if (data.transaction) onSaleCompleted(data.transaction);
      }
      onToast(`${sale.receiptNumber} cancelled.`);
    } catch {
      onToast("Could not cancel the sale - check the POS list.");
    } finally {
      setBusy(false);
      setSale(null);
      setCheckoutUrl("");
      setPayStage("closed");
    }
  }

  const qrMarkup = useMemo(() => (checkoutUrl ? renderQrSvg(checkoutUrl) : ""), [checkoutUrl]);

  return (
    <section className="sell-screen">
      {/* --- Catalog --------------------------------------------------------- */}
      <div className="sell-catalog">
        <div className="sell-search">
          <Search size={16} />
          <input
            ref={searchRef}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search or scan"
            // A barcode scanner types the code and presses Enter. One exact SKU
            // match on Enter rings it straight up, which is the whole point of
            // having a scanner at the counter.
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              const needle = search.trim().toLowerCase();
              if (!needle) return;
              const exact = catalog.find((item) => (item.sku || "").toLowerCase() === needle);
              if (exact) addItem(exact);
              else if (tiles.length === 1) addItem(tiles[0]);
            }}
          />
          {Boolean(search) && (
            <button className="icon-button small" onClick={() => setSearch("")} type="button" aria-label="Clear search">
              <X size={14} />
            </button>
          )}
          <button className="outline-button" onClick={() => setCustomOpen((open) => !open)} type="button">
            <Plus size={15} /> Custom
          </button>
        </div>

        {customOpen && (
          <div className="sell-custom-panel">
            <label className="settings-field">
              <span>What is it</span>
              <input
                value={customName}
                onChange={(event) => setCustomName(event.target.value)}
                placeholder="e.g. Range balls"
              />
            </label>
            <label className="settings-field">
              <span>Amount ({currency})</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={customAmount}
                onChange={(event) => setCustomAmount(event.target.value)}
              />
            </label>
            <button className="outline-button" onClick={addCustom} type="button">
              Add to sale
            </button>
          </div>
        )}

        <div className="sell-tabs" role="tablist" aria-label="Catalog categories">
          {TAB_ORDER.filter(
            (key) => key === "all" || catalog.some((item) => item.kind === key && item.active !== false),
          ).map((key) => (
            <button
              key={key}
              className={tab === key ? "active" : ""}
              onClick={() => setTab(key)}
              role="tab"
              aria-selected={tab === key}
              type="button"
            >
              {TAB_LABELS[key]}
            </button>
          ))}
        </div>

        {(catalogState === "loading" || catalogState === "idle") && <p className="field-help">Loading the catalog...</p>}
        {catalogState === "error" && (
          <p className="field-help">
            Could not load the catalog.{" "}
            <button className="link-button" onClick={onReloadCatalog} type="button">
              Retry
            </button>
          </p>
        )}
        {catalogState === "loaded" && !tiles.length && (
          <p className="field-help">Nothing here. Try another category, or add items under Billing &gt; Products.</p>
        )}

        <div className="sell-grid">
          {tiles.map((item) => {
            const low = isLowStock(item);
            return (
              <button key={item.id} className="sell-tile" onClick={() => addItem(item)} type="button">
                <span className="sell-tile-name">{item.name}</span>
                <span className="sell-tile-price">{formatMoney(item.price, currency)}</span>
                {item.trackStock && (
                  <span className={`sell-tile-stock${low ? " low" : ""}`}>
                    {low && <AlertTriangle size={11} />}
                    {item.stockLevel ?? 0} left
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* --- Docket ---------------------------------------------------------- */}
      <div className="sell-docket">
        <div className="sell-docket-head">
          <h2>Current sale</h2>
          {lines.length > 0 && (
            <button className="text-link-button" onClick={resetSale} type="button">
              <Trash2 size={14} /> Discard
            </button>
          )}
        </div>

        {customerName ? (
          <div className="sell-customer-chip">
            <User size={15} />
            <span>
              <strong>{customerName}</strong>
              {customerEmail && <em>{customerEmail}</em>}
            </span>
            <button
              className="icon-button small"
              onClick={() => {
                setCustomerId("");
                setCustomerName("");
                setCustomerEmail("");
              }}
              type="button"
              aria-label="Remove customer"
            >
              <X size={13} />
            </button>
          </div>
        ) : (
          <div className="sell-customer-search">
            <Search size={15} />
            <input
              value={customerSearch}
              onChange={(event) => setCustomerSearch(event.target.value)}
              placeholder="Search customers"
            />
            {Boolean(customerSearch.trim()) && (
              <div className="sell-customer-results">
                {clientMatches.map((client) => (
                  <button
                    key={client.id}
                    className="sell-customer-match"
                    onClick={() => attachCustomer(client)}
                    type="button"
                  >
                    <strong>{client.name}</strong>
                    <em>{client.email || "no email"}</em>
                  </button>
                ))}
                {!clientMatches.length && <p className="field-help">No client by that name.</p>}
                <button
                  className="sell-customer-add"
                  disabled={customerSaving}
                  onClick={() => void addCustomer()}
                  type="button"
                >
                  <Plus size={14} />
                  {customerSaving ? "Adding..." : `Add "${customerSearch.trim()}" as a new client`}
                </button>
              </div>
            )}
          </div>
        )}

        <div className="sell-lines">
          {!lines.length && (
            <div className="sell-empty">
              <Package size={26} />
              <p>Nothing on the docket yet.</p>
              <span>Tap an item on the right, or scan a barcode into the search box.</span>
            </div>
          )}
          {lines.map((line) => (
            <div key={line.key} className="sell-line">
              <div className="sell-line-name">
                <strong>{line.name}</strong>
                <em>
                  {line.sku ? `${line.sku} - ` : ""}
                  {formatMoney(line.unitPrice, currency)} each
                </em>
              </div>
              <div className="sell-line-qty">
                <button
                  className="icon-button small"
                  onClick={() => setLines((current) => setSellQuantity(current, line.key, line.quantity - 1))}
                  type="button"
                  aria-label={`One fewer ${line.name}`}
                >
                  <Minus size={13} />
                </button>
                <b>{line.quantity}</b>
                <button
                  className="icon-button small"
                  onClick={() => setLines((current) => setSellQuantity(current, line.key, line.quantity + 1))}
                  type="button"
                  aria-label={`One more ${line.name}`}
                >
                  <Plus size={13} />
                </button>
              </div>
              <input
                className="sell-line-price"
                type="number"
                min="0"
                step="0.01"
                value={line.unitPrice}
                onChange={(event) => setLines((current) => setSellPrice(current, line.key, Number(event.target.value)))}
                aria-label={`Price for ${line.name}`}
              />
              <strong className="sell-line-total">{formatMoney(lineTotal(line), currency)}</strong>
              <button
                className="icon-button small"
                onClick={() => setLines((current) => setSellQuantity(current, line.key, 0))}
                type="button"
                aria-label={`Remove ${line.name}`}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>

        <div className="sell-totals">
          {taxIncluded > 0 && (
            <div className="sell-total-row muted">
              <span>Includes {taxName || "tax"}</span>
              <span>{formatMoney(taxIncluded, currency)}</span>
            </div>
          )}
          <div className={`sell-total-row${couponAmount > 0 ? "" : " grand"}`}>
            <span>
              Total
              {itemCount > 0 && <em> {itemCount} item{itemCount === 1 ? "" : "s"}</em>}
            </span>
            <span>{formatMoney(total, currency)}</span>
          </div>
          {couponAmount > 0 && coupon && (
            <>
              <div className="sell-total-row coupon">
                <span>
                  <Ticket size={13} /> {coupon.code}
                </span>
                <span>-{formatMoney(couponAmount, currency)}</span>
              </div>
              <div className="sell-total-row grand">
                <span>To pay</span>
                <span>{formatMoney(dueNow, currency)}</span>
              </div>
            </>
          )}
        </div>

        {coupon ? (
          <div className="sell-coupon-applied">
            <Ticket size={14} />
            <span>
              <strong>{coupon.code}</strong>
              <em>
                {formatMoney(coupon.remainingValue, coupon.currency)} on it
                {couponAmount < coupon.remainingValue
                  ? ` - ${formatMoney(coupon.remainingValue - couponAmount, coupon.currency)} left after this`
                  : ""}
              </em>
            </span>
            <button
              className="icon-button small"
              onClick={() => setCoupon(null)}
              type="button"
              aria-label="Remove coupon"
            >
              <X size={13} />
            </button>
          </div>
        ) : (
          <div className="sell-coupon-entry">
            <Ticket size={14} />
            <input
              value={couponCode}
              onChange={(event) => {
                setCouponCode(event.target.value);
                setCouponError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void applyCoupon();
              }}
              placeholder="Coupon code"
            />
            <button
              className="outline-button"
              disabled={couponBusy || !couponCode.trim()}
              onClick={() => void applyCoupon()}
              type="button"
            >
              {couponBusy ? "..." : "Apply"}
            </button>
          </div>
        )}
        {couponError && <p className="sell-coupon-error">{couponError}</p>}

        <div className="sell-actions">
          <button className="outline-button" disabled={!lines.length} onClick={parkSale} type="button">
            Park
          </button>
          <button className="sell-pay-button" disabled={!lines.length} onClick={openPayment} type="button">
            Pay {formatMoney(dueNow, currency)}
          </button>
        </div>

        {parked.length > 0 && (
          <div className="sell-parked">
            <h3>Parked ({parked.length})</h3>
            {parked.map((entry) => (
              <div key={entry.id} className="sell-parked-item">
                <button onClick={() => resumeSale(entry)} type="button">
                  <strong>{entry.label || "Parked sale"}</strong>
                  <em>
                    {entry.lines.length} line{entry.lines.length === 1 ? "" : "s"} -{" "}
                    {formatMoney(sellTotal(entry.lines), currency)}
                  </em>
                </button>
                <button
                  className="icon-button small"
                  onClick={() => discardParked(entry)}
                  type="button"
                  aria-label="Discard parked sale"
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* --- Payment --------------------------------------------------------- */}
      {payStage !== "closed" && (
        <div className="details-overlay sell-pay-overlay" role="presentation">
          <aside className="details-panel details-modal sell-pay-panel" role="dialog" aria-modal="true">
            <div className="panel-header">
              <span>Payment</span>
              {payStage !== "qr" && (
                <button
                  className="icon-button small"
                  onClick={() => (payStage === "done" ? resetSale() : setPayStage("closed"))}
                  type="button"
                  aria-label="Close payment"
                >
                  <X size={17} />
                </button>
              )}
            </div>

            {error && <p className="pos-error">{error}</p>}

            {payStage === "method" && (
              <>
                <h2 className="sell-pay-total">{formatMoney(dueNow, currency)}</h2>
                {couponAmount > 0 && coupon && (
                  <p className="field-help">
                    {formatMoney(couponAmount, currency)} covered by {coupon.code}.
                  </p>
                )}
                <p className="field-help">How is the rest being paid?</p>
                <div className="pos-method-grid">
                  {methods.map((method) => (
                    <button
                      key={method.id}
                      className="pos-method-button"
                      disabled={busy}
                      onClick={() => chooseMethod(method)}
                      type="button"
                    >
                      {method.kind === "clarity_pay" && <CreditCard size={15} />}
                      {method.name}
                      {!method.settlesImmediately && <span className="pos-method-tag">owed</span>}
                    </button>
                  ))}
                </div>
                {!methods.length && <p className="field-help">No payment methods - add one under Billing &gt; Settings.</p>}
              </>
            )}

            {payStage === "cash" && (
              <>
                <h2 className="sell-pay-total">{formatMoney(dueNow, currency)}</h2>
                <div className="settings-field">
                  <label htmlFor="sell-tendered">Cash received</label>
                  <input
                    id="sell-tendered"
                    className="sell-tendered"
                    type="number"
                    min="0"
                    step="0.01"
                    value={tendered}
                    onChange={(event) => setTendered(event.target.value)}
                    autoFocus
                  />
                </div>
                <div className="sell-cash-suggestions">
                  {cashSuggestions(dueNow).map((value) => (
                    <button key={value} onClick={() => setTendered(String(value))} type="button">
                      {formatMoney(value, currency)}
                    </button>
                  ))}
                </div>
                <div className={`sell-change${change < 0 ? " short" : ""}`}>
                  <span>{change < 0 ? "Still to pay" : "Change"}</span>
                  <strong>{formatMoney(Math.abs(change), currency)}</strong>
                </div>
                <div className="panel-actions">
                  <button className="outline-button" onClick={() => setPayStage("method")} type="button">
                    Back
                  </button>
                  <button
                    className="primary-button"
                    disabled={busy || !selectedMethod || tendered === "" || change < 0}
                    onClick={() => selectedMethod && void takePayment(selectedMethod)}
                    type="button"
                  >
                    {busy ? "Working..." : "Complete sale"}
                  </button>
                </div>
              </>
            )}

            {payStage === "qr" && sale && (
              <>
                <h2 className="sell-pay-total">{formatMoney(sale.amount, sale.currency)}</h2>
                <p className="field-help">
                  Customer scans this and pays with Apple Pay, Google Pay or a card. This screen updates on its own the
                  moment it clears.
                </p>
                {qrMarkup && (
                  <div className="pos-qr" aria-label="Payment QR code" dangerouslySetInnerHTML={{ __html: qrMarkup }} />
                )}
                <div className="panel-actions">
                  <button className="outline-button" disabled={busy} onClick={() => void cancelPendingSale()} type="button">
                    Cancel sale
                  </button>
                  <a className="outline-button" href={checkoutUrl} target="_blank" rel="noreferrer noopener">
                    <ExternalLink size={15} /> Pay on this device
                  </a>
                </div>
              </>
            )}

            {payStage === "done" && sale && (
              <>
                <div className="pos-done">
                  <Check size={22} />
                  <div>
                    <strong>{formatMoney(sale.amount, sale.currency)}</strong>
                    <span>
                      {sale.paymentMethodName} - {sale.receiptNumber}
                    </span>
                  </div>
                </div>
                {tendered !== "" && change > 0 && (
                  <div className="sell-change">
                    <span>Change</span>
                    <strong>{formatMoney(change, currency)}</strong>
                  </div>
                )}
                {issuedCoupons.length > 0 && (
                  <div className="sell-issued-coupons">
                    <strong>
                      {issuedCoupons.length === 1 ? "Voucher code" : "Voucher codes"}
                    </strong>
                    {issuedCoupons.map((issued) => (
                      <span key={issued.id}>
                        {issued.code} - {formatMoney(issued.originalValue, issued.currency)}
                      </span>
                    ))}
                    <em>Write these on the card before it goes out the door.</em>
                  </div>
                )}
                {sale.status === "pending" && (
                  <p className="field-help">
                    Recorded as owed on {sale.paymentMethodName}. Mark it paid from Billing &gt; POS Transactions once it
                    is settled.
                  </p>
                )}
                <div className="panel-actions">
                  <button className="primary-button" onClick={resetSale} type="button">
                    New sale
                  </button>
                </div>
              </>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
