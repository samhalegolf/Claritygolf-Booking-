import type { Config } from "@netlify/functions";
import { createHash } from "node:crypto";
import { defaultAccountId } from "./_shared/account.mts";
import { listAkahuAccounts, syncAkahuTransactions } from "./_shared/akahu.mts";

// Admin backfill / poll endpoint for the Akahu bank feed: pulls transactions
// from the connected Akahu accounts into bank_transactions. Safe to re-run —
// everything upserts on the Akahu transaction id. Live updates arrive
// separately via akahu-webhook.mts (later phase); this endpoint is the manual
// backfill and the nightly-poll safety net.
//
// POST /api/akahu-sync  { action?: "sync" | "accounts", since?: string }
//   since: ISO date-time (exclusive start); omit for all available history.

const sessionCookieName = "clarity_session";

function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function parseCookies(req: Request) {
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

// Same session check as billing-api.mts / stripe-billing-sync.mts.
async function requireAdmin(req: Request) {
  const token = parseCookies(req)[sessionCookieName] || "";
  if (!token) return false;
  const url = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
  if (!url || !key) return false;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const response = await fetch(
    `${url}/rest/v1/admin_sessions?select=id&token_hash=eq.${encodeURIComponent(tokenHash)}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  );
  if (!response.ok) return false;
  const rows = await response.json();
  return Array.isArray(rows) && rows.length > 0;
}

export default async function handler(req: Request) {
  if (req.method !== "POST") return json({ error: "method_not_allowed", message: "POST only." }, 405);

  try {
    if (!(await requireAdmin(req))) return json({ error: "unauthorized", message: "Admin login required." }, 401);
    const accountId = defaultAccountId();

    const raw = await req.text();
    const body = raw ? JSON.parse(raw) : {};
    const action = String(body?.action || "sync");

    if (action === "accounts") {
      return json({ accounts: await listAkahuAccounts() });
    }
    if (action === "sync") {
      const since = typeof body?.since === "string" && body.since.trim() ? body.since.trim() : undefined;
      const until = typeof body?.until === "string" && body.until.trim() ? body.until.trim() : undefined;
      return json({ transactions: await syncAkahuTransactions(accountId, since, until) });
    }

    return json({ error: "unknown_action", message: "Unknown Akahu sync action." }, 400);
  } catch (error) {
    console.error("akahu_sync:failed", error);
    const status = Number((error as { status?: unknown })?.status);
    return json(
      { error: "akahu_sync_error", message: error instanceof Error ? error.message : "Sync failed." },
      Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500,
    );
  }
}

export const config: Config = {
  path: "/api/akahu-sync",
};
