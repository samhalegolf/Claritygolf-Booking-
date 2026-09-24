// Finding a gift voucher at the checkout.
//
// Used to be a box that took an exact code and nothing else, which is no help
// to someone who has lost the card but knows whose it was. It is now a search
// over the account's spendable vouchers, by code or by name.
//
// Picking one only *holds* it against this sale and shows what is on it. Nothing
// comes off the voucher until "Pay with coupon" is pressed at payment, and even
// then the value is taken in the same request that records the sale -- so a
// sale abandoned half-way never leaves a voucher short.
//
// Shared by the Sell screen and the checkout modal.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Search, Ticket, X } from "lucide-react";
import type { BillingCoupon } from "./types";
import { searchCoupons } from "./couponMath";

export type SpendableCoupons = {
  coupons: BillingCoupon[];
  state: "loading" | "loaded" | "error";
  reload: () => void;
};

// The whole active voucher book, read once when a checkout opens and again after
// every sale. A pro shop's book is dozens of codes, not thousands, so searching
// in the browser is instant and needs no endpoint. The balance shown is a read;
// the SQL guard at pay time is what actually stops a voucher being spent twice.
export function useSpendableCoupons(): SpendableCoupons {
  const [coupons, setCoupons] = useState<BillingCoupon[]>([]);
  const [state, setState] = useState<SpendableCoupons["state"]>("loading");
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/billing/coupons?status=active&limit=500", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Could not load coupons.");
        const data = (await response.json()) as { coupons?: BillingCoupon[] };
        if (cancelled) return;
        setCoupons(Array.isArray(data.coupons) ? data.coupons : []);
        setState("loaded");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [generation]);

  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  return { coupons, state, reload };
}

export type CouponPickerProps = {
  book: SpendableCoupons;
  held: BillingCoupon | null;
  // How much of the held voucher this sale would use, and whether it has
  // already been put down as paid credit.
  applyAmount: number;
  applied: boolean;
  // customerId -> name, so a voucher filed under a client is found by that
  // client's name even when it was issued to someone else.
  clientNames: ReadonlyMap<string, string>;
  formatMoney: (amount: number, currency?: string) => string;
  onHold: (coupon: BillingCoupon) => void;
  onRelease: () => void;
  disabled?: boolean;
};

export function CouponPicker({
  book,
  held,
  applyAmount,
  applied,
  clientNames,
  formatMoney,
  onHold,
  onRelease,
  disabled = false,
}: CouponPickerProps) {
  const [query, setQuery] = useState("");

  const entries = useMemo(
    () => book.coupons.map((coupon) => ({ ...coupon, customerName: clientNames.get(coupon.customerId) || "" })),
    [book.coupons, clientNames],
  );
  const matches = useMemo(() => searchCoupons(entries, query), [entries, query]);

  if (held) {
    const left = Math.max(0, held.remainingValue - applyAmount);
    return (
      <div className={`coupon-held${applied ? " applied" : ""}`}>
        <Ticket size={14} />
        <span>
          <strong>
            {held.code}
            {held.issuedToName ? ` · ${held.issuedToName}` : ""}
          </strong>
          <em>
            {applied
              ? `${formatMoney(applyAmount, held.currency)} paid by coupon${left > 0 ? ` - ${formatMoney(left, held.currency)} stays on it` : ""}`
              : `${formatMoney(held.remainingValue, held.currency)} available - held for this sale, not yet used`}
          </em>
        </span>
        <button
          className="icon-button small"
          disabled={disabled}
          onClick={onRelease}
          type="button"
          aria-label="Remove coupon"
        >
          <X size={13} />
        </button>
      </div>
    );
  }

  const needle = query.trim();
  return (
    <div className="coupon-search">
      <Search size={14} />
      <input
        value={query}
        disabled={disabled}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          // A scanned or typed full code with one match is held straight away.
          if (event.key === "Enter" && matches.length === 1) {
            onHold(matches[0]);
            setQuery("");
          }
        }}
        placeholder="Search coupons by code or name"
        aria-label="Search coupons by code or name"
      />
      {Boolean(needle) && (
        <div className="coupon-search-results">
          {matches.map((coupon) => (
            <button
              key={coupon.id}
              className="coupon-search-match"
              onClick={() => {
                onHold(coupon);
                setQuery("");
              }}
              type="button"
            >
              <span>
                <strong>{coupon.code}</strong>
                <em>{coupon.issuedToName || coupon.customerName || "No name on it"}</em>
              </span>
              <b>{formatMoney(coupon.remainingValue, coupon.currency)}</b>
            </button>
          ))}
          {!matches.length && (
            <p className="field-help">
              {book.state === "loading"
                ? "Loading coupons..."
                : book.state === "error"
                  ? "Could not load coupons."
                  : "No usable coupon matches that."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
