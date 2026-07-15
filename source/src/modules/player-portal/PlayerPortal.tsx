import { useCallback, useEffect, useState, type FormEvent } from "react";

import "./playerPortal.css";

// The portal is its own app personality (like the public booking embed), served
// from players.claritygolf.app. The ?portal=player flag is a fallback so it is
// testable before that subdomain's DNS/Netlify config is in place.
const PLAYER_PORTAL_HOST = "players.claritygolf.app";

export function isPlayerPortalMode(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.location.hostname === PLAYER_PORTAL_HOST ||
    new URLSearchParams(window.location.search).get("portal") === "player"
  );
}

type PortalStatus = "checking" | "guest" | "authenticated";

export default function PlayerPortal() {
  const [status, setStatus] = useState<PortalStatus>("checking");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [playerEmail, setPlayerEmail] = useState("");

  const checkSession = useCallback(async () => {
    try {
      const res = await fetch("/api/player/session", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const data = (await res.json().catch(() => ({}))) as {
        authenticated?: boolean;
        player?: { email?: string };
      };
      if (data?.authenticated) {
        setPlayerEmail(data.player?.email || "");
        setStatus("authenticated");
      } else {
        setStatus("guest");
      }
    } catch {
      setStatus("guest");
    }
  }, []);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    if (loginBusy) return;
    setLoginBusy(true);
    setLoginError("");
    try {
      const res = await fetch("/api/player/login", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email: email.trim(), phone: phone.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        authenticated?: boolean;
        message?: string;
        player?: { email?: string };
      };
      if (!res.ok || data?.authenticated !== true) {
        throw new Error(data?.message || "We couldn't log you in. Check your details and try again.");
      }
      setPlayerEmail(data.player?.email || email.trim());
      setStatus("authenticated");
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Login failed. Please try again.");
    } finally {
      setLoginBusy(false);
    }
  }

  async function handleLogout() {
    try {
      await fetch("/api/player/logout", { method: "POST", credentials: "same-origin", cache: "no-store" });
    } catch {
      // Best-effort; clear local state regardless so the UI returns to login.
    }
    setStatus("guest");
    setEmail("");
    setPhone("");
    setPlayerEmail("");
  }

  if (status === "checking") {
    return (
      <div className="player-portal">
        <div className="player-portal-card player-portal-loading">
          <span className="player-portal-spinner" aria-hidden="true" />
          <p>Loading your profile…</p>
        </div>
      </div>
    );
  }

  if (status === "guest") {
    return (
      <div className="player-portal">
        <form className="player-portal-card" onSubmit={handleLogin}>
          <div className="player-portal-brand">
            <strong>Clarity Golf</strong>
            <span>Player Portal</span>
          </div>
          <h1>Sign in</h1>
          <p className="player-portal-lead">
            Enter the email and phone number you used to book your lessons.
          </p>
          <label className="player-portal-field">
            <span>Email</span>
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
            />
          </label>
          <label className="player-portal-field">
            <span>Phone</span>
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="021 123 4567"
              required
            />
          </label>
          {loginError && (
            <p className="player-portal-error" role="alert">
              {loginError}
            </p>
          )}
          <button className="player-portal-primary" type="submit" disabled={loginBusy}>
            {loginBusy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="player-portal">
      <div className="player-portal-card">
        <div className="player-portal-header">
          <div className="player-portal-brand">
            <strong>Clarity Golf</strong>
            <span>Player Portal</span>
          </div>
          <button className="player-portal-ghost" type="button" onClick={() => void handleLogout()}>
            Sign out
          </button>
        </div>
        <h1>You're signed in</h1>
        {playerEmail && <p className="player-portal-lead">{playerEmail}</p>}
        <p className="player-portal-lead">Your bookings and lesson notes will appear here.</p>
      </div>
    </div>
  );
}
