import { coachAccountFromSettings } from "./coach-account.mts";
import type { WorkspaceBootstrap } from "./auth-contract.mts";
import type { CoachActor } from "./coach-auth.mts";
import { readSettingsMap, settingValue } from "./settings-store.mts";
import {
  coachProfilesFromSettings,
  coachUserForMembership,
  workspaceAccountsFromSettings,
} from "./workspace-state.mts";

/**
 * Read only what the coach shell needs while authentication is blocking first
 * paint. This deliberately reads the existing settings rows directly: schema
 * creation, seed writes and calendar state belong to migrations and the
 * calendar endpoint, not to the session check.
 *
 * Best effort by design. A valid session remains valid when workspace settings
 * are temporarily unavailable; the calendar shell can fill the bootstrap gap.
 */
export async function readWorkspaceBootstrap(
  membership: CoachActor,
): Promise<WorkspaceBootstrap | undefined> {
  try {
    const settingsMap = await readSettingsMap(membership.accountId);
    const account = coachAccountFromSettings(settingsMap, membership.accountId);
    const coaches = coachProfilesFromSettings(settingsMap, account);
    const coachName = settingValue(settingsMap, "accountCoachName") || account.coachName;
    return {
      accountId: membership.accountId,
      workspaceAccounts: workspaceAccountsFromSettings(settingsMap, account),
      account,
      coaches,
      currentUser: coachUserForMembership(membership, coaches, coachName),
    };
  } catch (error) {
    console.warn("workspace_bootstrap_unavailable", {
      accountId: membership.accountId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
