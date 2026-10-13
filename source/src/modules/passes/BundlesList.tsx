// Billing > Passes > Create or Edit Passes: bundles -- several pass types sold
// together for one price.
//
// A bundle is stored as a `package` entry in the service catalogue carrying
// `bundleItems`, so the till, the invoice picker, the player shop and the
// Optix inbox sell it exactly as they sell a pass type. What it issues is
// different: never a pass of its own, but each pass type it lists, as if each
// had been sold separately (grantBundle in _shared/passes.mts). So a client
// holds ordinary passes, each with its own coverage and expiry, and nothing
// that spends or reverses a credit needs to know bundles exist.

import { useState } from "react";
import { Plus, Search } from "lucide-react";

import { cleanBundleItems, isBundle, type BundleItem, type Service } from "../services/serviceModel";
import { t } from "../../lib/i18n";

export type BundleDraft = {
  id: string;
  name: string;
  description: string;
  price: number;
  items: BundleItem[];
  active: boolean;
};

export type BundlesListProps = {
  services: Service[];
  formatMoney: (amount: number) => string;
  saving: boolean;
  onSave: (draft: BundleDraft) => void;
  onArchive: (service: Service) => void;
};

function draftFrom(service: Service | null): BundleDraft {
  return {
    id: service?.id || "",
    name: service?.name || "",
    description: service?.description || "",
    price: service?.price ?? 0,
    items: cleanBundleItems(service?.bundleItems),
    active: service ? service.active : true,
  };
}

export function BundlesList({ services, formatMoney, saving, onSave, onArchive }: BundlesListProps) {
  const [editing, setEditing] = useState<Service | "new" | null>(null);
  const bundles = services.filter((service) => isBundle(service) && service.archived !== true);
  // What a bundle can hold: pass types, never another bundle.
  const passTypes = services.filter(
    (service) => service.lessonFormat === "package" && !isBundle(service) && service.archived !== true,
  );

  function includesLabel(service: Service) {
    return (
      cleanBundleItems(service.bundleItems)
        .map((item) => {
          const part = services.find((candidate) => candidate.id === item.passTypeId);
          return part ? `${item.quantity} × ${part.name}` : "";
        })
        .filter(Boolean)
        .join(" + ") || "—"
    );
  }

  if (editing) {
    return (
      <BundleEditor
        initial={draftFrom(editing === "new" ? null : editing)}
        isNew={editing === "new"}
        passTypes={passTypes}
        formatMoney={formatMoney}
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
      {bundles.length ? (
        <table className="recent-invoices-table">
          <thead>
            <tr>
              <th>{t("Bundle")}</th>
              <th>{t("Includes")}</th>
              <th>{t("Price")}</th>
              <th aria-label={t("Actions")} />
            </tr>
          </thead>
          <tbody>
            {bundles.map((service) => (
              <tr key={service.id} className={service.active ? "" : "voided-row"}>
                <td>{service.name}</td>
                <td>{includesLabel(service)}</td>
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
        <p>{t("No bundles yet.")}</p>
      )}
      <div className="panel-actions">
        <button
          className="primary-button"
          onClick={() => setEditing("new")}
          type="button"
          disabled={!passTypes.length}
        >
          <Plus size={16} /> {t("New bundle")}
        </button>
      </div>
    </>
  );
}

function BundleEditor({
  initial,
  isNew,
  passTypes,
  formatMoney,
  saving,
  onSave,
  onCancel,
}: {
  initial: BundleDraft;
  isNew: boolean;
  passTypes: Service[];
  formatMoney: (amount: number) => string;
  saving: boolean;
  onSave: (draft: BundleDraft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [price, setPrice] = useState(String(initial.price));
  const set = <K extends keyof BundleDraft>(key: K, value: BundleDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const quantityOf = (id: string) => draft.items.find((item) => item.passTypeId === id)?.quantity || 0;
  function setQuantity(id: string, value: string) {
    const quantity = Math.max(0, Math.min(20, Math.round(Number(value) || 0)));
    const others = draft.items.filter((item) => item.passTypeId !== id);
    // Keep the bundle's order as the coach built it: a changed line stays put,
    // a new one goes on the end.
    const at = draft.items.findIndex((item) => item.passTypeId === id);
    if (!quantity) return set("items", others);
    if (at < 0) return set("items", [...draft.items, { passTypeId: id, quantity }]);
    set("items", draft.items.map((item) => (item.passTypeId === id ? { ...item, quantity } : item)));
  }

  const separately = draft.items.reduce((sum, item) => {
    const part = passTypes.find((service) => service.id === item.passTypeId);
    return sum + (part?.price || 0) * item.quantity;
  }, 0);
  const canSave = !saving && draft.name.trim().length > 0 && draft.items.length > 0;

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
          placeholder={t("e.g. 5 Lessons + Swing Review")}
        />
      </label>
      <label className="pass-field">
        <span>{t("Price")}</span>
        <input inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} />
      </label>

      <div className="pass-field pass-field-wide">
        <span>{t("Includes")}</span>
        {draft.items.length ? (
          <ul className="bundle-items">
            {draft.items.map((item) => {
              const part = passTypes.find((service) => service.id === item.passTypeId);
              return (
                <li className="bundle-item" key={item.passTypeId}>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={item.quantity}
                    aria-label={part?.name || item.passTypeId}
                    // Never below one here: clearing the box to retype must
                    // not drop the line. Remove is the way out.
                    onChange={(event) => setQuantity(item.passTypeId, String(Math.max(1, Number(event.target.value) || 1)))}
                  />
                  <span>× {part?.name || t("Archived pass type")}</span>
                  <button
                    className="text-link-button"
                    type="button"
                    onClick={() => setQuantity(item.passTypeId, "0")}
                  >
                    {t("Remove")}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
        <PassTypePicker
          passTypes={passTypes.filter((service) => !draft.items.some((item) => item.passTypeId === service.id))}
          onPick={(id) => {
            rememberPassType(id);
            setQuantity(id, "1");
          }}
        />
        {separately > 0 ? (
          <span className="field-help">{t("Worth {amount} bought separately.", { amount: formatMoney(separately) })}</span>
        ) : null}
      </div>

      <label className="pass-field pass-field-wide">
        <span>{t("Description")}</span>
        <input value={draft.description} maxLength={240} onChange={(event) => set("description", event.target.value)} />
      </label>

      <label className="pass-coverage-option pass-field-wide">
        <input type="checkbox" checked={draft.active} onChange={(event) => set("active", event.target.checked)} />
        {t("On sale")}
      </label>

      <p className="field-help pass-field-wide">
        {t("Selling a bundle gives the client each pass inside it, with that pass type's own credits, cover and expiry.")}
      </p>

      <div className="pass-panel-actions">
        <button className="primary-button" type="submit" disabled={!canSave}>
          {saving ? t("Saving...") : isNew ? t("Create bundle") : t("Save")}
        </button>
        <button className="outline-button" type="button" onClick={onCancel}>
          {t("Cancel")}
        </button>
      </div>
    </form>
  );
}

/* The pass types this coach last put in a bundle, newest first. Kept in this
 * browser only: it is a convenience for the picker, never a record, so losing
 * it just means the picker suggests the catalogue's first few instead. */
const RECENT_KEY = "clarity.bundle.recentPassTypes";
const SUGGESTED = 4;

function readRecentPassTypes(): string[] {
  try {
    const stored = JSON.parse(globalThis.localStorage?.getItem(RECENT_KEY) || "[]");
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function rememberPassType(id: string) {
  try {
    const next = [id, ...readRecentPassTypes().filter((entry) => entry !== id)].slice(0, 12);
    globalThis.localStorage?.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Private window or blocked storage: the picker still works without it.
  }
}

/** "+ Add pass type", opening to a search box with a few recent picks under it. */
function PassTypePicker({ passTypes, onPick }: { passTypes: Service[]; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  if (!open) {
    return (
      <button
        className="outline-button bundle-add-button"
        type="button"
        disabled={!passTypes.length}
        onClick={() => setOpen(true)}
      >
        <Plus size={16} /> {t("Add pass type")}
      </button>
    );
  }

  const wanted = query.trim().toLowerCase();
  let shown: Service[];
  if (wanted) {
    shown = passTypes.filter((service) => service.name.toLowerCase().includes(wanted)).slice(0, 8);
  } else {
    const recent = readRecentPassTypes()
      .map((id) => passTypes.find((service) => service.id === id))
      .filter((service): service is Service => Boolean(service));
    const rest = passTypes.filter((service) => !recent.includes(service));
    shown = [...recent, ...rest].slice(0, SUGGESTED);
  }

  function pick(id: string) {
    onPick(id);
    setQuery("");
    setOpen(false);
  }

  return (
    <div className="bundle-picker">
      <label className="bundle-picker-search">
        <Search size={16} aria-hidden="true" />
        <input
          autoFocus
          value={query}
          placeholder={t("Search pass types")}
          aria-label={t("Search pass types")}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
            if (event.key === "Enter") {
              event.preventDefault();
              if (shown[0]) pick(shown[0].id);
            }
          }}
        />
      </label>
      {shown.length ? (
        <ul className="bundle-picker-results">
          {shown.map((service) => (
            <li key={service.id}>
              <button type="button" onClick={() => pick(service.id)}>
                {service.name}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <span className="pass-coverage-empty">{t("No pass types match.")}</span>
      )}
      <button className="text-link-button" type="button" onClick={() => setOpen(false)}>
        {t("Cancel")}
      </button>
    </div>
  );
}
