import { useCallback, useEffect, useState } from "react";
import { ClarityNotifications } from "../shared/ClarityIcons";

import { disablePush, enablePush, loadPushStatus, sendTestPush, type PushStatus } from "./browserPush";
import { t, tn } from "../../lib/i18n";

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
      setError(t("Could not read notification settings."));
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
      setError(caught instanceof Error ? caught.message : t("Something went wrong."));
    } finally {
      setBusy(false);
    }
  }

  const enabled = status?.enabled === true;
  const blocked = status?.permission === "denied";

  return (
    <article className="data-card notification-card settings-section settings-notifications browser-push-card">
      <div className="data-card-header">
        <div>
          <span>{t("Notifications")}</span>
          <h2>{t("Browser notifications")}</h2>
        </div>
        <ClarityNotifications size={24} />
      </div>

      <p className="field-help">{t("Pop-ups next to your browser when a client books, moves or cancels a lesson, and when a booking arrives from a system you've connected. They work with the browser closed. Turn them on separately on each device you want alerted.")}</p>

      {status === null ? (
        <p className="field-help">{t("Checking this browser…")}</p>
      ) : !status.supported ? (
        <p className="field-help">
          {status.needsHomeScreenInstall
            ? t("On iPhone and iPad, add Clarity to the home screen first — Safari only allows notifications for an installed app.")
            : t("This browser cannot show notifications.")}
        </p>
      ) : !status.configured ? (
        <p className="field-help">{t("Notifications are not set up on the server yet. Add the VAPID keys in Netlify and redeploy.")}</p>
      ) : (
        <>
          <div className="browser-push-state">
            <strong>{enabled ? t("On for this browser") : t("Off for this browser")}</strong>
            <span className="field-help">
              {status.deviceCount === 0
                ? t("No devices registered.")
                : tn(status.deviceCount, "{count} device registered on this account.", "{count} devices registered on this account.")}
            </span>
          </div>

          {blocked && !enabled ? (
            <p className="field-help">{t("Notifications are blocked for this site. Allow them in the browser's site settings, then try again.")}</p>
          ) : null}

          <div className="browser-push-actions">
            {enabled ? (
              <button
                type="button"
                className="outline-button"
                disabled={busy}
                onClick={() => void run(async () => setStatus(await disablePush()))}
              >{t("Turn off on this browser")}</button>
            ) : (
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => void run(async () => setStatus(await enablePush()))}
              >{t("Turn on for this browser")}</button>
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
                      ? tn(result.sent, "Test sent to {count} device.", "Test sent to {count} devices.")
                      : t("No device accepted the test. Try turning notifications off and on again."),
                  );
                })
              }
            >{t("Send a test")}</button>
          </div>
        </>
      )}

      {error ? <p className="browser-push-error">{error}</p> : null}
      {note ? <p className="field-help">{note}</p> : null}
    </article>
  );
}
