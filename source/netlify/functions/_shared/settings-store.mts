import { getDatabase } from "@netlify/database";
import { safeJsonParse } from "./values.mts";

/**
 * The database handle and the per-business settings table.
 *
 * Every read and write here takes an account id. There is no way to read or
 * write a setting without saying which business it belongs to.
 */

export function db() {
  return getDatabase();
}

/**
 * Does this table exist?
 *
 * Some tables here are created by a migration rather than by ensureSchema(), so
 * a database that has never run one is missing them without being broken. A
 * reader that assumes otherwise turns "this account has no Optix" into a 500.
 */
export async function tableExists(table: string) {
  const rows = (await db().sql`
    SELECT to_regclass(${`public.${table}`}) AS name
  `) as Record<string, unknown>[];
  return Boolean(rows[0]?.name);
}

export async function setSetting(accountId: string, key: string, value: unknown) {
  await setSettingsBulk(accountId, { [key]: value });
}

/**
 * Write a group of settings in one statement — account-scoped.
 *
 * Saving a settings form means writing a dozen or more keys, and doing that one
 * key at a time is a dozen or more sequential round trips to Postgres for a
 * change the coach experiences as pressing Save once. Same shape as the calendar
 * save that was rewriting one item per round trip: individually cheap, and the
 * cost is the count.
 *
 * Callers that write a single key keep using setSetting, which comes through
 * here with one entry. `run` is the statement runner, injectable so the built
 * SQL can be checked without a database behind it.
 *
 * accountId is required. No global writes.
 */
export async function setSettingsBulk(accountId: string, values: Record<string, unknown>, run: null | ((text: string, args: unknown[]) => Promise<unknown>) = null) {
  const entries = Object.entries(values || {}).filter(([key]) => key);
  if (!entries.length) return;
  if (!accountId) {
    throw new Error("setSettingsBulk: accountId is required");
  }

  const params: unknown[] = [];
  const rows = entries.map(([key, value]) => {
    params.push(accountId, key, String(value ?? ""));
    return `($${params.length - 2}, $${params.length - 1}, $${params.length}, NOW())`;
  });
  const query = run || ((text: string, args: unknown[]) => db().pool.query(text, args));
  await query(
    `INSERT INTO settings (account_id, key, value, updated_at)
     VALUES ${rows.join(", ")}
     ON CONFLICT (account_id, key) DO UPDATE
       SET value = EXCLUDED.value,
           updated_at = EXCLUDED.updated_at`,
    params,
  );
}

export async function getSetting(accountId: string, key: string): Promise<string> {
  if (!accountId) return "";
  const rows = await db().sql<{ value: string }[]>`SELECT value FROM settings WHERE account_id = ${accountId} AND key = ${key}`;
  return rows[0]?.value || "";
}

export async function readSettingsMap(accountId: string): Promise<Record<string, string>> {
  if (!accountId) return {};
  // Excludes the bulk-excluded keys (see _shared/settings-keys.mts): this read
  // runs on nearly every request and was shipping a 34 kB Google sync debug log
  // with it. Read those keys individually via getSetting() when needed.
  const rows = await db().sql<{ key: string; value: string }[]>`SELECT key, value FROM settings WHERE account_id = ${accountId} AND key <> 'googleCalendarDebugLogJson'`;
  return Object.fromEntries(rows.map((row) => [row.key, row.value || ""]));
}

export function settingValue(settings, key) {
  return settings?.[key] || "";
}

export function parseSettingJson(settings, key, fallback) {
  return safeJsonParse(settingValue(settings, key), fallback);
}

export function queryRows(result) {
  return Array.isArray(result) ? result : result?.rows || [];
}
