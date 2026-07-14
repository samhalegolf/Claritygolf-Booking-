import type { Config } from "@netlify/functions";
import { createHash, randomUUID } from "node:crypto";
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

function cleanInvoiceItem(raw: InvoiceItemInput) {
  const sourceType = ["booking", "product", "manual"].includes(String(raw?.sourceType)) ? String(raw.sourceType) : "manual";
  const quantity = cleanNumber(raw?.quantity, 1, { min: 0 });
  const unitPrice = round2(cleanNumber(raw?.unitPrice, 0, { min: 0 }));
  const taxRate = round2(cleanNumber(raw?.taxRate, 0, { min: 0, max: 100 }));
  const discountAmount = round2(cleanNumber(raw?.discountAmount, 0, { min: 0 }));
  const lineSubtotal = Math.max(0, round2(quantity * unitPrice) - discountAmount);
  const taxAmount = round2(lineSubtotal * (taxRate / 100));
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
    line_total: round2(lineSubtotal + taxAmount),
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
  return invoiceRowToApi(row, items);
}

async function createBookingLinks(accountId: string, invoiceId: string, bookingIds: string[]) {
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
      // At least one booking already has an invoice. Roll back the invoice
      // we just created so a failed pull doesn't leave an orphaned draft,
      // then surface which bookings were already invoiced.
      await supabase("billing_invoices", {
        method: "DELETE",
        query: `id=eq.${encodeFilter(invoiceId)}&account_id=eq.${encodeFilter(accountId)}`,
      }).catch(() => {});
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

  const itemsInput = Array.isArray(body?.items) ? (body.items as InvoiceItemInput[]) : [];
  const items = itemsInput.map(cleanInvoiceItem).filter((item) => item.description && item.quantity > 0);
  if (!items.length) throw Object.assign(new Error("Add at least one invoice line."), { status: 400 });

  const subtotal = round2(items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0));
  const discountTotal = round2(Math.min(subtotal, cleanNumber(body?.discountAmount, 0, { min: 0 })));
  const taxTotal = round2(items.reduce((sum, item) => sum + item.tax_amount, 0));
  const total = round2(Math.max(0, subtotal - discountTotal) + taxTotal);

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
    if (action.startsWith("invoices/") && req.method === "GET") {
      const invoice = await getInvoiceWithItems(accountId, action.slice("invoices/".length));
      if (!invoice) return json({ error: "not_found", message: "Invoice not found." }, 404);
      return json({ invoice });
    }
    if (action.startsWith("invoices/") && (req.method === "PATCH" || req.method === "PUT")) {
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
