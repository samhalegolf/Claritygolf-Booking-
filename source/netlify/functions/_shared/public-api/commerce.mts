/**
 * Passes and invoices, in the public API.
 *
 * Same rule as bookings: reads go straight to the tables, account-scoped in
 * SQL; writes go through the functions the app itself uses. So a pass issued
 * here merges into a client's existing pass the way the coach app's does, and
 * an invoice marked paid here issues the passes its package lines bought,
 * exactly as Mark paid in Billing does.
 *
 * Money: the pass engine stores cents and the billing tables store dollars.
 * Everything leaving the API is cents; the conversion is here and only here.
 */
import { getDatabase } from "@netlify/database";
import {
  grantPass,
  passTemplatesFromServices,
  readPassById,
  redeemPassManually,
  sweepReturnableCredits,
  voidPass,
  type PassView,
} from "../passes.mts";
import { createInvoice, deleteInvoice, sendInvoice, updateInvoiceStatus } from "../../billing-api.mts";
import { ApiError, decodeCursor, invalid, isoParam, listPage, notFound, pageLimit, requireStr, str } from "./http.mts";
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

/**
 * A `date` column as YYYY-MM-DD. The pg driver turns one into a Date at local
 * midnight, so it is read back with local parts -- toISOString() would move it
 * a day on any server not running in UTC.
 */
export function dateOnly(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value).slice(0, 10);
}

/** Dollars (numeric, as the billing tables keep them) to integer cents. */
export const toCents = (value: unknown) => Math.round((Number(value) || 0) * 100);
/** Integer cents from a request, or throws naming the parameter. */
function centsParam(value: unknown, param: string, fallback = 0): number {
  if (value === undefined || value === null || value === "") return fallback;
  const cents = Number(value);
  if (!Number.isInteger(cents) || cents < 0) {
    throw invalid("parameter_invalid", `'${param}' must be a whole number of cents, 0 or more.`, param);
  }
  return cents;
}

// ---------------------------------------------------------------------------
// Passes
// ---------------------------------------------------------------------------

export function passObject(pass: PassView, options: { ledger?: boolean } = {}) {
  return {
    id: pass.id,
    object: "pass",
    client_id: pass.personId,
    name: pass.name,
    pass_type_id: pass.templateServiceId,
    covers_service_ids: pass.coversServiceIds,
    status: pass.status,
    credits: { available: pass.creditsAvailable, issued: pass.creditsAllocated, used: pass.creditsRedeemed },
    stored_value:
      pass.flexibleValueCents > 0 ? { amount: pass.flexibleValueCents, currency: String(pass.currency || "").toLowerCase() } : null,
    next_expiry: iso(pass.nextExpiry),
    expires_at: iso(pass.expiresAt),
    source: pass.source,
    note: pass.note,
    issued_at: iso(pass.issuedAt),
    ...(options.ledger
      ? {
          lots: pass.allocations.map((lot) => ({
            id: lot.id,
            credits: lot.credits,
            credits_used: lot.creditsRedeemed,
            credits_available: lot.creditsAvailable,
            available_from: iso(lot.availableFrom),
            expires_at: iso(lot.expiresAt),
            source: lot.source,
            paid: lot.totalValueCents === null ? null : { amount: lot.totalValueCents, currency: String(lot.currency || "").toLowerCase() },
            created_at: iso(lot.createdAt),
          })),
          redemptions: pass.redemptions.map((redemption) => ({
            id: redemption.id,
            credits: redemption.credits,
            booking_id: redemption.bookingId,
            note: redemption.note,
            redeemed_at: iso(redemption.redeemedAt),
            reversed_at: iso(redemption.reversedAt),
            reversal_reason: redemption.reversalReason,
          })),
        }
      : {}),
  };
}

/** The current state of one pass, for an event. Null once it is gone. */
export async function readPassObject(accountId: string, passId: string) {
  const pass = await readPassById(accountId, passId);
  return pass ? passObject(pass) : null;
}

async function listPassTypes(ctx: RouteContext) {
  const catalog = await ctx.catalog();
  const types = passTemplatesFromServices(catalog.services).map((template) => ({
    id: template.serviceId,
    object: "pass_type",
    name: template.name,
    credits: template.credits,
    covers_service_ids: template.coversServiceIds,
    price: template.priceCents === null ? null : { amount: template.priceCents, currency: catalog.currency },
  }));
  return ok({ object: "list", data: types, has_more: false, next_cursor: null });
}

const PASS_STATUSES = ["active", "exhausted", "expired", "scheduled", "void"];

async function listPasses(ctx: RouteContext) {
  const accountId = ctx.principal.accountId;
  const q = ctx.url.searchParams;
  const limit = pageLimit(ctx.url);
  await sweepReturnableCredits(accountId);
  const where = ["b.account_id = $1"];
  const values: unknown[] = [accountId];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    where.push(sql.replace("?", `$${values.length}`));
  };
  const clientId = str(q.get("client_id"), 160);
  if (clientId) add("b.person_id = ?", clientId);
  const status = str(q.get("status"), 20);
  if (status) {
    if (!PASS_STATUSES.includes(status)) {
      throw invalid("parameter_invalid", `'status' must be one of ${PASS_STATUSES.join(", ")}.`, "status");
    }
    add("b.effective_status = ?", status);
  }
  const passType = str(q.get("pass_type_id"), 160);
  if (passType) add("b.template_service_id = ?", passType);
  const cursor = decodeCursor(ctx.url);
  if (cursor) {
    values.push(String(cursor[0]), String(cursor[1]));
    where.push(`(p.issued_at, p.id) < ($${values.length - 1}::timestamptz, $${values.length})`);
  }
  values.push(limit + 1);
  const { rows } = await db().pool.query(
    `SELECT b.*, p.source, p.note, p.issued_at, p.cross_redeemable
     FROM pass_balances b JOIN passes p ON p.id = b.pass_id AND p.account_id = b.account_id
     WHERE ${where.join(" AND ")}
     ORDER BY p.issued_at DESC, p.id DESC LIMIT $${values.length}`,
    values,
  );
  return ok(
    listPage(
      rows,
      limit,
      (row: any) => [new Date(row.issued_at).toISOString(), row.pass_id],
      (row: any) =>
        passObject({
          id: String(row.pass_id),
          personId: row.person_id || null,
          name: String(row.name || ""),
          templateServiceId: row.template_service_id || null,
          coversServiceIds: Array.isArray(row.covers_service_ids) ? row.covers_service_ids.map(String) : [],
          crossRedeemable: row.cross_redeemable === true,
          flexibleValueCents: 0,
          currency: null,
          creditsAvailable: Number(row.credits_available) || 0,
          creditsAllocated: Number(row.credits_allocated_all_time) || 0,
          creditsRedeemed: Number(row.credits_redeemed_all_time) || 0,
          nextExpiry: row.next_expiry || null,
          expiresAt: row.expires_at || null,
          status: String(row.effective_status || "active") as PassView["status"],
          source: String(row.source || ""),
          note: String(row.note || ""),
          issuedAt: String(row.issued_at || ""),
          allocations: [],
          redemptions: [],
        }),
    ),
  );
}

async function getPass(ctx: RouteContext) {
  const pass = await readPassById(ctx.principal.accountId, ctx.params[0]);
  if (!pass) throw notFound("pass", ctx.params[0]);
  return ok(passObject(pass, { ledger: true }));
}

/**
 * Issue a pass to a client. By default it tops up a matching pass the client
 * already holds rather than starting a second one -- the same thing the coach
 * app does -- unless `merge: false`. A paid pass (`amount_paid`) always starts
 * its own lot, so the value behind each credit stays exact.
 */
async function issuePass(ctx: RouteContext) {
  const catalog = await ctx.catalog();
  const clientId = requireStr(ctx.body, "client_id", 160);
  const passTypeId = requireStr(ctx.body, "pass_type_id", 160);
  const clientRows = await db().sql`SELECT id FROM people WHERE id = ${clientId} AND account_id = ${ctx.principal.accountId}`;
  if (!clientRows.length) throw notFound("client", clientId);
  const paidCents = ctx.body.amount_paid === undefined ? null : centsParam(ctx.body.amount_paid, "amount_paid");
  const result = await grantPass(
    {
      personId: clientId,
      templateServiceId: passTypeId,
      credits: ctx.body.credits,
      expiryMonths: ctx.body.expiry_months,
      note: str(ctx.body.note, 300) || "Issued through the Clarity API.",
      merge: ctx.body.merge !== false,
      source: "manual",
      ...(paidCents === null ? {} : { totalValueCents: paidCents, currency: catalog.currency.toUpperCase() }),
    },
    passTemplatesFromServices(catalog.services),
    { accountId: ctx.principal.accountId, actorId: `api:${ctx.principal.keyId}` },
  );
  const pass = await readPassById(ctx.principal.accountId, result.passId);
  if (!pass) throw new ApiError("api_error", "internal_error", "The pass was issued but could not be read back.");
  // 201 for a new pass, 200 when the credits topped up one the client holds.
  return ok(passObject(pass, { ledger: true }), result.merged ? 200 : 201);
}

async function redeemPass(ctx: RouteContext) {
  const note = requireStr(ctx.body, "note", 300);
  const credits = ctx.body.credits === undefined ? 1 : Number(ctx.body.credits);
  if (!Number.isInteger(credits) || credits < 1 || credits > 100) {
    throw invalid("parameter_invalid", "'credits' must be a whole number from 1 to 100.", "credits");
  }
  await redeemPassManually({
    accountId: ctx.principal.accountId,
    passId: ctx.params[0],
    credits,
    note,
    actorId: `api:${ctx.principal.keyId}`,
  });
  const pass = await readPassById(ctx.principal.accountId, ctx.params[0]);
  if (!pass) throw notFound("pass", ctx.params[0]);
  return ok(passObject(pass, { ledger: true }));
}

async function voidPassRoute(ctx: RouteContext) {
  const existing = await readPassById(ctx.principal.accountId, ctx.params[0]);
  if (!existing) throw notFound("pass", ctx.params[0]);
  // Voiding a void pass is not an error: it is in the state asked for.
  if (existing.status !== "void") {
    await voidPass(ctx.params[0], str(ctx.body.reason, 300) || "Voided through the Clarity API.", {
      accountId: ctx.principal.accountId,
      actorId: `api:${ctx.principal.keyId}`,
    });
  }
  return ok(passObject((await readPassById(ctx.principal.accountId, ctx.params[0]))!, { ledger: true }));
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export function invoiceObject(row: any, items: any[] | null) {
  const total = toCents(row.total);
  const paid = toCents(row.amount_paid);
  return {
    id: String(row.id),
    object: "invoice",
    number: String(row.invoice_number || ""),
    status: String(row.status || "draft"),
    client: {
      id: row.customer_id ? String(row.customer_id) : null,
      name: String(row.customer_name || ""),
      email: String(row.customer_email || ""),
      phone: String(row.customer_phone || ""),
    },
    issue_date: dateOnly(row.issue_date),
    due_date: dateOnly(row.due_date),
    currency: String(row.currency || "").toLowerCase(),
    tax_inclusive: row.tax_inclusive === true,
    subtotal: toCents(row.subtotal),
    tax: toCents(row.tax_total),
    discount: toCents(row.discount_total),
    total,
    amount_paid: paid,
    amount_due: Math.max(0, total - paid),
    customer_note: String(row.customer_note || ""),
    internal_note: String(row.internal_note || ""),
    reference: String(row.reference || ""),
    payment_url: String(row.payment_link_url || "") || null,
    sent_at: iso(row.sent_at),
    paid_at: iso(row.paid_at),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    ...(items
      ? {
          lines: items.map((item) => ({
            id: String(item.id),
            type: String(item.source_type || "manual"),
            booking_id: item.source_type === "booking" ? item.source_id || null : null,
            service_id: item.source_type === "product" ? item.source_id || null : null,
            description: String(item.description || ""),
            quantity: Number(item.quantity) || 0,
            unit_amount: toCents(item.unit_price),
            discount: toCents(item.discount_amount),
            tax_rate: Number(item.tax_rate) || 0,
            tax: toCents(item.tax_amount),
            amount: toCents(item.line_total),
            service_date: dateOnly(item.service_date),
          })),
        }
      : {}),
  };
}

async function readInvoiceRow(accountId: string, id: string) {
  const [row] = await db().sql`SELECT * FROM billing_invoices WHERE id = ${id} AND account_id = ${accountId}`;
  return row || null;
}

/** The current state of one invoice with its lines, for a route or an event. */
export async function readInvoiceObject(accountId: string, id: string) {
  const row = await readInvoiceRow(accountId, id);
  if (!row) return null;
  const items = await db().sql`
    SELECT * FROM billing_invoice_items WHERE invoice_id = ${id} AND account_id = ${accountId}
    ORDER BY created_at, ctid
  `;
  return invoiceObject(row, items);
}

const INVOICE_STATUSES = ["draft", "sent", "paid", "overdue", "void"];

async function listInvoices(ctx: RouteContext) {
  const q = ctx.url.searchParams;
  const limit = pageLimit(ctx.url);
  const where = ["account_id = $1"];
  const values: unknown[] = [ctx.principal.accountId];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    where.push(sql.replace("?", `$${values.length}`));
  };
  const status = str(q.get("status"), 20);
  if (status) {
    if (!INVOICE_STATUSES.includes(status)) {
      throw invalid("parameter_invalid", `'status' must be one of ${INVOICE_STATUSES.join(", ")}.`, "status");
    }
    add("status = ?", status);
  }
  const clientId = str(q.get("client_id"), 160);
  if (clientId) add("customer_id = ?", clientId);
  const number = str(q.get("number"), 60);
  if (number) add("invoice_number = ?", number);
  const updatedSince = isoParam(q.get("updated_since"), "updated_since");
  if (updatedSince) add("updated_at >= ?", updatedSince);
  const cursor = decodeCursor(ctx.url);
  if (cursor) {
    values.push(String(cursor[0]), String(cursor[1]));
    where.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length})`);
  }
  values.push(limit + 1);
  const { rows } = await db().pool.query(
    `SELECT * FROM billing_invoices WHERE ${where.join(" AND ")}
     ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
    values,
  );
  return ok(listPage(rows, limit, (row: any) => [new Date(row.created_at).toISOString(), row.id], (row: any) => invoiceObject(row, null)));
}

async function getInvoice(ctx: RouteContext) {
  const invoice = await readInvoiceObject(ctx.principal.accountId, ctx.params[0]);
  if (!invoice) throw notFound("invoice", ctx.params[0]);
  return ok(invoice);
}

/** API lines (cents, snake_case) into the billing engine's lines (dollars). */
export function billingLines(value: unknown) {
  if (!Array.isArray(value) || !value.length) throw invalid("parameter_missing", "'lines' needs at least one line.", "lines");
  if (value.length > 100) throw invalid("parameter_invalid", "At most 100 lines.", "lines");
  return value.map((raw, index) => {
    const line = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const param = `lines[${index}]`;
    const description = str(line.description, 400);
    if (!description) throw invalid("parameter_missing", `'${param}.description' is required.`, `${param}.description`);
    const quantity = line.quantity === undefined ? 1 : Number(line.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw invalid("parameter_invalid", `'${param}.quantity' must be more than 0.`, `${param}.quantity`);
    }
    const bookingId = str(line.booking_id, 160);
    const serviceId = str(line.service_id, 160);
    return {
      sourceType: bookingId ? "booking" : serviceId ? "product" : "manual",
      sourceId: bookingId || serviceId || "",
      description,
      quantity,
      unitPrice: centsParam(line.unit_amount, `${param}.unit_amount`) / 100,
      discountAmount: centsParam(line.discount, `${param}.discount`) / 100,
      taxRate: line.tax_rate === undefined ? 0 : Number(line.tax_rate) || 0,
      serviceDate: str(line.service_date, 10),
    };
  });
}

async function createInvoiceRoute(ctx: RouteContext) {
  const accountId = ctx.principal.accountId;
  let client = (ctx.body.client && typeof ctx.body.client === "object" ? ctx.body.client : {}) as Record<string, unknown>;
  const clientId = str(ctx.body.client_id, 160);
  if (clientId) {
    const [person] = await db().sql`SELECT id, name, email, phone FROM people WHERE id = ${clientId} AND account_id = ${accountId}`;
    if (!person) throw notFound("client", clientId);
    client = { name: person.name, email: person.email || "", phone: person.phone || "", ...client };
  }
  const status = str(ctx.body.status, 10) || "draft";
  if (!["draft", "sent"].includes(status)) {
    throw invalid("parameter_invalid", "'status' can be 'draft' or 'sent' when creating. Use /send to email it.", "status");
  }
  const created: any = await createInvoice(accountId, {
    autoNumber: !str(ctx.body.number, 60),
    invoiceNumber: str(ctx.body.number, 60),
    status,
    customerId: clientId,
    customerName: str(client.name, 140),
    customerEmail: str(client.email, 180),
    customerPhone: str(client.phone, 80),
    issueDate: str(ctx.body.issue_date, 10),
    dueDate: str(ctx.body.due_date, 10),
    currency: str(ctx.body.currency, 3).toUpperCase(),
    taxInclusive: ctx.body.tax_inclusive === true,
    items: billingLines(ctx.body.lines),
    discountAmount: centsParam(ctx.body.discount, "discount") / 100,
    customerNote: str(ctx.body.customer_note, 2000),
    internalNote: str(ctx.body.internal_note, 2000),
    reference: str(ctx.body.reference, 160),
  });
  return ok(await readInvoiceObject(accountId, String(created?.id)), 201);
}

async function requireInvoice(ctx: RouteContext) {
  const row = await readInvoiceRow(ctx.principal.accountId, ctx.params[0]);
  if (!row) throw notFound("invoice", ctx.params[0]);
  return row;
}

function refuse(code: string, message: string): never {
  throw new ApiError("conflict_error", code, message);
}

async function sendInvoiceRoute(ctx: RouteContext) {
  const row = await requireInvoice(ctx);
  if (row.status === "void") refuse("invoice_void", "A void invoice cannot be sent.");
  await sendInvoice(
    ctx.principal.accountId,
    row.id,
    { email: str(ctx.body.email, 180), includePaymentLink: ctx.body.include_payment_link === true },
    ctx.url.origin,
  );
  return ok(await readInvoiceObject(ctx.principal.accountId, row.id));
}

/**
 * Record a payment taken somewhere else (cash, bank transfer, another till).
 * Like Mark paid in Billing, this also issues any passes the invoice's package
 * lines bought.
 */
async function markInvoicePaid(ctx: RouteContext) {
  const row = await requireInvoice(ctx);
  if (row.status === "paid") refuse("invoice_already_paid", "This invoice is already paid.");
  if (row.status === "void") refuse("invoice_void", "A void invoice cannot be paid.");
  const amount = ctx.body.amount_paid === undefined ? undefined : centsParam(ctx.body.amount_paid, "amount_paid") / 100;
  await updateInvoiceStatus(ctx.principal.accountId, row.id, { status: "paid", ...(amount === undefined ? {} : { amountPaid: amount }) });
  return ok(await readInvoiceObject(ctx.principal.accountId, row.id));
}

async function voidInvoice(ctx: RouteContext) {
  const row = await requireInvoice(ctx);
  if (row.status === "paid") refuse("invoice_paid", "A paid invoice cannot be voided. Refund it where it was paid, then issue a credit.");
  if (row.status !== "void") await updateInvoiceStatus(ctx.principal.accountId, row.id, { status: "void" });
  return ok(await readInvoiceObject(ctx.principal.accountId, row.id));
}

async function deleteDraftInvoice(ctx: RouteContext) {
  const row = await requireInvoice(ctx);
  if (row.status !== "draft") refuse("invoice_not_draft", "Only a draft can be deleted. Void a published invoice instead.");
  await deleteInvoice(ctx.principal.accountId, row.id);
  return ok({ id: row.id, object: "invoice", deleted: true });
}

export const commerceHandlers = {
  listPassTypes,
  listPasses,
  getPass,
  issuePass,
  redeemPass,
  voidPass: voidPassRoute,
  listInvoices,
  getInvoice,
  createInvoice: createInvoiceRoute,
  sendInvoice: sendInvoiceRoute,
  markInvoicePaid,
  voidInvoice,
  deleteDraftInvoice,
};
