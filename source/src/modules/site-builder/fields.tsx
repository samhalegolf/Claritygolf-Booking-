// The inspector's fields. Small, and the same everywhere in the editor.
import { ArrowDown, ArrowUp, ImagePlus, Plus, Trash2 } from "lucide-react";
import { useState, type ChangeEvent, type ReactNode } from "react";

import type { SiteButton, SiteImage } from "../../../netlify/functions/_shared/site/document.mts";
import { t } from "../../lib/i18n";
import { prepareImage } from "./imagePrep";
import { uploadSiteImage } from "./siteApi";

export function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <label className="settings-field site-field">
      <span>{label}</span>
      {children}
      {help ? <em className="site-field-help">{help}</em> : null}
    </label>
  );
}

export function TextInput({
  label,
  value,
  onChange,
  maxLength = 200,
  placeholder,
  help,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  maxLength?: number;
  placeholder?: string;
  help?: string;
}) {
  return (
    <Field label={label} help={help}>
      <input value={value} maxLength={maxLength} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}

export function TextArea({
  label,
  value,
  onChange,
  rows = 4,
  maxLength = 8000,
  help,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  maxLength?: number;
  help?: string;
}) {
  return (
    <Field label={label} help={help}>
      <textarea value={value} rows={rows} maxLength={maxLength} onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}

export function SelectInput<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (next: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
}) {
  return (
    <Field label={label}>
      <select value={value} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => (
          <option value={option.value} key={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function NumberInput({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
  step?: number;
}) {
  return (
    <Field label={label}>
      <input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value) || min)} />
    </Field>
  );
}

export function ToggleInput({ label, checked, onChange }: { label: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <label className="site-toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function ColorInput({ label, value, onChange }: { label: string; value: string; onChange: (next: string) => void }) {
  return (
    <label className="site-colour">
      <input type="color" value={value} aria-label={label} onChange={(event) => onChange(event.target.value)} />
      <span>{label}</span>
      <code>{value}</code>
    </label>
  );
}

/**
 * A picture: uploaded from the coach's computer (shrunk first), or pasted
 * as an address. Either way the block only ever holds an https URL.
 */
export function ImageInput({
  label,
  value,
  onChange,
  onError,
}: {
  label: string;
  value: SiteImage | null;
  onChange: (next: SiteImage | null) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    try {
      const prepared = await prepareImage(file);
      const url = await uploadSiteImage(prepared.type, prepared.dataBase64);
      onChange({ url, alt: value?.alt || "" });
    } catch (error) {
      onError(error instanceof Error && error.message !== "unreadable" && error.message !== "not-an-image" ? error.message : t("Could not read that picture. Try a JPG or PNG."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="site-image-field">
      <span className="site-image-field-label">{label}</span>
      {value?.url ? <img className="site-image-field-preview" src={value.url} alt="" /> : null}
      <div className="site-image-field-actions">
        <label className="outline-button logo-upload">
          <ImagePlus size={16} />
          {busy ? t("Uploading…") : value?.url ? t("Replace picture") : t("Upload picture")}
          <input accept="image/*" type="file" disabled={busy} onChange={(event) => void upload(event)} />
        </label>
        {value?.url ? (
          <button className="outline-button" type="button" onClick={() => onChange(null)}>
            <Trash2 size={16} />
            {t("Remove")}
          </button>
        ) : null}
      </div>
      <TextInput
        label={t("Or paste a picture address")}
        value={value?.url || ""}
        maxLength={2000}
        placeholder="https://…"
        onChange={(url) => onChange(url ? { url, alt: value?.alt || "" } : null)}
      />
      {value?.url ? (
        <TextInput label={t("Describe the picture")} value={value.alt} maxLength={200} onChange={(alt) => onChange({ ...value, alt })} help={t("Read out by screen readers, and shown if the picture fails to load.")} />
      ) : null}
    </div>
  );
}

/** A button: its words, where it goes, and how it looks. */
export function ButtonInput({
  label,
  value,
  onChange,
  bookingHref,
  allowRemove = true,
}: {
  label: string;
  value: SiteButton | null;
  onChange: (next: SiteButton | null) => void;
  bookingHref: string;
  allowRemove?: boolean;
}) {
  if (!value) {
    return (
      <button className="outline-button" type="button" onClick={() => onChange({ label: t("Book a lesson"), href: bookingHref, style: "primary" })}>
        <Plus size={16} />
        {label}
      </button>
    );
  }
  return (
    <fieldset className="site-fieldset">
      <legend>{label}</legend>
      <TextInput label={t("Button text")} value={value.label} maxLength={60} onChange={(next) => onChange({ ...value, label: next })} />
      <TextInput label={t("Goes to")} value={value.href} maxLength={2000} placeholder="https://…  #contact  mailto:…" onChange={(href) => onChange({ ...value, href })} />
      <div className="site-inline-actions">
        <button className="outline-button" type="button" onClick={() => onChange({ ...value, href: bookingHref })}>
          {t("Use my booking page")}
        </button>
        {allowRemove ? (
          <button className="outline-button" type="button" onClick={() => onChange(null)}>
            <Trash2 size={16} />
            {t("Remove")}
          </button>
        ) : null}
      </div>
      <SelectInput
        label={t("Style")}
        value={value.style}
        onChange={(style) => onChange({ ...value, style })}
        options={[
          { value: "primary", label: t("Filled") },
          { value: "secondary", label: t("Quiet") },
        ]}
      />
    </fieldset>
  );
}

/**
 * An ordered list of things with fields: feature points, prices, questions.
 * Each item folds shut so a long list stays a list; the one just added opens.
 */
export function ListEditor<T extends { id: string }>({
  items,
  onChange,
  max,
  addLabel,
  create,
  itemLabel,
  render,
}: {
  items: T[];
  onChange: (next: T[]) => void;
  max: number;
  addLabel: string;
  create: () => T;
  itemLabel: (item: T, index: number) => string;
  render: (item: T, update: (patch: Partial<T>) => void) => ReactNode;
}) {
  const [openId, setOpenId] = useState("");
  const move = (index: number, delta: number) => {
    const next = [...items];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    onChange(next);
  };
  return (
    <div className="site-list">
      {items.map((item, index) => (
        <details
          className="site-list-item"
          key={item.id}
          open={openId === item.id}
          onToggle={(event) => setOpenId((event.target as HTMLDetailsElement).open ? item.id : openId === item.id ? "" : openId)}
        >
          <summary>
            <span>{itemLabel(item, index) || t("Untitled")}</span>
            <span className="site-list-item-actions" onClick={(event) => event.preventDefault()}>
              <button type="button" className="icon-button" aria-label={t("Move up")} disabled={index === 0} onClick={() => move(index, -1)}>
                <ArrowUp size={14} />
              </button>
              <button type="button" className="icon-button" aria-label={t("Move down")} disabled={index === items.length - 1} onClick={() => move(index, 1)}>
                <ArrowDown size={14} />
              </button>
              <button type="button" className="icon-button" aria-label={t("Remove")} onClick={() => onChange(items.filter((candidate) => candidate.id !== item.id))}>
                <Trash2 size={14} />
              </button>
            </span>
          </summary>
          <div className="site-list-item-body">
            {render(item, (patch) => onChange(items.map((candidate) => (candidate.id === item.id ? { ...candidate, ...patch } : candidate))))}
          </div>
        </details>
      ))}
      {items.length < max ? (
        <button
          className="outline-button"
          type="button"
          onClick={() => {
            const item = create();
            onChange([...items, item]);
            setOpenId(item.id);
          }}
        >
          <Plus size={16} />
          {addLabel}
        </button>
      ) : null}
    </div>
  );
}
