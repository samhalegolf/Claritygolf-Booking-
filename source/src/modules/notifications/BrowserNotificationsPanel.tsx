import { useCallback, useEffect, useState } from "react";
import { BellRing } from "lucide-react";

import { disablePush, enablePush, loadPushStatus, sendTestPush, type PushStatus } from "./browserPush";

/**
 * Settings → Email → Browser notifications.
 *
 * Self-contained on purpose: it owns its own loading, errors and per-device
 * state rather than threading five more pieces of state through App.tsx, which
 * is already carrying the whole workspace.
 */
export default function BrowserNotificationsPanel() {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const refresh = useCallback(async () => {
    try {
      setStatus(await loadPushStatus());
    } catch {
      setError("Could not read notification settings.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const enabled = status?.enabled === true;
  const blocked = status?.permission === "denied";

  return (
    <article className="data-card notification-card settings-section settings-email browser-push-card">
      <div className="data-card-header">
        <div>
          <span>Notifications</span>
          <h2>Browser notifications</h2>
        </div>
        <BellRing size={24} />
      </div>

      <p className="field-help">
        Pop-ups next to your browser when a client books, moves or cancels a lesson, and when a booking arrives from
        Optix. They work with the browser closed. Turn them on separately on each device you want alerted.
      </p>

      {status === null ? (
        <p className="field-help">Checking this browser…</p>
      ) : !status.supported ? (
        <p className="field-help">
          {status.needsHomeScreenInstall
            ? "On iPhone and iPad, add Clarity to the home screen first — Safari only allows notifications for an installed app."
            : "This browser cannot show notifications."}
        </p>
      ) : !status.configured ? (
        <p className="field-help">
          Notifications are not set up on the server yet. Add the VAPID keys in Netlify and redeploy.
        </p>
      ) : (
        <>
          <div className="browser-push-state">
            <strong>{enabled ? "On for this browser" : "Off for this browser"}</strong>
            <span className="field-help">
              {status.deviceCount === 0
                ? "No devices registered."
                : `${status.deviceCount} device${status.deviceCount === 1 ? "" : "s"} registered on this account.`}
            </span>
          </div>

          {blocked && !enabled ? (
            <p className="field-help">
              Notifications are blocked for this site. Allow them in the browser's site settings, then try again.
            </p>
          ) : null}

          <div className="browser-push-actions">
            {enabled ? (
              <button
                type="button"
                className="outline-button"
                disabled={busy}
                onClick={() => void run(async () => setStatus(await disablePush()))}
              >
                Turn off on this browser
              </button>
            ) : (
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => void run(async () => setStatus(await enablePush()))}
              >
                Turn on for this browser
              </button>
            )}
            <button
              type="button"
              className="outline-button"
              disabled={busy || status.deviceCount === 0}
              onClick={() =>
                void run(async () => {
                  const result = await sendTestPush();
                  setNote(
                    result.sent > 0
                      ? `Test sent to ${result.sent} device${result.sent === 1 ? "" : "s"}.`
                      : "No device accepted the test. Try turning notifications off and on again.",
                  );
                })
              }
            >
              Send a test
            </button>
          </div>
        </>
      )}

      {error ? <p className="browser-push-error">{error}</p> : null}
      {note ? <p className="field-help">{note}</p> : null}
    </article>
  );
}
