// The player's Account tab: who they are, their password, and the settings
// that belong to them rather than to their coach.
//
// A guest gets the settings half only -- there is no account behind them yet,
// but they still read the portal in a language and a theme.

import { useState, type FormEvent } from "react";
import { apiFetch } from "../auth/apiFetch";
import { LanguageSelect } from "../settings/LanguageSettings";
import type { PortalTheme } from "./portalTheme";
import { t } from "../../lib/i18n";

export type PlayerAccountPanelProps = {
  guest: boolean;
  name: string;
  email: string;
  phone: string;
  /** After the server has saved new details, so the rest of the portal says the new name. */
  onDetailsSaved: (details: { name: string; phone: string }) => void;
  theme: PortalTheme;
  onThemeChange: (theme: PortalTheme) => void;
  onSignedOut: () => void;
  onRequestSignIn?: () => void;
};

async function postJson(path: string, body?: unknown) {
  const response = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { response, data };
}

export function PlayerAccountPanel({
  guest,
  name,
  email,
  phone,
  onDetailsSaved,
  theme,
  onThemeChange,
  onSignedOut,
  onRequestSignIn,
}: PlayerAccountPanelProps) {
  return (
    <div className="player-account">
      {guest ? (
        <section className="player-portal-section">
          <h2>{t("Your account")}</h2>
          <p className="player-portal-lead">{t("Sign in to manage your name, contact details and password.")}</p>
          <button className="player-portal-primary player-account-action" type="button" onClick={() => onRequestSignIn?.()}>
            {t("Sign in")}
          </button>
        </section>
      ) : (
        <>
          <DetailsForm name={name} email={email} phone={phone} onSaved={onDetailsSaved} onSignedOut={onSignedOut} />
          <PasswordForm onSignedOut={onSignedOut} />
        </>
      )}

      <section className="player-portal-section">
        <h2>{t("Account settings")}</h2>
        <div className="player-account-settings">
          <LanguageSelect />
          <label className="settings-field">
            <span>{t("Appearance")}</span>
            <select value={theme} onChange={(event) => onThemeChange(event.target.value as PortalTheme)}>
              <option value="system">{t("Same as this device")}</option>
              <option value="light">{t("Light")}</option>
              <option value="dark">{t("Dark")}</option>
            </select>
          </label>
        </div>
        {!guest && <DeleteAccount onSignedOut={onSignedOut} />}
      </section>
    </div>
  );
}

function DetailsForm({
  name,
  email,
  phone,
  onSaved,
  onSignedOut,
}: {
  name: string;
  email: string;
  phone: string;
  onSaved: PlayerAccountPanelProps["onDetailsSaved"];
  onSignedOut: () => void;
}) {
  const [draftName, setDraftName] = useState(name);
  const [draftPhone, setDraftPhone] = useState(phone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const changed = draftName.trim() !== name || draftPhone.trim() !== phone;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !changed) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const { response, data } = await postJson("/api/player/account", {
        name: draftName.trim(),
        phone: draftPhone.trim(),
      });
      if (response.status === 401) return onSignedOut();
      if (!response.ok) throw new Error(String(data.message || "") || t("We couldn't save your details."));
      const player = (data.player || {}) as { name?: string; phone?: string };
      const next = { name: player.name || draftName.trim(), phone: player.phone || "" };
      setDraftName(next.name);
      setDraftPhone(next.phone);
      onSaved(next);
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("We couldn't save your details."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="player-portal-section player-account-form" onSubmit={(event) => void save(event)}>
      <h2>{t("Your details")}</h2>
      <label className="player-portal-field">
        <span>{t("Name")}</span>
        <input
          value={draftName}
          autoComplete="name"
          required
          onChange={(event) => {
            setDraftName(event.target.value);
            setSaved(false);
          }}
        />
      </label>
      <label className="player-portal-field">
        <span>{t("Phone")}</span>
        <input
          type="tel"
          value={draftPhone}
          autoComplete="tel"
          onChange={(event) => {
            setDraftPhone(event.target.value);
            setSaved(false);
          }}
        />
      </label>
      <label className="player-portal-field">
        <span>{t("Email")}</span>
        <input type="email" value={email} readOnly disabled />
      </label>
      <p className="player-account-hint">{t("Your email is how you sign in. To change it, ask your coach.")}</p>
      <button className="player-portal-primary player-account-action" type="submit" disabled={busy || !changed || !draftName.trim()}>
        {busy ? t("Saving…") : t("Save details")}
      </button>
      {saved && <p className="player-account-success" role="status">{t("Details saved.")}</p>}
      {error && <p className="player-portal-error-line" role="alert">{error}</p>}
    </form>
  );
}

function PasswordForm({ onSignedOut }: { onSignedOut: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setDone(false);
    if (next.length < 8) return setError(t("Use at least 8 characters."));
    if (next !== confirm) return setError(t("The new passwords don't match."));
    setBusy(true);
    try {
      const { response, data } = await postJson("/api/player/change-password", {
        currentPassword: current,
        newPassword: next,
      });
      if (response.status === 401) return onSignedOut();
      if (!response.ok) throw new Error(String(data.message || "") || t("Could not change password."));
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Could not change password."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="player-portal-section player-account-form" onSubmit={(event) => void submit(event)}>
      <h2>{t("Password")}</h2>
      <label className="player-portal-field">
        <span>{t("Current password")}</span>
        <input type="password" value={current} autoComplete="current-password" required onChange={(event) => setCurrent(event.target.value)} />
      </label>
      <label className="player-portal-field">
        <span>{t("New password")}</span>
        <input type="password" value={next} autoComplete="new-password" required onChange={(event) => setNext(event.target.value)} />
      </label>
      <label className="player-portal-field">
        <span>{t("Confirm new password")}</span>
        <input type="password" value={confirm} autoComplete="new-password" required onChange={(event) => setConfirm(event.target.value)} />
      </label>
      <p className="player-account-hint">{t("If you use Clarity Caddy, this changes your password there too.")}</p>
      <button className="player-portal-primary player-account-action" type="submit" disabled={busy || !current || !next || !confirm}>
        {busy ? t("Saving…") : t("Change password")}
      </button>
      {done && <p className="player-account-success" role="status">{t("Password changed. Other devices have been signed out.")}</p>}
      {error && <p className="player-portal-error-line" role="alert">{error}</p>}
    </form>
  );
}

function DeleteAccount({ onSignedOut }: { onSignedOut: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function requestDeletion() {
    if (busy) return;
    const confirmed = window.confirm(
      t(
        "Request deletion of your Clarity Player account and associated personal data? Some booking or payment records may be retained where legally required. We will email you when the review is complete.",
      ),
    );
    if (!confirmed) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const { response, data } = await postJson("/api/player/account-deletion");
      if (response.status === 401) return onSignedOut();
      if (!response.ok) throw new Error(String(data.message || "") || t("Could not submit the deletion request."));
      setMessage(
        t("Request received. We will review it and email you within {value} days.", {
          value: Number(data.expectedCompletionDays) || 7,
        }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Could not submit the deletion request."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="player-account-danger">
      <button
        className="player-account-deletion-toggle"
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
          setError("");
        }}
      >
        {t("Delete account")}
      </button>
      {open && (
        <div className="player-account-deletion" role="region" aria-label={t("Delete account")}>
          <strong>{t("Delete your account")}</strong>
          <p>{t("This requests deletion of your player login and associated personal data. We review booking and payment records before removal because some records may need to be retained by law. Your Clarity Caddy login may use the same identity and will be included in that review.")}</p>
          {message ? (
            <p className="player-account-deletion-success" role="status">{message}</p>
          ) : (
            <button className="player-account-deletion-submit" type="button" disabled={busy} onClick={() => void requestDeletion()}>
              {busy ? t("Submitting…") : t("Request account deletion")}
            </button>
          )}
          {error && <p className="player-portal-error-line" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
