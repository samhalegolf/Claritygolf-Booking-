// Shared coach/business-owner authentication and account resolution.
//
// Hard boundary:
//   Authenticated Supabase user
//     -> active account_memberships row
//     -> authoritative account_id
//     -> every account-owned read/write
//
// No default-account fallback. No account_id from request body, query string,
// browser state, or JSON blobs is ever trusted. Missing membership = 403.

import { getDatabase } from "@netlify/database";
import { LEGACY_DEFAULT_ACCOUNT_ID } from "./account.mts";
import type { AccountRole, AppUserRole, SessionRole } from "./auth-contract.mts";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const sessionCookieName = "clarity_session";

function env(name: string, fallback = ""): string {
  return (
    (globalThis as unknown as { Netlify?: { env?: { get: (n: string) => string } } })
      .Netlify?.env?.get(name) ||
    (process.env[name] as string | undefined) ||
    fallback
  );
}

function db() {
  return getDatabase();
}

function nowIso(): string {
  return new Date().toISOString();
}

function cleanString(value: unknown, fallback = "", max = 600): string {
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, max);
}

function cleanEmail(value: unknown, fallback = ""): string {
  const email = cleanString(value, "", 180).toLowerCase();
  return email.includes("@") ? email : fallback;
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

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function parseCookies(req: Request): Record<string, string> {
  const cookieHeaderValue = req.headers.get("cookie") || "";
  return Object.fromEntries(
    cookieHeaderValue
      .split(";")
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const index = pair.indexOf("=");
        return index === -1
          ? [decodeURIComponent(pair), ""]
          : [decodeURIComponent(pair.slice(0, index)), decodeURIComponent(pair.slice(index + 1))];
      }),
  );
}

/** The membership vocabulary. Defined once, in _shared/auth-contract.mts. */
export type CoachRole = AccountRole;

export type CoachActor = {
  authUserId: string;
  accountId: string;
  role: CoachRole;
  coachId?: string;
  isOwner: boolean;
  isAdmin: boolean;
  membershipId: string;
};

// --- Supabase Auth helpers (mirrors booking-core's pattern) ---------------

function supabaseStorageConfig(): { url: string; key: string } {
  return {
    url: env("SUPABASE_URL"),
    key: env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_API_KEY") || env("SUPABASE_KEY"),
  };
}

function supabaseAuthConfig() {
  const { url, key } = supabaseStorageConfig();
  const anonKey = env("SUPABASE_ANON_KEY") || env("SUPABASE_PUBLISHABLE_KEY") || key;
  return { url, serviceKey: key, anonKey };
}

async function supabaseAuthFetch(
  path: string,
  { method = "POST", body, useAnonKey = false }: { method?: string; body?: unknown; useAnonKey?: boolean } = {},
) {
  const { url, serviceKey, anonKey } = supabaseAuthConfig();
  const key = useAnonKey ? anonKey : serviceKey;
  const response = await fetch(`${url}/auth/v1${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  return { ok: response.ok, status: response.status, payload };
}

async function revokeSupabaseAuthSession(accessToken: string) {
  if (!accessToken) return;
  try {
    const { url, anonKey } = supabaseAuthConfig();
    await fetch(`${url}/auth/v1/logout?scope=local`, {
      method: "POST",
      headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    // best effort
  }
}

/** Verifies an email + password against Supabase Auth. Returns auth user id or "". */
export async function verifySupabaseAuthPassword(email: string, password: string): Promise<string> {
  if (!email || !password) return "";
  const { ok, payload } = await supabaseAuthFetch("/token?grant_type=password", {
    body: { email, password },
    useAnonKey: true,
  });
  if (!ok) return "";
  await revokeSupabaseAuthSession(cleanString((payload as { access_token?: string })?.access_token, "", 4000));
  return cleanString((payload as { user?: { id?: string } })?.user?.id, "", 80);
}

/** Finds an auth user id by email directly in auth.users. */
export async function findSupabaseAuthUserId(email: string): Promise<string> {
  const cleanEmailValue = cleanEmail(email, "");
  if (!cleanEmailValue) return "";
  try {
    const rows = await db().sql<{ id: string }[]>`
      SELECT id FROM auth.users WHERE lower(email) = ${cleanEmailValue} LIMIT 1
    `;
    return cleanString(rows[0]?.id, "", 80);
  } catch {
    return "";
  }
}

// --- Session + membership resolution --------------------------------------

/** Reads the admin_session and returns the linked auth_user_id or "" if missing. */
export async function readAdminSessionAuthUserId(req: Request): Promise<{
  sessionToken: string;
  authUserId: string;
  adminUserId: string;
  email: string;
  expiresAt: string;
} | null> {
  const sessionToken = parseCookies(req)[sessionCookieName] || "";
  if (!sessionToken) return null;
  const tokenHash = hashToken(sessionToken);
  const rows = await db().sql<{
    auth_user_id?: string;
    user_id: string;
    email: string;
    expires_at: string;
  }[]>`
    SELECT admin_sessions.auth_user_id,
           admin_sessions.user_id,
           admin_users.email,
           admin_sessions.expires_at
    FROM admin_sessions
    LEFT JOIN admin_users ON admin_users.id = admin_sessions.user_id
    WHERE admin_sessions.token_hash = ${tokenHash}
  `;
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await db().sql`DELETE FROM admin_sessions WHERE token_hash = ${tokenHash}`;
    return null;
  }
  return {
    sessionToken,
    authUserId: cleanString(row.auth_user_id, "", 80),
    adminUserId: cleanString(row.user_id, "", 140),
    email: cleanEmail(row.email, ""),
    expiresAt: row.expires_at,
  };
}

/**
 * The authoritative resolution step.
 *
 * Given a Supabase auth user id, looks up their active account_memberships.
 * Returns the primary (owner, else admin, else coach) membership, or null if
 * there is no active membership at all.
 */
export async function resolveMembershipForAuthUser(
  authUserId: string,
): Promise<(CoachActor & { membershipId: string }) | null> {
  if (!authUserId) return null;
  const rows = await db().sql<{
    id: string;
    account_id: string;
    role: string;
    coach_id?: string;
  }[]>`
    SELECT id, account_id, role, coach_id
    FROM account_memberships
    WHERE auth_user_id = ${authUserId}::uuid
      AND active = true
    ORDER BY CASE role
      WHEN 'owner' THEN 0
      WHEN 'admin' THEN 1
      WHEN 'coach' THEN 2
      ELSE 3
    END, created_at ASC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  const role = (["owner", "admin", "coach"].includes(row.role as CoachRole)
    ? row.role
    : "coach") as CoachRole;
  return {
    authUserId,
    accountId: cleanSlug(row.account_id, ""),
    role,
    coachId: cleanString(row.coach_id, "", 140) || undefined,
    isOwner: role === "owner",
    isAdmin: role === "owner" || role === "admin",
    membershipId: cleanString(row.id, "", 140),
  };
}

/**
 * Ensures the admin_sessions row records a Supabase auth user id.
 *
 * This bridges the legacy admin_users store and the new Supabase-Auth-first
 * boundary. If a session only has the legacy admin_user_id linked, we try to
 * find the auth user by email and backfill the auth_user_id column.
 */
export async function ensureSessionAuthUserId(
  session: NonNullable<Awaited<ReturnType<typeof readAdminSessionAuthUserId>>>,
): Promise<string> {
  if (session.authUserId) return session.authUserId;
  const derived = await findSupabaseAuthUserId(session.email);
  if (derived) {
    try {
      await db().sql`
        UPDATE admin_sessions
        SET auth_user_id = ${derived}::uuid
        WHERE token_hash = ${hashToken(session.sessionToken)}
      `;
    } catch {
      // best effort; we still have the id for this call
    }
  }
  return derived;
}

/**
 * requireCoachActor — the boundary.
 *
 * 401 = no session cookie or stale session
 * 403 = session valid but no active account_memberships row for this auth user
 *
 * Caller should catch-and-jsonify the thrown error.
 */
export async function requireCoachActor(req: Request): Promise<CoachActor> {
  const session = await readAdminSessionAuthUserId(req);
  if (!session) {
    const err = new Error("Admin login required.") as Error & { status: number; code: string };
    err.status = 401;
    err.code = "unauthorized";
    throw err;
  }
  const authUserId = await ensureSessionAuthUserId(session);
  if (!authUserId) {
    const err = new Error("This login has no Supabase identity.") as Error & { status: number; code: string };
    err.status = 403;
    err.code = "membership_required";
    throw err;
  }
  const actor = await resolveMembershipForAuthUser(authUserId);
  if (!actor) {
    const err = new Error("This account has no workspace membership.") as Error & { status: number; code: string };
    err.status = 403;
    err.code = "membership_required";
    throw err;
  }
  return actor;
}

/**
 * resolvePublicAccount — the public-route boundary.
 *
 * Resolves a business by its public slug (from /book/<slug> or hostname).
 * Unknown slug returns null — caller should 404. Never falls back to the
 * original workspace.
 */
export async function resolvePublicAccount(slug: string): Promise<{
  id: string;
  slug: string;
  businessName: string;
  status: string;
} | null> {
  const clean = cleanSlug(slug, "");
  if (!clean) return null;
  const rows = await db().sql<{
    id: string;
    slug: string;
    business_name: string;
    status: string;
  }[]>`
    SELECT id, slug, business_name, status
    FROM accounts
    WHERE (slug = ${clean} OR id = ${clean})
      AND status = 'active'
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: cleanString(row.id, ""),
    slug: cleanString(row.slug, ""),
    businessName: cleanString(row.business_name, ""),
    status: cleanString(row.status, ""),
  };
}

/** Legacy id preserved only for migrations/backfill — never for authorization. */
export { LEGACY_DEFAULT_ACCOUNT_ID };

/**
 * Bootstraps the original workspace's owner membership.
 *
 * Used once by ensureCoreTables / startup if the original workspace exists in
 * settings but account_memberships has no row for it yet. Safe to call
 * repeatedly (no-ops after the first insert).
 */
export async function ensureLegacyOwnerMembershipIfMissing(opts: {
  authUserId?: string;
  adminEmail?: string;
  coachId?: string;
} = {}): Promise<void> {
  try {
    const existing = await db().sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM account_memberships
    `;
    if (Number(existing[0]?.count || 0) > 0) return;

    const originalAccountId = LEGACY_DEFAULT_ACCOUNT_ID;
    // Migration A seeds this row for an existing database. A brand new one
    // reaches here with the tables created but empty, so seed it once.
    await db().sql`
      INSERT INTO accounts (id, slug, business_name, status)
      VALUES (${originalAccountId}, ${originalAccountId}, 'Sam Hale Golf', 'active')
      ON CONFLICT (id) DO NOTHING
    `;

    let authUserId = cleanString(opts.authUserId, "", 80);
    if (!authUserId && opts.adminEmail) {
      authUserId = await findSupabaseAuthUserId(opts.adminEmail);
    }
    if (!authUserId) return;

    const coachId = cleanString(opts.coachId, "", 140) || undefined;
    await db().sql`
      INSERT INTO account_memberships (id, account_id, auth_user_id, role, coach_id, active, created_at, updated_at)
      VALUES (
        ${`membership-${originalAccountId}-owner`},
        ${originalAccountId},
        ${authUserId}::uuid,
        'owner',
        ${coachId || null},
        true,
        NOW(),
        NOW()
      )
      ON CONFLICT DO NOTHING
    `;
  } catch {
    // bootstrap best-effort; missing rows surface as 403 at login instead
  }
}

/** Mint a new admin session record that also stores the auth user id. */
export async function createCoachSession(input: {
  adminUserId: string;
  authUserId?: string;
  expiresAt?: string;
}): Promise<{ token: string; expiresAt: string }> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt =
    input.expiresAt || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await db().sql`
    INSERT INTO admin_sessions (id, token_hash, user_id, auth_user_id, expires_at, created_at)
    VALUES (
      ${randomUUID()},
      ${tokenHash},
      ${input.adminUserId},
      ${input.authUserId || null}::uuid,
      ${expiresAt},
      NOW()
    )
  `;
  return { token, expiresAt };
}

/**
 * Three different role vocabularies meet at the login response, and they are
 * not interchangeable:
 *
 *   membership role   owner | admin | coach          -- which account you act for
 *   session role      guest | coach | player         -- which app shell loads
 *   app user role     account_admin | coach | staff  -- permissions inside it
 *
 * Sending a membership role where a session role was expected is what made a
 * successful login sit on the sign-in screen with no error: "owner" is not in
 * the session vocabulary, so the client read it as a guest. These two mappers
 * exist so that translation happens in one place instead of being re-guessed
 * at each boundary.
 */
export function sessionRoleForMembership(_role: CoachRole): SessionRole {
  // Every account membership is a coach-app session. The player portal has its
  // own login path and never comes through here.
  return "coach";
}

export function appUserRoleForMembership(role: CoachRole): AppUserRole {
  // An owner and an account admin get the same permissions inside the app; the
  // difference between them is ownership, which lives on the membership row.
  return role === "coach" ? "coach" : "account_admin";
}

/** Strict account membership check — no NULL accountId passes. */
export function userBelongsToAccountStrict(
  user: { accountId?: string | null } | null | undefined,
  accountId: string,
): boolean {
  return Boolean(user && typeof user.accountId === "string" && user.accountId !== "" && user.accountId === accountId);
}

/** Strict record ownership check — NULL accountId = visible to nobody. */
export function recordBelongsToAccountStrict(
  record: { accountId?: string | null } | null | undefined,
  accountId: string,
): boolean {
  return Boolean(
    record &&
      typeof record.accountId === "string" &&
      record.accountId !== "" &&
      record.accountId === accountId,
  );
}
