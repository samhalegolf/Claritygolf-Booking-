# Integrations & Developer Tab — Design

**Status:** design only, nothing built
**Date:** 18 Aug 2026
**Scope:** re-organise and re-label the Optix integration so it's provider-neutral. No settings change meaning or value.

---

## 1. The problem, stated plainly

`Settings > Integrations` today renders one grid holding four unrelated things:

```
settings-grid settings-tab-integrations
├── <OptixIntegrationPanel />      ← 5 tabs of Optix-specific plumbing
├── <BrowserNotificationsPanel />  ← not an integration at all
├── Google Calendar sync           ← OAuth, coach-facing
└── Google Drive transfer          ← OAuth, coach-facing
```

Two problems. The obvious one: nothing here survives contact with a second provider — `OptixIntegrationPanel.tsx` has the workspace id `"637949"` written into it three times and your seven bay ids in a `const BAYS` array. The subtler one: **a coach connecting their Google Calendar and a developer wiring up a booking system are doing completely different jobs, and they're sharing a screen.**

---

## 2. Your naming questions, answered

### "The intake data portion — Webhooks?"

**Yes.** That's exactly the right word and it's what Optix's own docs call it.

### "The system where I book a bay — is that more of an API?"

**Yes.** And the distinction you've spotted isn't cosmetic — it's the correct organising axis for the whole screen. It isn't really *webhook vs API*, it's **who starts the conversation**:

| What happens | Who starts it | Mechanism | Tab | Credentials flow |
|---|---|---|---|---|
| Optix tells Clarity a bay was booked | **Them** | HTTP POST to a URL we publish | **Webhooks** | We give them a URL. They give us a signing secret. |
| Optix tells Clarity a pass was sold | **Them** | same | **Webhooks** | same |
| Clarity books a bay in Optix | **Us** | GraphQL call to their endpoint | **API** | They give us an endpoint + tokens. |
| Clarity checks a booking is still correct | **Us** | GraphQL poll (`optix-reconcile`) | **API** | same |

Webhook and API happen to map cleanly onto inbound and outbound, which is why your instinct works. Going with mechanism-first names (**Webhooks** / **API**) rather than direction-first ones is the right call for one reason: whoever sets this up will have the other system's documentation open beside them, and that documentation says "webhook" and "API". Matching their vocabulary costs nothing and saves a translation step.

**The one case that trips everybody:** *auto-book a bay after a client booking* feels like a single feature, but it's two directions stitched together — webhook in, API out. Today they're tangled in one panel, so when it breaks you can't tell which half failed. Splitting by direction makes that visible. The Activity log (§8) is where you'd then see `booking_created ← in` followed by `bookingSet → out failed`.

---

## 3. The split: Settings vs Developer

You're right that Google belongs on the main menu. Here's the rule that makes it generalise:

> **If connecting means clicking "Connect" and logging in → Settings > Integrations.**
> **If connecting means copying secrets between two admin panels → Developer.**

It's a good rule because it splits on *who does the work*, not on how technical the provider is. Google Calendar is OAuth — you click, you approve, you're done. Optix is a client id, an app secret, two API tokens, a member id and an owner user id, pasted by hand.

**Result:**

```
Settings
└── Integrations          ← coach-facing, click-to-connect
    ├── Google Calendar
    ├── Google Drive
    └── (future: Xero, Stripe, Mailchimp…)

Developer                 ← admin-only, credentials and plumbing
├── Connections
├── Activity
└── API keys
```

**`BrowserNotificationsPanel` moves out of both.** It's a browser permission prompt for push notifications on your own device — nothing connects to anything. It belongs under Account or Notifications. It's sitting in Integrations because Integrations became the drawer for "things that didn't fit".

---

## 4. Developer tab structure

```
Developer
│
├── Connections
│   │
│   ├── ● Optix                                    Connected · 4 events today
│   │     ├── Webhooks     what they send us
│   │     ├── API          what we send them
│   │     ├── Mapping      their words → our words
│   │     └── Health       is it working
│   │
│   └── + Add connection
│
├── Activity              one log, every provider, both directions
│
└── API keys              Clarity's own outward surface (future)
```

A **Connection** is one provider. It has up to four parts, and a provider only shows the parts it actually uses — a webhook-only provider shows no API tab and doesn't look broken for it.

The connection list is where you see health at a glance. One line per provider, with the thing you actually care about: is it on, and has anything arrived lately.

---

## 5. The credential UI — the part that matters most

This is the single highest-value idea in the re-design, and it comes straight out of your own question: *"reveal whatever keys and codes need to be given to the other end and have an input in Clarity for the other way round."*

The hardest part of wiring up any integration is not the values — it's knowing **which direction each one travels**. So make direction the layout.

Every credential screen is two columns:

```
┌─ Webhooks ─────────────────────────────────────────────────────────┐
│                                                                     │
│  GIVE THESE TO OPTIX              PASTE THESE FROM OPTIX            │
│  ─────────────────────            ─────────────────────             │
│                                                                     │
│  Webhook URL              [copy]  Client ID                         │
│  https://claritygolf.app/         [ 8f3a…                       ]   │
│  api/optix-webhook                Optix › Apps › your app › ID.     │
│  Paste into Optix ›               Every payload carries this; we    │
│  Developers › Webhooks.           reject anything that doesn't      │
│                                   match.                            │
│                                                                     │
│  Subscribe to these       [copy]  App secret            ●●●●●●●●    │
│  events                           [ •••••••••••••••••••••••••   ]   │
│  · booking_created                Optix › Apps › your app ›         │
│  · booking_updated                Secret. Write-only — we can       │
│  · booking_cancelled              never show it again once saved.   │
│  · new_sale                                                         │
│  · new_plan_subscription          Signature recipe      read-only   │
│                                   sha256(client_id + app_secret     │
│  Nothing else is read.            + created_timestamp)              │
│                                                                     │
│                     [ Send test webhook ]                           │
└─────────────────────────────────────────────────────────────────────┘
```

Three things make this work:

**Left column is read-only with copy buttons.** These are facts about Clarity that the other system needs. You never type them, you never get them wrong.

**Right column is masked, write-only inputs.** Secrets go in and don't come back out. Show `Set · updated 14 Aug` rather than a value.

**Every field carries a helper line saying three things:** what it's called *on their side*, where to find it, and what breaks without it. That last part is what turns a form into documentation. `OPTIX_APP_SECRET` means nothing; *"Optix › Apps › your app › Secret. Without it every incoming webhook is rejected as unsigned"* means everything.

The signature recipe being visible is deliberate. `sha256(client_id + app_secret + created_timestamp)` is currently buried in `optix-webhook-auth.mts:18` and is exactly the thing that silently fails when a secret is pasted with a trailing space. Showing the recipe means a 401 is debuggable from the screen rather than from the source.

The API tab is the same shape, with only a right column:

```
┌─ API ───────────────────────────────────────────────────────────────┐
│                                                                     │
│  PASTE THESE FROM OPTIX                                             │
│                                                                     │
│  GraphQL endpoint    [ https://api.optixapp.com/graphql         ]   │
│                      Default is correct unless Optix moved you.     │
│                                                                     │
│  Organisation token  [ ••••••••••••••••••••••••••••••           ]   │
│                      Optix › Settings › API. Used for bay booking.  │
│                                                                     │
│  Personal token      [ ••••••••••••••••••••••••••••••           ]   │
│                      Fallback when no org token is set. One of      │
│                      the two is required.                           │
│                                                                     │
│  Member ID           [ 12345                                    ]   │
│                      Who the bay booking is made as.                │
│                                                                     │
│  Owner user ID       [ 67890                                    ]   │
│                      Who owns the resulting booking in Optix.       │
│                                                                     │
│              [ Test connection ]   Last OK 18 Aug, 9:04 am          │
└─────────────────────────────────────────────────────────────────────┘
```

**Both test buttons are new and both are overdue.** Right now the only way to find out whether this is wired correctly is to book a real lesson and watch what happens. "Test connection" should make one harmless read call; "Send test webhook" should POST a synthetic signed payload at your own endpoint and show the result. Two small features that turn setup from guesswork into a green tick.

---

## 6. The provider registry

You chose to add this now, which is the right moment — the registry is what stops the generic UI from being generic in name only.

One descriptor file per provider. It is a **description, not an abstraction layer**:

```ts
// integrations/providers/optix.ts
export const optix: ProviderDescriptor = {
  id: "optix",
  name: "Optix",
  docsUrl: "https://developer.optixapp.com",

  webhook: {
    path: "/api/optix-webhook",
    events: [
      { id: "booking_created",       label: "Booking created" },
      { id: "booking_updated",       label: "Booking updated" },
      { id: "booking_cancelled",     label: "Booking cancelled" },
      { id: "new_sale",              label: "Product sale",  note: "Pass purchases arrive here" },
      { id: "new_plan_subscription", label: "Plan started" },
    ],
    credentials: [
      { key: "clientId",  label: "Client ID",  secret: false,
        help: "Optix › Apps › your app › ID. Every payload carries this." },
      { key: "appSecret", label: "App secret", secret: true,
        help: "Optix › Apps › your app › Secret. Signs every delivery." },
    ],
    signatureRecipe: "sha256(client_id + app_secret + created_timestamp)",
  },

  api: {
    kind: "graphql",
    defaultEndpoint: "https://api.optixapp.com/graphql",
    credentials: [ /* org token, personal token, member id, owner user id */ ],
    capabilities: ["book-resource", "cancel-resource", "reconcile"],
  },

  mapping: {
    workspaceLabel: "Optix workspace",
    resourceLabel:  "Bay",
    resourcesFrom:  "api",          // ← fetched, never hardcoded
  },
};
```

The panel renders from this. Adding a provider becomes writing a descriptor plus a transport adapter, not forking the panel.

**What this pulls out of the code:**

| Hardcoded today | Where | Becomes |
|---|---|---|
| `"637949"` workspace id | `OptixIntegrationPanel.tsx` ×5 — lines 79, 110, 136 (logic) and 193, 196 (copy) | Saved connection value |
| `const BAYS` — 7 bay ids + names | `OptixIntegrationPanel.tsx:18-23` | Fetched from the Optix API |
| `"637949 · Swing Analysis"` label | `OptixIntegrationPanel.tsx:196` | Fetched |
| `"600006"` named as an ignored bay workspace | `OptixIntegrationPanel.tsx:193` prose | Fetched |
| Event names in prose | `passes` tab empty-state copy | `descriptor.webhook.events` |
| `/api/optix-webhook` | diagnostics tab | `descriptor.webhook.path` |

**`BAYS` is the one to fix first.** Seven bay ids and the names "Bay #1"…"Bay #7" are compiled into the frontend. They're literally your bays. A second user of this software would configure their resource profiles against your range. Everything else on this list is untidy; that one is wrong.

**A deliberate limit on the registry:** it describes *what fields exist and what they're called*. It should not try to make Optix's GraphQL and some future provider's REST API look like the same thing behind one interface. That's where generic integration layers go to die — you end up with an abstraction that fits exactly one provider and fights the second. Keep the transport per-provider (`optix-client.mts` stays as it is); share only the shape of the settings screen, the event log, and the mapping tables.

---

## 7. Mapping tab

Everything that translates their vocabulary into yours, in one place:

| Their side | Our side | Exists today as |
|---|---|---|
| Workspace | Clarity account + location + default coach | Setup tab |
| Booking type | Clarity lesson type | Forced to "External Booking" |
| Resource (bay) | Resource profile + priority order | Resources tab |
| Product name | Pass template | *new* — see the Pass design |

Renaming the current **Resources** tab to sit under **Mapping** matters more than it sounds: bay profiles aren't Optix settings, they're a translation between Optix resource ids and Clarity lesson types. Filing them as mapping is what makes the same screen work for a provider that calls them "courts" or "rooms" — `descriptor.mapping.resourceLabel` supplies the word.

**One deliberate exception:** the Optix-product → pass-template mapping from the Pass design lives with the **Pass Inbox** under Billing, *not* here — because you create those mappings while working through the inbox, not while configuring a connection. Cross-link the two screens rather than splitting the workflow.

---

## 8. Activity — one log, all providers

Replaces the current **Data feed** tab, and closes a real gap.

Today `optix_webhook_events` records everything **inbound** in good detail. There is no equivalent for **outbound** — a failed bay booking surfaces only as an `outboundBayBookingId: "Not booked"` field on the inbound event that triggered it. If a bay booking fails on retry, or on a reconcile pass with no originating webhook, **there is nowhere it appears at all.**

```
┌─ Activity ──────────────────────────────────────────────────────────┐
│  [All providers ▾] [All directions ▾] [Failed only ☐]   [Refresh]   │
│                                                                     │
│  09:04  Optix   → out  bookingSet        Bay #3, 9:30am    ✓ ok     │
│  09:04  Optix   ← in   booking_created   Ben Healy         ✓ processed│
│  08:41  Optix   ← in   new_sale          Sam Hale          ⚠ unclassified│
│  08:12  Optix   → out  bookingSet        Bay #1, 8:30am    ✗ no_resource│
│  07:55  Google  → out  calendar.sync     14 events         ✓ ok      │
│                                                                     │
│  3 events waiting to process    [ Replay last 7 days ▾ ] [ Process ] │
└─────────────────────────────────────────────────────────────────────┘
```

Direction as a first-class column is what makes the auto-book chain readable: the `← in` and the `→ out` it caused sit next to each other, and you can see which half broke.

Keep the existing behaviour that already works well: expandable rows with the raw payload, per-event retry, and bulk replay over a date window. They're good; they just need to cover both directions and every provider.

**Data-layer note:** with scope set at *UI + registry*, `optix_webhook_events` stays as it is for now and the log reads from it with `provider` hardcoded to `"optix"`. Add one new table for outbound (`integration_outbound_events` — provider, direction, operation, subject, status, request/response, error) and have the Activity screen union the two. Renaming the inbound table to something provider-neutral is a later, separate migration.

---

## 9. Health tab

The current **Diagnostics** tab is close to right — keep the counters, make the checks answer *"can I actually use this right now"*:

```
Webhook endpoint      ✓  Reachable · last delivery 4 min ago
Webhook signature     ✓  Client ID and secret set · last 40 deliveries verified
API credentials       ✓  Organisation token · test call OK 9:04 am
Workspace mapping     ✓  637949 → sam-hale-golf · enabled
Resource list         ⚠  Loaded from a hardcoded list, not the Optix API
Waiting to process    ✓  None
```

Each row is a fact with a timestamp, not a label. `Settings/feed endpoint: Connected` in today's panel tells you the browser could reach Clarity — not that Optix can reach you, which is the thing you want to know.

---

## 10. Build order

| # | Step | Why here |
|---|---|---|
| 1 | Split the tabs: Google → Settings > Integrations, Optix → Developer, notifications → Account | Pure move, no logic. Immediately makes the rest obvious |
| 2 | `ProviderDescriptor` type + `optix.ts` descriptor | Everything below reads from it |
| 3 | Re-shape the Optix panel into Webhooks / API / Mapping / Health | The re-label you asked for |
| 4 | Credential screens with the two-column direction layout (§5) | The bit that makes it usable by someone who isn't you |
| 5 | Test connection + Send test webhook | Small, and turns setup from guesswork into a green tick |
| 6 | Fetch bays from the Optix API; delete `const BAYS` | The one genuinely wrong hardcode |
| 7 | Outbound event table + unified Activity screen | Closes the outbound blind spot |
| 8 | Move workspace id out of the component into saved connection state | Last hardcode standing |

Steps 1–3 are the re-organisation you asked for and could ship as one pass. 4–8 are what make it true rather than cosmetic.

---

## 11. What to delete along the way

- **`const BAYS`**, `BAY_IDS` and `bayName()` in `OptixIntegrationPanel.tsx:18-23` — replaced by the API fetch, not kept as a fallback. A stale fallback that silently supplies the wrong bay names is worse than an empty list with an error.
- **All five `"637949"` literals** — one saved value, not three comparisons and two hardcoded sentences of UI copy.
- **`BrowserNotificationsPanel` from the integrations grid** — move, don't copy.
- **Diagnostics' `Settings/feed endpoint` and `Resource endpoint` rows** — they report whether the browser reached Clarity, which is never the question. Replaced by the Health checks in §9.

---

## Open questions

1. **Does Developer sit inside Settings or beside it?** A top-level item is more discoverable; nested under Settings keeps the top nav short. Leaning nested, admin-only.
2. **Where do credentials live once they leave env vars?** Netlify env vars are fine for one workspace but can't be edited from the UI, which defeats the whole point of §5. Wants an encrypted settings row — you already have `GOOGLE_PROVIDER_TOKEN_ENCRYPTION_KEY_V` and a working pattern in `google_provider_connections` to copy.
3. **Should `Add connection` exist before there's a second provider to add?** An empty picker is honest but looks unfinished. Could ship as "Optix · connected" with no add button until provider two arrives.
4. **Clarity's own API** — the third Developer section is a placeholder. Is anyone asking to call *into* Clarity yet, or is that hypothetical?
