import { StrictMode, Suspense, lazy, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import LoginScreen from "./modules/auth/LoginScreen";
import { fetchSession, guestSession, type Session } from "./modules/auth/session";
import { isBookingEmbedMode } from "./modules/shared/bookingHandoff";
import { installOptixBookingFeedback } from "./optix-booking-feedback";
import { installOptixBookingMutationSync } from "./optix-booking-mutation-sync";
import { installOptixOriginFeedback } from "./optix-origin-feedback";
import "./styles.css";

// Both shells are lazy so a player never downloads the coach workspace, and a
// visitor at the login screen downloads neither. This is why the login form
// lives in its own module rather than inside App.
const App = lazy(() => import("./App"));
const PlayerPortal = lazy(() => import("./modules/player-portal/PlayerPortal"));

// The booking embed is public by design -- it is the widget clients book
// through, and a signed-in player handing off to book must reach it too. It
// wins over everything below, including any session.
const bookingEmbed = isBookingEmbedMode();

let adminHooksInstalled = false;

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
 * Who is signed in decides which app runs.
 *
 * This used to be decided by hostname: players.claritygolf.app got the portal,
 * everything else got the admin app, and each had its own login. Now the server
 * answers /api/auth/session with a role and this routes on it, so one login
 * screen leads to two apps. The portal hostname still works -- it just is not
 * the mechanism any more.
 */
function Root() {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    if (bookingEmbed) return;
    let cancelled = false;
    void fetchSession().then((next) => {
      if (!cancelled) setSession(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Admin-only document hooks, installed once the coach shell is actually the
  // thing being rendered. They hook the document rather than React, so they
  // cannot live inside App -- but a player must never get them.
  useEffect(() => {
    if (bookingEmbed || session?.role !== "coach" || adminHooksInstalled) return;
    adminHooksInstalled = true;
    // This compatibility hook remains installed but is intentionally a no-op.
    // Clarity-origin resource bookings are created only by the admin card's
    // explicit Book resource action.
    installOptixBookingMutationSync();
    installOptixBookingFeedback();
    installOptixOriginFeedback();
  }, [session?.role]);

  // App calls this when the server rejects it mid-session (an expired or
  // revoked cookie), which drops straight back to the login screen instead of
  // leaving a workspace on screen that can no longer save anything.
  const handleSessionLost = useCallback(() => setSession(guestSession), []);

  if (bookingEmbed) {
    return (
      <Suspense fallback={<Splash label="Loading booking…" />}>
        <App />
      </Suspense>
    );
  }

  if (!session) return <Splash label="Checking session…" />;

  if (session.role === "coach") {
    return (
      <Suspense fallback={<Splash label="Loading your workspace…" />}>
        <App onSessionLost={handleSessionLost} />
      </Suspense>
    );
  }

  if (session.role === "player") {
    return (
      <Suspense fallback={<Splash label="Loading your profile…" />}>
        <PlayerPortal session={session} onSignedOut={handleSessionLost} />
      </Suspense>
    );
  }

  return <LoginScreen onSignedIn={setSession} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
