/**
 * Point-of-sale sales in the public API: what was rung up at the till.
 *
 * Reads come straight from billing_pos_transactions; writes go through the
 * till's own functions in billing-api, so receipt numbering, stock, vouchers
 * sold and passes bought all behave exactly as a sale rung up in Clarity.
 *
 * What the API deliberately does not do is take the payment. A sale recorded
 * here was paid somewhere else -- cash, an Eftpos terminal, a website -- or is
 * owed ("On account"). Three kinds of method stay in the app:
 *
 *   clarity_pay  a card has to be presented to Stripe; a record is not a charge
 *   pass         spends a client's credit against one lesson, with its own checks
 *   coupon       spends voucher value, with its own checks
 *
 * Same reason a refund here is only for money that moved outside Clarity Pay:
 * marking a card sale refunded would not put anything back on the card.
 *
 * Billing keeps dollars; the API speaks cents. The conversion is here.
 */
import { getDatabase } from "../database.mts";
import {
  createPosTransaction,
  emailPosReceipt,
  listPaymentMethods,
  updatePosTransactionStatus,
} from "../../billing-api.mts";
import { ApiError, decodeCursor, invalid, isoParam, listPage, notFound, pageLimit, requireStr, str } from "./http.mts";
import { toCents } from "./commerce.mts";
import type { RouteContext } from "./routes.mts";

function db() {
  return getDatabase();
}

const ok = (body: unknown, status = 200) => ({ status, body });

const iso = (value: unknown) => {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/** Methods a sale may be recorded against through the API. See the note at the top. */
export const API_PAYMENT_METHOD_KINDS = ["custom"];

function refuse(code: string, message: string): never {
  throw new ApiError("conflict_error", code, message);
}

function centsParam(value: unknown, param: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const cents = Number(value);
  if (!Number.isInteger(cents) || cents < 0) {
    throw invalid("parameter_invalid", `'${param}' must be a whole number of cents, 0 or more.`, param);
  }
  return cents;
}

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

export function saleObject(row: any, items: any[] | null) {
  const amount = toCents(row.amount);
  const listed = row.listed_amount === null || row.listed_amount === undefined ? null : toCents(row.listed_amount);
  const bookingIds = [
    ...new Set([row.booking_id, ...(Array.isArray(row.booking_ids) ? row.booking_ids : [])].map((id) => String(id ?? "")).filter(Boolean)),
  ];
  return {
    id: String(row.id),
    object: "sale",
    receipt_number: String(row.receipt_number || ""),
    status: String(row.status || "paid"),
    payment_method: {
      id: row.payment_method_id ? String(row.payment_method_id) : null,
      name: String(row.payment_method_name || ""),
      kind: String(row.payment_method_kind || "custom"),
    },
    description: String(row.description || ""),
    // What was taken, and what it would have cost: the difference is a
    // discount given at the counter (or, for a pass sale, the lesson's value).
    amount,
    listed_amount: listed,
    coupon_amount: toCents(row.coupon_amount),
    currency: String(row.currency || "").toLowerCase(),
    client: {
      id: row.customer_id ? String(row.customer_id) : null,
      name: String(row.customer_name || ""),
      email: String(row.customer_email || ""),
    },
    booking_ids: bookingIds,
    source: String(row.source || "counter"),
    channel: row.payment_channel ? String(row.payment_channel) : null,
    note: String(row.note || ""),
    paid_at: iso(row.paid_at),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    ...(items
      ? {
          items: items.map((item) => ({
            id: String(item.id),
            product_id: item.product_id ? String(item.product_id) : null,
            name: String(item.name || ""),
            sku: String(item.sku || ""),
            quantity: Number(item.quantity) || 0,
            unit_amount: toCents(item.unit_price),
            amount: toCents(item.line_total),
          })),
        }
      : {}),
  };
}

async function readSaleRow(accountId: string, id: string) {
  const [row] = await db().sql`SELECT * FROM billing_pos_transactions WHERE id = ${id} AND account_id = ${accountId}`;
  return row || null;
}

/** One sale with its items, as it is now. For routes and events. */
export async function readSaleObject(accountId: string, id: string) {
  const row = await readSaleRow(accountId, id);
  if (!row) return null;
  const items = await db().sql`
    SELECT * FROM billing_pos_transaction_items
    WHERE transaction_id = ${id} AND account_id = ${accountId}
    ORDER BY created_at, ctid
  `;
  return saleObject(row, items);
}

// ---------------------------------------------------------------------------
// Catalog: what can be sold, and how it can be paid
// ---------------------------------------------------------------------------

async function listProducts(ctx: RouteContext) {
  const catalog = await ctx.catalog();
  const includeInactive = ctx.url.searchParams.get("active") === "false";
  const rows = await db().sql`
    SELECT * FROM billing_products_services
    WHERE account_id = ${ctx.principal.accountId}
      AND (${includeInactive}::boolean OR active)
    ORDER BY name, id
  `;
  const products = rows.map((row: any) => ({
    id: String(row.id),
    object: "product",
    name: String(row.name || ""),
    kind: String(row.kind || "product"),
    description: String(row.description || ""),
    price: { amount: toCents(row.default_price), currency: catalog.currency },
    tax_rate: Number(row.tax_rate) || 0,
    sku: row.sku ? String(row.sku) : null,
    track_stock: row.track_stock === true,
    stock_level: row.track_stock === true ? Number(row.stock_level) || 0 : null,
    is_voucher: row.is_voucher === true,
    active: row.active !== false,
  }));
  return ok({ object: "list", data: products, has_more: false, next_cursor: null });
}

async function listPaymentMethodsRoute(ctx: RouteContext) {
  const { paymentMethods } = (await listPaymentMethods(ctx.principal.accountId)) as any;
  const data = (paymentMethods as any[]).map((method) => ({
    id: String(method.id),
    object: "payment_method",
    name: String(method.name),
    kind: String(method.kind),
    // Paid the moment it is recorded (Cash) or owed until marked paid (On account).
    settles_immediately: method.settlesImmediately !== false,
    active: method.active !== false,
    usable_through_api: API_PAYMENT_METHOD_KINDS.includes(String(method.kind)),
  }));
  return ok({ object: "list", data, has_more: false, next_cursor: null });
}

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

const SALE_STATUSES = ["pending", "paid", "refunded", "void"];

async function listSales(ctx: RouteContext) {
  const q = ctx.url.searchParams;
  const limit = pageLimit(ctx.url);
  const where = ["account_id = $1"];
  const values: unknown[] = [ctx.principal.accountId];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    where.push(sql.replaceAll("?", `$${values.length}`));
  };
  const status = str(q.get("status"), 20);
  if (status) {
    if (!SALE_STATUSES.includes(status)) {
      throw invalid("parameter_invalid", `'status' must be one of ${SALE_STATUSES.join(", ")}.`, "status");
    }
    add("status = ?", status);
  }
  const clientId = str(q.get("client_id"), 160);
  if (clientId) add("customer_id = ?", clientId);
  const bookingId = str(q.get("booking_id"), 160);
  if (bookingId) add("(booking_id = ? OR ? = ANY(booking_ids))", bookingId);
  const receipt = str(q.get("receipt_number"), 60);
  if (receipt) add("receipt_number = ?", receipt);
  const createdAfter = isoParam(q.get("created_after"), "created_after");
  if (createdAfter) add("created_at >= ?", createdAfter);
  const createdBefore = isoParam(q.get("created_before"), "created_before");
  if (createdBefore) add("created_at < ?", createdBefore);
  const updatedSince = isoParam(q.get("updated_since"), "updated_since");
  if (updatedSince) add("updated_at >= ?", updatedSince);
  const cursor = decodeCursor(ctx.url);
  if (cursor) {
    values.push(String(cursor[0]), String(cursor[1]));
    where.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length})`);
  }
  values.push(limit + 1);
  const { rows } = await db().pool.query(
    `SELECT * FROM billing_pos_transactions WHERE ${where.join(" AND ")}
     ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
    values,
  );
  return ok(listPage(rows, limit, (row: any) => [new Date(row.created_at).toISOString(), row.id], (row: any) => saleObject(row, null)));
}

async function getSale(ctx: RouteContext) {
  const sale = await readSaleObject(ctx.principal.accountId, ctx.params[0]);
  if (!sale) throw notFound("sale", ctx.params[0]);
  return ok(sale);
}

/** API items (cents, snake_case) into the till's items (dollars). Pure; exported for tests. */
export function tillItems(value: unknown) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid("parameter_invalid", "'items' must be a list.", "items");
  if (value.length > 50) throw invalid("parameter_invalid", "At most 50 items.", "items");
  return value.map((raw, index) => {
    const line = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const param = `items[${index}]`;
    const productId = str(line.product_id, 160);
    if (!productId) throw invalid("parameter_missing", `'${param}.product_id' is required.`, `${param}.product_id`);
    const quantity = line.quantity === undefined ? 1 : Number(line.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) {
      throw invalid("parameter_invalid", `'${param}.quantity' must be a whole number from 1 to 9999.`, `${param}.quantity`);
    }
    const unit = centsParam(line.unit_amount, `${param}.unit_amount`);
    return { productId, quantity, unitPrice: unit === null ? null : unit / 100 };
  });
}

/**
 * Record a sale. Either `items` (products, or lesson types as
 * `lesson:<service id>`, priced from the catalogue unless `unit_amount` says
 * otherwise) or a `description` and `amount`. `amount` on a basket overrides
 * its total -- that is how a discount is given, as at the till.
 */
async function createSale(ctx: RouteContext) {
  const accountId = ctx.principal.accountId;
  const methodId = requireStr(ctx.body, "payment_method_id", 160);
  const { paymentMethods } = (await listPaymentMethods(accountId)) as any;
  const method = (paymentMethods as any[]).find((entry) => entry.id === methodId);
  if (!method) throw notFound("payment method", methodId);
  if (!API_PAYMENT_METHOD_KINDS.includes(String(method.kind))) {
    throw invalid(
      "payment_method_not_supported",
      `${method.name} payments are taken in Clarity itself, not recorded through the API. Use a method like Cash, Eftpos or On account.`,
      "payment_method_id",
    );
  }
  const items = tillItems(ctx.body.items);
  const amount = centsParam(ctx.body.amount, "amount");
  const description = str(ctx.body.description, 300);
  if (!items.length && (!description || !amount)) {
    throw invalid("parameter_missing", "Give 'items', or a 'description' and an 'amount'.", "items");
  }

  let client = (ctx.body.client && typeof ctx.body.client === "object" ? ctx.body.client : {}) as Record<string, unknown>;
  const clientId = str(ctx.body.client_id, 160);
  if (clientId) {
    const [person] = await db().sql`SELECT id, name, email FROM people WHERE id = ${clientId} AND account_id = ${accountId}`;
    if (!person) throw notFound("client", clientId);
    client = { name: person.name, email: person.email || "", ...client };
  }
  const bookingIds = Array.isArray(ctx.body.booking_ids) ? ctx.body.booking_ids.map((id) => str(id, 160)).filter(Boolean) : [];
  if (bookingIds.length) {
    const found = await db().sql`
      SELECT id FROM calendar_items WHERE account_id = ${accountId} AND id = ANY(${bookingIds}) AND kind = 'appointment'
    `;
    const missing = bookingIds.find((id) => !found.some((row: any) => row.id === id));
    if (missing) throw notFound("booking", missing);
  }

  const result: any = await createPosTransaction(accountId, {
    paymentMethodId: methodId,
    items: items.length ? items : undefined,
    amount: amount === null ? undefined : amount / 100,
    description,
    customerId: clientId,
    customerName: str(client.name, 140),
    customerEmail: str(client.email, 180),
    bookingIds,
    // A sale about lessons reads as one in the takings report.
    source: bookingIds.length ? "lesson" : clientId ? "client" : "counter",
    note: str(ctx.body.note, 600),
  });
  return ok(await readSaleObject(accountId, String(result?.transaction?.id)), 201);
}

async function requireSale(ctx: RouteContext) {
  const row = await readSaleRow(ctx.principal.accountId, ctx.params[0]);
  if (!row) throw notFound("sale", ctx.params[0]);
  return row;
}

/** An "On account" sale has been paid. Takes stock and issues passes, as at the till. */
async function markSalePaid(ctx: RouteContext) {
  const row = await requireSale(ctx);
  if (row.status !== "pending") refuse("sale_not_pending", `A ${row.status} sale cannot be marked paid.`);
  if (!API_PAYMENT_METHOD_KINDS.includes(String(row.payment_method_kind))) {
    refuse("sale_paid_in_clarity", `A ${row.payment_method_name} sale is paid in Clarity itself.`);
  }
  await updatePosTransactionStatus(ctx.principal.accountId, row.id, { status: "paid" });
  return ok(await readSaleObject(ctx.principal.accountId, row.id));
}

/**
 * Record that a sale's money was given back, outside Clarity. Puts stock back.
 * Passes it bought stay (see billing-api): a coach voids those deliberately.
 */
async function refundSale(ctx: RouteContext) {
  const row = await requireSale(ctx);
  if (row.status !== "paid") refuse("sale_not_paid", `Only a paid sale can be refunded; this one is ${row.status}.`);
  if (!API_PAYMENT_METHOD_KINDS.includes(String(row.payment_method_kind))) {
    refuse(
      "refund_in_clarity",
      `A ${row.payment_method_name} sale is refunded in Clarity, so the money actually goes back. The API only records refunds of money taken elsewhere.`,
    );
  }
  const reason = str(ctx.body.reason, 300);
  await updatePosTransactionStatus(ctx.principal.accountId, row.id, {
    status: "refunded",
    ...(reason ? { note: [row.note, `Refunded through the Clarity API: ${reason}`].filter(Boolean).join("\n") } : {}),
  });
  return ok(await readSaleObject(ctx.principal.accountId, row.id));
}

/** Cancel a sale that was never paid. A paid one is refunded instead. */
async function voidSale(ctx: RouteContext) {
  const row = await requireSale(ctx);
  if (row.status === "void") return ok(await readSaleObject(ctx.principal.accountId, row.id));
  if (row.status !== "pending") refuse("sale_not_pending", `A ${row.status} sale cannot be voided. Refund a paid sale instead.`);
  if (!API_PAYMENT_METHOD_KINDS.includes(String(row.payment_method_kind))) {
    refuse("sale_paid_in_clarity", `A ${row.payment_method_name} sale is managed in Clarity itself.`);
  }
  await updatePosTransactionStatus(ctx.principal.accountId, row.id, { status: "void" });
  return ok(await readSaleObject(ctx.principal.accountId, row.id));
}

async function sendReceipt(ctx: RouteContext) {
  const row = await requireSale(ctx);
  if (row.status === "void") refuse("sale_void", "A void sale has no receipt to send.");
  await emailPosReceipt(ctx.principal.accountId, row.id, { email: str(ctx.body.email, 180) });
  return ok(await readSaleObject(ctx.principal.accountId, row.id));
}

export const salesHandlers = {
  listProducts,
  listPaymentMethods: listPaymentMethodsRoute,
  listSales,
  getSale,
  createSale,
  markSalePaid,
  refundSale,
  voidSale,
  sendReceipt,
};
