// Akahu (NZ open banking) → bank_transactions ledger sync.
//
// Lands every bank transaction from the connected Akahu accounts into a single
// bank_transactions staging ledger (keyed by the Akahu transaction id, so every
// sync is idempotent). That ledger then fans out to two billing flows:
//   - money OUT (debits)  → expense candidates (billing_expenses)
//   - money IN  (credits) → payment reconciliation against billing_invoices
// Phase 1 (this file) owns ingest + mapping + backfill; the expense /
// reconciliation fan-out lands in later phases.
//
// Self-contained on purpose (its own Supabase + Akahu REST helpers), same shape
// as stripe-billing.mts — it owns nothing outside bank_transactions (and, for
// the Phase 2 expense fan-out, writes billing_expenses keyed by the Akahu id).

import { randomUUID } from "node:crypto";

function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function round2(value: unknown) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function encodeFilter(value: unknown) {
  return encodeURIComponent(String(value ?? ""));
}

function cleanString(value: unknown, fallback = "", max = 600) {
  return typeof value === "string" ? value.trim().slice(0, max) || fallback : fallback;
}

function toDateOnly(value: unknown) {
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

function toIso(value: unknown) {
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

// --- Supabase REST helper (same shape as stripe-billing.mts's) --------------

function supabaseConfig() {
  const url = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
  if (!url || !key) throw new Error("Supabase is not configured.");
  return { url, key };
}

async function supabase(
  table: string,
  options: { method?: string; query?: string; body?: unknown; prefer?: string } = {},
) {
  const { url, key } = supabaseConfig();
  const response = await fetch(`${url}/rest/v1/${table}${options.query ? `?${options.query}` : ""}`, {
    method: options.method || "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(options.prefer ? { Prefer: options.prefer } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw Object.assign(
      new Error(`Supabase ${options.method || "GET"} ${table} failed ${response.status}: ${text.slice(0, 500)}`),
      { status: 502 },
    );
  }
  return text ? JSON.parse(text) : [];
}

// --- Akahu REST helper ------------------------------------------------------

const AKAHU_BASE = "https://api.akahu.io/v1";
const MAX_PAGES = 100;

// Akahu authenticates server-to-server with two tokens: the app token in the
// X-Akahu-Id header and the user's access token as a Bearer token.
function akahuTokens() {
  const appToken = env("AKAHU_APP_TOKEN");
  const userToken = env("AKAHU_USER_TOKEN");
  if (!appToken || !userToken) {
    throw Object.assign(new Error("Akahu is not configured (missing AKAHU_APP_TOKEN / AKAHU_USER_TOKEN)."), {
      status: 503,
    });
  }
  return { appToken, userToken };
}

async function akahu(path: string, params: Record<string, unknown> = {}) {
  const { appToken, userToken } = akahuTokens();
  const url = new URL(`${AKAHU_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.append(key, String(value));
  }
  // Bound every Akahu call so a stalled request surfaces as a clear error
  // instead of hanging the whole function until Netlify kills it. 9s keeps us
  // under the function timeout so the error is actually returned to the caller.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: { "X-Akahu-Id": appToken, Authorization: `Bearer ${userToken}` },
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = (error as { name?: string })?.name === "AbortError";
    throw Object.assign(
      new Error(
        aborted
          ? `Akahu GET ${path} timed out after 9s — no response from api.akahu.io (check token validity / connection).`
          : `Akahu GET ${path} network error: ${error instanceof Error ? error.message : String(error)}`,
      ),
      { status: 504 },
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(`Akahu GET ${path} failed ${response.status}: ${text.slice(0, 500)}`), {
      status: 502,
    });
  }
  const body = text ? JSON.parse(text) : {};
  if (body && body.success === false) {
    throw Object.assign(new Error(`Akahu GET ${path} returned success=false: ${cleanString(body.message, "", 300)}`), {
      status: 502,
    });
  }
  return body;
}

type AkahuList = { success?: boolean; items?: Record<string, any>[]; cursor?: { next?: string | null } };

// Akahu list endpoints are cursor-paginated: the response carries cursor.next
// until there are no more pages.
async function akahuPageAll(path: string, params: Record<string, unknown>) {
  const all: Record<string, any>[] = [];
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = (await akahu(path, { ...params, ...(cursor ? { cursor } : {}) })) as AkahuList;
    const items = Array.isArray(body?.items) ? body.items : [];
    all.push(...items);
    const next = body?.cursor?.next;
    if (!next) break;
    cursor = next;
  }
  return all;
}

/** The connected bank accounts (for reference / account selection in the UI). */
export async function listAkahuAccounts() {
  const body = (await akahu("/accounts")) as AkahuList;
  return Array.isArray(body?.items) ? body.items : [];
}

// --- Transaction mapping ----------------------------------------------------

// Akahu amount sign: negative = money out (debit), positive = money in (credit).
// That single split is what routes a row to expenses vs reconciliation.
function transactionDirection(amount: number) {
  return amount < 0 ? "out" : "in";
}

export function mapAkahuTransaction(txn: Record<string, any>, accountId: string) {
  const amount = Number(txn?.amount) || 0;
  const meta = txn?.meta || {};
  return {
    id: cleanString(txn?._id, "", 120),
    account_id: accountId,
    akahu_account_id: cleanString(txn?._account, "", 120) || null,
    akahu_connection_id: cleanString(txn?._connection, "", 120) || null,
    date: toDateOnly(txn?.date) || nowIso().slice(0, 10),
    posted_at: toIso(txn?.created_at) || toIso(txn?.date),
    amount,
    direction: transactionDirection(amount),
    currency: "NZD",
    description: cleanString(txn?.description, "", 500) || null,
    type: cleanString(txn?.type, "", 60) || null,
    merchant_name: cleanString(txn?.merchant?.name, "", 200) || null,
    // The NZ payment reference fields a payer types when paying an invoice —
    // the key signal for reconciliation.
    category_name: cleanString(txn?.category?.name, "", 200) || null,
    meta_particulars: cleanString(meta?.particulars, "", 120) || null,
    meta_code: cleanString(meta?.code, "", 120) || null,
    meta_reference: cleanString(meta?.reference, "", 120) || null,
    meta_other_account: cleanString(meta?.other_account, "", 200) || null,
    raw_json: txn,
    updated_at: nowIso(),
  };
}

// Upsert on the Akahu id. mapAkahuTransaction deliberately omits status /
// matched_invoice_id / expense_id, so a merge on re-sync refreshes the bank
// data without clobbering a row a coach has already expensed or reconciled.
async function upsertTransactions(rows: Record<string, any>[]) {
  if (!rows.length) return;
  await supabase("bank_transactions", {
    method: "POST",
    query: "on_conflict=id",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: rows,
  });
}

/**
 * Backfill / poll: pull transactions from the connected Akahu accounts and
 * upsert them into bank_transactions. `sinceIso` is an ISO date-time (exclusive
 * start); omit it for all available history.
 */
export async function syncAkahuTransactions(accountId: string, sinceIso?: string) {
  const params: Record<string, unknown> = {};
  if (sinceIso) params.start = sinceIso;
  const transactions = await akahuPageAll("/transactions", params);
  const rows = transactions.map((txn) => mapAkahuTransaction(txn, accountId)).filter((row) => row.id);
  await upsertTransactions(rows);
  const moneyIn = rows.filter((row) => row.direction === "in").length;
  return {
    ok: true,
    since: sinceIso || null,
    found: transactions.length,
    synced: rows.length,
    moneyIn,
    moneyOut: rows.length - moneyIn,
  };
}

/** Sync a specific set of transaction ids (from a webhook's new_transaction_ids). */
export async function syncAkahuTransactionsByIds(accountId: string, ids: string[]) {
  const rows: Record<string, any>[] = [];
  for (const id of ids.filter(Boolean)) {
    try {
      const body = await akahu(`/transactions/${encodeURIComponent(id)}`);
      const txn = body?.item || body;
      const row = mapAkahuTransaction(txn, accountId);
      if (row.id) rows.push(row);
    } catch (error) {
      // Skip individual failures; the nightly poll backstops any misses.
      console.error("akahu_tx_fetch_failed", id, error instanceof Error ? error.message : error);
    }
  }
  await upsertTransactions(rows);
  return { ok: true, requested: ids.length, synced: rows.length };
}

// --- Phase 2: expense fan-out (money-out → billing_expenses) -----------------

/** _account id → account display info, so candidates can show which account. */
export async function getAkahuAccountMap() {
  const accounts = await listAkahuAccounts();
  const map: Record<string, { name: string | null; type: string | null; formatted: string | null }> = {};
  for (const a of accounts) {
    const id = cleanString(a?._id, "", 120);
    if (id) {
      map[id] = {
        name: cleanString(a?.name, "", 120) || null,
        type: cleanString(a?.type, "", 40) || null,
        formatted: cleanString(a?.formatted_account, "", 60) || null,
      };
    }
  }
  return map;
}

/**
 * Unreviewed money-out transactions, annotated with account name + a suggested
 * category (from Akahu's enrichment). These are the review-first expense
 * candidates the coach approves; nothing is written to billing_expenses until
 * they do.
 */
export async function listBankExpenseCandidates(accountId: string, opts: { limit?: number } = {}) {
  const limit = Math.max(1, Math.min(300, Number(opts.limit) || 150));
  const rows = await supabase("bank_transactions", {
    query: `select=id,date,amount,description,merchant_name,category_name,type,akahu_account_id&account_id=eq.${encodeFilter(accountId)}&direction=eq.out&status=eq.unreviewed&order=date.desc&limit=${limit}`,
  });
  let accMap: Record<string, { name: string | null }> = {};
  try {
    accMap = await getAkahuAccountMap();
  } catch {
    accMap = {};
  }
  return (Array.isArray(rows) ? rows : []).map((r: Record<string, any>) => ({
    id: r.id,
    date: r.date,
    amount: round2(Math.abs(Number(r.amount) || 0)),
    description: r.description,
    merchant: r.merchant_name,
    type: r.type,
    suggestedCategory: r.category_name,
    accountId: r.akahu_account_id,
    account: accMap[r.akahu_account_id]?.name || null,
  }));
}

/** Approve one candidate → create a billing_expenses row and mark the bank
 *  transaction expensed. external_ref = the Akahu id, so it can never be
 *  imported twice (unique index) and re-syncs won't touch it. */
export async function approveBankExpenseCandidate(
  accountId: string,
  txnId: string,
  overrides: { categoryId?: string; categoryName?: string; description?: string; vendor?: string } = {},
) {
  const rows = await supabase("bank_transactions", {
    query: `select=*&id=eq.${encodeFilter(txnId)}&account_id=eq.${encodeFilter(accountId)}&limit=1`,
  });
  const txn = Array.isArray(rows) ? rows[0] : null;
  if (!txn) throw Object.assign(new Error("Bank transaction not found."), { status: 404 });
  if (txn.direction !== "out") {
    throw Object.assign(new Error("Only money-out transactions become expenses."), { status: 400 });
  }
  if (txn.status === "expensed" && txn.expense_id) {
    return { ok: true, alreadyExpensed: true, expenseId: txn.expense_id as string, txnId };
  }
  const expenseId = randomUUID();
  const expense = {
    id: expenseId,
    account_id: accountId,
    category_id: cleanString(overrides.categoryId, "", 120) || null,
    category_name_snapshot:
      cleanString(overrides.categoryName, "", 120) || cleanString(txn.category_name, "", 120) || null,
    description:
      cleanString(overrides.description, "", 600) || cleanString(txn.description, "", 600) || "Bank expense",
    vendor: cleanString(overrides.vendor, "", 200) || cleanString(txn.merchant_name, "", 200) || null,
    amount: round2(Math.abs(Number(txn.amount) || 0)),
    currency: cleanString(txn.currency, "NZD", 10) || "NZD",
    expense_date: txn.date,
    note: "Imported from bank feed (Akahu)",
    external_ref: txn.id,
  };
  await supabase("billing_expenses", { method: "POST", prefer: "return=minimal", body: [expense] });
  await supabase("bank_transactions", {
    method: "PATCH",
    query: `id=eq.${encodeFilter(txnId)}&account_id=eq.${encodeFilter(accountId)}`,
    body: { status: "expensed", expense_id: expenseId, updated_at: nowIso() },
  });
  return { ok: true, expenseId, txnId };
}

/** Dismiss a candidate (not a business expense) — it drops out of the list. */
export async function ignoreBankExpenseCandidate(accountId: string, txnId: string) {
  await supabase("bank_transactions", {
    method: "PATCH",
    query: `id=eq.${encodeFilter(txnId)}&account_id=eq.${encodeFilter(accountId)}&status=eq.unreviewed`,
    body: { status: "ignored", updated_at: nowIso() },
  });
  return { ok: true, txnId };
}
