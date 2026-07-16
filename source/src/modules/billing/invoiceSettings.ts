// Invoice-settings model: default values + normalisation of the persisted
// InvoiceSettings shape. Pure (no React, no network, no workspace state), so
// this can be unit-tested on its own. Cut 2 of the billing extraction - moved
// verbatim from App.tsx; behaviour unchanged.

import { clamp } from "../../lib/number";
import type {
  InvoiceCustomField,
  InvoiceCustomFieldPlacement,
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
  unpaidLoudness: 2,
};

export function cleanInvoiceCustomField(field?: Partial<InvoiceCustomField>, index = 0): InvoiceCustomField | null {
  const label = typeof field?.label === "string" ? field.label.trim().slice(0, 80) : "";
  const value = typeof field?.value === "string" ? field.value.trim().slice(0, 180) : "";
  if (!label && !value) return null;
  const placement: InvoiceCustomFieldPlacement =
    field?.placement === "bill-to" || field?.placement === "payment" || field?.placement === "footer"
      ? field.placement
      : "header";
  return {
    id: typeof field?.id === "string" && field.id.trim() ? field.id.trim().slice(0, 80) : `field-${index + 1}`,
    label: label || "Custom field",
    value,
    placement,
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
    unpaidLoudness: [1, 2, 3].includes(Number(settings?.unpaidLoudness))
      ? (Number(settings?.unpaidLoudness) as 1 | 2 | 3)
      : defaultInvoiceSettings.unpaidLoudness,
  };
}
