// Account-scoped access to the `settings` table over Supabase REST.
//
// `settings` used to be keyed on `key` alone, so every function that talked to
// it directly could say `select=key,value` and `on_conflict=key` and be right.
// After the settings-ownership migration the boundary is `(account_id, key)`:
//
//   * an unscoped read returns one row per business per key, and whichever the
//     REST layer happens to return last wins -- so one coach's notification
//     address, business name or branding can surface in another's;
//   * an `on_conflict=key` upsert no longer matches the real unique index, so
//     the write either fails or inserts a duplicate.
//
// These helpers exist so the fix is the same shape in all nine functions that
// reach the table directly, instead of nine slightly different ones.

/** PostgREST filter fragment pinning a settings read to one business. */
export function settingsAccountFilter(accountId: string): string {
  if (!accountId) {
    throw Object.assign(
      new Error("This request could not be scoped to a business and was refused."),
      { status: 500, code: "account_scope_unavailable" },
    );
  }
  return `account_id=eq.${encodeURIComponent(accountId)}`;
}

/**
 * A settings SELECT for one business.
 *
 * `select` defaults to key/value because that is what almost every caller
 * wants; `filters` takes any extra PostgREST fragments (a key filter, a limit).
 */
export function settingsSelectQuery(
  accountId: string,
  { select = "key,value", filters = [] }: { select?: string; filters?: string[] } = {},
): string {
  return [`select=${select}`, settingsAccountFilter(accountId), ...filters].join("&");
}

/** The conflict target for a settings upsert. Matches the composite PK. */
export const SETTINGS_UPSERT_QUERY = "on_conflict=account_id,key";

/** Rows for a settings upsert, each stamped with its owner. */
export function settingsUpsertRows(
  accountId: string,
  values: Record<string, unknown>,
  updatedAt: string,
): Array<{ account_id: string; key: string; value: string; updated_at: string }> {
  settingsAccountFilter(accountId);
  return Object.entries(values || {})
    .filter(([key]) => key)
    .map(([key, value]) => ({
      account_id: accountId,
      key,
      value: String(value ?? ""),
      updated_at: updatedAt,
    }));
}
