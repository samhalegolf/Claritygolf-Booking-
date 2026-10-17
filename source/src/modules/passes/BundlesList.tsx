// Billing > Bundles: passes, services and products sold together for one
// price.
//
// A bundle is stored as a `package` entry in the service catalogue carrying
// `bundleItems`, so the till, the invoice picker, the player shop and the
// Optix inbox sell it exactly as they sell a pass type. What it issues is
// different: never a pass of its own, but each pass type it lists as if sold
// separately, and a pass for each service covering just that service
// (grantBundle in _shared/passes.mts). Products issue nothing; a till sale
// takes them off stock (withBundleProducts in billing-api.mts). So a client
// holds ordinary passes, each with its own coverage and expiry, and nothing
// that spends or reverses a credit needs to know bundles exist.

import { useState } from "react";
import { Plus, Search } from "lucide-react";

import type { BillingCatalogItem } from "../billing/types";
import { cleanBundleItems, isBundle, type BundleItem, type BundleItemKind, type Service } from "../services/serviceModel";
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
  /** Billing products: the things on a shelf a bundle can hand over. */
  products: BillingCatalogItem[];
  formatMoney: (amount: number) => string;
  saving: boolean;
  onSave: (draft: BundleDraft) => void;
  onArchive: (service: Service) => void;
};

/** Something a bundle can hold, whatever it is. */
type Choice = { kind: BundleItemKind; id: string; name: string; price: number };

const KIND_LABEL: Record<BundleItemKind, string> = {
  pass: t("Pass"),
  service: t("Service"),
  product: t("Product"),
};

const choiceKey = (item: { kind: BundleItemKind; id: string }) => `${item.kind}:${item.id}`;

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

export function BundlesList({ services, products, formatMoney, saving, onSave, onArchive }: BundlesListProps) {
  const [editing, setEditing] = useState<Service | "new" | null>(null);
  const bundles = services.filter((service) => isBundle(service) && service.archived !== true);
  // What a bundle can hold: pass types (never another bundle), the services
  // themselves, and products on the shelf.
  const choices: Choice[] = [
    ...services
      .filter((service) => service.lessonFormat === "package" && !isBundle(service) && service.archived !== true)
      .map((service) => ({ kind: "pass" as const, id: service.id, name: service.name, price: service.price })),
    ...services
      .filter((service) => service.lessonFormat !== "package" && service.archived !== true)
      .map((service) => ({ kind: "service" as const, id: service.id, name: service.name, price: service.price })),
    ...products
      .filter((product) => product.active !== false)
      .map((product) => ({ kind: "product" as const, id: product.id, name: product.name, price: product.price })),
  ];
  const nameOf = (item: BundleItem) => choices.find((choice) => choiceKey(choice) === choiceKey(item))?.name || item.name;

  function includesLabel(service: Service) {
    return (
      cleanBundleItems(service.bundleItems)
        .map((item) => (nameOf(item) ? `${item.quantity} × ${nameOf(item)}` : ""))
        .filter(Boolean)
        .join(" + ") || "—"
    );
  }

  if (editing) {
    return (
      <BundleEditor
        initial={draftFrom(editing === "new" ? null : editing)}
        isNew={editing === "new"}
        choices={choices}
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
          disabled={!choices.length}
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
  choices,
  formatMoney,
  saving,
  onSave,
  onCancel,
}: {
  initial: BundleDraft;
  isNew: boolean;
  choices: Choice[];
  formatMoney: (amount: number) => string;
  saving: boolean;
  onSave: (draft: BundleDraft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [price, setPrice] = useState(String(initial.price));
  const set = <K extends keyof BundleDraft>(key: K, value: BundleDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const choiceFor = (item: { kind: BundleItemKind; id: string }) =>
    choices.find((choice) => choiceKey(choice) === choiceKey(item));

  function setQuantity(target: Choice | BundleItem, value: string) {
    const quantity = Math.max(0, Math.min(20, Math.round(Number(value) || 0)));
    const key = choiceKey(target);
    const others = draft.items.filter((item) => choiceKey(item) !== key);
    // Keep the bundle's order as the coach built it: a changed line stays put,
    // a new one goes on the end.
    const at = draft.items.findIndex((item) => choiceKey(item) === key);
    if (!quantity) return set("items", others);
    if (at < 0) return set("items", [...draft.items, { kind: target.kind, id: target.id, name: target.name, quantity }]);
    set("items", draft.items.map((item) => (choiceKey(item) === key ? { ...item, quantity } : item)));
  }

  const separately = draft.items.reduce((sum, item) => sum + (choiceFor(item)?.price || 0) * item.quantity, 0);
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
          // Each line keeps the name it has now, for anywhere that shows the
          // bundle without the product list to hand.
          items: draft.items.map((item) => ({ ...item, name: choiceFor(item)?.name || item.name })),
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
          placeholder={t("e.g. 5 Lessons + Swing Review + Glove")}
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
              const name = choiceFor(item)?.name;
              return (
                <li className="bundle-item" key={choiceKey(item)}>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={item.quantity}
                    aria-label={name || item.name || item.id}
                    // Never below one here: clearing the box to retype must
                    // not drop the line. Remove is the way out.
                    onChange={(event) => setQuantity(item, String(Math.max(1, Number(event.target.value) || 1)))}
                  />
                  <span>
                    × {name || t("{name} (no longer available)", { name: item.name || KIND_LABEL[item.kind] })} · {KIND_LABEL[item.kind]}
                  </span>
                  <button className="text-link-button" type="button" onClick={() => setQuantity(item, "0")}>
                    {t("Remove")}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
        <BundleItemPicker
          choices={choices.filter((choice) => !draft.items.some((item) => choiceKey(item) === choiceKey(choice)))}
          onPick={(choice) => {
            rememberChoice(choice);
            setQuantity(choice, "1");
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
        {t("Selling a bundle gives the client each pass inside it with its own credits, cover and expiry, and a pass for each service with a credit per lesson. Products leave stock when the bundle is sold at the till.")}
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

/* What this coach last put in a bundle, newest first. Kept in this browser
 * only: it is a convenience for the picker, never a record, so losing it just
 * means the picker suggests the catalogue's first few instead. */
const RECENT_KEY = "clarity.bundle.recentItems";
const SUGGESTED = 4;

function readRecentChoices(): string[] {
  try {
    const stored = JSON.parse(globalThis.localStorage?.getItem(RECENT_KEY) || "[]");
    return Array.isArray(stored) ? stored.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}

function rememberChoice(choice: Choice) {
  try {
    const key = choiceKey(choice);
    const next = [key, ...readRecentChoices().filter((entry) => entry !== key)].slice(0, 12);
    globalThis.localStorage?.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Private window or blocked storage: the picker still works without it.
  }
}

/** "+ Add item", opening to a search box with a few recent picks under it. */
function BundleItemPicker({ choices, onPick }: { choices: Choice[]; onPick: (choice: Choice) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  if (!open) {
    return (
      <button
        className="outline-button bundle-add-button"
        type="button"
        disabled={!choices.length}
        onClick={() => setOpen(true)}
      >
        <Plus size={16} /> {t("Add item")}
      </button>
    );
  }

  const wanted = query.trim().toLowerCase();
  let shown: Choice[];
  if (wanted) {
    shown = choices.filter((choice) => choice.name.toLowerCase().includes(wanted)).slice(0, 8);
  } else {
    const recent = readRecentChoices()
      .map((key) => choices.find((choice) => choiceKey(choice) === key))
      .filter((choice): choice is Choice => Boolean(choice));
    const rest = choices.filter((choice) => !recent.includes(choice));
    shown = [...recent, ...rest].slice(0, SUGGESTED);
  }

  function pick(choice: Choice) {
    onPick(choice);
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
          placeholder={t("Search passes, services and products")}
          aria-label={t("Search passes, services and products")}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
            if (event.key === "Enter") {
              event.preventDefault();
              if (shown[0]) pick(shown[0]);
            }
          }}
        />
      </label>
      {shown.length ? (
        <ul className="bundle-picker-results">
          {shown.map((choice) => (
            <li key={choiceKey(choice)}>
              <button type="button" onClick={() => pick(choice)}>
                {choice.name} · {KIND_LABEL[choice.kind]}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <span className="pass-coverage-empty">{t("Nothing matches.")}</span>
      )}
      <button className="text-link-button" type="button" onClick={() => setOpen(false)}>
        {t("Cancel")}
      </button>
    </div>
  );
}
