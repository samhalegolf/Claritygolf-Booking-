// The Putting Lab page in the staff app (its own item in the main menu).
//
// The lab itself is native and full screen; this page only opens it, links
// the printable template, and shows the headline of the session just closed.
// It renders nothing outside the staff app (see nativePuttingLab), and App
// only offers the menu item there. Putts are
// not saved anywhere yet: joining them to players, lessons and reports is the
// next piece of work, once the measurements have been validated on a green.

import { useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import {
  nativePuttingLab,
  PUTTING_LAB_TEMPLATE_URL,
  type PuttingConsistency,
  type PuttingSpread,
} from "../../native/clarityPuttingLab";
import "./puttingLab.css";

function signedDegrees(spread?: PuttingSpread): string {
  if (!spread) return "–";
  const mean = spread.mean.toFixed(1);
  return `${spread.mean > 0 ? "+" : ""}${mean}° ±${spread.standardDeviation.toFixed(1)}°`;
}

export default function PuttingLabLauncher() {
  const plugin = nativePuttingLab();
  const [lastSession, setLastSession] = useState<{ count: number; consistency: PuttingConsistency } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!plugin) return;
    const listener = plugin.addListener("closed", ({ strokes, consistency }) => {
      setLastSession({ count: strokes.length, consistency });
    });
    return () => {
      void Promise.resolve(listener).then((l) => l.remove());
    };
  }, [plugin]);

  if (!plugin) return null;

  const open = () => {
    setError("");
    plugin.open({}).catch((reason: unknown) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(t("The Putting Lab could not open: {message}", { message }));
    });
  };

  return (
    <section className="putting-lab-launcher" aria-label={t("Putting Lab")}>
      <div className="putting-lab-launcher-text">
        <p>{t("Face, path and start line from an overhead camera. Calibrate once with the printed template, then putt.")}</p>
        {lastSession && lastSession.count > 0 && (
          <p className="putting-lab-launcher-session">
            {t("Last session: {count} putts", { count: lastSession.count })}
            {" · "}
            {t("Average face {face}, path {path}, start {start}", {
              face: signedDegrees(lastSession.consistency.face),
              path: signedDegrees(lastSession.consistency.path),
              start: signedDegrees(lastSession.consistency.start),
            })}
          </p>
        )}
        {error && <p className="putting-lab-launcher-error" role="alert">{error}</p>}
      </div>
      <div className="putting-lab-launcher-actions">
        <button type="button" className="primary-button" onClick={open}>
          {t("Open Putting Lab")}
        </button>
        <a className="text-button" href={PUTTING_LAB_TEMPLATE_URL} target="_blank" rel="noreferrer">
          {t("Print the calibration template")}
        </a>
      </div>
    </section>
  );
}
