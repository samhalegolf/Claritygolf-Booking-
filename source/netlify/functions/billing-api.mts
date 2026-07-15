import type { Config } from "@netlify/functions";
import { createHash, randomUUID } from "node:crypto";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { defaultAccountId as fallbackAccountId, defaultCalendarSlug } from "./_shared/account.mts";

// Billing is a new, isolated top-level app section. This function owns its
// own tables (billing_products_services, billing_invoices,
// billing_invoice_items, billing_booking_invoice_links) and its own Supabase
// REST helper below. It deliberately does not import booking-core.mts or the
// local-db adapter: it reads calendar_items (completed bookings) and the
// shared settings table directly and read-only, and otherwise must not
// depend on booking/calendar code, per the billing build plan's "protected
// rules" (billing may read completed bookings/account settings, but does not
// own booking creation, completion, or calendar state).

const sessionCookieName = "clarity_session";

function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
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

function cleanString(value: unknown, fallback = "", max = 600) {
  return typeof value === "string" ? value.trim().slice(0, max) || fallback : fallback;
}

function cleanSlug(value: unknown, fallback = "") {
  const cleaned = cleanString(value, fallback, 160)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

function cleanNumber(value: unknown, fallback = 0, { min = -1e12, max = 1e12 } = {}) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.max(min, Math.min(max, num)) : fallback;
}

function round2(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

// Plain "NZD 120.00" style. Deliberately not locale-formatted: the PDF and
// email must render identically regardless of the server's locale, and the
// currency is a free-text code (NZD/AUD/USD/...), not a symbol we can trust.
function formatMoney(amount: unknown, currency: string) {
  return `${currency} ${(Number(amount) || 0).toFixed(2)}`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- Supabase REST helper -------------------------------------------------
// Self-contained on purpose: does not go through source/netlify/functions/
// local-db (the hand-rolled SQL-string-pattern shim used by booking-core.mts)
// so adding billing tables never requires touching that adapter or its
// pattern list. See supabase-storage.mts's own header comment for context on
// why that shim exists; billing intentionally avoids it.
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
    const error = new Error(`Supabase ${options.method || "GET"} ${table} failed ${response.status}: ${text.slice(0, 500)}`) as Error & {
      status?: number;
      supabaseStatus?: number;
    };
    error.supabaseStatus = response.status;
    throw error;
  }
  return text ? JSON.parse(text) : [];
}

function encodeFilter(value: unknown) {
  return encodeURIComponent(String(value ?? ""));
}

// --- Auth + account scoping ------------------------------------------------

async function requireAdmin(req: Request) {
  const token = parseCookies(req)[sessionCookieName] || "";
  if (!token) return false;
  const rows = await supabase("admin_sessions", {
    query: `select=id&token_hash=eq.${encodeFilter(hashToken(token))}&expires_at=gt.${encodeFilter(nowIso())}&limit=1`,
  });
  return rows.length > 0;
}

// Billing is read-only here against the shared settings table: it mirrors
// how calendar-state.mts resolves the active workspace account id, without
// importing booking-core.mts or writing to any booking/calendar table.
async function resolveAccountId() {
  const rows = await supabase("settings", {
    query: `select=key,value&key=in.(${["accountCalendarSlug", "accountBusinessName", "coachName"].join(",")})`,
  });
  const map = Object.fromEntries(rows.map((row: { key: string; value: string }) => [row.key, row.value]));
  const businessName = map.accountBusinessName || map.coachName || env("CLARITY_BUSINESS_NAME", "Sam Hale Golf");
  const slugSource = map.accountCalendarSlug || businessName;
  return cleanSlug(slugSource, fallbackAccountId());
}

async function parseBody(req: Request) {
  const raw = await req.text();
  return raw ? JSON.parse(raw) : {};
}

// --- Products / services ----------------------------------------------------

function cleanProductPayload(raw: Record<string, unknown>) {
  const kind = ["service", "product", "package", "lesson-type"].includes(String(raw?.kind)) ? String(raw.kind) : "service";
  return {
    name: cleanString(raw?.name, "", 140),
    kind,
    description: cleanString(raw?.description, "", 600) || null,
    default_price: round2(cleanNumber(raw?.price ?? raw?.defaultPrice, 0, { min: 0 })),
    tax_rate: round2(cleanNumber(raw?.taxRate, 0, { min: 0, max: 100 })),
    active: raw?.active !== false,
  };
}

function productRowToApi(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    description: row.description || "",
    price: Number(row.default_price) || 0,
    taxRate: Number(row.tax_rate) || 0,
    active: row.active !== false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listProducts(accountId: string) {
  const rows = await supabase("billing_products_services", {
    query: `select=*&account_id=eq.${encodeFilter(accountId)}&order=active.desc,name.asc`,
  });
  return { products: rows.map(productRowToApi) };
}

async function createProduct(accountId: string, body: Record<string, unknown>) {
  const clean = cleanProductPayload(body);
  if (!clean.name) throw Object.assign(new Error("Product name is required."), { status: 400 });
  const row = { id: randomUUID(), account_id: accountId, ...clean, created_at: nowIso(), updated_at: nowIso() };
  await supabase("billing_products_services", { method: "POST", body: [row], prefer: "return=minimal" });
  return { product: productRowToApi(row) };
}

async function updateProduct(accountId: string, id: string, body: Record<string, unknown>) {
  const clean = cleanProductPayload(body);
  if (!clean.name) throw Object.assign(new Error("Product name is required."), { status: 400 });
  const patch = { ...clean, updated_at: nowIso() };
  const rows = await supabase("billing_products_services", {
    method: "PATCH",
    query: `id=eq.${encodeFilter(id)}&account_id=eq.${encodeFilter(accountId)}`,
    body: patch,
    prefer: "return=representation",
  });
  if (!rows.length) throw Object.assign(new Error("Product not found."), { status: 404 });
  return { product: productRowToApi(rows[0]) };
}

// --- Discount presets --------------------------------------------------------

function cleanDiscountPayload(raw: Record<string, unknown>) {
  const discountType = String(raw?.discountType) === "percentage" ? "percentage" : "fixed";
  const maxValue = discountType === "percentage" ? 100 : 1e9;
  const couponCode = cleanString(raw?.couponCode, "", 40).toUpperCase();
  return {
    name: cleanString(raw?.name, "", 140),
    discount_type: discountType,
    value: round2(cleanNumber(raw?.value, 0, { min: 0, max: maxValue })),
    coupon_code: couponCode || null,
    active: raw?.active !== false,
  };
}

function discountRowToApi(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    discountType: row.discount_type,
    value: Number(row.value) || 0,
    couponCode: row.coupon_code || "",
    active: row.active !== false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listDiscounts(accountId: string) {
  const rows = await supabase("billing_discounts", {
    query: `select=*&account_id=eq.${encodeFilter(accountId)}&order=active.desc,name.asc`,
  });
  return { discounts: rows.map(discountRowToApi) };
}

async function createDiscount(accountId: string, body: Record<string, unknown>) {
  const clean = cleanDiscountPayload(body);
  if (!clean.name) throw Object.assign(new Error("Discount name is required."), { status: 400 });
  const row = { id: randomUUID(), account_id: accountId, ...clean, created_at: nowIso(), updated_at: nowIso() };
  try {
    await supabase("billing_discounts", { method: "POST", body: [row], prefer: "return=minimal" });
  } catch (error) {
    const status = (error as { supabaseStatus?: number })?.supabaseStatus;
    if (status === 409) {
      throw Object.assign(new Error(`Coupon code ${clean.coupon_code} is already in use.`), { status: 409, code: "COUPON_CODE_CONFLICT" });
    }
    throw error;
  }
  return { discount: discountRowToApi(row) };
}

async function updateDiscount(accountId: string, id: string, body: Record<string, unknown>) {
  const clean = cleanDiscountPayload(body);
  if (!clean.name) throw Object.assign(new Error("Discount name is required."), { status: 400 });
  const patch = { ...clean, updated_at: nowIso() };
  let rows;
  try {
    rows = await supabase("billing_discounts", {
      method: "PATCH",
      query: `id=eq.${encodeFilter(id)}&account_id=eq.${encodeFilter(accountId)}`,
      body: patch,
      prefer: "return=representation",
    });
  } catch (error) {
    const status = (error as { supabaseStatus?: number })?.supabaseStatus;
    if (status === 409) {
      throw Object.assign(new Error(`Coupon code ${clean.coupon_code} is already in use.`), { status: 409, code: "COUPON_CODE_CONFLICT" });
    }
    throw error;
  }
  if (!rows.length) throw Object.assign(new Error("Discount not found."), { status: 404 });
  return { discount: discountRowToApi(rows[0]) };
}

// --- Expense categories -------------------------------------------------------
// Presets only, same shape/pattern as discounts above (name + active). Not
// used anywhere else in billing - deactivating one just hides it from the
// picker, it never touches historical billing_expenses rows.

function cleanExpenseCategoryPayload(raw: Record<string, unknown>) {
  return {
    name: cleanString(raw?.name, "", 140),
    active: raw?.active !== false,
  };
}

function expenseCategoryRowToApi(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    active: row.active !== false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listExpenseCategories(accountId: string) {
  const rows = await supabase("billing_expense_categories", {
    query: `select=*&account_id=eq.${encodeFilter(accountId)}&order=active.desc,name.asc`,
  });
  return { categories: rows.map(expenseCategoryRowToApi) };
}

async function createExpenseCategory(accountId: string, body: Record<string, unknown>) {
  const clean = cleanExpenseCategoryPayload(body);
  if (!clean.name) throw Object.assign(new Error("Category name is required."), { status: 400 });
  const row = { id: randomUUID(), account_id: accountId, ...clean, created_at: nowIso(), updated_at: nowIso() };
  try {
    await supabase("billing_expense_categories", { method: "POST", body: [row], prefer: "return=minimal" });
  } catch (error) {
    const status = (error as { supabaseStatus?: number })?.supabaseStatus;
    if (status === 409) {
      throw Object.assign(new Error(`A category named "${clean.name}" already exists.`), { status: 409, code: "CATEGORY_NAME_CONFLICT" });
    }
    throw error;
  }
  return { category: expenseCategoryRowToApi(row) };
}

async function updateExpenseCategory(accountId: string, id: string, body: Record<string, unknown>) {
  const clean = cleanExpenseCategoryPayload(body);
  if (!clean.name) throw Object.assign(new Error("Category name is required."), { status: 400 });
  const patch = { ...clean, updated_at: nowIso() };
  let rows;
  try {
    rows = await supabase("billing_expense_categories", {
      method: "PATCH",
      query: `id=eq.${encodeFilter(id)}&account_id=eq.${encodeFilter(accountId)}`,
      body: patch,
      prefer: "return=representation",
    });
  } catch (error) {
    const status = (error as { supabaseStatus?: number })?.supabaseStatus;
    if (status === 409) {
      throw Object.assign(new Error(`A category named "${clean.name}" already exists.`), { status: 409, code: "CATEGORY_NAME_CONFLICT" });
    }
    throw error;
  }
  if (!rows.length) throw Object.assign(new Error("Category not found."), { status: 404 });
  return { category: expenseCategoryRowToApi(rows[0]) };
}

// --- Expenses ------------------------------------------------------------------
// Simple outgoing-spend tracking: what the coach paid for, when, and roughly
// why. Deliberately not linked to invoices/bookings (this isn't cost-of-goods
// against a specific sale) and never hard-deleted - "voided" hides a mistaken
// entry from totals while keeping the record for the audit trail.

async function resolveExpenseCategorySnapshot(accountId: string, categoryId: unknown) {
  const id = cleanString(categoryId, "", 200);
  if (!id) return { category_id: null, category_name_snapshot: null };
  const rows = await supabase("billing_expense_categories", {
    query: `select=id,name&id=eq.${encodeFilter(id)}&account_id=eq.${encodeFilter(accountId)}&limit=1`,
  });
  if (!rows.length) throw Object.assign(new Error("Expense category not found."), { status: 400 });
  return { category_id: rows[0].id, category_name_snapshot: rows[0].name };
}

function cleanExpensePayload(raw: Record<string, unknown>) {
  const expenseDate = cleanString(raw?.expenseDate, "", 10);
  return {
    description: cleanString(raw?.description, "", 200),
    vendor: cleanString(raw?.vendor, "", 140) || null,
    amount: round2(cleanNumber(raw?.amount, 0, { min: 0 })),
    currency: cleanString(raw?.currency, "NZD", 8).toUpperCase(),
    expense_date: /^\d{4}-\d{2}-\d{2}$/.test(expenseDate) ? expenseDate : nowIso().slice(0, 10),
    note: cleanString(raw?.note, "", 600) || null,
  };
}

function expenseRowToApi(row: Record<string, unknown>) {
  return {
    id: row.id,
    description: row.description,
    vendor: row.vendor || "",
    amount: Number(row.amount) || 0,
    currency: row.currency,
    expenseDate: row.expense_date,
    categoryId: row.category_id || "",
    categoryName: row.category_name_snapshot || "",
    note: row.note || "",
    voided: row.voided === true,
    imported: Boolean(row.external_ref),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listExpenses(accountId: string, url: URL) {
  const from = cleanString(url.searchParams.get("from"), "", 10);
  const to = cleanString(url.searchParams.get("to"), "", 10);
  const filters = [`account_id=eq.${encodeFilter(accountId)}`];
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) filters.push(`expense_date=gte.${encodeFilter(from)}`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) filters.push(`expense_date=lte.${encodeFilter(to)}`);
  const rows = await supabase("billing_expenses", {
    query: `select=*&${filters.join("&")}&order=expense_date.desc,created_at.desc&limit=200`,
  });
  return { expenses: rows.map(expenseRowToApi) };
}

async function createExpense(accountId: string, body: Record<string, unknown>) {
  const clean = cleanExpensePayload(body);
  if (!clean.description) throw Object.assign(new Error("Expense description is required."), { status: 400 });
  const categorySnapshot = await resolveExpenseCategorySnapshot(accountId, body?.categoryId);
  const row = {
    id: randomUUID(),
    account_id: accountId,
    ...categorySnapshot,
    ...clean,
    voided: false,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  await supabase("billing_expenses", { method: "POST", body: [row], prefer: "return=minimal" });
  return { expense: expenseRowToApi(row) };
}

async function updateExpense(accountId: string, id: string, body: Record<string, unknown>) {
  const clean = cleanExpensePayload(body);
  if (!clean.description) throw Object.assign(new Error("Expense description is required."), { status: 400 });
  const categorySnapshot =
    body?.categoryId === undefined ? {} : await resolveExpenseCategorySnapshot(accountId, body.categoryId);
  const patch: Record<string, unknown> = {
    ...clean,
    ...categorySnapshot,
    updated_at: nowIso(),
  };
  if (typeof body?.voided === "boolean") patch.voided = body.voided;
  const rows = await supabase("billing_expenses", {
    method: "PATCH",
    query: `id=eq.${encodeFilter(id)}&account_id=eq.${encodeFilter(accountId)}`,
    body: patch,
    prefer: "return=representation",
  });
  if (!rows.length) throw Object.assign(new Error("Expense not found."), { status: 404 });
  return { expense: expenseRowToApi(rows[0]) };
}

// Bulk import from a bank CSV. Each row is inserted individually (not one
// batch call) specifically so one bad or duplicate row can't sink the whole
// file - every row gets its own outcome, and the caller sees exactly which
// ones landed, which were duplicates, and which failed and why.
//
// Dedup key: the bank's own transaction reference when the import supplies
// one, otherwise a hash of account+date+description+amount. Re-uploading the
// same file, or a new export whose date range overlaps a previous one, will
// therefore skip rows already imported instead of double-counting spend.
function expenseExternalRef(accountId: string, reference: unknown, expenseDate: string, description: string, amount: number) {
  const cleanReference = cleanString(reference, "", 200);
  if (cleanReference) return `bank:${cleanReference}`;
  const digest = createHash("sha256").update(`${accountId}|${expenseDate}|${description}|${amount.toFixed(2)}`).digest("hex");
  return `hash:${digest}`;
}

async function importExpenses(accountId: string, body: Record<string, unknown>) {
  const rawRows = Array.isArray(body?.expenses) ? (body.expenses as Record<string, unknown>[]) : [];
  const result = {
    imported: 0,
    duplicate: 0,
    skipped: 0,
    failed: 0,
    errors: [] as Array<{ index: number; message: string }>,
  };

  for (let index = 0; index < rawRows.length; index += 1) {
    const raw = rawRows[index] || {};
    const clean = cleanExpensePayload(raw);
    if (!clean.description || clean.amount <= 0) {
      result.skipped += 1;
      continue;
    }
    try {
      const categorySnapshot = await resolveExpenseCategorySnapshot(accountId, raw?.categoryId);
      const row = {
        id: randomUUID(),
        account_id: accountId,
        ...categorySnapshot,
        ...clean,
        voided: false,
        external_ref: expenseExternalRef(accountId, raw?.reference, clean.expense_date, clean.description, clean.amount),
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      await supabase("billing_expenses", { method: "POST", body: [row], prefer: "return=minimal" });
      result.imported += 1;
    } catch (error) {
      const status = (error as { supabaseStatus?: number })?.supabaseStatus;
      if (status === 409) {
        result.duplicate += 1;
      } else {
        result.failed += 1;
        result.errors.push({ index, message: error instanceof Error ? error.message : "Unknown error" });
      }
    }
  }

  return result;
}

// --- Invoices ----------------------------------------------------------------

type InvoiceItemInput = {
  sourceType?: string;
  sourceId?: string;
  description?: string;
  quantity?: number;
  unitPrice?: number;
  taxRate?: number;
  discountAmount?: number;
};

function cleanInvoiceItem(raw: InvoiceItemInput, taxInclusive = false) {
  const sourceType = ["booking", "product", "manual"].includes(String(raw?.sourceType)) ? String(raw.sourceType) : "manual";
  const quantity = cleanNumber(raw?.quantity, 1, { min: 0 });
  const unitPrice = round2(cleanNumber(raw?.unitPrice, 0, { min: 0 }));
  const taxRate = round2(cleanNumber(raw?.taxRate, 0, { min: 0, max: 100 }));
  const discountAmount = round2(cleanNumber(raw?.discountAmount, 0, { min: 0 }));
  const lineAmount = Math.max(0, round2(quantity * unitPrice) - discountAmount);
  // Inclusive: the unit price already contains tax, so tax is the fraction
  // rate/(100+rate) of the line and the line total is just the line amount.
  // Exclusive: tax is added on top of the line.
  const taxAmount = taxInclusive
    ? round2(lineAmount * (taxRate / (100 + taxRate)))
    : round2(lineAmount * (taxRate / 100));
  return {
    id: randomUUID(),
    source_type: sourceType,
    source_id: cleanString(raw?.sourceId, "", 160) || null,
    description: cleanString(raw?.description, "", 400),
    quantity,
    unit_price: unitPrice,
    tax_rate: taxRate,
    tax_amount: taxAmount,
    discount_amount: discountAmount,
    line_total: taxInclusive ? lineAmount : round2(lineAmount + taxAmount),
  };
}

function invoiceRowToApi(row: Record<string, unknown>, items: Array<Record<string, unknown>> = []) {
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    status: row.status,
    customerId: row.customer_id || null,
    customerName: row.customer_name,
    customerEmail: row.customer_email || "",
    customerPhone: row.customer_phone || "",
    issueDate: row.issue_date,
    dueDate: row.due_date || null,
    currency: row.currency,
    subtotal: Number(row.subtotal) || 0,
    taxTotal: Number(row.tax_total) || 0,
    taxInclusive: row.tax_inclusive === true,
    discountTotal: Number(row.discount_total) || 0,
    discountLabel: row.discount_label || "",
    total: Number(row.total) || 0,
    amountPaid: Number(row.amount_paid) || 0,
    customerNote: row.customer_note || "",
    internalNote: row.internal_note || "",
    reference: row.reference || "",
    sentAt: row.sent_at || null,
    paidAt: row.paid_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: items.map((item) => ({
      id: item.id,
      sourceType: item.source_type,
      sourceId: item.source_id || null,
      description: item.description,
      quantity: Number(item.quantity) || 0,
      unitPrice: Number(item.unit_price) || 0,
      taxRate: Number(item.tax_rate) || 0,
      taxAmount: Number(item.tax_amount) || 0,
      discountAmount: Number(item.discount_amount) || 0,
      lineTotal: Number(item.line_total) || 0,
    })),
  };
}

async function listInvoices(accountId: string, url: URL) {
  const status = cleanString(url.searchParams.get("status"), "", 20);
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 50));
  const filters = [`account_id=eq.${encodeFilter(accountId)}`];
  if (status) filters.push(`status=eq.${encodeFilter(status)}`);
  const rows = await supabase("billing_invoices", {
    query: `select=*&${filters.join("&")}&order=issue_date.desc,created_at.desc&limit=${limit}`,
  });
  return { invoices: rows.map((row: Record<string, unknown>) => invoiceRowToApi(row)) };
}

async function getInvoiceWithItems(accountId: string, id: string) {
  const rows = await supabase("billing_invoices", {
    query: `select=*&id=eq.${encodeFilter(id)}&account_id=eq.${encodeFilter(accountId)}&limit=1`,
  });
  const row = rows[0];
  if (!row) return null;
  const items = await supabase("billing_invoice_items", {
    query: `select=*&invoice_id=eq.${encodeFilter(id)}&order=created_at.asc`,
  });
  return invoiceRowToApi(row, items) as unknown as InvoiceApi;
}

async function createBookingLinks(
  accountId: string,
  invoiceId: string,
  bookingIds: string[],
  { rollbackInvoiceOnConflict = true }: { rollbackInvoiceOnConflict?: boolean } = {},
) {
  if (!bookingIds.length) return;
  const rows = bookingIds.map((bookingId) => ({
    id: randomUUID(),
    account_id: accountId,
    booking_id: bookingId,
    invoice_id: invoiceId,
    created_at: nowIso(),
  }));
  try {
    await supabase("billing_booking_invoice_links", { method: "POST", body: rows, prefer: "return=minimal" });
  } catch (error) {
    const status = (error as { supabaseStatus?: number })?.supabaseStatus;
    if (status === 409) {
      // At least one booking already has an invoice. On create we roll back the
      // invoice we just made so a failed pull doesn't leave an orphaned draft;
      // on edit we must NOT delete the (pre-existing) invoice - just surface the
      // conflict so the caller can restore its prior links.
      if (rollbackInvoiceOnConflict) {
        await supabase("billing_invoices", {
          method: "DELETE",
          query: `id=eq.${encodeFilter(invoiceId)}&account_id=eq.${encodeFilter(accountId)}`,
        }).catch(() => {});
      }
      throw Object.assign(new Error("One or more of these bookings has already been invoiced."), {
        status: 409,
        code: "BOOKING_ALREADY_INVOICED",
      });
    }
    throw error;
  }
}

async function createInvoice(accountId: string, body: Record<string, unknown>) {
  const invoiceNumber = cleanString(body?.invoiceNumber, "", 60);
  const customerName = cleanString(body?.customerName, "", 140);
  if (!invoiceNumber) throw Object.assign(new Error("Invoice number is required."), { status: 400 });
  if (!customerName) throw Object.assign(new Error("Customer is required."), { status: 400 });

  const taxInclusive = body?.taxInclusive === true;
  const itemsInput = Array.isArray(body?.items) ? (body.items as InvoiceItemInput[]) : [];
  const items = itemsInput.map((item) => cleanInvoiceItem(item, taxInclusive)).filter((item) => item.description && item.quantity > 0);
  if (!items.length) throw Object.assign(new Error("Add at least one invoice line."), { status: 400 });

  const subtotal = round2(items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0));
  const discountTotal = round2(Math.min(subtotal, cleanNumber(body?.discountAmount, 0, { min: 0 })));
  const taxTotal = round2(items.reduce((sum, item) => sum + item.tax_amount, 0));
  // Inclusive: tax is already inside the line prices, so it isn't added again.
  const total = round2(Math.max(0, subtotal - discountTotal) + (taxInclusive ? 0 : taxTotal));

  const status = ["draft", "sent"].includes(String(body?.status)) ? String(body.status) : "draft";
  const invoiceId = randomUUID();
  const invoiceRow = {
    id: invoiceId,
    account_id: accountId,
    invoice_number: invoiceNumber,
    status,
    customer_id: cleanString(body?.customerId, "", 160) || null,
    customer_name: customerName,
    customer_email: cleanString(body?.customerEmail, "", 180) || null,
    customer_phone: cleanString(body?.customerPhone, "", 80) || null,
    issue_date: cleanString(body?.issueDate, new Date().toISOString().slice(0, 10), 20),
    due_date: cleanString(body?.dueDate, "", 20) || null,
    currency: cleanString(body?.currency, "NZD", 10),
    subtotal,
    tax_total: taxTotal,
    tax_inclusive: taxInclusive,
    discount_total: discountTotal,
    discount_label: cleanString(body?.discountLabel, "", 120) || null,
    total,
    amount_paid: 0,
    customer_note: cleanString(body?.customerNote, "", 2000) || null,
    internal_note: cleanString(body?.internalNote, "", 2000) || null,
    reference: cleanString(body?.reference, "", 160) || null,
    sent_at: status === "sent" ? nowIso() : null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  try {
    await supabase("billing_invoices", { method: "POST", body: [invoiceRow], prefer: "return=minimal" });
  } catch (error) {
    const status = (error as { supabaseStatus?: number })?.supabaseStatus;
    if (status === 409) {
      throw Object.assign(new Error(`Invoice number ${invoiceNumber} is already in use.`), {
        status: 409,
        code: "INVOICE_NUMBER_CONFLICT",
      });
    }
    throw error;
  }

  const itemRows = items.map((item) => ({ ...item, invoice_id: invoiceId, account_id: accountId, created_at: nowIso() }));
  await supabase("billing_invoice_items", { method: "POST", body: itemRows, prefer: "return=minimal" });

  const bookingIds = [...new Set(
    itemsInput
      .filter((item) => item.sourceType === "booking" && item.sourceId)
      .map((item) => String(item.sourceId)),
  )];
  await createBookingLinks(accountId, invoiceId, bookingIds);

  return getInvoiceWithItems(accountId, invoiceId);
}

// Edit a draft in place. Only draft invoices are editable - once an invoice is
// sent/paid/void its numbers are committed, so those come back as a 409 the UI
// reads as "not editable". The invoice_number itself is never changed here: it
// was already issued to this draft and is the account-unique key. Line items and
// booking links are replaced wholesale, and totals are recomputed exactly as in
// createInvoice so an edited draft and a freshly created one are indistinguishable.
async function updateInvoiceDraft(accountId: string, id: string, body: Record<string, unknown>) {
  const existingRows = await supabase("billing_invoices", {
    query: `select=id,status&id=eq.${encodeFilter(id)}&account_id=eq.${encodeFilter(accountId)}&limit=1`,
  });
  const existing = existingRows[0];
  if (!existing) throw Object.assign(new Error("Invoice not found."), { status: 404 });
  if (existing.status !== "draft") {
    throw Object.assign(new Error("Only draft invoices can be edited. Void this invoice to make changes."), {
      status: 409,
      code: "INVOICE_NOT_EDITABLE",
    });
  }

  const customerName = cleanString(body?.customerName, "", 140);
  if (!customerName) throw Object.assign(new Error("Customer is required."), { status: 400 });

  const taxInclusive = body?.taxInclusive === true;
  const itemsInput = Array.isArray(body?.items) ? (body.items as InvoiceItemInput[]) : [];
  const items = itemsInput.map((item) => cleanInvoiceItem(item, taxInclusive)).filter((item) => item.description && item.quantity > 0);
  if (!items.length) throw Object.assign(new Error("Add at least one invoice line."), { status: 400 });

  const subtotal = round2(items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0));
  const discountTotal = round2(Math.min(subtotal, cleanNumber(body?.discountAmount, 0, { min: 0 })));
  const taxTotal = round2(items.reduce((sum, item) => sum + item.tax_amount, 0));
  const total = round2(Math.max(0, subtotal - discountTotal) + (taxInclusive ? 0 : taxTotal));

  const patch = {
    customer_id: cleanString(body?.customerId, "", 160) || null,
    customer_name: customerName,
    customer_email: cleanString(body?.customerEmail, "", 180) || null,
    customer_phone: cleanString(body?.customerPhone, "", 80) || null,
    issue_date: cleanString(body?.issueDate, new Date().toISOString().slice(0, 10), 20),
    due_date: cleanString(body?.dueDate, "", 20) || null,
    currency: cleanString(body?.currency, "NZD", 10),
    subtotal,
    tax_total: taxTotal,
    tax_inclusive: taxInclusive,
    discount_total: discountTotal,
    discount_label: cleanString(body?.discountLabel, "", 120) || null,
    total,
    customer_note: cleanString(body?.customerNote, "", 2000) || null,
    internal_note: cleanString(body?.internalNote, "", 2000) || null,
    reference: cleanString(body?.reference, "", 160) || null,
    updated_at: nowIso(),
  };
  // Re-assert status=draft in the filter so a concurrent send/void can't be
  // silently overwritten between the read above and this write.
  const updated = await supabase("billing_invoices", {
    method: "PATCH",
    query: `id=eq.${encodeFilter(id)}&account_id=eq.${encodeFilter(accountId)}&status=eq.draft`,
    body: patch,
    prefer: "return=representation",
  });
  if (!updated.length) {
    throw Object.assign(new Error("Only draft invoices can be edited. Void this invoice to make changes."), {
      status: 409,
      code: "INVOICE_NOT_EDITABLE",
    });
  }

  // Replace the line items wholesale.
  await supabase("billing_invoice_items", { method: "DELETE", query: `invoice_id=eq.${encodeFilter(id)}` });
  const itemRows = items.map((item) => ({ ...item, invoice_id: id, account_id: accountId, created_at: nowIso() }));
  await supabase("billing_invoice_items", { method: "POST", body: itemRows, prefer: "return=minimal" });

  // Rebuild booking links (an edit can add or drop booking-sourced lines). Drop
  // this invoice's own links first so re-selecting the same bookings doesn't
  // collide with itself; a 409 now means another invoice grabbed the booking.
  await supabase("billing_booking_invoice_links", {
    method: "DELETE",
    query: `invoice_id=eq.${encodeFilter(id)}&account_id=eq.${encodeFilter(accountId)}`,
  });
  const bookingIds = [...new Set(
    itemsInput
      .filter((item) => item.sourceType === "booking" && item.sourceId)
      .map((item) => String(item.sourceId)),
  )];
  await createBookingLinks(accountId, id, bookingIds, { rollbackInvoiceOnConflict: false });

  return getInvoiceWithItems(accountId, id);
}

async function updateInvoiceStatus(accountId: string, id: string, body: Record<string, unknown>) {
  const nextStatus = String(body?.status || "");
  if (!["draft", "sent", "paid", "overdue", "void"].includes(nextStatus)) {
    throw Object.assign(new Error("Invalid invoice status."), { status: 400 });
  }
  const patch: Record<string, unknown> = { status: nextStatus, updated_at: nowIso() };
  if (nextStatus === "sent") patch.sent_at = nowIso();
  if (nextStatus === "paid") {
    patch.paid_at = nowIso();
    if (body?.amountPaid !== undefined) patch.amount_paid = round2(cleanNumber(body.amountPaid, 0, { min: 0 }));
  }
  const rows = await supabase("billing_invoices", {
    method: "PATCH",
    query: `id=eq.${encodeFilter(id)}&account_id=eq.${encodeFilter(accountId)}`,
    body: patch,
    prefer: "return=representation",
  });
  if (!rows.length) throw Object.assign(new Error("Invoice not found."), { status: 404 });
  if (nextStatus === "paid" && body?.amountPaid === undefined) {
    // Default "mark paid" to the invoice total unless a partial amount was given.
    const full = await supabase("billing_invoices", {
      method: "PATCH",
      query: `id=eq.${encodeFilter(id)}&account_id=eq.${encodeFilter(accountId)}`,
      body: { amount_paid: rows[0].total },
      prefer: "return=representation",
    });
    return getInvoiceWithItems(accountId, id) ?? invoiceRowToApi(full[0]);
  }
  return getInvoiceWithItems(accountId, id);
}

// --- Booking / invoice link lookups ------------------------------------------

async function checkBookingLinks(accountId: string, bookingIds: string[]) {
  if (!bookingIds.length) return { links: {} };
  const filter = bookingIds.map((id) => `"${id.replace(/"/g, '\\"')}"`).join(",");
  const rows = await supabase("billing_booking_invoice_links", {
    query: `select=booking_id,invoice_id&account_id=eq.${encodeFilter(accountId)}&booking_id=in.(${filter})`,
  });
  const links = Object.fromEntries(rows.map((row: Record<string, unknown>) => [row.booking_id, row.invoice_id]));
  return { links };
}

// --- Revenue report -----------------------------------------------------------
// Deliberately simple per the billing build plan ("Reports should be simple
// summaries, not heavy accounting dashboards"): fetch the invoice rows for the
// widest date range needed (current period + the matching period a year ago)
// in one request and bucket/sum them here, rather than standing up SQL
// aggregation. Revenue = invoiced totals for status in (sent, paid, overdue);
// drafts and voided invoices are excluded since they aren't committed income.
// All date math is done on plain "YYYY-MM-DD" values in UTC, matching how
// issue_date is stored (a date column, no time/timezone component).

const REVENUE_STATUSES = ["sent", "paid", "overdue"];
const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseDateOnly(value: unknown): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ""));
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDaysUTC(date: Date, days: number) {
  return new Date(date.getTime() + days * 86400000);
}

function startOfWeekUTC(date: Date) {
  const day = date.getUTCDay();
  const diff = (day === 0 ? -6 : 1) - day;
  return addDaysUTC(date, diff);
}

function startOfMonthUTC(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function endOfMonthUTC(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

function shiftYearsUTC(date: Date, years: number) {
  return new Date(Date.UTC(date.getUTCFullYear() + years, date.getUTCMonth(), date.getUTCDate()));
}

type RevenuePeriod = "week" | "month" | "year";

function periodRange(period: RevenuePeriod, refDate: Date) {
  if (period === "week") {
    const start = startOfWeekUTC(refDate);
    return { start, end: addDaysUTC(start, 6) };
  }
  if (period === "year") {
    return { start: new Date(Date.UTC(refDate.getUTCFullYear(), 0, 1)), end: new Date(Date.UTC(refDate.getUTCFullYear(), 11, 31)) };
  }
  return { start: startOfMonthUTC(refDate), end: endOfMonthUTC(refDate) };
}

function sumInvoiceTotals(rows: Array<{ issue_date: string; total: unknown }>, start: string, end: string) {
  return round2(
    rows
      .filter((row) => row.issue_date >= start && row.issue_date <= end)
      .reduce((sum, row) => sum + (Number(row.total) || 0), 0),
  );
}

function bucketizeRevenue(period: RevenuePeriod, start: Date, end: Date, rows: Array<{ issue_date: string; total: unknown }>) {
  if (period === "week") {
    return Array.from({ length: 7 }, (_, i) => {
      const day = addDaysUTC(start, i);
      const key = formatDateOnly(day);
      return { label: WEEKDAY_LABELS[i], rangeStart: key, rangeEnd: key, total: sumInvoiceTotals(rows, key, key) };
    });
  }
  if (period === "year") {
    const year = start.getUTCFullYear();
    return Array.from({ length: 12 }, (_, i) => {
      const monthStart = new Date(Date.UTC(year, i, 1));
      const monthEnd = new Date(Date.UTC(year, i + 1, 0));
      const rangeStart = formatDateOnly(monthStart);
      const rangeEnd = formatDateOnly(monthEnd);
      return { label: MONTH_LABELS[i], rangeStart, rangeEnd, total: sumInvoiceTotals(rows, rangeStart, rangeEnd) };
    });
  }
  // Month: bucket by week so it stays readable (4-5 bars instead of 28-31).
  const buckets: Array<{ label: string; rangeStart: string; rangeEnd: string; total: number }> = [];
  let cursor = start;
  while (cursor.getTime() <= end.getTime()) {
    const bucketEnd = new Date(Math.min(addDaysUTC(cursor, 6).getTime(), end.getTime()));
    const rangeStart = formatDateOnly(cursor);
    const rangeEnd = formatDateOnly(bucketEnd);
    buckets.push({
      label: `${cursor.getUTCDate()}-${bucketEnd.getUTCDate()}`,
      rangeStart,
      rangeEnd,
      total: sumInvoiceTotals(rows, rangeStart, rangeEnd),
    });
    cursor = addDaysUTC(bucketEnd, 1);
  }
  return buckets;
}

async function resolveDefaultCurrency() {
  const rows = await supabase("settings", {
    query: `select=value&key=eq.${encodeFilter("accountInvoiceSettingsJson")}&limit=1`,
  });
  try {
    const parsed = rows[0]?.value ? JSON.parse(rows[0].value) : null;
    return cleanString(parsed?.currency, "NZD", 10);
  } catch {
    return "NZD";
  }
}

async function revenueReport(accountId: string, url: URL) {
  const period: RevenuePeriod = ["week", "month", "year"].includes(String(url.searchParams.get("period")))
    ? (url.searchParams.get("period") as RevenuePeriod)
    : "month";
  const refDate = parseDateOnly(url.searchParams.get("date")) || parseDateOnly(formatDateOnly(new Date())) || new Date();
  const { start, end } = periodRange(period, refDate);
  const previousStart = shiftYearsUTC(start, -1);
  const previousEnd = shiftYearsUTC(end, -1);

  const [currency, rows] = await Promise.all([
    resolveDefaultCurrency(),
    supabase("billing_invoices", {
      query: `select=issue_date,total&account_id=eq.${encodeFilter(accountId)}&status=in.(${REVENUE_STATUSES.join(",")})&issue_date=gte.${encodeFilter(formatDateOnly(previousStart))}&issue_date=lte.${encodeFilter(formatDateOnly(end))}`,
    }),
  ]);

  const rangeStart = formatDateOnly(start);
  const rangeEnd = formatDateOnly(end);
  const previousRangeStart = formatDateOnly(previousStart);
  const previousRangeEnd = formatDateOnly(previousEnd);

  const total = sumInvoiceTotals(rows, rangeStart, rangeEnd);
  const previousYearRows = rows.filter((row: { issue_date: string }) => row.issue_date >= previousRangeStart && row.issue_date <= previousRangeEnd);
  // null (not 0) means "no invoices at all in that period last year" so the
  // frontend can show a soft empty state instead of claiming a 100% drop.
  const previousYearTotal = previousYearRows.length ? sumInvoiceTotals(rows, previousRangeStart, previousRangeEnd) : null;

  return {
    period,
    currency,
    rangeStart,
    rangeEnd,
    total,
    previousYearTotal,
    previousYearRangeStart: previousRangeStart,
    previousYearRangeEnd: previousRangeEnd,
    buckets: bucketizeRevenue(period, start, end, rows),
  };
}

// --- Invoice branding + PDF + send -------------------------------------------
// Reads the same settings keys booking-core.mts writes when the coach saves
// their account/invoice settings (accountInvoiceSettingsJson + business name,
// coach name, contact email), so a generated PDF matches what the in-app
// invoice editor renders. Read-only against the shared settings table, in the
// same spirit as resolveAccountId/resolveDefaultCurrency above.

type InvoiceBranding = {
  businessName: string;
  coachName: string;
  contactEmail: string;
  fromName: string;
  currency: string;
  taxName: string;
  taxNumber: string;
  bankAccount: string;
  businessAddress: string;
  paymentInstructions: string;
  footerText: string;
  // Coach branding (same keys booking-core writes from the Brand settings tab):
  // logo is a data:image/... URL, colours are #rrggbb hex.
  logoDataUrl: string;
  primaryColor: string;
  accentColor: string;
};

async function resolveInvoiceBranding(): Promise<InvoiceBranding> {
  const rows = await supabase("settings", {
    query: `select=key,value&key=in.(${[
      "accountBusinessName",
      "accountCoachName",
      "coachName",
      "accountContactEmail",
      "accountInvoiceSettingsJson",
      "notificationFromName",
      "brandLogoPreview",
      "brandPrimary",
      "brandAccent",
    ].join(",")})`,
  });
  const map = Object.fromEntries(rows.map((row: { key: string; value: string }) => [row.key, row.value]));
  let invoice: Record<string, unknown> = {};
  try {
    invoice = map.accountInvoiceSettingsJson ? JSON.parse(map.accountInvoiceSettingsJson) : {};
  } catch {
    invoice = {};
  }
  const businessName =
    cleanString(map.accountBusinessName, "", 140) ||
    cleanString(map.coachName, "", 140) ||
    env("CLARITY_BUSINESS_NAME", "Sam Hale Golf");
  const coachName = cleanString(map.accountCoachName, "", 140) || cleanString(map.coachName, "", 140) || businessName;
  return {
    businessName,
    coachName,
    contactEmail: cleanString(map.accountContactEmail, "", 180),
    fromName: cleanString(map.notificationFromName, "", 140) || coachName || businessName,
    currency: cleanString(invoice.currency, "NZD", 10),
    taxName: cleanString(invoice.taxName, "GST", 40),
    taxNumber: cleanString(invoice.taxNumber, "", 60),
    bankAccount: cleanString(invoice.bankAccount, "", 120),
    businessAddress: cleanString(invoice.businessAddress, "", 300),
    paymentInstructions: cleanString(invoice.paymentInstructions, "", 600),
    footerText: cleanString(invoice.footerText, "", 600),
    logoDataUrl: typeof map.brandLogoPreview === "string" && map.brandLogoPreview.startsWith("data:image/") ? map.brandLogoPreview : "",
    primaryColor: cleanHexColor(map.brandPrimary, "#1fd36d"),
    accentColor: cleanHexColor(map.brandAccent, "#111318"),
  };
}

// Parse a #rgb / #rrggbb string; fall back if malformed. Keeps a bad colour
// value in settings from ever throwing while rendering an invoice.
function cleanHexColor(value: unknown, fallback: string) {
  const raw = String(value ?? "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`.toLowerCase();
  }
  return fallback;
}

function hexToRgb(hex: string) {
  const clean = cleanHexColor(hex, "#111318").slice(1);
  return rgb(
    parseInt(clean.slice(0, 2), 16) / 255,
    parseInt(clean.slice(2, 4), 16) / 255,
    parseInt(clean.slice(4, 6), 16) / 255,
  );
}

// Relative luminance (WCAG). Used to avoid painting near-white brand colours as
// text/rules on the white PDF where they'd be invisible.
function colorLuminance(hex: string) {
  const clean = cleanHexColor(hex, "#111318").slice(1);
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = channel(parseInt(clean.slice(0, 2), 16));
  const g = channel(parseInt(clean.slice(2, 4), 16));
  const b = channel(parseInt(clean.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Explicit shape of the API invoice object (invoiceRowToApi returns the same
// structure but with unknown-typed fields, since it reads Supabase rows). The
// PDF/send helpers below want concrete string/number types, so getInvoiceWithItems
// casts to this and everything downstream stays type-safe.
interface InvoiceApi {
  id: string;
  invoiceNumber: string;
  status: string;
  customerId: string | null;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  subtotal: number;
  taxTotal: number;
  taxInclusive: boolean;
  discountTotal: number;
  discountLabel: string;
  total: number;
  amountPaid: number;
  customerNote: string;
  internalNote: string;
  reference: string;
  sentAt: string | null;
  paidAt: string | null;
  createdAt: unknown;
  updatedAt: unknown;
  items: Array<{
    id: string;
    sourceType: string;
    sourceId: string | null;
    description: string;
    quantity: number;
    unitPrice: number;
    taxRate: number;
    taxAmount: number;
    discountAmount: number;
    lineTotal: number;
  }>;
}

// Wrap a string to a pixel width for the current font/size, breaking on spaces
// (and hard-splitting any single word too long to fit). Keeps the line-item
// descriptions and free-text notes inside their columns instead of overrunning.
function wrapText(
  text: string,
  font: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  size: number,
  maxWidth: number,
): string[] {
  const words = String(text ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return [""];
  const lines: string[] = [];
  let current = "";
  const widthOf = (value: string) => font.widthOfTextAtSize(value, size);
  for (const word of words) {
    let candidate = current ? `${current} ${word}` : word;
    if (widthOf(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
      current = "";
    }
    // Single word longer than the column: hard-split it.
    let chunk = word;
    while (widthOf(chunk) > maxWidth && chunk.length > 1) {
      let cut = chunk.length - 1;
      while (cut > 1 && widthOf(chunk.slice(0, cut)) > maxWidth) cut -= 1;
      lines.push(chunk.slice(0, cut));
      chunk = chunk.slice(cut);
    }
    current = chunk;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

// Embed the coach logo (a data:image/png|jpeg URL from Brand settings). Returns
// null on anything unexpected - a malformed or unsupported logo must never break
// invoice rendering, it just falls back to the text wordmark.
async function embedLogo(pdf: PDFDocument, dataUrl: string) {
  const match = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(dataUrl || "");
  if (!match) return null;
  try {
    const bytes = Buffer.from(match[2], "base64");
    return /png/i.test(match[1]) ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
  } catch {
    return null;
  }
}

export async function renderInvoicePdf(invoice: InvoiceApi, branding: InvoiceBranding): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 595.28; // A4 portrait, points
  const pageHeight = 841.89;
  const margin = 50;
  const contentRight = pageWidth - margin;
  const currency = invoice.currency || branding.currency;

  const ink = rgb(0.11, 0.13, 0.16);
  const muted = rgb(0.42, 0.45, 0.5);
  const hair = rgb(0.82, 0.84, 0.87);
  // Coach brand accent. The primary colour is used for the wordmark, the header
  // rule and the Total line - but only if it's dark enough to read on white;
  // otherwise we fall back to the (dark) accent colour so nothing goes invisible.
  const brandReadable = colorLuminance(branding.primaryColor) < 0.72;
  const brand = brandReadable ? hexToRgb(branding.primaryColor) : hexToRgb(branding.accentColor);

  const logo = await embedLogo(pdf, branding.logoDataUrl);
  let logoW = 0;
  let logoH = 0;
  if (logo) {
    const scale = Math.min(44 / logo.height, 150 / logo.width, 1);
    logoW = logo.width * scale;
    logoH = logo.height * scale;
  }

  let page = pdf.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const text = (value: unknown, x: number, yy: number, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb> } = {}) => {
    page.drawText(String(value ?? ""), { x, y: yy, size: opts.size ?? 10, font: opts.bold ? bold : font, color: opts.color ?? ink });
  };
  const textRight = (value: string, xRight: number, yy: number, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb> } = {}) => {
    const size = opts.size ?? 10;
    const usedFont = opts.bold ? bold : font;
    const width = usedFont.widthOfTextAtSize(String(value ?? ""), size);
    text(value, xRight - width, yy, opts);
  };
  const hrule = (yy: number) => {
    page.drawLine({ start: { x: margin, y: yy }, end: { x: contentRight, y: yy }, thickness: 1, color: hair });
  };
  const ensureSpace = (needed: number) => {
    if (y - needed >= margin) return;
    page = pdf.addPage([pageWidth, pageHeight]);
    y = pageHeight - margin;
  };

  // Header: logo + business name (left), INVOICE wordmark (right).
  const headerTop = y;
  if (logo) {
    page.drawImage(logo, { x: margin, y: headerTop - logoH, width: logoW, height: logoH });
  }
  const nameX = logo ? margin + logoW + 12 : margin;
  const nameY = logo ? headerTop - logoH / 2 - 6 : headerTop - 4;
  text(branding.businessName, nameX, nameY, { size: 16, bold: true });
  textRight("INVOICE", contentRight, headerTop - 4, { size: 18, bold: true, color: brand });
  y = headerTop - Math.max(logoH, 22) - 8;
  const brandLines = [
    branding.businessAddress,
    branding.contactEmail,
    branding.taxNumber ? `${branding.taxName} No: ${branding.taxNumber}` : "",
  ].filter(Boolean);
  const metaLines = [
    `Invoice #: ${invoice.invoiceNumber}`,
    `Issued: ${invoice.issueDate || ""}`,
    invoice.dueDate ? `Due: ${invoice.dueDate}` : "",
    `Status: ${String(invoice.status || "").toUpperCase()}`,
  ].filter(Boolean);
  const headerRows = Math.max(brandLines.length, metaLines.length);
  for (let i = 0; i < headerRows; i += 1) {
    if (brandLines[i]) text(brandLines[i], margin, y, { size: 9, color: muted });
    if (metaLines[i]) textRight(metaLines[i], contentRight, y, { size: 9, color: muted });
    y -= 13;
  }
  y -= 6;
  page.drawLine({ start: { x: margin, y }, end: { x: contentRight, y }, thickness: 1.6, color: brand });
  y -= 22;

  // Bill to.
  text("BILL TO", margin, y, { size: 8, bold: true, color: muted });
  y -= 14;
  text(invoice.customerName || "-", margin, y, { size: 11, bold: true });
  y -= 14;
  for (const contact of [invoice.customerEmail, invoice.customerPhone, invoice.reference ? `Ref: ${invoice.reference}` : ""].filter(Boolean)) {
    text(contact, margin, y, { size: 9, color: muted });
    y -= 12;
  }
  y -= 10;

  // Line-item table.
  const colQtyRight = margin + 320;
  const colUnitRight = margin + 410;
  const descWidth = colQtyRight - margin - 60;
  text("DESCRIPTION", margin, y, { size: 8, bold: true, color: muted });
  textRight("QTY", colQtyRight, y, { size: 8, bold: true, color: muted });
  textRight("UNIT", colUnitRight, y, { size: 8, bold: true, color: muted });
  textRight("AMOUNT", contentRight, y, { size: 8, bold: true, color: muted });
  y -= 8;
  hrule(y);
  y -= 16;

  for (const item of invoice.items) {
    const descLines = wrapText(item.description || "-", font, 10, descWidth);
    ensureSpace(descLines.length * 13 + 6);
    descLines.forEach((lineText, index) => {
      text(lineText, margin, y - index * 13, { size: 10 });
    });
    const lineAmount = (Number(item.quantity) || 0) * (Number(item.unitPrice) || 0) - (Number(item.discountAmount) || 0);
    textRight(String(item.quantity), colQtyRight, y, { size: 10 });
    textRight((Number(item.unitPrice) || 0).toFixed(2), colUnitRight, y, { size: 10 });
    textRight((lineAmount < 0 ? 0 : lineAmount).toFixed(2), contentRight, y, { size: 10 });
    y -= descLines.length * 13 + 6;
  }

  y -= 4;
  hrule(y);
  y -= 20;

  // Totals block (right-aligned key/value rows).
  const totalRow = (label: string, value: string, opts: { bold?: boolean; size?: number; color?: ReturnType<typeof rgb> } = {}) => {
    ensureSpace(18);
    const size = opts.size ?? 10;
    textRight(label, contentRight - 110, y, { size, bold: opts.bold, color: opts.color ?? (opts.bold ? ink : muted) });
    textRight(value, contentRight, y, { size, bold: opts.bold, color: opts.color ?? ink });
    y -= opts.bold ? 20 : 16;
  };
  totalRow("Subtotal", formatMoney(invoice.subtotal, currency));
  if ((Number(invoice.discountTotal) || 0) > 0) {
    totalRow(invoice.discountLabel || "Discount", `- ${formatMoney(invoice.discountTotal, currency)}`);
  }
  // Exclusive tax is a line added before the total; inclusive tax is shown as a
  // note under the total (it's already inside the prices).
  if (!invoice.taxInclusive && (Number(invoice.taxTotal) || 0) > 0) {
    totalRow(branding.taxName || "Tax", formatMoney(invoice.taxTotal, currency));
  }
  totalRow("Total", formatMoney(invoice.total, currency), { bold: true, size: 12, color: brand });
  if (invoice.taxInclusive && (Number(invoice.taxTotal) || 0) > 0) {
    totalRow(`Includes ${branding.taxName || "Tax"}`, formatMoney(invoice.taxTotal, currency));
  }
  if ((Number(invoice.amountPaid) || 0) > 0) {
    totalRow("Paid", `- ${formatMoney(invoice.amountPaid, currency)}`);
    totalRow("Balance due", formatMoney(round2((Number(invoice.total) || 0) - (Number(invoice.amountPaid) || 0)), currency), { bold: true });
  }

  // Notes / payment instructions / footer.
  const noteBlocks: Array<{ heading: string; body: string }> = [];
  if (invoice.customerNote) noteBlocks.push({ heading: "Notes", body: invoice.customerNote });
  const paymentBody = [branding.paymentInstructions, branding.bankAccount ? `Bank account: ${branding.bankAccount}` : ""].filter(Boolean).join("\n");
  if (paymentBody) noteBlocks.push({ heading: "Payment", body: paymentBody });
  if (branding.footerText) noteBlocks.push({ heading: "", body: branding.footerText });

  if (noteBlocks.length) {
    y -= 10;
    ensureSpace(20);
    hrule(y);
    y -= 20;
    for (const block of noteBlocks) {
      if (block.heading) {
        ensureSpace(16);
        text(block.heading.toUpperCase(), margin, y, { size: 8, bold: true, color: muted });
        y -= 14;
      }
      for (const rawLine of block.body.split("\n")) {
        for (const wrapped of wrapText(rawLine, font, 9, contentRight - margin)) {
          ensureSpace(13);
          text(wrapped, margin, y, { size: 9, color: muted });
          y -= 12;
        }
      }
      y -= 8;
    }
  }

  return pdf.save();
}

// Self-contained Resend sender (billing stays isolated from booking/notification
// code by design - see this file's header). Mirrors notification-engine.mts's
// from-header handling and adds the invoice PDF as a base64 attachment.
function invoiceEmailFrom(branding: InvoiceBranding) {
  const rawFrom = env("CLARITY_EMAIL_FROM", `${branding.businessName} <onboarding@resend.dev>`);
  if (/<[^>]+>/.test(rawFrom)) return rawFrom; // env already supplies a "Name <addr>" header
  return `${branding.fromName || branding.businessName} <${rawFrom}>`;
}

async function emailInvoicePdf(
  opts: { to: string; subject: string; text: string; html: string; replyTo?: string; pdf: Uint8Array; filename: string; idempotencyKey: string },
  branding: InvoiceBranding,
) {
  const apiKey = env("RESEND_API_KEY");
  if (!apiKey) {
    throw Object.assign(new Error("Email sending is not configured (missing RESEND_API_KEY)."), {
      status: 503,
      code: "EMAIL_NOT_CONFIGURED",
    });
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": opts.idempotencyKey,
    },
    body: JSON.stringify({
      from: invoiceEmailFrom(branding),
      to: [opts.to],
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
      ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
      attachments: [{ filename: opts.filename, content: Buffer.from(opts.pdf).toString("base64") }],
    }),
  });
  const responseText = await response.text().catch(() => "");
  if (!response.ok) {
    throw Object.assign(new Error(`Email send failed (${response.status}): ${responseText.slice(0, 300)}`), {
      status: 502,
      code: "EMAIL_SEND_FAILED",
    });
  }
  try {
    return { id: (responseText ? JSON.parse(responseText)?.id : "") || "" };
  } catch {
    return { id: "" };
  }
}

function pdfFilename(invoice: InvoiceApi) {
  return `${String(invoice.invoiceNumber || "invoice").replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;
}

async function sendInvoice(accountId: string, id: string, body: Record<string, unknown>) {
  const invoice = await getInvoiceWithItems(accountId, id);
  if (!invoice) throw Object.assign(new Error("Invoice not found."), { status: 404 });
  const to = cleanString(body?.email, "", 180) || cleanString(invoice.customerEmail, "", 180);
  if (!to) {
    throw Object.assign(new Error("This invoice has no customer email to send to."), { status: 400, code: "MISSING_RECIPIENT" });
  }

  const branding = await resolveInvoiceBranding();
  const pdf = await renderInvoicePdf(invoice, branding);
  const subject = `Invoice ${invoice.invoiceNumber} from ${branding.businessName}`;
  const bodyLines = [
    `Hi ${invoice.customerName || "there"},`,
    "",
    `Please find attached invoice ${invoice.invoiceNumber} for ${formatMoney(invoice.total, invoice.currency)}.`,
    invoice.dueDate ? `Due: ${invoice.dueDate}` : "",
    branding.paymentInstructions,
    branding.bankAccount ? `Bank account: ${branding.bankAccount}` : "",
    "",
    "Thanks,",
    branding.businessName,
  ].filter((line) => line !== undefined && line !== null) as string[];
  const plain = bodyLines.filter(Boolean).join("\n");
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1a1c1f">` +
    bodyLines.map((line) => (line === "" ? "<br/>" : `<p style="margin:0 0 8px">${escapeHtml(line)}</p>`)).join("") +
    `</div>`;

  const emailResult = await emailInvoicePdf(
    {
      to,
      subject,
      text: plain,
      html,
      replyTo: branding.contactEmail || undefined,
      pdf,
      filename: pdfFilename(invoice),
      idempotencyKey: `invoice-send-${id}-${Date.now()}`,
    },
    branding,
  );

  // Advance to "sent" only from draft/sent - never drag a paid/void invoice
  // backwards just because a copy was re-emailed.
  await supabase("billing_invoices", {
    method: "PATCH",
    query: `id=eq.${encodeFilter(id)}&account_id=eq.${encodeFilter(accountId)}&status=in.(draft,sent)`,
    body: { status: "sent", sent_at: nowIso(), updated_at: nowIso() },
    prefer: "return=minimal",
  });

  return { invoice: await getInvoiceWithItems(accountId, id), emailed: true, emailId: emailResult.id, recipient: to };
}

async function invoicePdfResponse(accountId: string, id: string) {
  const invoice = await getInvoiceWithItems(accountId, id);
  if (!invoice) return json({ error: "not_found", message: "Invoice not found." }, 404);
  const branding = await resolveInvoiceBranding();
  const pdf = await renderInvoicePdf(invoice, branding);
  return new Response(Buffer.from(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${pdfFilename(invoice)}"`,
      "Cache-Control": "no-store",
    },
  });
}

// --- Router ------------------------------------------------------------------

export default async function handler(req: Request) {
  const url = new URL(req.url);
  const action = url.pathname.replace(/^\/api\/billing\/?/, "").replace(/\/$/, "");

  try {
    if (!(await requireAdmin(req))) return json({ error: "unauthorized", message: "Admin login required." }, 401);
    const accountId = await resolveAccountId();

    if (action === "products" && req.method === "GET") return json(await listProducts(accountId));
    if (action === "products" && req.method === "POST") return json(await createProduct(accountId, await parseBody(req)));
    if (action.startsWith("products/") && (req.method === "PUT" || req.method === "PATCH")) {
      return json(await updateProduct(accountId, action.slice("products/".length), await parseBody(req)));
    }

    if (action === "discounts" && req.method === "GET") return json(await listDiscounts(accountId));
    if (action === "discounts" && req.method === "POST") return json(await createDiscount(accountId, await parseBody(req)));
    if (action.startsWith("discounts/") && (req.method === "PUT" || req.method === "PATCH")) {
      return json(await updateDiscount(accountId, action.slice("discounts/".length), await parseBody(req)));
    }

    if (action === "expense-categories" && req.method === "GET") return json(await listExpenseCategories(accountId));
    if (action === "expense-categories" && req.method === "POST") {
      return json(await createExpenseCategory(accountId, await parseBody(req)));
    }
    if (action.startsWith("expense-categories/") && (req.method === "PUT" || req.method === "PATCH")) {
      return json(await updateExpenseCategory(accountId, action.slice("expense-categories/".length), await parseBody(req)));
    }

    if (action === "expenses" && req.method === "GET") return json(await listExpenses(accountId, url));
    if (action === "expenses" && req.method === "POST") return json(await createExpense(accountId, await parseBody(req)), 201);
    if (action === "expenses/import" && req.method === "POST") return json(await importExpenses(accountId, await parseBody(req)));
    if (action.startsWith("expenses/") && (req.method === "PUT" || req.method === "PATCH")) {
      return json(await updateExpense(accountId, action.slice("expenses/".length), await parseBody(req)));
    }

    if (action === "invoices" && req.method === "GET") return json(await listInvoices(accountId, url));
    if (action === "invoices" && req.method === "POST") return json(await createInvoice(accountId, await parseBody(req)), 201);
    // Sub-actions (.../send, .../pdf) must be matched before the generic
    // invoices/:id handlers, which would otherwise treat "id/send" as the id.
    if (action.startsWith("invoices/") && action.endsWith("/send") && req.method === "POST") {
      const invoiceId = action.slice("invoices/".length, -"/send".length);
      return json(await sendInvoice(accountId, invoiceId, await parseBody(req)));
    }
    if (action.startsWith("invoices/") && action.endsWith("/pdf") && req.method === "GET") {
      const invoiceId = action.slice("invoices/".length, -"/pdf".length);
      return await invoicePdfResponse(accountId, invoiceId);
    }
    if (action.startsWith("invoices/") && req.method === "GET") {
      const invoice = await getInvoiceWithItems(accountId, action.slice("invoices/".length));
      if (!invoice) return json({ error: "not_found", message: "Invoice not found." }, 404);
      return json({ invoice });
    }
    // PUT edits a draft's contents; PATCH changes only its status.
    if (action.startsWith("invoices/") && req.method === "PUT") {
      const invoice = await updateInvoiceDraft(accountId, action.slice("invoices/".length), await parseBody(req));
      return json({ invoice });
    }
    if (action.startsWith("invoices/") && req.method === "PATCH") {
      const invoice = await updateInvoiceStatus(accountId, action.slice("invoices/".length), await parseBody(req));
      return json({ invoice });
    }

    if (action === "booking-links" && req.method === "GET") {
      const ids = (url.searchParams.get("bookingIds") || "").split(",").map((id) => id.trim()).filter(Boolean);
      return json(await checkBookingLinks(accountId, ids));
    }

    if (action === "reports/revenue" && req.method === "GET") return json(await revenueReport(accountId, url));

    return json({ error: "not_found", message: "Billing route not found." }, 404);
  } catch (error) {
    console.error("billing_api:failed", action, error);
    const status = Number((error as { status?: unknown })?.status);
    const httpStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
    return json(
      {
        error: (error as { code?: string })?.code || "billing_api_error",
        message: error instanceof Error ? error.message : "Billing request failed.",
      },
      httpStatus,
    );
  }
}

export const config: Config = {
  path: "/api/billing/*",
};
