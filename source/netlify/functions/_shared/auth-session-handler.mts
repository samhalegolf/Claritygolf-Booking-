import { authSessionResponse } from "./auth-contract.mts";
import {
  ensureSessionAuthUserId,
  readAdminSessionAuthUserId,
  resolveMembershipForAuthUser,
  sessionRoleForMembership,
} from "./coach-auth.mts";
import { json } from "./http.mts";
import { createServerTiming } from "./server-timing.mts";
import { readWorkspaceBootstrap } from "./workspace-bootstrap.mts";

/**
 * The same-origin coach-only session check. auth-session.mts calls this only
 * when an admin cookie exists and neither a player cookie nor native bearer
 * token is present; mixed coach/player handoffs still go through booking-core.
 *
 * Keeping this path in shared modules means a normal page load no longer
 * imports the 500 KB booking router or runs its schema/bootstrap setup.
 */
export async function handleCoachAuthSession(req: Request) {
  const timing = createServerTiming();
  const respond = (body: Parameters<typeof authSessionResponse>[0]) =>
    json(authSessionResponse(body), 200, { "Server-Timing": timing.header() });

  const session = await timing.measure("session", () => readAdminSessionAuthUserId(req));
  if (!session) return respond({ authenticated: false, role: "guest" });

  const authUserId = await timing.measure("identity", () => ensureSessionAuthUserId(session));
  const membership = authUserId
    ? await timing.measure("membership", () =>
        resolveMembershipForAuthUser(authUserId, session.activeAccountId),
      )
    : null;

  if (!membership) {
    return respond({
      authenticated: false,
      role: "guest",
      error: "membership_required",
      message: "This login is not attached to a business workspace yet.",
    });
  }

  const workspace = await timing.measure("workspace", () => readWorkspaceBootstrap(membership));
  return respond({
    authenticated: true,
    role: sessionRoleForMembership(membership.role),
    accountRole: membership.role,
    email: session.email,
    accountId: membership.accountId,
    accountKind: membership.sandboxOfAccountId ? "sandbox" : "live",
    ...(membership.sandboxOfAccountId
      ? { liveAccountId: membership.sandboxOfAccountId }
      : {}),
    workspace,
  });
}
