# Clarity API (v1)

Clarity's public API lets other software read and change a business's bookings and clients, read its lesson types, coaches, locations and availability, and hear about every change through webhooks.

It follows the conventions of the APIs developers already know best, mainly Stripe's. If you have integrated with Stripe, Square or Cal.com, nothing here should surprise you.

- **Base URL:** `https://<your Clarity domain>/api/v1`
- **Machine-readable spec:** `GET /api/v1/openapi.json` (OpenAPI 3.1, no key needed)
- **Code:** `netlify/functions/_shared/public-api/`
- **Settings screen:** Settings › API & webhooks (owners and admins only)

---

## What connects to it

Anything that can call a web API. In practice:

| Tool | How |
|---|---|
| **Zapier, Make, n8n, Pipedream** | Import `openapi.json`, or use their HTTP module with the key as a Bearer token. Triggers can use webhooks (REST hooks, see below) or poll `GET /events`. |
| **Microsoft Power Automate / Logic Apps** | Custom connector → "Import an OpenAPI file" → paste the spec URL. |
| **Postman / Insomnia** | Import the spec URL. You get every request, ready to send. |
| **A club's own website** | Show `/availability`, book with `POST /bookings`. CORS is open, but keep keys server-side. A key in browser code is a key anyone can copy. |
| **Accounting, CRM, marketing tools** | Subscribe a webhook to `booking.*` / `client.*`, or sync nightly with `updated_since`. |
| **A developer's own code** | Any OpenAPI generator (openapi-generator, oapi-codegen, openapi-typescript) builds a typed client from the spec. |

---

## Authentication

Make a key in **Settings › API & webhooks › New key** and send it on every request:

```
Authorization: Bearer ck_live_3xAmPl3…
```

- `ck_live_…` keys act on the real business. `ck_test_…` keys are made from inside the business's **sandbox** and act only on it. Nothing a test key does touches live data.
- A key belongs to exactly one business, and it can never reach another one.
- **The full key is shown once.** Only a hash is stored. If a key is lost, revoke it and make a new one.
- Keys can expire (30 days, 90 days, a year, or never) and can be revoked at any time. Revoking a key also switches off any webhooks that key subscribed.
- Test a key with `GET /me`.

### Scopes

Each key is given only the permissions it needs:

| Scope | Allows |
|---|---|
| `bookings:read` | List and read bookings |
| `bookings:write` | Create, cancel and reschedule bookings |
| `clients:read` | List and read clients |
| `clients:write` | Create and update clients |
| `catalog:read` | Lesson types, coaches, locations, availability |
| `events:read` | The event feed |
| `webhooks:manage` | Subscribe and unsubscribe webhooks through the API |

A request without the scope it needs gets `403 permission_error / insufficient_scope`.

---

## Conventions

- **JSON** in and out. Keys are `snake_case`.
- **Times** are ISO 8601 with an offset, in the location's time zone, for example `2026-09-29T10:00:00+13:00`. When you send a time, any offset is accepted.
- **Money** is in minor units (cents), with a lowercase currency: `{ "amount": 9000, "currency": "nzd" }`.
- **Every object names itself**, for example `"object": "booking"`.
- **Lists** look like this:
  ```json
  { "object": "list", "data": [ … ], "has_more": true, "next_cursor": "WzEyMywiYXBwdC0xIl0" }
  ```
  To get the next page, pass `?cursor=<next_cursor>`. `?limit=` sets the page size (1–100, default 25).
- **Errors** look like this:
  ```json
  { "error": { "type": "invalid_request_error", "code": "parameter_missing",
               "message": "'start' is required.", "param": "start", "request_id": "req_…" } }
  ```

  | HTTP | `type` | Meaning |
  |---|---|---|
  | 400 | `invalid_request_error` | Something in the request is wrong. `param` names it. |
  | 401 | `authentication_error` | The key is missing or invalid. |
  | 403 | `permission_error` | The key lacks the scope, or the plan lacks the feature. |
  | 404 | `not_found_error` | No such object in this business. |
  | 405 | `invalid_request_error` | Wrong method for the route. |
  | 409 | `conflict_error` | The time is no longer free, or the booking can't be changed that way. |
  | 409 | `idempotency_error` | The idempotency key was reused with a different body, or is still in progress. |
  | 429 | `rate_limit_error` | Too many requests. Wait for `Retry-After` seconds. |
  | 500 | `api_error` | Clarity's fault. Retry, and quote the `request_id`. |
- **`Request-Id`** comes back on every response. Quote it when reporting a problem.
- **Idempotency.** Send `Idempotency-Key: <any unique string>` on a `POST`. If you retry with the same key and the same body within 24 hours, you get the first response back (with `Idempotent-Replayed: true`) and nothing happens twice. Use this on every booking you create.
- **Rate limit.** 300 requests per minute per key, reported in the `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers.
- **Versioning.** The major version is in the URL. Within `v1`, fields and event types may be **added**, but nothing is removed or renamed. Ignore fields you don't recognise.

---

## Endpoints

| Method | Path | Scope | |
|---|---|---|---|
| GET | `/me` | none | The business and key this request acts as |
| GET | `/services` | catalog:read | Lesson types (`?bookable_online=true`) |
| GET | `/services/{id}` | catalog:read | |
| GET | `/coaches` | catalog:read | |
| GET | `/coaches/{id}` | catalog:read | |
| GET | `/locations` | catalog:read | |
| GET | `/locations/{id}` | catalog:read | |
| GET | `/availability` | catalog:read | Free times: `service_id` (required), `start`, `end` (max 31 days), `coach_id`, `location_id` |
| GET | `/bookings` | bookings:read | `start_after`, `start_before`, `updated_since`, `status`, `client_id`, `client_email`, `coach_id`, `service_id`, `location_id` |
| POST | `/bookings` | bookings:write | Book a lesson |
| GET | `/bookings/{id}` | bookings:read | |
| POST | `/bookings/{id}/cancel` | bookings:write | Optional `reason`. Cancelling a booking that is already cancelled is not an error. |
| POST | `/bookings/{id}/reschedule` | bookings:write | `start` |
| GET | `/clients` | clients:read | `email`, `phone`, `q` (name or email search), `updated_since` |
| POST | `/clients` | clients:write | 201 if new; 200 with the existing client if they're already on file |
| GET | `/clients/{id}` | clients:read | |
| PATCH | `/clients/{id}` | clients:write | Only the fields you send change |
| GET | `/events` | events:read | `type` (comma separated), `object_id`, `created_after` |
| GET | `/events/{id}` | events:read | |
| GET | `/event_types` | none | |
| GET | `/webhook_endpoints` | webhooks:manage | |
| POST | `/webhook_endpoints` | webhooks:manage | `url`, `events`, `description`. The response includes `secret`, once. |
| GET | `/webhook_endpoints/{id}` | webhooks:manage | |
| PATCH | `/webhook_endpoints/{id}` | webhooks:manage | `url`, `events`, `description`, `enabled` |
| DELETE | `/webhook_endpoints/{id}` | webhooks:manage | |

### Booking through the API

A booking made through the API follows **the same rules as the booking page**, because it runs through the same code:

- the lesson type must be bookable online;
- the time must be free for a coach, location and bay;
- the client gets the usual confirmation;
- the client record is matched or created;
- bays are held, and Google Calendar is synced.

```bash
# 1. Find a time
curl "$BASE/availability?service_id=lesson-60&start=2026-10-01T00:00:00Z" \
  -H "Authorization: Bearer $KEY"

# 2. Book it
curl -X POST "$BASE/bookings" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-8812" \
  -d '{
    "service_id": "lesson-60",
    "start": "2026-10-01T10:00:00+13:00",
    "client": { "first_name": "Alex", "last_name": "Player", "email": "alex@example.com", "phone": "+6421000000" },
    "notes": "Booked from the club website"
  }'
```

If the time was taken in between, you get a `409 conflict_error`. Pick another slot.

The coach sees "Booked from the Clarity API (<key name>)" in the lesson note.

---

## Webhooks

Clarity POSTs each change to your URL, usually within a minute.

### Event types

| Type | When |
|---|---|
| `booking.created` | A new booking, from anywhere: the calendar, the booking page, the API, Optix, or a Google import |
| `booking.rescheduled` | Its start, end or length changed |
| `booking.cancelled` | Cancelled, or deleted outright (the object then has `"deleted": true`) |
| `booking.completed` | Marked as taught |
| `booking.no_show` | Marked as a no-show |
| `booking.updated` | Anything else changed (notes, coach, bay, client link…) |
| `client.created`, `client.updated`, `client.deleted` | |

### Payload

```json
{
  "id": "evt_4b1c…",
  "object": "event",
  "type": "booking.rescheduled",
  "api_version": "v1",
  "account_id": "sam-hale-golf",
  "livemode": true,
  "created_at": "2026-09-28T19:39:03.000Z",
  "data": {
    "object": { "object": "booking", "id": "appt-1790624343026", "start": "2026-09-29T12:00:00+13:00", … },
    "previous_attributes": { "start": "2026-09-29T10:00:00+13:00", "end": "2026-09-29T11:00:00+13:00" }
  }
}
```

`previous_attributes` appears on updates. It holds the old values of whatever changed.

### Headers

| Header | |
|---|---|
| `X-Clarity-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256>` |
| `X-Clarity-Event` | The event type |
| `X-Clarity-Event-Id` | Same as `id` in the body. Use it to dedupe. |
| `X-Clarity-Delivery` | This attempt's delivery id |

### Verifying the signature

Compute an HMAC-SHA256 over `"<t>.<raw request body>"` with the endpoint's signing secret, and compare it with `v1`. Reject the request if `t` is more than 5 minutes old. The scheme is the same as Stripe's.

```js
// Node
import { createHmac, timingSafeEqual } from "node:crypto";
function verify(rawBody, header, secret) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${parts.t}.${rawBody}`).digest("hex");
  return expected.length === parts.v1.length && timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}
```

```python
# Python
import hmac, hashlib, time
def verify(raw_body: bytes, header: str, secret: str) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    if abs(time.time() - int(parts["t"])) > 300:
        return False
    expected = hmac.new(secret.encode(), f"{parts['t']}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts["v1"])
```

### Delivery rules

- Reply with any **2xx within 10 seconds**. Anything else counts as a failure, and so does a redirect.
- Failures are retried after 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours and 12 hours, then daily for three days.
- An endpoint that has failed for **3 days straight is switched off**. The settings screen says why. Switch it back on once it's fixed.
- Delivery is **at least once** and **not strictly in order**. Dedupe on the event id, and use `created_at` or `previous_attributes` rather than arrival order.
- The URL must be public `https://`. Private and local addresses are refused.
- From the settings screen you can send a test `ping`, see each endpoint's recent deliveries with their status codes, and resend any delivery.

### REST hooks (Zapier, Make, n8n)

Tools that manage their own subscriptions call `POST /webhook_endpoints` when a user turns a trigger on, and `DELETE /webhook_endpoints/{id}` when they turn it off. The key needs the `webhooks:manage` scope.

### Polling instead of webhooks

`GET /events` returns every event from the last 30 days, oldest first. `next_cursor` is always returned, even on the last page. Store it, and next time call `GET /events?cursor=<stored>` to get only what's new. This is also the way to catch up after your webhook receiver has been down.

---

## How it works inside

```
calendar_items / people
      │  AFTER INSERT/UPDATE/DELETE trigger (same transaction as the change)
      ▼
api_change_log ──► api-webhook-worker (every minute) ──► api_events ──► api_webhook_deliveries ──► POST, signed
                                                              │
                                                     GET /api/v1/events
```

- **Change capture uses a database trigger, not application hooks.** Bookings and clients are written from about eight different code paths: the calendar, the booking page, public cancel, the Google import, Optix, the API and others. A trigger sees every one of them, including paths added later. It records the change in the same transaction as the write, so a change that rolls back is never announced. If the trigger itself fails, it logs a warning and lets the booking save anyway.
- A save that rewrites a row without changing it (the calendar's whole-state save does this) produces no event. Neither does a block or time off.
- Within one worker run, housekeeping writes to a row are folded into the event before them. For example, a new booking getting its bay and client link two seconds later is still one `booking.created`. A change that means something on its own (a cancellation, a move) always gets its own event.
- The management screen talks to `/api/api-access` using the normal coach login. An API key can never make more keys.
- **Tables:**
  - `api_keys`
  - `api_events`
  - `api_webhook_endpoints`
  - `api_webhook_deliveries`
  - `api_change_log`
  - `api_idempotency_keys`
  - `api_rate_limits`

  All are server-only (RLS on, no anon/authenticated grants). The migration is `database/migrations/20260930000100_create_public_api`.
- **Retention:**
  - events: 30 days
  - processed change rows: 3 days
  - idempotency keys: 24 hours

## Not in v1 (the natural next steps)

- **OAuth 2.0 "Sign in with Clarity"** for third-party apps that many businesses install (a marketplace). API keys cover one business connecting its own tools, which is what exists today.
- **A published Zapier / Make app.** The spec and REST hooks are what those are built from.
- **More resources:** passes, invoices, payments, practice blocks, and marking a booking completed or no-show through the API.
- **Webhook delivery in seconds.** Today it takes up to a minute, because of the worker's schedule.
