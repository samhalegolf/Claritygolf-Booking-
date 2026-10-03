// Settings > Sandbox.
//
// Where the sandbox is created, entered, and given a plan to run on. Leaving it
// is the bar's job, not this panel's -- you can be anywhere in the app when you
// want out.
//
// The plan selector is not a convenience. A sandbox is its own account with its
// own planKey, so assertAccountFeature and assertAccountLimit enforce it for
// real in there. Setting it to `solo` is how a coach on `studio` finds out what
// their smallest customers actually run into, which is the class of bug that
// otherwise reaches someone who is paying.

import { lazy, Suspense, useEffect, useState } from "react";

import type { AccountMarketConfig } from "../../../netlify/functions/_shared/market-profile.mts";
import type { BusinessTerminology } from "../../../netlify/functions/_shared/business-terminology.mts";

import {
  createSandbox,
  fetchSandboxStatus,
  setSandboxPlan,
  switchWorkspace,
  SANDBOX_PLAN_KEYS,
  type SandboxPlanKey,
  type SandboxStatus,
} from "./sandboxApi";
import "./sandbox.css";
import { t } from "../../lib/i18n";

// Only inside the sandbox, so a live workspace never downloads it.
const MarketProfileBuilder = lazy(() => import("./MarketProfileBuilder"));

const PLAN_LABELS: Record<SandboxPlanKey, string> = {
  solo: t("Solo — 1 coach, 1 location, 10 lesson types"),
  studio: t("Studio — 5 coaches, 3 locations, invoicing, branding"),
  academy: t("Academy — everything, 20 coaches"),
  enterprise: t("Enterprise — everything, no practical limits"),
  founder: t("Founder — everything, no practical limits"),
};

export type SandboxPanelProps = {
  onMarketChange?: (config: AccountMarketConfig, terminology: BusinessTerminology) => void;
};

export default function SandboxPanel({ onMarketChange }: SandboxPanelProps = {}) {
  const [status, setStatus] = useState<SandboxStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchSandboxStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("That did not work."));
    } finally {
      setBusy(false);
    }
  }

  if (error && !status) return <p className="sandbox-panel__error">{error}</p>;
  if (!status) return <p className="sandbox-panel__lede">{t("Checking…")}</p>;

  return (
    <>
      <p className="sandbox-panel__lede">{t("Your tenant test space: a brand-new business on Clarity, walled off from this one. It starts empty — no lesson types, no hours, no integrations — and has its own booking page, so you can set it up and book into it the way a new coach would. Nothing from this workspace shows up in it.")}</p>

      {status.sandbox ? (
        <>
          <div className="sandbox-panel__row">
            <button
              type="button"
              className="primary"
              disabled={busy || status.inSandbox}
              onClick={() => run(() => switchWorkspace(status.sandbox!.id))}
            >
              {status.inSandbox ? t("You are in the sandbox") : t("Enter sandbox")}
            </button>
            <label className="settings-field">
              <span>{t("Plan it runs on")}</span>
              <select
                value={status.sandbox.planKey}
                disabled={busy}
                onChange={(event) => {
                  const planKey = event.target.value as SandboxPlanKey;
                  setStatus({ ...status, sandbox: { ...status.sandbox!, planKey } });
                  void run(async () => {
                    await setSandboxPlan(planKey);
                    setStatus(await fetchSandboxStatus());
                  });
                }}
              >
                {SANDBOX_PLAN_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {PLAN_LABELS[key]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="sandbox-panel__note">{t("Everyone on this business shares this one sandbox. Dropping to a smaller plan keeps anything already over its limit and refuses the next one — the same thing a coach who downgrades sees.")}</p>
          {/* The industry builder edits the account it runs in, so it is only
              offered from inside the sandbox -- never against the live one. */}
          {status.inSandbox ? (
            <Suspense fallback={null}>
              <MarketProfileBuilder onMarketChange={onMarketChange} />
            </Suspense>
          ) : null}
        </>
      ) : (
        <>
          <div className="sandbox-panel__row">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await createSandbox();
                  setStatus(await fetchSandboxStatus());
                })
              }
            >
              {busy ? t("Creating…") : t("Create sandbox")}
            </button>
          </div>
          <p className="sandbox-panel__note">{t("It starts with your country, timezone and currency and two demo players. Everything else you set up yourself, through the real screens.")}</p>
        </>
      )}

      {error ? <p className="sandbox-panel__error">{error}</p> : null}
    </>
  );
}
