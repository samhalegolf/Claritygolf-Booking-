// Memberships: the shapes /api/memberships answers with, and the calls that
// change them. The server (netlify/functions/_shared/memberships.mts) decides
// every amount, date and status; nothing here works out what anybody owes.

import { t, tn, readerLocale } from "../../lib/i18n";

export type BillingInterval = "week" | "month" | "year";
export type RolloverPolicy = "expire_each_period" | "rollover" | "rollover_capped";

export type MembershipEntitlement = {
  id: string;
  name: string;
  serviceIds: string[];
  credits: number;
  rollover: RolloverPolicy;
  maxBalance: number | null;
};

export type MembershipPlan = {
  id: string;
  name: string;
  description: string;
  active: boolean;
  sellOnline: boolean;
  priceCents: number;
  currency: string;
  interval: BillingInterval;
  intervalCount: number;
  anchor: "signup" | "day_of_month";
  anchorDay: number | null;
  prorateFirst: boolean;
  signupFeeCents: number;
  trialDays: number;
  termCycles: number | null;
  minCycles: number;
  failedPaymentAction: "pause" | "cancel";
  entitlements: MembershipEntitlement[];
  memberCount?: number;
};

export type MembershipStatus = "incomplete" | "trialing" | "active" | "past_due" | "paused" | "cancelled" | "ended";

export type MembershipCharge = {
  id: string;
  cycleNumber: number;
  periodStart: string;
  periodEnd: string;
  amountCents: number;
  signupFeeCents: number;
  currency: string;
  description: string;
  status: "pending" | "processing" | "paid" | "failed" | "requires_action" | "waived" | "void" | "refunded";
  attempts: number;
  lastError: string;
  paidAt: string | null;
  paidVia: string;
  note: string;
};

export type Membership = {
  id: string;
  personId: string;
  personName: string;
  personEmail: string;
  planId: string;
  plan: MembershipPlan;
  status: MembershipStatus;
  collection: "card" | "manual";
  cardLabel: string;
  startedAt: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  nextChargeAt: string | null;
  cancelAtPeriodEnd: boolean;
  cancelReason: string;
  endedAt: string | null;
  pausedAt: string | null;
  failedAttempts: number;
  paidCycles: number;
  memberMayCancel: boolean;
  outstandingCents: number;
  note: string;
  createdAt: string;
  charges: MembershipCharge[];
};

export type MembershipSummary = {
  members: number;
  trialing: number;
  pastDue: number;
  paused: number;
  mrr: Array<{ currency: string; cents: number }>;
  awaitingPayment: number;
  collected30d: Array<{ currency: string; cents: number }>;
};

export type MembershipsResponse = {
  plans: MembershipPlan[];
  memberships: Membership[];
  summary: MembershipSummary | null;
  cardsReady: boolean;
  currency: string;
};

export type MembershipActionName =
  | "cancel_at_period_end"
  | "undo_cancel"
  | "end_now"
  | "pause"
  | "resume"
  | "retry"
  | "use_manual";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message || t("Something went wrong."));
  return data as T;
}

const post = <T,>(url: string, body: unknown) => request<T>(url, { method: "POST", body: JSON.stringify(body) });

export const membershipsApi = {
  load: (personId?: string) =>
    request<MembershipsResponse>(`/api/memberships${personId ? `?personId=${encodeURIComponent(personId)}` : ""}`),
  savePlan: (plan: Partial<MembershipPlan>) => post<{ plans: MembershipPlan[] }>("/api/memberships/plans", { plan }),
  archivePlan: (id: string) =>
    request<{ plans: MembershipPlan[] }>(`/api/memberships/plans?id=${encodeURIComponent(id)}`, { method: "DELETE" }),
  enrol: (input: { personId: string; planId: string; startDate?: string; collection: "card" | "manual"; note?: string }) =>
    post<{ membership: Membership; checkoutUrl: string }>("/api/memberships/enrol", input),
  action: (membershipId: string, action: MembershipActionName, reason?: string) =>
    post<{ membership: Membership }>("/api/memberships/action", { membershipId, action, reason }),
  charge: (chargeId: string, action: "mark_paid" | "waive" | "void", via?: string, note?: string) =>
    post<{ membership: Membership }>("/api/memberships/charge", { chargeId, action, via, note }),
  cardLink: (membershipId: string) => post<{ url: string }>("/api/memberships/card-link", { membershipId }),
};

// ---------------------------------------------------------------------------
// Wording, shared by the coach screens and the player portal
// ---------------------------------------------------------------------------

export function intervalLabel(interval: BillingInterval, count: number) {
  if (interval === "week") return tn(count, "every week", "every {count} weeks");
  if (interval === "year") return tn(count, "every year", "every {count} years");
  return tn(count, "every month", "every {count} months");
}

export function statusLabel(membership: Pick<Membership, "status" | "cancelAtPeriodEnd">) {
  if (membership.cancelAtPeriodEnd && ["trialing", "active", "past_due"].includes(membership.status)) {
    return t("Ending");
  }
  switch (membership.status) {
    case "incomplete":
      return t("Waiting for card");
    case "trialing":
      return t("Trial");
    case "active":
      return t("Active");
    case "past_due":
      return t("Payment failed");
    case "paused":
      return t("Paused");
    case "cancelled":
      return t("Cancelled");
    default:
      return t("Ended");
  }
}

/** The same pills the invoice table uses, so a membership reads like the rest of Billing. */
export function statusPillClass(status: MembershipStatus) {
  if (status === "active" || status === "trialing") return "invoice-status-paid";
  if (status === "past_due") return "invoice-status-overdue";
  if (status === "cancelled" || status === "ended") return "invoice-status-void";
  return "invoice-status-published";
}

/** Stored in English on the charge, so a report reads the same whoever recorded it; shown in the reader's language. */
export const PAYMENT_METHODS = [
  { value: "Cash", label: () => t("Cash") },
  { value: "Bank transfer", label: () => t("Bank transfer") },
  { value: "Card at the till", label: () => t("Card at the till") },
  { value: "Other", label: () => t("Other") },
];

function paymentMethodLabel(value: string) {
  return PAYMENT_METHODS.find((method) => method.value === value)?.label() ?? value;
}

export function chargeStatusLabel(charge: MembershipCharge) {
  switch (charge.status) {
    case "paid":
      if (charge.paidVia === "trial") return t("Trial");
      if (charge.paidVia === "free") return t("Free");
      return charge.paidVia === "card" ? t("Paid by card") : t("Paid · {method}", { method: paymentMethodLabel(charge.paidVia) });
    case "waived":
      return t("Waived");
    case "pending":
      return t("Due");
    case "processing":
      return t("Processing");
    case "failed":
      return t("Failed");
    case "requires_action":
      return t("Needs the member");
    case "refunded":
      return t("Refunded");
    default:
      return t("Cancelled");
  }
}

export function dateLabel(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(readerLocale(), { day: "numeric", month: "short", year: "numeric" });
}

export function rolloverLabel(policy: RolloverPolicy) {
  if (policy === "rollover") return t("Unused credits carry over");
  if (policy === "rollover_capped") return t("Carry over, up to a limit");
  return t("Use them or lose them each period");
}
