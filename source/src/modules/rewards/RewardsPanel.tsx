// Billing › Rewards: programmes that earn clients pass credits for what they
// do -- every N completed lessons, or every $X spent at the till.
//
// The sibling of Memberships. Both top passes up over time according to their
// settings; a membership because a period was paid, a reward because a
// milestone was reached. What a client has earned lands on their profile as a
// pass and spends at checkout like any other. Self-contained -- it loads and
// changes its own data through /api/rewards -- so App.tsx only mounts it.

import { useCallback, useEffect, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";

import { t, tn } from "../../lib/i18n";
import { Loading } from "../shared/Loading";
import { rewardLabel, rewardsApi, runLabel, triggerLabel, type RewardProgram, type RewardTrigger } from "./rewardsApi";
import "../memberships/memberships.css";

export type CoverableService = { id: string; name: string };

export type RewardsPanelProps = {
  services: CoverableService[];
  currency: string;
  formatMoney: (amount: number, currency?: string) => string;
  notify: (message: string) => void;
};

const EXPIRY_CHOICES = [3, 6, 12, 24];

function scopeLabel(all: boolean, ids: string[], services: CoverableService[]) {
  if (all) return t("Every service");
  return ids.map((id) => services.find((service) => service.id === id)?.name).filter(Boolean).join(", ") || "-";
}

/** yyyy-mm-dd on the coach's own calendar, for a date input. */
function dateInput(value: string) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function RewardsPanel({ services, currency, formatMoney, notify }: RewardsPanelProps) {
  const [programs, setPrograms] = useState<RewardProgram[] | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "error">("loading");
  const [editing, setEditing] = useState<RewardProgram | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const money = (amount: number) => formatMoney(amount, currency);

  const load = useCallback(async () => {
    setLoadState("loading");
    try {
      setPrograms((await rewardsApi.load()).programs);
      setLoadState("loaded");
    } catch {
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(program: Partial<RewardProgram>) {
    setBusy(true);
    try {
      const result = await rewardsApi.save(program);
      setPrograms(result.programs);
      setEditing(null);
      notify(result.ran.rewards ? `${t("Programme saved.")} ${runLabel(result.ran)}` : t("Programme saved."));
    } catch (error) {
      notify(error instanceof Error ? error.message : t("Could not save that programme."));
    } finally {
      setBusy(false);
    }
  }

  async function retire(program: RewardProgram) {
    if (!window.confirm(t("Retire {name}? Nobody earns anything new from it. Rewards already earned stay spendable.", { name: program.name }))) return;
    try {
      setPrograms((await rewardsApi.archive(program.id)).programs);
      notify(t("Programme retired."));
    } catch (error) {
      notify(error instanceof Error ? error.message : t("Could not retire that programme."));
    }
  }

  async function runNow() {
    setBusy(true);
    try {
      const result = await rewardsApi.run();
      setPrograms(result.programs);
      notify(runLabel(result.ran));
    } catch (error) {
      notify(error instanceof Error ? error.message : t("Could not check rewards."));
    } finally {
      setBusy(false);
    }
  }

  if (loadState === "loading" && !programs) return <Loading what={t("rewards")} />;
  if (loadState === "error" && !programs) {
    return (
      <p>
        {t("Could not load rewards.")}{" "}
        <button className="link-button" type="button" onClick={() => void load()}>
          {t("Retry")}
        </button>
      </p>
    );
  }
  if (!programs) return null;

  if (editing) {
    return (
      <div className="memberships-panel">
        <article className="data-card wide">
          <RewardEditor
            program={editing === "new" ? null : editing}
            services={services}
            currency={currency}
            saving={busy}
            onSave={(program) => void save(program)}
            onCancel={() => setEditing(null)}
          />
        </article>
      </div>
    );
  }

  return (
    <div className="memberships-panel">
      <article className="data-card wide">
        <div className="data-card-header">
          <div>
            <span>{t("Rewards")}</span>
            <h2>{tn(programs.length, "{count} programme", "{count} programmes")}</h2>
          </div>
          <div className="membership-plan-actions">
            {programs.some((program) => program.active) ? (
              <button type="button" className="outline-button" disabled={busy} onClick={() => void runNow()}>
                <RefreshCw size={16} /> {t("Check now")}
              </button>
            ) : null}
            <button type="button" className="primary-button" onClick={() => setEditing("new")}>
              <Plus size={16} /> {t("New programme")}
            </button>
          </div>
        </div>
        <p className="field-help">
          {t("A rewards programme gives clients pass credits for what they do. Earned credits land on their passes and spend at checkout like any other. Rewards are checked every half hour.")}
        </p>
        {programs.length ? (
          <div className="membership-plans">
            {programs.map((program) => (
              <div key={program.id} className="membership-plan">
                <div>
                  <strong>{program.name}</strong>
                  <span className="membership-meta">
                    {triggerLabel(program, money)} {rewardLabel(program)}
                    {" · "}
                    {scopeLabel(program.rewardCoversAllServices, program.rewardCoversServiceIds, services)}
                  </span>
                  <span className="membership-meta">
                    {program.trigger === "lessons_completed" && !program.countsAllServices
                      ? t("Counts: {services}", { services: scopeLabel(false, program.countsServiceIds, services) })
                      : ""}
                  </span>
                  <span className="membership-tags">
                    {!program.active ? <em>{t("Paused")}</em> : null}
                    <em>{tn(program.peopleRewarded || 0, "1 client rewarded", "{count} clients rewarded")}</em>
                    <em>{tn(program.creditsGranted || 0, "1 credit given", "{count} credits given")}</em>
                  </span>
                </div>
                <div className="membership-plan-actions">
                  <button type="button" className="outline-button" onClick={() => setEditing(program)}>
                    {t("Edit")}
                  </button>
                  <button type="button" className="link-button" onClick={() => void retire(program)}>
                    {t("Retire")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p>{t("No rewards programmes yet. Create one to start rewarding regulars.")}</p>
        )}
      </article>
    </div>
  );
}

type Draft = {
  id: string;
  name: string;
  description: string;
  active: boolean;
  trigger: RewardTrigger;
  threshold: string;
  countsAllServices: boolean;
  countsServiceIds: string[];
  countsFrom: string;
  rewardCredits: string;
  rewardCoversAllServices: boolean;
  rewardCoversServiceIds: string[];
  rewardExpiryMonths: string;
  maxRewardsPerPerson: string;
};

function draftFrom(program: RewardProgram | null): Draft {
  return {
    id: program?.id || "",
    name: program?.name || "",
    description: program?.description || "",
    active: program ? program.active : true,
    trigger: program?.trigger || "lessons_completed",
    threshold: program
      ? program.trigger === "amount_spent"
        ? String(program.threshold / 100)
        : String(program.threshold)
      : "10",
    countsAllServices: program ? program.countsAllServices : true,
    countsServiceIds: program?.countsServiceIds || [],
    countsFrom: dateInput(program?.countsFrom || ""),
    rewardCredits: String(program?.rewardCredits || 1),
    rewardCoversAllServices: program?.rewardCoversAllServices || false,
    rewardCoversServiceIds: program?.rewardCoversServiceIds || [],
    rewardExpiryMonths: program?.rewardExpiryMonths ? String(program.rewardExpiryMonths) : "",
    maxRewardsPerPerson: program?.maxRewardsPerPerson ? String(program.maxRewardsPerPerson) : "",
  };
}

function ServicePicker({
  label,
  all,
  ids,
  services,
  onChange,
}: {
  label: string;
  all: boolean;
  ids: string[];
  services: CoverableService[];
  onChange: (all: boolean, ids: string[]) => void;
}) {
  return (
    <div className="membership-services" role="group" aria-label={label}>
      <span className="membership-services-label">{label}</span>
      <label className="membership-check">
        <input type="checkbox" checked={all} onChange={(event) => onChange(event.target.checked, [])} />
        <span>{t("Every service")}</span>
      </label>
      {all
        ? null
        : services.map((service) => (
            <label key={service.id} className="membership-check">
              <input
                type="checkbox"
                checked={ids.includes(service.id)}
                onChange={(event) =>
                  onChange(false, event.target.checked ? [...ids, service.id] : ids.filter((id) => id !== service.id))
                }
              />
              <span>{service.name}</span>
            </label>
          ))}
    </div>
  );
}

function RewardEditor({
  program,
  services,
  currency,
  saving,
  onSave,
  onCancel,
}: {
  program: RewardProgram | null;
  services: CoverableService[];
  currency: string;
  saving: boolean;
  onSave: (program: Partial<RewardProgram>) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(program));
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const spend = draft.trigger === "amount_spent";

  const submit = () =>
    onSave({
      ...(draft.id ? { id: draft.id } : {}),
      name: draft.name,
      description: draft.description,
      active: draft.active,
      trigger: draft.trigger,
      threshold: spend ? Math.round((Number(draft.threshold) || 0) * 100) : Math.round(Number(draft.threshold) || 0),
      countsAllServices: spend || draft.countsAllServices,
      countsServiceIds: spend || draft.countsAllServices ? [] : draft.countsServiceIds,
      // The start of the chosen day, where the coach is.
      countsFrom: draft.countsFrom ? new Date(`${draft.countsFrom}T00:00:00`).toISOString() : undefined,
      rewardCredits: Number(draft.rewardCredits) || 0,
      rewardCoversAllServices: draft.rewardCoversAllServices,
      rewardCoversServiceIds: draft.rewardCoversAllServices ? [] : draft.rewardCoversServiceIds,
      rewardExpiryMonths: Number(draft.rewardExpiryMonths) || null,
      maxRewardsPerPerson: Number(draft.maxRewardsPerPerson) || null,
    });

  return (
    <form
      className="membership-plan-editor"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h3>{program ? t("Edit rewards programme") : t("New rewards programme")}</h3>
      {program ? (
        <p className="field-help">{t("Changes apply to rewards earned from now on. Credits already given stay as they are.")}</p>
      ) : null}

      <div className="membership-form-grid">
        <label className="settings-field">
          <span>{t("Name")}</span>
          <input
            value={draft.name}
            required
            maxLength={120}
            onChange={(event) => set("name", event.target.value)}
            placeholder={t("e.g. Every 10th lesson free")}
          />
        </label>
        <label className="settings-field membership-span">
          <span>{t("Description")}</span>
          <textarea rows={2} maxLength={600} value={draft.description} onChange={(event) => set("description", event.target.value)} />
        </label>
      </div>

      <fieldset className="membership-fieldset">
        <legend>{t("What earns a reward")}</legend>
        <div className="membership-form-grid">
          <label className="settings-field">
            <span>{t("Reward clients for")}</span>
            <select value={draft.trigger} onChange={(event) => set("trigger", event.target.value as RewardTrigger)}>
              <option value="lessons_completed">{t("Completed lessons")}</option>
              <option value="amount_spent">{t("Money spent at the till")}</option>
            </select>
          </label>
          <label className="settings-field">
            <span>{spend ? t("Every ({currency})", { currency }) : t("Every how many lessons")}</span>
            <input inputMode={spend ? "decimal" : "numeric"} value={draft.threshold} onChange={(event) => set("threshold", event.target.value)} />
          </label>
          <label className="settings-field">
            <span>{t("Count activity from")}</span>
            <input type="date" value={draft.countsFrom} onChange={(event) => set("countsFrom", event.target.value)} />
          </label>
        </div>
        <p className="field-help">
          {spend
            ? t("Paid till sales to a named client count. Sales paid with a pass or a coupon do not.")
            : t("A lesson counts once it is marked completed, for the client it was booked under.")}
        </p>
        {spend ? null : (
          <ServicePicker
            label={t("Lessons that count")}
            all={draft.countsAllServices}
            ids={draft.countsServiceIds}
            services={services}
            onChange={(all, ids) => setDraft((current) => ({ ...current, countsAllServices: all, countsServiceIds: ids }))}
          />
        )}
      </fieldset>

      <fieldset className="membership-fieldset">
        <legend>{t("What a reward gives")}</legend>
        <div className="membership-form-grid">
          <label className="settings-field">
            <span>{t("Credits per reward")}</span>
            <input inputMode="numeric" value={draft.rewardCredits} onChange={(event) => set("rewardCredits", event.target.value)} />
          </label>
          <label className="settings-field">
            <span>{t("Credits expire")}</span>
            <select value={draft.rewardExpiryMonths} onChange={(event) => set("rewardExpiryMonths", event.target.value)}>
              <option value="">{t("Never")}</option>
              {EXPIRY_CHOICES.map((months) => (
                <option key={months} value={String(months)}>
                  {tn(months, "After 1 month", "After {count} months")}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-field">
            <span>{t("Most rewards per client")}</span>
            <input
              inputMode="numeric"
              value={draft.maxRewardsPerPerson}
              placeholder={t("No limit")}
              onChange={(event) => set("maxRewardsPerPerson", event.target.value)}
            />
          </label>
        </div>
        <ServicePicker
          label={t("Can be spent on")}
          all={draft.rewardCoversAllServices}
          ids={draft.rewardCoversServiceIds}
          services={services}
          onChange={(all, ids) =>
            setDraft((current) => ({ ...current, rewardCoversAllServices: all, rewardCoversServiceIds: ids }))
          }
        />
      </fieldset>

      <fieldset className="membership-fieldset">
        <legend>{t("Availability")}</legend>
        <label className="membership-check">
          <input type="checkbox" checked={draft.active} onChange={(event) => set("active", event.target.checked)} />
          <span>{t("Running: clients are earning rewards")}</span>
        </label>
      </fieldset>

      <div className="membership-actions">
        <button type="submit" className="primary-button" disabled={saving}>
          {saving ? t("Saving...") : t("Save")}
        </button>
        <button type="button" className="outline-button" onClick={onCancel}>
          {t("Cancel")}
        </button>
      </div>
    </form>
  );
}
