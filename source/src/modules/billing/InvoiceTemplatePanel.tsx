// Settings > Billing > the invoice template, edited on a sample invoice rather
// than in a column of labelled boxes.
//
// The standing details — logo, address, tax number, header line, bank account,
// payment instructions, default note, footer — are the same document every
// client receives, so they are written where they will be read. Anything left
// blank simply does not print, which the sheet shows by leaving the slot as an
// invitation instead of a placeholder a client would mistake for real text.
//
// The lines and totals are an example, so the template can be seen in use. They
// are not editable here; writing lines is the New invoice flow.
//
// Presentational: it renders the settings it is given and reports edits back
// through onChange, owning no fetching and no settings state.

import { useState } from "react";
import { Check, ImageIcon, Pencil, RotateCcw, Smartphone, X } from "lucide-react";
import { computeInvoiceTotals } from "./invoiceMath";
import type { InvoiceLine, InvoiceSettings } from "./types";

/** The fields this sheet owns. Everything else about invoicing stays a form field. */
export type InvoiceTemplateField =
  | "businessAddress"
  | "taxNumber"
  | "headerText"
  | "bankAccount"
  | "paymentInstructions"
  | "defaultCustomerNote"
  | "footerText";

const TEMPLATE_FIELDS: InvoiceTemplateField[] = [
  "businessAddress",
  "taxNumber",
  "headerText",
  "bankAccount",
  "paymentInstructions",
  "defaultCustomerNote",
  "footerText",
];

// An example invoice. Three lines with a percentage discount, a plain line and a
// fixed discount, so the totals block shows every row it can show.
const EXAMPLE_LINES: InvoiceLine[] = [
  {
    id: "example-1",
    source: "booking_snapshot",
    description: "45 min private lesson",
    quantity: 3,
    unitPrice: 120,
    taxRate: 0,
    discountKind: "percent",
    discountValue: 10,
    discountAmount: 36,
    serviceDate: "",
    tag: "",
  },
  {
    id: "example-2",
    source: "catalog",
    description: "Golf balls, dozen",
    quantity: 1,
    unitPrice: 89,
    taxRate: 0,
    discountKind: "none",
    discountValue: 0,
    discountAmount: 0,
    serviceDate: "",
    tag: "",
  },
  {
    id: "example-3",
    source: "package_sale",
    description: "Six lesson block",
    quantity: 1,
    unitPrice: 660,
    taxRate: 0,
    discountKind: "amount",
    discountValue: 60,
    discountAmount: 60,
    serviceDate: "",
    tag: "",
  },
];

const EXAMPLE_NOTES: Record<string, string> = {
  "example-1": "3 lessons · Aug 4, 11, 18",
  "example-2": "From the catalog",
  "example-3": "Package sale",
};

export type InvoiceTemplatePanelProps = {
  settings: InvoiceSettings;
  /** Read-only until the settings block is put into edit mode. */
  locked: boolean;
  businessName: string;
  logoUrl: string;
  /** Formats an amount in the workspace's currency. */
  formatMoney: (value: number) => string;
  onChange: (field: InvoiceTemplateField, value: string) => void;
};

export function InvoiceTemplatePanel({
  settings,
  locked,
  businessName,
  logoUrl,
  formatMoney,
  onChange,
}: InvoiceTemplatePanelProps) {
  const [editing, setEditing] = useState<InvoiceTemplateField | "">("");
  const [draft, setDraft] = useState("");
  const [narrow, setNarrow] = useState(false);
  // Preview-only. Whether an invoice is tax-inclusive is decided per invoice,
  // not here — this just shows the template both ways round.
  const [taxInclusive, setTaxInclusive] = useState(true);

  const totals = computeInvoiceTotals(
    { lines: EXAMPLE_LINES, discountAmount: 0, taxInclusive },
    settings.taxRate,
  );

  function beginEdit(field: InvoiceTemplateField) {
    if (locked) return;
    setEditing(field);
    setDraft(settings[field]);
  }

  function cancelEdit() {
    setEditing("");
    setDraft("");
  }

  function commit() {
    if (!editing) return;
    onChange(editing, draft);
    cancelEdit();
  }

  /** Clears every field this sheet owns. The invoice then prints none of them. */
  function resetAll() {
    if (locked) return;
    for (const field of TEMPLATE_FIELDS) onChange(field, "");
    cancelEdit();
  }

  const anySet = TEMPLATE_FIELDS.some((field) => settings[field].trim());

  // One standing detail. Blank reads as an invitation rather than as text, so
  // nothing on the sheet can be mistaken for what a client will actually see.
  function slot(
    field: InvoiceTemplateField,
    options: { className?: string; multiline?: boolean; rows?: number; label: string; empty: string },
  ) {
    const value = settings[field];
    if (editing === field) {
      return (
        <span className={`it-editing${options.className ? ` ${options.className}` : ""}`}>
          {options.multiline ? (
            <textarea
              value={draft}
              rows={options.rows ?? 3}
              onChange={(event) => setDraft(event.target.value)}
              aria-label={options.label}
              autoFocus
            />
          ) : (
            <input value={draft} onChange={(event) => setDraft(event.target.value)} aria-label={options.label} autoFocus />
          )}
          <button className="it-commit" onClick={commit} type="button" aria-label={`Save ${options.label}`}>
            <Check size={14} />
          </button>
          <button className="it-cancel" onClick={cancelEdit} type="button" aria-label={`Cancel ${options.label}`}>
            <X size={14} />
          </button>
        </span>
      );
    }
    return (
      <button
        className={`it-slot${value.trim() ? "" : " is-empty"}${options.className ? ` ${options.className}` : ""}`}
        onClick={() => beginEdit(field)}
        disabled={locked}
        title={locked ? undefined : options.label}
        type="button"
      >
        <span className="it-slot-value">{value.trim() || options.empty}</span>
        {!locked && (
          <span className="it-slot-pencil">
            <Pencil size={13} />
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="invoice-template">
      <div className="it-toolbar">
        <span className="it-dashed-key">
          <span className="it-dashed-swatch" />
          Dashed is yours to write
        </span>
        <button
          className="it-tax-mode"
          onClick={() => setTaxInclusive((current) => !current)}
          title={`Inclusive prices already contain ${settings.taxName}; on top adds it to the total`}
          type="button"
        >
          {taxInclusive ? `${settings.taxName} inclusive` : `${settings.taxName} on top`}
        </button>
        <button
          className={`it-width${narrow ? " is-active" : ""}`}
          onClick={() => setNarrow((current) => !current)}
          aria-pressed={narrow}
          title="Preview at phone width"
          type="button"
        >
          <Smartphone size={16} />
        </button>
        {/* Rule 10: clearing the whole template is text, not a filled button
            beside the sheet it would empty. */}
        <button className="text-button" onClick={resetAll} disabled={locked || !anySet} type="button">
          <RotateCcw size={14} />
          Clear every field
        </button>
      </div>

      <p className="settings-note">
        Lines and totals below are an example, so you can see the template in use. The number, dates, bill-to block and
        the lines come from the invoice itself.
      </p>

      <div className="it-mat">
        <div className={`it-sheet${narrow ? " is-narrow" : ""}`}>
          <div className="it-head">
            <span className={`it-logo${logoUrl ? "" : " is-empty"}`} title="Set in Settings › Business">
              {logoUrl ? <img src={logoUrl} alt={`${businessName} logo`} /> : <ImageIcon size={18} />}
            </span>

            <div className="it-issuer">
              {businessName.trim() ? (
                <strong>{businessName}</strong>
              ) : (
                <span className="it-from-business">Set your business name in Settings › Business</span>
              )}
              {slot("businessAddress", {
                className: "it-address",
                multiline: true,
                rows: 3,
                label: "Business address",
                empty: "Add your business address",
              })}
              {slot("taxNumber", {
                className: "it-taxnumber",
                label: `${settings.taxName} number`,
                empty: `Add your ${settings.taxName} number`,
              })}
            </div>

            <div className="it-meta">
              <strong>
                {settings.prefix}-{String(settings.nextNumber).padStart(4, "0")}
              </strong>
              <span>Issued 12 Aug 2026</span>
              <span>Due 19 Aug 2026</span>
              <span>
                {settings.paymentTermsDays === 0
                  ? "Due on receipt"
                  : `Payment terms ${settings.paymentTermsDays} day${settings.paymentTermsDays === 1 ? "" : "s"}`}
              </span>
            </div>
          </div>

          <div className="it-headertext">
            {slot("headerText", { label: "Header line", empty: "A line under your name, on every invoice" })}
          </div>

          <div className="it-parties">
            <div>
              <span className="it-label">Bill to</span>
              <strong>[client name]</strong>
              <em>From the invoice</em>
            </div>
            <div>
              <span className="it-label">Reference</span>
              <strong>Lessons, Aug 2026</strong>
              <em>From the invoice</em>
            </div>
          </div>

          <div className="it-lines">
            <div className="it-line it-line-head">
              <span>Item</span>
              <span>Qty</span>
              <span>Unit</span>
              <span>Amount</span>
            </div>
            {EXAMPLE_LINES.map((line) => (
              <div className="it-line" key={line.id}>
                <span className="it-line-desc">
                  {line.description}
                  <em>{EXAMPLE_NOTES[line.id]}</em>
                </span>
                <span className="it-line-qty">{line.quantity}</span>
                <span className="it-line-unit">{formatMoney(line.unitPrice)}</span>
                <span className="it-line-amount">{formatMoney(line.quantity * line.unitPrice - line.discountAmount)}</span>
              </div>
            ))}
          </div>

          <div className="it-totals">
            <div className="it-total-row">
              <span>Subtotal</span>
              <span>{formatMoney(totals.lineSubtotal)}</span>
            </div>
            {totals.lineDiscountTotal > 0 && (
              <div className="it-total-row">
                <span>Line discounts</span>
                <span>− {formatMoney(totals.lineDiscountTotal)}</span>
              </div>
            )}
            <div className="it-total-row">
              <span>
                {settings.taxName} {settings.taxRate}%{taxInclusive ? " (included)" : ""}
              </span>
              <span>{formatMoney(totals.taxTotal)}</span>
            </div>
            <div className="it-total-row it-total-grand">
              <span>Total {taxInclusive ? `incl. ${settings.taxName}` : "due"}</span>
              <span>{formatMoney(totals.total)}</span>
            </div>
          </div>

          <div className="it-block">
            <span className="it-label">How to pay</span>
            {slot("bankAccount", { label: "Bank account", empty: "Add your bank account" })}
            {slot("paymentInstructions", {
              multiline: true,
              rows: 2,
              label: "Payment instructions",
              empty: "Add payment instructions",
            })}
          </div>

          <div className="it-block">
            <span className="it-label">Note to the client</span>
            {slot("defaultCustomerNote", {
              multiline: true,
              rows: 2,
              label: "Default note",
              empty: "A note on every invoice — the one-off note is written per invoice",
            })}
          </div>

          <div className="it-foot">
            {slot("footerText", { label: "Footer", empty: "A footer line, on every invoice" })}
          </div>
        </div>
      </div>

      <p className="settings-note">
        Everything dashed is saved here once and used on every invoice. Left blank, it simply does not print.
      </p>
    </div>
  );
}
