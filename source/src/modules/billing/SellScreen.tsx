import { Loading } from "../shared/Loading";
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

import { createElement, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  ExternalLink,
  Minus,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  ClarityCalendar,
  ClarityPassesCredits,
  ClarityPayments,
  ClarityProducts,
  ClarityProfile,
  ClarityServices,
  ClarityStore,
  type IconComponent,
} from "../shared/ClarityIcons";
import { usePhoneLayout } from "../phone/phoneLayout";
import { PhoneStepSwipe } from "../phone/PhoneStepSwipe";
import type { BillingCatalogItem, BillingCatalogKind, BillingCoupon, PosPaymentMethod, PosTransaction } from "./types";
import { couponApplyAmount, remainingAfterCoupon } from "./couponMath";
import { CouponPicker, useSpendableCoupons } from "./CouponPicker";
import { ReceiptEmailPrompt } from "./ReceiptEmailPrompt";
import { tillLessonGroups, tillLessonIsUpcoming, tillLessonWhen } from "./tillLessons";
import type { TillLesson } from "./tillLessons";
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
import { catalogTiles, offTabMatchCount } from "./catalogSearch";
import type { SellLine } from "./stockMath";
import { postPosJson, renderQrSvg, usePosPaymentPoll } from "./posCheckoutPoll";
import { TerminalPayment } from "./TerminalPayment";
import { tapToPayName, tenderLabel, useTapToPay, type PosTender, type TapState } from "./terminal";
import { t, tn } from "../../lib/i18n";

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
  // Lessons with no payment on record, past and upcoming. Built by App, which
  // holds the calendar and the paid/invoiced maps; searched here by name.
  lessons: TillLesson[];
  // Opens the client's profile over the till. Closing it lands back here with
  // the sale untouched, because the till never unmounts.
  onOpenClientProfile: (clientId: string) => void;
  // A receipt emailed to an address the client did not have yet saved it to
  // their profile; App updates its copy so the till and the list agree.
  onClientEmailSaved: (clientId: string, email: string) => void;
  // On a phone the current sale is a page of its own over the catalogue. App
  // holds which one is showing, because its topbar Back and the swipe step
  // between them.
  phoneSaleOpen: boolean;
  onPhoneSaleOpenChange: (open: boolean) => void;
};

type TabKey = "all" | BillingCatalogKind;

const TABS: Record<TabKey, { label: string; Icon: IconComponent }> = {
  all: { label: t("All"), Icon: ClarityStore },
  product: { label: t("Products"), Icon: ClarityProducts },
  service: { label: t("Services"), Icon: ClarityServices },
  package: { label: t("Packages"), Icon: ClarityPassesCredits },
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
  // A voucher held against the sale is parked with it. Only held, never spent:
  // nothing comes off a voucher until the sale is recorded, so a parked sale
  // cannot be sitting on anyone's money.
  coupon?: BillingCoupon | null;
  couponApplied?: boolean;
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
  lessons,
  onOpenClientProfile,
  onClientEmailSaved,
  phoneSaleOpen,
  onPhoneSaleOpenChange,
}: SellScreenProps) {
  const phoneLayout = usePhoneLayout();
  const payPanelRef = useRef<HTMLElement>(null);
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

  // A voucher held against this sale. Held is all it is until "Pay with
  // coupon" is pressed: then either it covers everything and the sale is done,
  // or it is put down as paid credit (couponApplied) and the rest is taken on a
  // normal method. Its value only comes off the voucher when the sale is
  // recorded, in the same request -- which is why this lives outside payStage.
  const [coupon, setCoupon] = useState<BillingCoupon | null>(null);
  const [couponApplied, setCouponApplied] = useState(false);
  const couponBook = useSpendableCoupons();

  // Folded client groups the coach has opened in the lesson results.
  const [openLessonGroups, setOpenLessonGroups] = useState<string[]>([]);

  // Payment overlay. "closed" -> "method" -> ("coupon" to confirm a part
  // payment, "cash" for tendering) -> ("tap" in the staff app, else
  // "qr") -> "done".
  const [payStage, setPayStage] = useState<"closed" | "method" | "coupon" | "cash" | "tap" | "qr" | "done">("closed");
  const tapToPay = useTapToPay();
  const [tenders, setTenders] = useState<PosTender[]>([]);
  const [methodId, setMethodId] = useState("");
  const [tendered, setTendered] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sale, setSale] = useState<PosTransaction | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState("");
  // Codes minted by this sale (a voucher product was rung up). Read out on the
  // done screen so they can be written on the card before it leaves.
  const [issuedCoupons, setIssuedCoupons] = useState<BillingCoupon[]>([]);
  const [issuedPasses, setIssuedPasses] = useState<string[]>([]);

  const searchRef = useRef<HTMLInputElement | null>(null);

  const total = sellTotal(lines);
  const taxIncluded = sellTaxIncluded(lines);
  const itemCount = lines.reduce((count, line) => count + line.quantity, 0);
  const selectedMethod = methods.find((method) => method.id === methodId) || null;
  // Capped by the balance and by the sale: a $100 voucher against a $40 sale
  // spends $40 and keeps $60, it does not hand out change.
  const couponAmount = coupon ? couponApplyAmount(coupon, total) : 0;
  const couponCovers = Boolean(coupon) && couponAmount > 0 && couponAmount >= total;
  // Only credit that has been put down counts against what is owed. A held
  // voucher is shown, not subtracted.
  const appliedCoupon = couponApplied ? couponAmount : 0;
  const dueNow = remainingAfterCoupon(total, appliedCoupon);
  const couponMethod = methods.find((method) => method.kind === "coupon") || null;
  // The grid is for money. Coupon has its own button, and Pass settles a
  // booked lesson from the checkout modal, not a walk-up docket.
  const payMethods = methods.filter((method) => method.kind !== "coupon" && method.kind !== "pass");
  const bookingIds = lines.map((line) => line.bookingId || "").filter(Boolean);
  const clientNames = useMemo(() => new Map(clients.map((client) => [client.id, client.name])), [clients]);
  const lessonGroups = useMemo(
    () => tillLessonGroups(lessons, search, new Set(bookingIds)),
    // bookingIds is derived from lines; keyed on its contents, not its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lessons, search, bookingIds.join(",")],
  );
  // Credits land on a profile. With nobody attached there is no profile, and
  // the server skips issuing rather than fail a sale -- so the till asks first.
  const needsCustomerForPackage = !customerId && lines.some((line) => line.kind === "package");
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

  // The rule lives in catalogSearch.ts so it can be tested as a rule: a coach
  // searching for something that exists and being shown an empty shelf is
  // exactly the sort of thing that should fail a test rather than a sale.
  const tiles = useMemo(() => catalogTiles(catalog, tab, search), [catalog, tab, search]);
  const offTabMatches = useMemo(() => offTabMatchCount(tiles, tab, search), [tiles, tab, search]);

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
    setIssuedPasses([]);
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
    setCouponApplied(false);
    setIssuedCoupons([]);
    setTenders([]);
    setPayStage("closed");
    // A new sale starts at the catalogue on a phone.
    onPhoneSaleOpenChange(false);
    searchRef.current?.focus();
  }

  function addItem(item: BillingCatalogItem) {
    setLines((current) => addSellLine(current, item));
    setSearch("");
    searchRef.current?.focus();
  }

  // A lesson goes on as its own line, tied to its booking, so paying the sale
  // is what marks that lesson paid. Rung up against its lesson type when that
  // type is still in the catalog; as plain money when it is not, so a retired
  // lesson type never makes an old lesson impossible to settle.
  function addLesson(lesson: TillLesson) {
    if (lines.some((line) => line.bookingId === lesson.bookingId)) return;
    const inCatalog = Boolean(lesson.catalogItemId) && catalog.some((item) => item.id === lesson.catalogItemId);
    setLines((current) => [
      ...current,
      {
        key: `booking:${lesson.bookingId}`,
        productId: inCatalog ? lesson.catalogItemId : "",
        name: lesson.serviceName || "Lesson",
        detail: tillLessonWhen(lesson.startsAt),
        sku: "",
        kind: "service",
        quantity: 1,
        unitPrice: lesson.price,
        taxRate: defaultTaxRate,
        bookingId: lesson.bookingId,
      },
    ]);
    // Paying for someone's lesson is paying as them, unless the coach has
    // already said who is paying.
    if (!customerName && lesson.personId) {
      setCustomerId(lesson.personId);
      setCustomerName(lesson.clientName);
      setCustomerEmail(lesson.clientEmail);
      setCustomerSearch("");
    }
  }

  function toggleLessonGroup(key: string) {
    setOpenLessonGroups((current) =>
      current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key],
    );
  }

  function addCustom() {
    const amount = Number(customAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      onToast(t("Enter an amount for the custom item."));
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
      coupon,
      couponApplied,
    };
    const next = [entry, ...parked].slice(0, 12);
    setParked(next);
    writeParked(next);
    resetSale();
    onToast(t("Sale parked."));
  }

  function resumeSale(entry: ParkedSale) {
    // Anything already on screen would be silently thrown away, so it gets
    // parked first rather than lost.
    if (lines.length) parkSale();
    setLines(entry.lines);
    setCustomerId(entry.customerId);
    setCustomerName(entry.customerName);
    setCustomerEmail(entry.customerEmail);
    // The held voucher comes back as held. Whether it is still spendable is
    // settled by the server at pay time; the balance may have moved since.
    setCoupon(entry.coupon || null);
    setCouponApplied(Boolean(entry.coupon && entry.couponApplied));
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

  function openPayment() {
    if (!lines.length) return;
    if (needsCustomerForPackage) {
      onToast(t("Add the customer first - a package puts credits on their profile."));
      return;
    }
    setError("");
    setTendered("");
    setMethodId((current) => current || payMethods[0]?.id || "");
    setPayStage("method");
  }

  // "Pay with coupon". Enough on it: the sale is recorded on the Coupon method
  // and is done. Not enough: ask, then put what it has down as paid credit and
  // let the coach choose how the rest is paid.
  function payWithCoupon() {
    if (!coupon || couponAmount <= 0) return;
    setError("");
    if (couponCovers) {
      if (!couponMethod) {
        setError(t("This account has no Coupon payment method yet. Close this and press Pay again."));
        return;
      }
      setMethodId(couponMethod.id);
      void takePayment(couponMethod);
      return;
    }
    setPayStage("coupon");
  }

  function confirmCouponCredit() {
    setCouponApplied(true);
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
        .map((line) => {
          const label = line.detail ? `${line.name} (${line.detail})` : line.name;
          return line.quantity > 1 ? `${label} x${line.quantity}` : label;
        })
        .join(", ")
        .slice(0, 300);
      // The voucher is only spent when it was chosen to be: as the whole
      // payment, or as credit put down before the rest.
      const spendCoupon = Boolean(coupon) && (method.kind === "coupon" || couponApplied);

      // Reuse an already-created sale if only the Stripe step failed - pressing
      // Pay again must not mint a second receipt number.
      const response =
        sale
          ? null
          : ((await postPosJson("/api/billing/pos/transactions", {
            description,
            amount: total,
            listedAmount: total,
            couponId: spendCoupon ? coupon?.id || "" : "",
            couponAmount: spendCoupon ? couponAmount : 0,
            bookingIds,
            items: lines
              .filter((line) => line.productId)
              .map((line) => ({ productId: line.productId, quantity: line.quantity, unitPrice: line.unitPrice })),
            currency,
            paymentMethodId: method.id,
            customerId,
            customerName: customerName.trim(),
            customerEmail: customerEmail.trim(),
            source: "counter",
          })) as {
            transaction?: PosTransaction;
            issuedCoupons?: BillingCoupon[];
            issuedPasses?: string[];
          });

      const created = sale || response?.transaction;
      if (!created) throw new Error(t("The sale could not be recorded."));
      if (response?.issuedCoupons?.length) setIssuedCoupons(response.issuedCoupons);
      // Selling a package puts credits under the customer's name without anyone
      // asking for it. Saying so is the difference between that feeling
      // automatic and feeling like nothing happened.
      if (response?.issuedPasses?.length) setIssuedPasses(response.issuedPasses);
      setSale(created);
      onSaleCompleted(created);
      // Balances moved; the next search should see them.
      if (spendCoupon) couponBook.reload();

      if (method.kind !== "clarity_pay") {
        setPayStage("done");
        return;
      }
      if (tapToPay.ready) {
        setPayStage("tap");
        return;
      }
      await showQr(created);
    } catch (paymentError) {
      setError(paymentError instanceof Error ? paymentError.message : t("The sale could not be recorded."));
    } finally {
      setBusy(false);
    }
  }

  // The QR for a pending Clarity Pay sale, and the way out of Tap to Pay: the
  // server stands the tap down first, so the customer can only pay one way.
  async function showQr(pending: PosTransaction) {
    const checkout = (await postPosJson(
      `/api/billing/pos/transactions/${encodeURIComponent(pending.id)}/checkout`,
      {},
    )) as { url?: string };
    if (!checkout.url) throw new Error(t("Stripe did not return a checkout link."));
    setCheckoutUrl(checkout.url);
    setPayStage("qr");
  }

  async function switchToQr() {
    if (!sale) return;
    setBusy(true);
    setError("");
    try {
      await showQr(sale);
    } catch (qrError) {
      setError(qrError instanceof Error ? qrError.message : t("Could not show the QR."));
    } finally {
      setBusy(false);
    }
  }

  function tapPaid(paid: Extract<TapState, { kind: "succeeded" }>) {
    setSale(paid.transaction);
    setTenders(paid.tenders);
    if (paid.issuedPasses.length) setIssuedPasses(paid.issuedPasses);
    setPayStage("done");
    onSaleCompleted(paid.transaction);
  }

  usePosPaymentPoll(
    payStage === "qr" ? sale?.id || "" : "",
    (paid) => {
      setSale(paid);
      setPayStage("done");
      onSaleCompleted(paid);
    },
    () => setError(t("Stopped checking for payment. Cancel the sale and start it again.")),
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
      const data = (await response.json().catch(() => null)) as { transaction?: PosTransaction; message?: string } | null;
      if (!response.ok) {
        // Refused because a card is paying for it right now, or just did.
        // Stay on the payment so the coach sees how it ends.
        setError(data?.message || t("Could not cancel the sale."));
        setBusy(false);
        return;
      }
      if (data?.transaction) onSaleCompleted(data.transaction);
      onToast(`${sale.receiptNumber} cancelled.`);
      // Voiding puts any voucher value back; show the restored balance.
      if (sale.couponId) couponBook.reload();
    } catch {
      onToast(t("Could not cancel the sale - check the POS list."));
    }
    setBusy(false);
    setSale(null);
    setCheckoutUrl("");
    setPayStage("closed");
  }

  // The payment's steps on a phone, for its Back arrow and swipe: a cash or
  // coupon step goes back to choosing how to pay, which goes back to the sale.
  // Card and QR are in flight and have their own way out; a finished sale's
  // Back is Done.
  const payBackStep =
    payStage === "cash" || payStage === "coupon"
      ? { label: "", go: () => setPayStage("method") }
      : payStage === "method"
        ? { label: "", go: () => setPayStage("closed") }
        : payStage === "done"
          ? { label: "", go: resetSale }
          : null;

  const qrMarkup = useMemo(() => (checkoutUrl ? renderQrSvg(checkoutUrl) : ""), [checkoutUrl]);

  return (
    <section className={`sell-screen${phoneSaleOpen ? " is-phone-sale" : ""}`}>
      {/* --- Catalog --------------------------------------------------------- */}
      <div className="sell-catalog">
        <div className="sell-search">
          <Search size={16} />
          <input
            ref={searchRef}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("Search or scan")}
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
            <button className="icon-button small" onClick={() => setSearch("")} type="button" aria-label={t("Clear search")}>
              <X size={14} />
            </button>
          )}
          <button className="outline-button" onClick={() => setCustomOpen((open) => !open)} type="button">
            <Plus size={15} />{" "}{t("Custom")}</button>
        </div>

        {customOpen && (
          <div className="sell-custom-panel">
            <label className="settings-field">
              <span>{t("What is it")}</span>
              <input
                value={customName}
                onChange={(event) => setCustomName(event.target.value)}
                placeholder={t("e.g. Range balls")}
              />
            </label>
            <label className="settings-field">
              <span>{t("Amount ({currency})", { currency })}</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={customAmount}
                onChange={(event) => setCustomAmount(event.target.value)}
              />
            </label>
            <button className="outline-button" onClick={addCustom} type="button">{t("Add to sale")}</button>
          </div>
        )}

        <div className="sell-tabs" role="tablist" aria-label={t("Catalog categories")}>
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
              {createElement(TABS[key].Icon, { size: 14 })}
              {TABS[key].label}
            </button>
          ))}
        </div>

        {(catalogState === "loading" || catalogState === "idle") && <Loading what={t("the catalog")} className="field-help" />}
        {catalogState === "error" && (
          <p className="field-help">{t("Could not load the catalog.")}{" "}<button className="link-button" onClick={onReloadCatalog} type="button">{t("Retry")}</button>
          </p>
        )}
        {catalogState === "loaded" && offTabMatches > 0 && (
          <p className="field-help">
            {offTabMatches === 1
              ? t("1 match from another category is shown below.")
              : t("{offTabMatches} matches from other categories are shown below.", { offTabMatches })}
          </p>
        )}
        {catalogState === "loaded" && !tiles.length && !lessonGroups.length && (
          <p className="field-help">{t("Nothing here. Try another category, or add items under Billing > Products > New Product.")}</p>
        )}

        {lessonGroups.length > 0 && (
          <div className="sell-lessons" aria-label={t("Unpaid lessons")}>
            <h3>
              <ClarityCalendar size={14} />{" "}{t("Lessons with no payment recorded")}</h3>
            {lessonGroups.map((group) => {
              const open = !group.collapsed || openLessonGroups.includes(group.key);
              const groupTotal = group.lessons.reduce((sum, lesson) => sum + lesson.price, 0);
              return (
                <div key={group.key} className="sell-lesson-group">
                  {group.collapsed && (
                    <div className="sell-lesson-group-head">
                      <button
                        className="sell-lesson-group-toggle"
                        onClick={() => toggleLessonGroup(group.key)}
                        aria-expanded={open}
                        type="button"
                      >
                        <ChevronDown size={15} className={open ? "open" : ""} />
                        <strong>{group.clientName}</strong>
                        <em>{t("{length} lessons - {groupTotal}", { length: group.lessons.length, groupTotal: formatMoney(groupTotal, currency) })}</em>
                      </button>
                      <button
                        className="outline-button"
                        onClick={() => group.lessons.forEach((lesson) => addLesson(lesson))}
                        type="button"
                      >{t("Add all")}</button>
                    </div>
                  )}
                  {open &&
                    group.lessons.map((lesson) => (
                      <button
                        key={lesson.bookingId}
                        className="sell-lesson"
                        onClick={() => addLesson(lesson)}
                        type="button"
                      >
                        <span>
                          <strong>
                            {group.collapsed ? lesson.serviceName : `${lesson.clientName} - ${lesson.serviceName}`}
                          </strong>
                          <em>
                            {tillLessonWhen(lesson.startsAt)}
                            {tillLessonIsUpcoming(lesson.startsAt) ? t(" - upcoming") : ""}
                            {lesson.ownerLabel ? ` - booked in ${lesson.ownerLabel}` : ""}
                          </em>
                        </span>
                        <b>{formatMoney(lesson.price, currency)}</b>
                      </button>
                    ))}
                </div>
              );
            })}
          </div>
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
                    {item.stockLevel ?? 0}{" "}{t("left")}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* --- Docket ---------------------------------------------------------- */}
      <div className="sell-docket">
        <div className="sell-docket-head">
          <h2>{t("Current sale")}</h2>
          {lines.length > 0 && (
            <button className="text-link-button" onClick={resetSale} type="button">
              <Trash2 size={14} />{" "}{t("Discard")}</button>
          )}
        </div>

        {customerName ? (
          <div className="sell-customer-chip">
            <ClarityProfile size={15} />
            {customerId && !customerId.startsWith("appointment-") ? (
              <button
                className="sell-customer-open"
                onClick={() => onOpenClientProfile(customerId)}
                type="button"
                title={t("Open their profile")}
              >
                <strong>{customerName}</strong>
                {customerEmail && <em>{customerEmail}</em>}
              </button>
            ) : (
              <span>
                <strong>{customerName}</strong>
                {customerEmail && <em>{customerEmail}</em>}
              </span>
            )}
            <button
              className="icon-button small"
              onClick={() => {
                setCustomerId("");
                setCustomerName("");
                setCustomerEmail("");
              }}
              type="button"
              aria-label={t("Remove customer")}
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
              placeholder={t("Search customers")}
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
                {!clientMatches.length && <p className="field-help">{t("No client by that name.")}</p>}
                <button
                  className="sell-customer-add"
                  disabled={customerSaving}
                  onClick={() => void addCustomer()}
                  type="button"
                >
                  <Plus size={14} />
                  {customerSaving ? t("Adding...") : t("Add \"{customerSearch}\" as a new client", { customerSearch: customerSearch.trim() })}
                </button>
              </div>
            )}
          </div>
        )}

        <div className="sell-lines">
          {!lines.length && (
            <div className="sell-empty">
              <ClarityProducts size={26} />
              <p>{t("Nothing on the docket yet.")}</p>
              <span>{t("Tap an item on the right, or scan a barcode into the search box.")}</span>
            </div>
          )}
          {lines.map((line) => (
            <div key={line.key} className="sell-line">
              <div className="sell-line-name">
                <strong>{line.name}</strong>
                <em>
                  {line.detail
                    ? line.detail
                    : `${line.sku ? `${line.sku} - ` : ""}${formatMoney(line.unitPrice, currency)} each`}
                </em>
              </div>
              {line.bookingId ? (
                <div className="sell-line-qty">
                  <b>1</b>
                </div>
              ) : (
              <div className="sell-line-qty">
                <button
                  className="icon-button small"
                  onClick={() => setLines((current) => setSellQuantity(current, line.key, line.quantity - 1))}
                  type="button"
                  aria-label={t("One fewer {name}", { name: line.name })}
                >
                  <Minus size={13} />
                </button>
                <b>{line.quantity}</b>
                <button
                  className="icon-button small"
                  onClick={() => setLines((current) => setSellQuantity(current, line.key, line.quantity + 1))}
                  type="button"
                  aria-label={t("One more {name}", { name: line.name })}
                >
                  <Plus size={13} />
                </button>
              </div>
              )}
              <input
                className="sell-line-price"
                type="number"
                min="0"
                step="0.01"
                value={line.unitPrice}
                onChange={(event) => setLines((current) => setSellPrice(current, line.key, Number(event.target.value)))}
                aria-label={t("Price for {name}", { name: line.name })}
              />
              <strong className="sell-line-total">{formatMoney(lineTotal(line), currency)}</strong>
              <button
                className="icon-button small"
                onClick={() => setLines((current) => setSellQuantity(current, line.key, 0))}
                type="button"
                aria-label={t("Remove {name}", { name: line.name })}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>

        <div className="sell-totals">
          {taxIncluded > 0 && (
            <div className="sell-total-row muted">
              <span>{t("Includes")}{" "}{taxName || "tax"}</span>
              <span>{formatMoney(taxIncluded, currency)}</span>
            </div>
          )}
          <div className={`sell-total-row${appliedCoupon > 0 ? "" : " grand"}`}>
            <span>{t("Total")}{itemCount > 0 && <em>{" "}{tn(itemCount, "{count} item", "{count} items")}</em>}
            </span>
            <span>{formatMoney(total, currency)}</span>
          </div>
          {appliedCoupon > 0 && coupon && (
            <>
              <div className="sell-total-row coupon">
                <span>
                  <ClarityPassesCredits size={13} />{" "}{t("Paid by coupon {code}", { code: coupon.code })}</span>
                <span>-{formatMoney(appliedCoupon, currency)}</span>
              </div>
              <div className="sell-total-row grand">
                <span>{t("To pay")}</span>
                <span>{formatMoney(dueNow, currency)}</span>
              </div>
            </>
          )}
        </div>

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
          }}
          onRelease={() => {
            setCoupon(null);
            setCouponApplied(false);
          }}
        />
        {needsCustomerForPackage && (
          <p className="field-help">{t("A package puts credits on a profile - add the customer before taking payment.")}</p>
        )}

        <div className="sell-actions">
          <button
            className="outline-button"
            disabled={!lines.length}
            onClick={parkSale}
            type="button"
            title={t("Put this sale aside and start another. It waits under Parked on this device.")}
          >{t("Park sale")}</button>
          <button className="sell-pay-button" disabled={!lines.length} onClick={openPayment} type="button">{t("Pay {dueNow}", { dueNow: formatMoney(dueNow, currency) })}</button>
        </div>

        {parked.length > 0 && (
          <div className="sell-parked">
            <h3>{t("Parked ({length})", { length: parked.length })}</h3>
            {parked.map((entry) => (
              <div key={entry.id} className="sell-parked-item">
                <button onClick={() => resumeSale(entry)} type="button">
                  <strong>{entry.label || t("Parked sale")}</strong>
                  <em>{tn(entry.lines.length, "{count} line", "{count} lines")} -{" "}
                    {formatMoney(sellTotal(entry.lines), currency)}
                  </em>
                </button>
                <button
                  className="icon-button small"
                  onClick={() => discardParked(entry)}
                  type="button"
                  aria-label={t("Discard parked sale")}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Phone only (hidden by the stylesheet everywhere else): on the
          catalogue page, the sale so far and Pay, above the tab bar. Tapping
          the sale opens it as its own page; Back or a swipe right returns. */}
      {!phoneSaleOpen && (
        <div className="sell-phone-bar">
          <button className="sell-phone-bar-sale" onClick={() => onPhoneSaleOpenChange(true)} type="button">
            <strong>{t("Current sale")}</strong>
            <span>{tn(itemCount, "{count} item", "{count} items")}</span>
          </button>
          <button className="sell-pay-button" disabled={!lines.length} onClick={openPayment} type="button">{t("Pay {dueNow}", { dueNow: formatMoney(dueNow, currency) })}</button>
        </div>
      )}

      {/* --- Payment --------------------------------------------------------- */}
      {payStage !== "closed" && (
        <div className="details-overlay sell-pay-overlay" role="presentation">
          {phoneLayout && payBackStep ? (
            <PhoneStepSwipe panelRef={payPanelRef} back={payBackStep} forward={null} paper={false} />
          ) : null}
          <aside className="details-panel details-modal sell-pay-panel" role="dialog" aria-modal="true" ref={payPanelRef}>
            <div className="panel-header">
              {phoneLayout && payBackStep ? (
                <button type="button" className="phone-back-button" onClick={payBackStep.go} aria-label={t("Back")}>
                  <ArrowLeft size={22} />
                </button>
              ) : null}
              <span>{t("Payment")}</span>
              {!phoneLayout && payStage !== "qr" && payStage !== "tap" && (
                <button
                  className="icon-button small"
                  onClick={() => (payStage === "done" ? resetSale() : setPayStage("closed"))}
                  type="button"
                  aria-label={t("Close payment")}
                >
                  <X size={17} />
                </button>
              )}
            </div>

            {error && <p className="pos-error">{error}</p>}

            {payStage === "method" && (
              <>
                <h2 className="sell-pay-total">{formatMoney(dueNow, currency)}</h2>
                {appliedCoupon > 0 && coupon && (
                  <div className="sell-coupon-paid">
                    <Check size={15} />
                    <span>{t("{appliedCoupon} paid by coupon {code}", { appliedCoupon: formatMoney(appliedCoupon, currency), code: coupon.code })}</span>
                    <button
                      className="text-link-button"
                      disabled={busy}
                      onClick={() => setCouponApplied(false)}
                      type="button"
                    >{t("Undo")}</button>
                  </div>
                )}
                {coupon && !couponApplied && couponAmount > 0 && (
                  <button className="sell-coupon-pay" disabled={busy} onClick={payWithCoupon} type="button">
                    <ClarityPassesCredits size={16} />
                    <span>
                      <strong>{t("Pay with coupon")}</strong>
                      <em>{t("{code} - {remainingValue} available", { code: coupon.code, remainingValue: formatMoney(coupon.remainingValue, coupon.currency) })}{couponCovers ? "" : t(" (covers {couponAmount})", { couponAmount: formatMoney(couponAmount, currency) })}
                      </em>
                    </span>
                  </button>
                )}
                <p className="field-help">
                  {appliedCoupon > 0 ? t("How is the rest being paid?") : t("How is it being paid?")}
                </p>
                <div className="pos-method-grid">
                  {payMethods.map((method) => (
                    <button
                      key={method.id}
                      className="pos-method-button"
                      disabled={busy}
                      onClick={() => chooseMethod(method)}
                      type="button"
                    >
                      {method.kind === "clarity_pay" && <ClarityPayments size={15} />}
                      {method.name}
                      {!method.settlesImmediately && <span className="pos-method-tag">{t("owed")}</span>}
                    </button>
                  ))}
                </div>
                {!payMethods.length && <p className="field-help">{t("No payment methods - add one under Billing > Settings.")}</p>}
              </>
            )}

            {payStage === "coupon" && coupon && (
              <>
                <h2 className="sell-pay-total">{formatMoney(couponAmount, currency)}</h2>
                <p>{t("{code} has {remainingValue} on it, which covers {couponAmount} of this {total} sale.", { code: coupon.code, remainingValue: formatMoney(coupon.remainingValue, coupon.currency), couponAmount: formatMoney(couponAmount, currency), total: formatMoney(total, currency) })}</p>
                <p className="field-help">{t("Put it down as paid credit and choose how the remaining {value} is paid. The voucher is charged when the sale is completed, so backing out leaves it untouched.", { value: formatMoney(total - couponAmount, currency) })}</p>
                <div className="panel-actions">
                  <button className="outline-button" onClick={() => setPayStage("method")} type="button">{t("Back")}</button>
                  <button className="primary-button" onClick={confirmCouponCredit} type="button">{t("Use {couponAmount} credit", { couponAmount: formatMoney(couponAmount, currency) })}</button>
                </div>
              </>
            )}

            {payStage === "cash" && (
              <>
                <h2 className="sell-pay-total">{formatMoney(dueNow, currency)}</h2>
                <div className="settings-field">
                  <label htmlFor="sell-tendered">{t("Cash received")}</label>
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
                  <span>{change < 0 ? t("Still to pay") : t("Change")}</span>
                  <strong>{formatMoney(Math.abs(change), currency)}</strong>
                </div>
                <div className="panel-actions">
                  <button className="outline-button" onClick={() => setPayStage("method")} type="button">{t("Back")}</button>
                  <button
                    className="primary-button"
                    disabled={busy || !selectedMethod || tendered === "" || change < 0}
                    onClick={() => selectedMethod && void takePayment(selectedMethod)}
                    type="button"
                  >
                    {busy ? t("Working...") : t("Complete sale")}
                  </button>
                </div>
              </>
            )}

            {payStage === "tap" && sale && tapToPay.ready && (
              <TerminalPayment
                transactionId={sale.id}
                amount={remainingAfterCoupon(sale.amount, sale.couponAmount ?? 0)}
                currency={sale.currency}
                status={tapToPay.status}
                formatMoney={formatMoney}
                onPaid={tapPaid}
                onShowQr={switchToQr}
                onCancelSale={() => void cancelPendingSale()}
              />
            )}

            {payStage === "qr" && sale && (
              <>
                {/* What the QR charges: the voucher's slice is already paid. */}
                <h2 className="sell-pay-total">
                  {formatMoney(remainingAfterCoupon(sale.amount, sale.couponAmount ?? 0), sale.currency)}
                </h2>
                <p className="field-help">{t("Customer scans this and pays with Apple Pay, Google Pay or a card. This screen updates on its own the moment it clears.")}</p>
                {qrMarkup && (
                  <div className="pos-qr" aria-label={t("Payment QR code")} dangerouslySetInnerHTML={{ __html: qrMarkup }} />
                )}
                <div className="panel-actions">
                  <button className="outline-button" disabled={busy} onClick={() => void cancelPendingSale()} type="button">{t("Cancel sale")}</button>
                  <a className="outline-button" href={checkoutUrl} target="_blank" rel="noreferrer noopener">
                    <ExternalLink size={15} />{" "}{t("Pay on this device")}</a>
                  {tapToPay.ready && (
                    <button className="outline-button" disabled={busy} onClick={() => setPayStage("tap")} type="button">{tapToPayName()}</button>
                  )}
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
                {tenders.length > 0 ? (
                  <ul className="pos-tenders">
                    {tenders.map((tender) => (
                      <li key={`${tender.kind}-${tender.channel}`}>
                        <span>{tenderLabel(tender)}</span>
                        <span>{formatMoney(tender.amount, tender.currency || sale.currency)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  (sale.couponAmount ?? 0) > 0 && (
                    <p className="field-help">{t("{value} of it paid by coupon", { value: formatMoney(sale.couponAmount ?? 0, sale.currency) })}{coupon ? ` ${coupon.code}` : ""}.
                    </p>
                  )
                )}
                {tendered !== "" && change > 0 && (
                  <div className="sell-change">
                    <span>{t("Change")}</span>
                    <strong>{formatMoney(change, currency)}</strong>
                  </div>
                )}
                {issuedCoupons.length > 0 && (
                  <div className="sell-issued-coupons">
                    <strong>
                      {issuedCoupons.length === 1 ? t("Voucher code") : t("Voucher codes")}
                    </strong>
                    {issuedCoupons.map((issued) => (
                      <span key={issued.id}>
                        {issued.code} - {formatMoney(issued.originalValue, issued.currency)}
                      </span>
                    ))}
                    <em>{t("Write these on the card before it goes out the door.")}</em>
                  </div>
                )}
                {issuedPasses.length > 0 && (
                  <p className="field-help">
                    {issuedPasses.length === 1
                      ? t("{issuedPasses} is now on their profile.", { issuedPasses: issuedPasses[0] })
                      : t("{issuedPasses} are now on their profile.", { issuedPasses: issuedPasses.join(", ") })}
                  </p>
                )}
                {sale.status === "pending" && (
                  <p className="field-help">{t("Recorded as owed on {paymentMethodName}. Mark it paid from Billing > POS Transactions once it is settled.", { paymentMethodName: sale.paymentMethodName })}</p>
                )}
                <ReceiptEmailPrompt
                  key={sale.id}
                  transactionId={sale.id}
                  email={customerEmail || sale.customerEmail || ""}
                  clientId={customerId}
                  clientName={customerName}
                  onClientEmailSaved={(clientId, email) => {
                    if (clientId === customerId) setCustomerEmail(email);
                    onClientEmailSaved(clientId, email);
                  }}
                />
                <div className="panel-actions">
                  <button className="primary-button" onClick={resetSale} type="button">
                    <ClarityStore size={16} />{t("New sale")}</button>
                </div>
              </>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
