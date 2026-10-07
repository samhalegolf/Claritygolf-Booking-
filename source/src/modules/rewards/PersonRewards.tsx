// A client's standing in each rewards programme, on the Passes tab of their
// profile. Read-only: what they have earned already sits in the passes list
// below as a pass like any other, and this only answers "how close is the
// next one". Renders nothing when the business runs no programme.

import { useEffect, useState } from "react";

import { t, tn } from "../../lib/i18n";
import { formatMoney } from "../../lib/money";
import { rewardsApi, type PersonRewardProgress } from "./rewardsApi";
import "../memberships/memberships.css";

export function PersonRewards({ personId }: { personId: string }) {
  const [progress, setProgress] = useState<PersonRewardProgress[]>([]);

  useEffect(() => {
    let cancelled = false;
    setProgress([]);
    rewardsApi
      .progress(personId)
      .then((data) => {
        if (!cancelled) setProgress(Array.isArray(data.progress) ? data.progress : []);
      })
      // Rewards are extra information on this tab; failing to read them must
      // not get in the way of the passes underneath.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [personId]);

  if (!progress.length) return null;

  return (
    <div className="memberships-panel person-rewards">
      <div className="membership-plans">
      {progress.map((entry) => {
        const money = entry.trigger === "amount_spent";
        const value = (amount: number) => (money ? formatMoney(amount / 100) : String(amount));
        return (
          <div key={entry.programId} className="membership-plan">
            <div>
              <strong>{entry.name}</strong>
              <span className="membership-meta">
                {entry.capped
                  ? t("Every reward earned")
                  : money
                    ? t("{done} of {needed} spent towards the next reward", {
                        done: value(entry.intoCurrent),
                        needed: value(entry.threshold),
                      })
                    : t("{done} of {needed} lessons towards the next reward", {
                        done: entry.intoCurrent,
                        needed: entry.threshold,
                      })}
              </span>
              <progress
                className="reward-progress-bar"
                max={entry.threshold}
                value={entry.capped ? entry.threshold : entry.intoCurrent}
              />
            </div>
            <span className="membership-tags">
              <em>{tn(entry.earned, "1 reward earned", "{count} rewards earned")}</em>
            </span>
          </div>
        );
      })}
      </div>
    </div>
  );
}
