import { useEffect } from "react";

import { t } from "../../lib/i18n";
import "./publicSite.css";

/**
 * Where a customer's phone lands after paying at the counter by QR (Stripe
 * Checkout's success and cancel addresses). The customer is not signed in and
 * is usually a stranger, so this is a plain public page: no login screen, no
 * Clarity marketing. The till settles the sale on its own; nothing here does.
 */
export default function PaymentReturnPage({ outcome }: { outcome: "paid" | "cancelled" }) {
  const receipt = new URLSearchParams(window.location.search).get("receipt") || "";
  const paid = outcome === "paid";

  useEffect(() => {
    document.title = paid ? t("Payment received") : t("Payment cancelled");
  }, [paid]);

  return (
    <div className="public-site-shell">
      <main className="public-site-main">
        <article className="public-legal">
          <h1>{paid ? t("Payment received") : t("Payment cancelled")}</h1>
          <p>
            {paid
              ? t("Thanks, your payment has gone through. You can close this page.")
              : t("Nothing was charged. You can close this page, or scan the code again to pay another way.")}
          </p>
          {receipt ? <p className="public-eyebrow">{t("Receipt {receipt}", { receipt })}</p> : null}
        </article>
      </main>
    </div>
  );
}
