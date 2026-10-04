// Taking the card part of a sale by Tap to Pay on this phone (iPhone or Android).
//
// Shared by the checkout modal and the Sell screen. The sale already exists and
// is pending on Clarity Pay; this only collects the card. Whatever happens, the
// QR is one tap away, so a sale is never stuck here.
//
// See terminal.ts for the rule this screen is built around: once a card may
// have been charged it says "Checking payment" and waits for the server, never
// "failed".

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CircleHelp, Loader2, Nfc, QrCode, RotateCcw, X } from "lucide-react";
import { nativeTerminal, onAndroid } from "../../native/clarityTerminal";
import {
  canRetry,
  connectThisPhone,
  defaultTerminalLocationId,
  saveTerminalLocation,
  showHowToTap,
  stateAfterCollect,
  stateFromServer,
  terminalApi,
  type TapState,
  type TerminalStatus,
} from "./terminal";
import { t } from "../../lib/i18n";

const RECONCILE_INTERVAL_MS = 2000;

export type TerminalPaymentProps = {
  transactionId: string;
  // What the card owes, for display only. The server charges what the stored
  // sale says, whatever this is.
  amount: number;
  currency: string;
  status: TerminalStatus;
  formatMoney: (amount: number, currency?: string) => string;
  onPaid: (paid: Extract<TapState, { kind: "succeeded" }>) => void;
  onShowQr: () => void;
  onCancelSale: () => void;
  // So the caller can refuse to close while money may be moving.
  onStateChange?: (state: TapState) => void;
};

/**
 * Apple's "How to Tap" guide, which Apple requires the app to offer. On an
 * iPhone before iOS 18, and on Android, there is no system guide to show, so
 * the same words are given here instead. An Android phone's tap spot is on its
 * back, not its top.
 */
export function HowToTap() {
  const [fallback, setFallback] = useState(false);
  return (
    <>
      <button
        className="text-button"
        onClick={() => void showHowToTap().then((shown) => setFallback(!shown))}
        type="button"
      >
        <CircleHelp size={15} />{" "}{t("How to tap")}</button>
      {fallback && (
        <p className="field-help">
          {onAndroid()
            ? t("The customer holds their card, phone or watch flat against the back of this phone and keeps it there until it confirms.")
            : t("The customer holds their card, phone or watch flat against the top of this iPhone and keeps it there until the check mark shows.")}
        </p>
      )}
    </>
  );
}

/** True while a card may be mid-charge: nothing may close or restart. */
export function tapIsBusy(state: TapState | null) {
  return Boolean(state && ["reading", "processing", "unknown"].includes(state.kind));
}

export function TerminalPayment({
  transactionId,
  amount,
  currency,
  status,
  formatMoney,
  onPaid,
  onShowQr,
  onCancelSale,
  onStateChange,
}: TerminalPaymentProps) {
  const [state, setStateRaw] = useState<TapState>({ kind: "connecting" });
  const [locationId, setLocationId] = useState(() => defaultTerminalLocationId(status));
  const alive = useRef(true);
  const stateRef = useRef<TapState>(state);
  const onPaidRef = useRef(onPaid);
  const onStateChangeRef = useRef(onStateChange);
  useEffect(() => {
    onPaidRef.current = onPaid;
    onStateChangeRef.current = onStateChange;
  }, [onPaid, onStateChange]);

  const setState = useCallback((next: TapState) => {
    if (!alive.current) return;
    stateRef.current = next;
    setStateRaw(next);
    onStateChangeRef.current?.(next);
    if (next.kind === "succeeded") onPaidRef.current(next);
  }, []);

  // Ask the server until it knows. Runs until it gets an answer that is not
  // "still going", or the screen goes away.
  const reconcile = useCallback(async () => {
    setState({ kind: "processing" });
    let openCount = 0;
    while (alive.current) {
      try {
        const answer = await terminalApi.state(transactionId);
        openCount = answer.state === "open" ? openCount + 1 : 0;
        const next = stateFromServer(answer, openCount);
        if (next.kind !== "processing") {
          setState(next);
          return;
        }
        setState({ kind: "processing" });
      } catch {
        // No answer is not a "no". Keep asking.
        setState({ kind: "unknown" });
      }
      await new Promise((resolve) => setTimeout(resolve, RECONCILE_INTERVAL_MS));
    }
  }, [setState, transactionId]);

  const run = useCallback(async () => {
    const plugin = nativeTerminal();
    if (!plugin) {
      setState({ kind: "failed", message: t("Tap to Pay isn't available on this device.") });
      return;
    }
    setState({ kind: "connecting" });
    let started;
    try {
      await connectThisPhone(locationId);
      started = await terminalApi.start(transactionId, locationId);
    } catch (error) {
      // Nothing has been tapped yet, so nothing can have been charged.
      setState({ kind: "failed", message: error instanceof Error ? error.message : t("Tap to Pay could not start.") });
      return;
    }
    if (started.state === "succeeded") {
      setState(stateFromServer(started, 0));
      return;
    }
    if (started.state === "processing") {
      await reconcile();
      return;
    }
    if (started.state !== "open" || !started.clientSecret) {
      setState({ kind: "failed", message: t("Tap to Pay could not start.") });
      return;
    }
    setState({ kind: "ready_to_tap" });
    const outcome = await plugin
      .collectPayment({ clientSecret: started.clientSecret })
      .catch((error: unknown) => ({
        outcome: "failed" as const,
        stage: "collect" as const,
        message: error instanceof Error ? error.message : t("The card could not be read."),
      }));
    const next = stateAfterCollect(outcome);
    if (next.kind === "processing") await reconcile();
    else setState(next);
  }, [locationId, reconcile, setState, transactionId]);

  useEffect(() => {
    alive.current = true;
    void run();
    return () => {
      alive.current = false;
    };
    // Starts once per sale. A location change restarts it through tryAgain.
  }, [transactionId]);

  // What the reader wants the customer to do ("Remove card", "Try another
  // card"), and the one-off setup Apple runs on a phone's first connection.
  useEffect(() => {
    const plugin = nativeTerminal();
    if (!plugin) return;
    const listeners = [
      plugin.addListener("readerMessage", ({ message }) => {
        if (stateRef.current.kind === "ready_to_tap" || stateRef.current.kind === "reading") {
          setState({ kind: "reading", message });
        }
      }),
      plugin.addListener("readerUpdate", ({ progress }) => {
        if (stateRef.current.kind === "connecting") setState({ kind: "connecting", progress });
      }),
    ];
    return () => {
      for (const listener of listeners) void Promise.resolve(listener).then((handle) => handle.remove());
    };
  }, [setState]);

  async function stopWaiting() {
    await nativeTerminal()?.cancel().catch(() => null);
  }

  function tryAgain() {
    void run();
  }

  async function showQr() {
    if (state.kind === "ready_to_tap") await stopWaiting();
    onShowQr();
  }

  const money = formatMoney(amount, currency);

  if (state.kind === "processing" || state.kind === "unknown") {
    return (
      <div className="pos-tap" aria-live="polite">
        <Loader2 className="pos-tap-spin" size={28} aria-hidden="true" />
        <strong className="pos-tap-amount">{money}</strong>
        <p className="pos-tap-title">{t("Checking payment…")}</p>
        <p className="field-help">{t("Do not charge again yet. This updates on its own.")}</p>
        {state.kind === "unknown" && <p className="field-help">{t("Waiting for a connection to Clarity.")}</p>}
      </div>
    );
  }

  if (state.kind === "succeeded") {
    // The caller swaps to its receipt the moment this happens.
    return null;
  }

  if (canRetry(state)) {
    const message =
      state.kind === "cancelled"
        ? t("Tap to Pay was cancelled. Nothing was charged.")
        : state.message;
    return (
      <div className="pos-tap" aria-live="polite">
        <AlertTriangle size={26} aria-hidden="true" />
        <strong className="pos-tap-amount">{money}</strong>
        <p className="pos-tap-title">
          {state.kind === "declined" ? t("Card declined") : state.kind === "cancelled" ? t("Not charged") : t("Couldn't use Tap to Pay")}
        </p>
        <p className="field-help">{message}</p>
        {status.locations.length > 1 && (
          <label className="pos-tap-location">
            <span>{t("Taking payments at")}</span>
            <select
              value={locationId}
              onChange={(event) => {
                setLocationId(event.target.value);
                saveTerminalLocation(event.target.value);
              }}
            >
              {status.locations.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="pos-tap-actions">
          <button className="primary-button" onClick={tryAgain} type="button">
            <RotateCcw size={15} />{" "}{t("Try again")}</button>
          <button className="outline-button" onClick={showQr} type="button">
            <QrCode size={15} />{" "}{t("Show payment QR")}</button>
          <button className="text-button" onClick={onCancelSale} type="button">{t("Cancel sale")}</button>
        </div>
      </div>
    );
  }

  const waiting = state.kind === "ready_to_tap" || state.kind === "reading";
  return (
    <div className="pos-tap" aria-live="polite">
      {waiting ? <Nfc className="pos-tap-icon" size={36} aria-hidden="true" /> : <Loader2 className="pos-tap-spin" size={28} aria-hidden="true" />}
      <strong className="pos-tap-amount">{money}</strong>
      {state.kind === "connecting" && (
        <>
          <p className="pos-tap-title">{t("Getting Tap to Pay ready…")}</p>
          {typeof state.progress === "number" && state.progress < 1 && (
            <p className="field-help">{t("Setting up this iPhone the first time ({value}%).", { value: Math.round(state.progress * 100) })}</p>
          )}
        </>
      )}
      {state.kind === "ready_to_tap" && (
        <>
          <p className="pos-tap-title">{t("Ready to tap")}</p>
          <p className="field-help">
            {onAndroid() ? t("Hold card or phone against the back of this phone.") : t("Hold card or phone near the top of this iPhone.")}
          </p>
        </>
      )}
      {state.kind === "reading" && <p className="pos-tap-title">{state.message}</p>}
      {status.testMode && <p className="pos-tap-test">{t("Test mode – no real money moves.")}</p>}
      <div className="pos-tap-actions">
        {state.kind !== "reading" && (
          <button className="outline-button" onClick={showQr} type="button">
            <QrCode size={15} />{" "}{t("Pay on customer phone")}</button>
        )}
        {state.kind === "ready_to_tap" && (
          <button className="text-button" onClick={stopWaiting} type="button">
            <X size={15} />{" "}{t("Stop")}</button>
        )}
      </div>
      {state.kind === "ready_to_tap" && <HowToTap />}
    </div>
  );
}
