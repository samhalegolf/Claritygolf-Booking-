import { userBelongsToAccountStrict } from "./coach-auth.mts";
import { cleanSlug } from "./values.mts";

/**
 * Who may do what.
 *
 * Two kinds of rule live here. Plan entitlements: what a business's plan
 * includes and how many coaches, locations and services it allows. And user
 * permissions: whether the signed-in person is an admin, or only has their own
 * calendar and clients. The errors they throw carry a status, so a route can
 * hand them straight back to the browser.
 */

const accountFeatureKeys = [
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

function accountFeatures(enabled) {
  return Object.fromEntries(accountFeatureKeys.map((feature) => [feature, enabled.includes(feature)]));
}

const allAccountFeatures = accountFeatures(accountFeatureKeys);
export const accountPlanCatalog = {
  solo: {
    features: accountFeatures(["publicBooking", "coachCalendar", "services", "groupLessons", "packages", "clients", "notifications", "googleCalendarSync"]),
    limits: { maxCoaches: 1, maxLocations: 1, maxUsers: 1, maxServices: 10, maxBookingScreens: 1 },
  },
  studio: {
    features: accountFeatures(["publicBooking", "coachCalendar", "locationCalendar", "multiCoach", "multiLocation", "services", "groupLessons", "packages", "clients", "notifications", "googleCalendarSync", "invoicing", "customBranding", "staffUsers"]),
    limits: { maxCoaches: 5, maxLocations: 3, maxUsers: 8, maxServices: 40, maxBookingScreens: 4 },
  },
  academy: { features: allAccountFeatures, limits: { maxCoaches: 20, maxLocations: 10, maxUsers: 30, maxServices: 120, maxBookingScreens: 12 } },
  enterprise: { features: allAccountFeatures, limits: { maxCoaches: 999, maxLocations: 999, maxUsers: 999, maxServices: 999, maxBookingScreens: 999 } },
  founder: { features: allAccountFeatures, limits: { maxCoaches: 999, maxLocations: 999, maxUsers: 999, maxServices: 999, maxBookingScreens: 999 } },
};

function mergeEntitlementOverrides(base, override) {
  return {
    features: { ...base.features, ...(override?.features || {}) },
    limits: { ...base.limits, ...(override?.limits || {}) },
  };
}

export function accountEntitlements(account) {
  return mergeEntitlementOverrides(accountPlanCatalog[account?.planKey] || accountPlanCatalog.solo, account?.entitlementsOverride);
}

function accountHasFeature(account, feature) {
  return accountEntitlements(account).features[feature] === true;
}

function accountLimit(account, limit) {
  return accountEntitlements(account).limits[limit];
}

function isAccountActive(account) {
  return account?.active !== false && ["trialing", "active", "comped", "internal"].includes(account?.subscriptionStatus);
}

function entitlementError(message, status = 403) {
  return Object.assign(new Error(message), { status });
}

function assertAccountActive(account) {
  if (!isAccountActive(account)) {
    throw entitlementError("This workspace subscription is not active.");
  }
}

export function assertAccountFeature(account, feature) {
  assertAccountActive(account);
  if (!accountHasFeature(account, feature)) {
    throw entitlementError(`${feature} is not included in this workspace plan.`);
  }
}

export function assertAccountLimit(account, currentUsage, limitName) {
  const limit = accountLimit(account, limitName);
  if (Number.isFinite(limit) && currentUsage > limit) {
    throw entitlementError(`This workspace plan allows ${limit} ${String(limitName).replace(/^max/, "").toLowerCase()}.`, 409);
  }
}

export function forbidden(message = "Permission denied.", code = "permission_denied") {
  const error = Object.assign(new Error(message), { status: 403, code });
  return error;
}

export function permissionDenied(message = "You do not have permission to perform this action.") {
  return forbidden(message, "permission_denied");
}

/**
 * Raised when a query would have to run without an account filter.
 *
 * Several reads used to retry unscoped when Supabase reported account_id
 * missing, which turned a schema problem into a silent cross-tenant read. The
 * column is NOT NULL now; if the scope cannot be applied, that is a server
 * fault and the request fails.
 */
export function missingAccountScope(where = "query") {
  return Object.assign(
    new Error("This request could not be scoped to a business and was refused."),
    { status: 500, code: "account_scope_unavailable", scope: where },
  );
}

function isAdminUser(user) {
  return ["admin", "account_admin", "platform_admin"].includes(user?.role) || Object.values(user?.permissions || {}).includes("all");
}

export function userCoachId(user) {
  return cleanSlug(user?.coachId, "") || undefined;
}

export function hasPermission(user, permissionKey, scope = "own") {
  if (isAdminUser(user)) return true;
  const grant = user?.permissions?.[permissionKey];
  if (!grant) return false;
  if (grant === "all") return true;
  if (scope === "assigned") return grant === "assigned";
  if (scope === "own") return grant === "own" || grant === "assigned";
  return false;
}

function assertUserBelongsToAccount(user, accountId) {
  if (!userBelongsToAccountStrict(user, accountId)) {
    throw permissionDenied("This user does not belong to the requested workspace.");
  }
}

export function assertAuthenticatedContext(context) {
  if (!context?.user) throw Object.assign(new Error("Admin login required."), { status: 401, code: "unauthorized" });
  assertAccountActive(context.account);
  assertUserBelongsToAccount(context.user, context.accountId);
}

export function assertAccountAdminContext(context, message = "You do not have permission to change account settings.") {
  assertAuthenticatedContext(context);
  if (!context.isAdmin) throw permissionDenied(message);
}
