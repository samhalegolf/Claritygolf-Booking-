import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from "react";

import { sessionFromLoginResponse, type Session } from "./session";

// The single front door. It used to live inside App.tsx, which meant a player
// had to download the whole coach workspace just to reach a sign-in form. It is
// standalone now: the entry point renders this for anyone with no session, and
// only loads the coach app or the player portal once the server says which one
// they are.
//
// Styling comes from the existing .login-shell / .login-card rules in
// styles.css, so this looks exactly like the screen it replaces.

type AuthMode = "login" | "forgot" | "reset" | "invite";

const THEME_STORAGE_KEY = "clarity-booking-theme";
const BRAND_STORAGE_KEY = "clarity-booking-brand";

function storedThemeMode(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
}

// Pre-auth there is no brand API call to make, so the login screen reuses
// whatever the last signed-in session stored. A first-time visitor just gets
// the stylesheet defaults.
function storedBrandStyle(): CSSProperties {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(BRAND_STORAGE_KEY);
    if (!raw) return {};
    const brand = JSON.parse(raw) as Record<string, unknown>;
    const variable = (name: string, value: unknown) =>
      typeof value === "string" && value ? { [name]: value } : {};
    return {
      ...variable("--coach-neutral", brand.neutral),
      ...variable("--coach-primary", brand.primary),
      ...variable("--coach-secondary", brand.secondary),
      ...variable("--coach-accent", brand.accent),
    } as CSSProperties;
  } catch {
    return {};
  }
}

function searchParam(name: string) {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get(name) ?? "";
}

function clearQueryString() {
  if (typeof window === "undefined") return;
  window.history.replaceState(null, "", window.location.pathname);
}

export type LoginScreenProps = {
  onSignedIn: (session: Session) => void;
};

export default function LoginScreen({ onSignedIn }: LoginScreenProps) {
  const [themeMode] = useState(storedThemeMode);
  const [brandStyle] = useState(storedBrandStyle);

  const [resetToken] = useState(() => searchParam("reset"));
  const [inviteToken] = useState(() => searchParam("portalInvite"));
  const [mode, setMode] = useState<AuthMode>(() =>
    searchParam("portalInvite") ? "invite" : searchParam("reset") ? "reset" : "login",
  );

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotSent, setForgotSent] = useState(false);

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [inviteState, setInviteState] = useState<"checking" | "valid" | "invalid">("checking");
  const [inviteEmail, setInviteEmail] = useState("");

  // An invite link is only worth showing a form for if the token is still good.
  const checkInvite = useCallback(async () => {
    if (!inviteToken) return;
    try {
      const response = await fetch(`/api/portal/invite?token=${encodeURIComponent(inviteToken)}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const data = (await response.json().catch(() => ({}))) as {
        valid?: boolean;
        email?: string;
        message?: string;
      };
      if (data?.valid) {
        setInviteState("valid");
        setInviteEmail(data.email || "");
      } else {
        setInviteState("invalid");
        setError(data?.message || "That invite link has expired. Ask your coach to send a new one.");
      }
    } catch {
      setInviteState("invalid");
      setError("Could not reach the booking server.");
    }
  }, [inviteToken]);

  useEffect(() => {
    void checkInvite();
  }, [checkInvite]);

  async function submitLogin(loginEmail: string, loginPassword: string) {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email: loginEmail, password: loginPassword }),
    });
    const data = (await response.json().catch(() => ({}))) as {
      authenticated?: boolean;
      role?: string;
      email?: string;
      name?: string;
      message?: string;
    };
    if (!response.ok || !data.authenticated) {
      throw new Error(data.message || "Email or password is incorrect.");
    }
    return sessionFromLoginResponse(data);
  }

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const session = await submitLogin(email.trim(), password);
      setPassword("");
      onSignedIn(session);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Login failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleForgot(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email: forgotEmail.trim() }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (!response.ok || !data.ok) {
        setError(data.message || "Could not send the reset email.");
        return;
      }
      setForgotSent(true);
      setNotice(data.message || "If that email matches an account, a reset link has been sent.");
    } catch {
      setError("Could not reach the booking server.");
    } finally {
      setBusy(false);
    }
  }

  async function handleReset(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (newPassword.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Those passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ token: resetToken, password: newPassword }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        authenticated?: boolean;
        role?: string;
        email?: string;
        message?: string;
      };
      if (!response.ok || !data.authenticated) {
        setError(data.message || "Could not reset password.");
        return;
      }
      clearQueryString();
      // The reset route only ever signs a coach in.
      onSignedIn(sessionFromLoginResponse({ ...data, role: data.role || "coach" }));
    } catch {
      setError("Could not reach the booking server.");
    } finally {
      setBusy(false);
    }
  }

  // Setting a password from an invite signs the player straight in with the
  // password they just chose -- making them type it again on a login form would
  // be a pointless extra step.
  async function handleInvite(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (newPassword.length < 10) {
      setError("Use at least 10 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Those passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/portal/set-password", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ token: inviteToken, password: newPassword }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        email?: string;
        message?: string;
      };
      if (!response.ok || !data.ok) {
        setError(data.message || "Could not set that password.");
        return;
      }
      const session = await submitLogin(data.email || inviteEmail, newPassword);
      clearQueryString();
      onSignedIn(session);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not set that password.");
    } finally {
      setBusy(false);
    }
  }

  const eyebrow =
    mode === "forgot"
      ? "Password Reset"
      : mode === "reset"
        ? "New Password"
        : mode === "invite"
          ? "Player Portal"
          : "Sign In";

  const heading =
    mode === "forgot"
      ? "Forgot password"
      : mode === "reset"
        ? "Reset password"
        : mode === "invite"
          ? "Set your password"
          : "Welcome back";

  const lead =
    mode === "forgot"
      ? "Enter your email and we will send a reset link."
      : mode === "reset"
        ? "Choose a new password for Clarity Golf Booking."
        : mode === "invite"
          ? inviteEmail
            ? `Choose a password for ${inviteEmail}.`
            : "Choose a password for your player portal."
          : "Sign in to your Clarity Golf account.";

  const onSubmit =
    mode === "forgot"
      ? handleForgot
      : mode === "reset"
        ? handleReset
        : mode === "invite"
          ? handleInvite
          : handleLogin;

  const submitLabel = busy
    ? mode === "forgot"
      ? "Sending"
      : mode === "login"
        ? "Signing In"
        : "Saving"
    : mode === "forgot"
      ? forgotSent
        ? "Sent"
        : "Send Reset Link"
      : mode === "reset"
        ? "Save New Password"
        : mode === "invite"
          ? "Set Password And Sign In"
          : "Sign In";

  return (
    <main className={`login-shell theme-${themeMode}`} style={brandStyle}>
      <form className="login-card" onSubmit={onSubmit}>
        <div className="brand">
          <div className="brand-mark">
            <img src="/assets/clarity-golf-logo.png" alt="Clarity Golf" />
          </div>
          <div>
            <strong>Clarity Golf</strong>
            <span>Booking System</span>
          </div>
        </div>
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h1>{heading}</h1>
          <p>{lead}</p>
        </div>

        {mode === "login" && (
          <>
            <label>
              <span>Email</span>
              <input
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                type="email"
                autoComplete="email"
              />
            </label>
            <label>
              <span>Password</span>
              <input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
              />
            </label>
            <label className="show-password-toggle">
              <input
                checked={showPassword}
                onChange={(event) => setShowPassword(event.target.checked)}
                type="checkbox"
              />
              <span>Show password</span>
            </label>
          </>
        )}

        {mode === "forgot" && (
          <label>
            <span>Email</span>
            <input
              value={forgotEmail}
              onChange={(event) => {
                setForgotEmail(event.target.value);
                setForgotSent(false);
                setNotice("");
                setError("");
              }}
              type="email"
              autoComplete="email"
            />
          </label>
        )}

        {(mode === "reset" || (mode === "invite" && inviteState === "valid")) && (
          <>
            <label>
              <span>New password</span>
              <input
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
              />
            </label>
            <label>
              <span>Confirm password</span>
              <input
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
              />
            </label>
            <label className="show-password-toggle">
              <input
                checked={showPassword}
                onChange={(event) => setShowPassword(event.target.checked)}
                type="checkbox"
              />
              <span>Show password</span>
            </label>
          </>
        )}

        {error && <div className="auth-error">{error}</div>}
        {notice && <div className="auth-success">{notice}</div>}

        {!(mode === "invite" && inviteState !== "valid") && (
          <button className="primary-button" type="submit" disabled={busy}>
            {submitLabel}
          </button>
        )}

        {mode === "login" ? (
          <button
            className="text-button"
            type="button"
            onClick={() => {
              setMode("forgot");
              setForgotEmail(email);
              setError("");
            }}
          >
            Forgot password?
          </button>
        ) : (
          <button
            className="text-button"
            type="button"
            onClick={() => {
              setMode("login");
              setError("");
              setNotice("");
            }}
          >
            Back to sign in
          </button>
        )}
      </form>
    </main>
  );
}
