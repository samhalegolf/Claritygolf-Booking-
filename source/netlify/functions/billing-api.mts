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
// billing_products_services holds PRODUCTS: things with a shelf, a supplier and
// a price. Services and packages are not stored here at all - they are the
// coach's lesson types, read from the servicesJson setting by lessonTypeItems()
// below and merged into the catalog on the way out.
//
// That split is the whole point. A lesson price used to exist in two places
// (the lesson type and a catalog row), which is how the account ended up with
// nine "Golf Coaching" rows at nine different prices. Now the lesson type is
// the only place a lesson price is written.
//
// Stock is only ever changed through adjustProductStock() or a POS sale, never
// by the plain product save - otherwise two tills editing a product at the same
// time would each write back the level they happened to load.

function cleanProductPayload(raw: Record<string, unknown>) {
  return {
    name: cleanString(raw?.name, "", 140),
    // Only products live in this table. A service or package arriving here
    // would be a second copy of a lesson type, which is exactly what was
    // removed - so the kind is not taken from the request at all.
    kind: "product",
    description: cleanString(raw?.description, "", 600) || null,
    default_price: round2(cleanNumber(raw?.price ?? raw?.defaultPrice, 0, { min: 0 })),
    tax_rate: round2(cleanNumber(raw?.taxRate, 0, { min: 0, max: 100 })),
    active: raw?.active !== false,
    supplier: cleanString(raw?.supplier, "", 140) || null,
    // Stored as typed but compared case-insensitively by the unique index, so
    // "gl-01" and "GL-01" can't both exist.
    sku: cleanString(raw?.sku, "", 60) || null,
    cost_price: round2(cleanNumber(raw?.costPrice, 0, { min: 0 })),
    // Off for a fitting fee or a gift voucher: sold, but never on a shelf.
    track_stock: raw?.trackStock !== false,
    low_stock_threshold: Math.round(cleanNumber(raw?.lowStockThreshold, 0, { min: 0, max: 1e6 })),
    // Selling one of these issues a coupon rather than just taking money.
    is_voucher: raw?.isVoucher === true,
  };
}

function productRowToApi(row: Record<string, unknown>) {
  const trackStock = row.track_stock === true;
  const stockLevel = Number(row.stock_level) || 0;
  const lowStockThreshold = Number(row.low_stock_threshold) || 0;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    description: row.description || "",
    price: Number(row.default_price) || 0,
    taxRate: Number(row.tax_rate) || 0,
    active: row.active !== false,
    supplier: row.supplier || "",
    sku: row.sku || "",
    costPrice: Number(row.cost_price) || 0,
    trackStock,
    stockLevel,
    lowStockThreshold,
    // Derived here rather than in the UI so the list, the checkout picker and
    // any future reorder report all agree on what "low" means. A threshold of
    // 0 means "don't warn me", so only out-of-stock counts.
    lowStock: trackStock && (stockLevel <= 0 || (lowStockThreshold > 0 && stockLevel <= lowStockThreshold)),
    isVoucher: row.is_voucher === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// The unique SKU index is the only conflict these writes can hit.
function rethrowProductConflict(error: unknown, sku: string | null): never {
  if ((error as { supabaseStatus?: number })?.supabaseStatus === 409 && sku) {
    throw Object.assign(new Error(`SKU "${sku}" is already used by another product.`), {
      status: 409,
      code: "PRODUCT_SKU_EXISTS",
    });
  }
  throw error;
}

// --- Lesson types are the services ------------------------------------------
// Read-only against the same settings key booking-core.mts writes when a coach
// saves a lesson type. Billing never writes it: a lesson price is changed in
// one place, on the lesson type itself.

// Catalog ids for lesson types are prefixed so the till can tell at a glance
// whether an id names a row in the products table or a lesson type. Nothing
// else in the system produces an id starting "lesson:".
const LESSON_ITEM_PREFIX = "lesson:";

// What one booking of this lesson type costs, which is not always `price`.
//
// A custom group charges basePrice for the base head count and extraPersonPrice
// per head above it, and the editor writes those fields without touching
// `price` - so the two drift apart the moment a base price is edited. Selling
// the base price at the counter is the honest floor; the per-head part is a
// counter override, the same as any other.
//
// A per-person lesson type prices per head, so `price` is right but the number
// on its own is misleading. It is labelled rather than multiplied: the till has
// no idea how many people turned up.
function lessonTypeUnitPrice(service: Record<string, unknown>) {
  const customGroup = service.customGroup === true || service.customGroupEnabled === true;
  const raw = customGroup ? (service.basePrice ?? service.price) : service.price;
  return round2(cleanNumber(raw, 0, { min: 0 }));
}

function lessonTypePriceNote(service: Record<string, unknown>) {
  if (service.customGroup === true || service.customGroupEnabled === true) {
    const base = Math.max(1, Math.round(cleanNumber(service.baseParticipants, 3, { min: 1, max: 50 })));
    const extra = round2(cleanNumber(service.extraPersonPrice, 0, { min: 0 }));
    return extra > 0 ? `Up to ${base} people, then ${extra} each` : `Up to ${base} people`;
  }
  if (String(service.priceMode || "") === "per-person") return "Price is per person";
  return "";
}

function lessonTypeToCatalogItem(service: Record<string, unknown>, taxRate: number) {
  const format = String(service.lessonFormat || "");
  const priceNote = lessonTypePriceNote(service);
  return {
    id: `${LESSON_ITEM_PREFIX}${String(service.id ?? "")}`,
    // The invoice line records the bare lesson-type id, the way it always has.
    sourceServiceId: String(service.id ?? ""),
    name: String(service.name ?? ""),
    // A package of lessons is still a package on the docket; everything else a
    // coach teaches is a service.
    kind: format === "package" ? "package" : "service",
    description: [priceNote, cleanString(service.description || service.lessonNote || service.location, "", 500)]
      .filter(Boolean)
      .join(" - "),
    price: lessonTypeUnitPrice(service),
    taxRate,
    active: true,
    // A lesson has no shelf, no supplier and no barcode. These are here so the
    // shape matches a product row and the UI needs no special case.
    supplier: "",
    sku: "",
    costPrice: 0,
    trackStock: false,
    stockLevel: 0,
    lowStockThreshold: 0,
    lowStock: false,
    isVoucher: false,
    // Tells the Products screen to list it without an edit link - a lesson
    // type is changed under Settings, not here.
    readOnly: true,
  };
}

async function lessonTypeItems(taxRate: number) {
  const rows = await supabase("settings", {
    query: `select=value&key=eq.${encodeFilter("servicesJson")}&limit=1`,
  });
  let parsed: unknown = null;
  try {
    parsed = rows[0]?.value ? JSON.parse(rows[0].value) : null;
  } catch {
    // A corrupt setting must not take the till down - better an empty lesson
    // list than a 500 on every catalog read.
    console.error("billing_api:services_json_unparseable");
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((service): service is Record<string, unknown> => Boolean(service) && typeof service === "object")
    .filter((service) => service.active !== false && service.archived !== true)
    .map((service) => lessonTypeToCatalogItem(service, taxRate))
    .filter((item) => item.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function listProducts(accountId: string) {
  const [rows, tax] = await Promise.all([
    supabase("billing_products_services", {
      query: `select=*&account_id=eq.${encodeFilter(accountId)}&order=active.desc,name.asc`,
    }),
    resolveReportTaxConfig(),
  ]);
  const lessons = await lessonTypeItems(tax.taxRate);
  return { products: [...rows.map(productRowToApi), ...lessons] };
}

async function getProductRow(accountId: string, id: string) {
  const rows = await supabase("billing_products_services", {
    query: `select=*&id=eq.${encodeFilter(id)}&account_id=eq.${encodeFilter(accountId)}&limit=1`,
  });
  return rows.length ? (rows[0] as Record<string, unknown>) : null;
}

async function createProduct(accountId: string, body: Record<string, unknown>) {
  const clean = cleanProductPayload(body);
  if (!clean.name) throw Object.assign(new Error("Product name is required."), { status: 400 });
  // Opening stock is allowed here because nothing else can have touched the row
  // yet. Every later change goes through adjustProductStock().
  const openingStock = clean.track_stock ? Math.round(cleanNumber(body?.stockLevel, 0, { min: -1e6, max: 1e6 })) : 0;
  const row = {
    id: randomUUID(),
    account_id: accountId,
    ...clean,
    stock_level: openingStock,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  try {
    await supabase("billing_products_services", { method: "POST", body: [row], prefer: "return=minimal" });
  } catch (error) {
    rethrowProductConflict(error, clean.sku);
  }
  if (openingStock !== 0) {
    await writeStockMovement(accountId, String(row.id), {
      delta: openingStock,
      resultingLevel: openingStock,
      kind: "receipt",
      note: "Opening stock",
    });
  }
  return { product: productRowToApi(row) };
}

async function updateProduct(accountId: string, id: string, body: Record<string, unknown>) {
  const clean = cleanProductPayload(body);
  if (!clean.name) throw Object.assign(new Error("Product name is required."), { status: 400 });
  // Note the absence of stock_level: a product save must not be able to undo a
  // sale that landed while the form was open.
  const patch = { ...clean, updated_at: nowIso() };
  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = await supabase("billing_products_services", {
      method: "PATCH",
      query: `id=eq.${encodeFilter(id)}&account_id=eq.${encodeFilter(accountId)}`,
      body: patch,
      prefer: "return=representation",
    });
  } catch (error) {
    rethrowProductConflict(error, clean.sku);
  }
  if (!rows.length) throw Object.assign(new Error("Product not found."), { status: 404 });
  return { product: productRowToApi(rows[0]) };
}

// --- Stock ------------------------------------------------------------------

type StockMovementKind = "adjustment" | "stocktake" | "receipt" | "sale" | "sale_reversal";

async function writeStockMovement(
  accountId: string,
  productId: string,
  entry: {
    delta: number;
    resultingLevel: number | null;
    kind: StockMovementKind;
    note?: string;
    posTransactionId?: string;
  },
) {
  await supabase("billing_stock_movements", {
    method: "POST",
    prefer: "return=minimal",
    body: [
      {
        id: randomUUID(),
        account_id: accountId,
        product_id: productId,
        delta: entry.delta,
        resulting_level: entry.resultingLevel,
        kind: entry.kind,
        pos_transaction_id: entry.posTransactionId || null,
        note: cleanString(entry.note, "", 300) || null,
        created_at: nowIso(),
      },
    ],
  });
}

// Adds delta to the level inside a single UPDATE (see billing_adjust_stock in
// products-stock-schema.sql) and returns the new level. Returns null when the
// product doesn't exist, isn't ours, or doesn't track stock.
async function adjustStockLevel(accountId: string, productId: string, delta: number) {
  if (!delta) return null;
  const result = await supabase("rpc/billing_adjust_stock", {
    method: "POST",
    body: { p_account_id: accountId, p_product_id: productId, p_delta: delta },
  });
  const level = Array.isArray(result) ? result[0] : result;
  return level === null || level === undefined ? null : Number(level);
}

// Manual stock change from the Products tab: either a relative delta ("+6
// arrived") or an absolute count ("the shelf says 4"). A stocktake is sent as
// setTo so the ledger records the correction, not the number typed.
async function adjustProductStock(accountId: string, id: string, body: Record<string, unknown>) {
  const product = await getProductRow(accountId, id);
  if (!product) throw Object.assign(new Error("Product not found."), { status: 404 });
  if (product.track_stock !== true) {
    throw Object.assign(new Error(`${product.name} does not track stock.`), { status: 400 });
  }

  const hasSetTo = body?.setTo !== undefined && body?.setTo !== null && body?.setTo !== "";
  const current = Number(product.stock_level) || 0;
  const delta = hasSetTo
    ? Math.round(cleanNumber(body?.setTo, current, { min: -1e6, max: 1e6 })) - current
    : Math.round(cleanNumber(body?.delta, 0, { min: -1e6, max: 1e6 }));

  if (!delta) {
    return { product: productRowToApi(product), movement: null };
  }

  const resultingLevel = await adjustStockLevel(accountId, id, delta);
  const kind: StockMovementKind = hasSetTo ? "stocktake" : delta > 0 ? "receipt" : "adjustment";
  await writeStockMovement(accountId, id, {
    delta,
    resultingLevel,
    kind,
    note: cleanString(body?.note, "", 300),
  });

  const updated = await getProductRow(accountId, id);
  return { product: productRowToApi(updated || { ...product, stock_level: resultingLevel }) };
}

async function listStockMovements(accountId: string, id: string, url: URL) {
  const limit = Math.max(1, Math.min(200, cleanNumber(url.searchParams.get("limit"), 50)));
  const rows = await supabase("billing_stock_movements", {
    query:
      `select=*&account_id=eq.${encodeFilter(accountId)}&product_id=eq.${encodeFilter(id)}` +
      `&order=created_at.desc&limit=${limit}`,
  });
  return {
    movements: (rows as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id ?? ""),
      productId: String(row.product_id ?? ""),
      delta: Number(row.delta) || 0,
      resultingLevel: row.resulting_level === null || row.resulting_level === undefined ? null : Number(row.resulting_level),
      kind: String(row.kind ?? "adjustment"),
      posTransactionId: String(row.pos_transaction_id ?? ""),
      note: String(row.note ?? ""),
      createdAt: String(row.created_at ?? ""),
    })),
  };
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

// Invoice numbering is derived from the highest existing number in the same
// series, not a static local counter, so app-created invoices continue on from
// the invoices imported from Stripe (e.g. SHG-0414 -> SHG-0415) and stay aligned
// as more Stripe invoices import. The prefix is sanitised to [A-Z0-9-] so it is
// safe to drop straight into the RegExp below (no metacharacters survive).
function normalizeInvoicePrefix(value: unknown) {
  return cleanString(value, "INV", 12).toUpperCase().replace(/[^A-Z0-9-]/g, "") || "INV";
}

function invoiceSequenceForPrefix(invoiceNumber: string, prefix: string): number | null {
  const match = new RegExp(`^${prefix}-(\\d+)$`).exec(invoiceNumber);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

async function resolveInvoicePrefix() {
  const rows = await supabase("settings", {
    query: `select=value&key=eq.${encodeFilter("accountInvoiceSettingsJson")}&limit=1`,
  });
  try {
    const parsed = rows[0]?.value ? JSON.parse(rows[0].value) : null;
    return normalizeInvoicePrefix(parsed?.prefix);
  } catch {
    return normalizeInvoicePrefix(undefined);
  }
}

// The prefix is an account setting, not a per-request choice. Always read it
// from stored settings so a stale client value (e.g. the default "INV" sent
// before the account finished loading) can't put a new invoice on the wrong
// series. prefixInput is accepted for back-compat but only used if settings
// have no prefix at all.
async function nextInvoiceNumber(accountId: string, prefixInput?: unknown) {
  const storedPrefix = await resolveInvoicePrefix();
  const prefix = storedPrefix || normalizeInvoicePrefix(prefixInput);
  // Pull just the numbers already used for this prefix and compute the max in JS.
  // Charges (ORD-###) and un-numbered Stripe rows (in_…) use other prefixes and
  // are excluded both by the like filter and the exact ^PREFIX-<digits>$ match.
  // Max computed in code (not via lexical ORDER BY) so 5-digit sequences don't
  // lose to zero-padded 4-digit ones.
  const rows = (await supabase("billing_invoices", {
    query:
      `select=invoice_number&account_id=eq.${encodeFilter(accountId)}` +
      `&invoice_number=like.${encodeFilter(`${prefix}-*`)}&limit=100000`,
  })) as Array<{ invoice_number?: string }>;
  let highest = 0;
  for (const row of rows) {
    const sequence = invoiceSequenceForPrefix(cleanString(row?.invoice_number, "", 60), prefix);
    if (sequence !== null && sequence > highest) highest = sequence;
  }
  const sequence = highest + 1;
  // Keep the 4-digit zero padding the Stripe series uses (SHG-0415); sequences
  // >= 10000 render at their natural width.
  return { prefix, sequence, invoiceNumber: `${prefix}-${String(sequence).padStart(4, "0")}` };
}

async function createInvoice(accountId: string, body: Record<string, unknown>) {
  const autoNumber = body?.autoNumber === true;
  // autoNumber => server assigns the next number in the series (the aligned
  // path). Otherwise honour an explicit client-supplied number.
  let invoiceNumber = autoNumber
    ? (await nextInvoiceNumber(accountId, body?.invoicePrefix)).invoiceNumber
    : cleanString(body?.invoiceNumber, "", 60);
  const customerName = cleanString(body?.customerName, "", 140);
  if (!invoiceNumber) throw Object.assign(new Error("Invoice number is required."), { status: 400 });
  if (!customerName) throw Object.assign(new Error("Customer is required."), { status: 400 });

  const taxInclusive = body?.taxInclusive === true;
  const itemsInput = Array.isArray(body?.items) ? (body.items as InvoiceItemInput[]) : [];
  const items = itemsInput.map((item) => cleanInvoiceItem(item, taxInclusive)).filter((item) => item.description && item.quantity > 0);
  if (!items.length) throw Object.assign(new Error("Add at least one invoice line."), { status: 400 });

  // Subtotal is net of each line's own discount (matches what the line shows and
  // what computeInvoiceTotals reports client-side). The invoice-level discount
  // then applies on top. cleanInvoiceItem already floors line_total/tax at the
  // per-line discount, so subtracting discount_amount here keeps totals aligned.
  const subtotal = round2(items.reduce((sum, item) => sum + Math.max(0, item.quantity * item.unit_price - item.discount_amount), 0));
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
    // sent_at means "actually emailed" - set only by the send endpoint. Status
    // "sent" here means published/committed, not necessarily emailed.
    sent_at: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  for (let attempt = 0; ; attempt += 1) {
    try {
      await supabase("billing_invoices", { method: "POST", body: [invoiceRow], prefer: "return=minimal" });
      break;
    } catch (error) {
      const conflict = (error as { supabaseStatus?: number })?.supabaseStatus === 409;
      // Auto-numbered: a 409 means another invoice (or a Stripe import) claimed
      // this number between our read and write - recompute and retry a few times.
      if (conflict && autoNumber && attempt < 5) {
        invoiceNumber = (await nextInvoiceNumber(accountId, body?.invoicePrefix)).invoiceNumber;
        invoiceRow.invoice_number = invoiceNumber;
        continue;
      }
      if (conflict) {
        throw Object.assign(new Error(`Invoice number ${invoiceNumber} is already in use.`), {
          status: 409,
          code: "INVOICE_NUMBER_CONFLICT",
        });
      }
      throw error;
    }
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
  // Publishing (status -> sent) does NOT set sent_at; only the send endpoint
  // marks an invoice as emailed.
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

// Hard-delete an invoice. Its items and booking links are removed by the ON
// DELETE CASCADE foreign keys. The UI only calls this for drafts/voided
// invoices; committed ones are voided (status change) instead of deleted.
async function deleteInvoice(accountId: string, id: string) {
  await supabase("billing_invoices", {
    method: "DELETE",
    query: `id=eq.${encodeFilter(id)}&account_id=eq.${encodeFilter(accountId)}`,
  });
  return { deleted: true };
}

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

// --- Financial reports (P&L, GST, A/R aging) ---------------------------------
// One date-range summary the Reports tab renders: income vs expenses, net
// profit, GST collected/owed, a month-by-month series, top customers, and
// accounts-receivable aging. Read-only - it aggregates billing_invoices +
// billing_expenses exactly the way the invoice list / expense list already do,
// and never writes. buildReportSummary is shared by the JSON and PDF routes.

// Outstanding = committed but not fully paid. Drafts/void never count as owed.
const AGING_STATUSES = ["sent", "overdue"];

async function resolveReportTaxConfig() {
  const rows = await supabase("settings", {
    query: `select=value&key=eq.${encodeFilter("accountInvoiceSettingsJson")}&limit=1`,
  });
  try {
    const parsed = rows[0]?.value ? JSON.parse(rows[0].value) : {};
    const rate = Number(parsed?.taxRate);
    return {
      currency: cleanString(parsed?.currency, "NZD", 10),
      taxRate: Number.isFinite(rate) ? Math.max(0, Math.min(100, rate)) : 15,
      taxName: cleanString(parsed?.taxName, "GST", 40),
    };
  } catch {
    return { currency: "NZD", taxRate: 15, taxName: "GST" };
  }
}

// Whole calendar months overlapping [start, end], for the income/expense
// time series. Capped so a multi-year custom range can't produce 100 bars.
function monthsBetween(start: Date, end: Date) {
  const months: Array<{ label: string; start: string; end: string }> = [];
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth();
  const endYear = end.getUTCFullYear();
  const endMonth = end.getUTCMonth();
  while ((year < endYear || (year === endYear && month <= endMonth)) && months.length < 36) {
    months.push({
      label: `${MONTH_LABELS[month]} ${String(year).slice(2)}`,
      start: formatDateOnly(new Date(Date.UTC(year, month, 1))),
      end: formatDateOnly(new Date(Date.UTC(year, month + 1, 0))),
    });
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  return months;
}

type ReportInvoiceRow = { issue_date: string; total: unknown; tax_total: unknown; amount_paid: unknown; status: string; customer_name: string };
type ReportExpenseRow = { expense_date: string; amount: unknown; category_id: string | null; category_name_snapshot: string | null };
type ReportAgingRow = { invoice_number: string; customer_name: string; issue_date: string; due_date: string | null; total: unknown; amount_paid: unknown };

async function buildReportSummary(accountId: string, url: URL) {
  const today = parseDateOnly(formatDateOnly(new Date())) || new Date();
  const startParam = parseDateOnly(url.searchParams.get("start")) || startOfMonthUTC(today);
  const endParam = parseDateOnly(url.searchParams.get("end")) || endOfMonthUTC(today);
  // Tolerate a reversed range instead of returning nothing.
  const [rangeStartDate, rangeEndDate] =
    startParam.getTime() <= endParam.getTime() ? [startParam, endParam] : [endParam, startParam];
  const rangeStart = formatDateOnly(rangeStartDate);
  const rangeEnd = formatDateOnly(rangeEndDate);

  const tax = await resolveReportTaxConfig();

  const [invoiceRows, expenseRows, outstandingRows] = (await Promise.all([
    supabase("billing_invoices", {
      query: `select=issue_date,total,tax_total,amount_paid,status,customer_name&account_id=eq.${encodeFilter(accountId)}&status=in.(${REVENUE_STATUSES.join(",")})&issue_date=gte.${encodeFilter(rangeStart)}&issue_date=lte.${encodeFilter(rangeEnd)}`,
    }),
    supabase("billing_expenses", {
      query: `select=expense_date,amount,category_id,category_name_snapshot&account_id=eq.${encodeFilter(accountId)}&voided=is.false&expense_date=gte.${encodeFilter(rangeStart)}&expense_date=lte.${encodeFilter(rangeEnd)}`,
    }),
    supabase("billing_invoices", {
      query: `select=invoice_number,customer_name,issue_date,due_date,total,amount_paid&account_id=eq.${encodeFilter(accountId)}&status=in.(${AGING_STATUSES.join(",")})`,
    }),
  ])) as [ReportInvoiceRow[], ReportExpenseRow[], ReportAgingRow[]];

  // Income (by status) + GST collected.
  const incomeByStatus = { sent: 0, paid: 0, overdue: 0 };
  let incomeTotal = 0;
  let taxCollected = 0;
  for (const row of invoiceRows) {
    const total = Number(row.total) || 0;
    incomeTotal += total;
    taxCollected += Number(row.tax_total) || 0;
    if (row.status === "sent" || row.status === "paid" || row.status === "overdue") {
      incomeByStatus[row.status] += total;
    }
  }

  // Expenses. `excludeCategories` (whole-report filter) drops the excluded
  // category rows from every expense-derived figure — total, GST-on-expenses,
  // net profit, and the monthly series. byCategory keeps the FULL category list
  // (with each row's own total) so the client can still list every category as a
  // toggle; the display/export just hide the excluded rows.
  const excludedCategories = parseExcludedCategories(url);
  const includedExpenseRows = excludedCategories.size
    ? expenseRows.filter((row) => !excludedCategories.has(row.category_id || "uncategorised"))
    : expenseRows;
  const expenseTotal = includedExpenseRows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  const categoryMap = new Map<string, { categoryId: string; categoryName: string; total: number; count: number }>();
  for (const row of expenseRows) {
    const id = row.category_id || "uncategorised";
    const bucket = categoryMap.get(id) || {
      categoryId: id,
      categoryName: row.category_name_snapshot || "Uncategorised",
      total: 0,
      count: 0,
    };
    bucket.total += Number(row.amount) || 0;
    bucket.count += 1;
    categoryMap.set(id, bucket);
  }
  const byCategory = [...categoryMap.values()]
    .map((bucket) => ({ ...bucket, total: round2(bucket.total) }))
    .sort((a, b) => b.total - a.total);
  // Names of the excluded categories present in this range, for the "Filtered —
  // excludes: …" annotation on the report and its exports.
  const excludedCategoryNames = byCategory
    .filter((category) => excludedCategories.has(category.categoryId))
    .map((category) => category.categoryName);

  // GST: collected on income invoices vs the GST content of GST-inclusive
  // expenses (amount * rate/(100+rate)). Expenses aren't tagged taxable/exempt,
  // so onExpenses treats every expense as GST-inclusive - an estimate, not a
  // filed figure.
  const gstCollected = round2(taxCollected);
  const gstOnExpenses = tax.taxRate > 0 ? round2(expenseTotal * (tax.taxRate / (100 + tax.taxRate))) : 0;

  // Month-by-month income vs expenses.
  const months = monthsBetween(rangeStartDate, rangeEndDate).map((month) => {
    const income = invoiceRows
      .filter((row) => row.issue_date >= month.start && row.issue_date <= month.end)
      .reduce((sum, row) => sum + (Number(row.total) || 0), 0);
    const expenses = includedExpenseRows
      .filter((row) => row.expense_date >= month.start && row.expense_date <= month.end)
      .reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
    return { label: month.label, monthStart: month.start, income: round2(income), expenses: round2(expenses), net: round2(income - expenses) };
  });

  // Top customers by income in range.
  const customerMap = new Map<string, { customerName: string; total: number; invoiceCount: number }>();
  for (const row of invoiceRows) {
    const name = (row.customer_name || "").trim() || "Unknown";
    const bucket = customerMap.get(name) || { customerName: name, total: 0, invoiceCount: 0 };
    bucket.total += Number(row.total) || 0;
    bucket.invoiceCount += 1;
    customerMap.set(name, bucket);
  }
  const topCustomers = [...customerMap.values()]
    .map((bucket) => ({ ...bucket, total: round2(bucket.total) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  // A/R aging as of today. Outstanding = total - amount_paid, bucketed by days
  // past due (due_date, falling back to issue_date). Point-in-time, so it's NOT
  // bounded by the report date range - it's everything still owed right now.
  const aging = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0, total: 0 };
  const agingInvoices: Array<{
    invoiceNumber: string;
    customerName: string;
    dueDate: string;
    daysOverdue: number;
    outstanding: number;
    bucket: keyof typeof aging;
  }> = [];
  for (const row of outstandingRows) {
    const outstanding = round2((Number(row.total) || 0) - (Number(row.amount_paid) || 0));
    if (outstanding <= 0) continue;
    const dueStr = row.due_date || row.issue_date;
    const dueDate = parseDateOnly(dueStr) || today;
    const daysOverdue = Math.round((today.getTime() - dueDate.getTime()) / 86400000);
    const bucket: keyof typeof aging =
      daysOverdue <= 0 ? "current" : daysOverdue <= 30 ? "d1_30" : daysOverdue <= 60 ? "d31_60" : daysOverdue <= 90 ? "d61_90" : "d90plus";
    aging[bucket] += outstanding;
    aging.total += outstanding;
    agingInvoices.push({
      invoiceNumber: row.invoice_number,
      customerName: (row.customer_name || "").trim() || "Unknown",
      dueDate: dueStr,
      daysOverdue: Math.max(0, daysOverdue),
      outstanding,
      bucket,
    });
  }
  for (const key of Object.keys(aging) as Array<keyof typeof aging>) aging[key] = round2(aging[key]);
  agingInvoices.sort((a, b) => b.daysOverdue - a.daysOverdue || b.outstanding - a.outstanding);

  return {
    currency: tax.currency,
    taxName: tax.taxName,
    taxRate: tax.taxRate,
    rangeStart,
    rangeEnd,
    generatedAt: nowIso(),
    income: {
      total: round2(incomeTotal),
      invoiceCount: invoiceRows.length,
      byStatus: {
        sent: round2(incomeByStatus.sent),
        paid: round2(incomeByStatus.paid),
        overdue: round2(incomeByStatus.overdue),
      },
    },
    expenses: {
      total: round2(expenseTotal),
      count: includedExpenseRows.length,
      byCategory,
      excludedCategoryIds: [...excludedCategories],
      excludedCategoryNames,
    },
    netProfit: round2(incomeTotal - expenseTotal),
    gst: { collected: gstCollected, onExpenses: gstOnExpenses, net: round2(gstCollected - gstOnExpenses) },
    months,
    topCustomers,
    aging: { asOf: formatDateOnly(today), ...aging, invoices: agingInvoices.slice(0, 60) },
  };
}

type ReportSummary = Awaited<ReturnType<typeof buildReportSummary>>;

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
    const lineDiscount = Number(item.discountAmount) || 0;
    // When a line is discounted, note it under the description so the AMOUNT
    // column (which is net of the discount) reads clearly to the customer.
    const descText = item.description || "-";
    const descLines = wrapText(
      lineDiscount > 0 ? `${descText}  (incl. ${formatMoney(lineDiscount, currency)} discount)` : descText,
      font,
      10,
      descWidth,
    );
    ensureSpace(descLines.length * 13 + 6);
    descLines.forEach((lineText, index) => {
      text(lineText, margin, y - index * 13, { size: 10 });
    });
    const lineAmount = (Number(item.quantity) || 0) * (Number(item.unitPrice) || 0) - lineDiscount;
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

// --- Clarity Pay (Stripe Checkout) -------------------------------------------
// One hosted Stripe Checkout page for a single amount. Shared by invoices and
// by POS sales: in both cases our own record is the source of truth and Stripe
// only collects the money, so the shape of the request is identical apart from
// the description and the metadata that lets us reconcile it afterwards.
// Uses the Stripe REST API directly (form-encoded) so no SDK is required.
// Requires STRIPE_SECRET_KEY in the environment.

function stripeSecret() {
  const secret = env("STRIPE_SECRET_KEY");
  if (!secret) {
    throw Object.assign(new Error("Clarity Pay is not configured yet (missing Stripe key)."), {
      status: 503,
      code: "STRIPE_NOT_CONFIGURED",
    });
  }
  return secret;
}

async function stripeRequest(path: string, options: { method?: string; params?: URLSearchParams } = {}) {
  const secret = stripeSecret();
  const method = options.method || "GET";
  const query = method === "GET" && options.params ? `?${options.params.toString()}` : "";
  const response = await fetch(`https://api.stripe.com/v1/${path}${query}`, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(method === "GET" ? {} : { "Content-Type": "application/x-www-form-urlencoded" }),
    },
    ...(method === "GET" ? {} : { body: (options.params || new URLSearchParams()).toString() }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(`Stripe ${method} ${path} failed (${response.status}): ${text.slice(0, 300)}`), {
      status: 502,
      code: "STRIPE_ERROR",
    });
  }
  return text ? JSON.parse(text) : {};
}

type StripeCheckoutInput = {
  // Major units (12.50), not cents - converted here so no caller has to remember.
  amount: number;
  currency: string;
  productName: string;
  productDescription?: string;
  customerEmail?: string;
  clientReferenceId?: string;
  metadata?: Record<string, string>;
  successUrl: string;
  cancelUrl: string;
};

async function createStripeCheckoutSession(input: StripeCheckoutInput) {
  const amountInCents = Math.round((Number(input.amount) || 0) * 100);
  if (amountInCents <= 0) {
    throw Object.assign(new Error("Amount must be greater than zero to take a payment."), { status: 400 });
  }

  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("success_url", input.successUrl);
  params.set("cancel_url", input.cancelUrl);
  if (input.clientReferenceId) params.set("client_reference_id", input.clientReferenceId);
  for (const [key, value] of Object.entries(input.metadata || {})) {
    if (value) params.set(`metadata[${key}]`, value);
  }
  if (input.customerEmail) params.set("customer_email", input.customerEmail);
  // A single line for the whole total keeps the charged amount identical to our
  // record (no per-line rounding drift; tax is already reflected in the total).
  params.set("line_items[0][quantity]", "1");
  params.set("line_items[0][price_data][currency]", String(input.currency || "NZD").toLowerCase());
  params.set("line_items[0][price_data][unit_amount]", String(amountInCents));
  params.set("line_items[0][price_data][product_data][name]", input.productName);
  if (input.productDescription) {
    params.set("line_items[0][price_data][product_data][description]", input.productDescription);
  }

  const session = await stripeRequest("checkout/sessions", { method: "POST", params });
  if (!session.url) throw Object.assign(new Error("Stripe did not return a checkout URL."), { status: 502 });
  return { url: session.url as string, sessionId: (session.id as string) || "" };
}

async function retrieveStripeCheckoutSession(sessionId: string) {
  const session = await stripeRequest(`checkout/sessions/${encodeURIComponent(sessionId)}`);
  return {
    paid: session?.payment_status === "paid",
    expired: session?.status === "expired",
    paymentIntentId: typeof session?.payment_intent === "string" ? (session.payment_intent as string) : "",
  };
}

async function createInvoiceCheckout(accountId: string, id: string, req: Request) {
  const invoice = await getInvoiceWithItems(accountId, id);
  if (!invoice) throw Object.assign(new Error("Invoice not found."), { status: 404 });

  const branding = await resolveInvoiceBranding();
  const origin = new URL(req.url).origin;
  const invoiceNumber = String(invoice.invoiceNumber);

  return createStripeCheckoutSession({
    amount: Number(invoice.total) || 0,
    currency: String(invoice.currency || "NZD"),
    productName: `Invoice ${invoiceNumber} - ${branding.businessName}`,
    productDescription: invoice.customerName ? `Billed to ${invoice.customerName}` : "",
    customerEmail: invoice.customerEmail ? String(invoice.customerEmail) : "",
    clientReferenceId: String(invoice.id),
    metadata: { invoice_id: String(invoice.id), account_id: accountId, invoice_number: invoiceNumber },
    successUrl: `${origin}/?pay=success&invoice=${encodeURIComponent(invoiceNumber)}`,
    cancelUrl: `${origin}/?pay=cancel&invoice=${encodeURIComponent(invoiceNumber)}`,
  });
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

// Accountant-facing PDF of the financial summary. Uses the same branding +
// pdf-lib helpers as the invoice PDF so it looks like it came from the same
// business, but lays out summary tables instead of line items.
// Section keys shared with the frontend (reportsMath ReportSectionKey). The
// query passes the ones to include; absent = all, "none" = empty.
const ALL_REPORT_SECTIONS = ["pl", "gst", "chart", "expensesByCategory", "topCustomers", "aging"] as const;
type ReportSectionKey = (typeof ALL_REPORT_SECTIONS)[number];

function parseReportSections(url: URL): Set<ReportSectionKey> {
  const raw = url.searchParams.get("sections");
  if (raw === null) return new Set(ALL_REPORT_SECTIONS);
  if (raw === "none" || raw.trim() === "") return new Set();
  const valid = new Set<string>(ALL_REPORT_SECTIONS);
  return new Set(raw.split(",").map((key) => key.trim()).filter((key) => valid.has(key)) as ReportSectionKey[]);
}

function parseExcludedCategories(url: URL): Set<string> {
  const raw = url.searchParams.get("excludeCategories");
  if (!raw) return new Set();
  return new Set(raw.split(",").map((id) => id.trim()).filter(Boolean));
}

async function renderReportPdf(
  summary: ReportSummary,
  branding: InvoiceBranding,
  sections: Set<ReportSectionKey> = new Set(ALL_REPORT_SECTIONS),
  excludedCategories: Set<string> = new Set(),
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 50;
  const contentRight = pageWidth - margin;
  const currency = summary.currency || branding.currency;
  const money = (value: number) => formatMoney(value, currency);

  const ink = rgb(0.11, 0.13, 0.16);
  const muted = rgb(0.42, 0.45, 0.5);
  const hair = rgb(0.82, 0.84, 0.87);
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
    text(value, xRight - usedFont.widthOfTextAtSize(String(value ?? ""), size), yy, opts);
  };
  const hrule = (yy: number) => {
    page.drawLine({ start: { x: margin, y: yy }, end: { x: contentRight, y: yy }, thickness: 1, color: hair });
  };
  const ensureSpace = (needed: number) => {
    if (y - needed >= margin) return;
    page = pdf.addPage([pageWidth, pageHeight]);
    y = pageHeight - margin;
  };
  // Section heading + two-column key/value rows shared by every block below.
  const heading = (label: string) => {
    ensureSpace(40);
    y -= 6;
    text(label.toUpperCase(), margin, y, { size: 9, bold: true, color: muted });
    y -= 8;
    hrule(y);
    y -= 16;
  };
  const row = (label: string, value: string, opts: { bold?: boolean; color?: ReturnType<typeof rgb> } = {}) => {
    ensureSpace(16);
    text(label, margin, y, { size: 10, bold: opts.bold, color: opts.color });
    textRight(value, contentRight, y, { size: 10, bold: opts.bold, color: opts.color });
    y -= 16;
  };

  // Header.
  const headerTop = y;
  if (logo) page.drawImage(logo, { x: margin, y: headerTop - logoH, width: logoW, height: logoH });
  const nameX = logo ? margin + logoW + 12 : margin;
  const nameY = logo ? headerTop - logoH / 2 - 6 : headerTop - 4;
  text(branding.businessName, nameX, nameY, { size: 16, bold: true });
  textRight("FINANCIAL REPORT", contentRight, headerTop - 4, { size: 15, bold: true, color: brand });
  y = headerTop - Math.max(logoH, 22) - 8;
  textRight(`${summary.rangeStart} to ${summary.rangeEnd}`, contentRight, y, { size: 9, color: muted });
  if (branding.taxNumber) text(`${branding.taxName} No: ${branding.taxNumber}`, margin, y, { size: 9, color: muted });
  y -= 13;
  textRight(`Generated ${String(summary.generatedAt).slice(0, 10)}`, contentRight, y, { size: 9, color: muted });
  y -= 10;
  page.drawLine({ start: { x: margin, y }, end: { x: contentRight, y }, thickness: 1.6, color: brand });
  y -= 20;

  // Filtered-report annotation, so an exported PDF is never mistaken for the
  // full picture when expense categories have been excluded.
  if (summary.expenses.excludedCategoryNames.length) {
    ensureSpace(20);
    text(`Filtered — expenses exclude: ${summary.expenses.excludedCategoryNames.join(", ")}`, margin, y, {
      size: 9,
      bold: true,
      color: rgb(0.72, 0.13, 0.13),
    });
    y -= 18;
  }

  // Profit & loss + income by status.
  if (sections.has("pl")) {
    heading("Profit & Loss");
    row("Income", money(summary.income.total));
    row("Expenses", `- ${money(summary.expenses.total)}`);
    hrule(y + 6);
    row("Net profit", money(summary.netProfit), { bold: true, color: summary.netProfit < 0 ? rgb(0.72, 0.13, 0.13) : brand });
    y -= 6;

    heading("Income by status");
    row("Paid", money(summary.income.byStatus.paid));
    row("Sent (awaiting payment)", money(summary.income.byStatus.sent));
    row("Overdue", money(summary.income.byStatus.overdue));
  }

  // GST.
  if (sections.has("gst")) {
    heading(`${summary.taxName} summary (${summary.taxRate}%)`);
    row(`${summary.taxName} collected on income`, money(summary.gst.collected));
    row(`${summary.taxName} on expenses (est.)`, `- ${money(summary.gst.onExpenses)}`);
    hrule(y + 6);
    row(`Net ${summary.taxName} ${summary.gst.net >= 0 ? "payable" : "refund"}`, money(Math.abs(summary.gst.net)), { bold: true });
    y -= 6;
  }

  // Expenses by category.
  if (sections.has("expensesByCategory") && summary.expenses.byCategory.length) {
    const shownCategories = summary.expenses.byCategory.filter(
      (category) => !excludedCategories.has(category.categoryId),
    );
    if (shownCategories.length) {
      heading("Expenses by category");
      for (const category of shownCategories) {
        row(`${category.categoryName} (${category.count})`, money(category.total));
      }
    }
  }

  // Top customers.
  if (sections.has("topCustomers") && summary.topCustomers.length) {
    heading("Top customers");
    for (const customer of summary.topCustomers) {
      row(`${customer.customerName} (${customer.invoiceCount})`, money(customer.total));
    }
  }

  // A/R aging.
  if (sections.has("aging")) {
    heading(`Accounts receivable (as of ${summary.aging.asOf})`);
    row("Current / not yet due", money(summary.aging.current));
    row("1-30 days overdue", money(summary.aging.d1_30));
    row("31-60 days overdue", money(summary.aging.d31_60));
    row("61-90 days overdue", money(summary.aging.d61_90));
    row("90+ days overdue", money(summary.aging.d90plus));
    hrule(y + 6);
    row("Total outstanding", money(summary.aging.total), { bold: true });
  }

  if (branding.footerText) {
    ensureSpace(24);
    y -= 8;
    text(branding.footerText, margin, y, { size: 8, color: muted });
  }

  return pdf.save();
}

async function reportPdfResponse(accountId: string, url: URL) {
  const summary = await buildReportSummary(accountId, url);
  const branding = await resolveInvoiceBranding();
  const pdf = await renderReportPdf(summary, branding, parseReportSections(url), parseExcludedCategories(url));
  return new Response(Buffer.from(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="financial-report-${summary.rangeStart}-to-${summary.rangeEnd}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}

// --- POS (point of sale) ------------------------------------------------------
// A POS sale is money taken at the counter. It is deliberately NOT an invoice:
// separate table, separate receipt series (POS-0001), never summed into invoice
// revenue, A/R aging or the invoice reports. The same lesson can be both paid
// at the counter and pulled onto an invoice, so any shared numbering would
// double-count. Keeping the two apart at the table level is what makes that
// impossible rather than merely unlikely.

const POS_RECEIPT_PREFIX = "POS";

// Seeded once per account the first time the methods are read. Clarity Pay is
// the Stripe-backed method and is the only one the UI treats specially; the
// rest are ordinary manual methods the coach can rename, reorder or retire.
const DEFAULT_PAYMENT_METHODS = [
  { name: "Clarity Pay", kind: "clarity_pay", settles_immediately: true, sort_order: 10 },
  { name: "Cash", kind: "custom", settles_immediately: true, sort_order: 20 },
  { name: "Eftpos", kind: "custom", settles_immediately: true, sort_order: 30 },
  { name: "On account", kind: "custom", settles_immediately: false, sort_order: 40 },
  // The method a sale lands on when a voucher covered the whole thing. It is an
  // ordinary manual method as far as the table is concerned; what makes it a
  // coupon payment is billing_pos_transactions.coupon_amount, and posSummary
  // nets that off so the cash drawer never appears to hold voucher money.
  { name: "Coupon", kind: "custom", settles_immediately: true, sort_order: 50 },
];

// Name of the seeded method above. Matched by name because the row is seeded
// per account and has no stable id.
const COUPON_METHOD_NAME = "Coupon";

function paymentMethodRowToApi(row: Record<string, unknown>) {
  return {
    id: String(row.id ?? ""),
    name: String(row.name ?? ""),
    kind: row.kind === "clarity_pay" ? "clarity_pay" : "custom",
    settlesImmediately: row.settles_immediately !== false,
    sortOrder: Number(row.sort_order) || 0,
    active: row.active !== false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Only custom methods are editable. The Clarity Pay row is created by the seed
// and its kind is fixed: a manual method that claimed to be Stripe-backed (or
// the reverse) would silently take payments through the wrong path.
function cleanPaymentMethodPayload(raw: Record<string, unknown>) {
  return {
    name: cleanString(raw?.name, "", 60),
    settles_immediately: raw?.settlesImmediately !== false,
    sort_order: Math.round(cleanNumber(raw?.sortOrder, 100, { min: 0, max: 9999 })),
    active: raw?.active !== false,
  };
}

async function listPaymentMethods(accountId: string) {
  let rows = await supabase("billing_payment_methods", {
    query: `select=*&account_id=eq.${encodeFilter(accountId)}&order=sort_order.asc,name.asc`,
  });
  if (!rows.length) {
    const seeded = DEFAULT_PAYMENT_METHODS.map((method) => ({
      id: randomUUID(),
      account_id: accountId,
      ...method,
      active: true,
      created_at: nowIso(),
      updated_at: nowIso(),
    }));
    try {
      await supabase("billing_payment_methods", { method: "POST", body: seeded, prefer: "return=minimal" });
      rows = seeded;
    } catch (error) {
      // A 409 means a concurrent request seeded them first - re-read rather
      // than fail the page load.
      if ((error as { supabaseStatus?: number })?.supabaseStatus !== 409) throw error;
      rows = await supabase("billing_payment_methods", {
        query: `select=*&account_id=eq.${encodeFilter(accountId)}&order=sort_order.asc,name.asc`,
      });
    }
  }
  return { paymentMethods: rows.map(paymentMethodRowToApi) };
}

async function createPaymentMethod(accountId: string, body: Record<string, unknown>) {
  const clean = cleanPaymentMethodPayload(body);
  if (!clean.name) throw Object.assign(new Error("Payment method name is required."), { status: 400 });
  const row = { id: randomUUID(), account_id: accountId, kind: "custom", ...clean, created_at: nowIso(), updated_at: nowIso() };
  try {
    await supabase("billing_payment_methods", { method: "POST", body: [row], prefer: "return=minimal" });
  } catch (error) {
    if ((error as { supabaseStatus?: number })?.supabaseStatus === 409) {
      throw Object.assign(new Error(`"${clean.name}" already exists.`), { status: 409, code: "PAYMENT_METHOD_EXISTS" });
    }
    throw error;
  }
  return { paymentMethod: paymentMethodRowToApi(row) };
}

async function updatePaymentMethod(accountId: string, id: string, body: Record<string, unknown>) {
  const clean = cleanPaymentMethodPayload(body);
  if (!clean.name) throw Object.assign(new Error("Payment method name is required."), { status: 400 });
  const rows = await supabase("billing_payment_methods", {
    method: "PATCH",
    query: `id=eq.${encodeFilter(id)}&account_id=eq.${encodeFilter(accountId)}`,
    body: { ...clean, updated_at: nowIso() },
    prefer: "return=representation",
  });
  if (!rows.length) throw Object.assign(new Error("Payment method not found."), { status: 404 });
  return { paymentMethod: paymentMethodRowToApi(rows[0]) };
}

function posRowToApi(row: Record<string, unknown>) {
  return {
    id: String(row.id ?? ""),
    receiptNumber: String(row.receipt_number ?? ""),
    status: String(row.status ?? "paid"),
    paymentMethodId: String(row.payment_method_id ?? ""),
    paymentMethodName: String(row.payment_method_name ?? ""),
    paymentMethodKind: row.payment_method_kind === "clarity_pay" ? "clarity_pay" : "custom",
    description: String(row.description ?? ""),
    amount: Number(row.amount) || 0,
    listedAmount: row.listed_amount === null || row.listed_amount === undefined ? null : Number(row.listed_amount),
    currency: String(row.currency ?? "NZD"),
    customerId: String(row.customer_id ?? ""),
    customerName: String(row.customer_name ?? ""),
    customerEmail: String(row.customer_email ?? ""),
    bookingId: String(row.booking_id ?? ""),
    source: String(row.source ?? "counter"),
    note: String(row.note ?? ""),
    couponId: String(row.coupon_id ?? ""),
    couponAmount: Number(row.coupon_amount) || 0,
    paidAt: String(row.paid_at ?? ""),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

// Same "highest existing number wins" approach as invoice numbering, computed
// in JS so a 5-digit receipt doesn't lose to a zero-padded 4-digit one. Reads
// only the POS table, so the two series can never collide or influence each
// other.
async function nextReceiptNumber(accountId: string) {
  const rows = (await supabase("billing_pos_transactions", {
    query:
      `select=receipt_number&account_id=eq.${encodeFilter(accountId)}` +
      `&receipt_number=like.${encodeFilter(`${POS_RECEIPT_PREFIX}-*`)}&limit=100000`,
  })) as Array<{ receipt_number?: string }>;
  let highest = 0;
  for (const row of rows) {
    const match = new RegExp(`^${POS_RECEIPT_PREFIX}-(\\d+)$`).exec(cleanString(row?.receipt_number, "", 60));
    const sequence = match ? Number(match[1]) : NaN;
    if (Number.isFinite(sequence) && sequence > highest) highest = sequence;
  }
  const sequence = highest + 1;
  return { sequence, receiptNumber: `${POS_RECEIPT_PREFIX}-${String(sequence).padStart(4, "0")}` };
}

// --- POS line items + stock ---------------------------------------------------
// A counter sale can be several products at once. The item rows snapshot name,
// SKU and unit price, so a receipt keeps saying what was sold even after the
// product is renamed, repriced or retired.

function posItemRowToApi(row: Record<string, unknown>) {
  return {
    id: String(row.id ?? ""),
    productId: String(row.product_id ?? ""),
    name: String(row.name ?? ""),
    sku: String(row.sku ?? ""),
    quantity: Number(row.quantity) || 0,
    unitPrice: Number(row.unit_price) || 0,
    lineTotal: Number(row.line_total) || 0,
  };
}

async function posItemsForTransactions(accountId: string, transactionIds: string[]) {
  const grouped: Record<string, ReturnType<typeof posItemRowToApi>[]> = {};
  if (!transactionIds.length) return grouped;
  // Same batching ceiling as the booking-link lookups: a query string is not an
  // unbounded place to put ids.
  for (let index = 0; index < transactionIds.length; index += 150) {
    const batch = transactionIds.slice(index, index + 150);
    const list = batch.map((id) => `"${id.replace(/"/g, "")}"`).join(",");
    const rows = await supabase("billing_pos_transaction_items", {
      query:
        `select=*&account_id=eq.${encodeFilter(accountId)}` +
        `&transaction_id=in.(${encodeURIComponent(list)})&order=created_at.asc`,
    });
    for (const row of rows as Array<Record<string, unknown>>) {
      const key = String(row.transaction_id ?? "");
      (grouped[key] ||= []).push(posItemRowToApi(row));
    }
  }
  return grouped;
}

// Turns the basket sent by the checkout modal into rows we are willing to
// store: every line has to name a product that belongs to this account, and the
// prices are re-read from the product rather than trusted from the client.
async function resolvePosItems(accountId: string, raw: unknown) {
  if (!Array.isArray(raw) || !raw.length) return [];
  const requested = raw.slice(0, 50).map((entry) => {
    const line = (entry || {}) as Record<string, unknown>;
    return {
      productId: cleanString(line.productId, "", 160),
      quantity: Math.round(cleanNumber(line.quantity, 1, { min: 1, max: 9999 })),
      // A price may be overridden at the counter, but only downward-or-upward
      // as an explicit number; an absent one falls back to the list price. A
      // null has to count as absent - it used to fall through and sell the line
      // for zero.
      unitPrice:
        line.unitPrice === undefined || line.unitPrice === null || line.unitPrice === ""
          ? null
          : round2(cleanNumber(line.unitPrice, 0, { min: 0 })),
    };
  });

  const ids = [...new Set(requested.map((line) => line.productId).filter(Boolean))];
  if (!ids.length) throw Object.assign(new Error("A sale item must name a product."), { status: 400 });

  // A basket can mix a glove with a lesson, and the two are stored in different
  // places, so each id is looked up against the source its prefix names.
  const productIds = ids.filter((id) => !id.startsWith(LESSON_ITEM_PREFIX));
  const byId = new Map<string, { name: string; price: number; sku: string; trackStock: boolean; isVoucher: boolean }>();

  if (productIds.length) {
    const list = productIds.map((id) => `"${id.replace(/"/g, "")}"`).join(",");
    const rows = await supabase("billing_products_services", {
      query: `select=*&account_id=eq.${encodeFilter(accountId)}&id=in.(${encodeURIComponent(list)})`,
    });
    for (const row of rows as Array<Record<string, unknown>>) {
      byId.set(String(row.id ?? ""), {
        name: String(row.name ?? ""),
        price: round2(Number(row.default_price) || 0),
        sku: String(row.sku ?? ""),
        trackStock: row.track_stock === true,
        isVoucher: row.is_voucher === true,
      });
    }
  }

  if (ids.length > productIds.length) {
    const { taxRate } = await resolveReportTaxConfig();
    for (const item of await lessonTypeItems(taxRate)) {
      // A lesson has no shelf and issues no voucher, so nothing here can move
      // stock or mint a coupon.
      byId.set(item.id, { name: item.name, price: item.price, sku: "", trackStock: false, isVoucher: false });
    }
  }

  return requested.map((line) => {
    const product = byId.get(line.productId);
    if (!product) throw Object.assign(new Error("One of the items is no longer available."), { status: 400 });
    const unitPrice = line.unitPrice === null ? product.price : line.unitPrice;
    return {
      productId: line.productId,
      name: product.name,
      sku: product.sku,
      trackStock: product.trackStock,
      isVoucher: product.isVoucher,
      quantity: line.quantity,
      unitPrice,
      lineTotal: round2(unitPrice * line.quantity),
    };
  });
}

type ResolvedPosItem = Awaited<ReturnType<typeof resolvePosItems>>[number];

async function insertPosItems(accountId: string, transactionId: string, items: ResolvedPosItem[]) {
  if (!items.length) return;
  await supabase("billing_pos_transaction_items", {
    method: "POST",
    prefer: "return=minimal",
    body: items.map((item) => ({
      id: randomUUID(),
      account_id: accountId,
      transaction_id: transactionId,
      product_id: item.productId,
      name: item.name,
      sku: item.sku || null,
      quantity: item.quantity,
      unit_price: item.unitPrice,
      line_total: item.lineTotal,
      created_at: nowIso(),
    })),
  });
}

// Move a sale's stock exactly once, in either direction.
//
// The guard is the stock_applied flag on the transaction, not its status: a
// sale can go paid -> refunded -> paid, and each hop has to move stock once. The
// flag is flipped with a conditional PATCH (`stock_applied=is.false`), so two
// requests arriving together produce one winner - the loser gets no rows back
// and does nothing.
async function movePosStock(accountId: string, transactionId: string, direction: "apply" | "reverse") {
  const applying = direction === "apply";
  const claimed = await supabase("billing_pos_transactions", {
    method: "PATCH",
    query:
      `id=eq.${encodeFilter(transactionId)}&account_id=eq.${encodeFilter(accountId)}` +
      `&stock_applied=is.${applying ? "false" : "true"}`,
    body: { stock_applied: applying, updated_at: nowIso() },
    prefer: "return=representation",
  });
  if (!claimed.length) return;

  const items = (await posItemsForTransactions(accountId, [transactionId]))[transactionId] || [];
  for (const item of items) {
    if (!item.productId || !item.quantity) continue;
    // A lesson has no shelf. The RPC would return null for it anyway, but
    // asking is a round-trip per lesson line on every sale.
    if (item.productId.startsWith(LESSON_ITEM_PREFIX)) continue;
    const delta = applying ? -item.quantity : item.quantity;
    try {
      // Returns null when the product stopped tracking stock (or was deleted),
      // in which case there is nothing to record.
      const resultingLevel = await adjustStockLevel(accountId, item.productId, delta);
      if (resultingLevel === null) continue;
      await writeStockMovement(accountId, item.productId, {
        delta,
        resultingLevel,
        kind: applying ? "sale" : "sale_reversal",
        posTransactionId: transactionId,
      });
    } catch (error) {
      // A stock write must never fail the sale itself - the money is already
      // taken. Log it and carry on; a stocktake corrects the count.
      console.error("billing_api:stock_move_failed", transactionId, item.productId, error);
    }
  }
}

async function syncPosStock(accountId: string, transactionId: string, status: string) {
  await movePosStock(accountId, transactionId, status === "paid" ? "apply" : "reverse");
}

async function listPosTransactions(accountId: string, url: URL) {
  const limit = Math.max(1, Math.min(500, cleanNumber(url.searchParams.get("limit"), 100)));
  const from = cleanString(url.searchParams.get("from"), "", 20);
  const to = cleanString(url.searchParams.get("to"), "", 20);
  const filters = [`account_id=eq.${encodeFilter(accountId)}`];
  // created_at is a timestamp; widen a bare date bound to cover the whole day.
  if (from) filters.push(`created_at=gte.${encodeFilter(`${from}T00:00:00.000Z`)}`);
  if (to) filters.push(`created_at=lte.${encodeFilter(`${to}T23:59:59.999Z`)}`);
  const rows = await supabase("billing_pos_transactions", {
    query: `select=*&${filters.join("&")}&order=created_at.desc&limit=${limit}`,
  });
  const transactions = rows.map(posRowToApi);
  const itemsByTransaction = await posItemsForTransactions(accountId, transactions.map((entry) => entry.id));
  const counter = transactions.map((entry) => ({ ...entry, items: itemsByTransaction[entry.id] || [] }));
  const optix = await listOptixPosRecords(accountId, { from, to, limit });
  // Newest first across both sources, held to the same limit as before.
  const merged = [...counter, ...optix]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit);
  return { transactions: merged };
}

// Optix lesson-pass sales, merged into the POS list as read-only records.
//
// They live in optix_pass_purchases (written by the Optix webhook), not in
// billing_pos_transactions: the money was taken inside Optix, not at the till,
// so they consume no POS receipt number and get no Mark paid / Refund actions
// (source "optix" is what the frontend gates on). The receipt column shows the
// Optix sale number instead (OPTIX-00652).
//
// Only sales classified as a lesson pass (is_pass) are merged. Every Optix
// new_sale still lands raw in optix_pass_purchases — that table is the full
// feed — but the POS list is the lessons picked out of it, so a bay-time
// top-up like "1 x Extra Hour" stays in the feed and off the POS list (and
// out of the POS summary's Optix tile, which is computed from this list).
//
// A sale is paid at purchase: Optix takes the money when new_sale fires, and
// the payload carries no invoice_id, so there is no later settlement signal.
async function listOptixPosRecords(accountId: string, range: { from: string; to: string; limit: number }) {
  const filters = [`account_id=eq.${encodeFilter(accountId)}`, "event_type=eq.new_sale", "is_pass=eq.true"];
  if (range.from) filters.push(`purchased_at=gte.${encodeFilter(`${range.from}T00:00:00.000Z`)}`);
  if (range.to) filters.push(`purchased_at=lte.${encodeFilter(`${range.to}T23:59:59.999Z`)}`);
  // The table is created by the Optix migration; absent (or any read failure)
  // just means no Optix records to merge, never a broken POS list.
  const rows = (await supabase("optix_pass_purchases", {
    query:
      `select=id,sale_number,external_purchase_id,member_name,person_id,item_name,quantity,amount_cents,currency,purchased_at,paid_at,is_pass` +
      `&${filters.join("&")}&order=purchased_at.desc&limit=${range.limit}`,
  }).catch(() => [])) as Array<Record<string, unknown>>;
  if (!rows.length) return [];
  const defaultCurrency = await resolveDefaultCurrency();
  return rows.map((row) => {
    const quantity = Number(row.quantity) || 1;
    const name = String(row.item_name ?? "") || "Optix sale";
    const amount = round2((Number(row.amount_cents) || 0) / 100);
    return {
      id: `optix-${String(row.id ?? "")}`,
      receiptNumber: row.sale_number ? `OPTIX-${String(row.sale_number)}` : `OPTIX-${String(row.external_purchase_id ?? "")}`,
      status: "paid",
      paymentMethodId: "",
      paymentMethodName: "Optix",
      paymentMethodKind: "custom",
      description: quantity > 1 ? `${name} x${quantity}` : name,
      amount,
      listedAmount: null as number | null,
      currency: String(row.currency ?? "") || defaultCurrency,
      customerId: String(row.person_id ?? ""),
      customerName: String(row.member_name ?? ""),
      customerEmail: "",
      bookingId: "",
      source: "optix",
      note: "",
      couponId: "",
      couponAmount: 0,
      paidAt: String(row.paid_at ?? row.purchased_at ?? ""),
      createdAt: String(row.purchased_at ?? ""),
      updatedAt: String(row.purchased_at ?? ""),
      isLessonPass: row.is_pass === true,
      items: [] as ReturnType<typeof posItemRowToApi>[],
    };
  });
}

async function getPosTransaction(accountId: string, id: string) {
  const rows = await supabase("billing_pos_transactions", {
    query: `select=*&id=eq.${encodeFilter(id)}&account_id=eq.${encodeFilter(accountId)}&limit=1`,
  });
  if (!rows.length) return null;
  const items = (await posItemsForTransactions(accountId, [String(rows[0].id ?? "")]))[String(rows[0].id ?? "")] || [];
  return { ...posRowToApi(rows[0]), items };
}

// Selling a voucher product issues a coupon for it, so a voucher bought over
// the counter is the same object as one bought on Squarespace. The code is
// generated here and handed back for the till to read out or print.
async function issueCouponsForSale(
  accountId: string,
  row: Record<string, unknown>,
  items: ResolvedPosItem[],
) {
  const voucherItems = items.filter((item) => item.isVoucher && item.lineTotal > 0);
  if (!voucherItems.length) return [] as unknown[];

  const issued: unknown[] = [];
  for (const item of voucherItems) {
    // One coupon per unit, not one per line: two vouchers bought together are
    // two gifts, and they need two codes.
    for (let copy = 0; copy < item.quantity; copy += 1) {
      try {
        const coupon = await issueCoupon(accountId, {
          value: item.unitPrice,
          currency: String(row.currency ?? ""),
          issuedToName: String(row.customer_name ?? ""),
          issuedToEmail: String(row.customer_email ?? ""),
          customerId: String(row.customer_id ?? ""),
          source: "pos",
          productId: item.productId,
          note: `Sold on ${row.receipt_number}`,
        });
        if (coupon) issued.push(coupon);
      } catch (error) {
        // The money is already taken; a failed coupon write must not undo the
        // sale. It shows up as a sale with no voucher, which is fixable by hand.
        console.error("billing_api:coupon_issue_failed", row.id, item.productId, error);
      }
    }
  }
  return issued;
}

// Refunding or voiding a sale puts the voucher value back; re-paying it takes
// it off again. Guarded by coupon_reversed with the same compare-and-swap as
// stock_applied, so each hop moves the balance exactly once however many times
// the status is flipped.
async function syncPosCoupon(accountId: string, row: Record<string, unknown>, status: string) {
  const couponId = cleanString(row?.coupon_id, "", 160);
  const amount = round2(Number(row?.coupon_amount) || 0);
  if (!couponId || amount <= 0) return;

  const shouldReverse = status !== "paid";
  const claimed = await supabase("billing_pos_transactions", {
    method: "PATCH",
    query:
      `id=eq.${encodeFilter(String(row.id ?? ""))}&account_id=eq.${encodeFilter(accountId)}` +
      `&coupon_reversed=is.${shouldReverse ? "false" : "true"}`,
    body: { coupon_reversed: shouldReverse, updated_at: nowIso() },
    prefer: "return=representation",
  });
  if (!claimed.length) return;

  const balance = shouldReverse
    ? await restoreCouponValue(accountId, couponId, amount)
    : await redeemCouponValue(accountId, couponId, amount);

  if (balance === null && !shouldReverse) {
    // Re-charging a coupon that no longer has the value is not something to
    // paper over: put the flag back so the state still says "not taken".
    await supabase("billing_pos_transactions", {
      method: "PATCH",
      query: `id=eq.${encodeFilter(String(row.id ?? ""))}&account_id=eq.${encodeFilter(accountId)}`,
      body: { coupon_reversed: true, updated_at: nowIso() },
      prefer: "return=minimal",
    });
    throw Object.assign(new Error("The coupon no longer has enough left to cover this sale."), {
      status: 409,
      code: "COUPON_UNAVAILABLE",
    });
  }

  await writeCouponRedemption(accountId, couponId, {
    amount: shouldReverse ? -amount : amount,
    resultingBalance: balance,
    posTransactionId: String(row.id ?? ""),
    note: `${row.receipt_number ?? ""} ${status}`.trim(),
  });
}

async function createPosTransaction(accountId: string, body: Record<string, unknown>) {
  // Prices come back off the product rows, not the request body, so a basket
  // can't be re-priced by whoever is holding the till's browser open.
  const items = await resolvePosItems(accountId, body?.items);
  const itemsTotal = round2(items.reduce((total, item) => total + item.lineTotal, 0));

  // An explicit amount still wins - that is how a discount at the counter is
  // given - but a basket no longer needs one typed in.
  const requestedAmount = round2(cleanNumber(body?.amount, 0, { min: 0 }));
  const amount = requestedAmount > 0 ? requestedAmount : itemsTotal;
  if (amount <= 0) throw Object.assign(new Error("Enter an amount greater than zero."), { status: 400 });

  const description =
    cleanString(body?.description, "", 300) ||
    (items.length ? items.map((item) => (item.quantity > 1 ? `${item.name} x${item.quantity}` : item.name)).join(", ").slice(0, 300) : "");
  if (!description) throw Object.assign(new Error("A description is required."), { status: 400 });

  const methodId = cleanString(body?.paymentMethodId, "", 160);
  const methods = (await listPaymentMethods(accountId)).paymentMethods;
  const method = methods.find((entry) => entry.id === methodId);
  if (!method) throw Object.assign(new Error("Choose a payment method."), { status: 400 });
  if (!method.active) throw Object.assign(new Error(`${method.name} is no longer available.`), { status: 400 });

  // Clarity Pay starts pending and only becomes paid once Stripe confirms it.
  // Manual methods are recorded by a human who just took the money, so they are
  // paid on creation - except "On account", which is money still owed.
  const status = method.kind === "clarity_pay" ? "pending" : method.settlesImmediately ? "paid" : "pending";
  const listedAmountRaw = body?.listedAmount;
  const source = ["lesson", "client", "counter"].includes(String(body?.source)) ? String(body.source) : "counter";

  // Reserve the coupon BEFORE the sale row exists. The reservation is the part
  // that can legitimately fail (someone else just spent it, it expired between
  // the till reading it and pressing pay), and failing then is a refused sale
  // rather than a receipt that has to be unpicked.
  const couponId = cleanString(body?.couponId, "", 160);
  let couponAmount = 0;
  let couponBalance: number | null = null;
  if (couponId) {
    const requested = round2(cleanNumber(body?.couponAmount, 0, { min: 0 }));
    couponAmount = Math.min(requested > 0 ? requested : amount, amount);
    if (couponAmount <= 0) {
      throw Object.assign(new Error("The coupon amount must be greater than zero."), { status: 400 });
    }
    couponBalance = await redeemCouponValue(accountId, couponId, couponAmount);
    if (couponBalance === null) {
      throw Object.assign(new Error("That coupon can no longer cover this sale."), {
        status: 409,
        code: "COUPON_UNAVAILABLE",
      });
    }
  }

  const row = {
    id: randomUUID(),
    account_id: accountId,
    receipt_number: (await nextReceiptNumber(accountId)).receiptNumber,
    status,
    coupon_id: couponId || null,
    coupon_amount: couponAmount,
    payment_method_id: method.id,
    payment_method_name: method.name,
    payment_method_kind: method.kind,
    description,
    amount,
    // For a basket the list price is what the items add up to, so a counter
    // discount on a bag of gear stays visible the same way it does on a lesson.
    listed_amount: listedAmountRaw === null || listedAmountRaw === undefined || listedAmountRaw === ""
      ? itemsTotal > 0
        ? itemsTotal
        : null
      : round2(cleanNumber(listedAmountRaw, 0, { min: 0 })),
    currency: cleanString(body?.currency, await resolveDefaultCurrency(), 10),
    customer_id: cleanString(body?.customerId, "", 160) || null,
    customer_name: cleanString(body?.customerName, "", 140) || null,
    customer_email: cleanString(body?.customerEmail, "", 180) || null,
    booking_id: cleanString(body?.bookingId, "", 160) || null,
    source,
    stripe_session_id: null as string | null,
    stripe_payment_intent_id: null as string | null,
    note: cleanString(body?.note, "", 600) || null,
    paid_at: status === "paid" ? nowIso() : null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  for (let attempt = 0; ; attempt += 1) {
    try {
      await supabase("billing_pos_transactions", { method: "POST", body: [row], prefer: "return=minimal" });
      break;
    } catch (error) {
      // A 409 means another till claimed this receipt number between our read
      // and write. Recompute and retry, same as invoice numbering.
      if ((error as { supabaseStatus?: number })?.supabaseStatus === 409 && attempt < 5) {
        row.receipt_number = (await nextReceiptNumber(accountId)).receiptNumber;
        continue;
      }
      // The sale is not going to exist, so the value reserved above has to go
      // back on the coupon or it is lost with nothing to show for it.
      if (couponId && couponAmount > 0) {
        await restoreCouponValue(accountId, couponId, couponAmount).catch(() => null);
      }
      throw error;
    }
  }

  if (couponId && couponAmount > 0) {
    await writeCouponRedemption(accountId, couponId, {
      amount: couponAmount,
      resultingBalance: couponBalance,
      posTransactionId: String(row.id),
      note: row.receipt_number,
    });
  }

  await insertPosItems(accountId, String(row.id), items);
  // Selling a voucher product is what creates a voucher. Done after the sale
  // exists so a coupon can never outlive a receipt that failed to write.
  const issuedCoupons = await issueCouponsForSale(accountId, row, items);
  // Cash and Eftpos are paid the moment they are recorded, so the stock leaves
  // the shelf now. Clarity Pay and On account wait for their status change.
  if (status === "paid") await syncPosStock(accountId, String(row.id), status);

  return {
    issuedCoupons,
    transaction: {
      ...posRowToApi(row),
      items: items.map((item) => ({
        id: "",
        productId: item.productId,
        name: item.name,
        sku: item.sku,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        lineTotal: item.lineTotal,
      })),
    },
  };
}

async function updatePosTransactionStatus(accountId: string, id: string, body: Record<string, unknown>) {
  const status = String(body?.status || "");
  if (!["pending", "paid", "refunded", "void"].includes(status)) {
    throw Object.assign(new Error("Unknown status."), { status: 400 });
  }
  const patch: Record<string, unknown> = { status, updated_at: nowIso() };
  if (status === "paid") patch.paid_at = nowIso();
  if (body?.note !== undefined) patch.note = cleanString(body?.note, "", 600) || null;
  const rows = await supabase("billing_pos_transactions", {
    method: "PATCH",
    query: `id=eq.${encodeFilter(id)}&account_id=eq.${encodeFilter(accountId)}`,
    body: patch,
    prefer: "return=representation",
  });
  if (!rows.length) throw Object.assign(new Error("Transaction not found."), { status: 404 });
  // Marking a sale paid takes its items off the shelf; refunding or voiding it
  // puts them back. movePosStock() is the thing that makes each of those happen
  // exactly once, however many times the status is flipped.
  await syncPosStock(accountId, id, status);
  await syncPosCoupon(accountId, rows[0] as Record<string, unknown>, status);
  const items = (await posItemsForTransactions(accountId, [id]))[id] || [];
  const refreshed = (await getPosTransaction(accountId, id)) || { ...posRowToApi(rows[0]), items };
  return { transaction: refreshed };
}

// Clarity Pay at the counter: create a Stripe Checkout session for this sale.
// The client renders the returned URL as a QR code so the customer can pay
// contactless from their own phone (Apple Pay / Google Pay), or opens it
// directly to key a card in on the till.
async function createPosCheckout(accountId: string, id: string, req: Request) {
  const transaction = await getPosTransaction(accountId, id);
  if (!transaction) throw Object.assign(new Error("Transaction not found."), { status: 404 });
  if (transaction.status === "paid") {
    throw Object.assign(new Error(`${transaction.receiptNumber} is already paid.`), { status: 409, code: "POS_ALREADY_PAID" });
  }

  const branding = await resolveInvoiceBranding();
  const origin = new URL(req.url).origin;
  const receiptNumber = String(transaction.receiptNumber);

  const session = await createStripeCheckoutSession({
    amount: transaction.amount,
    currency: String(transaction.currency),
    productName: `${transaction.description} - ${branding.businessName}`,
    productDescription: transaction.customerName ? `For ${transaction.customerName}` : "",
    customerEmail: transaction.customerEmail || "",
    clientReferenceId: String(transaction.id),
    metadata: { pos_transaction_id: String(transaction.id), account_id: accountId, receipt_number: receiptNumber },
    successUrl: `${origin}/pos-paid?receipt=${encodeURIComponent(receiptNumber)}`,
    cancelUrl: `${origin}/pos-cancelled?receipt=${encodeURIComponent(receiptNumber)}`,
  });

  await supabase("billing_pos_transactions", {
    method: "PATCH",
    query: `id=eq.${encodeFilter(id)}&account_id=eq.${encodeFilter(accountId)}`,
    body: { stripe_session_id: session.sessionId, updated_at: nowIso() },
    prefer: "return=minimal",
  });

  return { url: session.url, sessionId: session.sessionId, receiptNumber };
}

// Polled by the checkout modal while the QR is on screen. Asking Stripe
// directly (rather than waiting for a webhook) means the till updates even if
// webhook delivery is delayed or the endpoint is not configured.
async function syncPosCheckout(accountId: string, id: string) {
  const transaction = await getPosTransaction(accountId, id);
  if (!transaction) throw Object.assign(new Error("Transaction not found."), { status: 404 });
  if (transaction.status === "paid") return { transaction, paid: true };

  const rows = await supabase("billing_pos_transactions", {
    query: `select=stripe_session_id&id=eq.${encodeFilter(id)}&account_id=eq.${encodeFilter(accountId)}&limit=1`,
  });
  const sessionId = cleanString(rows[0]?.stripe_session_id, "", 200);
  if (!sessionId) return { transaction, paid: false };

  const session = await retrieveStripeCheckoutSession(sessionId);
  if (!session.paid) return { transaction, paid: false, expired: session.expired };

  const updated = await supabase("billing_pos_transactions", {
    method: "PATCH",
    query: `id=eq.${encodeFilter(id)}&account_id=eq.${encodeFilter(accountId)}`,
    body: {
      status: "paid",
      paid_at: nowIso(),
      stripe_payment_intent_id: session.paymentIntentId || null,
      updated_at: nowIso(),
    },
    prefer: "return=representation",
  });
  await syncPosStock(accountId, id, "paid");
  if (updated.length) await syncPosCoupon(accountId, updated[0] as Record<string, unknown>, "paid");
  const items = (await posItemsForTransactions(accountId, [id]))[id] || [];
  return { transaction: updated.length ? { ...posRowToApi(updated[0]), items } : transaction, paid: true };
}

// bookingId -> the sale that settled it. Drives the "paid at POS" badge on
// lesson cards and the Unpaid/Paid filter on the invoice pull lists. Only paid
// sales count: a pending Clarity Pay session is not money in the till.
async function posBookingPayments(accountId: string, bookingIds: string[]) {
  if (!bookingIds.length) return { payments: {} as Record<string, unknown> };
  const list = bookingIds.slice(0, 400).map((id) => `"${id.replace(/"/g, "")}"`).join(",");
  const rows = await supabase("billing_pos_transactions", {
    query:
      `select=id,receipt_number,booking_id,amount,currency,payment_method_name,paid_at` +
      `&account_id=eq.${encodeFilter(accountId)}&status=eq.paid&booking_id=in.(${encodeURIComponent(list)})`,
  });
  const payments: Record<string, unknown> = {};
  for (const row of rows as Array<Record<string, unknown>>) {
    const bookingId = String(row.booking_id || "");
    if (!bookingId) continue;
    payments[bookingId] = {
      id: row.id,
      receiptNumber: row.receipt_number,
      amount: Number(row.amount) || 0,
      currency: row.currency || "NZD",
      paymentMethodName: row.payment_method_name,
      paidAt: row.paid_at || "",
    };
  }
  return { payments };
}

// Counter takings for a date range, split by method. Kept out of
// reports/summary on purpose: mixing it in there is exactly the double-count
// this whole section is designed to avoid.
async function posSummary(accountId: string, url: URL) {
  const { transactions } = await listPosTransactions(accountId, url);
  const paid = transactions.filter((entry) => entry.status === "paid");
  const byMethod = new Map<string, { paymentMethodName: string; count: number; total: number }>();
  const addToMethod = (name: string, amount: number, countsAsSale: boolean) => {
    if (amount <= 0 && !countsAsSale) return;
    const bucket = byMethod.get(name) || { paymentMethodName: name, count: 0, total: 0 };
    if (countsAsSale) bucket.count += 1;
    bucket.total = round2(bucket.total + amount);
    byMethod.set(name, bucket);
  };

  // A sale can be part voucher, part card. entry.amount is the whole sale, so
  // the payment method only gets what was actually tendered on it - otherwise a
  // $100 sale settled with a $60 voucher would show $100 in the cash drawer.
  let couponTotal = 0;
  for (const entry of paid) {
    const couponAmount = round2(entry.couponAmount || 0);
    couponTotal = round2(couponTotal + couponAmount);
    addToMethod(String(entry.paymentMethodName), round2(entry.amount - couponAmount), true);
  }
  if (couponTotal > 0) addToMethod("Coupons redeemed", couponTotal, false);

  return {
    currency: paid[0]?.currency || (await resolveDefaultCurrency()),
    paidCount: paid.length,
    pendingCount: transactions.filter((entry) => entry.status === "pending").length,
    // The headline stays the full value of what went out the door; the method
    // breakdown underneath is what reconciles against a till float.
    paidTotal: round2(paid.reduce((sum, entry) => sum + entry.amount, 0)),
    couponTotal,
    byMethod: [...byMethod.values()].sort((a, b) => b.total - a.total),
  };
}

// --- Coupons (gift vouchers) -------------------------------------------------
// Stored value, not a discount. Someone pays for a voucher - on Squarespace via
// Stripe, or at the counter - and gets a code to spend later. The balance is
// money owed to whoever holds the code, which is why every move of it goes
// through the SQL functions in coupons-schema.sql rather than a read-then-write
// here: two tills spending the same voucher at once would otherwise both
// succeed.

// Ambiguous characters left out on purpose - a code gets read off a printed
// card and down a phone line, and 0/O and 1/I/L are where that goes wrong.
// Mirrors generateCouponCode in src/modules/billing/couponMath.ts.
const COUPON_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generateCouponCode() {
  const block = (length: number) =>
    Array.from({ length }, () => COUPON_ALPHABET[Math.floor(Math.random() * COUPON_ALPHABET.length)]).join("");
  return `CG-${block(4)}-${block(4)}`;
}

function normaliseCouponCode(value: unknown) {
  return cleanString(value, "", 40).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function couponRowToApi(row: Record<string, unknown>) {
  const remaining = Number(row.remaining_value) || 0;
  const expiresAt = row.expires_at ? String(row.expires_at) : null;
  const expired = Boolean(expiresAt && new Date(expiresAt).getTime() <= Date.now());
  return {
    id: String(row.id ?? ""),
    code: String(row.code ?? ""),
    status: String(row.status ?? "active"),
    originalValue: Number(row.original_value) || 0,
    remainingValue: remaining,
    currency: String(row.currency ?? "NZD"),
    issuedToName: String(row.issued_to_name ?? ""),
    issuedToEmail: String(row.issued_to_email ?? ""),
    customerId: String(row.customer_id ?? ""),
    source: String(row.source ?? "manual"),
    productId: String(row.product_id ?? ""),
    sourceLineId: String(row.source_line_id ?? ""),
    sourceInvoiceId: String(row.source_invoice_id ?? ""),
    expiresAt,
    // Derived so the till, the list and any future report all agree.
    expired,
    spendable: row.status === "active" && remaining > 0 && !expired,
    note: String(row.note ?? ""),
    issuedAt: String(row.issued_at ?? ""),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

// Insert with a fresh code, retrying on the unique-code index rather than
// pre-checking - the check would be a race, the index is not.
async function insertCouponRow(row: Record<string, unknown>) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await supabase("billing_coupons", { method: "POST", body: [row], prefer: "return=minimal" });
      return row;
    } catch (error) {
      const status = (error as { supabaseStatus?: number })?.supabaseStatus;
      if (status !== 409) throw error;
      // A 409 is either a duplicate code (retry with a new one) or a duplicate
      // source line, which means this purchase already has a coupon and must
      // not get a second.
      if (row.source_line_id) return null;
      if (attempt >= 5) throw error;
      row.code = generateCouponCode();
    }
  }
}

async function issueCoupon(
  accountId: string,
  input: {
    value: number;
    code?: string;
    currency?: string;
    issuedToName?: string;
    issuedToEmail?: string;
    customerId?: string;
    source?: string;
    productId?: string;
    sourceLineId?: string;
    sourceInvoiceId?: string;
    expiresAt?: string | null;
    note?: string;
  },
) {
  const value = round2(cleanNumber(input.value, 0, { min: 0 }));
  if (value <= 0) throw Object.assign(new Error("A coupon needs a value greater than zero."), { status: 400 });

  const row: Record<string, unknown> = {
    id: randomUUID(),
    account_id: accountId,
    code: normaliseCouponCode(input.code) ? String(input.code).toUpperCase().trim() : generateCouponCode(),
    status: "active",
    original_value: value,
    remaining_value: value,
    currency: cleanString(input.currency, await resolveDefaultCurrency(), 10),
    issued_to_name: cleanString(input.issuedToName, "", 140) || null,
    issued_to_email: cleanString(input.issuedToEmail, "", 180) || null,
    customer_id: cleanString(input.customerId, "", 160) || null,
    source: ["stripe", "pos", "manual"].includes(String(input.source)) ? String(input.source) : "manual",
    product_id: cleanString(input.productId, "", 160) || null,
    source_line_id: cleanString(input.sourceLineId, "", 200) || null,
    source_invoice_id: cleanString(input.sourceInvoiceId, "", 200) || null,
    expires_at: input.expiresAt ? new Date(String(input.expiresAt)).toISOString() : null,
    note: cleanString(input.note, "", 400) || null,
    issued_at: nowIso(),
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  const inserted = await insertCouponRow(row);
  return inserted ? couponRowToApi(inserted) : null;
}

async function listCoupons(accountId: string, url: URL) {
  const limit = Math.max(1, Math.min(500, cleanNumber(url.searchParams.get("limit"), 200)));
  const status = cleanString(url.searchParams.get("status"), "", 20);
  const filters = [`account_id=eq.${encodeFilter(accountId)}`];
  if (["active", "redeemed", "void"].includes(status)) filters.push(`status=eq.${encodeFilter(status)}`);
  const rows = await supabase("billing_coupons", {
    query: `select=*&${filters.join("&")}&order=issued_at.desc&limit=${limit}`,
  });
  return { coupons: (rows as Array<Record<string, unknown>>).map(couponRowToApi) };
}

async function getCouponRow(accountId: string, id: string) {
  const rows = await supabase("billing_coupons", {
    query: `select=*&id=eq.${encodeFilter(id)}&account_id=eq.${encodeFilter(accountId)}&limit=1`,
  });
  return rows.length ? (rows[0] as Record<string, unknown>) : null;
}

// What the till calls when a code is typed in. Codes are stored with hyphens
// but compared without them, so the lookup normalises both sides. There is no
// index on the normalised form, so this reads the account's codes and matches
// in JS - fine at the scale of a pro shop's voucher book.
async function lookupCoupon(accountId: string, rawCode: string) {
  const needle = normaliseCouponCode(rawCode);
  if (!needle) throw Object.assign(new Error("Enter a coupon code."), { status: 400 });
  const rows = (await supabase("billing_coupons", {
    query: `select=*&account_id=eq.${encodeFilter(accountId)}&limit=5000`,
  })) as Array<Record<string, unknown>>;
  const match = rows.find((row) => normaliseCouponCode(row.code) === needle);
  if (!match) throw Object.assign(new Error("No coupon with that code."), { status: 404, code: "COUPON_NOT_FOUND" });
  return { coupon: couponRowToApi(match) };
}

async function updateCoupon(accountId: string, id: string, body: Record<string, unknown>) {
  const patch: Record<string, unknown> = { updated_at: nowIso() };
  const status = String(body?.status || "");
  // Only cancelling and un-cancelling are offered. "redeemed" is a consequence
  // of spending, never something to be set by hand.
  if (status === "void" || status === "active") patch.status = status;
  if (body?.note !== undefined) patch.note = cleanString(body?.note, "", 400) || null;
  if (body?.issuedToName !== undefined) patch.issued_to_name = cleanString(body?.issuedToName, "", 140) || null;
  if (body?.issuedToEmail !== undefined) patch.issued_to_email = cleanString(body?.issuedToEmail, "", 180) || null;
  if (body?.expiresAt !== undefined) {
    patch.expires_at = body.expiresAt ? new Date(String(body.expiresAt)).toISOString() : null;
  }
  const rows = await supabase("billing_coupons", {
    method: "PATCH",
    query: `id=eq.${encodeFilter(id)}&account_id=eq.${encodeFilter(accountId)}`,
    body: patch,
    prefer: "return=representation",
  });
  if (!rows.length) throw Object.assign(new Error("Coupon not found."), { status: 404 });
  return { coupon: couponRowToApi(rows[0]) };
}

async function writeCouponRedemption(
  accountId: string,
  couponId: string,
  entry: { amount: number; resultingBalance: number | null; posTransactionId?: string; note?: string },
) {
  await supabase("billing_coupon_redemptions", {
    method: "POST",
    prefer: "return=minimal",
    body: [
      {
        id: randomUUID(),
        account_id: accountId,
        coupon_id: couponId,
        amount: entry.amount,
        resulting_balance: entry.resultingBalance,
        pos_transaction_id: entry.posTransactionId || null,
        note: cleanString(entry.note, "", 300) || null,
        created_at: nowIso(),
      },
    ],
  });
}

async function listCouponRedemptions(accountId: string, id: string, url: URL) {
  const limit = Math.max(1, Math.min(200, cleanNumber(url.searchParams.get("limit"), 50)));
  const rows = await supabase("billing_coupon_redemptions", {
    query:
      `select=*&account_id=eq.${encodeFilter(accountId)}&coupon_id=eq.${encodeFilter(id)}` +
      `&order=created_at.desc&limit=${limit}`,
  });
  return {
    redemptions: (rows as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id ?? ""),
      amount: Number(row.amount) || 0,
      resultingBalance: row.resulting_balance === null || row.resulting_balance === undefined ? null : Number(row.resulting_balance),
      posTransactionId: String(row.pos_transaction_id ?? ""),
      note: String(row.note ?? ""),
      createdAt: String(row.created_at ?? ""),
    })),
  };
}

// Take value off a coupon. Returns the new balance, or null when the coupon is
// missing, cancelled, expired or short - the guard is in the SQL, so this is
// safe against two tills racing on the same code.
async function redeemCouponValue(accountId: string, couponId: string, amount: number) {
  const result = await supabase("rpc/billing_redeem_coupon", {
    method: "POST",
    body: { p_account_id: accountId, p_coupon_id: couponId, p_amount: amount },
  });
  const balance = Array.isArray(result) ? result[0] : result;
  return balance === null || balance === undefined ? null : Number(balance);
}

async function restoreCouponValue(accountId: string, couponId: string, amount: number) {
  const result = await supabase("rpc/billing_restore_coupon", {
    method: "POST",
    body: { p_account_id: accountId, p_coupon_id: couponId, p_amount: amount },
  });
  const balance = Array.isArray(result) ? result[0] : result;
  return balance === null || balance === undefined ? null : Number(balance);
}

// --- Importing vouchers bought through Stripe --------------------------------
// Squarespace sells the voucher, Stripe takes the money, and the existing
// billing sync already mirrors that purchase into billing_invoices /
// billing_invoice_items. So the import reads what is already here rather than
// re-querying Stripe for orders.
//
// Matching a line back to a voucher product is unavoidably a heuristic: an
// invoice line carries a Stripe *price* id, while a catalog row is keyed by the
// Stripe *product* id. So we resolve prices per voucher product where Stripe is
// reachable, and fall back to matching the line description against the product
// name. Because it is a heuristic, the result is a list of candidates for a
// human to confirm - nothing is minted automatically.

async function voucherProducts(accountId: string) {
  const rows = await supabase("billing_products_services", {
    query: `select=*&account_id=eq.${encodeFilter(accountId)}&is_voucher=is.true`,
  });
  return rows as Array<Record<string, unknown>>;
}

async function stripePriceIdsForProduct(productId: string) {
  // Only Stripe-synced catalog rows have Stripe product ids; a hand-made one
  // has a UUID and there is nothing to ask Stripe about.
  if (!/^prod_/.test(productId)) return [];
  try {
    const response = (await stripeRequest("prices", {
      method: "GET",
      params: new URLSearchParams({ product: productId, limit: "100" }),
    })) as { data?: Array<{ id?: string }> };
    return (response.data || []).map((price) => String(price.id || "")).filter(Boolean);
  } catch {
    // Stripe unreachable or not configured: fall back to name matching.
    return [];
  }
}

async function stripeCouponCandidates(accountId: string, url: URL) {
  const products = await voucherProducts(accountId);
  if (!products.length) return { candidates: [], voucherProducts: [] as unknown[] };

  const priceToProduct = new Map<string, Record<string, unknown>>();
  const nameToProduct = new Map<string, Record<string, unknown>>();
  for (const product of products) {
    nameToProduct.set(String(product.name ?? "").trim().toLowerCase(), product);
    for (const priceId of await stripePriceIdsForProduct(String(product.id ?? ""))) {
      priceToProduct.set(priceId, product);
    }
  }

  const limit = Math.max(1, Math.min(1000, cleanNumber(url.searchParams.get("limit"), 500)));
  const lines = (await supabase("billing_invoice_items", {
    query:
      `select=id,invoice_id,description,line_total,source_id,created_at` +
      `&account_id=eq.${encodeFilter(accountId)}&order=created_at.desc&limit=${limit}`,
  })) as Array<Record<string, unknown>>;

  const matched = lines
    .map((line) => {
      const bySource = priceToProduct.get(String(line.source_id ?? ""));
      const byName = nameToProduct.get(String(line.description ?? "").trim().toLowerCase());
      const product = bySource || byName;
      if (!product) return null;
      return {
        lineId: String(line.id ?? ""),
        invoiceId: String(line.invoice_id ?? ""),
        description: String(line.description ?? ""),
        value: round2(Number(line.line_total) || 0),
        productId: String(product.id ?? ""),
        productName: String(product.name ?? ""),
        // How confident the match is, so the review list can say so.
        matchedBy: bySource ? "price" : "name",
        purchasedAt: String(line.created_at ?? ""),
      };
    })
    .filter(Boolean) as Array<Record<string, unknown>>;

  if (!matched.length) return { candidates: [], voucherProducts: products.map(productRowToApi) };

  // Anything already issued is dropped rather than shown greyed out - the point
  // of the list is "what still needs doing".
  const existing = (await supabase("billing_coupons", {
    query: `select=source_line_id&account_id=eq.${encodeFilter(accountId)}&source_line_id=not.is.null&limit=5000`,
  })) as Array<{ source_line_id?: string }>;
  const issued = new Set(existing.map((row) => String(row.source_line_id ?? "")));

  // Invoice customer details make the voucher findable later by the person who
  // bought it, so they are pulled in for the invoices that survived the filter.
  const outstanding = matched.filter((entry) => !issued.has(String(entry.lineId)) && Number(entry.value) > 0);
  const invoiceIds = [...new Set(outstanding.map((entry) => String(entry.invoiceId)).filter(Boolean))];
  const invoices = new Map<string, Record<string, unknown>>();
  for (let index = 0; index < invoiceIds.length; index += 150) {
    const batch = invoiceIds.slice(index, index + 150);
    const list = batch.map((id) => `"${id.replace(/"/g, "")}"`).join(",");
    const rows = (await supabase("billing_invoices", {
      query:
        `select=id,customer_name,customer_email,currency,issue_date&account_id=eq.${encodeFilter(accountId)}` +
        `&id=in.(${encodeURIComponent(list)})`,
    })) as Array<Record<string, unknown>>;
    for (const row of rows) invoices.set(String(row.id ?? ""), row);
  }

  return {
    voucherProducts: products.map(productRowToApi),
    candidates: outstanding.map((entry) => {
      const invoice = invoices.get(String(entry.invoiceId));
      return {
        ...entry,
        customerName: String(invoice?.customer_name ?? ""),
        customerEmail: String(invoice?.customer_email ?? ""),
        currency: String(invoice?.currency ?? "NZD"),
        purchasedAt: String(invoice?.issue_date ?? entry.purchasedAt ?? ""),
      };
    }),
  };
}

// Issues one coupon per confirmed candidate. Re-running with the same ids is
// harmless: the unique index on (account_id, source_line_id) turns a repeat into
// a skip, not a duplicate voucher.
async function importStripeCoupons(accountId: string, body: Record<string, unknown>, url: URL) {
  const requested = Array.isArray(body?.lineIds) ? body.lineIds.map((id) => cleanString(id, "", 200)).filter(Boolean) : [];
  const { candidates } = await stripeCouponCandidates(accountId, url);
  const wanted = requested.length
    ? (candidates as Array<Record<string, unknown>>).filter((entry) => requested.includes(String(entry.lineId)))
    : (candidates as Array<Record<string, unknown>>);

  const issued: unknown[] = [];
  let skipped = 0;
  for (const candidate of wanted) {
    const coupon = await issueCoupon(accountId, {
      value: Number(candidate.value) || 0,
      currency: String(candidate.currency || ""),
      issuedToName: String(candidate.customerName || ""),
      issuedToEmail: String(candidate.customerEmail || ""),
      source: "stripe",
      productId: String(candidate.productId || ""),
      sourceLineId: String(candidate.lineId || ""),
      sourceInvoiceId: String(candidate.invoiceId || ""),
      note: `Imported from ${candidate.description}`,
    });
    if (coupon) issued.push(coupon);
    else skipped += 1;
  }
  return { issued, issuedCount: issued.length, skipped };
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
    // Stock sub-actions come first: the generic products/:id handler below would
    // otherwise read "id/stock" as the id.
    if (action.startsWith("products/") && action.endsWith("/stock") && req.method === "POST") {
      return json(await adjustProductStock(accountId, action.slice("products/".length, -"/stock".length), await parseBody(req)));
    }
    if (action.startsWith("products/") && action.endsWith("/stock-movements") && req.method === "GET") {
      return json(await listStockMovements(accountId, action.slice("products/".length, -"/stock-movements".length), url));
    }
    if (action.startsWith("products/") && (req.method === "PUT" || req.method === "PATCH")) {
      return json(await updateProduct(accountId, action.slice("products/".length), await parseBody(req)));
    }

    // Coupons (gift vouchers). Sub-actions before the generic :id handlers.
    if (action === "coupons" && req.method === "GET") return json(await listCoupons(accountId, url));
    if (action === "coupons" && req.method === "POST") {
      const body = await parseBody(req);
      const coupon = await issueCoupon(accountId, { ...body, source: "manual" });
      if (!coupon) throw Object.assign(new Error("That coupon already exists."), { status: 409 });
      return json({ coupon }, 201);
    }
    if (action === "coupons/lookup" && req.method === "GET") {
      return json(await lookupCoupon(accountId, url.searchParams.get("code") || ""));
    }
    if (action === "coupons/stripe-candidates" && req.method === "GET") {
      return json(await stripeCouponCandidates(accountId, url));
    }
    if (action === "coupons/import" && req.method === "POST") {
      return json(await importStripeCoupons(accountId, await parseBody(req), url));
    }
    if (action.startsWith("coupons/") && action.endsWith("/redemptions") && req.method === "GET") {
      return json(await listCouponRedemptions(accountId, action.slice("coupons/".length, -"/redemptions".length), url));
    }
    if (action.startsWith("coupons/") && (req.method === "PUT" || req.method === "PATCH")) {
      return json(await updateCoupon(accountId, action.slice("coupons/".length), await parseBody(req)));
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
    // The next number in the series (continues the imported Stripe numbering).
    // Must precede the generic invoices/:id GET, which would treat it as an id.
    if (action === "invoices/next-number" && req.method === "GET") {
      return json(await nextInvoiceNumber(accountId, url.searchParams.get("prefix")));
    }
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
    if (action.startsWith("invoices/") && action.endsWith("/checkout") && req.method === "POST") {
      const invoiceId = action.slice("invoices/".length, -"/checkout".length);
      return json(await createInvoiceCheckout(accountId, invoiceId, req));
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
    if (action.startsWith("invoices/") && req.method === "DELETE") {
      return json(await deleteInvoice(accountId, action.slice("invoices/".length)));
    }

    // POS. Its own namespace and its own tables - nothing under pos/ touches
    // billing_invoices, and nothing above this line reads billing_pos_transactions.
    if (action === "pos/payment-methods" && req.method === "GET") return json(await listPaymentMethods(accountId));
    if (action === "pos/payment-methods" && req.method === "POST") {
      return json(await createPaymentMethod(accountId, await parseBody(req)), 201);
    }
    if (action.startsWith("pos/payment-methods/") && (req.method === "PUT" || req.method === "PATCH")) {
      return json(await updatePaymentMethod(accountId, action.slice("pos/payment-methods/".length), await parseBody(req)));
    }

    if (action === "pos/summary" && req.method === "GET") return json(await posSummary(accountId, url));
    if (action === "pos/booking-payments" && req.method === "GET") {
      const ids = (url.searchParams.get("bookingIds") || "").split(",").map((id) => id.trim()).filter(Boolean);
      return json(await posBookingPayments(accountId, ids));
    }

    if (action === "pos/transactions" && req.method === "GET") return json(await listPosTransactions(accountId, url));
    if (action === "pos/transactions" && req.method === "POST") {
      return json(await createPosTransaction(accountId, await parseBody(req)), 201);
    }
    // Sub-actions must be matched before the generic transactions/:id handlers,
    // which would otherwise read "id/checkout" as the id.
    if (action.startsWith("pos/transactions/") && action.endsWith("/checkout") && req.method === "POST") {
      const transactionId = action.slice("pos/transactions/".length, -"/checkout".length);
      return json(await createPosCheckout(accountId, transactionId, req));
    }
    if (action.startsWith("pos/transactions/") && action.endsWith("/checkout-status") && req.method === "GET") {
      const transactionId = action.slice("pos/transactions/".length, -"/checkout-status".length);
      return json(await syncPosCheckout(accountId, transactionId));
    }
    if (action.startsWith("pos/transactions/") && req.method === "GET") {
      const transaction = await getPosTransaction(accountId, action.slice("pos/transactions/".length));
      if (!transaction) return json({ error: "not_found", message: "Transaction not found." }, 404);
      return json({ transaction });
    }
    if (action.startsWith("pos/transactions/") && req.method === "PATCH") {
      return json(await updatePosTransactionStatus(accountId, action.slice("pos/transactions/".length), await parseBody(req)));
    }

    if (action === "booking-links" && req.method === "GET") {
      const ids = (url.searchParams.get("bookingIds") || "").split(",").map((id) => id.trim()).filter(Boolean);
      return json(await checkBookingLinks(accountId, ids));
    }

    if (action === "reports/revenue" && req.method === "GET") return json(await revenueReport(accountId, url));
    if (action === "reports/summary" && req.method === "GET") return json(await buildReportSummary(accountId, url));
    if (action === "reports/summary/pdf" && req.method === "GET") return reportPdfResponse(accountId, url);

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
