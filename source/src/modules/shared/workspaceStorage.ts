// The one local-storage key that both the entry point and the coach workspace
// read. It lives here rather than in App.tsx because main.tsx must not import
// App -- that would pull the whole workspace into the first download.

/** The workspace accounts (and so the plan) from the last coach visit. */
export const WORKSPACE_ACCOUNTS_STORAGE_KEY = "clarity-booking-workspace-accounts";

/**
 * Whether the last person to use this browser was a coach who did not sign
 * out. The key is written by the workspace and removed on logout, so its
 * presence is a good enough hint to start downloading the coach app while the
 * session check is still in flight, instead of after it.
 */
export function lastVisitorWasCoach(): boolean {
  try {
    return Boolean(window.localStorage.getItem(WORKSPACE_ACCOUNTS_STORAGE_KEY));
  } catch {
    return false;
  }
}
