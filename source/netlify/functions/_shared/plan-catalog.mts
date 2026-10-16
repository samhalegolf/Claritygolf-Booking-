// What each plan includes, in one place for both sides.
//
// The browser reads this to decide what to show (workspaceModel.ts); the
// functions read it to decide what to allow (permissions.mts). It used to be
// written twice, and a plan that drifted between the two would have been a
// feature the app offered and the server refused. No Node or browser API here.

export type AccountPlanKey = "solo" | "studio" | "academy" | "enterprise" | "founder";

export type AccountFeatureKey =
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

export type AccountEntitlements = {
  features: Record<AccountFeatureKey, boolean>;
  limits: AccountLimits;
};

export type AccountEntitlementsOverride = {
  features?: Partial<Record<AccountFeatureKey, boolean>>;
  limits?: Partial<AccountLimits>;
};

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

export function accountFeatures(enabled: AccountFeatureKey[]): Record<AccountFeatureKey, boolean> {
  return accountFeatureKeys.reduce(
    (features, feature) => ({ ...features, [feature]: enabled.includes(feature) }),
    {} as Record<AccountFeatureKey, boolean>,
  );
}

const allAccountFeatures = accountFeatures(accountFeatureKeys);

export const accountPlanCatalog: Record<AccountPlanKey, AccountEntitlements> = {
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

export function isAccountPlanKey(value: unknown): value is AccountPlanKey {
  return typeof value === "string" && value in accountPlanCatalog;
}

function mergeEntitlementOverrides(base: AccountEntitlements, override?: AccountEntitlementsOverride | null): AccountEntitlements {
  return {
    features: { ...base.features, ...(override?.features ?? {}) },
    limits: { ...base.limits, ...(override?.limits ?? {}) },
  };
}

/** The plan's entitlements with the account's own overrides applied. An unknown plan reads as solo. */
export function accountEntitlements(
  account?: { planKey?: string | null; entitlementsOverride?: AccountEntitlementsOverride | null } | null,
): AccountEntitlements {
  const plan = isAccountPlanKey(account?.planKey) ? accountPlanCatalog[account.planKey] : accountPlanCatalog.solo;
  return mergeEntitlementOverrides(plan, account?.entitlementsOverride);
}
