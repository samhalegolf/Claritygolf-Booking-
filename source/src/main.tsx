import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import PlayerPortal, { isPlayerPortalMode } from "./modules/player-portal/PlayerPortal";
import "./styles.css";

// The player portal is a separate app personality (players.claritygolf.app or
// ?portal=player). Branch here so the full admin App and its hooks never mount
// in portal mode, and vice versa.
createRoot(document.getElementById("root")!).render(
  <StrictMode>{isPlayerPortalMode() ? <PlayerPortal /> : <App />}</StrictMode>,
);
