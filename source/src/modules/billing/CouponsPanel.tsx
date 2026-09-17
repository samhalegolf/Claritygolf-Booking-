import { Loading } from "../shared/Loading";
// Billing > Coupons. Gift vouchers: what has been issued, what is left on each,
// and the Stripe purchases that still need one.
//
// Presentational, like ProductsPanel and BillingReportsPanel: App.tsx owns the
// list and every request; what lives here is form and disclosure state.

import { Fragment, useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Copy, Download, Plus, Search, Ticket, X } from "lucide-react";
import type { BillingCoupon, CouponImportCandidate, CouponRedemption, VoucherAmountRule } from "./types";

/** What a scan came back with. `scannedCount` is how many charges were read,
 *  so "nothing found" can be told apart from "nothing looked at". */
export type CouponScanResult = {
  candidates: CouponImportCandidate[];
  otherCharges: CouponImportCandidate[];
  scannedCount: number;
  sinceDays: number;
  rules: VoucherAmountRule[];
};

export type CouponIssueValues = {
  value: number;
  code: string;
  issuedToName: string;
  issuedToEmail: string;
  expiresAt: string;
  note: string;
};

export type CouponsPanelProps = {
  coupons: BillingCoupon[];
  loadState: "idle" | "loading" | "loaded" | "error";
  currency: string;
  formatMoney: (amount: number, currency?: string) => string;
  onReload: () => void;
  onIssue: (values: CouponIssueValues) => Promise<boolean>;
  onSetVoid: (coupon: BillingCoupon, isVoid: boolean) => Promise<void>;
  onLoadRedemptions: (couponId: string) => Promise<CouponRedemption[]>;
  onScanStripe: () => Promise<CouponScanResult | null>;
  onImport: (chargeIds: string[], addBuyersAsClients: boolean) => Promise<number>;
  /** The coach's price rules, and saving a changed list of them. */
  rules: VoucherAmountRule[];
  onSaveRules: (rules: VoucherAmountRule[]) => Promise<boolean>;
  /** Preview, then perform, the "give old vouchers an owner" repair. */
  onRepairOwners: (preview: boolean, addBuyersAsClients: boolean) => Promise<VoucherRepairResult | null>;
};

export type VoucherRepairResult = {
  preview: boolean;
  unowned?: number;
  alreadyKnown?: number;
  clientsToAdd?: number;
  linked?: number;
  clientsAdded?: number;
  failures?: number;
};

const SOURCE_LABELS: Record<BillingCoupon["source"], string> = {
  stripe: "Stripe",
  pos: "Sold at the till",
  manual: "Issued by hand",
};

function emptyIssueForm() {
  return { value: "", code: "", issuedToName: "", issuedToEmail: "", expiresAt: "", note: "" };
}

function statusLabel(coupon: BillingCoupon) {
  if (coupon.status === "void") return "cancelled";
  if (coupon.expired) return "expired";
  if (coupon.status === "redeemed" || coupon.remainingValue <= 0) return "used";
  return "active";
}

export function CouponsPanel({
  coupons,
  loadState,
  currency,
  formatMoney,
  onReload,
  onIssue,
  onSetVoid,
  onLoadRedemptions,
  onScanStripe,
  onImport,
  rules,
  onSaveRules,
  onRepairOwners,
}: CouponsPanelProps) {
  const [form, setForm] = useState(emptyIssueForm);
  const [issuing, setIssuing] = useState(false);
  const [search, setSearch] = useState("");
  const [showSpent, setShowSpent] = useState(false);

  const [openCoupon, setOpenCoupon] = useState("");
  const [redemptions, setRedemptions] = useState<CouponRedemption[]>([]);
  const [redemptionsLoading, setRedemptionsLoading] = useState(false);

  /** null until a scan has been run: "not looked yet" is not "nothing found". */
  const [scan, setScan] = useState<CouponScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  /** The charges the classifier did not recognise, shut by default. */
  const [showOthers, setShowOthers] = useState(false);

  /** The price-rule editor. Shut unless the coach opens it or has rules. */
  const [showRules, setShowRules] = useState(false);
  const [ruleDraft, setRuleDraft] = useState({ amount: "", label: "", from: "", until: "" });
  const [savingRules, setSavingRules] = useState(false);

  async function addRule() {
    const amountCents = Math.round(Number(ruleDraft.amount) * 100);
    const label = ruleDraft.label.trim();
    if (!Number.isFinite(amountCents) || amountCents <= 0 || !label) return;
    setSavingRules(true);
    try {
      const saved = await onSaveRules([
        ...rules,
        {
          id: `rule-${Date.now()}`,
          amountCents,
          currency,
          label,
          from: ruleDraft.from,
          until: ruleDraft.until,
        },
      ]);
      if (saved) setRuleDraft({ amount: "", label: "", from: "", until: "" });
    } finally {
      setSavingRules(false);
    }
  }

  async function removeRule(id: string) {
    setSavingRules(true);
    try {
      await onSaveRules(rules.filter((rule) => rule.id !== id));
    } finally {
      setSavingRules(false);
    }
  }

  async function runScan() {
    setScanning(true);
    try {
      const found = await onScanStripe();
      setScan(found);
      // Recognised ones start ticked -- that is the whole point of recognising
      // them -- but each is still a tick a coach can take off, because the
      // classifier is a keyword match and a coupon is spendable money.
      setChosen(Object.fromEntries((found?.candidates || []).map((entry) => [entry.chargeId, true])));
      setShowOthers(false);
    } finally {
      setScanning(false);
    }
  }

  async function runImport() {
    const chargeIds = Object.entries(chosen)
      .filter(([, ticked]) => ticked)
      .map(([chargeId]) => chargeId);
    if (!chargeIds.length) return;
    setImporting(true);
    try {
      await onImport(chargeIds, addBuyers);
      setScan(null);
      setChosen({});
    } finally {
      setImporting(false);
    }
  }

  const chosenCount = Object.values(chosen).filter(Boolean).length;

  /* Everything the scan came back with, as one list.
   *
   * The screen still separates recognised from unrecognised, because they are
   * read differently -- but selecting works across both. A coach who knows the
   * $160 ones are vouchers does not care which half of the screen each row
   * happens to be sitting in. */
  const allCandidates = useMemo(
    () => (scan ? [...scan.candidates, ...scan.otherCharges] : []),
    [scan],
  );

  /* Amounts, biggest group first.
   *
   * Grouping by price because price is what a coach actually knows about these
   * -- the payments carry no product name, which is the whole problem, and
   * "all the $160 ones" is the sentence they would use out loud. */
  const amountGroups = useMemo(() => {
    const groups = new Map<string, { key: string; valueCents: number; currency: string; ids: string[] }>();
    for (const entry of allCandidates) {
      const key = `${entry.currency}:${entry.valueCents}`;
      const held = groups.get(key);
      if (held) held.ids.push(entry.chargeId);
      else
        groups.set(key, {
          key,
          valueCents: entry.valueCents,
          currency: entry.currency,
          ids: [entry.chargeId],
        });
    }
    return [...groups.values()].sort((a, b) => b.ids.length - a.ids.length || b.valueCents - a.valueCents);
  }, [allCandidates]);

  /* A selection the coach cannot see is a selection they cannot check.
   *
   * Both bulk actions reach rows in the folded half, and "Issue 21 codes" over
   * a shut fold is a button that will mint money for rows nobody has looked
   * at. Selecting anything in there opens it. */
  function revealIfFolded(ids: string[]) {
    if (!scan) return;
    const folded = new Set(scan.otherCharges.map((entry) => entry.chargeId));
    if (ids.some((id) => folded.has(id))) setShowOthers(true);
  }

  function toggleAmount(ids: string[]) {
    // All-or-nothing on the group: half-ticked, clicking selects the rest,
    // which is what "select all of these" means when some already are.
    const allOn = ids.every((id) => chosen[id]);
    setChosen((current) => {
      const next = { ...current };
      for (const id of ids) next[id] = !allOn;
      return next;
    });
    if (!allOn) revealIfFolded(ids);
  }

  /* Order numbers, in a form that can be taken somewhere else.
   *
   * The payments cannot say what they were for, but the coach's own order
   * confirmation emails can -- and the order number is the join. Copying the
   * list out, working out which are vouchers elsewhere, and pasting the
   * numbers back is a real workflow, and a far better one than reading 102
   * rows off a screen. */
  const [copied, setCopied] = useState("");
  /* Default on, because a voucher filed under nobody cannot be found by the
   * name of whoever bought it -- which is the point of filing it. Still a
   * choice, because adding fifty clients is a thing to agree to rather than
   * discover afterwards. */
  const [addBuyers, setAddBuyers] = useState(true);

  /* The one-off repair for vouchers imported before they could be filed under
   * anybody. Two steps on purpose: on this account the honest description is
   * "add 29 people to your client list", which somebody should read before it
   * happens rather than after. */
  const [repairPreview, setRepairPreview] = useState<VoucherRepairResult | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [repairDone, setRepairDone] = useState("");

  async function previewRepair() {
    setRepairing(true);
    setRepairDone("");
    try {
      setRepairPreview(await onRepairOwners(true, addBuyers));
    } finally {
      setRepairing(false);
    }
  }

  async function runRepair() {
    setRepairing(true);
    try {
      const result = await onRepairOwners(false, addBuyers);
      if (result) {
        setRepairDone(
          `Filed ${result.linked || 0} voucher${result.linked === 1 ? "" : "s"}` +
            (result.clientsAdded
              ? `, ${result.clientsAdded} client${result.clientsAdded === 1 ? "" : "s"} added`
              : "") +
            (result.failures ? `, ${result.failures} could not be filed` : "") +
            ".",
        );
        setRepairPreview(null);
      }
    } finally {
      setRepairing(false);
    }
  }

  const [orderPaste, setOrderPaste] = useState("");
  const [showPaste, setShowPaste] = useState(false);

  async function copyOrderNumbers() {
    const lines = allCandidates.map((entry) =>
      [
        entry.orderNumber,
        entry.when ? entry.when.slice(0, 10) : "",
        `${entry.currency} ${(entry.valueCents / 100).toFixed(2)}`,
        entry.buyerName,
        entry.buyerEmail,
      ].join("\t"),
    );
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(`Copied ${lines.length} order${lines.length === 1 ? "" : "s"}.`);
    } catch {
      setCopied("Could not reach the clipboard — select the list by hand.");
    }
  }

  /* Tick the rows whose order number appears in the pasted text.
   *
   * Deliberately forgiving about what is pasted: a reply from an assistant, a
   * list with bullets, "ORD-272" or "272" are all the same answer, and making
   * a coach reformat it would undo the point of the shortcut. Anything that is
   * not an order number here matches nothing, which is visible as a count. */
  function selectPastedOrders() {
    const wanted = new Set(
      (orderPaste.match(/\d{1,10}/g) || []).map((digits) => digits.replace(/^0+(?=\d)/, "")),
    );
    if (!wanted.size) return;
    const matched: string[] = [];
    for (const entry of allCandidates) {
      const digits = (entry.orderNumber.match(/\d{1,10}/) || [])[0];
      if (digits && wanted.has(digits.replace(/^0+(?=\d)/, ""))) matched.push(entry.chargeId);
    }
    setChosen((current) => {
      const next = { ...current };
      for (const id of matched) next[id] = true;
      return next;
    });
    revealIfFolded(matched);
    setCopied(
      matched.length
        ? `Ticked ${matched.length} of ${wanted.size} order number${wanted.size === 1 ? "" : "s"}.`
        : "None of those order numbers is in this list.",
    );
  }

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return coupons.filter((coupon) => {
      if (!showSpent && !coupon.spendable) return false;
      if (!needle) return true;
      return [coupon.code, coupon.issuedToName, coupon.issuedToEmail, coupon.note]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle));
    });
  }, [coupons, search, showSpent]);

  const outstanding = useMemo(
    () => coupons.filter((coupon) => coupon.spendable).reduce((total, coupon) => total + coupon.remainingValue, 0),
    [coupons],
  );

  async function submitIssue() {
    const value = Number(form.value);
    if (!Number.isFinite(value) || value <= 0) return;
    setIssuing(true);
    try {
      if (await onIssue({ ...form, value })) setForm(emptyIssueForm());
    } finally {
      setIssuing(false);
    }
  }

  async function toggleCoupon(coupon: BillingCoupon) {
    if (openCoupon === coupon.id) {
      setOpenCoupon("");
      return;
    }
    setOpenCoupon(coupon.id);
    setRedemptions([]);
    setRedemptionsLoading(true);
    try {
      setRedemptions(await onLoadRedemptions(coupon.id));
    } finally {
      setRedemptionsLoading(false);
    }
  }

  return (
    <div className="billing-dashboard billing-coupons">
      <article className="data-card">
        <div className="data-card-header">
          <div>
            <span>Gift vouchers</span>
            <h2>{formatMoney(outstanding, currency)} outstanding</h2>
          </div>
          <Ticket size={24} />
        </div>
        <p className="field-help">
          Vouchers people have paid for and not yet spent. That total is money you owe in lessons and gear, not takings -
          it lands in the till on the day the voucher is redeemed, not the day it was bought.
        </p>
        <div className="settings-field-row product-search-row">
          <div className="settings-field product-search-field">
            <label htmlFor="coupon-search">Search</label>
            <div className="product-search-input">
              <Search size={15} />
              <input
                id="coupon-search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Code, name or email"
              />
              {Boolean(search) && (
                <button className="icon-button small" onClick={() => setSearch("")} type="button" aria-label="Clear search">
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
          <label className="settings-field pos-settles-toggle">
            <input checked={showSpent} onChange={(event) => setShowSpent(event.target.checked)} type="checkbox" />
            <span>Show used and cancelled</span>
          </label>
          <button className="outline-button" onClick={onReload} type="button">
            Refresh
          </button>
        </div>
      </article>

      <article className="data-card wide">
        <div className="data-card-header">
          <div>
            <span>From Stripe</span>
            <h2>Vouchers bought online</h2>
          </div>
          <Download size={24} />
        </div>
        <p className="field-help">
          Reads your Stripe payments directly and looks for gift vouchers among them — in the
          payment's own wording, and failing that in what was actually in the basket. It has to go
          to Stripe rather than the synced invoice list because Stripe labels every one of these
          "Charge for &lt;email&gt;", so the product name is not in your records at all.
        </p>
        {/* Vouchers imported before they could be filed under anyone.
         *
         * Not shown unless there are some: a repair for a problem the account
         * does not have is a button that only ever creates doubt. */}
        <div className="coupon-repair">
          {!repairPreview && !repairDone && (
            <button className="link-button" type="button" disabled={repairing} onClick={() => void previewRepair()}>
              {repairing ? "Checking…" : "Check for vouchers that belong to nobody"}
            </button>
          )}
          {repairPreview && (repairPreview.unowned || 0) > 0 && (
            <div className="coupon-repair-preview">
              <p className="field-help">
                {repairPreview.unowned} voucher{repairPreview.unowned === 1 ? "" : "s"} belong
                {repairPreview.unowned === 1 ? "s" : ""} to nobody.{" "}
                {repairPreview.alreadyKnown
                  ? `${repairPreview.alreadyKnown} of them match a client you already have. `
                  : "None of them matches a client you already have — which is normal for gifts. "}
                {addBuyers
                  ? `Filing them adds ${repairPreview.clientsToAdd} client${
                      repairPreview.clientsToAdd === 1 ? "" : "s"
                    }.`
                  : "Only the ones matching an existing client will be filed."}
              </p>
              <div className="panel-actions">
                <button className="primary-button" type="button" disabled={repairing} onClick={() => void runRepair()}>
                  {repairing ? "Filing…" : "File them"}
                </button>
                <button className="outline-button" type="button" onClick={() => setRepairPreview(null)}>
                  Not now
                </button>
                <label className="coupon-add-buyers">
                  <input
                    type="checkbox"
                    checked={addBuyers}
                    onChange={(event) => setAddBuyers(event.target.checked)}
                  />
                  Add buyers to the client list
                </label>
              </div>
            </div>
          )}
          {repairPreview && !repairPreview.unowned && (
            <p className="field-help">Every voucher already belongs to somebody.</p>
          )}
          {repairDone && <p className="field-help">{repairDone}</p>}
        </div>

        {/* Price rules.
         *
         * Only ever consulted for a payment Stripe could not name, which for a
         * Squarespace sale is every one of them: its metadata is four
         * identifiers and no product. They are the coach's own because a price
         * is not permanent -- this account's voucher was $150 until July 2025
         * and $160 from September -- and a number written into the code would
         * be wrong the next time one moved, silently.
         */}
        <div className="coupon-rules">
          <button
            className="coupon-candidates-fold-toggle"
            type="button"
            aria-expanded={showRules}
            onClick={() => setShowRules((current) => !current)}
          >
            {showRules ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            {rules.length
              ? `${rules.length} price rule${rules.length === 1 ? "" : "s"} for naming a payment`
              : "No price rules yet — add one to name payments Stripe cannot"}
          </button>
          {showRules && (
            <>
              <p className="field-help">
                Squarespace tells Stripe an order number and nothing about the product, so a price
                is the only clue left. A rule is used only when the payment itself says nothing.
                Changed your price? Add a second rule with the same name — the old one keeps naming
                the older sales correctly.
              </p>
              {rules.length > 0 && (
                <ul className="coupon-rules-list">
                  {rules.map((rule) => (
                    <li key={rule.id}>
                      <span>
                        <strong>{formatMoney(rule.amountCents / 100, rule.currency || currency)}</strong>{" "}
                        → {rule.label}
                        {rule.from || rule.until ? (
                          <em>
                            {rule.from ? ` from ${rule.from}` : ""}
                            {rule.until ? ` until ${rule.until}` : ""}
                          </em>
                        ) : null}
                      </span>
                      <button
                        className="link-button"
                        type="button"
                        disabled={savingRules}
                        onClick={() => void removeRule(rule.id)}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="coupon-rule-form">
                <label className="settings-field">
                  <span>Amount ({currency})</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={ruleDraft.amount}
                    onChange={(event) =>
                      setRuleDraft((current) => ({ ...current, amount: event.target.value }))
                    }
                  />
                </label>
                <label className="settings-field">
                  <span>Is this product</span>
                  <input
                    value={ruleDraft.label}
                    placeholder="Lesson Gift Voucher"
                    onChange={(event) =>
                      setRuleDraft((current) => ({ ...current, label: event.target.value }))
                    }
                  />
                </label>
                <label className="settings-field">
                  <span>From (optional)</span>
                  <input
                    type="date"
                    value={ruleDraft.from}
                    onChange={(event) =>
                      setRuleDraft((current) => ({ ...current, from: event.target.value }))
                    }
                  />
                </label>
                <label className="settings-field">
                  <span>Until (optional)</span>
                  <input
                    type="date"
                    value={ruleDraft.until}
                    onChange={(event) =>
                      setRuleDraft((current) => ({ ...current, until: event.target.value }))
                    }
                  />
                </label>
                <button
                  className="outline-button"
                  type="button"
                  disabled={savingRules || !ruleDraft.label.trim() || !Number(ruleDraft.amount)}
                  onClick={() => void addRule()}
                >
                  {savingRules ? "Saving…" : "Add rule"}
                </button>
              </div>
            </>
          )}
        </div>

        <div className="panel-actions coupon-import-actions">
          <button className="outline-button" disabled={scanning} onClick={() => void runScan()} type="button">
            {scanning ? "Looking…" : "Find voucher purchases"}
          </button>
          {chosenCount > 0 && (
            <button className="primary-button" disabled={importing} onClick={() => void runImport()} type="button">
              {importing ? "Issuing…" : `Issue ${chosenCount} code${chosenCount === 1 ? "" : "s"}`}
            </button>
          )}
          {chosenCount > 0 && (
            <label className="coupon-add-buyers">
              <input
                type="checkbox"
                checked={addBuyers}
                onChange={(event) => setAddBuyers(event.target.checked)}
              />
              Add buyers to the client list
            </label>
          )}
        </div>

        {scan && (
          <>
            {/* Said plainly, because the old version of this screen could not:
                "nothing found" and "nothing looked at" rendered identically and
                the difference was the entire bug. */}
            <p className="field-help">
              Read {scan.scannedCount} payment{scan.scannedCount === 1 ? "" : "s"} from the last{" "}
              {scan.sinceDays} days.{" "}
              {scan.candidates.length
                ? `${scan.candidates.length} look${scan.candidates.length === 1 ? "s" : ""} like a voucher.`
                : "None of them is named like a voucher."}
            </p>

            {/* Selecting in bulk.
              *
              * A hundred payments that carry no product name cannot be triaged
              * one checkbox at a time, and the two things a coach does know
              * about them are the price and the order number. So both are
              * selectable wholesale: pick every payment at a price, or paste
              * the order numbers worked out elsewhere. */}
            {allCandidates.length > 0 && (
              <div className="coupon-bulk">
                <div className="coupon-bulk-amounts">
                  <span className="coupon-bulk-label">Select every payment of</span>
                  {amountGroups.map((group) => {
                    const allOn = group.ids.every((id) => chosen[id]);
                    const someOn = !allOn && group.ids.some((id) => chosen[id]);
                    return (
                      <button
                        key={group.key}
                        type="button"
                        className={`coupon-amount-chip${allOn ? " is-on" : someOn ? " is-part" : ""}`}
                        aria-pressed={allOn}
                        onClick={() => toggleAmount(group.ids)}
                      >
                        {formatMoney(group.valueCents / 100, group.currency || currency)}
                        <em>{group.ids.length}</em>
                      </button>
                    );
                  })}
                </div>
                <div className="panel-actions coupon-import-actions">
                  <button className="outline-button" type="button" onClick={() => void copyOrderNumbers()}>
                    <Copy size={15} /> Copy {allCandidates.length} order numbers
                  </button>
                  <button
                    className="outline-button"
                    type="button"
                    aria-expanded={showPaste}
                    onClick={() => setShowPaste((current) => !current)}
                  >
                    Paste order numbers to tick
                  </button>
                  {chosenCount > 0 && (
                    <button className="link-button" type="button" onClick={() => setChosen({})}>
                      Clear {chosenCount} selected
                    </button>
                  )}
                </div>
                {showPaste && (
                  <div className="coupon-paste">
                    <label className="settings-field">
                      <span>Order numbers</span>
                      <textarea
                        rows={3}
                        value={orderPaste}
                        placeholder="272, 266, ORD-261 — any format, one line or many"
                        onChange={(event) => setOrderPaste(event.target.value)}
                      />
                    </label>
                    <button
                      className="outline-button"
                      type="button"
                      disabled={!orderPaste.trim()}
                      onClick={selectPastedOrders}
                    >
                      Tick those
                    </button>
                  </div>
                )}
                {copied && <p className="field-help">{copied}</p>}
              </div>
            )}

            {scan.candidates.length > 0 && (
              <ul className="coupon-candidates">
                {scan.candidates.map((candidate) => (
                  <li key={candidate.chargeId}>
                    <label>
                      <input
                        type="checkbox"
                        checked={Boolean(chosen[candidate.chargeId])}
                        onChange={(event) =>
                          setChosen((current) => ({
                            ...current,
                            [candidate.chargeId]: event.target.checked,
                          }))
                        }
                      />
                      <span className="coupon-candidate-main">
                        <strong>{candidate.label || "Unnamed purchase"}</strong>
                        <em>
                          {[
                            candidate.buyerName || candidate.buyerEmail || "Unknown buyer",
                            formatMoney(candidate.valueCents / 100, candidate.currency || currency),
                            candidate.when ? new Date(candidate.when).toLocaleDateString() : "",
                            candidate.orderNumber,
                            // Where the name came from. A coach deciding
                            // whether to mint money should be able to see what
                            // the guess was made on.
                            candidate.labelSource ? `from ${candidate.labelSource}` : "",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </em>
                        {candidate.partlyRefunded && (
                          <em className="coupon-candidate-warning">
                            <AlertTriangle size={12} /> Partly refunded — the value above is what is
                            left
                          </em>
                        )}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}

            {/* Everything else that was paid for and is not already a voucher.
                Kept because the classifier reads words, and a voucher the coach
                knows was bought but that Squarespace named something
                unexpected has to be reachable -- otherwise this screen is
                confidently wrong in exactly the way the last one was. */}
            {scan.otherCharges.length > 0 && (
              <div className="coupon-candidates-fold">
                <button
                  className="coupon-candidates-fold-toggle"
                  type="button"
                  aria-expanded={showOthers}
                  onClick={() => setShowOthers((current) => !current)}
                >
                  {showOthers ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  {scan.otherCharges.length} other payment
                  {scan.otherCharges.length === 1 ? "" : "s"} with no coupon — tick any that were
                  vouchers
                </button>
                {showOthers && (
                  <ul className="coupon-candidates">
                    {scan.otherCharges.map((candidate) => (
                      <li key={candidate.chargeId}>
                        <label>
                          <input
                            type="checkbox"
                            checked={Boolean(chosen[candidate.chargeId])}
                            onChange={(event) =>
                              setChosen((current) => ({
                                ...current,
                                [candidate.chargeId]: event.target.checked,
                              }))
                            }
                          />
                          <span className="coupon-candidate-main">
                            <strong>{candidate.label || "Unnamed purchase"}</strong>
                            <em>
                              {[
                                candidate.buyerName || candidate.buyerEmail || "Unknown buyer",
                                formatMoney(candidate.valueCents / 100, candidate.currency || currency),
                                candidate.when ? new Date(candidate.when).toLocaleDateString() : "",
                                candidate.orderNumber,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </em>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </article>

      <article className="data-card wide">
        <div className="data-card-header">
          <div>
            <span>Issue</span>
            <h2>New coupon</h2>
          </div>
          <Plus size={24} />
        </div>
        <div className="billing-catalog-editor product-editor">
          <label className="settings-field">
            <span>Value ({currency})</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.value}
              onChange={(event) => setForm((current) => ({ ...current, value: event.target.value }))}
            />
          </label>
          <label className="settings-field">
            <span>Code</span>
            <input
              value={form.code}
              onChange={(event) => setForm((current) => ({ ...current, code: event.target.value }))}
              placeholder="Leave blank to generate one"
            />
          </label>
          <label className="settings-field">
            <span>For</span>
            <input
              value={form.issuedToName}
              onChange={(event) => setForm((current) => ({ ...current, issuedToName: event.target.value }))}
              placeholder="Optional"
            />
          </label>
          <label className="settings-field">
            <span>Email</span>
            <input
              type="email"
              value={form.issuedToEmail}
              onChange={(event) => setForm((current) => ({ ...current, issuedToEmail: event.target.value }))}
              placeholder="Optional"
            />
          </label>
          <label className="settings-field">
            <span>Expires</span>
            <input
              type="date"
              value={form.expiresAt}
              onChange={(event) => setForm((current) => ({ ...current, expiresAt: event.target.value }))}
            />
          </label>
          <label className="settings-field product-notes-field">
            <span>Note</span>
            <input
              value={form.note}
              onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))}
              placeholder="Optional - why it was issued"
            />
          </label>
        </div>
        <p className="field-help">
          Leave the expiry blank unless you mean it. Someone has already paid for this.
        </p>
        <div className="panel-actions">
          <button
            className="primary-button"
            disabled={issuing || !(Number(form.value) > 0)}
            onClick={() => void submitIssue()}
            type="button"
          >
            {issuing ? "Issuing..." : "Issue Coupon"}
          </button>
        </div>
      </article>

      <article className="data-card wide recent-invoices-card">
        <div className="data-card-header">
          <div>
            <span>Coupons</span>
            <h2>{visible.length} shown</h2>
          </div>
          <Ticket size={24} />
        </div>
        {loadState === "loading" && <Loading what="coupons" />}
        {loadState === "error" && (
          <p>
            Could not load coupons.{" "}
            <button className="link-button" onClick={onReload} type="button">
              Retry
            </button>
          </p>
        )}
        {loadState !== "loading" && !visible.length && (
          <p>{coupons.length ? "Nothing matches that." : "No coupons yet."}</p>
        )}
        {visible.length > 0 && (
          <table className="recent-invoices-table product-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>For</th>
                <th>Remaining</th>
                <th>Value</th>
                <th>Source</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((coupon) => {
                const open = openCoupon === coupon.id;
                const label = statusLabel(coupon);
                return (
                  <Fragment key={coupon.id}>
                    <tr className={coupon.spendable ? "" : "product-row-inactive"}>
                      <td>
                        <button className="link-button coupon-code" onClick={() => void toggleCoupon(coupon)} type="button">
                          {coupon.code}
                        </button>
                        <em className="product-row-meta">
                          {label}
                          {coupon.expiresAt ? ` - expires ${new Date(coupon.expiresAt).toLocaleDateString()}` : ""}
                        </em>
                      </td>
                      <td>
                        {coupon.issuedToName || "-"}
                        {coupon.issuedToEmail && <em className="product-row-meta">{coupon.issuedToEmail}</em>}
                      </td>
                      <td>
                        <strong>{formatMoney(coupon.remainingValue, coupon.currency)}</strong>
                      </td>
                      <td>{formatMoney(coupon.originalValue, coupon.currency)}</td>
                      <td>{SOURCE_LABELS[coupon.source] || coupon.source}</td>
                      <td className="product-row-actions">
                        <button className="link-button" onClick={() => void toggleCoupon(coupon)} type="button">
                          {open ? "Close" : "History"}
                        </button>
                        <button
                          className="text-link-button"
                          onClick={() => void onSetVoid(coupon, coupon.status !== "void")}
                          type="button"
                        >
                          {coupon.status === "void" ? "Restore" : "Cancel"}
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr className="product-stock-row">
                        <td colSpan={6}>
                          <div className="product-movement-list">
                            {redemptionsLoading && <Loading what="history" className="field-help" />}
                            {!redemptionsLoading && !redemptions.length && (
                              <p className="field-help">Not used yet.</p>
                            )}
                            {!redemptionsLoading &&
                              redemptions.map((entry) => (
                                <div key={entry.id} className="product-movement">
                                  <strong className={entry.amount > 0 ? "negative" : "positive"}>
                                    {entry.amount > 0 ? `-${entry.amount}` : `+${Math.abs(entry.amount)}`}
                                  </strong>
                                  <span>{entry.note || (entry.amount > 0 ? "Redeemed" : "Put back")}</span>
                                  <em>
                                    {entry.createdAt ? new Date(entry.createdAt).toLocaleString() : ""}
                                    {entry.resultingBalance === null ? "" : ` - left ${entry.resultingBalance}`}
                                  </em>
                                </div>
                              ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </article>
    </div>
  );
}
