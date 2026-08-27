import { StrictMode, Suspense, lazy, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import LoginScreen from "./modules/auth/LoginScreen";
import { fetchSession, guestSession, type Session } from "./modules/auth/session";
import { isBookingEmbedMode, isPlayerBookingMode, isVideoShareMode } from "./modules/shared/bookingHandoff";
import { installOptixBookingFeedback } from "./optix-booking-feedback";
import { installOptixBookingMutationSync } from "./optix-booking-mutation-sync";
import { installOptixOriginFeedback } from "./optix-origin-feedback";
import { installBoxAudit } from "./lib/boxAudit";
// Tokens first: styles.css and every module stylesheet read --c-*.
import "./tokens.css";
import "./styles.css";
// After styles.css: the app-wide switch settles the ties with the per-screen
// rules that used to size these as tick boxes.
import "./switches.css";

// The nesting law is a property of the rendered page, not the stylesheet, so
// it is checked in the browser rather than by uiRules.test.ts. Dev only.
installBoxAudit();

// Both shells are lazy so a player never downloads the coach workspace, and a
// visitor at the login screen downloads neither. This is why the login form
// lives in its own module rather than inside App.
const App = lazy(() => import("./App"));
const PlayerPortal = lazy(() => import("./modules/player-portal/PlayerPortal"));
const VideoSharePage = lazy(() => import("./modules/video-share/VideoSharePage"));

// The booking embed is public by design -- it is the widget clients book
// through. It wins over everything below, including any session.
//
// Player booking is the same widget entered from the Player Terminal. It is
// the one booking entry that waits for the session, because the whole point is
// that the player is already signed in and is not asked again.
const bookingEmbed = isBookingEmbedMode();
const playerBooking = isPlayerBookingMode();
const publicBookingOnly = bookingEmbed && !playerBooking;
// The coach's emailed link to a video a guest sent them. Like the booking
// embed it wins over everything below, including any session -- the token is
// the credential, and asking a coach to log in to watch one video is exactly
// the friction the link exists to remove.
const videoShare = isVideoShareMode();

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
    // The share page never asks who is looking -- that is the whole point of
    // it -- so it must not make a session call either.
    if (publicBookingOnly || videoShare) return;
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
    // (bookingEmbed covers player booking too: the widget never wants them.)
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

  if (videoShare) {
    return (
      <Suspense fallback={<Splash label="Loading video…" />}>
        <VideoSharePage />
      </Suspense>
    );
  }

  if (publicBookingOnly) {
    return (
      <Suspense fallback={<Splash label="Loading booking…" />}>
        <App />
      </Suspense>
    );
  }

  if (!session) return <Splash label="Checking session…" />;

  // A player always gets the terminal, booking included. The portal renders
  // booking inside its own shell rather than handing the page over, so the
  // navigation bar survives the trip.
  if (session.role === "player") {
    return (
      <Suspense fallback={<Splash label="Loading your profile…" />}>
        <PlayerPortal session={session} onSignedOut={handleSessionLost} />
      </Suspense>
    );
  }

  // Everyone else who lands on the player-booking URL -- a shared link, an
  // expired cookie, a coach -- gets the ordinary public widget rather than a
  // login wall. The parameter asked; the session decided.
  if (bookingEmbed) {
    return (
      <Suspense fallback={<Splash label="Loading booking…" />}>
        <App />
      </Suspense>
    );
  }

  if (session.role === "coach") {
    return (
      <Suspense fallback={<Splash label="Loading your workspace…" />}>
        <App onSessionLost={handleSessionLost} />
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
