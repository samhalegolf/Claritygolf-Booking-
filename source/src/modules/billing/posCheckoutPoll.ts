// Watching a Clarity Pay sale settle.
//
// Extracted from PosCheckoutModal so the Sell screen doesn't carry a second copy
// of the same timer. Both screens show a QR, both need the till to flip to Paid
// on its own, and a duplicated poll loop is exactly the kind of thing that gets
// fixed in one place and not the other.
//
// Asking our backend to re-read the Stripe session (rather than waiting on a
// webhook) means the till updates even if webhook delivery is slow or the
// endpoint was never configured.

import { useCallback, useEffect, useRef } from "react";
import qrcode from "qrcode-generator";
import type { BillingCoupon, PosTransaction } from "./types";
import { t } from "../../lib/i18n";

// The server closes a counter QR after an hour (POS_CHECKOUT_MINUTES in
// billing-api). The poll runs a little longer than that, then stops rather than
// leaving a timer behind a forgotten tab. Afterpay on the customer's phone
// routinely takes several minutes, so this cannot be a "couple of minutes".
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 65 * 60 * 1000;

export type PollStop = "expired" | "timeout";
export type CheckResult = "paid" | "pending" | "expired" | "error";

/**
 * Polls while `transactionId` is non-empty. Pass "" to stop.
 *
 * A browser slows the timers of a tab that is hidden or on a sleeping screen
 * to about once a minute, which is exactly what happens while the coach watches
 * the customer's phone instead. So it also checks the moment the screen is
 * looked at again, and returns a `checkNow` for a Check again button, which
 * works even after the automatic checking has stopped.
 *
 * Both callbacks are held in refs. They are plain functions from a component
 * that re-renders on a timer, so depending on them directly would tear the
 * interval down and rebuild it every few seconds - which resets the timeout
 * clock and delays each poll.
 */
export function usePosPaymentPoll(
  transactionId: string,
  onPaid: (transaction: PosTransaction, issuedCoupons: BillingCoupon[]) => void,
  onStopped: (reason: PollStop) => void,
) {
  const onPaidRef = useRef(onPaid);
  const onStoppedRef = useRef(onStopped);
  const checkRef = useRef<() => Promise<CheckResult>>(async () => "error");
  useEffect(() => {
    onPaidRef.current = onPaid;
    onStoppedRef.current = onStopped;
  }, [onPaid, onStopped]);

  useEffect(() => {
    if (!transactionId) {
      checkRef.current = async () => "error";
      return;
    }
    const startedAt = Date.now();
    let cancelled = false;
    let paid = false;
    let inFlight: Promise<CheckResult> | null = null;

    async function ask(): Promise<CheckResult> {
      try {
        const response = await fetch(
          `/api/billing/pos/transactions/${encodeURIComponent(transactionId)}/checkout-status`,
          { credentials: "same-origin", cache: "no-store" },
        );
        if (!response.ok) return "error";
        const data = (await response.json()) as {
          transaction?: PosTransaction;
          paid?: boolean;
          expired?: boolean;
          issuedCoupons?: BillingCoupon[];
        };
        if (cancelled || paid) return paid ? "paid" : "error";
        if (data.paid && data.transaction) {
          paid = true;
          clearInterval(timer);
          // A voucher's code is issued when the card clears, not when the sale
          // was rung up, so this is the first moment the till can show it.
          onPaidRef.current(data.transaction, data.issuedCoupons || []);
          return "paid";
        }
        if (data.expired) {
          clearInterval(timer);
          onStoppedRef.current("expired");
          return "expired";
        }
        return "pending";
      } catch {
        // Transient network blips are expected on a till; the next check retries.
        return "error";
      }
    }

    // One question at a time: the timer, a returning screen and the button can
    // all ask at once.
    function check() {
      if (!inFlight) inFlight = ask().finally(() => (inFlight = null));
      return inFlight;
    }

    const timer = setInterval(() => {
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        clearInterval(timer);
        if (!cancelled && !paid) onStoppedRef.current("timeout");
        return;
      }
      void check();
    }, POLL_INTERVAL_MS);

    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    checkRef.current = check;

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [transactionId]);

  return useCallback(() => checkRef.current(), []);
}

/** What the till says when the automatic checking has stopped. */
export function pollStoppedMessage(reason: PollStop) {
  return reason === "expired"
    ? t("This payment page closed without being paid. Cancel the sale and start it again.")
    : t("Stopped checking automatically. Once the customer has paid, tap Check again.");
}

/** What Check again says when the answer is not "paid". */
export function checkAgainMessage(result: CheckResult) {
  if (result === "pending") return t("Not paid yet. If the customer has just finished, wait a moment and check again.");
  if (result === "expired") return pollStoppedMessage("expired");
  if (result === "error") return t("Could not reach the payment service. Check the connection and try again.");
  return "";
}

// Shared by both checkout surfaces: create a sale, open a Stripe session, void
// an abandoned one.
export async function postPosJson(path: string, body: unknown) {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(body ?? {}),
  });
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new Error(typeof data?.message === "string" ? data.message : t("Payment could not be recorded."));
  }
  return data || {};
}

export function renderQrSvg(value: string) {
  // Error correction M: enough redundancy for a phone camera at counter
  // distance without inflating the module count. Type 0 = auto-size.
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();
  return qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
}
