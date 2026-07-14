// Canonical phone handling for the whole app — frontend and functions both
// import this module.
//
// It exists because phone logic had been hand-rolled three times with three
// different rule sets: App.tsx had canonicalPhoneKey (which folded +64 to 0),
// App.tsx also had phoneVariants (which additionally matched on trailing
// digits), and booking-core had normalizedPersonPhone (which just stripped
// non-digits and folded nothing). The frontend therefore recognised
// "+64274637700" and "0274637700" as the same person while the server did not,
// so the server inserted a second contact row and collided with the
// account-scoped unique index on lower(email). That failed the INSERT, rolled
// back the transaction, and took the coach's whole calendar save down with it.
//
// One implementation, one set of rules, both sides.

import {
  parsePhoneNumberFromString,
  getCountries,
  getCountryCallingCode,
  isSupportedCountry,
  type CountryCode,
} from "libphonenumber-js";

// The country a bare national number (no leading +) is assumed to belong to.
// Override per deployment with CLARITY_PHONE_COUNTRY, or per workspace with the
// account's country setting, which is threaded in as the `country` argument.
export const FALLBACK_PHONE_COUNTRY: CountryCode = "NZ";

export function isPhoneCountry(value: unknown): value is CountryCode {
  const code = String(value ?? "").trim().toUpperCase();
  return code.length === 2 && isSupportedCountry(code);
}

export function cleanPhoneCountry(
  value: unknown,
  fallback: CountryCode = FALLBACK_PHONE_COUNTRY,
): CountryCode {
  const code = String(value ?? "").trim().toUpperCase();
  return isPhoneCountry(code) ? (code as CountryCode) : fallback;
}

// The workspace's home country, held here so the pure key-building helpers on
// both sides can stay callable without threading a country argument through
// every call site. The server sets this while seeding; the frontend sets it
// when the account loads. Both then agree on what a bare "0274637700" means —
// which is the whole point, since disagreeing is what produced duplicate
// contacts in the first place.
let activeCountry: CountryCode = FALLBACK_PHONE_COUNTRY;

export function setActivePhoneCountry(value: unknown): CountryCode {
  activeCountry = cleanPhoneCountry(value);
  return activeCountry;
}

export function getActivePhoneCountry(): CountryCode {
  return activeCountry;
}

// Strip everything a human or a spreadsheet might have decorated the number
// with, while preserving a leading +. Excel writes text cells with a leading
// apostrophe ('+64274637700), which libphonenumber will not parse.
function sanitize(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const plus = /^\s*'?\s*\+/.test(text) ? "+" : "";
  return `${plus}${text.replace(/\D/g, "")}`;
}

function parse(value: unknown, country: CountryCode) {
  const text = sanitize(value);
  if (!text) return null;
  try {
    return parsePhoneNumberFromString(text, country) ?? null;
  } catch {
    return null;
  }
}

// Last-resort key for numbers libphonenumber cannot parse (too short, obvious
// typos, placeholder values). Folding a leading country code back to a trunk
// prefix keeps the international and national spellings of the same broken
// number comparing equal, which is all a dedupe key has to do.
function heuristicKey(value: unknown, country: CountryCode): string {
  let digits = sanitize(value).replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);
  let callingCode = "";
  try {
    callingCode = getCountryCallingCode(country);
  } catch {
    callingCode = "";
  }
  if (
    callingCode &&
    digits.startsWith(callingCode) &&
    digits.length - callingCode.length >= 6
  ) {
    const national = digits.slice(callingCode.length);
    return national.startsWith("0") ? national : `0${national}`;
  }
  return digits.startsWith("0") ? digits : `0${digits}`;
}

/**
 * The value to compare two phone numbers on. Never throws, never returns
 * undefined. Equal keys mean "the same person's phone", which is exactly what
 * contact matching needs — and nothing else should be used for that.
 */
export function canonicalPhoneKey(
  value: unknown,
  country: CountryCode = getActivePhoneCountry(),
): string {
  const parsed = parse(value, cleanPhoneCountry(country));
  if (parsed?.number) return parsed.number; // E.164, e.g. +64274637700
  return heuristicKey(value, cleanPhoneCountry(country));
}

/** Canonical storage form: E.164 (+64274637700), or "" when unparseable. */
export function phoneToE164(
  value: unknown,
  country: CountryCode = getActivePhoneCountry(),
): string {
  const parsed = parse(value, cleanPhoneCountry(country));
  return parsed?.isValid() ? parsed.number : "";
}

/** Human form for the UI: national when local, international when not. */
export function formatPhoneForDisplay(
  value: unknown,
  country: CountryCode = getActivePhoneCountry(),
): string {
  const clean = cleanPhoneCountry(country);
  const parsed = parse(value, clean);
  if (!parsed?.isValid()) return String(value ?? "").trim();
  return parsed.country === clean
    ? parsed.formatNational()
    : parsed.formatInternational();
}

export function isValidPhone(
  value: unknown,
  country: CountryCode = getActivePhoneCountry(),
): boolean {
  const parsed = parse(value, cleanPhoneCountry(country));
  return Boolean(parsed?.isValid());
}

/** "+64" for the given country, or the active one. "" if unknown. */
export function dialCodeFor(
  country: CountryCode = getActivePhoneCountry(),
): string {
  try {
    return `+${getCountryCallingCode(cleanPhoneCountry(country))}`;
  } catch {
    return "";
  }
}

export type PhoneCountryOption = {
  code: CountryCode;
  name: string;
  dialCode: string; // "+64"
};

let cachedOptions: PhoneCountryOption[] | null = null;

/** Every country libphonenumber knows, for the country/prefix dropdown. */
export function phoneCountryOptions(locale = "en"): PhoneCountryOption[] {
  if (cachedOptions) return cachedOptions;
  const names =
    typeof Intl !== "undefined" && "DisplayNames" in Intl
      ? new Intl.DisplayNames([locale], { type: "region" })
      : null;
  cachedOptions = getCountries()
    .map((code) => ({
      code,
      name: names?.of(code) ?? code,
      dialCode: `+${getCountryCallingCode(code)}`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return cachedOptions;
}
