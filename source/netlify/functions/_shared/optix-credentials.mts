import { integrationCredentials, isOriginalWorkspace } from "./integration-credentials.mts";
import { readOptixReconcileConfig } from "./optix-reconcile.mts";

/**
 * The Optix configuration one business books with: its own token, member and
 * owner ids, from the credentials it saved. The original workspace falls back
 * to the env vars it has always used; nobody else does. Every Optix call made
 * with the returned config goes out on that business's token (config.read).
 */
export async function optixConfigForAccount(accountId: string) {
  return readOptixReconcileConfig(await integrationCredentials(accountId, "optix"), {
    originalWorkspace: isOriginalWorkspace(accountId),
  });
}
