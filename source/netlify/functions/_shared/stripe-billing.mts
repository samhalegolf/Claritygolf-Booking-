// Stripe → billing tables sync (shared logic).
//
// Mirrors Stripe invoices and products into billing_invoices /
// billing_invoice_items / billing_products_services. Used by
// stripe-billing-sync.mts (admin backfill endpoint) and
// stripe-billing-webhook.mts (live Stripe events).
//
// Follows billing-api.mts's protected rules: owns nothing outside the billing
// tables, and keeps its own Supabase REST helper rather than importing the
// local-db shim. Stripe rows are keyed by their Stripe ids (in_/il_/prod_...),
// which keeps every sync idempotent and never collides with the app's own
// randomUUID invoice ids.

function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function round2(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/** Stripe minor units (cents) → the dollars the billing tables store. */
function fromCents(value: unknown) {
  return round2((Number(value) || 0) / 100);
}

function cleanString(value: unknown, fallback = "", max = 600) {
  return typeof value === "string" ? value.trim().slice(0, max) || fallback : fallback;
}

function toDateOnly(epoch: unknown) {
  const num = Number(epoch);
  if (!num || !Number.isFinite(num)) return null;
  return new Date(num * 1000).toISOString().slice(0, 10);
}

function toIso(epoch: unknown) {
  const num = Number(epoch);
  if (!num || !Number.isFinite(num)) return null;
  return new Date(num * 1000).toISOString();
}

// --- Supabase REST helper (same shape as billing-api.mts's) -----------------

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

function encodeFilter(value: unknown) {
  return encodeURIComponent(String(value ?? ""));
}

// --- Stripe REST helper ------------------------------------------------------

const STRIPE_PAGE_LIMIT = 100;
const MAX_PAGES = 50;

/** Default invoice backfill window start: 2026-01-01T00:00:00Z. */
export const DEFAULT_SINCE_EPOCH = 1767225600;

async function stripe(path: string, params: Record<string, unknown> = {}) {
  const secret = env("STRIPE_SECRET_KEY");
  if (!secret) throw Object.assign(new Error("Stripe is not configured (missing STRIPE_SECRET_KEY)."), { status: 503 });
  const url = new URL(`https://api.stripe.com${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.append(key, String(value));
  }
  const response = await fetch(url.toString(), { headers: { Authorization: `Bearer ${secret}` } });
  const text = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(`Stripe GET ${path} failed ${response.status}: ${text.slice(0, 500)}`), {
      status: 502,
    });
  }
  return text ? JSON.parse(text) : {};
}

type StripeList = { data?: Record<string, any>[]; has_more?: boolean };

async function stripePageAll(path: string, params: Record<string, unknown>) {
  const all: Record<string, any>[] = [];
  let startingAfter = "";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = (await stripe(path, {
      ...params,
      limit: STRIPE_PAGE_LIMIT,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })) as StripeList;
    const data = Array.isArray(body?.data) ? body.data : [];
    all.push(...data);
    if (!body?.has_more || !data.length) break;
    startingAfter = data[data.length - 1].id;
  }
  return all;
}

// --- Invoice mapping ----------------------------------------------------------

// billing_invoices.status is CHECK-constrained to draft|sent|paid|overdue|void,
// so Stripe's statuses must be translated, never passed through.
function mapStatus(invoice: Record<string, any>) {
  const status = String(invoice?.status || "draft");
  if (status === "paid") return "paid";
  if (status === "void") return "void";
  if (status === "uncollectible") return "overdue";
  if (status === "open") {
    const due = Number(invoice?.due_date);
    if (Number.isFinite(due) && due > 0 && due * 1000 < Date.now()) return "overdue";
    return "sent";
  }
  return "draft";
}

function taxTotal(invoice: Record<string, any>) {
  if (Array.isArray(invoice.total_taxes)) {
    return round2(invoice.total_taxes.reduce((sum: number, t: any) => sum + (Number(t?.amount) || 0), 0) / 100);
  }
  return fromCents(invoice.tax);
}

function isTaxInclusive(invoice: Record<string, any>) {
  if (!Array.isArray(invoice.total_taxes)) return false;
  return invoice.total_taxes.some(
    (t: any) => String(t?.tax_behavior || "").toLowerCase() === "inclusive" || t?.inclusive === true,
  );
}

function sumAmounts(amounts: unknown) {
  if (!Array.isArray(amounts)) return 0;
  return round2(amounts.reduce((sum: number, entry: any) => sum + (Number(entry?.amount) || 0), 0) / 100);
}

function discountLabel(invoice: Record<string, any>) {
  const names = (Array.isArray(invoice.discounts) ? invoice.discounts : [])
    .map((d: any) => (d && typeof d === "object" && d.coupon?.name ? String(d.coupon.name) : ""))
    .filter(Boolean);
  return names.length ? cleanString(names.join(", "), "", 120) || null : null;
}

function mapInvoice(invoice: Record<string, any>, accountId: string) {
  const transitions = invoice.status_transitions || {};
  return {
    id: invoice.id,
    account_id: accountId,
    invoice_number: cleanString(invoice.number, "", 60) || invoice.id,
    status: mapStatus(invoice),
    customer_id: cleanString(invoice.customer, "", 160) || null,
    customer_name: cleanString(invoice.customer_name, "", 140) || "Stripe customer",
    customer_email: cleanString(invoice.customer_email, "", 180) || null,
    customer_phone: cleanString(invoice.customer_phone, "", 80) || null,
    issue_date: toDateOnly(transitions.finalized_at || invoice.created) || nowIso().slice(0, 10),
    due_date: toDateOnly(invoice.due_date),
    // The app stores display currency codes uppercase (formatMoney prints them verbatim).
    currency: String(invoice.currency || "NZD").toUpperCase(),
    subtotal: fromCents(invoice.subtotal),
    tax_total: taxTotal(invoice),
    tax_inclusive: isTaxInclusive(invoice),
    discount_total: sumAmounts(invoice.total_discount_amounts),
    discount_label: discountLabel(invoice),
    total: fromCents(invoice.total),
    amount_paid: fromCents(invoice.amount_paid),
    customer_note: null,
    internal_note: "Synced from Stripe",
    reference: invoice.id,
    sent_at: toIso(transitions.finalized_at),
    paid_at: toIso(transitions.paid_at),
    updated_at: nowIso(),
  };
}

function mapLine(line: Record<string, any>, invoice: Record<string, any>, accountId: string) {
  const quantity = Number(line.quantity) > 0 ? Number(line.quantity) : 1;
  const lineTotal = fromCents(line.amount);
  const priceId = line.pricing?.price_details?.price || line.price?.id || null;
  return {
    id: line.id,
    invoice_id: invoice.id,
    account_id: accountId,
    source_type: "stripe",
    source_id: cleanString(priceId, "", 160) || null,
    description: cleanString(line.description, "", 500) || "Stripe line item",
    quantity,
    unit_price: round2(lineTotal / quantity),
    tax_rate: null,
    tax_amount: sumAmounts(line.tax_amounts),
    discount_amount: sumAmounts(line.discount_amounts),
    line_total: lineTotal,
  };
}

async function fetchAllInvoiceLines(invoice: Record<string, any>) {
  const embedded = Array.isArray(invoice.lines?.data) ? invoice.lines.data : [];
  if (invoice.lines && !invoice.lines.has_more) return embedded;
  const paged = await stripePageAll(`/v1/invoices/${invoice.id}/lines`, {});
  return paged.length ? paged : embedded;
}

async function upsertInvoice(invoice: Record<string, any>, lines: Record<string, any>[], accountId: string) {
  await supabase("billing_invoices", {
    method: "POST",
    query: "on_conflict=id",
    prefer: "resolution=merge-duplicates",
    body: mapInvoice(invoice, accountId),
  });
  // Replace line items wholesale so removed/edited Stripe lines never linger.
  await supabase("billing_invoice_items", { method: "DELETE", query: `invoice_id=eq.${encodeFilter(invoice.id)}` });
  const rows = lines.map((line) => mapLine(line, invoice, accountId));
  if (rows.length) await supabase("billing_invoice_items", { method: "POST", body: rows });
}

/** Sync a single Stripe invoice object (e.g. a webhook event payload). */
export async function syncStripeInvoice(invoice: Record<string, any>, accountId: string) {
  if (!invoice?.id) return null;
  const lines = await fetchAllInvoiceLines(invoice);
  await upsertInvoice(invoice, lines, accountId);
  return { invoiceId: invoice.id as string, lineItems: lines.length };
}

/** Remove a deleted (draft) Stripe invoice and its rows. */
export async function deleteStripeInvoice(invoiceId: string) {
  if (!invoiceId) return null;
  await supabase("billing_invoice_items", { method: "DELETE", query: `invoice_id=eq.${encodeFilter(invoiceId)}` });
  await supabase("billing_booking_invoice_links", { method: "DELETE", query: `invoice_id=eq.${encodeFilter(invoiceId)}` });
  await supabase("billing_invoices", { method: "DELETE", query: `id=eq.${encodeFilter(invoiceId)}` });
  return { invoiceId, deleted: true };
}

/** Backfill all Stripe invoices created at/after sinceEpoch. */
export async function syncInvoicesSince(sinceEpoch: number, accountId: string) {
  const invoices = await stripePageAll("/v1/invoices", { "created[gte]": sinceEpoch });
  let synced = 0;
  let itemsSynced = 0;
  const failures: { invoiceId: string; number: string | null; error: string }[] = [];
  for (const invoice of invoices) {
    try {
      const lines = await fetchAllInvoiceLines(invoice);
      await upsertInvoice(invoice, lines, accountId);
      synced += 1;
      itemsSynced += lines.length;
    } catch (error) {
      failures.push({
        invoiceId: invoice.id,
        number: invoice.number || null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    ok: failures.length === 0,
    since: new Date(sinceEpoch * 1000).toISOString(),
    invoicesFound: invoices.length,
    invoicesSynced: synced,
    lineItemsSynced: itemsSynced,
    failures,
  };
}

// --- Product mapping ----------------------------------------------------------

// billing_products_services.kind is CHECK-constrained. Honour an explicit
// per-product override via Stripe metadata (clarity_kind), otherwise map
// Stripe's type loosely: goods → product, everything else → service.
function productKind(product: Record<string, any>) {
  const allowed = ["service", "product", "package", "lesson-type"];
  const override = String(product.metadata?.clarity_kind || product.metadata?.kind || "").trim().toLowerCase();
  if (allowed.includes(override)) return override;
  return String(product.type || "").toLowerCase() === "good" ? "product" : "service";
}

function defaultPriceAmount(product: Record<string, any>) {
  const price = product.default_price;
  if (!price || typeof price !== "object") return 0;
  if (Number.isFinite(Number(price.unit_amount))) return fromCents(price.unit_amount);
  if (price.unit_amount_decimal) return round2(Number(price.unit_amount_decimal) / 100);
  return 0;
}

function mapProduct(product: Record<string, any>, accountId: string) {
  return {
    id: product.id,
    account_id: accountId,
    name: cleanString(product.name, "", 140) || product.id,
    kind: productKind(product),
    description: cleanString(product.description, "", 600) || null,
    default_price: defaultPriceAmount(product),
    tax_rate: 0,
    active: product.active !== false,
    updated_at: nowIso(),
  };
}

/** Sync one Stripe product; refetches when the payload lacks an expanded default_price. */
export async function syncStripeProduct(product: Record<string, any>, accountId: string) {
  if (!product?.id) return null;
  let full = product;
  if (!product.default_price || typeof product.default_price === "string") {
    try {
      full = await stripe(`/v1/products/${product.id}`, { "expand[]": "default_price" });
    } catch {
      full = product;
    }
  }
  await supabase("billing_products_services", {
    method: "POST",
    query: "on_conflict=id",
    prefer: "resolution=merge-duplicates",
    body: mapProduct(full, accountId),
  });
  return { productId: product.id as string };
}

/** Stripe product deleted: keep the row (items may reference it), mark inactive. */
export async function deactivateStripeProduct(productId: string) {
  if (!productId) return null;
  await supabase("billing_products_services", {
    method: "PATCH",
    query: `id=eq.${encodeFilter(productId)}`,
    body: { active: false, updated_at: nowIso() },
  });
  return { productId, deactivated: true };
}

/** Backfill every Stripe product — active and archived, deliberately unfiltered. */
export async function syncAllProducts(accountId: string) {
  const products = await stripePageAll("/v1/products", { "expand[]": "data.default_price" });
  let synced = 0;
  const failures: { productId: string; name: string | null; error: string }[] = [];
  for (const product of products) {
    try {
      await syncStripeProduct(product, accountId);
      synced += 1;
    } catch (error) {
      failures.push({
        productId: product.id,
        name: product.name || null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { ok: failures.length === 0, productsFound: products.length, productsSynced: synced, failures };
}
