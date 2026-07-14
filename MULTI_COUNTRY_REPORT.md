# Making Clarity Golf make sense outside New Zealand

**14 July 2026 — written off the back of the "Another person already uses that email address" bug.**

---

## 1. What the bug actually taught us

The save failure was not an email bug. The chain was:

1. Brian Fox existed twice: once as `'+64274637700` (spreadsheet import, Excel's text-cell apostrophe) and once as `0274637700` (typed into the booking form).
2. The **frontend** knew these were the same person — `App.tsx` had `canonicalPhoneKey`, which folded a leading `64` to `0`.
3. The **server** did not — `booking-core.mts` had `normalizedPersonPhone`, which only stripped non-digits. `64274637700 ≠ 0274637700`.
4. So the server failed to match the existing contact, fell through to `INSERT`, and hit the account-scoped unique index on `lower(email)`.
5. The failed INSERT rolled back the transaction — taking the lesson down with it — and the 409 was rendered as *"Another person already uses that email address."*

**The root cause was a country assumption, hardcoded twice, inconsistently.** That is exactly the failure mode that multiplies when you add a second country.

Fixed: one shared module (`netlify/functions/_shared/phone.mts`) that frontend and server both import. It parses to E.164 (`+64274637700`) via `libphonenumber-js`. They can no longer disagree.

---

## 2. The one primitive that's missing: `country`

The app already stores `timezone` (per account and per location) and `currency` (invoice settings). It has **never had a country.** That's the gap — country is the primitive nearly everything else should derive from:

| Derives from country | Currently |
|---|---|
| Phone dial code / parsing | Hardcoded NZ (`64`) in 3 places |
| Date format | Hardcoded `en-NZ` |
| Default timezone | Hardcoded `Pacific/Auckland` |
| Currency | Separate setting, defaults `NZD` |
| Address format, tax labels | Not modelled |

**Done in this change:** `country` (ISO 3166-1 alpha-2) is now a first-class account setting — persisted as `accountCountry`, defaulting from `CLARITY_COUNTRY`, exposed in Settings as a searchable dropdown showing the dial code, and wired into phone parsing on both sides.

---

## 3. What's still hardcoded to New Zealand

These are the remaining landmines, in priority order.

### 3.1 `Pacific/Auckland` as a literal fallback — **highest risk**

`booking-core.mts` repeats `"Pacific/Auckland"` as a *default argument* in the appointment-time logic:

```
nowInTimeZoneParts(timeZone = "Pacific/Auckland")
isAppointmentInPast(item, timeZone = "Pacific/Auckland")
buildCalendarState(..., timeZone = "Pacific/Auckland")
```

An account already *has* a timezone, and callers mostly pass it. But any call site that forgets silently gets Auckland — and this code decides **whether an appointment is in the past**. For a coach in London that's an 11–13 hour error: lessons vanish, reminders fire at the wrong time, past/future logic inverts.

This is a bug *today* for a non-NZ coach, and it fails silently. Fix by making `timeZone` a required argument — let the compiler find every call site — rather than defaulting it.

### 3.2 `en-NZ` date formatting

`toLocaleDateString("en-NZ", …)` is hardcoded. NZ is day/month/year; the US is month/day/year. A US coach reading `07/08` as August 7th when it means July 8th is a missed lesson. Derive the locale from `country`.

### 3.3 Currency is decoupled from country

`currency: "NZD"` is an independent invoice setting, so a coach can set country = US and still be invoicing in NZD. Default currency from country, but keep it overridable — coaches near borders, or billing tourists, legitimately need this.

### 3.4 The account-scoped unique email index — **a real product decision**

There's a contradiction in your migration history:

- `20260623000200_allow_shared_client_contacts` **dropped** the unique email index, with the comment: *"Multiple clients may legitimately share a family, school, club or organisation email address."*
- `20260704000100_add_people_account_scope` **reintroduced** uniqueness as `(account_id, lower(email))`.

Since you have exactly one account, that index means **two people can never share an email address** — which is precisely the family case the earlier migration set out to support. A mum booking lessons for two kids with her email cannot exist in the data model.

This is what makes the failure so sharp: it isn't a corner case, it's a golf-lesson-shaped case. Options:

- **(a) Drop the unique index**, keep app-level dedupe (name + phone + email). Honours the family case. Risks more duplicate contacts.
- **(b) Keep it**, and have the booking form explicitly ask "is this a new person or the same person?" when an email is reused.

I did **not** change this — it's your call. But the current state promises one thing in the migration comments and enforces the opposite.

---

## 4. Recommended sequence

1. **Make `timeZone` a required parameter** in `booking-core.mts` (§3.1). Silent, high-impact, and the compiler does the work.
2. **Derive locale + default currency from `country`** (§3.2, §3.3).
3. **Decide the shared-email question** (§3.4).
4. **Per-location country** — you already model locations with their own timezone. A coach running clinics across a border would need this. Not urgent.

---

## 5. Cost of the phone change (measured, not estimated)

`libphonenumber-js` is the industry-standard implementation (the same rules Google, Stripe and Twilio use). Measured against the pre-change build:

| | Raw | Gzipped | Modules |
|---|---|---|---|
| Before | 814.61 kB | 218.32 kB | 1733 |
| After | 935.98 kB | 249.10 kB | 1846 |
| **Cost** | **+121.4 kB** | **+30.8 kB** | +113 |

~+14% on a bundle that was already over Vite's 500 kB warning threshold. Worth it for correctness, but if you want it back: import from `libphonenumber-js/core` with a metadata subset containing only the countries you actually operate in — that trims the bulk of the 121 kB while keeping the same API.

**Verification:** full build passes (`tsc` + `vite build`), 56/56 existing tests pass, and the canonicaliser round-trips national ↔ international ↔ Excel-apostrophe forms correctly for NZ, AU, GB and US, while keeping genuinely different numbers distinct.
