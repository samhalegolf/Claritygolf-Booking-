// Billing › Memberships: the plans for sale, everybody on one, and what the
// recurring billing has collected. Self-contained -- it loads and changes its
// own data through /api/memberships -- so App.tsx only mounts it.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";

import { t, tn } from "../../lib/i18n";
import { Loading } from "../shared/Loading";
import { MembershipCard } from "./MembershipCard";
import { PlanEditor, type CoverableService } from "./PlanEditor";
import {
  dateLabel,
  intervalLabel,
  membershipsApi,
  statusLabel,
  statusPillClass,
  type Membership,
  type MembershipPlan,
  type MembershipsResponse,
} from "./membershipsApi";
import "./memberships.css";

export type MembershipsPanelProps = {
  services: CoverableService[];
  formatMoney: (amount: number, currency?: string) => string;
  notify: (message: string) => void;
  onOpenPerson: (personId: string) => void;
};

type Filter = "live" | "attention" | "all" | "ended";

export function MembershipsPanel({ services, formatMoney, notify, onOpenPerson }: MembershipsPanelProps) {
  const [data, setData] = useState<MembershipsResponse | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "error">("loading");
  const [editing, setEditing] = useState<MembershipPlan | "new" | null>(null);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState<Filter>("live");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState("");

  const load = useCallback(async () => {
    setLoadState("loading");
    try {
      setData(await membershipsApi.load());
      setLoadState("loaded");
    } catch {
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const memberships = data?.memberships || [];
  const shown = useMemo(() => {
    const query = search.trim().toLowerCase();
    return memberships.filter((m) => {
      if (query && !`${m.personName} ${m.plan.name}`.toLowerCase().includes(query)) return false;
      if (filter === "live") return ["trialing", "active", "past_due", "paused", "incomplete"].includes(m.status);
      if (filter === "attention") return m.status === "past_due" || m.outstandingCents > 0 || m.status === "incomplete";
      if (filter === "ended") return m.status === "cancelled" || m.status === "ended";
      return true;
    });
  }, [memberships, filter, search]);

  const replace = (updated: Membership) =>
    setData((current) =>
      current ? { ...current, memberships: current.memberships.map((m) => (m.id === updated.id ? updated : m)) } : current,
    );

  async function savePlan(plan: Partial<MembershipPlan>) {
    setSaving(true);
    try {
      const { plans } = await membershipsApi.savePlan(plan);
      setData((current) => (current ? { ...current, plans } : current));
      setEditing(null);
      notify(t("Plan saved."));
    } catch (error) {
      notify(error instanceof Error ? error.message : t("Could not save that plan."));
    } finally {
      setSaving(false);
    }
  }

  async function retirePlan(plan: MembershipPlan) {
    if (!window.confirm(t("Retire {name}? Nobody new can join it. Existing members keep billing until they cancel.", { name: plan.name }))) return;
    try {
      const { plans } = await membershipsApi.archivePlan(plan.id);
      setData((current) => (current ? { ...current, plans } : current));
      notify(t("Plan retired."));
    } catch (error) {
      notify(error instanceof Error ? error.message : t("Could not retire that plan."));
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

  const summary = data.summary;
  const moneyList = (list: Array<{ currency: string; cents: number }>) =>
    list.length ? list.map((entry) => formatMoney(entry.cents / 100, entry.currency)).join(" + ") : formatMoney(0, data.currency);

  if (editing) {
    return (
      <div className="memberships-panel">
        <article className="data-card wide">
          <PlanEditor
            plan={editing === "new" ? null : editing}
            currency={data.currency}
            services={services}
            cardsReady={data.cardsReady}
            saving={saving}
            onSave={(plan) => void savePlan(plan)}
            onCancel={() => setEditing(null)}
          />
        </article>
      </div>
    );
  }

  return (
    <div className="memberships-panel">
      {summary ? (
        <div className="membership-tiles">
          <div className="membership-tile">
            <span>{t("Members")}</span>
            <strong>{summary.members}</strong>
            {summary.trialing ? <em>{tn(summary.trialing, "{count} on trial", "{count} on trial")}</em> : null}
          </div>
          <div className="membership-tile">
            <span>{t("Monthly recurring")}</span>
            <strong>{moneyList(summary.mrr)}</strong>
          </div>
          <div className="membership-tile">
            <span>{t("Collected, last 30 days")}</span>
            <strong>{moneyList(summary.collected30d)}</strong>
          </div>
          <div className={`membership-tile${summary.pastDue || summary.awaitingPayment ? " needs-attention" : ""}`}>
            <span>{t("Needs attention")}</span>
            <strong>{summary.pastDue + summary.awaitingPayment}</strong>
            <em>
              {t("{failed} failed · {due} awaiting payment", { failed: summary.pastDue, due: summary.awaitingPayment })}
            </em>
          </div>
        </div>
      ) : null}

      <article className="data-card wide">
        <div className="data-card-header">
          <div>
            <span>{t("Plans")}</span>
            <h2>{tn(data.plans.length, "{count} plan", "{count} plans")}</h2>
          </div>
          <button type="button" className="primary-button" onClick={() => setEditing("new")}>
            <Plus size={16} /> {t("New plan")}
          </button>
        </div>
        <p className="field-help">
          {t("A plan sets the price, how often it is charged, and the credits each paid period adds to the member's passes.")}
        </p>
        {!data.cardsReady ? (
          <p className="membership-warning">
            {t("Automatic card billing needs Clarity Pay (Billing › Settings). Until then, members are billed by hand: each period raises a charge for you to mark paid.")}
          </p>
        ) : null}
        {data.plans.length ? (
          <div className="membership-plans">
            {data.plans.map((plan) => (
              <div key={plan.id} className="membership-plan">
                <div>
                  <strong>{plan.name}</strong>
                  <span className="membership-meta">
                    {formatMoney(plan.priceCents / 100, plan.currency)} {intervalLabel(plan.interval, plan.intervalCount)}
                    {plan.termCycles ? ` · ${tn(plan.termCycles, "{count} payment", "{count} payments")}` : ""}
                    {plan.trialDays ? ` · ${tn(plan.trialDays, "{count}-day trial", "{count}-day trial")}` : ""}
                  </span>
                  <span className="membership-meta">
                    {plan.entitlements
                      .map(
                        (entitlement) =>
                          `${tn(entitlement.credits, "{count} credit", "{count} credits")} · ${
                            entitlement.serviceIds
                              .map((id) => services.find((service) => service.id === id)?.name)
                              .filter(Boolean)
                              .join(", ") || entitlement.name
                          }`,
                      )
                      .join("  ·  ")}
                  </span>
                  <span className="membership-tags">
                    {!plan.active ? <em>{t("Closed to new members")}</em> : null}
                    {plan.sellOnline ? <em>{t("Sold in the portal")}</em> : null}
                    <em>{tn(plan.memberCount || 0, "{count} member", "{count} members")}</em>
                  </span>
                </div>
                <div className="membership-plan-actions">
                  <button type="button" className="outline-button" onClick={() => setEditing(plan)}>
                    {t("Edit")}
                  </button>
                  <button type="button" className="link-button" onClick={() => void retirePlan(plan)}>
                    {t("Retire")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p>{t("No plans yet. Create one to start selling memberships.")}</p>
        )}
      </article>

      <article className="data-card wide">
        <div className="data-card-header">
          <div>
            <span>{t("Members")}</span>
            <h2>{tn(shown.length, "{count} membership", "{count} memberships")}</h2>
          </div>
        </div>
        <p className="field-help">{t("To add someone, open their client profile and go to Passes.")}</p>
        <div className="membership-toolbar">
          <input
            type="search"
            value={search}
            placeholder={t("Search members")}
            onChange={(event) => setSearch(event.target.value)}
            aria-label={t("Search members")}
          />
          <select value={filter} onChange={(event) => setFilter(event.target.value as Filter)} aria-label={t("Show")}>
            <option value="live">{t("Current")}</option>
            <option value="attention">{t("Needs attention")}</option>
            <option value="ended">{t("Ended")}</option>
            <option value="all">{t("All")}</option>
          </select>
        </div>
        {shown.length ? (
          <table className="recent-invoices-table membership-table">
            <thead>
              <tr>
                <th>{t("Member")}</th>
                <th>{t("Plan")}</th>
                <th>{t("Next charge")}</th>
                <th>{t("Owing")}</th>
                <th>{t("Status")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => (
                <MemberRow
                  key={m.id}
                  membership={m}
                  selected={selectedId === m.id}
                  onSelect={() => setSelectedId(selectedId === m.id ? "" : m.id)}
                  formatMoney={formatMoney}
                  onChanged={replace}
                  notify={notify}
                  onOpenPerson={onOpenPerson}
                />
              ))}
            </tbody>
          </table>
        ) : (
          <p>{t("Nobody here.")}</p>
        )}
      </article>
    </div>
  );
}

function MemberRow({
  membership: m,
  selected,
  onSelect,
  formatMoney,
  onChanged,
  notify,
  onOpenPerson,
}: {
  membership: Membership;
  selected: boolean;
  onSelect: () => void;
  formatMoney: (amount: number, currency?: string) => string;
  onChanged: (membership: Membership) => void;
  notify: (message: string) => void;
  onOpenPerson: (personId: string) => void;
}) {
  return (
    <>
      <tr className={selected ? "membership-row selected" : "membership-row"}>
        <td>
          <button type="button" className="link-button" onClick={onSelect} aria-expanded={selected}>
            {m.personName || t("Unnamed client")}
          </button>
        </td>
        <td>{m.plan.name}</td>
        <td>{m.nextChargeAt ? dateLabel(m.nextChargeAt) : "-"}</td>
        <td>{m.outstandingCents ? formatMoney(m.outstandingCents / 100, m.plan.currency) : "-"}</td>
        <td>
          <span className={`invoice-status-pill ${statusPillClass(m.status)}`}>{statusLabel(m)}</span>
        </td>
      </tr>
      {selected ? (
        <tr className="membership-row-detail">
          <td colSpan={5}>
            <MembershipCard
              membership={m}
              formatMoney={formatMoney}
              onChanged={onChanged}
              notify={notify}
              onOpenPerson={onOpenPerson}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}
