// The banner shown when the coach comes back from Stripe's Clarity Pay signup.
import { AlertCircle, Check, X } from "lucide-react";
import { t } from "../../lib/i18n";

/**
 * How Stripe's Clarity Pay signup went, when the browser has just come back
 * from it. The server sends the coach to the page they started on with
 * `clarityPay=on|pending|error` (stripe-connect.mts); the page shows it once.
 */
export type ClarityPayReturn = "on" | "pending" | "error" | "paused";

/**
 * "paused" never comes from the server: it is the coach coming back to Clarity
 * (the Back button, usually) before finishing Stripe's signup. Nothing is lost
 * by that — the account Stripe started is kept — so it says so calmly and
 * offers the way back in.
 */
export function ClarityPayReturnBanner({
  outcome,
  onDismiss,
  onContinue,
  busy,
}: {
  outcome: ClarityPayReturn;
  onDismiss: () => void;
  onContinue: () => void;
  busy: boolean;
}) {
  const [title, message] =
    outcome === "on"
      ? [t("Clarity Pay is on"), t("Card payments now go straight to your account, and Stripe pays them out to your bank.")]
      : outcome === "pending"
        ? [t("Almost there"), t("Stripe is still checking your details, or needs a few more. Clarity Pay switches on by itself once Stripe is done.")]
        : outcome === "paused"
          ? [t("Clarity Pay setup is paused"), t("You left Stripe's signup before the end. Nothing is lost: carry on where you stopped whenever you're ready.")]
          : [t("Clarity Pay isn't set up"), t("Stripe's signup didn't finish. You can start it again now.")];
  return (
    <div className={`clarity-pay-return is-${outcome}`} role="status">
      <span className="clarity-pay-return-icon" aria-hidden="true">
        {outcome === "on" ? <Check size={18} /> : <AlertCircle size={18} />}
      </span>
      <div>
        <strong>{title}</strong>
        <span>{message}</span>
        {outcome !== "on" && (
          <div className="clarity-pay-return-actions">
            <button className="primary-button" disabled={busy} onClick={onContinue} type="button">
              {busy ? t("Opening…") : outcome === "error" ? t("Set up Clarity Pay") : t("Finish Clarity Pay setup")}
            </button>
          </div>
        )}
      </div>
      <button className="icon-button" onClick={onDismiss} title={t("Dismiss")} aria-label={t("Dismiss")} type="button">
        <X size={16} />
      </button>
    </div>
  );
}
