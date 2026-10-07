// Creating and editing a membership plan: price, billing period, term, and
// what each paid period gives the member. The server validates all of it
// again (normalisePlan in membership-schedule.mts); this form only makes the
// choices legible.

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import { t } from "../../lib/i18n";
import type { BillingInterval, MembershipEntitlement, MembershipPlan, RolloverPolicy } from "./membershipsApi";
import { rolloverLabel } from "./membershipsApi";

export type CoverableService = { id: string; name: string };

export type PlanEditorProps = {
  plan: MembershipPlan | null;
  currency: string;
  services: CoverableService[];
  cardsReady: boolean;
  saving: boolean;
  onSave: (plan: Partial<MembershipPlan>) => void;
  onCancel: () => void;
};

type Draft = {
  id: string;
  name: string;
  description: string;
  active: boolean;
  sellOnline: boolean;
  price: string;
  interval: BillingInterval;
  intervalCount: string;
  anchor: "signup" | "day_of_month";
  anchorDay: string;
  prorateFirst: boolean;
  signupFee: string;
  trialDays: string;
  termMode: "ongoing" | "fixed";
  termCycles: string;
  minCycles: string;
  failedPaymentAction: "pause" | "cancel";
  entitlements: MembershipEntitlement[];
};

const toMajor = (cents: number) => (cents ? (cents / 100).toFixed(2).replace(/\.00$/, "") : "");
const toCents = (value: string) => Math.round((Number(value) || 0) * 100);

function draftFrom(plan: MembershipPlan | null): Draft {
  return {
    id: plan?.id || "",
    name: plan?.name || "",
    description: plan?.description || "",
    active: plan ? plan.active : true,
    sellOnline: plan?.sellOnline || false,
    price: plan ? toMajor(plan.priceCents) : "",
    interval: plan?.interval || "month",
    intervalCount: String(plan?.intervalCount || 1),
    anchor: plan?.anchor || "signup",
    anchorDay: String(plan?.anchorDay || 1),
    prorateFirst: plan ? plan.prorateFirst : true,
    signupFee: plan ? toMajor(plan.signupFeeCents) : "",
    trialDays: plan?.trialDays ? String(plan.trialDays) : "",
    termMode: plan?.termCycles ? "fixed" : "ongoing",
    termCycles: plan?.termCycles ? String(plan.termCycles) : "12",
    minCycles: plan?.minCycles ? String(plan.minCycles) : "",
    failedPaymentAction: plan?.failedPaymentAction || "pause",
    entitlements: plan?.entitlements?.length
      ? plan.entitlements
      : [{ id: "ent1", name: "", serviceIds: [], credits: 4, rollover: "expire_each_period", maxBalance: null }],
  };
}

export function PlanEditor({ plan, currency, services, cardsReady, saving, onSave, onCancel }: PlanEditorProps) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(plan));
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const setEntitlement = (index: number, patch: Partial<MembershipEntitlement>) =>
    setDraft((current) => ({
      ...current,
      entitlements: current.entitlements.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
    }));

  const submit = () =>
    onSave({
      ...(draft.id ? { id: draft.id } : {}),
      name: draft.name,
      description: draft.description,
      active: draft.active,
      sellOnline: draft.sellOnline && cardsReady,
      priceCents: toCents(draft.price),
      currency: plan?.currency || currency,
      interval: draft.interval,
      intervalCount: Number(draft.intervalCount) || 1,
      anchor: draft.interval === "month" ? draft.anchor : "signup",
      anchorDay: Number(draft.anchorDay) || 1,
      prorateFirst: draft.prorateFirst,
      signupFeeCents: toCents(draft.signupFee),
      trialDays: Number(draft.trialDays) || 0,
      termCycles: draft.termMode === "fixed" ? Number(draft.termCycles) || 1 : null,
      minCycles: Number(draft.minCycles) || 0,
      failedPaymentAction: draft.failedPaymentAction,
      entitlements: draft.entitlements,
    });

  return (
    <form
      className="membership-plan-editor"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h3>{plan ? t("Edit plan") : t("New plan")}</h3>
      {plan ? (
        <p className="field-help">{t("Changes apply to people who join from now on. Existing members keep the terms they signed up to.")}</p>
      ) : null}

      <div className="membership-form-grid">
        <label className="settings-field">
          <span>{t("Name")}</span>
          <input value={draft.name} required maxLength={120} onChange={(event) => set("name", event.target.value)} placeholder={t("e.g. Monthly Academy")} />
        </label>
        <label className="settings-field">
          <span>{t("Price ({currency})", { currency: plan?.currency || currency })}</span>
          <input inputMode="decimal" value={draft.price} onChange={(event) => set("price", event.target.value)} placeholder="0" />
        </label>
        <label className="settings-field membership-span">
          <span>{t("Description")}</span>
          <textarea rows={2} maxLength={600} value={draft.description} onChange={(event) => set("description", event.target.value)} />
        </label>
      </div>

      <fieldset className="membership-fieldset">
        <legend>{t("Billing")}</legend>
        <div className="membership-form-grid">
          <label className="settings-field">
            <span>{t("Charge every")}</span>
            <div className="membership-inline">
              <input
                className="membership-number"
                inputMode="numeric"
                value={draft.intervalCount}
                onChange={(event) => set("intervalCount", event.target.value)}
                aria-label={t("How many")}
              />
              <select value={draft.interval} onChange={(event) => set("interval", event.target.value as BillingInterval)}>
                <option value="week">{t("week(s)")}</option>
                <option value="month">{t("month(s)")}</option>
                <option value="year">{t("year(s)")}</option>
              </select>
            </div>
          </label>
          {draft.interval === "month" ? (
            <label className="settings-field">
              <span>{t("Billing day")}</span>
              <select value={draft.anchor} onChange={(event) => set("anchor", event.target.value as Draft["anchor"])}>
                <option value="signup">{t("The day they join")}</option>
                <option value="day_of_month">{t("The same day for everyone")}</option>
              </select>
            </label>
          ) : null}
          {draft.interval === "month" && draft.anchor === "day_of_month" ? (
            <>
              <label className="settings-field">
                <span>{t("Day of the month")}</span>
                <input inputMode="numeric" value={draft.anchorDay} onChange={(event) => set("anchorDay", event.target.value)} />
              </label>
              <label className="membership-check">
                <input type="checkbox" checked={draft.prorateFirst} onChange={(event) => set("prorateFirst", event.target.checked)} />
                <span>{t("Charge a part-month pro rata when someone joins mid-month")}</span>
              </label>
            </>
          ) : null}
          <label className="settings-field">
            <span>{t("Joining fee ({currency})", { currency: plan?.currency || currency })}</span>
            <input inputMode="decimal" value={draft.signupFee} onChange={(event) => set("signupFee", event.target.value)} placeholder="0" />
          </label>
          <label className="settings-field">
            <span>{t("Free trial (days)")}</span>
            <input inputMode="numeric" value={draft.trialDays} onChange={(event) => set("trialDays", event.target.value)} placeholder="0" />
          </label>
          <label className="settings-field">
            <span>{t("Length")}</span>
            <select value={draft.termMode} onChange={(event) => set("termMode", event.target.value as Draft["termMode"])}>
              <option value="ongoing">{t("Until cancelled")}</option>
              <option value="fixed">{t("A set number of payments")}</option>
            </select>
          </label>
          {draft.termMode === "fixed" ? (
            <label className="settings-field">
              <span>{t("Number of payments")}</span>
              <input inputMode="numeric" value={draft.termCycles} onChange={(event) => set("termCycles", event.target.value)} />
            </label>
          ) : null}
          <label className="settings-field">
            <span>{t("Minimum payments before the member can cancel")}</span>
            <input inputMode="numeric" value={draft.minCycles} onChange={(event) => set("minCycles", event.target.value)} placeholder="0" />
          </label>
          <label className="settings-field">
            <span>{t("If a card keeps failing")}</span>
            <select
              value={draft.failedPaymentAction}
              onChange={(event) => set("failedPaymentAction", event.target.value as Draft["failedPaymentAction"])}
            >
              <option value="pause">{t("Pause the membership")}</option>
              <option value="cancel">{t("Cancel the membership")}</option>
            </select>
          </label>
        </div>
        <p className="field-help">{t("A failed card is retried after 1, 3 and 5 days, and the member is emailed once.")}</p>
      </fieldset>

      <fieldset className="membership-fieldset">
        <legend>{t("What each paid period gives")}</legend>
        <p className="field-help">{t("Credits land on the member's passes when a period is paid, and spend at checkout like any other pass.")}</p>
        {draft.entitlements.map((entitlement, index) => (
          <div key={entitlement.id} className="membership-entitlement">
            <div className="membership-form-grid">
              <label className="settings-field">
                <span>{t("Credits each period")}</span>
                <input
                  inputMode="numeric"
                  value={String(entitlement.credits)}
                  onChange={(event) => setEntitlement(index, { credits: Number(event.target.value) || 0 })}
                />
              </label>
              <label className="settings-field">
                <span>{t("Label (optional)")}</span>
                <input
                  value={entitlement.name}
                  maxLength={120}
                  placeholder={t("e.g. Lessons")}
                  onChange={(event) => setEntitlement(index, { name: event.target.value })}
                />
              </label>
              <label className="settings-field">
                <span>{t("Unused credits")}</span>
                <select
                  value={entitlement.rollover}
                  onChange={(event) => setEntitlement(index, { rollover: event.target.value as RolloverPolicy })}
                >
                  {(["expire_each_period", "rollover", "rollover_capped"] as RolloverPolicy[]).map((policy) => (
                    <option key={policy} value={policy}>
                      {rolloverLabel(policy)}
                    </option>
                  ))}
                </select>
              </label>
              {entitlement.rollover === "rollover_capped" ? (
                <label className="settings-field">
                  <span>{t("Most a member can hold")}</span>
                  <input
                    inputMode="numeric"
                    value={String(entitlement.maxBalance ?? entitlement.credits * 2)}
                    onChange={(event) => setEntitlement(index, { maxBalance: Number(event.target.value) || null })}
                  />
                </label>
              ) : null}
            </div>
            <div className="membership-services" role="group" aria-label={t("Can be spent on")}>
              <span className="membership-services-label">{t("Can be spent on")}</span>
              <label className="membership-check">
                <input
                  type="checkbox"
                  checked={entitlement.allServices === true}
                  onChange={(event) =>
                    setEntitlement(index, { allServices: event.target.checked, serviceIds: [] })
                  }
                />
                <span>{t("Every service")}</span>
              </label>
              {entitlement.allServices ? null : services.length ? (
                services.map((service) => (
                  <label key={service.id} className="membership-check">
                    <input
                      type="checkbox"
                      checked={entitlement.serviceIds.includes(service.id)}
                      onChange={(event) =>
                        setEntitlement(index, {
                          serviceIds: event.target.checked
                            ? [...entitlement.serviceIds, service.id]
                            : entitlement.serviceIds.filter((id) => id !== service.id),
                        })
                      }
                    />
                    <span>{service.name}</span>
                  </label>
                ))
              ) : (
                <em>{t("Add a lesson type first.")}</em>
              )}
            </div>
            {draft.entitlements.length > 1 ? (
              <button
                type="button"
                className="link-button"
                onClick={() => set("entitlements", draft.entitlements.filter((_, i) => i !== index))}
              >
                <Trash2 size={14} /> {t("Remove")}
              </button>
            ) : null}
          </div>
        ))}
        {draft.entitlements.length < 12 ? (
          <button
            type="button"
            className="outline-button"
            onClick={() =>
              set("entitlements", [
                ...draft.entitlements,
                {
                  id: `ent${Date.now().toString(36)}`,
                  name: "",
                  serviceIds: [],
                  credits: 1,
                  rollover: "expire_each_period",
                  maxBalance: null,
                },
              ])
            }
          >
            <Plus size={14} /> {t("Add another entitlement")}
          </button>
        ) : null}
      </fieldset>

      <fieldset className="membership-fieldset">
        <legend>{t("Availability")}</legend>
        <label className="membership-check">
          <input type="checkbox" checked={draft.active} onChange={(event) => set("active", event.target.checked)} />
          <span>{t("Open for new members")}</span>
        </label>
        <label className="membership-check">
          <input
            type="checkbox"
            checked={draft.sellOnline && cardsReady}
            disabled={!cardsReady}
            onChange={(event) => set("sellOnline", event.target.checked)}
          />
          <span>{t("Players can join from their portal")}</span>
        </label>
        {!cardsReady ? (
          <p className="field-help">{t("Joining online and automatic card billing need Clarity Pay. You can still enrol members and record their payments by hand.")}</p>
        ) : null}
      </fieldset>

      <div className="membership-actions">
        <button type="submit" className="primary-button" disabled={saving}>
          {saving ? t("Saving…") : t("Save plan")}
        </button>
        <button type="button" className="outline-button" onClick={onCancel}>
          {t("Back")}
        </button>
      </div>
    </form>
  );
}
