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

export type BillingCatalogKind = "service" | "product" | "package" | "lesson-type";

export type BillingCatalogItem = {
  id: string;
  kind: BillingCatalogKind;
  name: string;
  description: string;
  price: number;
  taxRate: number;
  sourceServiceId?: string;
  active?: boolean;
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
// sale opened from a client profile; "counter" is a walk-up sale.
export type PosTransactionSource = "lesson" | "client" | "counter";

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
  paidAt: string;
  createdAt: string;
  updatedAt: string;
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
