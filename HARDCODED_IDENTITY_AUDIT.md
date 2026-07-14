# Hardcoded identity audit

**14 July 2026.** What's baked into the source that should live in the coach account instead.

The good news first: **your admin login is already clean.** `ensureAdminUser()` reads `CLARITY_ADMIN_EMAIL` and `CLARITY_ADMIN_PASSWORD` from the environment — there is no hardcoded admin user, no backdoor account, no allowlisted email. That's the one thing that *should* be tied to you, and it's the one thing done properly.

Everything below is the opposite: things tied to you that shouldn't be.

---

## 1. The serious one — your inbox was the fallback recipient (FIXED)

`public-booking.ts` ended its recipient chain with a literal address:

```ts
cleanEmail(env("CLARITY_CONTACT_EMAIL"), "") ||
"samhalegolf@gmail.com"        // ← last resort
```

`notification-engine.mts` did the same in four places with `sam@samhalegolf.co.nz`.

**Why this matters:** these are the recipients for *booking notifications* — client name, phone number, email, lesson time. Any workspace that hadn't configured a notification address would have sent its clients' booking details to your personal inbox. That's not just branding — it's someone else's client data landing with you, and yours landing with them if the roles were reversed.

**Fixed.** All personal-address fallbacks removed. An unset recipient is now empty, and `sendAndRecord()` already skips the send and logs `missing_recipient` — fail loudly, rather than quietly deliver to the wrong person.

**One catch, handled:** your own `notificationEmail` and `accountContactEmail` settings were *empty* — you were silently relying on that hardcoded fallback. Removing it would have stopped your own booking alerts. I wrote `samhalegolf@gmail.com` into your account settings (matching your existing `replyToEmail`), so your alerts keep working and the address now lives where it belongs: editable in Settings, not compiled into the product.

---

## 2. Your name and business as code defaults (PARTIALLY FIXED)

| Value | Where |
|---|---|
| `"Sam Hale"` | 31 occurrences, 10 files |
| `"Sam Hale Golf"` | env fallbacks in notification-engine, public-booking, calendar-state |
| `"The Range 24/7 - Three Kings"` | 16 occurrences, 8 files |
| `"sam-hale-golf"` | 38 occurrences, 14 files — account id + calendar slug fallbacks |

**Fixed:** the branding fallbacks in the two files that send email (`notification-engine.mts`, `public-booking.ts`) now default to empty rather than your name. Safe, because your real values are populated in settings.

**Not fixed:** `"sam-hale-golf"` as the fallback *account id* and *calendar slug* is threaded through ~14 files (`public-booking.ts`, `public-cancel.mts`, `calendar-state.mts`, `public-calendar-invite.mts`, `booking-core.mts`). This one is structural, not cosmetic: a second coach's records would silently land under the account id `sam-hale-golf` if their settings ever failed to resolve. It wants a single `defaultAccountId()` helper reading one env var, rather than 38 scattered string literals — a focused refactor, not a find-and-replace, because some of those are legitimately the *seed* value for your workspace.

---

## 3. New Zealand as an unremovable assumption

Covered in more depth in `MULTI_COUNTRY_REPORT.md`. Summary:

- `Pacific/Auckland` — 17 occurrences. **The dangerous ones are default arguments** in `booking-core.mts`: `isAppointmentInPast(item, timeZone = "Pacific/Auckland")`. A coach in London gets an 11-hour error in the code that decides whether a lesson has already happened, and it fails silently.
- `en-NZ` — 17 occurrences. Date formatting. NZ is day/month; the US is month/day. `07/08` means two different days depending on who's reading.
- `NZD` — 14 occurrences. Currency is a separate setting from country, so the two can contradict each other.
- **Fixed already:** phone numbers. `country` is now a real account setting driving a proper E.164 parser.

---

## 4. Also worth knowing

- **`server/calendar-store.mjs`** (local dev server) still has `sam@samhalegolf.co.nz` and `sam-hale` defaults. Dev-only, doesn't ship — low priority, but it's where a new contributor would learn the wrong habits.
- **`server/clarity-booking.sqlite`** is a committed binary containing your data. Worth checking what's in it before this repo goes anywhere.
- **`claritygolf.app`** — 45 occurrences. Fine as product URLs; only a problem under white-labelling.

---

## Suggested order

1. ~~Remove personal-email fallbacks~~ — **done**, this was the data-leak one.
2. Make `timeZone` a **required** argument in `booking-core.mts` — silent, high-impact, compiler finds every call site.
3. Collapse the `sam-hale-golf` fallbacks into one `defaultAccountId()` helper.
4. Derive locale and default currency from `country`.
5. Audit the committed `.sqlite` file.

---

**Verification:** full build passes, 56/56 tests pass, and no personal address remains anywhere in the shipped functions (only the comments explaining why they were removed).
