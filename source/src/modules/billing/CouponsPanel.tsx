// Billing > Coupons. Gift vouchers: what has been issued, what is left on each,
// and the Stripe purchases that still need one.
//
// Presentational, like ProductsPanel and BillingReportsPanel: App.tsx owns the
// list and every request; what lives here is form and disclosure state.

import { Fragment, useMemo, useState } from "react";
import { AlertTriangle, Check, Download, Plus, Search, Ticket, X } from "lucide-react";
import type { BillingCoupon, CouponImportCandidate, CouponRedemption } from "./types";

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
  onFindStripeCandidates: () => Promise<CouponImportCandidate[]>;
  onImport: (lineIds: string[]) => Promise<number>;
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
  onFindStripeCandidates,
  onImport,
}: CouponsPanelProps) {
  const [form, setForm] = useState(emptyIssueForm);
  const [issuing, setIssuing] = useState(false);
  const [search, setSearch] = useState("");
  const [showSpent, setShowSpent] = useState(false);

  const [openCoupon, setOpenCoupon] = useState("");
  const [redemptions, setRedemptions] = useState<CouponRedemption[]>([]);
  const [redemptionsLoading, setRedemptionsLoading] = useState(false);

  const [candidates, setCandidates] = useState<CouponImportCandidate[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [chosen, setChosen] = useState<Record<string, boolean>>({});

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

  async function scanStripe() {
    setScanning(true);
    try {
      const found = await onFindStripeCandidates();
      setCandidates(found);
      // Price-id matches are exact, so they start ticked. A name match is a
      // guess and has to be agreed to deliberately.
      setChosen(Object.fromEntries(found.map((entry) => [entry.lineId, entry.matchedBy === "price"])));
    } finally {
      setScanning(false);
    }
  }

  async function runImport() {
    if (!candidates) return;
    const lineIds = candidates.filter((entry) => chosen[entry.lineId]).map((entry) => entry.lineId);
    if (!lineIds.length) return;
    setImporting(true);
    try {
      await onImport(lineIds);
      setCandidates(null);
      setChosen({});
    } finally {
      setImporting(false);
    }
  }

  const chosenCount = candidates ? candidates.filter((entry) => chosen[entry.lineId]).length : 0;

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
          Looks through synced Stripe purchases for anything sold as a voucher product, and issues a code for each one
          that hasn't got one. Mark a product as a voucher under Billing &gt; Products first, or nothing here will match.
        </p>
        <div className="panel-actions coupon-import-actions">
          <button className="outline-button" disabled={scanning} onClick={() => void scanStripe()} type="button">
            {scanning ? "Looking..." : "Find voucher purchases"}
          </button>
          {candidates !== null && candidates.length > 0 && (
            <button className="primary-button" disabled={importing || !chosenCount} onClick={() => void runImport()} type="button">
              {importing ? "Issuing..." : `Issue ${chosenCount} coupon${chosenCount === 1 ? "" : "s"}`}
            </button>
          )}
        </div>

        {candidates !== null && !candidates.length && (
          <p className="field-help">Nothing new - every voucher purchase found already has a coupon.</p>
        )}

        {candidates !== null && candidates.length > 0 && (
          <table className="recent-invoices-table">
            <thead>
              <tr>
                <th />
                <th>Bought</th>
                <th>Customer</th>
                <th>Item</th>
                <th>Value</th>
                <th>Match</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((candidate) => (
                <tr key={candidate.lineId}>
                  <td>
                    <input
                      checked={Boolean(chosen[candidate.lineId])}
                      onChange={(event) =>
                        setChosen((current) => ({ ...current, [candidate.lineId]: event.target.checked }))
                      }
                      type="checkbox"
                      aria-label={`Issue a coupon for ${candidate.description}`}
                    />
                  </td>
                  <td>{candidate.purchasedAt ? new Date(candidate.purchasedAt).toLocaleDateString() : "-"}</td>
                  <td>
                    {candidate.customerName || "-"}
                    {candidate.customerEmail && <em className="product-row-meta">{candidate.customerEmail}</em>}
                  </td>
                  <td>{candidate.description}</td>
                  <td>{formatMoney(candidate.value, candidate.currency || currency)}</td>
                  <td>
                    {candidate.matchedBy === "price" ? (
                      <span className="coupon-match exact">
                        <Check size={12} /> exact
                      </span>
                    ) : (
                      <span className="coupon-match guess">
                        <AlertTriangle size={12} /> by name
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
        {loadState === "loading" && <p>Loading coupons...</p>}
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
                            {redemptionsLoading && <p className="field-help">Loading history...</p>}
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
