# Client Emails / Bulk Email Lite Plan

## 1) Current state from audit

### People / clients storage and load
- Clients are stored in table `people` (both Supabase-backed and local DB adapters) with current columns:
  - `id`, `name`, `email`, `phone`, `notes`, `source`, `caddy_profile_id`, `caddy_profile_url`, `created_at`, `updated_at`.
- Active admin load path:
  - `/api/calendar-state` returns `people` in `source/netlify/functions/booking-core.mts` and `source/netlify/functions/calendar-state.mts`.
  - UI consumes into `people` state in `source/src/App.tsx`.
- There is also a direct people endpoint:
  - `GET /api/people` and `PUT /api/people` in `booking-core.mts`.

### Bookings / appointments storage and load
- Bookings are stored in `calendar_items` with fields including:
  - `id`, `kind`, `week`, `day`, `start`, `duration`, `service_id`, `client`, `title`, `phone`, `email`, `note`, `status`.
- Current booking data is loaded from `calendar-state` and merged in App to build client summaries.
- UI already derives:
  - `count` of items per client,
  - `next` / `last` appointment per client,
  using `people` + `calendar_items`.

### Package lesson balances
- No explicit persisted remaining-balance field found.
- Package metadata exists on service definitions only (`lessonFormat: "package"`, `packageAllowance`, `packageCoverageMode`, `packageCoversServiceId`), but no client-level package purchase/redemption ledger table.
- Conclusion: package-balance support would require schema additions (not present today).

### Existing email sending functions
- Transactional notifications use:
  - `sendBookingNotifications` / `sendEmail` in `source/netlify/functions/booking-core.mts`.
  - `sendBookingNotifications` writes to `notification_history` and supports channels `client/coax/admin`.
- Dedicated notification sender (`source/netlify/functions/notification-engine.mts`) uses same provider (`resend`) and tracks records in `notification_history`.
- Existing test path:
  - `POST /api/test-email` in `booking-core.mts`.

### Notification settings currently in place
- `readAdminSettings` / `writeAdminSettings` in `source/netlify/functions/admin-settings.mts`.
- Persisted via `settings` key/value rows, including:
  - `notificationEmail`, `coachEmail`, `replyToEmail`,
  - `googleReviewUrl`,
  - `notificationFromName`, `notificationSubjectLine`,
  - sender defaults (`notificationFromName`, templates, send toggles, etc.).
- Sender identity for sends currently:
  - `from`: `notificationFromName` + env sender (`CLARITY_EMAIL_FROM` / `CLARITY_NOTIFICATION_EMAIL` fallback).
  - `reply_to`: `replyToEmail` (or fallback contact email).

### Notification/send history
- `notification_history` table exists:
  - `person_key`, `calendar_item_id`, `recipient`, `subject`, `kind`, `status`, `provider`, `provider_id`, `error`, timestamps.
- Also exposed via `GET /api/notification-history`.

### Unsubscribe / do-not-email
- No `unsubscribe`, `is_unsubscribed`, `do_not_email`, `marketingConsent`, etc. field found in `people`.
- No suppression list table found.

## 2) Proposed UI structure (admin only)

Best fit: add a new tab inside the existing **Clients** view:
- Keep existing **People** list and profile editor.
- Add a new section/card/toolbar in Clients for:
  1. **Filter panel**
     - last booking date
     - total bookings
     - remaining package lessons
     - service type (if available)
     - has future booking / no future booking
     - has email address
     - not unsubscribed
  2. **Recipient preview panel**
     - count, quick stats, sample rows
     - export/copy (future optional)
  3. **Compose + test + send controls**
     - subject
     - message body (phase 1 text template only)
     - sender identity summary (read-only sender email, editable sender name, reply-to)
     - per-send test email trigger
  4. **Recipient table**
     - checkbox select all / select all filtered / per client row
  5. **Send history panel**
     - recent campaign attempts from new `email_send_history` (plus `notification_history` cross-links).

This keeps the workflow near client management and avoids changing booking screens.

## 3) Required data model (phase-1 minimal)

### New table: `person_email_preference`
- `person_id` (FK to `people.id`)
- `is_unsubscribed` (boolean)
- `unsubscribed_at` (timestamp, nullable)
- `unsubscribed_reason` (text, nullable)
- `source` (text, default: "manual")
- `updated_at`

### New table: `email_campaigns`
- `id`
- `name`
- `type` enum/string: `review_clients` | `haven_t_seen_you` | `custom`
- `subject`
- `body_html`
- `body_text`
- `status` (`draft`, `ready`, `completed`)
- `created_by_admin`
- `created_at`, `updated_at`

### New table: `email_campaign_recipients`
- `id`
- `campaign_id` (FK)
- `person_id` (FK)
- `recipient_email`
- `reason` (text: why included based on filter)
- `client_match_context` (JSON, optional)
- `created_at`

### New table: `email_send_history`
- `id`
- `campaign_id` (FK)
- `person_id` (FK, nullable when unknown)
- `recipient`
- `subject`
- `status` (`queued`, `sent`, `failed`, `blocked_missing_email`, `blocked_unsubscribed`, `blocked_no_consent`)
- `provider` (`resend`)
- `provider_id`
- `request_id`
- `error`
- `sent_at`
- `created_at`

### Package balance table (if implemented in phase 2; not required for initial send if not available)
- `person_package_balances`
  - `person_id`, `service_id` (package covers service), `package_total`, `package_used`, `remaining`, `active_from`, `active_to`, `source_ref`
- `person_package_balances` currently absent; if package filter is required in phase 1, add and seed from existing package-related data sources.

## 4) Existing fields that can be reused
- `people.email`, `people.phone`, `people.name`.
- Client metadata from existing App-derived `ClientSummary`:
  - computed total booking count, future/next logic.
- `calendar_items` service linkage (`service_id`) for service-type filter.
- `notification_history` columns for provider/status/error metadata.
- Existing settings keys for sender identity and reply-to:
  - `notificationFromName`, `replyToEmail`, `notificationEmail`, `coachEmail`, `googleReviewUrl`.

## 5) Missing fields / tables / settings for this module
- Add person-level unsubscribe/consent field (new table or extend `people` with `is_unsubscribed`/`unsubscribed_at`).
- Campaign + recipient + send-history tables.
- Recipient precondition checks for do-not-email.
- API endpoints to support campaign drafting/preview/send.
- Potential package-balance source of truth table.

## 6) Send flow (phase 1)
1. Admin selects filter set in Clients → “Campaign”.
2. Server computes deterministic recipient set from persisted `people` + bookings snapshot:
   - only contacts with email,
   - exclude unsubscribed,
   - apply future/no-future + last-booking/date/booking-count/service filters.
3. UI displays recipient preview grid (names + emails + match reason).
4. Admin can send test email to one address through existing sender path.
5. On “Send selected clients”:
   - re-validate each row server-side immediately before enqueue/send
   - skip rows without email or unsubscribed
   - call internal email sender with explicit sender identity from settings
   - write to new `email_send_history`
   - also append/align with `notification_history` where useful.
6. UI shows inline send results (queued/sent/failed/skipped) + refreshable history.
7. No automatic scheduling, no recurring sequence in phase 1.

## 7) Safety checks and hard constraints
- Hard stop: do not send if `person.email` is blank/invalid.
- Hard stop: skip if unsubscribe preference exists and `is_unsubscribed = true`.
- Hard stop: require explicit admin action; no automatic triggers.
- Hard stop: no recurring/sequence jobs in phase 1.
- Sender identity is explicit:
  - `from` must be built from `notificationFromName` and configured sender address.
  - `reply_to` must be `replyToEmail`.
- All sends should record trace IDs and reason codes.
- Use phase-1 templates only, no open/click tracking.
- Keep transactional booking notifications untouched.

## 8) Implementation phases

### Phase 0 – Design + API contract (planning)
- Finalize campaign filters, payload shapes, response/error codes, sender validation rules.
- Document migration names and idempotent schema changes.

### Phase 1 – Read path + UI preview (no send)
- Backend: read-only campaign candidate endpoint with all filters.
- Frontend: Clients UI preview mode only.
- Add unsubscribe toggles + person-level preference management.

### Phase 2 – Send path + history
- Backend: send endpoint + validation + campaign record + send history table writes.
- Use existing resend sender wrapper and record reasons.
- Basic rate limiting + retries policy (small bounded retry, idempotency key).

### Phase 3 – Optional cleanup
- Add package-balance table if needed for this filter.
- Add import/export for preferences and campaign metadata.
- Add simple BI metrics (open/click intentionally excluded in phase 1).

## 9) Files likely to change
- `docs/CLIENT_EMAILS_LITE_PLAN.md` (this file)
- Backend/API:
  - `source/netlify/functions/booking-core.mts`
  - optionally `source/netlify/functions/admin-settings.mts` (for sender settings reuse)
  - `source/netlify/functions/notification-engine.mts` (if shared sender util reuse is standardized)
  - `source/netlify/database/migrations/*` and/or `source/supabase/booking-schema.sql` (schema)
- Admin UI:
  - `source/src/App.tsx`
- Potential shared docs:
  - `source/netlify/functions/PERSISTENCE_MAP.md`

## 10) Risks / blockers
- Package-balance filter cannot be implemented faithfully without a persisted package ledger.
- `people` uniqueness is currently by lower(email); same person with multiple emails/phones can still duplicate identity.
- `notification_history` uses `person_key` and `calendar_item_id`, not a clean campaign linkage.
- Existing booking history is only stored in `calendar_items`; if past records are purged or altered, last-booking and future-booking filters become less reliable.
- Email compliance requires explicit policy decision for legal basis of marketing contact before enabling “have not seen you” campaign type.

