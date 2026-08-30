// Invoice-settings model: default values + normalisation of the persisted
// InvoiceSettings shape. Pure (no React, no network, no workspace state), so
// this can be unit-tested on its own. Cut 2 of the billing extraction - moved
// verbatim from App.tsx; behaviour unchanged.

import { clamp } from "../../lib/number";
import type {
  InvoiceCustomField,
  InvoiceCustomFieldPlacement,
  InvoiceLineTag,
  InvoiceSettings,
} from "./types";

export const DEFAULT_TAX_RATE = 15;

export const defaultInvoiceSettings: InvoiceSettings = {
  enabled: true,
  showBillingWorkspace: true,
  prefix: "INV",
  nextNumber: 1001,
  currency: "NZD", // seed value; readCoachAccount derives the real one from country
  taxName: "GST",
  taxNumber: "",
  taxRate: DEFAULT_TAX_RATE,
  bankAccount: "",
  paymentTermsDays: 7,
  businessAddress: "",
  headerText: "",
  // Footer and payment instructions are optional and not defaulted - they only
  // appear on an invoice when the coach has actually set them in Billing Settings.
  footerText: "",
  defaultCustomerNote: "",
  paymentInstructions: "",
  customFields: [],
  // No tags until the coach adds some - see InvoiceSettings.lineTags.
  lineTags: [],
  unpaidLoudness: 2,
};

/**
 * Normalises one of the coach's invoice custom fields.
 *
 * A blank row is deliberately kept rather than dropped, and neither the label
 * nor the value is trimmed. This runs through cleanCoachAccount on every
 * keystroke in the settings editor and the result is what the inputs render
 * from, so dropping a blank row would make "Add Field" appear to do nothing,
 * and a trim here would swallow the space in "Bank Name" as it was typed.
 * Blank rows and untrimmed labels are dealt with where the fields are actually
 * printed - see printableInvoiceCustomFields.
 */
export function cleanInvoiceCustomField(field?: Partial<InvoiceCustomField>, index = 0): InvoiceCustomField | null {
  if (!field || typeof field !== "object") return null;
  const placement: InvoiceCustomFieldPlacement =
    field.placement === "bill-to" || field.placement === "payment" || field.placement === "footer"
      ? field.placement
      : "header";
  return {
    id: typeof field.id === "string" && field.id.trim() ? field.id.trim().slice(0, 80) : `field-${index + 1}`,
    label: typeof field.label === "string" ? field.label.slice(0, 80) : "",
    value: typeof field.value === "string" ? field.value.slice(0, 180) : "",
    placement,
  };
}

/**
 * The custom fields worth printing on an invoice, trimmed for display. A row
 * with neither a label nor a value is one the coach has added but not filled in
 * yet, so it is dropped here rather than in cleanInvoiceCustomField; a row with
 * only a value still prints, under the same "Custom field" heading it used to
 * get from normalisation.
 */
export function printableInvoiceCustomFields(fields: InvoiceCustomField[]): InvoiceCustomField[] {
  const printable: InvoiceCustomField[] = [];
  for (const field of fields) {
    const label = field.label.trim();
    const value = field.value.trim();
    if (!label && !value) continue;
    printable.push({ ...field, label: label || "Custom field", value });
  }
  return printable;
}

/**
 * Normalises one entry in the coach's invoice-line tag list. The id is kept as-is
 * when it already exists, so saving the settings never renumbers tags out from
 * under the invoice lines that reference them.
 *
 * An empty label is deliberately kept rather than dropped. This runs through
 * cleanCoachAccount on every keystroke in the settings editor, so dropping a
 * blank row would delete it the moment a coach cleared the field to retype it -
 * and would make "Add tag" appear to do nothing at all. Unlabelled tags are
 * filtered out where they would actually be seen (the line's Tag picker).
 */
export function cleanInvoiceLineTag(tag?: Partial<InvoiceLineTag>, index = 0): InvoiceLineTag | null {
  if (!tag || typeof tag !== "object") return null;
  return {
    id: typeof tag.id === "string" && tag.id.trim() ? tag.id.trim().slice(0, 80) : `tag-${index + 1}`,
    // Not trimmed: this normalises the settings draft on every keystroke, and a
    // trim here would swallow the space in "Coach Jordan" as it was typed.
    // Callers trim when they display or compare.
    label: typeof tag.label === "string" ? tag.label.slice(0, 60) : "",
  };
}

export function cleanInvoiceSettings(settings?: Partial<InvoiceSettings>): InvoiceSettings {
  const taxRate = Number(settings?.taxRate ?? defaultInvoiceSettings.taxRate);
  const paymentTermsDays = Number(settings?.paymentTermsDays ?? defaultInvoiceSettings.paymentTermsDays);
  const nextNumber = Number(settings?.nextNumber ?? defaultInvoiceSettings.nextNumber);
  const customFields = Array.isArray(settings?.customFields)
    ? settings.customFields
        .map((field, index) => cleanInvoiceCustomField(field, index))
        .filter((field): field is InvoiceCustomField => Boolean(field))
        .slice(0, 12)
    : [];
  // Duplicate ids would make the picker ambiguous and split one tag's lines into
  // two buckets, so the first entry to claim an id keeps it.
  const seenTagIds = new Set<string>();
  const lineTags: InvoiceLineTag[] = [];
  if (Array.isArray(settings?.lineTags)) {
    for (const [index, raw] of settings.lineTags.entries()) {
      if (lineTags.length >= 40) break;
      const tag = cleanInvoiceLineTag(raw, index);
      if (!tag || seenTagIds.has(tag.id)) continue;
      seenTagIds.add(tag.id);
      lineTags.push(tag);
    }
  }
  return {
    enabled: settings?.enabled !== false,
    showBillingWorkspace: settings?.showBillingWorkspace !== false,
    prefix:
      typeof settings?.prefix === "string" && settings.prefix.trim()
        ? settings.prefix.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 12)
        : defaultInvoiceSettings.prefix,
    // Any starting number is allowed (min 0 so the field can be cleared while
    // typing; up to 9 digits so year-based schemes like 20260001 work).
    nextNumber: Number.isFinite(nextNumber) ? clamp(Math.round(nextNumber), 0, 999999999) : defaultInvoiceSettings.nextNumber,
    currency:
      typeof settings?.currency === "string" && settings.currency.trim()
        ? settings.currency.trim().toUpperCase().slice(0, 8)
        : defaultInvoiceSettings.currency,
    taxName:
      typeof settings?.taxName === "string" && settings.taxName.trim()
        ? settings.taxName.trim().slice(0, 24)
        : defaultInvoiceSettings.taxName,
    taxNumber: typeof settings?.taxNumber === "string" ? settings.taxNumber.trim().slice(0, 80) : "",
    taxRate: Number.isFinite(taxRate) ? clamp(taxRate, 0, 30) : defaultInvoiceSettings.taxRate,
    bankAccount: typeof settings?.bankAccount === "string" ? settings.bankAccount.trim().slice(0, 120) : "",
    paymentTermsDays: Number.isFinite(paymentTermsDays)
      ? clamp(Math.round(paymentTermsDays), 0, 120)
      : defaultInvoiceSettings.paymentTermsDays,
    businessAddress: typeof settings?.businessAddress === "string" ? settings.businessAddress.trim().slice(0, 400) : "",
    headerText: typeof settings?.headerText === "string" ? settings.headerText.trim().slice(0, 280) : "",
    footerText:
      typeof settings?.footerText === "string" && settings.footerText.trim()
        ? settings.footerText.trim().slice(0, 400)
        : defaultInvoiceSettings.footerText,
    defaultCustomerNote:
      typeof settings?.defaultCustomerNote === "string" && settings.defaultCustomerNote.trim()
        ? settings.defaultCustomerNote.trim().slice(0, 400)
        : defaultInvoiceSettings.defaultCustomerNote,
    paymentInstructions:
      typeof settings?.paymentInstructions === "string" && settings.paymentInstructions.trim()
        ? settings.paymentInstructions.trim().slice(0, 400)
        : defaultInvoiceSettings.paymentInstructions,
    customFields,
    lineTags,
    unpaidLoudness: [1, 2, 3].includes(Number(settings?.unpaidLoudness))
      ? (Number(settings?.unpaidLoudness) as 1 | 2 | 3)
      : defaultInvoiceSettings.unpaidLoudness,
  };
}
