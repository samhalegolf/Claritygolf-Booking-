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

import { useEffect, useRef } from "react";
import qrcode from "qrcode-generator";
import type { PosTransaction } from "./types";

// Stripe checkout sessions live for 24h, but a customer standing at a counter
// either pays within a couple of minutes or does not. Stop polling after that
// rather than leaving a timer running behind a forgotten tab.
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Polls while `transactionId` is non-empty. Pass "" to stop.
 *
 * Both callbacks are held in refs. They are plain functions from a component
 * that re-renders on a timer, so depending on them directly would tear the
 * interval down and rebuild it every few seconds - which resets the timeout
 * clock and delays each poll.
 */
export function usePosPaymentPoll(
  transactionId: string,
  onPaid: (transaction: PosTransaction) => void,
  onTimeout: () => void,
) {
  const onPaidRef = useRef(onPaid);
  const onTimeoutRef = useRef(onTimeout);
  useEffect(() => {
    onPaidRef.current = onPaid;
    onTimeoutRef.current = onTimeout;
  }, [onPaid, onTimeout]);

  useEffect(() => {
    if (!transactionId) return;
    const startedAt = Date.now();
    let cancelled = false;

    const timer = setInterval(async () => {
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        clearInterval(timer);
        if (!cancelled) onTimeoutRef.current();
        return;
      }
      try {
        const response = await fetch(
          `/api/billing/pos/transactions/${encodeURIComponent(transactionId)}/checkout-status`,
          { credentials: "same-origin", cache: "no-store" },
        );
        if (!response.ok) return;
        const data = (await response.json()) as { transaction?: PosTransaction; paid?: boolean };
        if (cancelled || !data.paid || !data.transaction) return;
        clearInterval(timer);
        onPaidRef.current(data.transaction);
      } catch {
        // Transient network blips are expected on a till; the next tick retries.
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [transactionId]);
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
    throw new Error(typeof data?.message === "string" ? data.message : "Payment could not be recorded.");
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
