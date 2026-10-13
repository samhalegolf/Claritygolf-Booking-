// Where the "confirm your new email" link lands.
//
// The change runs on a tap rather than on page load. Mail scanners open links
// to check them, and a change that ran on load would go through before the
// player ever saw the email.

import "../../appStyles";
import { useState } from "react";
import { apiFetch } from "./apiFetch";
import { storedBrandStyle, storedThemeMode } from "./LoginScreen";
import { t } from "../../lib/i18n";

export default function ConfirmEmailScreen({ token }: { token: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmedEmail, setConfirmedEmail] = useState("");

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await apiFetch("/api/player/email-change/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = (await response.json().catch(() => ({}))) as { message?: string; email?: string };
      if (!response.ok) throw new Error(data.message || t("Could not change the email."));
      setConfirmedEmail(data.email || "");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Could not change the email."));
    } finally {
      setBusy(false);
    }
  }

  function carryOn() {
    // Drop the token from the address bar so a reload does not ask again.
    window.location.replace(window.location.pathname);
  }

  return (
    <main className={`login-shell theme-${storedThemeMode()}`} style={storedBrandStyle()}>
      <div className="login-card">
        <div className="brand">
          <div className="brand-mark">
            <img src="/assets/clarity-golf-logo-208.webp" alt={t("Clarity Golf")} width={208} height={208} />
          </div>
          <div>
            <strong>{t("Clarity Golf")}</strong>
            <span>{t("Booking System")}</span>
          </div>
        </div>
        <div>
          <h1>{confirmedEmail ? t("Email changed") : t("Confirm your new email")}</h1>
          <p>
            {confirmedEmail
              ? t("From now on, sign in with {email}.", { email: confirmedEmail })
              : t("This finishes changing the email you sign in with. It is your Clarity Caddy sign-in email too.")}
          </p>
        </div>
        {error && <div className="auth-error">{error}</div>}
        {confirmedEmail ? (
          <button className="primary-button" type="button" onClick={carryOn}>{t("Continue")}</button>
        ) : (
          <button className="primary-button" type="button" disabled={busy} onClick={() => void confirm()}>
            {busy ? t("Saving") : t("Confirm new email")}
          </button>
        )}
      </div>
    </main>
  );
}
