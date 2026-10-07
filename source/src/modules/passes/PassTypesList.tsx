// Billing > Passes > Create or Edit Passes: the pass types this business sells,
// made and changed here rather than among the lesson types.
//
// A pass type is still stored as a `package` entry in the service catalogue --
// that is what the till, the invoice picker, the player shop and the Optix
// inbox already sell and issue from, so keeping one catalogue means none of
// them can disagree about what a pass is. What moved is only where a coach
// edits one: lesson types are things you book, pass types are things you
// sell, and they no longer share a form.
//
// Scope is the new part. A pass type covers every service ("site wide") or
// just the ones ticked. Passes already issued keep the scope they were issued
// with; a single pass can be widened from the client's Passes tab.

import { useState } from "react";
import { Plus } from "lucide-react";

import { passCoverageList, type Service } from "../services/serviceModel";
import { t, tn } from "../../lib/i18n";

export type PassTypeDraft = {
  id: string;
  name: string;
  description: string;
  price: number;
  credits: number;
  coversAllServices: boolean;
  coversServiceIds: string[];
  /** 0 = never expires. */
  expiryMonths: number;
  crossRedeemable: boolean;
  active: boolean;
};

export type PassTypesListProps = {
  services: Service[];
  formatMoney: (amount: number) => string;
  saving: boolean;
  /** Write one pass type into the catalogue (new or changed). */
  onSave: (draft: PassTypeDraft) => void;
  onArchive: (service: Service) => void;
};

const EXPIRY_CHOICES = [3, 6, 12, 24, 0];
const DEFAULT_EXPIRY_MONTHS = 12;

function expiryLabel(months: number) {
  return months ? tn(months, "1 month", "{count} months") : t("No expiry");
}

function draftFrom(service: Service | null): PassTypeDraft {
  return {
    id: service?.id || "",
    name: service?.name || "",
    description: service?.description || "",
    price: service?.price ?? 0,
    credits: service?.packageAllowance ?? 5,
    coversAllServices: service?.coversAllServices === true,
    coversServiceIds: service ? passCoverageList(service) : [],
    expiryMonths: service?.passExpiryMonths ?? DEFAULT_EXPIRY_MONTHS,
    crossRedeemable: service?.crossRedeemable === true,
    active: service ? service.active : true,
  };
}

export function PassTypesList({ services, formatMoney, saving, onSave, onArchive }: PassTypesListProps) {
  const [editing, setEditing] = useState<Service | "new" | null>(null);
  const passTypes = services.filter((service) => service.lessonFormat === "package" && service.archived !== true);
  // What a pass can be spent on: anything bookable that is not itself a pass.
  const coverable = services.filter(
    (service) => service.lessonFormat !== "package" && service.archived !== true && service.active !== false,
  );
  const nameOf = (id: string) => services.find((service) => service.id === id)?.name || "";

  function coverLabel(service: Service) {
    if (service.coversAllServices) return t("Every service");
    return passCoverageList(service).map(nameOf).filter(Boolean).join(", ") || "—";
  }

  if (editing) {
    return (
      <PassTypeEditor
        initial={draftFrom(editing === "new" ? null : editing)}
        isNew={editing === "new"}
        coverable={coverable}
        saving={saving}
        onCancel={() => setEditing(null)}
        onSave={(draft) => {
          onSave(draft);
          setEditing(null);
        }}
      />
    );
  }

  return (
    <>
      {passTypes.length ? (
        <table className="recent-invoices-table">
          <thead>
            <tr>
              <th>{t("Pass")}</th>
              <th>{t("Covers")}</th>
              <th>{t("Credits")}</th>
              <th>{t("Expires")}</th>
              <th>{t("Price")}</th>
              <th aria-label={t("Actions")} />
            </tr>
          </thead>
          <tbody>
            {passTypes.map((service) => (
              <tr key={service.id} className={service.active ? "" : "voided-row"}>
                <td>{service.name}</td>
                <td>{coverLabel(service)}</td>
                <td>{service.packageAllowance ?? "—"}</td>
                <td>{expiryLabel(service.passExpiryMonths ?? DEFAULT_EXPIRY_MONTHS)}</td>
                <td>{formatMoney(service.price)}</td>
                <td>
                  <button className="text-link-button" type="button" onClick={() => setEditing(service)}>
                    {t("Edit")}
                  </button>{" "}
                  <button className="text-link-button" type="button" onClick={() => onArchive(service)}>
                    {t("Archive")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>{t("No pass types yet.")}</p>
      )}
      <div className="panel-actions">
        <button className="primary-button" onClick={() => setEditing("new")} type="button">
          <Plus size={16} /> {t("New pass type")}
        </button>
      </div>
    </>
  );
}

function PassTypeEditor({
  initial,
  isNew,
  coverable,
  saving,
  onSave,
  onCancel,
}: {
  initial: PassTypeDraft;
  isNew: boolean;
  coverable: Service[];
  saving: boolean;
  onSave: (draft: PassTypeDraft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [price, setPrice] = useState(String(initial.price));
  const [credits, setCredits] = useState(String(initial.credits));
  const set = <K extends keyof PassTypeDraft>(key: K, value: PassTypeDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const creditCount = Math.max(1, Math.min(100, Math.round(Number(credits) || 0)));
  const canSave =
    !saving && draft.name.trim().length > 0 && (draft.coversAllServices || draft.coversServiceIds.length > 0);

  return (
    <form
      className="pass-grant-form pass-type-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSave) return;
        onSave({
          ...draft,
          name: draft.name.trim(),
          description: draft.description.trim(),
          price: Math.max(0, Number(price) || 0),
          credits: creditCount,
          coversServiceIds: draft.coversAllServices ? [] : draft.coversServiceIds,
        });
      }}
    >
      <label className="pass-field pass-field-wide">
        <span>{t("Name")}</span>
        <input
          value={draft.name}
          maxLength={120}
          required
          onChange={(event) => set("name", event.target.value)}
          placeholder={t("e.g. 5 x 1 Hour Lessons")}
        />
      </label>
      <label className="pass-field">
        <span>{t("Price")}</span>
        <input inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} />
      </label>
      <label className="pass-field">
        <span>{t("Credits")}</span>
        <input type="number" min={1} max={100} value={credits} onChange={(event) => setCredits(event.target.value)} />
      </label>
      <label className="pass-field">
        <span>{t("Expires")}</span>
        <select value={String(draft.expiryMonths)} onChange={(event) => set("expiryMonths", Number(event.target.value))}>
          {EXPIRY_CHOICES.map((months) => (
            <option key={months} value={String(months)}>
              {expiryLabel(months)}
            </option>
          ))}
        </select>
      </label>

      <div className="pass-field pass-field-wide">
        <span>{t("Can be spent on")}</span>
        <div className="pass-coverage">
          <label className="pass-coverage-option">
            <input
              type="checkbox"
              checked={draft.coversAllServices}
              onChange={(event) => set("coversAllServices", event.target.checked)}
            />
            {t("Every service (site wide)")}
          </label>
          {draft.coversAllServices
            ? null
            : coverable.length
              ? coverable.map((service) => (
                  <label className="pass-coverage-option" key={service.id}>
                    <input
                      type="checkbox"
                      checked={draft.coversServiceIds.includes(service.id)}
                      onChange={(event) =>
                        set(
                          "coversServiceIds",
                          event.target.checked
                            ? [...draft.coversServiceIds, service.id]
                            : draft.coversServiceIds.filter((id) => id !== service.id),
                        )
                      }
                    />
                    {service.name}
                  </label>
                ))
              : <span className="pass-coverage-empty">{t("No services to cover yet.")}</span>}
        </div>
      </div>

      <label className="pass-field pass-field-wide">
        <span>{t("Description")}</span>
        <input value={draft.description} maxLength={240} onChange={(event) => set("description", event.target.value)} />
      </label>

      <label className="pass-coverage-option pass-field-wide">
        <input
          type="checkbox"
          checked={draft.crossRedeemable}
          onChange={(event) => set("crossRedeemable", event.target.checked)}
        />
        {t("Leftover value can pay for other services")}
      </label>
      <label className="pass-coverage-option pass-field-wide">
        <input type="checkbox" checked={draft.active} onChange={(event) => set("active", event.target.checked)} />
        {t("On sale")}
      </label>

      {!isNew ? (
        <p className="field-help pass-field-wide">
          {t("Changes apply to passes sold from now on. Passes already issued keep what they cover; change one from the client's Passes tab.")}
        </p>
      ) : null}

      <div className="pass-panel-actions">
        <button className="primary-button" type="submit" disabled={!canSave}>
          {saving ? t("Saving...") : isNew ? t("Create pass type") : t("Save")}
        </button>
        <button className="outline-button" type="button" onClick={onCancel}>
          {t("Cancel")}
        </button>
      </div>
    </form>
  );
}
