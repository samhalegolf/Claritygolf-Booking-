// The workspace's country, for the browser.
//
// This value used to live in netlify/functions/_shared/phone.mts and was shared
// by both sides. On the server that was a cross-tenant leak: one warm instance
// serves many businesses, and the country the last request set was still in
// place for the next one. So it was removed there, and the country became an
// explicit argument.
//
// Here it is exactly the right model, and not a compromise. A browser tab holds
// one signed-in coach in one workspace. Threading the country through every
// date and phone format in a 30,000-line component would be noise standing in
// for a decision that was made once, when the account loaded.
//
// The rules themselves are still the shared ones -- this module holds the
// country and nothing else, so the client and server can never disagree about
// what a bare "0274637700" means. Disagreeing is what produced duplicate
// contacts and failed calendar saves in the first place.

import {
  canonicalPhoneKey as sharedCanonicalPhoneKey,
  cleanPhoneCountry,
  dialCodeFor as sharedDialCodeFor,
  formatPhoneForDisplay as sharedFormatPhoneForDisplay,
  isValidPhone as sharedIsValidPhone,
  FALLBACK_PHONE_COUNTRY,
  type CountryCode,
} from "../../netlify/functions/_shared/phone.mts";
import {
  currencyForCountry,
  localeForCountry,
} from "../../netlify/functions/_shared/locale.mts";

let activeCountry: CountryCode = FALLBACK_PHONE_COUNTRY;

/** Called once when the account loads, and again if the coach changes country. */
export function setActiveCountry(value: unknown): CountryCode {
  activeCountry = cleanPhoneCountry(value);
  return activeCountry;
}

export function getActiveCountry(): CountryCode {
  return activeCountry;
}

/** This workspace's locale, for dates and numbers. */
export function activeLocale(): string {
  return localeForCountry(activeCountry);
}

/** This workspace's currency. */
export function activeCurrency(): string {
  return currencyForCountry(activeCountry);
}

export function canonicalPhoneKey(value: unknown, country: CountryCode = activeCountry): string {
  return sharedCanonicalPhoneKey(value, country);
}

export function formatPhoneForDisplay(value: unknown, country: CountryCode = activeCountry): string {
  return sharedFormatPhoneForDisplay(value, country);
}

export function isValidPhone(value: unknown, country: CountryCode = activeCountry): boolean {
  return sharedIsValidPhone(value, country);
}

export function dialCodeFor(country: CountryCode = activeCountry): string {
  return sharedDialCodeFor(country);
}
