import type { Config } from "@netlify/functions";
import { createHash } from "node:crypto";
import { defaultAccountId } from "./_shared/account.mts";
import {
  approveBankExpenseCandidate,
  ignoreBankExpenseCandidate,
  listBankExpenseCandidates,
} from "./_shared/akahu.mts";

// Phase 2 of the Akahu bank feed: turn money-out bank transactions into
// review-first expense candidates. The coach lists them, then approves (→ a
// billing_expenses row, keyed by the Akahu id so it can't be imported twice) or
// ignores. Admin-only, same session check as the other billing endpoints.
//
// POST /api/akahu-expenses
//   { action: "list" }
//   { action: "approve", id, categoryId?, categoryName?, description?, vendor? }
//   { action: "ignore", id }

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

function cleanId(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 200) : "";
}

export default async function handler(req: Request) {
  if (req.method !== "POST") return json({ error: "method_not_allowed", message: "POST only." }, 405);

  try {
    if (!(await requireAdmin(req))) return json({ error: "unauthorized", message: "Admin login required." }, 401);
    const accountId = defaultAccountId();

    const raw = await req.text();
    const body = raw ? JSON.parse(raw) : {};
    const action = String(body?.action || "list");

    if (action === "list") {
      return json({ candidates: await listBankExpenseCandidates(accountId, { limit: Number(body?.limit) || undefined }) });
    }
    if (action === "approve") {
      const id = cleanId(body?.id);
      if (!id) return json({ error: "bad_request", message: "Missing transaction id." }, 400);
      return json(
        await approveBankExpenseCandidate(accountId, id, {
          categoryId: typeof body?.categoryId === "string" ? body.categoryId : undefined,
          categoryName: typeof body?.categoryName === "string" ? body.categoryName : undefined,
          description: typeof body?.description === "string" ? body.description : undefined,
          vendor: typeof body?.vendor === "string" ? body.vendor : undefined,
        }),
      );
    }
    if (action === "ignore") {
      const id = cleanId(body?.id);
      if (!id) return json({ error: "bad_request", message: "Missing transaction id." }, 400);
      return json(await ignoreBankExpenseCandidate(accountId, id));
    }

    return json({ error: "unknown_action", message: "Unknown bank-expense action." }, 400);
  } catch (error) {
    console.error("akahu_expenses:failed", error);
    const status = Number((error as { status?: unknown })?.status);
    return json(
      { error: "akahu_expenses_error", message: error instanceof Error ? error.message : "Request failed." },
      Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500,
    );
  }
}

export const config: Config = {
  path: "/api/akahu-expenses",
};
