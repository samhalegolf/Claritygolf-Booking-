// The Capacitor entry point.
//
// This is the same portal the website serves -- same components, same
// stylesheet, same API -- entered through a different door. src/main.tsx is
// the web door and routes coach and player from one login screen; this one
// only ever opens the portal, so a phone build never carries the coach
// workspace as its home screen.
//
// The only real difference is below the UI: a webview cannot hold the session
// cookie, so the token is read from native storage before the first request.
// See src/modules/auth/apiFetch.ts for why.

import { StrictMode, Suspense, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import LoginScreen from "./modules/auth/LoginScreen";
import { loadAuthToken, loadGuestToken } from "./modules/auth/apiFetch";
import { fetchSession, guestSession, signOut, type Session } from "./modules/auth/session";
import PlayerPortal from "./modules/player-portal/PlayerPortal";
// Tokens first: styles.css and every module stylesheet read --c-*.
import "./tokens.css";
import "./styles.css";
import "./nativeApp.css";

function Splash({ label }: { label: string }) {
  return (
    <main className="login-shell">
      <div className="login-card">
        <p>{label}</p>
      </div>
    </main>
  );
}

/**
 * A coach can sign in here -- their password is the same one -- so say plainly
 * that this is the wrong app rather than showing an empty portal or, worse,
 * trying to run the coach workspace on a phone.
 */
function CoachNotice({ onSignOut }: { onSignOut: () => void }) {
  return (
    <main className="login-shell">
      <div className="login-card">
        <h1>Coach account</h1>
        <p>
          This app is the player portal. Your coach workspace lives on the web
          — sign in there instead.
        </p>
        <button className="primary-button" type="button" onClick={onSignOut}>
          Sign Out
        </button>
      </div>
    </main>
  );
}

function Root() {
  // Guest is the default, not a loading state -- the terminal has something
  // useful to show with no session at all, so there is nothing worth blocking
  // the first paint on. This effect quietly upgrades to a real session if the
  // device has one stored; if it never resolves, the player just stays a
  // guest instead of staring at a spinner.
  const [session, setSession] = useState<Session>(guestSession);
  const [showLogin, setShowLogin] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        // Before anything asks the server who we are: without the stored token
        // every request goes out anonymous and the player is asked to sign in
        // again on every launch.
        await loadAuthToken();
        // A guest credential is not a session and never becomes one, but it
        // does have to survive a relaunch or the app would ask for a name and
        // an email again for every video.
        await loadGuestToken();
        const next = await fetchSession();
        if (!cancelled) setSession(next);
      } catch {
        // Already defaulted to guest above -- nothing else to do.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleSessionLost = useCallback(() => setSession(guestSession), []);

  const handleCoachSignOut = useCallback(() => {
    void signOut().then(() => setSession(guestSession));
  }, []);

  const handleSignedIn = useCallback((next: Session) => {
    setSession(next);
    setShowLogin(false);
  }, []);

  if (session.role === "player") {
    return (
      <Suspense fallback={<Splash label="Loading your profile…" />}>
        <PlayerPortal session={session} onSignedOut={handleSessionLost} />
      </Suspense>
    );
  }

  if (session.role === "coach") return <CoachNotice onSignOut={handleCoachSignOut} />;

  // Guest: nothing stored yet, but the terminal opens anyway -- the video
  // tool works right away and signing in is one tap from any locked tab,
  // not a wall in front of the whole app.
  if (showLogin) {
    return <LoginScreen onSignedIn={handleSignedIn} onCancel={() => setShowLogin(false)} />;
  }

  return (
    <Suspense fallback={<Splash label="Loading…" />}>
      <PlayerPortal
        session={session}
        onSignedOut={handleSessionLost}
        onRequestSignIn={() => setShowLogin(true)}
      />
    </Suspense>
  );
}

document.documentElement.classList.add("native-app");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
