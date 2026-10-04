import { useCallback, useEffect, useState } from "react";
import { ClarityNotifications } from "../shared/ClarityIcons";

import { disableNativePush, enableNativePush, loadNativePushStatus, type NativePushStatus } from "../../native/nativePush";
import { sendTestPush } from "./browserPush";
import { t, tn } from "../../lib/i18n";

/**
 * Settings → Email → notifications, inside the staff app: alerts on this
 * phone. The browser version (BrowserNotificationsPanel) cannot work in the
 * app's webview, which has no service worker, so the app shows this instead.
 */
export function PhoneNotificationsPanel() {
  const [status, setStatus] = useState<NativePushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const refresh = useCallback(async () => {
    try {
      setStatus(await loadNativePushStatus());
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

  return (
    <article className="data-card notification-card settings-section settings-notifications browser-push-card">
      <div className="data-card-header">
        <div>
          <span>{t("Notifications")}</span>
          <h2>{t("Phone notifications")}</h2>
        </div>
        <ClarityNotifications size={24} />
      </div>

      <p className="field-help">{t("Alerts on this phone when a client books, moves or cancels a lesson, and when a booking arrives from a system you've connected. Turn them on separately on each phone you want alerted.")}</p>

      {status === null ? (
        <p className="field-help">{t("Checking this phone…")}</p>
      ) : !status.configured ? (
        <p className="field-help">{t("Phone notifications are not set up on the server yet.")}</p>
      ) : (
        <>
          <div className="browser-push-state">
            <strong>{enabled ? t("On for this phone") : t("Off for this phone")}</strong>
            <span className="field-help">
              {status.deviceCount === 0
                ? t("No devices registered.")
                : tn(status.deviceCount, "{count} device registered on this account.", "{count} devices registered on this account.")}
            </span>
          </div>

          {status.permission === "denied" && !enabled ? (
            <p className="field-help">{t("Notifications are blocked for this app. Allow them in the phone's Settings, then try again.")}</p>
          ) : null}

          <div className="browser-push-actions">
            {enabled ? (
              <button
                type="button"
                className="outline-button"
                disabled={busy}
                onClick={() => void run(async () => setStatus(await disableNativePush()))}
              >{t("Turn off on this phone")}</button>
            ) : (
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => void run(async () => setStatus(await enableNativePush()))}
              >{t("Turn on for this phone")}</button>
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
