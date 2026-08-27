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
  providerCustomerId: string;
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
 * Every integration Clarity knows about.
 *
 * Wider than ExternalProvider, which is only the booking systems that send us
 * events and therefore need an adapter. Stripe, Akahu, Resend and Caddy are
 * integrations with credentials and a health story but nothing to normalise.
 */
export type IntegrationId =
  | ExternalProvider
  | "google-calendar"
  | "google-drive"
  | "stripe"
  | "akahu"
  | "resend"
  | "caddy";

/**
 * Whose decision this is.
 *
 * The distinction that matters most and was missing entirely: some of these are
 * the software, and some are things a coach chooses to plug into it.
 *
 *   admin        Clarity runs on it. Resend sends the email, Drive holds the
 *                video, Caddy is the sibling app. A coach never picks these and
 *                mostly cannot change them.
 *   integration  The coach's own account, connected because they want it —
 *                their calendar, their range's booking system, their bank.
 *
 * Both are credentials on a screen, which is why they were filed together. They
 * answer completely different questions.
 */
export type IntegrationAudience = "admin" | "integration";

/**
 * What an integration is FOR, in the coach's words.
 *
 * The admin ones are grouped by what part of the software they are; the
 * integration ones by the job a coach is trying to do, because "I want my
 * lessons in my calendar" is how somebody arrives at this screen — not "I want
 * to configure an OAuth2 connection".
 */
export type IntegrationCategory =
  // Things a coach connects.
  | "calendar"
  | "resource-booking"
  | "accounting"
  | "payments"
  // Things Clarity runs on.
  | "email"
  | "storage"
  | "billing"
  | "clarity-apps";

/**
 * The six field types every integration is built from.
 *
 * `copy` is the one worth pausing on: it travels the other way. It is a fact
 * about Clarity that the other system needs — a webhook URL, a redirect URI,
 * the list of events to subscribe to. Direction is a property of the field
 * rather than of the screen it lands on, which is what lets one renderer draw
 * both columns of a setup pane without being told which side it is drawing.
 */
export type FieldType = "copy" | "text" | "secret" | "url" | "choice" | "oauth";

/**
 * How a `copy` field's value is worked out. These cannot be literals: the
 * webhook URL depends on which deployment is asking.
 */
export type FieldCompute = "webhook-url" | "redirect-uri" | "event-list" | "signature-recipe";

export type FieldSpec = {
  /** The environment variable holding it today. */
  key: string;
  type: FieldType;
  label: string;
  /**
   * Where to find it on their side, and what breaks without it.
   *
   * Not optional, and not decoration. "OPTIX_APP_SECRET" tells an admin
   * nothing; "Optix › Apps › your app › Secret — without it every incoming
   * webhook is rejected as unsigned" tells them where to look and what breaks.
   * The setup screen is the only documentation anyone reads.
   */
  help: string;
  /**
   * "one-of" means this field and its `group` partners are satisfied by any
   * one of them being set. Optix takes an organisation token OR a personal
   * token; Stripe's billing webhook secret falls back to the general one.
   * Plain `required` gets both of those wrong in both directions.
   */
  required: boolean | "one-of";
  group?: string;
  defaultValue?: string;
  choices?: Array<{ value: string; label: string }>;
  compute?: FieldCompute;
};

/**
 * The five shapes an integration comes in.
 *
 * All five were already in the codebase before they had names — this is a
 * description of what is there, not a framework laid over it.
 *
 *   webhook-in     they push to us          Optix, Stripe
 *   api-token      we call with a token     Optix, Resend, Caddy
 *   api-key-pair   two keys, two jobs       Akahu, Stripe
 *   oauth2         they hand us a token     Google
 *   service-link   shared secret with a peer Caddy
 *
 * A new kind earns its name when a SECOND integration needs it. service-link
 * has one member and is on probation: if nothing else ever links to a peer
 * service it should collapse into api-token, which is nearly what it is.
 */
export type ConnectionKind = "webhook-in" | "api-token" | "api-key-pair" | "oauth2" | "service-link";

export type ConnectionSpec = {
  kind: ConnectionKind;
  title: string;
  /** One line under the title. What this half of the connection is for. */
  summary: string;
  fields: FieldSpec[];
  /** webhook-in: the path Clarity listens on. */
  path?: string;
  /** webhook-in: which events to subscribe to. Nothing else is read. */
  events?: Array<{ id: string; label: string; note?: string }>;
  /** webhook-in: how a delivery is signed, in plain arithmetic. */
  signatureRecipe?: string;
  /** api-*: what Clarity asks the other system to do. */
  operations?: Array<{ id: string; label: string }>;
  transport?: "graphql" | "rest";
};

/**
 * One integration, whole.
 *
 * An integration is one or more connections, not one — Optix is a webhook
 * receiver AND an API client, Stripe likewise. That is why a connection is a
 * set of fields rather than a screen.
 *
 * `adapter` is absent for most of them, and that is the point: an integration
 * with no events to interpret is still a complete integration. Four of the six
 * are outbound only.
 */
export type IntegrationDescriptor = {
  id: IntegrationId;
  label: string;
  audience: IntegrationAudience;
  category: IntegrationCategory;
  /** One line on the card, before anything is opened. */
  summary: string;
  docsUrl?: string;
  connections: ConnectionSpec[];
  /** What this provider calls the things a mapping points at. */
  vocabulary?: { workspace: string; resource: string };
  /**
   * Two entries over one authorisation.
   *
   * Google is a single OAuth grant doing two jobs: the coach's calendar and
   * Clarity's video storage. Filing it once would put "connect my diary" in an
   * admin area, or Clarity's storage in the coach's list. It is listed twice
   * and connected once, and this is the id of the entry that owns the consent.
   */
  sharesGrantWith?: IntegrationId;
  /** Something true about this integration that is not a field. */
  caveat?: string;
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
   * Why this event is none of Clarity's business, if it isn't.
   *
   * A provider can deliver events that are structurally valid but are not
   * Clarity's to act on — a mirror of a calendar Clarity does not own, another
   * system's traffic passing through the same webhook. Only the adapter can
   * tell, because recognising them means reading the provider's own wording.
   *
   * A reason here is a *stated negative result*, not a failure: the event is
   * stored, marked ignored with this code, and never retried. Returning null
   * (or omitting the method) means the event is Clarity's to process.
   */
  ignoreReason?(payload: unknown): { code: string; message: string } | null;
  /**
   * Prefix for the Clarity calendar item ids this provider creates. Kept so an
   * id stays readable in a database row without a join.
   */
  itemIdPrefix: string;
  /** Everything the setup screens need to render themselves. */
  descriptor: IntegrationDescriptor;
};
