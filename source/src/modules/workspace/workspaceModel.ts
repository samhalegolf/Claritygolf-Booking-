import { type BusinessTerminology, terminologyFor } from "../../../netlify/functions/_shared/business-terminology.mts";
import {
  type AccountMarketConfig,
  cleanMarketConfig,
  DEFAULT_ACCOUNT_MARKET_CONFIG,
  marketProfileFor,
} from "../../../netlify/functions/_shared/market-profile.mts";
import { cleanMessageLanguage } from "../../../netlify/functions/_shared/message-language.mts";
import { cleanPhoneCountry } from "../../../netlify/functions/_shared/phone.mts";
import {
  cleanLocationKind,
  cleanLocationResources,
  cleanResourceSource,
  type LocationKind,
  type LocationResource,
  type ResourceSource,
} from "../../../netlify/functions/_shared/resources.mts";
import { t } from "../../lib/i18n";
import { cleanInvoiceSettings, defaultInvoiceSettings } from "../billing/invoiceSettings";
import type { InvoiceSettings } from "../billing/types";
import type { Service } from "../services/serviceModel";
import { WORKSPACE_ACCOUNTS_STORAGE_KEY } from "../shared/workspaceStorage";

/**
 * The business in the coach app: its account and plan, coaches, locations,
 * users, brand and calendar colours, and what the plan lets it use.
 *
 * The browser-side twin of netlify/functions/_shared/workspace.mts and
 * permissions.mts. Both clean the same saved settings.
 */

export type Location = {
  id: string;
  accountId?: string;
  name: string;
  shortName: string;
  address: string;
  mapUrl?: string;
  arrivalInstructions?: string;
  publicNotes?: string;
  timezone: string;
  /** Physical, or online (no address, no resources, no limit). */
  kind?: LocationKind;
  /** Who keeps the resources' availability: Clarity, or another system. */
  resourceSource?: ResourceSource;
  resources?: LocationResource[];
  active: boolean;
  archived?: boolean;
  isDefault?: boolean;
  sortOrder?: number;
};
export type ThemeMode = "light" | "dark";
type PermissionScope = "own" | "assigned" | "all";
type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "paused"
  | "cancelled"
  | "comped"
  | "internal";
type AccountPlanKey = "solo" | "studio" | "academy" | "enterprise" | "founder";
type AccountFeatureKey =
  | "publicBooking"
  | "coachCalendar"
  | "locationCalendar"
  | "multiCoach"
  | "multiLocation"
  | "services"
  | "groupLessons"
  | "packages"
  | "clients"
  | "notifications"
  | "googleCalendarSync"
  | "invoicing"
  | "checkout"
  | "customBranding"
  | "customDomains"
  | "staffUsers"
  | "advancedPermissions";
export type AccountLimits = {
  maxCoaches: number;
  maxLocations: number;
  maxUsers: number;
  maxServices: number;
  maxBookingScreens: number;
};
type AccountEntitlements = {
  features: Record<AccountFeatureKey, boolean>;
  limits: AccountLimits;
};
type AccountEntitlementsOverride = {
  features?: Partial<Record<AccountFeatureKey, boolean>>;
  limits?: Partial<AccountLimits>;
};
export type WorkspaceAccount = {
  id: string;
  name: string;
  slug: string;
  planKey: AccountPlanKey;
  subscriptionStatus: SubscriptionStatus;
  ownerUserId?: string;
  billingProvider?: "stripe" | "manual" | "none";
  billingCustomerId?: string;
  billingSubscriptionId?: string;
  trialEndsAt?: string;
  currentPeriodEndsAt?: string;
  entitlementsOverride?: AccountEntitlementsOverride;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type AppUser = {
  id: string;
  accountId?: string;
  email: string;
  name: string;
  role: "admin" | "account_admin" | "coach" | "staff" | "platform_admin";
  coachId?: string;
  permissions: {
    bookings: PermissionScope;
    services: PermissionScope;
    availability: PermissionScope;
    locations: PermissionScope;
    clients: PermissionScope;
    settings: PermissionScope;
  };
};

/**
 * The two outlines a booking card can wear. The fill is not here: that is the
 * lesson type's own colour, set on the service, because the lesson types are
 * whatever this coach sells rather than a fixed list.
 *
 * Only two states get an outline. Everything else a booking can be is either
 * the normal case or already said better elsewhere, and an outline for each
 * turned the week into a key you had to learn before you could read it.
 */
type CalendarColorSettings = {
  statusCompleted: string;
  statusBayBooked: string;
};

export type BrandSettings = {
  coachName: string;
  logoName: string;
  logoPreview: string;
  showLogo: boolean;
  neutral: string;
  primary: string;
  secondary: string;
  accent: string;
  bookingTheme: ThemeMode;
  calendarColors: CalendarColorSettings;
};

export type CoachAccount = {
  id: string;
  coachName: string;
  businessName: string;
  venueName: string;
  venueShortName: string;
  timezone: string;
  /** ISO 3166-1 alpha-2. The workspace's home country. */
  country: string;
  /** The language the business's emails and texts go out in. */
  messageLanguage: string;
  contactEmail: string;
  bookingUrl: string;
  calendarSlug: string;
  caddyWorkspaceUrl: string;
  terminology: BusinessTerminology;
  /**
   * Which market profile the business started from and which modules it has
   * switched away from that profile's defaults. Read here, written only by
   * /api/market-profile -- see _shared/market-profile.mts.
   */
  market: AccountMarketConfig;
  invoiceSettings: InvoiceSettings;
};

export type CoachProfile = {
  id: string;
  accountId?: string;
  name: string;
  displayName: string;
  shortName?: string;
  email: string;
  phone?: string;
  bio?: string;
  photoUrl?: string;
  active: boolean;
  archived?: boolean;
  bookable: boolean;
  assignedLocationIds?: string[];
  defaultLocationId?: string;
  sortOrder?: number;
};
export const CADDY_APP_URL = "https://caddy.claritygolf.app";
export const THEME_STORAGE_KEY = "clarity-booking-theme";
export const BRAND_STORAGE_KEY = "clarity-booking-brand";
export const COACH_ACCOUNT_STORAGE_KEY = "clarity-booking-coach-account";

/** Matches the --lesson-* / --status-* fallbacks in styles.css. */
export const defaultCalendarColors: CalendarColorSettings = {
  statusCompleted: "#7f8a80",
  statusBayBooked: "#e08a2e",
};

export const calendarColorFields: { key: keyof CalendarColorSettings; label: string; hint: string }[] = [
  { key: "statusCompleted", label: t("Completed"), hint: t("Card border") },
  { key: "statusBayBooked", label: t("Bay booked"), hint: t("Outer ring") },
];

export const defaultBrandSettings: BrandSettings = {
  // Empty, not the original business's name. This is the "from" name on a
  // workspace's emails.
  coachName: "",
  logoName: "",
  logoPreview: "",
  showLogo: false,
  neutral: "#ffffff",
  primary: "#1fd36d",
  secondary: "#d7b06b",
  accent: "#07100a",
  bookingTheme: "dark",
  calendarColors: defaultCalendarColors,
};

// The shape a coach account takes before the server has said anything, and the
// fallback for any field that arrives empty.
//
// It used to hold the original business's real details -- "Sam Hale", "Sam Hale
// Golf", "The Range 24/7 - Three Kings" -- which meant the client quietly wrote
// them back into any account whose settings left a field blank. A second
// business's availability screen was headed "The Range 24/7 - Three Kings" and
// its booking emails were signed by Sam Hale, even though the server had
// correctly sent empty strings for both. The server has neutral defaults now
// (see neutralCoachAccount in booking-core.mts); this is the other half of
// that, and the two must stay in step.
//
// Only genuinely product-level values remain: Clarity's own URLs, and a
// platform timezone/country guess for a workspace that has not chosen one.
// Everything identifying starts empty and is filled in during setup.
export const defaultCoachAccount: CoachAccount = {
  id: "",
  coachName: "",
  businessName: "",
  venueName: "",
  venueShortName: "",
  timezone: "Pacific/Auckland",
  country: "NZ",
  messageLanguage: "en",
  contactEmail: "",
  bookingUrl: "https://book.claritygolf.app",
  calendarSlug: "",
  caddyWorkspaceUrl: CADDY_APP_URL,
  terminology: terminologyFor(),
  market: { ...DEFAULT_ACCOUNT_MARKET_CONFIG },
  invoiceSettings: defaultInvoiceSettings,
};

export function cleanHexColor(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed : fallback;
}

export function cleanSlug(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || fallback;
}

export function cleanUrl(value: unknown, fallback: string) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return fallback;
    return url.toString().replace(/\/$/, "");
  } catch {
    return fallback;
  }
}

// A coach photo: either a link, or a small image uploaded from the coach
// profile screen and kept as a data URL beside the coach (like the logo).
const COACH_PHOTO_DATA_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
function cleanCoachPhoto(value: unknown) {
  if (typeof value === "string" && value.startsWith("data:image/")) {
    return value.length <= 200_000 && COACH_PHOTO_DATA_URL.test(value) ? value : "";
  }
  return cleanUrl(value, "");
}

export function cleanEmail(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const email = value.trim().toLowerCase().slice(0, 180);
  return email.includes("@") ? email : fallback;
}

export function cleanCoachAccount(account?: Partial<CoachAccount>): CoachAccount {
  const businessName =
    typeof account?.businessName === "string" && account.businessName.trim()
      ? account.businessName.trim().slice(0, 100)
      : defaultCoachAccount.businessName;
  const coachName =
    typeof account?.coachName === "string" && account.coachName.trim()
      ? account.coachName.trim().slice(0, 100)
      : defaultCoachAccount.coachName;
  const venueName =
    typeof account?.venueName === "string" && account.venueName.trim()
      ? account.venueName.trim().slice(0, 140)
      : defaultCoachAccount.venueName;
  const venueShortName =
    typeof account?.venueShortName === "string" && account.venueShortName.trim()
      ? account.venueShortName.trim().slice(0, 80)
      : venueName;
  return {
    id: cleanSlug(account?.id, defaultCoachAccount.id),
    coachName,
    businessName,
    venueName,
    venueShortName,
    timezone:
      typeof account?.timezone === "string" && account.timezone.trim()
        ? account.timezone.trim().slice(0, 80)
        : defaultCoachAccount.timezone,
    country: cleanPhoneCountry(account?.country, defaultCoachAccount.country),
    messageLanguage: cleanMessageLanguage(account?.messageLanguage),
    contactEmail: cleanEmail(account?.contactEmail, defaultCoachAccount.contactEmail),
    bookingUrl: cleanUrl(account?.bookingUrl, defaultCoachAccount.bookingUrl),
    calendarSlug: cleanSlug(account?.calendarSlug, cleanSlug(businessName, defaultCoachAccount.calendarSlug)),
    caddyWorkspaceUrl: cleanUrl(account?.caddyWorkspaceUrl, defaultCoachAccount.caddyWorkspaceUrl),
    terminology: terminologyFor(
      account?.terminology,
      marketProfileFor(cleanMarketConfig(account?.market).profileId).terminology,
    ),
    market: cleanMarketConfig(account?.market),
    invoiceSettings: cleanInvoiceSettings(
      account?.invoiceSettings,
      cleanPhoneCountry(account?.country, defaultCoachAccount.country),
    ),
  };
}

export const accountFeatureKeys: AccountFeatureKey[] = [
  "publicBooking",
  "coachCalendar",
  "locationCalendar",
  "multiCoach",
  "multiLocation",
  "services",
  "groupLessons",
  "packages",
  "clients",
  "notifications",
  "googleCalendarSync",
  "invoicing",
  "checkout",
  "customBranding",
  "customDomains",
  "staffUsers",
  "advancedPermissions",
];

// What the Account screen calls each part of a plan. Staff and service words
// follow the business's own terminology, so a physio clinic never reads "Coach".
export function accountFeatureLabel(feature: AccountFeatureKey, terms: BusinessTerminology) {
  const labels: Record<AccountFeatureKey, string> = {
    publicBooking: t("Online booking page"),
    coachCalendar: t("{staffSingular} calendar", { staffSingular: terms.staffSingular }),
    locationCalendar: t("Location calendar"),
    multiCoach: t("Multiple {staffPlural}", { staffPlural: terms.staffPlural.toLowerCase() }),
    multiLocation: t("Multiple locations"),
    services: t("{serviceSingular} types", { serviceSingular: terms.serviceSingular }),
    groupLessons: t("Group {servicePlural}", { servicePlural: terms.servicePlural.toLowerCase() }),
    packages: t("Packages"),
    clients: t("{customerSingular} records", { customerSingular: terms.customerSingular }),
    notifications: t("Email and SMS notifications"),
    googleCalendarSync: t("Google Calendar sync"),
    invoicing: t("Invoicing"),
    checkout: t("Online checkout"),
    customBranding: t("Custom branding"),
    customDomains: t("Custom domains"),
    staffUsers: t("Team logins"),
    advancedPermissions: t("Advanced permissions"),
  };
  return labels[feature];
}

export const SUBSCRIPTION_STATUS_LABEL: Record<SubscriptionStatus, string> = {
  trialing: t("Trial"),
  active: t("Active"),
  past_due: t("Payment overdue"),
  paused: t("Paused"),
  cancelled: t("Cancelled"),
  comped: t("Complimentary"),
  internal: t("Internal"),
};

// Plans at or above this are sold as unlimited; the catalogue stores 999
// because a limit has to be a number.
export const UNLIMITED_ACCOUNT_LIMIT = 999;

function accountFeatures(enabled: AccountFeatureKey[]): Record<AccountFeatureKey, boolean> {
  return accountFeatureKeys.reduce(
    (features, feature) => ({ ...features, [feature]: enabled.includes(feature) }),
    {} as Record<AccountFeatureKey, boolean>,
  );
}

const allAccountFeatures = accountFeatures(accountFeatureKeys);

const accountPlanCatalog: Record<AccountPlanKey, AccountEntitlements> = {
  solo: {
    features: accountFeatures([
      "publicBooking",
      "coachCalendar",
      "services",
      "groupLessons",
      "packages",
      "clients",
      "notifications",
      "googleCalendarSync",
    ]),
    limits: { maxCoaches: 1, maxLocations: 1, maxUsers: 1, maxServices: 10, maxBookingScreens: 1 },
  },
  studio: {
    features: accountFeatures([
      "publicBooking",
      "coachCalendar",
      "locationCalendar",
      "multiCoach",
      "multiLocation",
      "services",
      "groupLessons",
      "packages",
      "clients",
      "notifications",
      "googleCalendarSync",
      "invoicing",
      "customBranding",
      "staffUsers",
    ]),
    limits: { maxCoaches: 5, maxLocations: 3, maxUsers: 8, maxServices: 40, maxBookingScreens: 4 },
  },
  academy: {
    features: allAccountFeatures,
    limits: { maxCoaches: 20, maxLocations: 10, maxUsers: 30, maxServices: 120, maxBookingScreens: 12 },
  },
  enterprise: {
    features: allAccountFeatures,
    limits: { maxCoaches: 999, maxLocations: 999, maxUsers: 999, maxServices: 999, maxBookingScreens: 999 },
  },
  founder: {
    features: allAccountFeatures,
    limits: { maxCoaches: 999, maxLocations: 999, maxUsers: 999, maxServices: 999, maxBookingScreens: 999 },
  },
};

function mergeEntitlementOverrides(
  base: AccountEntitlements,
  override?: AccountEntitlementsOverride,
): AccountEntitlements {
  return {
    features: { ...base.features, ...(override?.features ?? {}) },
    limits: { ...base.limits, ...(override?.limits ?? {}) },
  };
}

export function accountEntitlements(account: WorkspaceAccount): AccountEntitlements {
  return mergeEntitlementOverrides(accountPlanCatalog[account.planKey] ?? accountPlanCatalog.solo, account.entitlementsOverride);
}

function accountHasFeature(account: WorkspaceAccount, feature: AccountFeatureKey) {
  return accountEntitlements(account).features[feature] === true;
}

export function accountLimit(account: WorkspaceAccount, limit: keyof AccountLimits) {
  return accountEntitlements(account).limits[limit];
}

export function isAccountActive(account: WorkspaceAccount) {
  return account.active && ["trialing", "active", "comped", "internal"].includes(account.subscriptionStatus);
}

export function defaultWorkspaceAccountFromCoachAccount(account: Partial<CoachAccount> = defaultCoachAccount): WorkspaceAccount {
  const cleanAccount = cleanCoachAccount(account);
  // No fallback to the original workspace: a shell built for a business that
  // has not named itself yet stays unnamed rather than borrowing.
  const slug = cleanSlug(cleanAccount.calendarSlug || cleanAccount.businessName, "");
  return {
    id: slug,
    name: cleanAccount.businessName,
    slug,
    planKey: "solo",
    subscriptionStatus: "trialing",
    billingProvider: "none",
    active: true,
  };
}

function cleanWorkspaceAccount(
  raw?: Partial<WorkspaceAccount>,
  fallback: WorkspaceAccount = defaultWorkspaceAccountFromCoachAccount(),
): WorkspaceAccount {
  const name =
    typeof raw?.name === "string" && raw.name.trim()
      ? raw.name.trim().slice(0, 120)
      : fallback.name;
  const slug = cleanSlug(raw?.slug || raw?.id || name, fallback.slug);
  const planKey: AccountPlanKey =
    raw?.planKey && raw.planKey in accountPlanCatalog ? raw.planKey : fallback.planKey;
  const subscriptionStatus: SubscriptionStatus =
    raw?.subscriptionStatus && ["trialing", "active", "past_due", "paused", "cancelled", "comped", "internal"].includes(raw.subscriptionStatus)
      ? raw.subscriptionStatus
      : fallback.subscriptionStatus;
  return {
    id: cleanSlug(raw?.id, slug),
    name,
    slug,
    planKey,
    subscriptionStatus,
    ownerUserId: typeof raw?.ownerUserId === "string" && raw.ownerUserId.trim() ? raw.ownerUserId.trim().slice(0, 120) : fallback.ownerUserId,
    billingProvider: raw?.billingProvider === "stripe" || raw?.billingProvider === "manual" || raw?.billingProvider === "none" ? raw.billingProvider : fallback.billingProvider,
    billingCustomerId: typeof raw?.billingCustomerId === "string" && raw.billingCustomerId.trim() ? raw.billingCustomerId.trim().slice(0, 160) : undefined,
    billingSubscriptionId: typeof raw?.billingSubscriptionId === "string" && raw.billingSubscriptionId.trim() ? raw.billingSubscriptionId.trim().slice(0, 160) : undefined,
    trialEndsAt: typeof raw?.trialEndsAt === "string" && raw.trialEndsAt.trim() ? raw.trialEndsAt.trim() : undefined,
    currentPeriodEndsAt: typeof raw?.currentPeriodEndsAt === "string" && raw.currentPeriodEndsAt.trim() ? raw.currentPeriodEndsAt.trim() : undefined,
    entitlementsOverride:
      raw?.entitlementsOverride && typeof raw.entitlementsOverride === "object"
        ? {
            features: raw.entitlementsOverride.features,
            limits: raw.entitlementsOverride.limits,
          }
        : undefined,
    active: raw?.active !== false,
    createdAt: typeof raw?.createdAt === "string" ? raw.createdAt : fallback.createdAt,
    updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : fallback.updatedAt,
  };
}

export function cleanWorkspaceAccounts(rawAccounts?: Partial<WorkspaceAccount>[], account?: Partial<CoachAccount>): WorkspaceAccount[] {
  const fallback = defaultWorkspaceAccountFromCoachAccount(account ?? defaultCoachAccount);
  const source = Array.isArray(rawAccounts) && rawAccounts.length ? rawAccounts : [fallback];
  const seen = new Set<string>();
  return source.map((raw, index) => {
    const clean = cleanWorkspaceAccount(raw, index === 0 ? fallback : defaultWorkspaceAccountFromCoachAccount(account ?? defaultCoachAccount));
    let id = clean.id;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${clean.id}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    return { ...clean, id, active: clean.active || index === 0 };
  });
}

function activeWorkspaceAccounts(accounts: WorkspaceAccount[]) {
  return accounts.filter((account) => account.active);
}

export function defaultAccountId(accounts: WorkspaceAccount[]) {
  return activeWorkspaceAccounts(accounts)[0]?.id || accounts[0]?.id || defaultWorkspaceAccountFromCoachAccount().id;
}

export function accountById(accounts: WorkspaceAccount[], id?: string) {
  if (!id) return undefined;
  return accounts.find((account) => account.id === id);
}

function resolvedRecordAccountId(record: { accountId?: string } | undefined, fallbackAccountId = defaultWorkspaceAccountFromCoachAccount().id) {
  return record?.accountId || fallbackAccountId;
}

export function recordBelongsToAccount(record: { accountId?: string } | undefined, accountId: string) {
  return resolvedRecordAccountId(record, accountId) === accountId;
}

export function filterRecordsForAccount<T extends { accountId?: string }>(records: T[], accountId: string) {
  return records.filter((record) => recordBelongsToAccount(record, accountId));
}

export function serviceBelongsToAccount(service: Partial<Service> | undefined, accountId: string) {
  return recordBelongsToAccount(service, accountId);
}

export function userBelongsToAccount(user: Partial<AppUser> | undefined, accountId: string) {
  return recordBelongsToAccount(user, accountId);
}

export function canUseFeature(account: WorkspaceAccount, feature: AccountFeatureKey) {
  return isAccountActive(account) && accountHasFeature(account, feature);
}

export function canCreateWithinLimit(account: WorkspaceAccount, currentUsage: number, limitName: keyof AccountLimits) {
  return currentUsage < accountLimit(account, limitName);
}

export function featureUnavailableMessage(feature: AccountFeatureKey) {
  return t("{feature} is not included in this workspace plan.", { feature });
}

export function limitReachedMessage(limitName: keyof AccountLimits, limit: number) {
  return t("This workspace plan allows {limit} {limitName}.", { limit, limitName: limitName.replace(/^max/, "").toLowerCase() });

}

export function defaultLocationFromCoachAccount(account: Partial<CoachAccount> = defaultCoachAccount): Location {
  const cleanAccount = cleanCoachAccount(account);
  const workspaceAccount = defaultWorkspaceAccountFromCoachAccount(cleanAccount);
  return {
    id: "default-location",
    accountId: workspaceAccount.id,
    name: cleanAccount.venueName,
    shortName: cleanAccount.venueShortName || cleanAccount.venueName,
    address: "",
    timezone: cleanAccount.timezone,
    active: true,
    archived: false,
    isDefault: true,
    sortOrder: 0,
  };
}

export function defaultCoachProfileFromAccount(account: Partial<CoachAccount> = defaultCoachAccount): CoachProfile {
  const cleanAccount = cleanCoachAccount(account);
  const workspaceAccount = defaultWorkspaceAccountFromCoachAccount(cleanAccount);
  return {
    id: cleanAccount.id,
    accountId: workspaceAccount.id,
    name: cleanAccount.coachName,
    displayName: cleanAccount.coachName || cleanAccount.businessName,
    shortName: cleanAccount.coachName.split(/\s+/)[0] || "",
    email: cleanAccount.contactEmail,
    active: true,
    archived: false,
    bookable: true,
    assignedLocationIds: ["default-location"],
    defaultLocationId: "default-location",
    sortOrder: 0,
  };
}

export function defaultAppUserFromCoachAccount(account: Partial<CoachAccount> = defaultCoachAccount): AppUser {
  const coach = defaultCoachProfileFromAccount(account);
  const workspaceAccount = defaultWorkspaceAccountFromCoachAccount(account);
  return {
    id: `${coach.id}-admin`,
    accountId: workspaceAccount.id,
    email: coach.email,
    name: coach.displayName,
    role: "admin",
    coachId: coach.id,
    permissions: {
      bookings: "all",
      services: "all",
      availability: "all",
      locations: "all",
      clients: "all",
      settings: "all",
    },
  };
}

export function cleanAppUser(raw?: Partial<AppUser>, fallback = defaultAppUserFromCoachAccount(), accountId = fallback.accountId): AppUser {
  const role =
    raw?.role === "account_admin" || raw?.role === "coach" || raw?.role === "staff" || raw?.role === "platform_admin"
      ? raw.role
      : raw?.role === "admin"
        ? "admin"
        : fallback.role;
  const permissions = typeof raw?.permissions === "object" && raw.permissions ? raw.permissions : fallback.permissions;
  return {
    id: cleanSlug(raw?.id, fallback.id),
    accountId: cleanSlug(raw?.accountId, accountId || defaultWorkspaceAccountFromCoachAccount().id),
    email: cleanEmail(raw?.email, fallback.email),
    name: typeof raw?.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 120) : fallback.name,
    role,
    coachId: cleanSlug(raw?.coachId, fallback.coachId || "") || undefined,
    permissions: {
      bookings: permissions.bookings === "own" || permissions.bookings === "assigned" ? permissions.bookings : "all",
      services: permissions.services === "own" || permissions.services === "assigned" ? permissions.services : "all",
      availability: permissions.availability === "own" || permissions.availability === "assigned" ? permissions.availability : "all",
      locations: permissions.locations === "own" || permissions.locations === "assigned" ? permissions.locations : "all",
      clients: permissions.clients === "own" || permissions.clients === "assigned" ? permissions.clients : "all",
      settings: permissions.settings === "own" || permissions.settings === "assigned" ? permissions.settings : "all",
    },
  };
}

export function blankCoachProfile(accountId = ""): CoachProfile {
  return {
    id: "",
    accountId,
    name: "",
    displayName: "",
    shortName: "",
    email: "",
    active: true,
    archived: false,
    bookable: true,
    assignedLocationIds: ["default-location"],
    defaultLocationId: "default-location",
    sortOrder: 0,
  };
}

export function cleanCoachProfile(raw?: Partial<CoachProfile>, fallback?: CoachProfile, index = 0): CoachProfile {
  const base = fallback ?? blankCoachProfile(defaultWorkspaceAccountFromCoachAccount().id);
  const name =
    typeof raw?.name === "string" && raw.name.trim()
      ? raw.name.trim().slice(0, 120)
      : base.name;
  return {
    id: cleanSlug(raw?.id, cleanSlug(name, `coach-${index + 1}`)),
    accountId: cleanSlug(raw?.accountId, base.accountId || defaultWorkspaceAccountFromCoachAccount().id),
    name,
    displayName:
      typeof raw?.displayName === "string" && raw.displayName.trim()
        ? raw.displayName.trim().slice(0, 120)
        : name,
    shortName:
      typeof raw?.shortName === "string" && raw.shortName.trim()
        ? raw.shortName.trim().slice(0, 60)
        : name.split(/\s+/).map((part) => part[0]).join("").slice(0, 4).toUpperCase(),
    email: cleanEmail(raw?.email, base.email),
    phone: typeof raw?.phone === "string" && raw.phone.trim() ? raw.phone.trim().slice(0, 80) : undefined,
    bio: typeof raw?.bio === "string" && raw.bio.trim() ? raw.bio.trim().slice(0, 600) : undefined,
    photoUrl: cleanCoachPhoto(raw?.photoUrl) || undefined,
    active: raw?.active !== false,
    archived: raw?.archived === true,
    bookable: raw?.bookable !== false,
    assignedLocationIds: Array.isArray(raw?.assignedLocationIds)
      ? raw.assignedLocationIds.map((id) => cleanSlug(id, "")).filter(Boolean)
      : base.assignedLocationIds,
    defaultLocationId: cleanSlug(raw?.defaultLocationId, raw?.assignedLocationIds?.[0] || base.assignedLocationIds?.[0] || "") || undefined,
    sortOrder: Number.isFinite(Number(raw?.sortOrder)) ? Math.round(Number(raw?.sortOrder)) : index,
  };
}

/**
 * Mirrors normalizeCoachProfiles in booking-core: only a list that was never
 * saved is seeded with the owner's coach. An empty list is a business whose
 * owner doesn't coach, and stays empty.
 */
export function cleanCoachProfiles(rawProfiles?: Partial<CoachProfile>[], account?: Partial<CoachAccount>): CoachProfile[] {
  const seeded = !Array.isArray(rawProfiles);
  const seed = defaultCoachProfileFromAccount(account ?? defaultCoachAccount);
  const source = seeded ? [seed] : rawProfiles;
  const seen = new Set<string>();
  const cleaned = source.map((raw, index) => {
    const profile = cleanCoachProfile(raw, seeded ? seed : blankCoachProfile(seed.accountId), index);
    let id = profile.id;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${profile.id}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    return { ...profile, id };
  });
  return cleaned.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.displayName.localeCompare(b.displayName));
}

/**
 * The coach a record that names none belongs to: the first active coach in
 * the business's list. There is no "default coach" setting -- lesson types,
 * bookings and availability all name their coach -- so this only decides
 * where rows saved before that are shown. Mirrors firstCoachId in booking-core.
 */
export function firstCoachId(coaches: CoachProfile[]) {
  return coaches.find((coach) => coach.active && !coach.archived)?.id || coaches[0]?.id || "";
}

export function coachById(coaches: CoachProfile[], id?: string) {
  if (!id) return undefined;
  return coaches.find((coach) => coach.id === id);
}

export function cleanLocation(raw?: Partial<Location>, fallback?: Location, index = 0): Location {
  const base = fallback ?? defaultLocationFromCoachAccount();
  const name =
    typeof raw?.name === "string" && raw.name.trim()
      ? raw.name.trim().slice(0, 140)
      : base.name;
  const shortName =
    typeof raw?.shortName === "string" && raw.shortName.trim()
      ? raw.shortName.trim().slice(0, 80)
      : name;
  const id = cleanSlug(raw?.id, cleanSlug(name, `location-${index + 1}`));
  return {
    id,
    accountId: cleanSlug(raw?.accountId, base.accountId || defaultWorkspaceAccountFromCoachAccount().id),
    name,
    shortName,
    address: typeof raw?.address === "string" ? raw.address.trim().slice(0, 240) : base.address,
    mapUrl: cleanUrl(raw?.mapUrl, "") || undefined,
    arrivalInstructions:
      typeof raw?.arrivalInstructions === "string" && raw.arrivalInstructions.trim()
        ? raw.arrivalInstructions.trim().slice(0, 500)
        : undefined,
    publicNotes:
      typeof raw?.publicNotes === "string" && raw.publicNotes.trim()
        ? raw.publicNotes.trim().slice(0, 500)
        : undefined,
    timezone:
      typeof raw?.timezone === "string" && raw.timezone.trim()
        ? raw.timezone.trim().slice(0, 80)
        : base.timezone,
    // Kept through every clean: the server's normaliser mirrors these, and a
    // location that loses them here saves back with no resources.
    kind: cleanLocationKind(raw?.kind),
    resourceSource: cleanResourceSource(raw?.resourceSource),
    resources: cleanLocationResources(raw?.resources),
    active: raw?.active !== false,
    archived: raw?.archived === true,
    isDefault: raw?.isDefault === true || base.isDefault === true,
    sortOrder: Number.isFinite(Number(raw?.sortOrder)) ? Math.round(Number(raw?.sortOrder)) : index,
  };
}

export function cleanLocations(rawLocations?: Partial<Location>[], account?: Partial<CoachAccount>): Location[] {
  const fallback = defaultLocationFromCoachAccount(account ?? defaultCoachAccount);
  const source = Array.isArray(rawLocations) && rawLocations.length ? rawLocations : [fallback];
  const seen = new Set<string>();
  const cleaned = source.map((raw, index) => {
    const location = cleanLocation(raw, index === 0 ? fallback : undefined, index);
    let id = location.id;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${location.id}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    return { ...location, id };
  });
  const active = cleaned.filter((location) => location.active && !location.archived);
  if (!active.length) {
    cleaned[0] = { ...cleaned[0], active: true, archived: false };
  }
  const defaultIndex = cleaned.findIndex((location) => location.isDefault && location.active && !location.archived);
  const nextDefaultIndex = defaultIndex >= 0 ? defaultIndex : cleaned.findIndex((location) => location.active && !location.archived);
  return cleaned
    .map((location, index) => ({ ...location, isDefault: index === nextDefaultIndex }))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
}

export function activeLocations(locations: Location[]) {
  return locations.filter((location) => location.active && !location.archived);
}

export function defaultLocationId(locations: Location[]) {
  return (
    activeLocations(locations).find((location) => location.isDefault)?.id ??
    activeLocations(locations)[0]?.id ??
    locations[0]?.id ??
    ""
  );
}

export function locationById(locations: Location[], id?: string) {
  if (!id) return undefined;
  return locations.find((location) => location.id === id);
}

export function getStoredCoachAccount(): CoachAccount {
  if (typeof window === "undefined") return defaultCoachAccount;
  try {
    const stored = window.localStorage.getItem(COACH_ACCOUNT_STORAGE_KEY);
    return stored ? cleanCoachAccount(JSON.parse(stored) as Partial<CoachAccount>) : defaultCoachAccount;
  } catch {
    return defaultCoachAccount;
  }
}

/**
 * The workspace accounts from the last visit, so the sidebar can be right on
 * first paint. The plan lives here and the plan is what decides whether Sell
 * and Billing are in the nav at all; without it every load started on a
 * made-up solo account and those two items arrived with the calendar shell.
 * The shell still overwrites this the moment it answers.
 */
export function getStoredWorkspaceAccounts(): Partial<WorkspaceAccount>[] | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const stored = window.localStorage.getItem(WORKSPACE_ACCOUNTS_STORAGE_KEY);
    const parsed = stored ? (JSON.parse(stored) as unknown) : undefined;
    return Array.isArray(parsed) ? (parsed as Partial<WorkspaceAccount>[]) : undefined;
  } catch {
    return undefined;
  }
}

export function cleanBrandSettings(settings?: Partial<BrandSettings>): BrandSettings {
  return {
    coachName: typeof settings?.coachName === "string" && settings.coachName.trim()
      ? settings.coachName.trim().slice(0, 80)
      : defaultBrandSettings.coachName,
    logoName: typeof settings?.logoName === "string" ? settings.logoName.trim().slice(0, 120) : "",
    logoPreview:
      typeof settings?.logoPreview === "string" && settings.logoPreview.startsWith("data:image/")
        ? settings.logoPreview
        : "",
    showLogo: settings?.showLogo === true,
    neutral: cleanHexColor(settings?.neutral, defaultBrandSettings.neutral),
    primary: cleanHexColor(settings?.primary, defaultBrandSettings.primary),
    secondary: cleanHexColor(settings?.secondary, defaultBrandSettings.secondary),
    accent: cleanHexColor(settings?.accent, defaultBrandSettings.accent),
    bookingTheme: settings?.bookingTheme === "light" ? "light" : "dark",
    calendarColors: cleanCalendarColors(settings?.calendarColors),
  };
}

/** { lessonPrivate: "#2b2233" } -> { "--lesson-private-set": "#2b2233" } */
export function calendarColorVariables(colors: CalendarColorSettings): Record<string, string> {
  const variables: Record<string, string> = {};
  calendarColorFields.forEach(({ key }) => {
    const name = key.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    variables[`--${name}-set`] = colors[key];
  });
  return variables;
}

function cleanCalendarColors(colors?: Partial<CalendarColorSettings>): CalendarColorSettings {
  const cleaned = {} as CalendarColorSettings;
  calendarColorFields.forEach(({ key }) => {
    cleaned[key] = cleanHexColor(colors?.[key], defaultCalendarColors[key]);
  });
  return cleaned;
}

export function getStoredTheme(): ThemeMode {
  if (typeof window === "undefined") return "light";
  return window.localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
}

export function getStoredBrandSettings(): BrandSettings {
  if (typeof window === "undefined") return defaultBrandSettings;
  try {
    const stored = window.localStorage.getItem(BRAND_STORAGE_KEY);
    return stored ? cleanBrandSettings(JSON.parse(stored) as Partial<BrandSettings>) : defaultBrandSettings;
  } catch {
    return defaultBrandSettings;
  }
}
