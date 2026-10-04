import { activeCurrency, activeLocale } from "./activeCountry";

/**
 * Money in the coach app: formatting an amount in the business's currency,
 * and reading what a coach typed into a price or quantity box.
 */

// --- Bank CSV import (expenses) ---------------------------------------------
// Self-contained parser: quote-aware, handles escaped "" quotes, mixed line
// endings and a BOM.

// Currency follows the workspace country. It was hardcoded to NZD, which meant
// a coach in another country was quoted prices in New Zealand dollars.
/* Clarity Pay's cut in words: "1%", "1% + $0.30", "$0.30". */
export function clarityPayFeeLabel(fee: { percent: number; fixedCents: number }) {
  const parts = [
    fee.percent > 0 ? `${fee.percent}%` : "",
    fee.fixedCents > 0 ? formatMoney(fee.fixedCents / 100) : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" + ") : "nothing";
}

export function formatMoney(amount: number, currency = activeCurrency()) {
  return new Intl.NumberFormat(activeLocale(), {
    style: "currency",
    currency: currency || activeCurrency(),
    maximumFractionDigits: 2,
  }).format(Number.isFinite(amount) ? amount : 0);
}

// The currency's symbol (e.g. "$") for the active/selected currency, used to
// prefix money inputs in the invoice editor so a raw number never shows without
// its unit. Falls back to "$" if the locale can't produce one.
export function currencySymbol(currency = activeCurrency()) {
  try {
    const parts = new Intl.NumberFormat(activeLocale(), {
      style: "currency",
      currency: currency || activeCurrency(),
      maximumFractionDigits: 0,
    }).formatToParts(0);
    return parts.find((part) => part.type === "currency")?.value || "$";
  } catch {
    return "$";
  }
}

export function parseMoneyInput(value: string) {
  const normalised = value.replace(/,/g, "").replace(/[^0-9.]/g, "");
  const firstDot = normalised.indexOf(".");
  const cleaned =
    firstDot === -1
      ? normalised
      : `${normalised.slice(0, firstDot + 1)}${normalised.slice(firstDot + 1).replace(/\./g, "")}`;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseQuantityInput(value: string) {
  return Math.max(0, Math.round(parseMoneyInput(value)));
}

export function parseDraftNumber(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}
