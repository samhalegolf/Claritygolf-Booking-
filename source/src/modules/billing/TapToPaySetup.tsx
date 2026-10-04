// Tap to Pay on this phone, from Settings.
//
// Only shows inside the staff app (iPhone or Android), for a business on Clarity Pay; when
// Tap to Pay can't be used there it says why instead of hiding. It is
// where a coach meets Tap to Pay before a customer is waiting: setting the
// phone up here is when Apple asks the business to accept its terms and does
// its one-off setup, and Apple's "How to Tap" guide is a tap away. Apple's
// review looks for both. On Android the same button does Stripe's first
// connection, so a customer is never kept waiting through it either.

import { useState, type ReactNode } from "react";
import { onAndroid } from "../../native/clarityTerminal";
import { HowToTap } from "./TerminalPayment";
import { defaultTerminalLocationId, prepareThisPhone, showHowToTap, useTapToPay } from "./terminal";
import { t } from "../../lib/i18n";

// `frame` is the collapsible group it sits in on Billing's Settings. Passed in
// rather than drawn here so that when there is nothing to say, no empty group
// is left behind.
export function TapToPaySetup({ frame }: { frame: (body: ReactNode) => ReactNode }) {
  const tapToPay = useTapToPay();
  const [state, setState] = useState<"idle" | "working" | "ready">("idle");
  const [error, setError] = useState("");
  if (!tapToPay.ready) {
    // Say why Tap to Pay is off rather than leaving the coach to guess.
    if (!tapToPay.reason) return null;
    return frame(<p className="field-help">{tapToPay.reason}</p>);
  }
  const { status } = tapToPay;
  const android = onAndroid();

  async function setUp() {
    setState("working");
    setError("");
    try {
      await prepareThisPhone(defaultTerminalLocationId(status));
      setState("ready");
      // The moment Tap to Pay is switched on is when Apple wants the guide shown.
      void showHowToTap();
    } catch (setupError) {
      setState("idle");
      setError(setupError instanceof Error ? setupError.message : t("Tap to Pay could not start."));
    }
  }

  return frame(
    <>
      <p className="field-help">
        {android
          ? t("Take contactless cards, Google Pay and other digital wallets on this phone. No extra hardware. Set it up once here, before your first sale, so this phone is ready when a customer is waiting.")
          : t("Take contactless cards, Apple Pay and other digital wallets on this iPhone. No extra hardware. Set it up once here, before your first sale: Apple asks you to accept its terms and gets this iPhone ready, which can take a minute or two.")}
      </p>
      {status.testMode && <p className="field-help">{t("Test mode – no real money moves.")}</p>}
      {state === "ready" && (
        <p className="field-help">{android ? t("This phone is ready for Tap to Pay.") : t("This iPhone is ready for Tap to Pay.")}</p>
      )}
      {error && <p className="field-help">{error}</p>}
      <div className="settings-field-row">
        <button className="primary-button" disabled={state === "working"} onClick={() => void setUp()} type="button">
          {state === "working" ? t("Setting up…") : android ? t("Set up this phone") : t("Set up this iPhone")}
        </button>
        <HowToTap />
      </div>
    </>,
  );
}
