// Billing / invoicing type surface.
//
// First cut of the billing extraction: these types were previously declared
// inline in App.tsx. They are pure declarations (no runtime), so moving them
// here changes no behaviour - App.tsx imports them back. Data still flows one
// way (booking -> billing); nothing here writes to clients or bookings.
//
// The persisted, backend-owned shapes (Billing*Record / report / preset types)
// mirror what netlify/functions/billing-api.mts returns.

export type InvoiceCustomFieldPlacement = "header" | "bill-to" | "payment" | "footer";

export type InvoiceCustomField = {
  id: string;
  label: string;
  value: string;
  placement: InvoiceCustomFieldPlacement;
};

export type InvoiceSettings = {
  enabled: boolean;
  showBillingWorkspace: boolean;
  prefix: string;
  nextNumber: number;
  currency: string;
  taxName: string;
  taxNumber: string;
  taxRate: number;
  bankAccount: string;
  paymentTermsDays: number;
  businessAddress: string;
  headerText: string;
  footerText: string;
  defaultCustomerNote: string;
  paymentInstructions: string;
  customFields: InvoiceCustomField[];
  // How insistently the Dashboard should call out unpaid/overdue invoices.
  // 1 = subtle count only, 2 = highlighted banner, 3 = urgent banner + row
  // highlighting in Recent Invoices. Purely a display setting - it doesn't
  // change invoice status, send reminders, or touch any other data.
  unpaidLoudness: 1 | 2 | 3;
};

export type BillingCatalogKind = "service" | "product" | "package";

// One entry per thing you sell. Products come from billing_products_services;
// services and packages are the coach's lesson types, merged in by the API
// (they carry readOnly, and are edited under Settings > Services). The stock
// fields only mean anything for a product with trackStock on - a lesson has
// nothing on a shelf to count.
//
// stockLevel is read-only from the frontend's point of view: it is set by a
// stock adjustment or a POS sale, never by saving the product form, so a save
// can't quietly undo a sale that happened while the form was open.
export type BillingCatalogItem = {
  id: string;
  kind: BillingCatalogKind;
  name: string;
  description: string;
  price: number;
  taxRate: number;
  sourceServiceId?: string;
  active?: boolean;
  supplier?: string;
  sku?: string;
  costPrice?: number;
  trackStock?: boolean;
  stockLevel?: number;
  lowStockThreshold?: number;
  // Computed by the backend so the list, the checkout picker and any future
  // reorder report all agree on what "low" means.
  lowStock?: boolean;
  // Selling this issues a gift voucher rather than just taking money.
  isVoucher?: boolean;
  // A lesson type, shown in the catalog but owned by Settings > Services. It
  // can be sold and invoiced; it cannot be edited or retired from Billing.
  readOnly?: boolean;
};

// Why a stock level is what it is. Append-only; "sale"/"sale_reversal" rows
// carry the receipt that caused them.
export type StockMovementKind = "adjustment" | "stocktake" | "receipt" | "sale" | "sale_reversal";

export type StockMovement = {
  id: string;
  productId: string;
  delta: number;
  resultingLevel: number | null;
  kind: StockMovementKind;
  posTransactionId: string;
  note: string;
  createdAt: string;
};

export type InvoiceLineSource = "manual" | "catalog" | "booking_snapshot" | "package_sale";

// How a per-line discount is expressed. "none" = no discount; "amount" = a fixed
// value in the invoice currency; "percent" = a percentage of the line's gross.
export type InvoiceLineDiscountKind = "none" | "amount" | "percent";

export type InvoiceLine = {
  id: string;
  source: InvoiceLineSource;
  sourceId?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  // Per-line discount, applied to this line before tax and independent of the
  // invoice-level discount (InvoiceDraft.discountAmount) which still applies on
  // top. discountKind/discountValue are the editor's source of truth (so a
  // percentage tracks price changes); discountAmount is the resolved currency
  // value sent to and loaded from the backend. discountPresetId remembers which
  // saved discount preset was chosen, if any.
  discountKind: InvoiceLineDiscountKind;
  discountValue: number;
  discountAmount: number;
  discountPresetId?: string;
};

export type InvoiceDraft = {
  accountId?: string;
  coachId?: string;
  payerName: string;
  payerEmail: string;
  payerPhone: string;
  invoiceDate: string;
  dueDate: string;
  reference: string;
  discountLabel: string;
  discountAmount: number;
  message: string;
  lineSearch: string;
  taxInclusive: boolean;
  lines: InvoiceLine[];
};

// Shape returned by /api/billing/invoices (billing-api.mts). This is the
// persisted, backend-owned invoice record - distinct from InvoiceDraft, which
// is just the in-progress editor state before an invoice has been saved.
export type BillingInvoiceStatus = "draft" | "sent" | "paid" | "overdue" | "void";

export type BillingInvoiceRecord = {
  id: string;
  invoiceNumber: string;
  status: BillingInvoiceStatus;
  customerName: string;
  customerEmail: string;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  total: number;
  amountPaid: number;
  // Set once the invoice has actually been emailed. status "sent" without this =
  // Published (committed but not emailed).
  sentAt?: string | null;
};

// Shape returned by GET /api/billing/reports/revenue.
export type BillingRevenueBucket = {
  label: string;
  rangeStart: string;
  rangeEnd: string;
  total: number;
};

export type BillingRevenueReport = {
  period: "week" | "month" | "year";
  currency: string;
  rangeStart: string;
  rangeEnd: string;
  total: number;
  previousYearTotal: number | null;
  previousYearRangeStart: string;
  previousYearRangeEnd: string;
  buckets: BillingRevenueBucket[];
};

// Shape returned by GET /api/billing/reports/summary - the Reports tab's
// full P&L / GST / aging payload. Backend-owned (billing-api.mts
// buildReportSummary); the frontend only reads it.
export type BillingReportAgingBucket = "current" | "d1_30" | "d31_60" | "d61_90" | "d90plus";

export type BillingReportAgingInvoice = {
  invoiceNumber: string;
  customerName: string;
  dueDate: string;
  daysOverdue: number;
  outstanding: number;
  bucket: BillingReportAgingBucket;
};

export type BillingReportSummary = {
  currency: string;
  taxName: string;
  taxRate: number;
  rangeStart: string;
  rangeEnd: string;
  generatedAt: string;
  income: {
    total: number;
    invoiceCount: number;
    byStatus: { sent: number; paid: number; overdue: number };
  };
  expenses: {
    total: number;
    count: number;
    byCategory: Array<{ categoryId: string; categoryName: string; total: number; count: number }>;
    // Whole-report category filter: totals above already exclude these; the
    // names drive the "Filtered — excludes: …" banner + export annotation.
    excludedCategoryIds?: string[];
    excludedCategoryNames?: string[];
  };
  netProfit: number;
  gst: { collected: number; onExpenses: number; net: number };
  months: Array<{ label: string; monthStart: string; income: number; expenses: number; net: number }>;
  topCustomers: Array<{ customerName: string; total: number; invoiceCount: number }>;
  aging: {
    asOf: string;
    current: number;
    d1_30: number;
    d31_60: number;
    d61_90: number;
    d90plus: number;
    total: number;
    invoices: BillingReportAgingInvoice[];
  };
};

// Shape returned by /api/billing/discounts. Presets only - applying one to an
// invoice just fills invoiceDraft.discountLabel/discountAmount, it does not
// change how the invoice itself stores its discount.
export type BillingDiscountType = "percentage" | "fixed";

export type BillingDiscount = {
  id: string;
  name: string;
  discountType: BillingDiscountType;
  value: number;
  couponCode: string;
  active: boolean;
};

// Shape returned by /api/billing/expense-categories. Presets only, same
// pattern as discounts above.
export type BillingExpenseCategory = {
  id: string;
  name: string;
  active: boolean;
};

// --- POS -------------------------------------------------------------------
// Counter sales. Deliberately a separate world from BillingInvoiceRecord: its
// own table, its own POS-#### receipt series, and never summed into invoice
// revenue or aging. A lesson can be paid at the counter AND appear on an
// invoice, so any shared numbering would double-count.

// "clarity_pay" is the Stripe-backed method (exactly one per account, seeded by
// the backend). Everything else is a manual method the coach defines.
export type PosPaymentMethodKind = "clarity_pay" | "custom";

export type PosPaymentMethod = {
  id: string;
  name: string;
  kind: PosPaymentMethodKind;
  // false = the money is owed, not received (On account). Sales on such a
  // method are recorded as pending rather than paid.
  settlesImmediately: boolean;
  sortOrder: number;
  active: boolean;
};

export type PosTransactionStatus = "pending" | "paid" | "refunded" | "void";

// Where the sale was started from. "lesson" carries a bookingId; "client" is a
// sale opened from a client profile; "counter" is a walk-up sale. "optix" is a
// read-only record merged in from Optix product sales — money Optix already
// took, so it has no POS receipt number and no Mark paid / Refund actions.
export type PosTransactionSource = "lesson" | "client" | "counter" | "optix";

// A product line on a counter sale. Name, SKU and unit price are snapshots
// taken when the sale was rung up, so an old receipt still reads correctly
// after the product is renamed, repriced or retired.
export type PosTransactionItem = {
  id: string;
  productId: string;
  name: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
};

export type PosTransaction = {
  id: string;
  receiptNumber: string;
  status: PosTransactionStatus;
  paymentMethodId: string;
  paymentMethodName: string;
  paymentMethodKind: PosPaymentMethodKind;
  description: string;
  amount: number;
  // What the lesson type / product was priced at when the sale was opened, so
  // a discount given at the counter stays visible afterwards. null when the
  // sale never had a list price.
  listedAmount: number | null;
  currency: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  bookingId: string;
  source: PosTransactionSource;
  note: string;
  // A sale can be part voucher, part card. `amount` is still the whole sale;
  // couponAmount is the slice a coupon covered, so the takings report can net
  // it off the payment method.
  couponId?: string;
  couponAmount?: number;
  paidAt: string;
  createdAt: string;
  updatedAt: string;
  // Only on source "optix": the product is a lesson pass/package, i.e. a
  // lesson paid for through Optix.
  isLessonPass?: boolean;
  // Empty for a plain lesson or free-form sale; populated when products were
  // rung up. Stock moves off these lines, not off the amount.
  items?: PosTransactionItem[];
};

// bookingId -> the paid sale that settled it. Drives the "paid at POS" badge on
// lesson cards and the Unpaid/Paid filter on the invoice pull lists.
export type PosBookingPayment = {
  id: string;
  receiptNumber: string;
  amount: number;
  currency: string;
  paymentMethodName: string;
  paidAt: string;
};

// Counter takings for a date range, split by method. Kept out of
// BillingReportSummary on purpose.
export type PosSummary = {
  currency: string;
  paidCount: number;
  pendingCount: number;
  paidTotal: number;
  // Value settled with vouchers over the range. Already excluded from each
  // method's total in byMethod, and shown there as its own "Coupons redeemed"
  // row - paidTotal remains the full value of what went out the door.
  couponTotal?: number;
  byMethod: Array<{ paymentMethodName: string; count: number; total: number }>;
};

// What the checkout modal needs to open a sale. Everything is optional except
// the amount and description defaults, so the same modal serves a lesson card,
// a client profile and a blank counter sale.
export type PosCheckoutContext = {
  source: PosTransactionSource;
  description: string;
  amount: number;
  listedAmount: number | null;
  customerId?: string;
  customerName?: string;
  customerEmail?: string;
  bookingId?: string;
};

// Shape returned by /api/billing/expenses. Not linked to invoices/bookings -
// this is simple outgoing-spend tracking, not cost-of-goods-sold.
export type BillingExpense = {
  id: string;
  description: string;
  vendor: string;
  amount: number;
  currency: string;
  expenseDate: string;
  categoryId: string;
  categoryName: string;
  note: string;
  voided: boolean;
};

// --- Coupons (gift vouchers) -------------------------------------------------
// Stored value, not a discount. Someone paid for this - on Squarespace through
// Stripe, or at the counter - so until it is spent the balance is money owed to
// whoever holds the code. Deliberately separate from BillingDiscount, which is
// only ever a label that reduces a price.

export type CouponStatus = "active" | "redeemed" | "void";

// Where the coupon came from. "stripe" = imported from a synced Stripe
// purchase, "pos" = a voucher product sold at the till, "manual" = issued by hand.
export type CouponSource = "stripe" | "pos" | "manual";

export type BillingCoupon = {
  id: string;
  code: string;
  status: CouponStatus;
  // originalValue never changes, so a half-spent voucher still says what it was
  // worth when it was bought.
  originalValue: number;
  remainingValue: number;
  currency: string;
  issuedToName: string;
  issuedToEmail: string;
  customerId: string;
  source: CouponSource;
  productId: string;
  sourceLineId: string;
  sourceInvoiceId: string;
  expiresAt: string | null;
  // Both derived by the backend so the till and the list can't disagree about
  // whether a code is usable.
  expired: boolean;
  spendable: boolean;
  note: string;
  issuedAt: string;
  createdAt: string;
  updatedAt: string;
};

// Append-only. Negative amounts are value put back by a refunded or voided sale.
export type CouponRedemption = {
  id: string;
  amount: number;
  resultingBalance: number | null;
  posTransactionId: string;
  note: string;
  createdAt: string;
};

// A Stripe purchase that looks like it bought a voucher but has no coupon yet.
// Matching a line to a product is a heuristic (invoice lines carry a Stripe
// price id, catalog rows are keyed by product id), so these are reviewed by a
// human before anything is issued. matchedBy says how confident the match is.
export type CouponImportCandidate = {
  lineId: string;
  invoiceId: string;
  description: string;
  value: number;
  productId: string;
  productName: string;
  matchedBy: "price" | "name";
  customerName: string;
  customerEmail: string;
  currency: string;
  purchasedAt: string;
};
