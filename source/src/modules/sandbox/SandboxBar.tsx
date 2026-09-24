// The bar that says you are not in the real workspace.
//
// Rendered from main.tsx above whichever shell the session role chose, so the
// coach workspace and the player terminal both get it without either layout
// knowing it exists. It is fixed-position and adds its own height as body
// padding, which is what lets it sit above two full-height layouts that share
// no markup.
//
// It is deliberately unmissable. A sandbox looks exactly like the live
// workspace -- that is the entire point of it -- so the only thing standing
// between a tester and an afternoon of work filed in the wrong place is this.

import { useEffect, useState } from "react";
import { FlaskConical } from "lucide-react";

import {
  continueAsPlayer,
  fetchSandboxPlayers,
  returnToCoach,
  switchWorkspace,
  type SandboxPlayer,
} from "./sandboxApi";
import "./sandbox.css";

export type SandboxBarProps = {
  /**
   * The live business to go back to. Empty during a player handoff -- the way
   * out of one is back to the coach, not straight to the live workspace.
   */
  liveAccountId?: string;
  /** Set during a handoff: the player the coach is currently viewing as. */
  viewingAs?: string;
};

export default function SandboxBar({ liveAccountId = "", viewingAs }: SandboxBarProps) {
  const [busy, setBusy] = useState(false);
  const [players, setPlayers] = useState<SandboxPlayer[] | null>(null);
  const impersonating = Boolean(viewingAs);

  useEffect(() => {
    document.body.classList.add("has-sandbox-bar");
    return () => document.body.classList.remove("has-sandbox-bar");
  }, []);

  // Every action here ends in a navigation, so "finished" means the page went
  // away. Reaching the finally means it did not, and the only recovery needed is
  // to let the coach try again -- nothing was changed and they are still safely
  // inside the sandbox.
  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  }

  async function openPicker() {
    if (players) {
      setPlayers(null);
      return;
    }
    await run(async () => setPlayers(await fetchSandboxPlayers()));
  }

  return (
    <div className="sandbox-bar" role="status">
      <span className="sandbox-bar__mark">
        <FlaskConical size={14} aria-hidden="true" />
        Test tenant
      </span>
      <span className="sandbox-bar__detail">
        {impersonating ? (
          <>
            Viewing as <strong>{viewingAs}</strong>
          </>
        ) : (
          <>A fresh business, walled off from your live workspace. Emails and bookings made here are real.</>
        )}
      </span>
      <span className="sandbox-bar__actions">
        {impersonating ? (
          <button
            type="button"
            className="sandbox-bar__action sandbox-bar__action--leave"
            disabled={busy}
            onClick={() => run(returnToCoach)}
          >
            {busy ? "Returning…" : "Return to coach"}
          </button>
        ) : (
          <>
            {players ? (
              <select
                className="sandbox-bar__picker"
                defaultValue=""
                disabled={busy}
                onChange={(event) => {
                  const personId = event.target.value;
                  if (personId) void run(() => continueAsPlayer(personId));
                }}
              >
                <option value="">Choose a player…</option>
                {players.map((player) => (
                  <option key={player.id} value={player.id}>
                    {player.name || player.email || player.id}
                  </option>
                ))}
              </select>
            ) : null}
            <button
              type="button"
              className="sandbox-bar__action"
              disabled={busy}
              onClick={() => void openPicker()}
            >
              {players ? "Cancel" : "Continue as player"}
            </button>
            <button
              type="button"
              className="sandbox-bar__action sandbox-bar__action--leave"
              disabled={busy || !liveAccountId}
              onClick={() => run(() => switchWorkspace(liveAccountId))}
            >
              {busy ? "Leaving…" : "Leave sandbox"}
            </button>
          </>
        )}
      </span>
    </div>
  );
}
