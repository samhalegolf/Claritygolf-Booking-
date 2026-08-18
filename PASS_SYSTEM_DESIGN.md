# Pass System — Design

**Status:** design only, nothing built
**Date:** 18 Aug 2026
**Project:** Clarity Booking (Supabase `kaxmjuxgfylfdxdjfjsi`)

---

## 1. What a Pass is

> A Pass is a named person holding **N credits**, valid for **certain lesson types**, until it **expires**.

That's the whole idea. Everything below is in service of two questions the software must always be able to answer instantly:

1. What is this person entitled to?
2. How much of it is left?

A Pass does not care where it came from. Optix sold it, you sold it at the counter, or you gave it away as a favour — once issued, it behaves identically. That's the point of building your own: **one shape of entitlement, many sources.**

---

## 2. The three objects

Only three. Resist adding a fourth.

### 2.1 Pass template — *what is for sale*

**You already have this.** A `Service` with `lessonFormat: "package"` is a pass template today:

| Existing field | Becomes |
|---|---|
| `name` | Pass name — "30 Minute Golf Lesson Package" |
| `price` | What it sells for |
| `packageAllowance` | Credits granted (currently 1–100, default 5) |
| `packageCoversServiceId` | Which lesson type it pays for |

Do **not** build a separate pass-template catalogue. You'd be maintaining two lists of the same thing and they would drift. The one change needed: `packageCoversServiceId` is singular and needs to become a list (`packageCoversServiceIds: string[]`), because a "3 lessons" pass realistically covers both your 30-min and your 45-min lesson.

**Redundancy to delete:** `packageCoverageMode: "upfront" | "lesson-by-lesson"` is set, stored, and rendered as a label — nothing reads it to make a decision. A Pass is paid upfront by definition; "lesson-by-lesson" is just a normal booking with no pass at all. Delete the field and its editor row.

### 2.2 Pass — *an issued entitlement, living under a person*

This is the new thing. It hangs off `people.id` and holds:

- who it belongs to
- how many credits it started with
- what it covers
- when it expires
- where it came from (Optix / Clarity POS / invoice / manual grant)
- its state: `active` · `exhausted` · `expired` · `void`

### 2.3 Pass redemption — *one credit spent on one booking*

An append-only ledger line: this pass, this booking, this date, this coach, this much.

**The most important decision in this whole design:** the balance is **never stored**. It is always `credits_total − count(live redemptions)`. A stored `credits_remaining` column is a number that can drift out of sync with reality, and when it drifts you have no way to find out which one is wrong. A ledger can always be recounted and always explains itself: "Sam's pass shows 1 left because these two lessons used the other two, on these dates."

Deleting a booking, refunding a lesson, or a coach fat-fingering a checkout all become *reverse the ledger line* — not *decrement a counter and hope*.

---

## 3. Data model

Naming follows your existing conventions: `text` ids you generate, `account_id` on everything, snapshot columns so history reads correctly after a rename.

### `passes`

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | |
| `account_id` | text | |
| `person_id` | text → `people.id` | **Nullable** — an unassigned pass is legitimate, see §5 |
| `name` | text | Snapshot: "30 Minute Golf Lesson Package". Survives a template rename |
| `template_service_id` | text | The `package` Service it came from. Nullable for a free-form manual grant |
| `covers_service_ids` | text[] | Snapshot of coverage at issue time. Changing the template later must not silently re-scope passes already in people's hands |
| `credits_total` | integer | ≥ 1 |
| `issued_at` | timestamptz | |
| `expires_at` | timestamptz | Nullable = never expires |
| `status` | text | `active` · `exhausted` · `expired` · `void`. **Derived and refreshed**, not hand-managed — see §3.1 |
| `source` | text | `optix` · `clarity_pos` · `clarity_invoice` · `manual` |
| `source_ref` | text | Optix `product_sale_id`, POS `receipt_number`, or invoice id |
| `amount_paid_cents` | integer | What was actually paid. Nullable for a comp |
| `currency` | text | |
| `note` | text | "Comped after the rained-out session" |
| `created_at` / `updated_at` | timestamptz | |

**Index:** `(account_id, person_id, status)` — the checkout lookup runs on every lesson card.

### `pass_redemptions`

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | |
| `account_id` | text | |
| `pass_id` | text → `passes.id` | |
| `booking_id` | text → `calendar_items.id` | Nullable, so a manual adjustment is possible |
| `credits` | integer | Normally 1. Lets a 60-min lesson burn 2 credits off a 30-min pass if you ever want that |
| `redeemed_at` | timestamptz | |
| `redeemed_by` | text | admin user id — who pressed the button |
| `pos_transaction_id` | text | The $0 sale that recorded it |
| `reversed_at` | timestamptz | Nullable. **Set, never delete** |
| `reversal_reason` | text | |
| `created_at` | timestamptz | |

**Unique index:** `(booking_id) where reversed_at is null` — one live redemption per booking. This is the guard that makes double-charging a pass structurally impossible rather than a thing you remember not to do.

### `pass_source_mappings`

The Optix ↔ Clarity translation table. Same idea as your existing `external_booking_mappings`.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `account_id` | text | |
| `provider` | text | `optix` |
| `external_item_name` | text | Exactly as Optix sends it: "30 Minute Golf Lesson Package" |
| `template_service_id` | text | The Clarity `package` Service to issue from |
| `credits_override` | integer | Nullable — use the template's allowance unless set |
| `expiry_days` | integer | Nullable — days from purchase |
| `auto_issue` | boolean | Default `false`. See §5 |
| `enabled` | boolean | |

**Unique:** `(account_id, provider, external_item_name)`.

### 3.1 On `status`

`status` is a cache of three facts you can always recompute:

- `void` — someone voided it. The only genuinely stored state.
- `expired` — `expires_at < now()`
- `exhausted` — live redemptions ≥ `credits_total`
- `active` — none of the above

Recompute it at write time (issue, redeem, reverse) and lazily on read for expiry. **Never let a nightly job be the only thing that sets it** — if the job doesn't run, passes stay spendable past their expiry and you find out from a customer.

Simplest robust option: a Postgres view `pass_balances` that computes `credits_remaining` and `effective_status` from the two tables, and have the app read the view. The `status` column then exists only for indexing and can be rebuilt from scratch at any time.

---

## 4. Where passes come from

Three doors, one room.

```
   Optix new_sale webhook  ─┐
                            ├──►  Pass Inbox  ──► issue ──►  passes
   Clarity POS / invoice   ─┤                                  │
                            │                                  ▼
   Manual grant            ─┘                          pass_redemptions
                                                     (one per lesson)
```

### 4.1 Internal — sold in Clarity

You already sell `package` services on an invoice (`source: "package_sale"`) and can ring one up at the counter. Neither issues anything today.

**Add:** when a paid POS sale or a paid invoice contains a line whose product is a `package` Service, issue a Pass to that sale's customer automatically. The customer is known — no ambiguity, no inbox, no review step. It just appears under their name.

### 4.2 External — Optix

Covered in §5. This is the hard one.

### 4.3 Manual grant

A "Give pass" button on the client profile. Pick a template (or free-form: name + credits + coverage), add a note, done. `source: "manual"`, `amount_paid_cents: null`.

This exists for the real world — the comp, the goodwill gesture, the pass someone bought in cash before you had the software. Without it, people work around the system, and a system people work around stops being trustworthy.

---

## 5. The Optix Pass Inbox

### The problem, stated plainly

Your `optix-passes.mts` already documents it, and the doc comment is right:

> `new_sale` carries **no email**. The buyer is a display name only (`user_name`), so a sale cannot be auto-linked to a Clarity client the way a booking is.

The previous author explicitly rejected name-matching because two clients sharing a name would silently attach a purchase to the wrong person with no signal that anything went wrong. That reasoning holds — don't reverse it.

Also note: today's `optix_pass_purchases` table is a **raw event log**, not a pass. It has no balance, no redemption, no link to checkout. It records that something was bought. The Pass System is what turns that record into something spendable.

### The design

A **Pass Inbox** — one screen, sitting in the Optix panel or next to Billing.

Each incoming `new_sale` where `classification = 'pass'` becomes a row:

```
┌──────────────────────────────────────────────────────────────┐
│  30 Minute Golf Lesson Package            $90.00 · Sale 00652│
│  Optix buyer: "Sam Hale"          purchased 17 Aug, 8:41 pm  │
│                                                              │
│  Person   [ Sam Hale  ▾ ]   ← 1 close match                  │
│  Pass     [ 30 Min Package · 3 credits · covers 30-min ▾ ]   │
│  Expires  [ 12 months ▾ ]                                    │
│                                                              │
│               [ Not a pass ]        [ Issue pass ]           │
└──────────────────────────────────────────────────────────────┘
```

**Person** — pre-filled with the best name match, *never* committed without your click. Show how confident it is: "1 close match" vs "3 people named Sam H — pick one" vs "no match, create client?". You are the tiebreaker the payload can't provide.

**Pass** — pre-filled from `pass_source_mappings` if the item name has been mapped before. First time you see a product, you map it; every one after that arrives pre-filled and issuing is a single click.

**Not a pass** — writes `classification = 'not_pass'` back to `optix_pass_purchases` and dismisses. This is how "1 x Extra Hour" (currently sitting at `classification = 'unknown'`) gets cleared, and how you correct the keyword classifier without touching code.

**Unknowns show too.** `classifyPassPurchase` returns `unknown` for anything not matching `/pass|lesson/`. Those sit in the inbox as "is this a pass?" rather than vanishing. The current classifier is a keyword guess; the inbox is what makes a wrong guess visible and cheap to fix.

### Once a mapping is trusted

`pass_source_mappings.auto_issue` exists for the case where you've issued the same product twenty times and it's always right. Even then, auto-issue only fires when the person match is **unambiguous** — exactly one person, exact name, case-insensitive. Anything less still lands in the inbox. Ambiguity is the trigger for human review, not volume.

### Unassigned passes

If the buyer isn't a Clarity client yet, issue with `person_id = null` and let it sit as unassigned. First time you book that person in, the inbox offers "attach this pass?". A pass with no owner is honest; a pass attached to the wrong owner is a bug you find out about at the counter.

---

## 6. Checkout — spending a pass

This is where it has to feel effortless, because it's the moment that happens 20 times a week.

### What you see

Today `openPosCheckoutForLesson(item)` opens `PosCheckoutModal` with a `PosCheckoutContext`. Add one field:

```ts
type PosCheckoutContext = {
  …existing…
  availablePasses?: PassOption[];   // resolved before opening
};

type PassOption = {
  passId: string;
  name: string;          // "30 Minute Golf Lesson Package"
  creditsRemaining: number;
  creditsTotal: number;
  expiresAt: string | null;
  covered: boolean;      // does it cover THIS booking's service?
};
```

The lookup runs when the modal opens: passes for `context.customerId`, status `active`, remaining > 0.

**In the modal**, if a covering pass exists, it appears **above** the payment method buttons — because if the customer has a pass, that is almost certainly the answer:

```
┌────────────────────────────────────────────────┐
│  Sam Hale · 30 min lesson · $30.00             │
│                                                │
│  ┌──────────────────────────────────────────┐  │
│  │ ● Use pass                               │  │
│  │   30 Minute Golf Lesson Package           │  │
│  │   2 of 3 left · expires 17 Aug 2027       │  │
│  └──────────────────────────────────────────┘  │
│                                                │
│  or pay:                                       │
│  [ Clarity Pay ] [ Cash ] [ Bank ] [ …  ]      │
└────────────────────────────────────────────────┘
```

No pass → the block doesn't render and checkout is exactly what it is today. **Nothing changes for anyone who doesn't use passes.**

### Coverage

Passes that exist but don't cover this service show greyed with the reason: *"covers 30 min lessons only"*. Show them rather than hiding them — "why isn't his pass showing up?" is a support question you'll ask yourself otherwise.

Per your choice, there's **no override**: if it doesn't cover, it can't pay. If that bites in practice, widen the template's `covers_service_ids` — the fix belongs in the catalogue, not in a one-off exception at the counter.

### What happens on confirm

One transaction:

1. Re-check the balance server-side. **Never trust the number the browser had** — two devices, one pass, one credit is a real scenario in a busy bay.
2. Insert `pass_redemptions` (unique index catches a double-tap).
3. Insert `billing_pos_transactions`: `amount = 0`, `listed_amount = 30.00`, `payment_method_kind = 'pass'`, `source = 'lesson'`, `booking_id` set.
4. Recompute `passes.status` → `exhausted` if that was the last credit.

Step 3 matters: the booking flows through your **existing** paid-lesson machinery untouched. `posBookingPayments` picks it up, the lesson card shows its paid badge, the invoice pull list treats it as settled. You are not building a parallel notion of "paid".

`billing_payment_methods` gets one seeded row: name `Pass`, `kind: 'pass'`, `settles_immediately: true`, not deletable.

**Constraint changes this needs** (checked against the live DB, 18 Aug):

```sql
-- both currently allow only 'clarity_pay' | 'custom'
billing_payment_methods_kind_check
billing_pos_transactions_payment_method_kind_check
   → add 'pass'
```

Alternative: seed `Pass` as `kind: 'custom'` and identify it by name. Don't — reporting would have to string-match a user-editable name, and the day someone renames it to "Passes" the takings row silently empties. Widen the constraint.

**Unrelated bug found while checking this:** `PosTransactionSource` in `types.ts` is `"lesson" | "client" | "counter" | "optix"`, but `billing_pos_transactions_source_check` allows only `lesson | client | counter`. It doesn't bite today because Optix POS records are synthesised at read time in `billing-api.mts:2848` and never inserted — but the type says a value the table would reject. Either widen the constraint or comment the type to say `"optix"` is read-only. Worth a two-line fix while you're in here.

---

## 7. Money and reporting

**Rule: revenue is recognised when the pass is sold. A redemption is worth $0.**

Otherwise you'd count the $90 package sale *and* three $30 lessons, and your takings would read $180 for $90 of actual money.

| Event | Shows as |
|---|---|
| Optix sells a $90 pass | Revenue $90 at purchase date, source `optix` |
| You sell a $90 pass at the counter | Revenue $90, normal POS sale |
| Lesson redeemed against a pass | $0 sale, method **Pass**, `listed_amount` $30 |

`listed_amount` is already on `billing_pos_transactions` and already carries "what it would have cost" — reuse it rather than adding a column.

In the takings report, `Pass` becomes its own row alongside the existing **Coupons redeemed** row: count and imputed value, **excluded from the paid total**. Same treatment `couponTotal` already gets. So you can see *"14 lessons delivered on passes, $420 of value"* without a cent of it inflating revenue.

One deliberate consequence: **Optix pass revenue lands on the purchase date, not spread across delivery.** For a sole-trader cash view that's correct and simple. If you ever want proper deferred revenue, the ledger already holds every fact needed to compute it — it becomes a reporting change, not a schema change. That's why the ledger is worth building now.

---

## 8. Edge cases

Each of these is a real thing that will happen. Deciding now costs a paragraph; deciding later costs a migration.

**Lesson cancelled after redeeming** → reverse the redemption (`reversed_at` + reason), credit returns, `exhausted` flips back to `active`. Prompt on cancel: *"This lesson used a pass credit. Return it?"* — default yes.

**Lesson deleted outright** → same reversal, no prompt. A deleted booking cannot hold a credit.

**No-show** → your call, and it's a policy setting, not a code branch: `passes.no_show_burns_credit`, default **true**. Charging for a no-show is standard and defaulting to "credit returned" quietly costs you money.

**Refunding a pass** → void the pass. Redemptions already taken stay in the ledger (those lessons *happened*), but the pass can't be spent again. If credits were used, the refund UI shows *"2 of 3 credits already used — refund $30 of $90?"* and lets you decide the amount. Don't automate the arithmetic of a refund; surface the facts and let a human choose.

**Expiry** → set from `pass_source_mappings.expiry_days` or the template. Recommend a default of **12 months** rather than never: an unbounded liability that resurfaces two years later is a genuinely awkward conversation. An expired pass stays visible on the profile, greyed, with an **Extend** button — because you will want to be generous sometimes, and the software should let you be.

**Transfer between people** → don't build it. Change `person_id`, log it in `note`. If it turns out to happen weekly, build it then.

**Two coaches, one pass, same moment** → the unique index on `(booking_id) where reversed_at is null` plus a server-side balance re-check makes over-redemption impossible. Second one gets *"no credits left"* rather than a silently negative balance.

**Same Optix webhook delivered twice** → already handled: `optix_pass_purchases` is keyed on `event_key` and merges duplicates. Issuing is idempotent on `source_ref` too, so a redelivery can't create a second pass.

---

## 9. What to remove while building

Per your standing preference — delete, don't work around:

1. **`packageCoverageMode`** — written, sanitised, copied and displayed, but nothing ever branches on it. Verified across the whole tree: it appears in `src/App.tsx` (type, editor, label), `netlify/functions/booking-core.mts:207,589,619` (sanitiser only) and the `calendar-state.mts:42` seed row. Four files, no logic. Delete it.
2. **`packageCoversServiceId` (singular)** — replace with the array, don't keep both. One migration, one read path.
3. **Nothing in `optix_pass_purchases`** — it stays as the raw event log. It's doing a real job (an audit trail of what Optix actually sent); it just isn't a pass and shouldn't try to become one.

---

## 10. Build order

Each step is independently useful and independently shippable. If you stop after any of them, what exists still works.

| # | Step | Why here |
|---|---|---|
| 1 | `passes` + `pass_redemptions` tables, `pass_balances` view | Nothing works without the ledger |
| 2 | Manual grant + passes shown on the client profile | End-to-end proof with zero integration risk — you can see a pass under a name |
| 3 | Pass as a checkout method (§6) | The whole point. Now passes are spendable |
| 4 | Reversal on cancel / delete (§8) | Before real credits are in circulation, not after |
| 5 | Auto-issue from Clarity POS / invoice package sales | Internal source, customer already known |
| 6 | `pass_source_mappings` + the Optix Pass Inbox (§5) | The hard external half, on a foundation already proven |
| 7 | Takings report `Pass` row (§7) | Reporting last — needs real redemptions to be worth looking at |
| 8 | Expiry defaults + `packageCoverageMode` cleanup | Tidy-up |

Steps 1–4 are the system. 5–8 are the integration and the polish.

---

## Open questions for you

1. **Expiry default** — 12 months, or no expiry until you decide otherwise?
2. **Do passes cross coaches?** If you add a second coach, does a pass bought for lessons with you pay for a lesson with them? (Affects whether `coach_id` belongs on `passes`.)
3. **Should a client see their own pass balance in the Player Portal?** You have `PlayerPortal.tsx` already — "you have 2 lessons left" is a small addition with a real retention effect.
4. **Optix `1 x Extra Hour`** — bay time, not lessons. Out of scope for passes entirely, or does bay time eventually want the same treatment?
