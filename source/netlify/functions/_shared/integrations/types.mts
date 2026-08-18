/**
 * The vocabulary Clarity uses to talk about external booking systems.
 *
 * Everything in this file is deliberately provider-neutral. A provider adapter
 * translates its own wording into these types once, at the edge; from there
 * inwards nothing knows whether a booking came from Optix, Acuity or anything
 * else.
 *
 * The rule that keeps it that way: **no provider name may appear below this
 * layer.** If the ingest pipeline has to ask "is this Optix?", the adapter
 * interface is missing something — widen the interface rather than adding the
 * check.
 */

export type ExternalProvider = "optix" | "google_calendar" | "acuity" | "setmore";

/**
 * How Clarity reaches a provider: a booking API it can call, or a calendar it
 * can only read. Drives which capabilities are even plausible.
 */
export type ExternalSourceType = "api" | "calendar";

/**
 * What one external booking source can actually do.
 *
 * A capability is false until the code to honour it exists and the data it
 * needs is on hand — claiming one Clarity cannot deliver is how the two systems
 * end up silently disagreeing.
 */
export type ProviderCapabilities = {
  sourceType: ExternalSourceType;
  label: string;
  createExternally: boolean;
  rescheduleExternally: boolean;
  cancelExternally: boolean;
  receiveCreatedEvents: boolean;
  receiveUpdatedEvents: boolean;
  receiveCancelledEvents: boolean;
  /** Why a write capability is off, shown to the admin instead of a dead end. */
  writeBlockedReason?: string;
};

/**
 * What an inbound event *means*, in Clarity's words rather than the sender's.
 *
 * Providers name the same three things differently — Optix says
 * `new_member_booking`, another might say `appointment.scheduled`. The pipeline
 * branches on these canonical kinds, so adding a provider never means editing a
 * switch statement somewhere downstream.
 *
 * "unsupported" is a real answer, not a failure: an event Clarity has no use
 * for is stored and ignored, which is different from one that broke.
 */
export type IntegrationEventKind =
  | "booking.created"
  | "booking.updated"
  | "booking.cancelled"
  | "purchase.sale"
  | "purchase.subscription"
  | "unsupported";

export function isBookingKind(kind: IntegrationEventKind) {
  return kind === "booking.created" || kind === "booking.updated" || kind === "booking.cancelled";
}

export function isPurchaseKind(kind: IntegrationEventKind) {
  return kind === "purchase.sale" || kind === "purchase.subscription";
}

/**
 * An inbound booking, read into the one shape the pipeline understands.
 *
 * `rawEventType` is kept alongside `kind` on purpose: the pipeline reads
 * `kind`, but the event log and the admin UI should still show what the
 * provider actually called it. Throwing that away makes a debugging session
 * guess at the payload.
 */
export type NormalizedBookingEvent = {
  kind: IntegrationEventKind;
  rawEventType: string;
  bookingId: string;
  organisationId: string;
  workspaceId: string;
  workspaceName: string;
  workspaceType: string;
  startIso: string;
  endIso: string;
  timezone: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  source: string;
};

/** An inbound purchase — a pass, a package, a plan — in neutral terms. */
export type NormalizedPurchaseEvent = {
  kind: IntegrationEventKind;
  rawEventType: string;
  purchaseId: string;
  /** The receipt reference a buyer sees, if the provider sends one. */
  saleNumber: string;
  memberEmail: string;
  memberName: string;
  itemName: string;
  /** Everything describing what was bought, joined — used for classification. */
  descriptor: string;
  quantity: number | null;
  amountCents: number | null;
  unitAmountCents: number | null;
  currency: string;
  purchasedAt: string;
};

/**
 * How a booking maps onto Clarity, once a provider's workspace is recognised.
 *
 * Named for what it does rather than who sends it: an Optix "workspace", an
 * Acuity "calendar" and a Setmore "service" all land here as workspaceId.
 */
export type IntegrationEmailBehaviour = "none" | "immediate" | "after_bay";

export type IntegrationMapping = {
  id?: string;
  provider: ExternalProvider;
  organisationId: string;
  workspaceId: string;
  workspaceName: string;
  accountId: string;
  locationId: string;
  defaultCoachId: string | null;
  enabled: boolean;
  expectedDuration: number | null;
  bayProfileId: string | null;
  emailBehaviour: IntegrationEmailBehaviour;
};

/**
 * Everything Clarity needs to know about one external system.
 *
 * Two required methods, because two things genuinely cannot be described in
 * config: what a payload's fields are called, and what its event names mean.
 * Everything else about a provider — what it can do, what its credentials are —
 * is data, and lives in the capability registry. An adapter deliberately does
 * *not* carry its own capabilities: one source of truth, reached through
 * `providerCapabilities(adapter.id)`.
 *
 * `normalizePurchase` is optional: a provider that only sends bookings should
 * not have to stub it out.
 */
export type ProviderAdapter = {
  id: ExternalProvider;
  label: string;
  /** Classify a raw payload without paying to normalise it. */
  eventKind(payload: unknown): IntegrationEventKind;
  normalizeBooking(payload: unknown): NormalizedBookingEvent;
  normalizePurchase?(payload: unknown): NormalizedPurchaseEvent;
  /**
   * Prefix for the Clarity calendar item ids this provider creates. Kept so an
   * id stays readable in a database row without a join.
   */
  itemIdPrefix: string;
};
