// Everything a workspace's country decides, beyond the phone and date rules in
// phone.mts and locale.mts: which time zones it can be in, and how its tax is
// named, charged and shown.
//
// These are starting points, not rules. Choosing a country fills them in; a
// coach can still change any of them afterwards (a US state's sales tax, a
// business not registered for GST). Tax used to start at New Zealand's GST at
// 15% for everyone, so a UK coach's invoices said "GST" until they noticed.
//
// Isomorphic: imported by both the Netlify functions and the frontend, so it must
// not touch `process` or any Node API.

import { cleanPhoneCountry } from "./phone.mts";
import { currencyForCountry } from "./locale.mts";
import { TIME_ZONES_BY_COUNTRY } from "./time-zones-data.mts";

export type TaxDefaults = {
  /** What the tax is called on invoices and receipts, e.g. "GST", "VAT". */
  taxName: string;
  /** Percent. 0 where the tax varies too much to guess (US sales tax). */
  taxRate: number;
  /** Whether prices a client sees already include the tax. */
  taxInclusive: boolean;
};

// Standard rates on services, as of 2026. Where a country shows consumers
// tax-inclusive prices (most of the world outside North America and India),
// taxInclusive is true.
const TAX_BY_COUNTRY: Record<string, TaxDefaults> = {
  NZ: { taxName: "GST", taxRate: 15, taxInclusive: true },
  AU: { taxName: "GST", taxRate: 10, taxInclusive: true },
  // Sales tax is set by the state and often the city, so there is no rate
  // worth guessing. Prices are shown before tax.
  US: { taxName: "Sales tax", taxRate: 0, taxInclusive: false },
  // Federal GST only; a province with HST or PST needs its own rate.
  CA: { taxName: "GST", taxRate: 5, taxInclusive: false },
  GB: { taxName: "VAT", taxRate: 20, taxInclusive: true },
  IE: { taxName: "VAT", taxRate: 23, taxInclusive: true },
  ZA: { taxName: "VAT", taxRate: 15, taxInclusive: true },
  SG: { taxName: "GST", taxRate: 9, taxInclusive: true },
  HK: { taxName: "Tax", taxRate: 0, taxInclusive: true },
  JP: { taxName: "Consumption tax", taxRate: 10, taxInclusive: true },
  KR: { taxName: "VAT", taxRate: 10, taxInclusive: true },
  CN: { taxName: "VAT", taxRate: 6, taxInclusive: true },
  IN: { taxName: "GST", taxRate: 18, taxInclusive: false },
  AE: { taxName: "VAT", taxRate: 5, taxInclusive: true },
  CH: { taxName: "MWST", taxRate: 8.1, taxInclusive: true },
  SE: { taxName: "Moms", taxRate: 25, taxInclusive: true },
  NO: { taxName: "MVA", taxRate: 25, taxInclusive: true },
  DK: { taxName: "Moms", taxRate: 25, taxInclusive: true },
  MX: { taxName: "IVA", taxRate: 16, taxInclusive: true },
  AR: { taxName: "IVA", taxRate: 21, taxInclusive: true },
  TH: { taxName: "VAT", taxRate: 7, taxInclusive: true },
  MY: { taxName: "SST", taxRate: 8, taxInclusive: false },
  PH: { taxName: "VAT", taxRate: 12, taxInclusive: true },
  ID: { taxName: "PPN", taxRate: 11, taxInclusive: true },
  VN: { taxName: "VAT", taxRate: 10, taxInclusive: true },
  // Euro area
  AT: { taxName: "USt", taxRate: 20, taxInclusive: true },
  BE: { taxName: "VAT", taxRate: 21, taxInclusive: true },
  CY: { taxName: "VAT", taxRate: 19, taxInclusive: true },
  EE: { taxName: "VAT", taxRate: 24, taxInclusive: true },
  FI: { taxName: "ALV", taxRate: 25.5, taxInclusive: true },
  FR: { taxName: "TVA", taxRate: 20, taxInclusive: true },
  DE: { taxName: "MwSt", taxRate: 19, taxInclusive: true },
  GR: { taxName: "VAT", taxRate: 24, taxInclusive: true },
  IT: { taxName: "IVA", taxRate: 22, taxInclusive: true },
  LV: { taxName: "VAT", taxRate: 21, taxInclusive: true },
  LT: { taxName: "VAT", taxRate: 21, taxInclusive: true },
  LU: { taxName: "TVA", taxRate: 17, taxInclusive: true },
  MT: { taxName: "VAT", taxRate: 18, taxInclusive: true },
  NL: { taxName: "BTW", taxRate: 21, taxInclusive: true },
  PT: { taxName: "IVA", taxRate: 23, taxInclusive: true },
  SK: { taxName: "VAT", taxRate: 23, taxInclusive: true },
  SI: { taxName: "DDV", taxRate: 22, taxInclusive: true },
  ES: { taxName: "IVA", taxRate: 21, taxInclusive: true },
};

// A country not in the table gets a neutral label and no rate, so nothing is
// charged until the coach says what their tax is.
const FALLBACK_TAX: TaxDefaults = { taxName: "Tax", taxRate: 0, taxInclusive: false };

export function taxDefaultsForCountry(country: unknown): TaxDefaults {
  return { ...(TAX_BY_COUNTRY[cleanPhoneCountry(country)] ?? FALLBACK_TAX) };
}

// The zone a country starts on when it has several. zone.tab lists them
// roughly east to west, so without this Australia would start on Lord Howe
// Island and Canada on Newfoundland.
const MAIN_TIME_ZONE: Record<string, string> = {
  AU: "Australia/Sydney",
  BR: "America/Sao_Paulo",
  CA: "America/Toronto",
  RU: "Europe/Moscow",
  UA: "Europe/Kyiv",
};

const FALLBACK_TIME_ZONE = "UTC";

export type TimeZoneOption = {
  zone: string;
  /** "Auckland", or "Sydney — New South Wales (most areas)" when a country has several. */
  label: string;
};

function cityOf(zone: string): string {
  return zone.split("/").pop()!.replace(/_/g, " ");
}

/** The time zones a business in this country can be in, in tz database order. */
export function timeZonesForCountry(country: unknown): TimeZoneOption[] {
  const zones = TIME_ZONES_BY_COUNTRY[cleanPhoneCountry(country)] ?? [];
  return zones.map(([zone, note]) => ({
    zone,
    label: zones.length > 1 && note ? `${cityOf(zone)} — ${note}` : cityOf(zone),
  }));
}

export function defaultTimeZoneForCountry(country: unknown): string {
  const code = cleanPhoneCountry(country);
  return MAIN_TIME_ZONE[code] ?? TIME_ZONES_BY_COUNTRY[code]?.[0]?.[0] ?? FALLBACK_TIME_ZONE;
}

/**
 * Keep the current zone if it belongs to the new country; otherwise move to the
 * country's main one. Changing Auckland to Australia should not leave the
 * business on New Zealand time.
 */
export function timeZoneForCountryChange(country: unknown, currentZone: unknown): string {
  const zone = String(currentZone ?? "");
  return timeZonesForCountry(country).some((option) => option.zone === zone)
    ? zone
    : defaultTimeZoneForCountry(country);
}

/** "UTC+13:00" for the zone at the given moment, or "" if the runtime cannot say. */
export function timeZoneOffsetLabel(zone: string, at: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat("en", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((item) => item.type === "timeZoneName")?.value;
    return part ? part.replace(/^GMT/, "UTC").replace(/^UTC$/, "UTC+00:00") : "";
  } catch {
    return "";
  }
}

export type RegionDefaults = TaxDefaults & { currency: string; timezone: string };

/** Everything choosing a country fills in, in one place. */
export function regionDefaultsForCountry(country: unknown, currentZone?: unknown): RegionDefaults {
  return {
    currency: currencyForCountry(country),
    timezone: timeZoneForCountryChange(country, currentZone),
    ...taxDefaultsForCountry(country),
  };
}
