import type { Config } from "@netlify/functions";
import { requireCoachActor } from "./_shared/coach-auth.mts";
import {
  approveBankExpenseCandidate,
  approveManyBankExpenseCandidates,
  ignoreBankExpenseCandidate,
  ignoreManyBankExpenseCandidates,
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
//   { action: "approveMany", ids, categoryId?, categoryName? }
//   { action: "ignoreMany", ids }


function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function cleanId(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 200) : "";
}

export default async function handler(req: Request) {
  if (req.method !== "POST") return json({ error: "method_not_allowed", message: "POST only." }, 405);

  try {
    // Bank feeds, expenses and reconciliation are per business. This used to
    // check only that a session existed and then act on the original
    // workspace regardless of who was signed in.
    const accountId = (await requireCoachActor(req)).accountId;

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
    if (action === "approveMany" || action === "ignoreMany") {
      const ids = Array.isArray(body?.ids) ? body.ids.map(cleanId).filter(Boolean) : [];
      if (!ids.length) return json({ error: "bad_request", message: "No transaction ids supplied." }, 400);
      if (ids.length > 500) return json({ error: "bad_request", message: "Too many transactions in one request." }, 400);
      if (action === "ignoreMany") return json(await ignoreManyBankExpenseCandidates(accountId, ids));
      return json(
        await approveManyBankExpenseCandidates(accountId, ids, {
          categoryId: typeof body?.categoryId === "string" ? body.categoryId : undefined,
          categoryName: typeof body?.categoryName === "string" ? body.categoryName : undefined,
        }),
      );
    }

    return json({ error: "unknown_action", message: "Unknown bank-expense action." }, 400);
  } catch (error) {
    console.error("akahu_expenses:failed", error);
    const status = Number((error as { status?: unknown })?.status);
    return json(
      {
        error: (error as { code?: string })?.code || "akahu_expenses_error",
        message: error instanceof Error ? error.message : "Request failed." ,
      },
      Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500,
    );
  }
}

export const config: Config = {
  path: "/api/akahu-expenses",
};
