# Integrations: the list, and a schema of field types

**Status:** design, for review before building
**Date:** 18 Aug 2026
**Follows:** the Developer tab as built (`6f35946`), the provider descriptor in `_shared/integrations/types.mts`

---

## 1. What's actually there

Six integrations ship today. Nobody planned them as a set, and yet:

| Integration | What it does | Credentials |
|---|---|---|
| **Optix** | inbound bookings + outbound bay booking | `OPTIX_CLIENT_ID`, `OPTIX_APP_SECRET`, `OPTIX_GRAPHQL_ENDPOINT`, `OPTIX_ORGANIZATION_TOKEN` / `OPTIX_PERSONAL_TOKEN`, `OPTIX_MEMBER_ID`, `OPTIX_OWNER_USER_ID` |
| **Google** | Calendar sync, Drive video storage | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (+ a second Calendar-specific pair), OAuth tokens in `google_provider_connections` |
| **Stripe** | Clarity Pay, billing sync | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_BILLING_WEBHOOK_SECRET` |
| **Akahu** | bank feed for expense reconciliation | `AKAHU_APP_TOKEN`, `AKAHU_USER_TOKEN` |
| **Resend** | transactional email | `RESEND_API_KEY`, `RESEND_FROM_EMAIL` |
| **Clarity Caddy** | the sibling app | `CLARITY_SERVICE_SECRET`, `CLARITY_CADDY_URL`, `CLARITY_CADDY_COACH_ACCOUNT_ID`, `CLARITY_CADDY_COACH_EMAIL` |

**Five of the six have no UI at all.** They are environment variables, configured by editing Netlify and redeploying, and nothing on any screen says whether they are set, working, or wrong. Optix got a screen last week because it broke often enough to earn one.

The shapes repeat, which is the whole argument for a schema: two are webhook receivers, three are token-authenticated API clients, one is OAuth, one is a key pair. Written as six bespoke screens they would drift apart the same way the four token systems did.

---

## 2. The structure

```
Settings › Integrations

  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
  │ ● Optix  │ │ ● Google │ │ ○ Stripe │ │ + New    │
  │ Bookings │ │ Calendar │ │ Payments │ │          │
  │ 4 today  │ │ Connected│ │ Not set  │ │          │
  └──────────┘ └──────────┘ └──────────┘ └──────────┘

  ── Optix ──────────────────────────────────────────
  ▸ Webhooks     what they send us
  ▸ API          what we send them
  ▸ Mapping      their words → ours
  ▸ Activity     everything that moved
  ▸ Health       can I use this right now
```

Three levels, and none of them is new: the list is L2 (a section), a connection's panes are L3 accordions, and rows inside them are L4. Same as every other settings section.

**"Integrations", not "Developer".** The word describes what is in it rather than who is expected to open it — and by the fourth or fifth connection, most of what is in there is a coach clicking Connect.

**One list, both connect methods.** Google is OAuth and Optix is pasted secrets, and earlier we split Settings from Developer on exactly that difference. This overrides it, for one reason: the question a coach actually has is *"what is Clarity talking to?"*, and that question has one answer. A card shows whatever its method needs — a Connect button, or fields. Ordered so the click-to-connect ones come first, since they are the ones a coach will touch.

**Status on the card**, because "is it working" should not require opening anything: connected and quiet, connected with a problem, or not set up.

### "+ New integration" — what it can honestly do

It lists **the integrations Clarity has code for and you have not configured**. Nothing else.

That boundary is real, not a shortcut. Reading a provider's payload means knowing what its fields are called, and that is the adapter — a decision already made deliberately over declarative field maps, because the first provider needing a conditional turns a config format into a programming language. A "+ New" that accepted arbitrary providers would produce a connection that looks configured and does nothing, which is worse than an honest short list.

Today that list is Stripe, Akahu, Resend and Caddy — four integrations that are live in the product and invisible in it. That is plenty for the button to earn its place.

---

## 3. Field primitives

Six. Everything below composes from these.

| Type | Direction | Rendered as | Stored |
|---|---|---|---|
| `copy` | **ours → theirs** | read-only, copy button | not stored, computed |
| `text` | theirs → ours | plain input | as-is |
| `secret` | theirs → ours | set / length / fingerprint | encrypted, write-only |
| `url` | theirs → ours | input, with the usual value as placeholder | as-is |
| `choice` | ours | select | as-is |
| `oauth` | handshake | a Connect button and a status line | tokens, encrypted |

Direction is a property of the field, not of the screen. That is what lets one component render both columns of the Webhooks pane without being told which side it is on — and it is the thing that is genuinely hard to hold in your head when wiring two systems together.

```ts
type FieldSpec = {
  key: string;              // the env var it lives in today
  type: "copy" | "text" | "secret" | "url" | "choice" | "oauth";
  label: string;
  help: string;             // where to find it, and what breaks without it
  required: boolean | "one-of";  // see below
  group?: string;           // "one-of" partners share a group
  defaultValue?: string;
  choices?: Array<{ value: string; label: string }>;
  /** For `copy`: how to build the value from this deployment. */
  compute?: "webhook-url" | "redirect-uri" | "event-list" | "signature-recipe";
};
```

**`required: "one-of"`** exists because Optix needs an organisation token *or* a personal token and warns when both are set, and Stripe's billing webhook secret falls back to the general one. Two fields where either satisfies the requirement is common enough to name, and "required" alone gets it wrong in both directions.

**`help` is not optional.** `OPTIX_APP_SECRET` tells an admin nothing. "Optix › Apps › your app › Secret — without it every incoming webhook is rejected as unsigned" tells them where to look and what breaks. The setup screen is the only documentation anyone reads.

---

## 4. Archetypes

Five, and all five are already in the codebase — they were just never named.

**`webhook-in`** — they push to us.
`copy` the URL, `copy` the event list, `copy` the signature recipe; `text` a client id, `secret` a signing secret.
*Optix, Stripe.*

**`api-token`** — we call them with a bearer token.
`url` the endpoint, `secret` the token, plus `text` ids identifying who we act as.
*Optix (GraphQL), Resend, Caddy.*

**`api-key-pair`** — two keys, different jobs.
`secret` × 2, one public-ish and one private.
*Akahu (app + user token), Stripe (publishable + secret).*

**`oauth2`** — they hand us a token after the user says yes.
`copy` the redirect URI, `text` client id, `secret` client secret, `oauth` the Connect button; status comes from stored tokens, not from a field.
*Google.*

**`service-link`** — a shared secret between two things we both own.
`url` the peer, `secret` a shared secret, `text` the identity on the far side.
*Clarity Caddy.*

A provider is **one or more archetype instances**, not one archetype: Optix is `webhook-in` + `api-token`, Stripe is `webhook-in` + `api-key-pair`. That composition is why an archetype is a field set rather than a screen.

```ts
type ConnectionSpec = {
  kind: "webhook-in" | "api-token" | "api-key-pair" | "oauth2" | "service-link";
  title: string;            // the accordion header
  summary: string;          // one line under it
  fields: FieldSpec[];
};

type IntegrationDescriptor = {
  id: string;
  label: string;
  category: "bookings" | "payments" | "email" | "banking" | "storage" | "internal";
  docsUrl?: string;
  connections: ConnectionSpec[];
  /** Only for providers that send us events — see §5. */
  adapter?: ProviderAdapter;
  mapping?: MappingSpec;    // Optix's workspace/resource mapping, generalised
};
```

---

## 5. The six, written out

| Integration | Archetypes | Fields |
|---|---|---|
| **Optix** | `webhook-in` + `api-token` | 2 copy, 2 secret, 1 url, 3 text — already built, this is a re-expression not a rewrite |
| **Google** | `oauth2` ×2 (Calendar, Drive) | 1 copy (redirect), 2 text, 2 secret, 2 oauth |
| **Stripe** | `webhook-in` + `api-key-pair` | 1 copy, 3 secret (`one-of` on the two webhook secrets) |
| **Akahu** | `api-key-pair` | 2 secret |
| **Resend** | `api-token` | 1 secret, 1 text (from address) |
| **Caddy** | `service-link` | 1 url, 1 secret, 2 text |

Only Optix and Stripe carry an `adapter`, because only they send events Clarity has to interpret. Google's tokens are handled by its OAuth code, and Akahu, Resend and Caddy are outbound only. **A descriptor without an adapter is a valid, complete integration** — that is what makes the schema fit five things that are not Optix.

---

## 6. What this changes

**Kept as-is.** The five panes (Webhooks · API · Mapping · Activity · Health) and everything in them. `ProviderAdapter`, `providerCapabilities`, the ingest pipeline, the credential status endpoint — none of it moves.

**Generalised.** `ProviderDescriptor` becomes `IntegrationDescriptor`: `webhook?`/`api?` become `connections[]`, and the credential list becomes `FieldSpec[]` with a `type`. `/api/integration-setup` grows a list mode returning every descriptor with its status, and keeps its detail mode.

**New.** The list screen. `+ New`. Field renderers for `url`, `choice` and `oauth` — `copy`, `text` and `secret` already exist as `CopyField` and `CredentialField`.

**The open question this does not solve.** Credentials still live in environment variables, so every field is read-only in the UI and setup still means editing Netlify. Making them editable needs an encrypted settings store — the pattern is already in `google_provider_connections`, which encrypts refresh tokens with `GOOGLE_PROVIDER_TOKEN_ENCRYPTION_KEY_V`. Worth doing, and worth doing *after* this, because the schema is what tells the store which fields are secret.

---

## 7. Build order

| # | Step | Why here |
|---|---|---|
| 1 | `FieldSpec`, `ConnectionSpec`, `IntegrationDescriptor` | Everything reads from these |
| 2 | Re-express Optix in them | Proves the schema against the one we know, and it either fits or it does not |
| 3 | List mode on `/api/integration-setup`, with status per integration | The list needs something to list |
| 4 | The Integrations list screen + card status | The structure you asked for |
| 5 | Optix detail behind a card | Same five panes, one level deeper |
| 6 | Field renderers for `url`, `choice`, `oauth` | Needed before any non-Optix descriptor renders |
| 7 | Stripe, Akahu, Resend, Caddy descriptors | Four integrations that are live and invisible |
| 8 | Google, incl. the Connect button and token status | Most different, so last — and it earns the `oauth2` archetype |
| 9 | `+ New` | Needs 7 and 8 to have anything worth listing |

Steps 1–5 are the restructure. 6–9 are what makes it worth having done.

---

## One thing worth disagreeing with early

Naming the archetypes risks the usual failure: an abstraction fitted to what exists, which then fights the seventh integration. The check I would apply — **a new archetype is only worth adding when two providers need it.** `service-link` currently has one member (Caddy) and is on probation; if nothing else ever links to a peer service, it should collapse into `api-token`, which is what it nearly is.
