// A client's memberships, on the Passes tab of their profile: what they are
// on, what they owe, and putting them on a plan. The credits a membership
// grants show in the passes list below this, like any other pass.

import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";

import { t } from "../../lib/i18n";
import { Loading } from "../shared/Loading";
import { MembershipCard } from "./MembershipCard";
import { intervalLabel, membershipsApi, type Membership, type MembershipsResponse } from "./membershipsApi";
import "./memberships.css";

export type PersonMembershipsProps = {
  personId: string;
  formatMoney: (amount: number, currency?: string) => string;
  notify: (message: string) => void;
  /** A paid period adds credits, so the passes list below should re-read. */
  onPassesChanged: () => void;
};

export function PersonMemberships({ personId, formatMoney, notify, onPassesChanged }: PersonMembershipsProps) {
  const [data, setData] = useState<MembershipsResponse | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "error">("loading");
  const [adding, setAdding] = useState(false);
  const [planId, setPlanId] = useState("");
  const [collection, setCollection] = useState<"card" | "manual">("manual");
  const [startDate, setStartDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [checkoutUrl, setCheckoutUrl] = useState("");

  const load = useCallback(async () => {
    setLoadState("loading");
    try {
      const next = await membershipsApi.load(personId);
      setData(next);
      setCollection(next.cardsReady ? "card" : "manual");
      setLoadState("loaded");
    } catch {
      setLoadState("error");
    }
  }, [personId]);

  useEffect(() => {
    setCheckoutUrl("");
    setAdding(false);
    void load();
  }, [load]);

  const changed = (updated: Membership) => {
    setData((current) =>
      current ? { ...current, memberships: current.memberships.map((m) => (m.id === updated.id ? updated : m)) } : current,
    );
    onPassesChanged();
  };

  async function enrol() {
    if (!planId) {
      notify(t("Choose a plan."));
      return;
    }
    setBusy(true);
    try {
      const result = await membershipsApi.enrol({ personId, planId, collection, startDate: startDate || undefined });
      setData((current) => (current ? { ...current, memberships: [result.membership, ...current.memberships] } : current));
      setAdding(false);
      setPlanId("");
      onPassesChanged();
      if (result.checkoutUrl) {
        setCheckoutUrl(result.checkoutUrl);
        try {
          await navigator.clipboard.writeText(result.checkoutUrl);
          notify(t("Membership created. The card link is copied — send it to them to start billing."));
        } catch {
          notify(t("Membership created. Send them the card link below to start billing."));
        }
      } else {
        notify(t("Membership started."));
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : t("Could not start that membership."));
    } finally {
      setBusy(false);
    }
  }

  if (loadState === "loading" && !data) return <Loading what={t("memberships")} />;
  if (loadState === "error" && !data) {
    return (
      <p>
        {t("Could not load memberships.")}{" "}
        <button className="link-button" type="button" onClick={() => void load()}>
          {t("Retry")}
        </button>
      </p>
    );
  }
  if (!data) return null;

  const current = data.memberships.filter((m) => m.status !== "cancelled" && m.status !== "ended");
  const past = data.memberships.filter((m) => m.status === "cancelled" || m.status === "ended");
  const joinable = data.plans.filter((plan) => plan.active);

  return (
    <section className="person-memberships">
      <div className="person-memberships-head">
        <h3>{t("Memberships")}</h3>
        {!adding && joinable.length ? (
          <button type="button" className="outline-button" onClick={() => setAdding(true)}>
            <Plus size={14} /> {t("Add membership")}
          </button>
        ) : null}
      </div>

      {adding ? (
        <div className="membership-enrol">
          <div className="membership-form-grid">
            <label className="settings-field">
              <span>{t("Plan")}</span>
              <select value={planId} onChange={(event) => setPlanId(event.target.value)}>
                <option value="">{t("Choose a plan")}</option>
                {joinable.map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.name} · {formatMoney(plan.priceCents / 100, plan.currency)} {intervalLabel(plan.interval, plan.intervalCount)}
                  </option>
                ))}
              </select>
            </label>
            <label className="settings-field">
              <span>{t("Starts")}</span>
              <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
            </label>
            <label className="settings-field">
              <span>{t("Payment")}</span>
              <select value={collection} onChange={(event) => setCollection(event.target.value as "card" | "manual")}>
                {data.cardsReady ? <option value="card">{t("Card, charged automatically")}</option> : null}
                <option value="manual">{t("By hand (cash, bank transfer)")}</option>
              </select>
            </label>
          </div>
          <p className="field-help">
            {collection === "card"
              ? t("You'll get a link for them to save a card. The first payment is taken then, and each period after that automatically.")
              : t("Each period raises a charge for you to mark paid. Its credits are added when you do.")}
          </p>
          <div className="membership-actions">
            <button type="button" className="primary-button" disabled={busy} onClick={() => void enrol()}>
              {busy ? t("Starting…") : t("Start membership")}
            </button>
            <button type="button" className="outline-button" onClick={() => setAdding(false)}>
              {t("Back")}
            </button>
          </div>
        </div>
      ) : null}

      {checkoutUrl ? (
        <div className="settings-field membership-card-link">
          <span>{t("Card link")}</span>
          <input readOnly value={checkoutUrl} onFocus={(event) => event.currentTarget.select()} />
        </div>
      ) : null}

      {current.map((m) => (
        <MembershipCard key={m.id} membership={m} formatMoney={formatMoney} onChanged={changed} notify={notify} />
      ))}
      {!current.length && !adding ? (
        <p className="field-help">
          {joinable.length ? t("Not on a membership.") : t("No membership plans yet. Create one in Billing › Memberships.")}
        </p>
      ) : null}
      {past.length ? (
        <p className="field-help">
          {t("Past: {plans}", { plans: past.map((m) => m.plan.name).join(", ") })}
        </p>
      ) : null}
    </section>
  );
}
