// Tap to Pay on this iPhone, from Settings.
//
// Only shows inside the staff iPhone app, for a business on Clarity Pay; when
// Tap to Pay can't be used there it says why instead of hiding. It is
// where a coach meets Tap to Pay before a customer is waiting: setting the
// phone up here is when Apple asks the business to accept its terms and does
// its one-off setup, and Apple's "How to Tap" guide is a tap away. Apple's
// review looks for both.

import { useState } from "react";
import { Nfc } from "lucide-react";
import { HowToTap } from "./TerminalPayment";
import { defaultTerminalLocationId, prepareThisIphone, showHowToTap, useTapToPay } from "./terminal";
import { t } from "../../lib/i18n";

export function TapToPaySetup() {
  const tapToPay = useTapToPay();
  const [state, setState] = useState<"idle" | "working" | "ready">("idle");
  const [error, setError] = useState("");
  if (!tapToPay.ready) {
    // Say why Tap to Pay is off rather than leaving the coach to guess.
    if (!tapToPay.reason) return null;
    return (
      <article className="data-card">
        <TapToPayHeader />
        <p className="field-help">{tapToPay.reason}</p>
      </article>
    );
  }
  const { status } = tapToPay;

  async function setUp() {
    setState("working");
    setError("");
    try {
      await prepareThisIphone(defaultTerminalLocationId(status));
      setState("ready");
      // The moment Tap to Pay is switched on is when Apple wants the guide shown.
      void showHowToTap();
    } catch (setupError) {
      setState("idle");
      setError(setupError instanceof Error ? setupError.message : t("Tap to Pay could not start."));
    }
  }

  return (
    <article className="data-card">
      <TapToPayHeader />
      <p className="field-help">
        {t("Take contactless cards, Apple Pay and other digital wallets on this iPhone. No extra hardware. Set it up once here, before your first sale: Apple asks you to accept its terms and gets this iPhone ready, which can take a minute or two.")}
      </p>
      {status.testMode && <p className="field-help">{t("Test mode – no real money moves.")}</p>}
      {state === "ready" && <p className="field-help">{t("This iPhone is ready for Tap to Pay.")}</p>}
      {error && <p className="field-help">{error}</p>}
      <div className="settings-field-row">
        <button className="primary-button" disabled={state === "working"} onClick={() => void setUp()} type="button">
          {state === "working" ? t("Setting up…") : t("Set up this iPhone")}
        </button>
        <HowToTap />
      </div>
    </article>
  );
}

function TapToPayHeader() {
  return (
    <div className="data-card-header">
      <div>
        <span>{t("On this iPhone")}</span>
        <h2>{t("Tap to Pay on iPhone")}</h2>
      </div>
      <Nfc size={24} />
    </div>
  );
}
