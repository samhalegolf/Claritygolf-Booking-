// Date formatting and currency, derived from the workspace's country.
//
// Both were hardcoded to New Zealand: `toLocaleDateString("en-NZ")` in eight
// places and `currency: "NZD"` in nine. The date one is not cosmetic — NZ writes
// day/month and the US writes month/day, so "07/08" is 7 August to one coach and
// 8 July to another. A coach reading the wrong date misses a lesson.
//
// Isomorphic: imported by both the Netlify functions and the frontend, so it must
// not touch `process` or any Node API.

import { cleanPhoneCountry, getActivePhoneCountry } from "./phone.mts";

// ISO 4217 by country. Not exhaustive — it covers the markets a golf coaching
// business plausibly operates in, and anything unlisted falls back to USD rather
// than silently billing someone in New Zealand dollars.
const CURRENCY_BY_COUNTRY: Record<string, string> = {
  NZ: "NZD",
  AU: "AUD",
  US: "USD",
  CA: "CAD",
  GB: "GBP",
  IE: "EUR",
  ZA: "ZAR",
  SG: "SGD",
  HK: "HKD",
  JP: "JPY",
  KR: "KRW",
  CN: "CNY",
  IN: "INR",
  AE: "AED",
  CH: "CHF",
  SE: "SEK",
  NO: "NOK",
  DK: "DKK",
  MX: "MXN",
  BR: "BRL",
  AR: "ARS",
  TH: "THB",
  MY: "MYR",
  PH: "PHP",
  ID: "IDR",
  VN: "VND",
  // Euro area
  AT: "EUR", BE: "EUR", CY: "EUR", EE: "EUR", FI: "EUR", FR: "EUR", DE: "EUR",
  GR: "EUR", IT: "EUR", LV: "EUR", LT: "EUR", LU: "EUR", MT: "EUR", NL: "EUR",
  PT: "EUR", SK: "EUR", SI: "EUR", ES: "EUR",
};

const FALLBACK_CURRENCY = "USD";

export function currencyForCountry(country: unknown = getActivePhoneCountry()): string {
  return CURRENCY_BY_COUNTRY[cleanPhoneCountry(country)] || FALLBACK_CURRENCY;
}

/**
 * A BCP-47 tag for date and number formatting. We only ever render English text,
 * so the language stays "en" and the region does the work: en-NZ gives 8/07/2026,
 * en-US gives 7/8/2026. Intl falls back sensibly for any region it does not know.
 */
export function localeForCountry(country: unknown = getActivePhoneCountry()): string {
  return `en-${cleanPhoneCountry(country)}`;
}

/** The active workspace's locale — the one nearly every caller wants. */
export function activeLocale(): string {
  return localeForCountry(getActivePhoneCountry());
}

/** The active workspace's currency. */
export function activeCurrency(): string {
  return currencyForCountry(getActivePhoneCountry());
}
