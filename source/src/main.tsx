import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import PlayerPortal, { isPlayerPortalMode, isBookingHandoff } from "./modules/player-portal/PlayerPortal";
import { installOptixBookingFeedback } from "./optix-booking-feedback";
import { installOptixBookingMutationSync } from "./optix-booking-mutation-sync";
import { installOptixOriginFeedback } from "./optix-origin-feedback";
import "./styles.css";

// The player portal is a separate app personality (players.claritygolf.app or
// ?portal=player). Branch here so the full admin App and its hooks never mount
// in portal mode, and vice versa.
//
// The booking hand-off (?embed=booking) must win even on the portal host, so a
// signed-in player can jump straight into the pre-filled booking embed without
// the portal-host detection trapping them on the portal.
function selectRoot() {
  if (isBookingHandoff()) return <App />;
  if (isPlayerPortalMode()) return <PlayerPortal />;
  return <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>{selectRoot()}</StrictMode>,
);

// This compatibility hook remains installed but is intentionally a no-op.
// Clarity-origin resource bookings are created only by the admin card's
// explicit Book resource action.
if (!isPlayerPortalMode()) {
  installOptixBookingMutationSync();
}

// Resource configuration, manual booking feedback, and external-origin
// ownership indicators remain admin-only.
if (!isPlayerPortalMode() && !isBookingHandoff()) {
  installOptixBookingFeedback();
  installOptixOriginFeedback();
}
