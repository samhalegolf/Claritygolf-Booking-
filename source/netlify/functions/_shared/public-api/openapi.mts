/**
 * The OpenAPI 3.1 description of /api/v1, served at /api/v1/openapi.json.
 *
 * This is what makes the API connect to "as much as possible" without Clarity
 * writing a connector for each thing: Postman, Insomnia, Zapier's and Make's
 * custom-app builders, Microsoft Power Automate custom connectors, n8n, and
 * every OpenAPI code generator read this file directly.
 *
 * Kept by hand next to routes.mts. The test in public-api.test.mts fails if a
 * route exists that this spec does not describe.
 */
import { API_SCOPES, SCOPE_LABELS } from "./keys.mts";
import { EVENT_TYPES } from "./events.mts";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const listOf = (name: string) => ({
  type: "object",
  properties: {
    object: { const: "list" },
    data: { type: "array", items: ref(name) },
    has_more: { type: "boolean" },
    next_cursor: { type: ["string", "null"], description: "Pass as `cursor` to get the next page." },
  },
});
const idParam = (name: string) => ({ name: "id", in: "path", required: true, schema: { type: "string" }, description: `The ${name} id.` });
const query = (name: string, description: string, schema: Record<string, unknown> = { type: "string" }) => ({
  name,
  in: "query",
  required: false,
  schema,
  description,
});
const paging = [
  query("limit", "Page size, 1-100. Default 25.", { type: "integer", minimum: 1, maximum: 100 }),
  query("cursor", "The `next_cursor` from the previous page."),
];
const json = (schema: unknown) => ({ content: { "application/json": { schema } } });
const errors = {
  "400": { description: "Invalid request", ...json(ref("Error")) },
  "401": { description: "Missing or invalid API key", ...json(ref("Error")) },
  "403": { description: "The key lacks the scope this route needs", ...json(ref("Error")) },
  "404": { description: "Not found", ...json(ref("Error")) },
  "429": { description: "Rate limited", ...json(ref("Error")) },
};
const op = (
  operationId: string,
  summary: string,
  scope: string | null,
  response: unknown,
  extra: Record<string, unknown> = {},
) => ({
  operationId,
  summary,
  ...(scope ? { security: [{ apiKey: [scope] }], "x-required-scope": scope } : {}),
  responses: { "200": { description: "OK", ...json(response) }, ...errors },
  ...extra,
});
const idempotencyHeader = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  schema: { type: "string", maxLength: 255 },
  description: "Any unique string. Retrying with the same key returns the first response instead of acting twice. Kept 24 hours.",
};

const Ref = { type: ["object", "null"], properties: { id: { type: "string" }, name: { type: "string" } } };
const DateTime = { type: "string", format: "date-time" };

export function openApiSpec(origin: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Clarity API",
      version: "v1",
      description:
        "Read and write a Clarity business's bookings, clients, passes, invoices, lesson types, coaches, locations and availability, " +
        "and receive webhooks when they change. Authenticate with an API key from Settings › API & webhooks, sent as " +
        "`Authorization: Bearer ck_live_…` (or `ck_test_…` for a sandbox). Times are ISO 8601 with an offset; money is in " +
        "minor units (cents). Lists page with `limit` and `cursor`. Errors are `{ error: { type, code, message, param, request_id } }`.",
    },
    servers: [{ url: `${origin}/api/v1` }],
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description: `API key. Scopes: ${API_SCOPES.map((scope) => `\`${scope}\` (${SCOPE_LABELS[scope]})`).join(", ")}.`,
        },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: [
                    "invalid_request_error", "authentication_error", "permission_error", "not_found_error",
                    "conflict_error", "rate_limit_error", "idempotency_error", "api_error",
                  ],
                },
                code: { type: "string" },
                message: { type: "string" },
                param: { type: "string" },
                request_id: { type: "string" },
              },
            },
          },
        },
        Account: {
          type: "object",
          properties: {
            object: { const: "account" }, id: { type: "string" }, name: { type: "string" },
            livemode: { type: "boolean" }, timezone: { type: "string" }, currency: { type: "string" },
            country: { type: "string" },
            api_key: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, scopes: { type: "array", items: { type: "string" } } } },
          },
        },
        Booking: {
          type: "object",
          properties: {
            object: { const: "booking" },
            id: { type: "string" },
            status: { type: "string", enum: ["booked", "completed", "cancelled", "no_show"] },
            start: DateTime, end: DateTime, timezone: { type: "string" },
            duration_minutes: { type: "integer" },
            service: Ref, coach: Ref, location: Ref,
            client: {
              type: "object",
              properties: {
                id: { type: ["string", "null"] }, name: { type: "string" }, email: { type: "string" }, phone: { type: "string" },
              },
            },
            notes: { type: "string" },
            origin: { type: "string", description: "clarity, or the system it was synced in from (optix, google)." },
            external_id: { type: ["string", "null"] },
            deleted: { type: "boolean", description: "Only on events: the booking was removed outright." },
            created_at: DateTime, updated_at: DateTime,
          },
        },
        Client: {
          type: "object",
          properties: {
            object: { const: "client" }, id: { type: "string" }, name: { type: "string" }, email: { type: "string" },
            phone: { type: "string" }, notes: { type: "string" }, source: { type: "string" },
            created_at: DateTime, updated_at: DateTime,
          },
        },
        Service: {
          type: "object",
          properties: {
            object: { const: "service" }, id: { type: "string" }, name: { type: "string" }, description: { type: "string" },
            duration_minutes: { type: "integer" },
            price: { type: ["object", "null"], properties: { amount: { type: "integer" }, currency: { type: "string" } } },
            price_mode: { type: "string" }, format: { type: "string", enum: ["private", "group", "package", "video-review"] },
            capacity: { type: "integer" }, active: { type: "boolean" },
            bookable_online: { type: "boolean", description: "Can be booked through the API and the booking page." },
            coach_ids: { type: "array", items: { type: "string" } }, location_ids: { type: "array", items: { type: "string" } },
          },
        },
        Coach: {
          type: "object",
          properties: {
            object: { const: "coach" }, id: { type: "string" }, name: { type: "string" }, email: { type: "string" },
            bio: { type: "string" }, photo_url: { type: ["string", "null"] }, active: { type: "boolean" },
            bookable: { type: "boolean" }, location_ids: { type: "array", items: { type: "string" } },
          },
        },
        Location: {
          type: "object",
          properties: {
            object: { const: "location" }, id: { type: "string" }, name: { type: "string" }, address: { type: "string" },
            timezone: { type: "string" }, kind: { type: "string" }, active: { type: "boolean" }, is_default: { type: "boolean" },
          },
        },
        Slot: {
          type: "object",
          properties: {
            object: { const: "slot" }, start: DateTime, end: DateTime, timezone: { type: "string" },
            service_id: { type: "string" }, coach_id: { type: ["string", "null"] }, location_id: { type: ["string", "null"] },
            remaining_spots: { type: "integer" },
          },
        },
        PassType: {
          type: "object",
          properties: {
            object: { const: "pass_type" }, id: { type: "string" }, name: { type: "string" },
            credits: { type: "integer", description: "Credits a pass of this type starts with." },
            covers_service_ids: { type: "array", items: { type: "string" } },
            price: { type: ["object", "null"], properties: { amount: { type: "integer" }, currency: { type: "string" } } },
          },
        },
        Pass: {
          type: "object",
          properties: {
            object: { const: "pass" }, id: { type: "string" }, client_id: { type: ["string", "null"] },
            name: { type: "string" }, pass_type_id: { type: ["string", "null"] },
            covers_service_ids: { type: "array", items: { type: "string" } },
            status: { type: "string", enum: ["active", "exhausted", "expired", "scheduled", "void"] },
            credits: {
              type: "object",
              properties: { available: { type: "integer" }, issued: { type: "integer" }, used: { type: "integer" } },
            },
            stored_value: { type: ["object", "null"], properties: { amount: { type: "integer" }, currency: { type: "string" } } },
            next_expiry: { type: ["string", "null"] }, expires_at: { type: ["string", "null"] },
            source: { type: "string" }, note: { type: "string" }, issued_at: DateTime,
            lots: { type: "array", description: "Only on a single pass: each batch of credits added.", items: { type: "object" } },
            redemptions: { type: "array", description: "Only on a single pass: each spend.", items: { type: "object" } },
          },
        },
        InvoiceLine: {
          type: "object",
          properties: {
            id: { type: "string" }, type: { type: "string", enum: ["booking", "product", "manual"] },
            booking_id: { type: ["string", "null"] }, service_id: { type: ["string", "null"] },
            description: { type: "string" }, quantity: { type: "number" },
            unit_amount: { type: "integer" }, discount: { type: "integer" }, tax_rate: { type: "number", description: "Percent." },
            tax: { type: "integer" }, amount: { type: "integer" }, service_date: { type: ["string", "null"], format: "date" },
          },
        },
        Invoice: {
          type: "object",
          properties: {
            object: { const: "invoice" }, id: { type: "string" }, number: { type: "string" },
            status: { type: "string", enum: ["draft", "sent", "paid", "overdue", "void"] },
            client: {
              type: "object",
              properties: { id: { type: ["string", "null"] }, name: { type: "string" }, email: { type: "string" }, phone: { type: "string" } },
            },
            issue_date: { type: ["string", "null"], format: "date" }, due_date: { type: ["string", "null"], format: "date" },
            currency: { type: "string" }, tax_inclusive: { type: "boolean" },
            subtotal: { type: "integer" }, tax: { type: "integer" }, discount: { type: "integer" },
            total: { type: "integer" }, amount_paid: { type: "integer" }, amount_due: { type: "integer" },
            customer_note: { type: "string" }, internal_note: { type: "string" }, reference: { type: "string" },
            payment_url: { type: ["string", "null"] }, sent_at: { type: ["string", "null"] }, paid_at: { type: ["string", "null"] },
            created_at: DateTime, updated_at: DateTime,
            lines: { type: "array", description: "Only on a single invoice.", items: ref("InvoiceLine") },
          },
        },
        Event: {
          type: "object",
          properties: {
            object: { const: "event" }, id: { type: "string" },
            type: { type: "string", enum: [...EVENT_TYPES] },
            api_version: { const: "v1" }, account_id: { type: "string" }, livemode: { type: "boolean" },
            created_at: DateTime,
            data: {
              type: "object",
              properties: {
                object: { oneOf: [ref("Booking"), ref("Client"), ref("Pass"), ref("Invoice")] },
                redemption: { type: "object", description: "On pass.redeemed: the spend itself." },
                previous_attributes: { type: "object", description: "On updates: the changed fields' previous values." },
              },
            },
          },
        },
        WebhookEndpoint: {
          type: "object",
          properties: {
            object: { const: "webhook_endpoint" }, id: { type: "string" }, url: { type: "string" },
            description: { type: "string" },
            events: { type: "array", items: { type: "string", enum: ["*", ...EVENT_TYPES] } },
            enabled: { type: "boolean" }, disabled_reason: { type: ["string", "null"] },
            secret: { type: "string", description: "Only in the response that creates the endpoint. Verifies X-Clarity-Signature." },
            created_at: DateTime, last_success_at: { type: ["string", "null"] }, last_failure_at: { type: ["string", "null"] },
          },
        },
      },
    },
    security: [{ apiKey: [] }],
    paths: {
      "/me": { get: op("getMe", "The business and key this request acts as. Use it to test a key.", null, ref("Account")) },
      "/services": {
        get: op("listServices", "Lesson types", "catalog:read", listOf("Service"), {
          parameters: [query("bookable_online", "Only lesson types that can be booked online.", { type: "boolean" })],
        }),
      },
      "/services/{id}": { get: op("getService", "One lesson type", "catalog:read", ref("Service"), { parameters: [idParam("service")] }) },
      "/coaches": { get: op("listCoaches", "Coaches", "catalog:read", listOf("Coach")) },
      "/coaches/{id}": { get: op("getCoach", "One coach", "catalog:read", ref("Coach"), { parameters: [idParam("coach")] }) },
      "/locations": { get: op("listLocations", "Locations", "catalog:read", listOf("Location")) },
      "/locations/{id}": { get: op("getLocation", "One location", "catalog:read", ref("Location"), { parameters: [idParam("location")] }) },
      "/availability": {
        get: op("getAvailability", "Bookable times for a lesson type (up to 31 days)", "catalog:read", listOf("Slot"), {
          parameters: [
            { ...query("service_id", "The lesson type."), required: true },
            query("start", "From (ISO 8601). Default now.", { type: "string", format: "date-time" }),
            query("end", "Until (ISO 8601). Default start + 7 days.", { type: "string", format: "date-time" }),
            query("coach_id", "Only this coach."),
            query("location_id", "Only this location."),
          ],
        }),
      },
      "/bookings": {
        get: op("listBookings", "Bookings, soonest first", "bookings:read", listOf("Booking"), {
          parameters: [
            query("start_after", "Starting at or after (ISO 8601).", { type: "string", format: "date-time" }),
            query("start_before", "Starting before (ISO 8601).", { type: "string", format: "date-time" }),
            query("updated_since", "Changed at or after (ISO 8601).", { type: "string", format: "date-time" }),
            query("status", "booked, completed, cancelled or no_show."),
            query("client_id", "One client's bookings."),
            query("client_email", "Bookings under this email."),
            query("coach_id", "One coach's bookings."),
            query("service_id", "One lesson type's bookings."),
            query("location_id", "One location's bookings."),
            ...paging,
          ],
        }),
        post: {
          ...op("createBooking", "Book a lesson. Same rules as the booking page: the time must be free and the lesson type bookable online. The client gets the usual confirmation.", "bookings:write", ref("Booking")),
          parameters: [idempotencyHeader],
          requestBody: json({
            type: "object",
            required: ["service_id", "start"],
            properties: {
              service_id: { type: "string" },
              start: { type: "string", format: "date-time", description: "A start time from /availability." },
              coach_id: { type: "string", description: "Preferred coach. Another free one is used if they are not." },
              location_id: { type: "string" },
              client_id: { type: "string", description: "An existing client. Or give `client`." },
              client: {
                type: "object",
                properties: {
                  first_name: { type: "string" }, last_name: { type: "string" }, email: { type: "string" }, phone: { type: "string" },
                },
              },
              notes: { type: "string" },
              handedness: { type: "string", enum: ["left", "right"] },
            },
          }),
          responses: { "201": { description: "Booked", ...json(ref("Booking")) }, "409": { description: "That time is no longer free", ...json(ref("Error")) }, ...errors },
        },
      },
      "/bookings/{id}": { get: op("getBooking", "One booking", "bookings:read", ref("Booking"), { parameters: [idParam("booking")] }) },
      "/bookings/{id}/cancel": {
        post: op("cancelBooking", "Cancel a booking. Cancelling a cancelled booking is not an error.", "bookings:write", ref("Booking"), {
          parameters: [idParam("booking"), idempotencyHeader],
          requestBody: json({ type: "object", properties: { reason: { type: "string" } } }),
        }),
      },
      "/bookings/{id}/reschedule": {
        post: op("rescheduleBooking", "Move a booking to another free time", "bookings:write", ref("Booking"), {
          parameters: [idParam("booking"), idempotencyHeader],
          requestBody: json({ type: "object", required: ["start"], properties: { start: { type: "string", format: "date-time" } } }),
        }),
      },
      "/clients": {
        get: op("listClients", "Clients, oldest first", "clients:read", listOf("Client"), {
          parameters: [
            query("email", "Exact email."),
            query("phone", "Phone number (matches on the digits)."),
            query("q", "Search name or email."),
            query("updated_since", "Changed at or after (ISO 8601).", { type: "string", format: "date-time" }),
            ...paging,
          ],
        }),
        post: {
          ...op("createClient", "Add a client. If they are already on file, that client is returned (200) instead of a duplicate (201).", "clients:write", ref("Client")),
          parameters: [idempotencyHeader],
          requestBody: json({
            type: "object",
            properties: {
              name: { type: "string" }, first_name: { type: "string" }, last_name: { type: "string" },
              email: { type: "string" }, phone: { type: "string" }, notes: { type: "string" },
            },
          }),
        },
      },
      "/clients/{id}": {
        get: op("getClient", "One client", "clients:read", ref("Client"), { parameters: [idParam("client")] }),
        patch: op("updateClient", "Change a client. Only the fields sent change.", "clients:write", ref("Client"), {
          parameters: [idParam("client")],
          requestBody: json({
            type: "object",
            properties: { name: { type: "string" }, email: { type: "string" }, phone: { type: "string" }, notes: { type: "string" } },
          }),
        }),
      },
      "/pass_types": { get: op("listPassTypes", "The kinds of pass this business sells (its package lesson types)", "catalog:read", listOf("PassType")) },
      "/passes": {
        get: op("listPasses", "Passes, newest first", "passes:read", listOf("Pass"), {
          parameters: [
            query("client_id", "One client's passes."),
            query("status", "active, exhausted, expired, scheduled or void."),
            query("pass_type_id", "Passes of one type."),
            ...paging,
          ],
        }),
        post: {
          ...op("issuePass", "Issue a pass to a client. Tops up a matching pass they already hold (200) unless merge is false; a new pass is 201.", "passes:write", ref("Pass")),
          parameters: [idempotencyHeader],
          requestBody: json({
            type: "object",
            required: ["client_id", "pass_type_id"],
            properties: {
              client_id: { type: "string" }, pass_type_id: { type: "string" },
              credits: { type: "integer", description: "Default: the pass type's credits. 1-100." },
              expiry_months: { type: "integer", description: "Default 12; 0 never expires." },
              amount_paid: { type: "integer", description: "What was paid for it, in cents, if anything." },
              merge: { type: "boolean", description: "Default true." },
              note: { type: "string" },
            },
          }),
        },
      },
      "/passes/{id}": { get: op("getPass", "One pass, with its lots and redemptions", "passes:read", ref("Pass"), { parameters: [idParam("pass")] }) },
      "/passes/{id}/redeem": {
        post: op("redeemPass", "Spend credits by hand (not for a booking). Needs a note saying why.", "passes:write", ref("Pass"), {
          parameters: [idParam("pass"), idempotencyHeader],
          requestBody: json({
            type: "object",
            required: ["note"],
            properties: { credits: { type: "integer", description: "Default 1." }, note: { type: "string" } },
          }),
        }),
      },
      "/passes/{id}/void": {
        post: op("voidPass", "Switch a pass off. Credits already spent stay spent.", "passes:write", ref("Pass"), {
          parameters: [idParam("pass"), idempotencyHeader],
          requestBody: json({ type: "object", properties: { reason: { type: "string" } } }),
        }),
      },
      "/invoices": {
        get: op("listInvoices", "Invoices, newest first", "invoices:read", listOf("Invoice"), {
          parameters: [
            query("status", "draft, sent, paid, overdue or void."),
            query("client_id", "One client's invoices."),
            query("number", "Exact invoice number."),
            query("updated_since", "Changed at or after (ISO 8601).", { type: "string", format: "date-time" }),
            ...paging,
          ],
        }),
        post: {
          ...op("createInvoice", "Create an invoice. Numbered automatically unless `number` is given.", "invoices:write", ref("Invoice")),
          parameters: [idempotencyHeader],
          requestBody: json({
            type: "object",
            required: ["lines"],
            properties: {
              client_id: { type: "string" },
              client: { type: "object", properties: { name: { type: "string" }, email: { type: "string" }, phone: { type: "string" } } },
              status: { type: "string", enum: ["draft", "sent"], description: "Default draft. 'sent' publishes without emailing." },
              number: { type: "string" }, issue_date: { type: "string", format: "date" }, due_date: { type: "string", format: "date" },
              currency: { type: "string" }, tax_inclusive: { type: "boolean" },
              discount: { type: "integer", description: "Whole-invoice discount, cents." },
              customer_note: { type: "string" }, internal_note: { type: "string" }, reference: { type: "string" },
              lines: {
                type: "array",
                items: {
                  type: "object",
                  required: ["description"],
                  properties: {
                    description: { type: "string" }, quantity: { type: "number" },
                    unit_amount: { type: "integer", description: "Cents." }, discount: { type: "integer", description: "Cents." },
                    tax_rate: { type: "number", description: "Percent." },
                    booking_id: { type: "string", description: "Bills this booking (it cannot then be on another live invoice)." },
                    service_id: { type: "string", description: "A lesson type or pass type. A pass type issues the pass when the invoice is paid." },
                    service_date: { type: "string", format: "date" },
                  },
                },
              },
            },
          }),
        },
      },
      "/invoices/{id}": {
        get: op("getInvoice", "One invoice, with its lines", "invoices:read", ref("Invoice"), { parameters: [idParam("invoice")] }),
        delete: op("deleteInvoice", "Delete a draft. Published invoices are voided instead.", "invoices:write", { type: "object" }, { parameters: [idParam("invoice")] }),
      },
      "/invoices/{id}/send": {
        post: op("sendInvoice", "Email the invoice as a PDF, optionally with a Clarity Pay link", "invoices:write", ref("Invoice"), {
          parameters: [idParam("invoice"), idempotencyHeader],
          requestBody: json({
            type: "object",
            properties: {
              email: { type: "string", description: "Default: the client's email." },
              include_payment_link: { type: "boolean" },
            },
          }),
        }),
      },
      "/invoices/{id}/mark_paid": {
        post: op("markInvoicePaid", "Record a payment taken elsewhere. Issues any passes the invoice bought.", "invoices:write", ref("Invoice"), {
          parameters: [idParam("invoice"), idempotencyHeader],
          requestBody: json({ type: "object", properties: { amount_paid: { type: "integer", description: "Cents. Default: the total." } } }),
        }),
      },
      "/invoices/{id}/void": {
        post: op("voidInvoice", "Void an unpaid invoice", "invoices:write", ref("Invoice"), { parameters: [idParam("invoice"), idempotencyHeader] }),
      },
      "/events": {
        get: op("listEvents", "Everything that happened, oldest first, for 30 days. Keep the last `next_cursor` to resume.", "events:read", listOf("Event"), {
          parameters: [
            query("type", "One or more event types, comma separated."),
            query("object_id", "Events about one booking or client."),
            query("created_after", "ISO 8601.", { type: "string", format: "date-time" }),
            ...paging,
          ],
        }),
      },
      "/events/{id}": { get: op("getEvent", "One event", "events:read", ref("Event"), { parameters: [idParam("event")] }) },
      "/event_types": { get: op("listEventTypes", "Every event type a webhook can subscribe to", null, { type: "object" }) },
      "/webhook_endpoints": {
        get: op("listWebhookEndpoints", "Webhook subscriptions", "webhooks:manage", listOf("WebhookEndpoint")),
        post: {
          ...op("createWebhookEndpoint", "Subscribe a URL to events (REST hooks). The response carries the signing secret, once.", "webhooks:manage", ref("WebhookEndpoint")),
          requestBody: json({
            type: "object",
            required: ["url"],
            properties: {
              url: { type: "string", description: "Public https:// URL." },
              events: { type: "array", items: { type: "string", enum: ["*", ...EVENT_TYPES] }, description: "Default: all ('*')." },
              description: { type: "string" },
            },
          }),
        },
      },
      "/webhook_endpoints/{id}": {
        get: op("getWebhookEndpoint", "One webhook subscription", "webhooks:manage", ref("WebhookEndpoint"), { parameters: [idParam("webhook endpoint")] }),
        patch: op("updateWebhookEndpoint", "Change a webhook subscription", "webhooks:manage", ref("WebhookEndpoint"), {
          parameters: [idParam("webhook endpoint")],
          requestBody: json({
            type: "object",
            properties: {
              url: { type: "string" }, events: { type: "array", items: { type: "string" } },
              description: { type: "string" }, enabled: { type: "boolean" },
            },
          }),
        }),
        delete: op("deleteWebhookEndpoint", "Unsubscribe", "webhooks:manage", { type: "object" }, { parameters: [idParam("webhook endpoint")] }),
      },
    },
    webhooks: Object.fromEntries(
      EVENT_TYPES.map((type) => [
        type,
        {
          post: {
            summary: `${type}. Signed with X-Clarity-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>"> using the endpoint secret. Reply 2xx within 10 seconds.`,
            requestBody: json(ref("Event")),
            responses: { "200": { description: "Received" } },
          },
        },
      ]),
    ),
  };
}
