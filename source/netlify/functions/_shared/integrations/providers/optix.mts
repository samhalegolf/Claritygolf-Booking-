/**
 * The Optix adapter.
 *
 * This is the only file in the integration stack that knows what Optix calls
 * things. Its whole job is translation: Optix's event names become canonical
 * kinds, Optix's field names become the normalized shapes in ../types.mts, and
 * nothing downstream has to ask which provider it is dealing with.
 *
 * When Optix changes a payload, this file changes. If a payload change ever
 * forces an edit outside this file, the adapter interface is missing something.
 */

import { amountInCents, iso, pick, text } from "../payload.mts";
import type {
  IntegrationEventKind,
  NormalizedBookingEvent,
  NormalizedPurchaseEvent,
  ProviderAdapter,
  ProviderDescriptor,
} from "../types.mts";

/**
 * Optix's event names, mapped onto what they mean.
 *
 * Only two events describe what was actually bought:
 *
 *   new_sale               a one-off product sale — product, quantity,
 *                          unit_amount, tax, total
 *   new_plan_subscription  a recurring plan — plan_template_name, price,
 *                          deposit, set_up_fee, subscribers[]
 *
 * A Pass is a one-time purchase granting allowance, so it arrives as new_sale.
 * new_plan_subscription is recorded anyway, because a plan is the thing a Pass
 * is most easily confused with and seeing both side by side is what makes a
 * misclassification obvious.
 *
 * invoice_paid is deliberately absent: its six keys carry no purchase detail,
 * and with no invoice_id on a sale there is nothing to join it to. It falls
 * through to "unsupported" and is stored as ignored.
 */
const EVENT_KINDS: Record<string, IntegrationEventKind> = {
  new_member_booking: "booking.created",
  member_booking_updated: "booking.updated",
  member_booking_cancelled: "booking.cancelled",
  new_sale: "purchase.sale",
  new_plan_subscription: "purchase.subscription",
};

export function optixRawEventType(payload: any) {
  return text(pick(payload, "event", "event_type"));
}

export function optixEventKind(payload: unknown): IntegrationEventKind {
  return EVENT_KINDS[optixRawEventType(payload)] || "unsupported";
}

/**
 * An Optix booking webhook, read into the neutral shape.
 *
 * Every field lists the paths seen in real payloads, most specific first.
 * Optix posts form-encoded webhooks whose field names vary by event type and
 * have changed shape between versions (member.email vs member_email vs email),
 * so each lookup is deliberately generous.
 */
export function normalizeOptixBooking(payload: any): NormalizedBookingEvent {
  return {
    kind: optixEventKind(payload),
    rawEventType: optixRawEventType(payload),
    bookingId: text(pick(payload, "booking_id", "booking.id", "id")),
    organisationId: text(pick(payload, "organization_id", "organisation_id", "booking.organization_id", "booking.organisation_id")),
    workspaceId: text(pick(payload, "workspace_id", "workspace.id", "booking.workspace_id", "booking.workspace.id")),
    workspaceName: text(pick(payload, "workspace_name", "workspace.name", "booking.workspace_name", "booking.workspace.name")),
    workspaceType: text(pick(payload, "workspace_type", "workspace.type", "booking.workspace_type", "booking.workspace.type")),
    startIso: iso(pick(payload, "check_in_timestamp", "booking.check_in_timestamp", "start_timestamp", "start")),
    endIso: iso(pick(payload, "check_out_timestamp", "booking.check_out_timestamp", "end_timestamp", "end")),
    timezone: text(pick(payload, "timezone", "time_zone", "booking.timezone")) || "Pacific/Auckland",
    firstName: text(pick(payload, "member.first_name", "member_name", "member_first_name", "customer.first_name", "first_name")),
    lastName: text(pick(payload, "member.last_name", "member_last_name", "customer.last_name", "last_name")),
    email: text(pick(payload, "member.email", "member_email", "customer.email", "email")).toLowerCase(),
    phone: text(pick(payload, "member.phone", "member.phone_number", "member_phone", "customer.phone", "phone")),
    source: text(pick(payload, "source")) || "Optix webhook",
  };
}

/**
 * An Optix purchase event, read into the neutral shape.
 *
 * The two purchase payloads share almost nothing, so each field name is listed
 * once against the event that sends it and the reader takes the first that
 * resolves.
 *
 * Worth knowing about new_sale (first seen 18 Aug 2026): it carries NO
 * invoice_id, no email and no currency, despite Optix's docs listing
 * invoice_id. What it does carry: product, quantity, unit_amount, tax, total,
 * product_sale_id, number (the Optix sale number, "00652"), account and
 * user_name. The buyer is a display name only, so a sale cannot be auto-linked
 * to a Clarity client the way a booking is.
 */
export function normalizeOptixPurchase(payload: any): NormalizedPurchaseEvent {
  const itemName = text(pick(
    payload,
    // new_sale: the product itself, not invoice_item_name ("Sale of X (#123)").
    "product",
    // new_plan_subscription: the template is the product; "name" is this
    // subscriber's instance of it ("Plan A for Jean").
    "plan_template_name", "name",
  ));
  const descriptor = [
    itemName,
    text(pick(payload, "invoice_item_name")),
    text(pick(payload, "description")),
  ].filter(Boolean).join(" ");
  const subscriber = (payload?.subscribers as any[] | undefined)?.[0];
  return {
    kind: optixEventKind(payload),
    rawEventType: optixRawEventType(payload),
    purchaseId: text(pick(payload, "product_sale_id", "account_plan_id")),
    saleNumber: text(pick(payload, "number")),
    // Only new_plan_subscription identifies the buyer by email.
    memberEmail: text(pick(subscriber || {}, "email")).toLowerCase(),
    memberName: text(pick(payload, "user_name")) || text(pick(subscriber || {}, "user_fullname")),
    itemName,
    descriptor,
    quantity: quantityOf(pick(payload, "quantity")),
    // new_sale totals include tax; a plan's price does not, but Optix sends no
    // tax on a plan either, so total is the best each event has.
    amountCents: amountInCents(pick(payload, "total", "price")),
    unitAmountCents: amountInCents(pick(payload, "unit_amount")),
    currency: text(pick(payload, "currency")).toUpperCase(),
    purchasedAt: iso(pick(payload, "created_timestamp")),
  };
}

/** Optix sends quantity as "1.0000". Null when absent or unusable. */
function quantityOf(value: unknown) {
  const raw = text(value);
  if (!raw) return null;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * What the setup screens show for Optix.
 *
 * Every credential lists where to find it on Optix's side and what breaks
 * without it, because the setup screen is the only documentation anyone will
 * read. Nothing here is a secret — the values live in the environment; this
 * only describes them.
 */
const optixDescriptor: ProviderDescriptor = {
  id: "optix",
  label: "Optix",
  docsUrl: "https://developer.optixapp.com",
  webhook: {
    path: "/api/optix-webhook",
    events: [
      { id: "new_member_booking", label: "Booking created" },
      { id: "member_booking_updated", label: "Booking updated" },
      { id: "member_booking_cancelled", label: "Booking cancelled" },
      { id: "new_sale", label: "Product sale", note: "Pass purchases arrive here" },
      { id: "new_plan_subscription", label: "Plan started", note: "Recorded, never treated as a Pass" },
    ],
    credentials: [
      {
        key: "OPTIX_CLIENT_ID",
        label: "Client ID",
        help: "Optix › Apps › your app › ID. Every payload carries this; a delivery whose client_id does not match is rejected.",
        secret: false,
        required: true,
      },
      {
        key: "OPTIX_APP_SECRET",
        label: "App secret",
        help: "Optix › Apps › your app › Secret. Signs every delivery. Without it, or with a stray space on the end, every incoming webhook is rejected as unsigned.",
        secret: true,
        required: true,
      },
    ],
    signatureRecipe: "sha256(client_id + app_secret + created_timestamp)",
  },
  api: {
    kind: "graphql",
    credentials: [
      {
        key: "OPTIX_GRAPHQL_ENDPOINT",
        label: "GraphQL endpoint",
        help: "The default is correct unless Optix has moved you.",
        secret: false,
        required: false,
        defaultValue: "https://api.optixapp.com/graphql",
      },
      {
        key: "OPTIX_ORGANIZATION_TOKEN",
        label: "Organisation token",
        help: "Optix › Settings › API. Preferred over the personal token. Set one or the other, never both — which one is present decides how Optix reads the request.",
        secret: true,
        required: false,
      },
      {
        key: "OPTIX_PERSONAL_TOKEN",
        label: "Personal token",
        help: "The fallback when no organisation token is set. One of the two is required for bay booking to work at all.",
        secret: true,
        required: false,
      },
      {
        key: "OPTIX_MEMBER_ID",
        label: "Member ID",
        help: "Who a bay booking is made as.",
        secret: false,
        required: true,
      },
      {
        key: "OPTIX_OWNER_USER_ID",
        label: "Owner user ID",
        help: "Who owns the resulting booking inside Optix.",
        secret: false,
        required: true,
      },
    ],
    operations: [
      { id: "bookingsDraft", label: "Check a bay is free" },
      { id: "bookingsCommit", label: "Book a bay" },
      { id: "bookingsCancel", label: "Release a bay" },
    ],
  },
  vocabulary: { workspace: "workspace", resource: "bay" },
};

export const optixAdapter: ProviderAdapter = {
  id: "optix",
  label: "Optix",
  itemIdPrefix: "optix",
  eventKind: optixEventKind,
  normalizeBooking: normalizeOptixBooking,
  normalizePurchase: normalizeOptixPurchase,
  descriptor: optixDescriptor,
};
