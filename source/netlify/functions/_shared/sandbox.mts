// What a sandbox is, in one place.
//
// A sandbox is not a mode. It is a row in `accounts` with kind = 'sandbox' and
// sandbox_of_account_id pointing at the live business it shadows. Everything
// else follows from that: the tenant boundary already filters every read and
// write on account_id, so a sandbox has its own settings, calendar, people,
// passes and invoices without a single query being changed.
//
// Two rules hold the whole design up.
//
// 1. Sandbox capability is proved from the accounts table, never from a flag on
//    a session or a header on a request. Anything a sandbox can do that a live
//    account cannot -- impersonating a player above all -- asks this module, and
//    this module asks Postgres. There is no sandbox flag to forge because there
//    is no sandbox flag.
//
// 2. Access is derived, not granted. A coach may enter the sandbox because they
//    hold an active membership on the business it belongs to, and for no other
//    reason. There is deliberately no account_memberships row for a sandbox: a
//    mirrored row would outlive the membership it mirrored, so removing a coach
//    from a business would leave their sandbox access behind. Deriving it means
//    the two can never disagree.

import { getDatabase } from "./database.mts";

function db() {
  return getDatabase();
}

function cleanSlug(value: unknown, fallback = ""): string {
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

export const SANDBOX_KIND = "sandbox";
export const LIVE_KIND = "live";

export type SandboxAccount = {
  id: string;
  slug: string;
  businessName: string;
  status: string;
  /** The live business this sandbox belongs to. */
  sandboxOfAccountId: string;
};

/**
 * The sandbox id for a business.
 *
 * Derived rather than random so it is recognisable in a log, a query and a URL,
 * and so a re-create cannot quietly produce a second one. The unique index on
 * sandbox_of_account_id is what actually enforces one-per-business; this just
 * makes the id readable.
 */
export function sandboxAccountIdFor(liveAccountId: string): string {
  const clean = cleanSlug(liveAccountId, "");
  return clean ? `${clean}-sandbox`.slice(0, 80) : "";
}

function rowToSandbox(row: {
  id: string;
  slug: string;
  business_name: string;
  status: string;
  sandbox_of_account_id: string;
}): SandboxAccount {
  return {
    id: cleanSlug(row.id, ""),
    slug: cleanSlug(row.slug, ""),
    businessName: String(row.business_name || "").slice(0, 200),
    status: String(row.status || "").slice(0, 40),
    sandboxOfAccountId: cleanSlug(row.sandbox_of_account_id, ""),
  };
}

/** The sandbox belonging to a live business, or null if it has none yet. */
export async function readSandboxForAccount(
  liveAccountId: string,
): Promise<SandboxAccount | null> {
  const parent = cleanSlug(liveAccountId, "");
  if (!parent) return null;
  const rows = await db().sql<
    {
      id: string;
      slug: string;
      business_name: string;
      status: string;
      sandbox_of_account_id: string;
    }[]
  >`
    SELECT id, slug, business_name, status, sandbox_of_account_id
    FROM accounts
    WHERE sandbox_of_account_id = ${parent}
      AND kind = ${SANDBOX_KIND}
    LIMIT 1
  `;
  return rows[0] ? rowToSandbox(rows[0]) : null;
}

/** An account id, read back as a sandbox. Null when it is live or unknown. */
export async function readSandboxAccount(accountId: string): Promise<SandboxAccount | null> {
  const clean = cleanSlug(accountId, "");
  if (!clean) return null;
  const rows = await db().sql<
    {
      id: string;
      slug: string;
      business_name: string;
      status: string;
      sandbox_of_account_id: string;
    }[]
  >`
    SELECT id, slug, business_name, status, sandbox_of_account_id
    FROM accounts
    WHERE id = ${clean}
      AND kind = ${SANDBOX_KIND}
      AND sandbox_of_account_id IS NOT NULL
    LIMIT 1
  `;
  return rows[0] ? rowToSandbox(rows[0]) : null;
}

/**
 * The gate every sandbox-only capability opens with.
 *
 * Throws 403 unless the account id names a real sandbox row. A live account has
 * no such row, so there is no code path in which a production account reaches a
 * sandbox-only behaviour -- not a check that could be skipped, an absence that
 * cannot be satisfied.
 */
export async function requireSandboxAccount(accountId: string): Promise<SandboxAccount> {
  const sandbox = await readSandboxAccount(accountId);
  if (!sandbox) {
    throw Object.assign(new Error("This is only available inside a sandbox workspace."), {
      status: 403,
      code: "sandbox_required",
    });
  }
  return sandbox;
}
