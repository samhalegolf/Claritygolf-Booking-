# Sandbox Mode — build plan

Turning the Sandbox spec into work, mapped onto the code that exists today.

Read the spec first. This document does not restate it; it says what the codebase
already gives you, what is in the way, and the order to build in.

---

## Status

Built, with tests passing and typecheck clean:

- **B3** — one outbound email boundary (`_shared/email-delivery.mts`). Eight
  `api.resend.com` call sites and two drifted `sendEmail()` implementations are
  now one `deliverEmail()`. The throttle and 429 retry that only booking
  notifications had now cover password resets, invoices, video alerts and the
  test send too, and `EMAIL_NOTIFICATIONS_ENABLED` now switches off all of them
  rather than one.
- **B1** — `admin_sessions.active_account_id`, a validated `preferredAccountId`
  on `resolveMembershipForAuthUser`, and `POST /api/workspace/switch`.
- **M1** — `accounts.kind` / `accounts.sandbox_of_account_id` with the partial
  unique index, `_shared/sandbox.mts`, derived sandbox access, `kind = 'live'`
  filters on all three public/scheduled resolvers, and `GET`/`POST /api/sandbox`.
- **M2** — Settings › Sandbox (create, enter, plan selector) and the persistent
  full-width sandbox bar, rendered above both shells from `main.tsx`.
- **M3** — `POST /api/sandbox/impersonate`, `POST /api/sandbox/return`,
  `player_sessions.sandbox_actor_auth_user`, the session endpoint preferring a
  handoff over the coach cookie, and Continue as player / Return to coach in the
  bar.
- **B2** — the module-level `activeCountry` is gone from `phone.mts`, and
  `activeLocale()` / `activeCurrency()` from `locale.mts`. Country is an argument
  everywhere on the server, read from the account being served. The browser keeps
  a per-page one in `src/lib/activeCountry.ts`, which is the correct model there.
  A side effect worth having: a new business's invoice currency now defaults to
  its own country's rather than to NZD.
- **B2's sibling** — `activeTimeZone` is gone from `booking-core.mts` too, along
  with `accountTimeZone()` and `setActiveTimeZone()`. The five slot-maths
  functions (`isSlotInPast`, `slotWallTimeToUtcMillis`,
  `appointmentMinutesSinceEnd`, `isAppointmentInPast`, `nowInTimeZoneParts`) now
  take the timezone with **no default**, so omitting one is a type error rather
  than a silently wrong hour. `bayBookingMatchesSlot` lost its hardcoded
  `"Pacific/Auckland"` fallback along with it.

Eighteen cases added to `_shared/tenant-boundary.test.mts`.

Still to do: M4–M9.

---

## The short version

Sandbox as specified is mostly already built, and you didn't build it for
Sandbox — you built it when you took `sam-hale-golf` out of 22 fallback sites and
made `account_id` the real tenant boundary.

**A sandbox is another row in `accounts`.** That is the whole data model. Isolated
data, real settings, real business logic and real UI all fall out of it, because
every coach-side read and write in the app already derives its account from one
function and filters on it in SQL.

Three things stand in the way. All three are live bugs that are worth fixing
whether or not Sandbox ever ships.

---

## What the codebase already gives you

**1. There is exactly one place that decides which account a request acts for.**

```
admin_sessions cookie
  -> readAdminSessionAuthUserId()          _shared/coach-auth.mts
  -> resolveMembershipForAuthUser()        _shared/coach-auth.mts
  -> CoachActor.accountId
  -> currentActor(req)                     booking-core.mts:9869  (per-Request cache)
  -> currentAccountId() / resolveBackendRequestContext()
  -> every account-scoped read and write
```

No account id is ever taken from a request body, query string, cookie or settings
blob. That is asserted by tests, not just by comment. So teaching the app about
Sandbox is teaching *one function* about Sandbox.

**2. 35 of the 45 public tables already carry `account_id`.**

Including all the ones that matter: `calendar_items`, `people`, `settings`,
`passes`, `pass_allocations`, `pass_redemptions`, `pass_value_transactions`,
`billing_invoices`, `billing_pos_transactions`, `portal_players`,
`player_sessions`, `notification_history`, `practice_blocks`.

The ten without it are listed under Gaps below, and only four of them matter.

**3. `tenant-boundary.test.mts` already has ~30 tests asserting the boundary
holds** — that reads filter in SQL rather than in JavaScript afterwards, that a
row with no account is visible to nobody, that an unknown slug never resolves to
the original workspace. Sandbox rides on those. You extend that file rather than
starting a new safety net.

**4. Creating an account is code you already run.** `seedSettings(accountId)`
(booking-core.mts:2337) and `seedItems(accountId)` populate a new business with
45 default settings keys and starter data, and `tenant-boundary.test.mts` already
asserts that a new business inherits none of the original coach's details.
"Create sandbox" is "create account" with two extra columns set.

**5. A purchase that never touches Stripe already works, end to end.** In
`/api/player/checkout` (booking-core.mts ~12361), when account credit covers the
whole price, `cardValueCents === 0` and the code runs:

```
reserve value -> insert billing_payment_tenders -> settle -> grantPass -> return profile
```

with no processor involved. That path is the proof that the sandbox payment
adapter is a substitution and not a simulation — it joins an existing road.

**6. The Player Portal is already a real second shell chosen by session role**,
not by hostname (`main.tsx` routes on `/api/auth/session` → `role`). Handing a
coach a player session is enough to enter the actual portal. Nothing needs
building to "render the portal in sandbox".

**7. `subscriptionStatus: "internal"` is already an accepted active status**
(booking-core.mts:1211). A sandbox account can be entitled without being billed,
using machinery that exists.

---

## Three blockers — do these before any Sandbox UI

### B1. A user can only have one membership today

`resolveMembershipForAuthUser()` in `_shared/coach-auth.mts`:

```sql
SELECT ... FROM account_memberships
WHERE auth_user_id = $1 AND active = true
ORDER BY CASE role WHEN 'owner' THEN 0 ... END, created_at ASC
LIMIT 1
```

One auth user, one answer. Give a coach a sandbox membership and which account
they land in is decided by a sort order, not by them.

**Fix:** the session has to remember which account is active.

- `ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS active_account_id TEXT`
- `resolveMembershipForAuthUser(authUserId, preferredAccountId?)` — the preference
  is *validated* against a real active membership row and ignored if it doesn't
  resolve. It is never trusted on its own.
- `requireCoachActor()` reads `active_account_id` off the session row and passes it
  in. A new endpoint `POST /api/workspace/switch` writes it.

This is the only genuinely new auth machinery in the whole plan. It is also the
change multi-workspace switching needs anyway, so it is not Sandbox-only code.

### B2. The active country is module-global state in a warm serverless instance

`_shared/phone.mts:54`:

```ts
let activeCountry: CountryCode = FALLBACK_PHONE_COUNTRY;
export function setActivePhoneCountry(value) { activeCountry = cleanPhoneCountry(value); }
export function getActivePhoneCountry() { return activeCountry; }
```

Five request paths set it: `public-reschedule.mts:157`,
`notification-engine.mts:189`, `calendar-state.mts:754`,
`booking-core.mts:5334` and `:5750`. `locale.mts` then reads it for every date
and currency default in the app.

A Netlify instance stays warm and serves many requests. Two businesses in
different countries on the same instance can already format each other's dates —
and per `locale.mts`'s own comment, a misread date is a missed lesson. Today that
is rare because there is effectively one live account. **Sandbox makes it
routine**, because changing country is the point of Sandbox.

**Fix:** carry the country on the request context that
`resolveBackendRequestContext()` already builds, pass it to the `locale.mts` and
`phone.mts` functions explicitly, and delete `setActivePhoneCountry` /
`getActivePhoneCountry` along with the parameter defaults that call them.

This is the least interesting item here and the one most likely to bite you if
skipped. It is also a genuine example of the spec's own principle: Sandbox is
already exposing a weakness in the real application, before a line of it is
written.

### B3. Seven places send email, through two drifted implementations

`https://api.resend.com/emails` is fetched from:

| file | line |
|---|---|
| `notification-engine.mts` | 540 |
| `booking-core.mts` | 7816 |
| `billing-api.mts` | 2533 |
| `video-transfer.mts` | 2671, 2721, 2797 |
| `system-smoke.mts` | 95 |

There are two `sendEmail()` functions. The `notification-engine` one throttles to
Resend's 2/sec limit and retries a 429; the `booking-core` one does neither. So
password resets and booking confirmations already have different reliability for
no reason anyone chose.

**Fix, before Sandbox touches email:** one `_shared/email-delivery.mts` exporting
`deliverEmail({ accountId, to, subject, html, text, replyTo, idempotencyKey })`,
carrying the throttle, the 429 retry and the from-header logic from
`notification-engine`. Delete the other six call sites — not wrap them.

Then Sandbox email interception is one `if` inside one function.

The same principle applies to the other boundaries, and they are in better shape
already:

- **Stripe** — `_shared/stripe.mts:130` and `_shared/stripe-billing.mts:96`. Two,
  and they are genuinely two different things (customer payments vs. billing this
  workspace).
- **Google** — `_shared/google-provider.mts`.
- **Optix** — `_shared/optix-client.mts`.

---

## The data model

```sql
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'live';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS sandbox_of_account_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS accounts_one_sandbox_per_account
  ON accounts (sandbox_of_account_id)
  WHERE sandbox_of_account_id IS NOT NULL;

ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS active_account_id TEXT;
```

Schema in this app is idempotent DDL run at boot (`ensureCoreTables`), not
migration files, so these go in the existing `ddlBatch()` in `booking-core.mts`
alongside the `accounts` definition at line 2176.

**The sandbox belongs to the business, not to a person.** `sandbox_of_account_id`
points at the live account it shadows, and the partial unique index enforces
one-per-business in the schema rather than in code. Every coach, admin and owner
on that business shares the one sandbox.

**No sandbox memberships.** A coach's right to enter the sandbox is derived from
their membership on the *live* account, not from a second `account_memberships`
row:

```
Authenticated user  (admin_sessions -> auth_user_id)
      |
      v
active_account_id = S
      |
      +-- S has a membership for this user?            -> ordinary account
      |
      +-- accounts[S].kind = 'sandbox'
          AND this user has an active membership on
              accounts[S].sandbox_of_account_id         -> sandbox unlocked,
                                                           role inherited from
                                                           that live membership
      |
      v
otherwise: 403
```

Mirroring memberships onto the sandbox account would work too, and is worse:
removing a coach from the business would leave their sandbox row behind unless
someone remembered to deactivate it. Deriving access means revoking a coach
revokes their sandbox in the same instant, with no second thing to keep in sync.

Inheriting the role matters as well — a `coach`-role user gets `coach` in the
sandbox, so permission differences are testable rather than flattened.

**The rule that makes production impersonation structurally impossible:** every
sandbox-only capability checks `accounts.kind = 'sandbox'` **on the server, from
the accounts table**. Not a flag in the session, not a header, not an env var. A
row.

If `kind <> 'sandbox'`, "Continue as Player" does not exist as an endpoint
response — it 403s. There is no code path where the check is skipped, because
there is no sandbox mode flag to skip it with.

---

## Milestones

Ordered so each one is usable on its own. The spec's V1 priority list maps onto
these; the numbers in brackets are its items.

### M1 — A sandbox account exists  [1, 2]

- The two `accounts` columns above.
- `POST /api/sandbox` — creates `<accountId>-sandbox` with `kind='sandbox'`,
  `sandbox_of_account_id = actor.accountId`, `status='active'`, then runs the
  existing `seedSettings` / `seedItems`. The unique index makes a second call a
  no-op rather than a second sandbox.
- No membership row. Access is derived from the caller's live membership (see
  The data model).
- Its `workspaceAccountsJson` entry gets `subscriptionStatus: 'internal'` and a
  copy of the owner's live `planKey`, so entitlement checks run for real rather
  than being bypassed. The Sandbox bar's plan selector changes it later (see
  Decisions).

**Done when:** the row exists and a direct DB read shows the sandbox has its own
45 settings keys and none of the live account's data.

### M2 — The coach can switch into it  [1, 2, 3]

Needs **B1**.

- `POST /api/workspace/switch { accountId }` — validates membership, writes
  `admin_sessions.active_account_id`.
- `/api/auth/session` returns `accountKind` alongside `accountId` in its
  `WorkspaceBootstrap` (`_shared/auth-contract.mts`).
- A persistent bar in the coach shell when `accountKind === 'sandbox'`. Not a
  badge in a corner — full width, unmissable, above everything.

**Done when:** you can switch in, see the real coach UI over sandbox data, create
a service, switch out, and the live account is untouched.

### M3 — Continue as Player  [4, 5, 6]  ← the first genuinely useful milestone

This is the milestone that makes Sandbox worth having. Everything after it is
convenience.

The two session cookies already coexist: `clarity_session` (coach) and
`clarity_player_session` (player). So the handoff does not have to destroy
anything.

- `POST /api/sandbox/impersonate { portalPlayerId }` checks, in order:
  1. `requireCoachActor(req)` resolves.
  2. The active account's `kind = 'sandbox'`.
  3. The caller has an active membership on that sandbox's
     `sandbox_of_account_id`.
  4. The `portal_players` row belongs to that same sandbox account.

  Then mints a normal `player_sessions` row through the existing
  `createPlayerSession()`, with one new column
  `player_sessions.sandbox_actor_auth_user` recording who is driving.
- `/api/auth/session` prefers the player session when that column is set, so
  `main.tsx` renders `PlayerPortal` with no login and no logout.
- `POST /api/sandbox/return` deletes that player session only. The coach cookie
  never moved, so the coach shell comes straight back.
- The portal shows `SANDBOX — Viewing as <name>  [ Return to Coach ]` whenever
  `sandbox_actor_auth_user` is set.

Note check 2 is what the spec means by "production player impersonation must
remain impossible". It is not a policy — a live account has no sandbox row to
satisfy it.

**Done when:** create a player as the coach → Continue as them → buy something →
return → see it on the coach side. That round trip is the deliverable.

### M4 — Settings freedom  [7]

Needs **B2**.

Mostly nothing to build: the sandbox uses the same settings system, so country,
currency, timezone, tax, services, locations, availability, passes, booking rules
and cancellation rules are already editable through the real screens.

The work is making sure nothing caches across the switch — the frontend holds
`coachAccount.country` and calls `setActivePhoneCountry` at `App.tsx:5470`, which
B2 removes.

**Deliberately not building:** hard-coded "NZ Demo" / "US Demo" presets. The spec
is right that those defeat the purpose.

### M5 — Sandbox payment adapter  [8]

`createStripeCheckoutSession(credential, opts)` returns `{ url, sessionId }`. The
sandbox adapter returns the same shape, with an in-app URL
(`/?sandbox-pay=<id>`) instead of Stripe's hosted page. `booking-core` does not
branch.

`/api/player/checkout/confirm` accepts a sandbox session id when the account is a
sandbox, and then runs exactly the existing confirm path — tender, settle,
`grantPass`, receipt, booking state. The credit-only branch already proves that
path runs with no processor.

The sandbox payment page offers Successful / Declined / Cancel. Declined and
Cancel matter more than Successful: the reversal path
(`reversePassValueTransaction` + the refunded-cents update) is the code most
likely to be wrong and least likely to be tested by hand today.

### M6 — Sandbox Outbox  [9]

`notification_history` already has `account_id`, `recipient`, `subject`, `kind`,
`status`, `provider`, `provider_id`, `error`. The Outbox is a filtered read of
the real table, with `status = 'sandbox_captured'` and the rendered HTML stored
alongside.

**Do not create a parallel outbox table.** If the Outbox shows something
different from what production records, it stops being a test of production.

The interception is one branch in the `deliverEmail` from B3: when the account is
a sandbox, render the template exactly as now, write the history row, skip the
`fetch`.

### M7 — Integration interception  [10]

Same shape at each boundary: run the decision, log the intended call, don't send.

- **Google Calendar** — `_shared/google-provider.mts`. Straightforward; the
  payload is built then posted.
- **Optix** — `_shared/optix-client.mts` / `optix-book-resource.mts`. **See the
  gap below; this one is not free.**
- **Caddy** — `_shared/caddy.mts`. Audit before mocking. If it is entirely inside
  Clarity infrastructure it can run against sandbox records for real, which is
  strictly better.

### M8 — Activity log  [11]

A `sandbox_events` table (`account_id`, `at`, `kind`, `summary`, `payload jsonb`)
written from the sandbox branches added in M5–M7 plus the account-scoped write
paths. This is the one genuinely sandbox-only table, and it is fine: it records
what happened rather than changing what happens.

### M9 — Reset  [12]

Don't hard-code the table list — it will go stale the next time you add a table,
and a reset that misses a table leaves data behind that looks like a bug in
whatever you test next.

```sql
SELECT table_name FROM information_schema.columns
WHERE table_schema = 'public' AND column_name = 'account_id'
```

Delete from each where `account_id = <sandbox>`, in FK order, then re-seed. Guard
the whole thing on `kind = 'sandbox'` — the same check as everywhere else.

V1 is "Reset Everything". The partial resets in the spec can wait.

---

## Gaps you will hit

**Optix and external-booking state is not account-scoped at all.** These four
tables have no `account_id` column:

- `optix_bay_bookings`
- `optix_booking_sync`
- `optix_webhook_events`
- `external_booking_links`

So sandbox Optix activity cannot be isolated by account, because there is nothing
to isolate it by. Two options, and only one is right:

- **Add `account_id` to all four.** Fixes a real multi-tenant leak that exists
  today, and Sandbox then works like everything else.
- Make sandbox never reach that code. Cheaper, and wrong — resource booking is
  exactly the thing you want to test under odd configurations.

This is the largest piece of unglamorous work the plan implies, and it is in the
"you needed it anyway" column rather than the "Sandbox cost" column.

**The other six tables without `account_id`** are fine as they are:
`accounts`, `admin_users`, `admin_sessions`, `admin_password_resets` (global by
design), `notification_webhook_events` (Resend's ingest, keyed on provider id),
`schema_migrations`.

---

## Where the "same logic" rule will be tested

The spec's warning sign — "if a workflow only works in Sandbox because Sandbox has
special business logic" — has three likely places to appear:

1. **A parallel outbox table.** Tempting, because the sandbox outbox wants fields
   production doesn't store. Store them in production too, or don't show them.
2. **A sandbox branch inside `booking-core`'s checkout.** Keep the adapter behind
   `createStripeCheckoutSession`'s return shape so the dispatcher never learns
   what a sandbox is.
3. **Bypassing `assertAccountFeature` for sandbox accounts.** Use the existing
   `subscriptionStatus: 'internal'` and a real `planKey` instead. A sandbox that
   skips entitlement checks cannot test entitlement checks.

---

## Tests

Extend `_shared/tenant-boundary.test.mts` rather than starting a new file — the
fixtures and the fake database (`setDatabaseForTests`) are already there.

New cases worth having:

- A sandbox's calendar read never returns live rows, and the filter is in SQL.
- `POST /api/sandbox/impersonate` against a `kind='live'` account is a 403.
- Impersonating a `portal_players` row from a *different* sandbox is a 403.
- A player session with `sandbox_actor_auth_user` set cannot be minted by
  `/api/auth/login` — only by the impersonate endpoint.
- `deliverEmail` for a sandbox account performs no `fetch` and writes exactly one
  `notification_history` row.
- Reset deletes only the sandbox's rows, and refuses to run against `kind='live'`.
- Switching workspaces with an `accountId` the user has no membership for leaves
  `active_account_id` unchanged.
- A coach whose live membership is deactivated can no longer activate that
  business's sandbox, with no sandbox row having been touched.
- A second `POST /api/sandbox` for a business returns the existing sandbox rather
  than creating another.

---

## Decisions

**1. Publicly bookable? — No. DECIDED.**

A sandbox account is never reachable from `/book/<slug>`. `resolvePublicAccount()`
gains `AND kind = 'live'`.

This decision does more work than it looks like. `resolvePublicAccountId()`
(booking-core.mts:9928) has a fallback: with no `?business=` slug in the URL and
**exactly one** active account, that account is the answer. The moment a sandbox
row exists with `status='active'`, there are two — and every existing public
booking link without an explicit slug starts 404ing with "This booking page is not
available."

So the `kind = 'live'` filter is not a preference, it is what stops creating a
sandbox from taking the live booking page down. It belongs in three places:

- `resolvePublicAccount()` — the slug lookup.
- `resolvePublicAccountId()` — the single-business fallback count.
- `listActiveAccountIds()` — see below.

**Consequence:** the public booking widget cannot be exercised inside Sandbox.
The player-side booking flow still can, because the Player Portal renders booking
inside its own shell against the authenticated player session — but the anonymous
`/book/<slug>` path is out of scope for Sandbox testing.

**Scheduled jobs.** `listActiveAccountIds()` is what lesson reminders and the
admin-notification debounce iterate. Two defensible answers:

- Exclude sandboxes — reminders never fire there, and testing them means
  triggering the job by hand.
- Include them — reminders fire on the real schedule against sandbox data, and
  the email is captured by the Outbox anyway, so nothing leaves Clarity.

Including them is the better test and costs nothing once M6 is in. Until M6 is in,
exclude them.

**2. How many sandboxes? — DECIDED: one per business account.**

Not one per coach. The sandbox belongs to the business, so everyone on it —
owner, admins, coaches — shares the same one. Enforced by the partial unique index
on `accounts.sandbox_of_account_id` rather than by a check in code.

Two things follow from sharing it:

- **Reset is destructive for everybody.** One coach hitting Reset Sandbox wipes
  whatever another was midway through. At your current size that is fine; the fix
  if it ever stings is a confirmation naming the last person who touched it, which
  the M8 activity log already knows.
- **Two people can be in the sandbox at once**, including impersonating different
  players. That works — `player_sessions` rows are independent — but the activity
  log should record which coach did what, or it reads as one confused person.

**3. What plan does the sandbox run on? — DECIDED: owner's plan, with a selector.**

"Plan" here means `planKey` — the subscription tier in `accountPlanCatalog`
(booking-core.mts:1177): `solo`, `studio`, `academy`, `enterprise`, `founder`.
It is not about money. It is the thing that decides which features and limits the
app allows:

```
solo     publicBooking, coachCalendar, services, groupLessons, packages,
         clients, notifications, googleCalendarSync
         max 1 coach, 1 location, 10 services

studio   + locationCalendar, multiCoach, multiLocation, invoicing,
           customBranding, staffUsers
         max 5 coaches, 3 locations, 40 services

founder  everything, 999 of each
```

Routes enforce it: `assertAccountFeature(account, "clients")` throws 403 when the
plan doesn't include the feature, and `assertAccountLimit` throws 409 past a
count. A sandbox is its own account, so it carries its own `planKey` and its own
limits — it doesn't consume the live account's.

**The decision:** a new sandbox takes a copy of the owner's live `planKey`, and
the Sandbox bar carries a plan selector so it can be changed at any time.

Implementation:

- `planKey` lives on the account's entry in `workspaceAccountsJson`, read back by
  `workspaceAccountForId()` (booking-core.mts) and turned into entitlements by
  `accountEntitlements()`. So the selector is an ordinary settings write against
  the sandbox account — no new storage.
- `subscriptionStatus` stays `'internal'` regardless of plan, so
  `isAccountActive()` passes without anything being billed.
- The endpoint that writes it refuses unless `accounts.kind = 'sandbox'`. Same
  check as every other sandbox capability; a live account's plan is not editable
  from the app.

**Expected behaviour when you downgrade mid-session:** `assertAccountLimit` only
fires on write (`currentUsage > limit`), so a sandbox holding three locations that
drops to `solo` keeps all three and refuses the fourth. That is exactly what
happens to a real coach who downgrades, so leave it — it is a feature of the test
environment, not a bug to smooth over.

---

## Suggested order of work

```
B3  consolidate email delivery          (independent, do it first — it's a pure win)
B1  session-scoped active account
M1  sandbox account exists
M2  switch into it + persistent bar
M3  Continue as Player / Return to Coach   <- stop here and use it for a while
B2  remove module-global country
M4  settings freedom
M5  payment adapter
M6  outbox
M7  integration interception  (+ account_id on the four Optix tables)
M8  activity log
M9  reset
```

B3 first because it stands alone and makes the codebase better on its own. B2 sits
before M4 because M4 is the thing that would expose it.
