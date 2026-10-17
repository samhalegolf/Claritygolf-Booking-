// Billing's sections and groups: the sub-nav as data, and the names things
// are called in it. Shared by the Billing screen, the invoice editor and the
// Business Hub cards that link into a section.
import { Package, Plus, RefreshCw, Sparkles } from "lucide-react";
import { t } from "../../lib/i18n";
import {
  ClarityBookingPages,
  ClarityDashboardHome,
  ClarityIntegrations,
  ClarityInvoices,
  ClarityPassesCredits,
  ClarityPayments,
  ClarityProducts,
  ClarityReports,
  ClaritySettings,
  ClarityStore,
  type IconComponent,
} from "../shared/ClarityIcons";

export type BillingSection =
  | "none"
  | BillingGroup
  | "dashboard"
  | "new-invoice"
  | "invoices"
  | "products-new"
  | "products-catalog"
  | "products-orders"
  | "products-integrations"
  | "expenses-log"
  | "expenses-records"
  | "expenses-integrations"
  | "vouchers-issue"
  | "vouchers-edit"
  | "vouchers-records"
  | "vouchers-integrations"
  | "passes-issue"
  | "passes-edit"
  | "passes-records"
  | "bundles"
  | "reports"
  | "transactions"
  | "memberships"
  | "rewards"
  | "settings";

// Products, Expenses, Vouchers and Passes. A group on its own is the group's
// page with every section folded shut.
export type BillingGroup = "products" | "expenses" | "vouchers" | "passes";

/**
 * Billing's sub-nav, as data -- the same shape as SETTINGS_SECTIONS, so the
 * side column, the topbar's subtitle and the coach profile's "does this
 * section exist" check all read one list and cannot drift apart.
 *
 * Products, Expenses, Vouchers and Passes are groups, laid out like a
 * Settings tab: one row in the side column, and its sections as fold-out
 * blocks beside it, all shut until one is opened.
 */
export const BILLING_SECTION_NAV: Array<{
  key: Exclude<BillingSection, "none">;
  label: string;
  icon: IconComponent;
  group?: BillingGroup;
}> = [
  { key: "dashboard", label: t("Dashboard"), icon: ClarityDashboardHome },
  { key: "new-invoice", label: t("New Invoice"), icon: ClarityBookingPages },
  { key: "invoices", label: t("Invoices"), icon: ClarityInvoices },
  { key: "products-new", label: t("New Product"), icon: Plus, group: "products" },
  { key: "products-catalog", label: t("Catalog"), icon: ClarityProducts, group: "products" },
  { key: "products-orders", label: t("Orders"), icon: ClarityPayments, group: "products" },
  { key: "products-integrations", label: t("Integrations"), icon: ClarityIntegrations, group: "products" },
  { key: "expenses-log", label: t("Log An Expense"), icon: Plus, group: "expenses" },
  { key: "expenses-records", label: t("Expense Log"), icon: ClarityStore, group: "expenses" },
  { key: "expenses-integrations", label: t("Integrations"), icon: ClarityIntegrations, group: "expenses" },
  { key: "vouchers-issue", label: t("Issue Voucher"), icon: Plus, group: "vouchers" },
  { key: "vouchers-edit", label: t("Create or Edit Vouchers"), icon: ClarityProducts, group: "vouchers" },
  { key: "vouchers-records", label: t("Voucher Records"), icon: ClarityPassesCredits, group: "vouchers" },
  { key: "vouchers-integrations", label: t("Integrations"), icon: ClarityIntegrations, group: "vouchers" },
  { key: "passes-issue", label: t("Issue or Redeem Passes"), icon: Plus, group: "passes" },
  { key: "passes-edit", label: t("Create or Edit Passes"), icon: ClarityProducts, group: "passes" },
  { key: "passes-records", label: t("Pass Records"), icon: ClarityPassesCredits, group: "passes" },
  { key: "bundles", label: t("Bundles"), icon: Package },
  { key: "transactions", label: t("Transaction History"), icon: ClarityPayments },
  { key: "memberships", label: t("Memberships"), icon: RefreshCw },
  { key: "rewards", label: t("Rewards"), icon: Sparkles },
  { key: "reports", label: t("Reports"), icon: ClarityReports },
  { key: "settings", label: t("Settings"), icon: ClaritySettings },
];

export const BILLING_GROUPS: Array<{ key: BillingGroup; label: string; icon: IconComponent }> = [
  { key: "products", label: t("Products"), icon: ClarityProducts },
  { key: "expenses", label: t("Expenses"), icon: ClarityStore },
  { key: "vouchers", label: t("Vouchers"), icon: ClarityPayments },
  { key: "passes", label: t("Passes"), icon: ClarityPassesCredits },
];

export function isBillingSection(value: unknown): value is Exclude<BillingSection, "none"> {
  return BILLING_SECTION_NAV.some((entry) => entry.key === value) || BILLING_GROUPS.some((group) => group.key === value);
}

/** The group a section is filed under -- or the group itself, when its page is open with nothing unfolded. */
export function billingGroupOf(section: BillingSection): BillingGroup | undefined {
  const group = BILLING_GROUPS.find((candidate) => candidate.key === section);
  if (group) return group.key;
  return BILLING_SECTION_NAV.find((candidate) => candidate.key === section)?.group;
}

export function billingGroupLabel(group: BillingGroup) {
  return BILLING_GROUPS.find((candidate) => candidate.key === group)?.label ?? "";
}

// A grouped section reads as "Group › Section" wherever it stands alone, so
// three rows all called Integrations still say whose they are.
export function billingSectionLabel(section: Exclude<BillingSection, "none">) {
  const entry = BILLING_SECTION_NAV.find((candidate) => candidate.key === section);
  if (!entry) return billingGroupLabel(section as BillingGroup);
  return entry.group ? `${billingGroupLabel(entry.group)} › ${entry.label}` : entry.label;
}

// Which completed bookings the "ready to pull" lists show.
//
// "all" is the default because a counter payment no longer settles a lesson for
// invoicing purposes - see addCompletedBookingLine. Taking payment at the till
// and invoicing the range for the same lesson are two different transactions,
// so a paid lesson has to stay in the working list.
//
// "unpaid" is for the other way of working: treat a counter payment as the end
// of it and only ever invoice what has not been paid. "paid" is for looking
// back at what has been settled.
export type BookingPullFilter = "unpaid" | "all" | "paid";
// v2: the stored value is deliberately re-keyed. Everyone currently has
// "unpaid" saved from when that was the default, and reusing the old key would
// leave them with paid lessons hidden from a list that now expects to show them.
export const BOOKING_PULL_FILTER_STORAGE_KEY = "clarity.billing.pullFilter.v2";

export function readStoredPullFilter(): BookingPullFilter {
  if (typeof window === "undefined") return "all";
  const stored = window.localStorage.getItem(BOOKING_PULL_FILTER_STORAGE_KEY);
  return stored === "unpaid" || stored === "paid" ? stored : "all";
}
