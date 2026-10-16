import { userBelongsToAccountStrict } from "./coach-auth.mts";
import { cleanSlug } from "./values.mts";
import { accountEntitlements, accountPlanCatalog } from "./plan-catalog.mts";

/**
 * Who may do what.
 *
 * Two kinds of rule live here. Plan entitlements: what a business's plan
 * includes and how many coaches, locations and services it allows. And user
 * permissions: whether the signed-in person is an admin, or only has their own
 * calendar and clients. The errors they throw carry a status, so a route can
 * hand them straight back to the browser.
 */

export { accountPlanCatalog, accountEntitlements };

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
