// The player's memberships, and the plans they could join. Sits at the top of
// the Passes tab: a membership is where their recurring credits come from, so
// it belongs beside the passes it fills.
//
// Prices, terms and whether they may cancel all come from the server
// (readPlayerMemberships in _shared/memberships.mts). Joining and changing a
// card go to Stripe's own page, so no card details touch this app.

import { useState } from "react";

import { t, tn } from "../../lib/i18n";
import { apiFetch } from "../auth/apiFetch";
import { formatDate } from "./format";

type Interval = "week" | "month" | "year";

export type PlayerMembership = {
  id: string;
  name: string;
  description: string;
  status: "trialing" | "active" | "past_due" | "paused";
  priceCents: number;
  currency: string;
  interval: Interval;
  intervalCount: number;
  collection: "card" | "manual";
  cardLabel: string;
  currentPeriodEnd: string | null;
  nextChargeAt: string | null;
  cancelAtPeriodEnd: boolean;
  mayCancel: boolean;
  minCycles: number;
  outstandingCents: number;
  entitlements: Array<{ name: string; credits: number }>;
};

export type PlayerMembershipPlan = {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  interval: Interval;
  intervalCount: number;
  signupFeeCents: number;
  trialDays: number;
  termCycles: number | null;
  minCycles: number;
  entitlements: Array<{ name: string; credits: number }>;
};

const money = (cents: number, currency: string) => `${currency} ${(cents / 100).toFixed(2)}`;

function per(interval: Interval, count: number) {
  if (interval === "week") return tn(count, "a week", "every {count} weeks");
  if (interval === "year") return tn(count, "a year", "every {count} years");
  return tn(count, "a month", "every {count} months");
}

function gives(entitlements: Array<{ name: string; credits: number }>) {
  return entitlements
    .map((entry) => tn(entry.credits, "{count} × {name}", "{count} × {name}", { name: entry.name }))
    .join(" · ");
}

export function PlayerMemberships({
  memberships,
  plans,
  canBuy,
  onChanged,
}: {
  memberships: PlayerMembership[];
  plans: PlayerMembershipPlan[];
  /** False in the App Store build: it never sells or links out to buy. */
  canBuy: boolean;
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState("");
  const [note, setNote] = useState("");

  async function post(path: string, body: Record<string, unknown>, busy: string) {
    setBusyId(busy);
    setNote("");
    try {
      const response = await apiFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await response.json().catch(() => ({}))) as { url?: string; message?: string };
      if (!response.ok) throw new Error(data.message || t("Something went wrong."));
      if (data.url) {
        window.location.assign(data.url);
        return;
      }
      onChanged();
      setBusyId("");
    } catch (error) {
      setNote(error instanceof Error ? error.message : t("Something went wrong."));
      setBusyId("");
    }
  }

  const visiblePlans = canBuy ? plans : [];
  if (!memberships.length && !visiblePlans.length) return null;

  return (
    <section className="player-portal-section">
      <h2>{memberships.length ? t("Your membership") : t("Memberships")}</h2>
      {note ? (
        <p className="player-portal-purchase-note" role="status">
          {note}
        </p>
      ) : null}

      {memberships.length ? (
        <ul className="player-portal-list">
          {memberships.map((m) => (
            <li className="player-portal-pass" key={m.id}>
              <div className="player-portal-pass-head">
                <strong>{m.name}</strong>
                <span className="player-portal-pass-count">
                  {money(m.priceCents, m.currency)} {per(m.interval, m.intervalCount)}
                </span>
              </div>
              {m.entitlements.length ? (
                <span className="player-portal-pass-meta">
                  {t("Each period: {gives}", { gives: gives(m.entitlements) })}
                </span>
              ) : null}
              <span className="player-portal-pass-meta">
                {m.status === "paused"
                  ? t("Paused. Talk to your coach to pick it back up.")
                  : m.cancelAtPeriodEnd && m.currentPeriodEnd
                    ? t("Ends {date}. You won't be charged again.", { date: formatDate(m.currentPeriodEnd) })
                    : m.nextChargeAt
                      ? m.status === "trialing"
                        ? t("Free trial until {date}.", { date: formatDate(m.nextChargeAt) })
                        : t("Renews {date}.", { date: formatDate(m.nextChargeAt) })
                      : ""}
                {m.collection === "card" && m.cardLabel ? ` ${t("Paid with {card}.", { card: m.cardLabel })}` : ""}
              </span>
              {m.status === "past_due" ? (
                <span className="player-portal-pass-meta player-portal-membership-alert">
                  {t("Your last payment didn't go through. We'll try again soon, or you can use a different card.")}
                </span>
              ) : m.outstandingCents > 0 && m.collection === "manual" ? (
                <span className="player-portal-pass-meta">
                  {t("{amount} to pay your coach.", { amount: money(m.outstandingCents, m.currency) })}
                </span>
              ) : null}
              <div className="player-portal-membership-actions">
                {canBuy && m.collection === "card" && m.status !== "paused" ? (
                  <button
                    type="button"
                    className="player-portal-ghost"
                    disabled={Boolean(busyId)}
                    onClick={() => void post("/api/player/memberships/card", { membershipId: m.id }, `card-${m.id}`)}
                  >
                    {busyId === `card-${m.id}` ? t("Opening…") : t("Change card")}
                  </button>
                ) : null}
                {m.cancelAtPeriodEnd ? (
                  <button
                    type="button"
                    className="player-portal-ghost"
                    disabled={Boolean(busyId)}
                    onClick={() => void post("/api/player/memberships/cancel", { membershipId: m.id, undo: true }, `undo-${m.id}`)}
                  >
                    {t("Keep my membership")}
                  </button>
                ) : m.status !== "paused" ? (
                  m.mayCancel ? (
                    <button
                      type="button"
                      className="player-portal-ghost"
                      disabled={Boolean(busyId)}
                      onClick={() => {
                        if (!window.confirm(t("Cancel {name}? It stays active until the end of this period.", { name: m.name }))) return;
                        void post("/api/player/memberships/cancel", { membershipId: m.id }, `cancel-${m.id}`);
                      }}
                    >
                      {t("Cancel membership")}
                    </button>
                  ) : (
                    <span className="player-portal-pass-meta">
                      {tn(m.minCycles, "You can cancel after your first payment.", "You can cancel after {count} payments.")}
                    </span>
                  )
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {visiblePlans.length ? (
        <>
          {memberships.length ? <h3 className="player-portal-subhead">{t("Other memberships")}</h3> : null}
          <ul className="player-portal-list">
            {visiblePlans.map((plan) => (
              <li className="player-portal-shop-item" key={plan.id}>
                <div className="player-portal-shop-main">
                  <strong>{plan.name}</strong>
                  {plan.entitlements.length ? <span>{t("Each period: {gives}", { gives: gives(plan.entitlements) })}</span> : null}
                  {plan.description ? <span>{plan.description}</span> : null}
                  <span>
                    {[
                      plan.trialDays ? tn(plan.trialDays, "{count}-day free trial", "{count}-day free trial") : "",
                      plan.signupFeeCents ? t("{amount} joining fee", { amount: money(plan.signupFeeCents, plan.currency) }) : "",
                      plan.termCycles ? tn(plan.termCycles, "{count} payment", "{count} payments") : "",
                      plan.minCycles ? tn(plan.minCycles, "Minimum {count} payment", "Minimum {count} payments") : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
                <button
                  className="player-portal-primary player-portal-shop-buy"
                  type="button"
                  disabled={Boolean(busyId)}
                  onClick={() => void post("/api/player/memberships/join", { planId: plan.id }, `join-${plan.id}`)}
                >
                  {busyId === `join-${plan.id}`
                    ? t("Opening…")
                    : `${money(plan.priceCents, plan.currency)} ${per(plan.interval, plan.intervalCount)}`}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
