# Booking × Caddy Integration — Handover

Built 13 Aug 2026, against `Clarity_Booking_Caddy_Integration_Plan.docx`.
Touches both repos: `Claritygolf-Booking-` and `GolfDaddy`.

## Decisions this was built to

- Booking authenticates to Caddy with a **shared service secret**, server to server.
- `Include Clarity Caddy Pass` issues a **`month_pass`** — 30 days, no renewal.
- The unauthenticated `/api/admin-user-invite` was **fixed first**.

## Environment variables

Set the **same** secret in both Netlify sites. Anything long and random.

```text
# Both sites
CLARITY_SERVICE_SECRET=<same value in Booking and Caddy>

# Booking only
CLARITY_CADDY_URL=https://caddy.claritygolf.app     # optional, this is the default
CLARITY_CADDY_COACH_ACCOUNT_ID=<your Caddy account_id>   # or:
CLARITY_CADDY_COACH_EMAIL=<the email on your Caddy account>
```

Until `CLARITY_SERVICE_SECRET` is set on both sides, Booking simply skips the
Caddy steps and the profile card says Caddy is not connected. Nothing breaks.

## The security fix, first

`/api/admin-user-invite` in Caddy had **no authentication at all**. It took the
acting coach straight from the request body. Anyone who knew the URL could
create Supabase Auth users, send account-setup emails from your domain, and
attach themselves as coach to any player.

It now resolves the caller through `functions/clarity-caller.js`:

- a Supabase bearer token belonging to a coach or admin, or
- the shared service secret (Booking's server)

and takes the actor from **that**, not from the body. Only an admin can mint
another coach or admin; a coach can only create players.

**This required a matching front-end change.** `scripts/clarity-supabase-auth.js`
now sends the signed-in user's access token with the invite call. The role check
that was already in `invitePlayer()` was UI-only and proved nothing.

> Worth testing first on a deploy preview: sign in as a coach in Caddy and
> invite a player. If the token is not reaching the function you will get a 401
> rather than a silent failure.

## The seam

One endpoint, three actions: `POST /api/clarity-integration` in Caddy.

| Action | What it does |
|---|---|
| `ensureRelationship` | Idempotent, additive coach↔player link. Never removes a player from another coach. |
| `issuePass` | Writes one `user_entitlements` row. Only `month_pass` is issuable through this seam — memberships and billing stay Caddy's. |
| `playerStatus` | Account existence, access level, coach count. Read-only. |

Booking's side is `netlify/functions/_shared/caddy.mts` — the only place Booking
talks to Caddy.

## What happens when you press "Give portal access"

1. Create or link the Supabase Auth user (unchanged).
2. Create/enable the Booking portal profile (unchanged).
3. **Ensure the coach–player relationship exists in Caddy.**
4. **If the box is ticked, ask Caddy to issue a month pass.**
5. Send the welcome email — the Caddy variant only if a pass actually issued.

Steps 3 and 4 can never fail the invite. If Caddy is unreachable the player
still gets their portal and you get a toast saying what did not happen.

## Multi-coach

Nothing needed converting. Caddy already models this correctly:
`app_accounts.linked_coach_ids` / `linked_player_ids` are arrays and every write
is additive. `ensureRelationship` follows the same pattern and preserves
`created_by_coach_id` when a second coach adds an existing player.

## The deep link

`Open in Clarity Caddy ↗` on the player profile opens:

```
https://caddy.claritygolf.app/?clarityPlayer=<shared auth user id>
```

Handled by a new `scripts/clarity-booking-deeplink.js` in Caddy — a standalone
file rather than an edit to the 24,000-line `gd-app-core.js`. It uses the public
`window.GolfDaddyAccounts` API, and switching to the player still goes through
`gdAccountViewProfile`, which throws unless the coach is linked. **The URL is a
pointer, not a grant.** It also strips the parameter afterwards so a refresh or
a screenshot is not a re-entry.

If the player has not synced to that device yet, it says so rather than
implying they do not exist.

## Files

**Caddy (`GolfDaddy`)**

| File | |
|---|---|
| `functions/clarity-caller.js` | new — resolves token or service secret to an actor |
| `functions/clarity-integration.js` | new — the three actions |
| `functions/admin-user-invite.js` | now authenticated |
| `scripts/clarity-supabase-auth.js` | sends the bearer token |
| `scripts/clarity-booking-deeplink.js` | new — `?clarityPlayer=` arrival |
| `index.html`, `netlify.toml` | script tag, route |

**Booking (`Claritygolf-Booking-`)**

| File | |
|---|---|
| `netlify/functions/_shared/caddy.mts` | new — the only place Booking calls Caddy |
| `netlify/functions/booking-core.mts` | grant flow, email variants, `/api/caddy-status` |
| `src/App.tsx` | pass checkbox, Caddy card, deep link |
| `src/modules/player-profiles/playerProfiles.css` | card styling |

## Still open

- **`clarity_coach_player_links` is dead.** The table exists in Supabase with 0
  rows and no code in either repo references it — a second, abandoned model of
  the relationship `linked_coach_ids` already handles. I have left it alone
  because dropping a table is not something to do on my own initiative, but I'd
  drop it: `DROP TABLE public.clarity_coach_player_links;`
- **Nothing has been exercised against the live services.** Typecheck, 256 unit
  tests and a production build pass in Booking; every changed Caddy file passes
  `node --check`. But no real invite, pass issue, or deep link has been run.
- **Booking is single-coach.** The coach's Caddy identity comes from an env var.
  That is fine today; a second coach in one Booking workspace would need it to
  come from the coach profile instead.
- **Version 1 is deliberately manual**, per your plan. No automatic pass issuing
  from bookings or lesson rules.
