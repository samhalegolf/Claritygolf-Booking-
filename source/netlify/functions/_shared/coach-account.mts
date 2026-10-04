// The business account, built from a business's own settings rows.
//
// One copy, shared. booking-core and the calendar shell (calendar-state) both
// hand the browser this object, and the browser replaces whatever it had with
// it. The shell used to build its own, shorter version that left out country
// and invoice settings, so every calendar load quietly swapped a business's
// country, currency and tax back to the defaults -- New Zealand, NZD, GST --
// and the next save of any account block wrote them to the database.
//
// Kept out of booking-core so the calendar shell can use it without loading
// booking-core, which it deliberately only imports for the heavy routes.

import { defaultCalendarSlug, legacyOriginalWorkspaceId, slugify } from "./account.mts";
import { terminologyFor } from "./business-terminology.mts";
import { currencyForAccountSettings } from "./locale.mts";
import {
  cleanMarketConfig,
  DEFAULT_ACCOUNT_MARKET_CONFIG,
  marketConfigFromSettings,
  marketProfileFor,
} from "./market-profile.mts";
import { cleanMessageLanguage } from "./message-language.mts";
import { cleanPhoneCountry, FALLBACK_PHONE_COUNTRY } from "./phone.mts";
import { taxDefaultsForCountry } from "./region.mts";
import { cleanEmail, cleanString, cleanUrl, env } from "./values.mts";
import { parseSettingJson, settingValue } from "./settings-store.mts";

const defaultInvoiceSettings = {
  enabled: true,
  showBillingWorkspace: true,
  prefix: "INV",
  nextNumber: 1001,
  // No currency or tax here on purpose. Both come from the business's country
  // in cleanInvoiceSettings below; a value here would be read as a choice the
  // business had made, and every new workspace would start in New Zealand
  // dollars with GST.
  taxNumber: "",
  bankAccount: "",
  paymentTermsDays: 7,
  businessAddress: "",
  headerText: "",
  footerText: "Thank you for training with Sam Hale Golf.",
  defaultCustomerNote: "Thanks for your work on the lesson programme. Invoice attached below.",
  paymentInstructions:
    "Please pay by bank transfer and use the invoice number as reference.",
  customFields: [],
  // The coach's own labels for invoice lines, and how loudly the workspace
  // flags unpaid invoices. Both are set in Billing Settings - see
  // src/modules/billing/invoiceSettings.ts, which this mirrors.
  lineTags: [],
  unpaidLoudness: 2,
};

/**
 * Invoice defaults for a business that has not been set up yet.
 *
 * Same shape as defaultInvoiceSettings, minus everything that names the
 * original business -- the footer said "Thank you for training with Sam Hale
 * Golf" on every invoice a second business would have sent.
 */
function neutralInvoiceSettings() {
  return {
    ...defaultInvoiceSettings,
    footerText: "",
    defaultCustomerNote: "",
  };
}


// Original-workspace bootstrapping only — never used as auth fallback or account resolution.
// New workspaces get their own values from DB settings per-account.
/** True only for the business this deployment started life as. */
export function isOriginalWorkspace(accountId) {
  return slugify(accountId, "") === legacyOriginalWorkspaceId();
}

/**
 * Product defaults for a business that has not been set up yet.
 *
 * A new workspace must not open on somebody else's details. Before this, an
 * account with no settings rows fell through to defaultCoachAccount(), so the
 * second business's first login showed "Sam Hale", "Sam Hale Golf" and "The
 * Range 24/7 - Three Kings" -- and its invoices carried "Thank you for training
 * with Sam Hale Golf". Everything identifying starts empty and is filled in
 * during setup; only genuinely product-level things (Clarity's own booking and
 * Caddy URLs, the platform's timezone guess) carry over.
 */
export function neutralCoachAccount(accountId) {
  return {
    id: slugify(accountId, ""),
    coachName: "",
    businessName: "",
    venueName: "",
    venueShortName: "",
    timezone: defaultTimeZone(),
    country: cleanPhoneCountry(env("CLARITY_COUNTRY", FALLBACK_PHONE_COUNTRY)),
    messageLanguage: "en",
    contactEmail: "",
    bookingUrl: env("CLARITY_BOOKING_URL", "https://book.claritygolf.app"),
    calendarSlug: slugify(accountId, ""),
    caddyWorkspaceUrl: env("CLARITY_CADDY_WORKSPACE_URL", "https://caddy.claritygolf.app"),
    terminology: terminologyFor(),
    market: { ...DEFAULT_ACCOUNT_MARKET_CONFIG },
    invoiceSettings: neutralInvoiceSettings(),
  };
}

export function defaultCoachAccount() {
  return {
    id: legacyOriginalWorkspaceId(),
    coachName: env("CLARITY_COACH_NAME", "Sam Hale"),
    businessName: env("CLARITY_BUSINESS_NAME", "Sam Hale Golf"),
    venueName: env("CLARITY_VENUE_NAME", "The Range 24/7 - Three Kings"),
    venueShortName: env("CLARITY_VENUE_SHORT_NAME", "The Range 24/7"),
    timezone: defaultTimeZone(),
    // ISO 3166-1 alpha-2. The workspace's home country: what a phone number
    // with no + is assumed to be, and the default selection in the country
    // dropdown. Everything else that is currently hardcoded to New Zealand
    // (date formatting, currency) should eventually derive from this too.
    country: cleanPhoneCountry(env("CLARITY_COUNTRY", FALLBACK_PHONE_COUNTRY)),
    // The language the business's emails and texts go out in. See
    // message-language.mts.
    messageLanguage: "en",
    contactEmail: env("CLARITY_CONTACT_EMAIL", ""),
    bookingUrl: env("CLARITY_BOOKING_URL", "https://book.claritygolf.app"),
    calendarSlug: defaultCalendarSlug(),
    caddyWorkspaceUrl: env("CLARITY_CADDY_WORKSPACE_URL", "https://caddy.claritygolf.app"),
    terminology: terminologyFor(),
    market: { ...DEFAULT_ACCOUNT_MARKET_CONFIG },
    invoiceSettings: defaultInvoiceSettings,
  };
}

/**
 * Normalises one of the coach's invoice custom fields. Like cleanInvoiceLineTag
 * below, this keeps a blank row and does not trim, so the settings editor gets
 * its draft back unchanged when it saves: an added-but-not-filled-in row stays
 * on screen, and a label still being typed keeps its trailing space. The blank
 * rows are dropped and the labels trimmed where the fields are printed - see
 * printableInvoiceCustomFields in src/modules/billing/invoiceSettings.ts, which
 * this mirrors.
 */
function cleanInvoiceCustomField(field, index = 0) {
  if (!field || typeof field !== "object") return null;
  const placement = ["bill-to", "payment", "footer"].includes(field?.placement)
    ? field.placement
    : "header";
  return {
    id: cleanString(field?.id, `field-${index + 1}`, 80),
    label: typeof field?.label === "string" ? field.label.slice(0, 80) : "",
    value: typeof field?.value === "string" ? field.value.slice(0, 180) : "",
    placement,
  };
}

/**
 * Normalises one of the coach's invoice-line tags. Deliberately keeps a blank
 * label and does not trim, so this is the same shape the browser's
 * cleanInvoiceLineTag returns: the settings editor round-trips its draft
 * through here on save, and a row the coach has added but not named yet has to
 * come back the way it went in rather than disappearing under the cursor.
 */
function cleanInvoiceLineTag(tag, index = 0) {
  if (!tag || typeof tag !== "object") return null;
  return {
    id: cleanString(tag?.id, `tag-${index + 1}`, 80),
    label: typeof tag?.label === "string" ? tag.label.slice(0, 60) : "",
  };
}

function cleanInvoiceSettings(settings = {}, country = FALLBACK_PHONE_COUNTRY) {
  const nextNumber = Number(
    settings?.nextNumber ?? defaultInvoiceSettings.nextNumber,
  );
  // Tax a business has not set yet starts from its country, not from New
  // Zealand's GST -- see taxDefaultsForCountry.
  const tax = taxDefaultsForCountry(country);
  const taxRate = Number(settings?.taxRate ?? tax.taxRate);
  const paymentTermsDays = Number(
    settings?.paymentTermsDays ?? defaultInvoiceSettings.paymentTermsDays,
  );
  const customFields = Array.isArray(settings?.customFields)
    ? settings.customFields
        .map(cleanInvoiceCustomField)
        .filter(Boolean)
        .slice(0, 12)
    : [];
  // Duplicate ids would make the picker ambiguous and split one tag's lines into
  // two buckets, so the first entry to claim an id keeps it.
  const seenTagIds = new Set();
  const lineTags = [];
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
      cleanString(settings?.prefix, defaultInvoiceSettings.prefix, 12)
        .toUpperCase()
        .replace(/[^A-Z0-9-]/g, "") || defaultInvoiceSettings.prefix,
    // Same range the browser allows (see cleanInvoiceSettings in
    // src/modules/billing/invoiceSettings.ts): min 0 so the field can be cleared
    // while typing, and up to 9 digits so a year-based scheme like 20260001
    // survives the save rather than being rewritten to 999999.
    nextNumber: Number.isFinite(nextNumber)
      ? Math.max(0, Math.min(999999999, Math.round(nextNumber)))
      : defaultInvoiceSettings.nextNumber,
    // A business that has chosen a currency keeps it; one that has not gets the
    // one its country uses, rather than New Zealand's. This is the same helper
    // billing-api already invoices with, so the two cannot disagree.
    currency: currencyForAccountSettings(settings?.currency, country),
    taxName: cleanString(settings?.taxName, tax.taxName, 24),
    taxNumber: cleanString(settings?.taxNumber, "", 80),
    taxRate: Number.isFinite(taxRate)
      ? Math.max(0, Math.min(30, taxRate))
      : tax.taxRate,
    taxInclusive:
      typeof settings?.taxInclusive === "boolean" ? settings.taxInclusive : tax.taxInclusive,
    bankAccount: cleanString(settings?.bankAccount, "", 120),
    paymentTermsDays: Number.isFinite(paymentTermsDays)
      ? Math.max(0, Math.min(120, Math.round(paymentTermsDays)))
      : defaultInvoiceSettings.paymentTermsDays,
    businessAddress: cleanString(settings?.businessAddress, "", 400),
    headerText: cleanString(settings?.headerText, "", 280),
    footerText: cleanString(settings?.footerText, defaultInvoiceSettings.footerText, 400),
    defaultCustomerNote: cleanString(settings?.defaultCustomerNote, defaultInvoiceSettings.defaultCustomerNote, 400),
    paymentInstructions: cleanString(settings?.paymentInstructions, defaultInvoiceSettings.paymentInstructions, 400),
    customFields,
    lineTags,
    unpaidLoudness: [1, 2, 3].includes(Number(settings?.unpaidLoudness))
      ? Number(settings?.unpaidLoudness)
      : defaultInvoiceSettings.unpaidLoudness,
  };
}

export function cleanCoachAccount(account) {
  const defaults = defaultCoachAccount();
  // Read-only here: writeCoachAccount does not write it back. The market
  // config is owned by /api/market-profile, so a stale account draft saved
  // from another block cannot revert a profile or capability change.
  const market = cleanMarketConfig(account?.market);
  const businessName = cleanString(account?.businessName, defaults.businessName, 100);
  const venueName = cleanString(account?.venueName, defaults.venueName, 140);
  return {
    id: slugify(account?.id, defaults.id),
    coachName: cleanString(account?.coachName, defaults.coachName, 100),
    businessName,
    venueName,
    venueShortName: cleanString(account?.venueShortName, defaults.venueShortName || venueName, 80),
    timezone: cleanString(account?.timezone, defaults.timezone, 80),
    country: cleanPhoneCountry(account?.country, defaults.country),
    messageLanguage: cleanMessageLanguage(account?.messageLanguage || defaults.messageLanguage),
    contactEmail: cleanEmail(account?.contactEmail, defaults.contactEmail),
    bookingUrl: cleanUrl(account?.bookingUrl, defaults.bookingUrl),
    calendarSlug: slugify(
      account?.calendarSlug,
      slugify(businessName, defaults.calendarSlug),
    ),
    caddyWorkspaceUrl: cleanUrl(account?.caddyWorkspaceUrl, defaults.caddyWorkspaceUrl),
    // Words the business has not set come from its market profile, so a
    // salon reads "Chair" where a golf business reads "Bay".
    terminology: terminologyFor(account?.terminology, marketProfileFor(market.profileId).terminology),
    market,
    invoiceSettings: cleanInvoiceSettings(
      account?.invoiceSettings,
      cleanPhoneCountry(account?.country, defaults.country),
    ),
  };
}

// UTC, not Auckland. When we genuinely do not know where the coach is, being
// obviously wrong everywhere beats being silently right in one country.
export const FALLBACK_TIME_ZONE = "UTC";

// There used to be a module-level `activeTimeZone` here, set from whichever
// account was read last and reached through accountTimeZone() in a dozen
// places. It was written to stop a call site forgetting an argument, and it did
// -- by answering with a value that belonged to a different business.
//
// That matters more than the country did. Five of those call sites are slot
// maths (isSlotInPast, slotWallTimeToUtcMillis, appointmentMinutesSinceEnd,
// isAppointmentInPast, nowInTimeZoneParts). A stale timezone there does not
// format a date oddly; it decides whether a lesson has already happened, which
// is the difference between a reminder sending and not, and between a slot
// being offered to the public and not.
//
// The timezone is an argument now, and the functions that need one take it with
// no default -- so forgetting is a tsc error rather than a silently wrong hour.
// The deployment default below is a constant, never a previous request's value.
export function defaultTimeZone() {
  return cleanString(env("CLARITY_TIMEZONE", ""), "", 80) || FALLBACK_TIME_ZONE;
}

/**
 * The coach account for one business, from that business's own settings.
 *
 * The defaults differ by business on purpose. The original workspace keeps the
 * env-backed values it has always had, so nothing about it changes. Any other
 * business falls back to neutral product defaults rather than inheriting the
 * original coach's name, venue and invoice footer.
 */
export function coachAccountFromSettings(settings, accountId = "") {
  const scopedAccountId = slugify(settingValue(settings, "accountId") || accountId, "");
  const defaults =
    !scopedAccountId || isOriginalWorkspace(scopedAccountId)
      ? defaultCoachAccount()
      : neutralCoachAccount(scopedAccountId);
  return cleanCoachAccount({
    id: settingValue(settings, "accountId") || defaults.id,
    coachName: settingValue(settings, "accountCoachName") || defaults.coachName,
    businessName:
      settingValue(settings, "accountBusinessName") ||
      settingValue(settings, "coachName") ||
      defaults.businessName,
    venueName: settingValue(settings, "accountVenueName") || defaults.venueName,
    venueShortName:
      settingValue(settings, "accountVenueShortName") || defaults.venueShortName,
    timezone: settingValue(settings, "accountTimezone") || defaults.timezone,
    country: settingValue(settings, "accountCountry") || defaults.country,
    messageLanguage: settingValue(settings, "accountMessageLanguage") || defaults.messageLanguage,
    contactEmail:
      settingValue(settings, "accountContactEmail") || defaults.contactEmail,
    bookingUrl: settingValue(settings, "accountBookingUrl") || defaults.bookingUrl,
    calendarSlug:
      settingValue(settings, "accountCalendarSlug") || defaults.calendarSlug,
    caddyWorkspaceUrl:
      settingValue(settings, "accountCaddyWorkspaceUrl") ||
      defaults.caddyWorkspaceUrl,
    terminology: parseSettingJson(settings, "accountTerminologyJson", {}),
    market: marketConfigFromSettings(settings),
    invoiceSettings: parseSettingJson(settings, "accountInvoiceSettingsJson", defaults.invoiceSettings),
  });
}
