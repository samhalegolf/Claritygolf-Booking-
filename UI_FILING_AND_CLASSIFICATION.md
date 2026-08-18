# Filing System & Style Classification

**Status:** analysis, nothing built
**Date:** 18 Aug 2026
**Input:** `Global UI rules discussion` handoff — eleven rules, `--c-*` tokens, worked settings screen
**Scope:** coach admin app (`source/src`). Player portal noted where it diverges.

---

## 1. The one idea

The handoff's Rule 01 says *a box means you can act on it; text is just text.* Applied across a whole app, that turns out to be the same statement as **the filing system**:

> **A border marks a place you can go or a thing you can press.
> Everything you went there to read carries no border at all.**

Boxes are the *furniture* of the hierarchy — nav, tabs, section headers, list containers, buttons, modals. Contents are never boxed. So "what lives behind what" and "what style classification does it get" aren't two questions. Depth **is** the classification: how deep something sits decides whether it's furniture or content, and furniture is the only thing that gets a border.

That gives one test to apply to every element in the app:

**Can I click this to go somewhere, or press it to do something? If no, it has no border.**

Every non-compliant surface in §6 fails exactly that test.

---

## 2. The six levels

| Level | What it is | Examples | Rule 01 | Treatment |
|---|---|---|---|---|
| **L0** | Shell | Sidebar, topbar | 3 | 248px sidebar, 42px rows, 9px radius. Selected = filled `--c-accent`, white, 700. Rest transparent until hover. |
| **L1** | Destination | Calendar, People, Sell, Billing, Settings | 3 | One page card per destination: `1px --c-border`, 16px radius, `overflow:hidden`. Title 40px/800/-0.02em in the topbar. |
| **L2** | Section | Settings sub-nav rows, Billing sections | 3 | 216px sub-nav, 38px rows, 9px radius, `--c-surface-soft` column, `border-right: 1px --c-border-soft`. Same selected treatment as L0. |
| **L3** | Group | Accordion headers, list containers, editor cards | 3 collapsed | 52px header, 12px radius, `1px --c-border`. Open body gets `border-top: 1px --c-border-soft` — **the hairline replaces a second border, it does not add one.** |
| **L4** | Row | Settings rows, list rows, table rows | **0**, or 1 if editable | No border ever. Hairline `1px --c-border-soft` *between* rows, none on the last. Hover `--c-hover` + `✎` if editable. 54px (48px dense). |
| **L5** | Value | The value itself | **0 → 2 while live** | Plain text at rest. `1px --c-accent` only while the field is open, at `min(Nch,100%)` per Rule 05. |

**The nesting law, stated once:** a level-3 box never contains another level-3 box. L3 inside L3 drops to a hairline or to nothing. That single constraint is what stops the current "boxes inside boxes inside boxes" — and it is mechanically checkable, so it can be a lint rule rather than a matter of taste.

**Density (Rule 04)** is one attribute on the L0 shell, not a redesign: coach 40px controls / 34px pills / 54px rows; player 44px minimum / 46px primary. Embed mode is not a third density at all: it is the player density plus a `chrome: none` flag, because its audience is a customer. See Decisions.

---

## 3. Five kinds of thing

Before deciding where something lives, decide what it *is*. Everything in the app is one of five, and each has a natural depth:

| Kind | Question it answers | Depth it wants | Visited |
|---|---|---|---|
| **Work** | What am I doing now? | L1, no sub-nav | Constantly |
| **Records** | Who/what do I have? | L1 list → L2 detail | Daily |
| **Money** | What did I earn and owe? | L1 → L2 sections | Weekly |
| **Preferences** | How should it behave? | L1 → L2 → L3 accordion | Twice a year |
| **Plumbing** | Why is it broken? | L2 (admin) → L3 accordion | When something breaks |

Depth should track **how often you go there**, and today it doesn't: lesson types (edited monthly) and webhook secrets (touched once) are both two clicks inside Settings, while a Save you press twenty times a day sits inside a modal.

---

## 4. Where everything should live

### L1 — Destinations (5)

```
Calendar          the day                    Work
People            clients + player profiles  Records
Sell              the counter                Work
Billing           invoices, expenses, money  Money
Settings          how it behaves             Preferences  (Developer is its last section)
```

One change from today.

**People merges Clients and Player Profiles.** They are the same person filed twice — and demonstrably so: `.lesson-notes-list` renders in *both* the Client Profile modal ("Lesson notes" tab) and the Player Profile ("Notes" tool). One collection, two homes, and no way for a coach to know which one they wrote in. One person, one record, tabs inside it.

Developer stays inside Settings — see Decisions. Its five tabs become accordions, which is what keeps the app two levels deep without giving it a sidebar row.

### L2 — Settings sections (7)

The handoff's worked screen. Eleven tabs collapse to seven sub-nav rows, each opening a pane of L3 accordions:

| Section | Accordions inside | Comes from |
|---|---|---|
| **Business** | Identity · Branding · Coaches · Locations | `account` (venue/coach), `branding`, `experience`, `coaches`, `locations` |
| **Booking** | Availability · Booking page · Policy & notice | `availability`, `experience` (booking page) |
| **Lesson types** | Catalogue | `services` |
| **Payments** | Invoicing defaults · Payment methods · Discounts · Tax | Billing › Settings, `account` (invoicing) |
| **Notifications** | Email · SMS · Browser · Reminders | `email`, `experience` (Text Machine), Browser notifications |
| **Account** | Subscription · Security · Export & import · Close account | `account`, `data` |
| **Developer** | Webhooks · API · Mapping · Activity · Health | `integrations`, `developer` |

### L2 — Billing sections (7, from 9)

`Dashboard · Invoices · Expenses · Products · Coupons · Transactions · Reports`

**New Invoice** stops being a tab. It is an *action*, not a place — a primary button on Invoices that opens the editor. A tab implies somewhere you can be; you are never "in" New Invoice without having decided to make one.

**Billing › Settings** disappears into Settings › Payments. It is not a second opinion — `App.tsx:24384` and `App.tsx:25783` render the same `EditableSettingsBlock` against the *same* `billingSettingsEditor` state under two different DOM ids. One block of settings, two front doors.

### L3 — Developer accordions (5)

`Webhooks · API · Mapping · Activity · Health`, with the connection chosen by a picker above them rather than by a nav level. The five names and their contents are the ones built two commits ago; only the disclosure mechanism changes — tabs become `<details>`.

---

## 5. Filing errors found

Each verified in the source, most severe first.

**1. `experience` and `branding` are the same tab.** All four panels that render on `branding` are dual-classed onto `experience` (Booking Page `18916`, Theme `27331`, Coach Branding `27399`, Coach Account `25539`). There is no content unique to `branding`. Two names, one screen.

**2. Billing Settings is filed twice against one state.** `billing-settings-block` (`24384`) and `billing-settings-account-block` (`25783`) share `billingSettingsEditor` and the same `startEditableBlock("billing-settings")` key. Because Settings mounts every panel regardless of tab (`.settings-grid > .settings-section { display:none }` — CSS hides, React does not unmount), one of the two is always in the DOM behind whatever you are looking at.

**3. Video storage lives inside Google Calendar Sync.** `App.tsx:25998` opens the "Google Calendar Sync" article; "VIDEO STORAGE", "My Library and Clarity Cloud" and the "CLARITY CLOUD CATALOGUE" transfer list are all inside it, before it closes at `26764`. Video storage has nothing to do with calendar sync. It is a filing error nested inside a panel — the hardest kind to notice, because the breadcrumb is right and the content is wrong.

**4. SMS is filed under Customer Experience and Integrations, never Notifications.** "Text Machine · SMS/webhook hook" (`26981`) carries `settings-experience settings-integrations`. The one place SMS is configured is the one place a coach looking for notification settings will not look.

**5. Client CSV import is a Settings tab.** The whole `data` tab is one panel with two controls (`27528`): a textarea and a file input. Importing clients is something you do *to* People, from People.

**6. Lesson notes exist in two places.** `.lesson-notes-list` renders in both the Client Profile modal and the Player Profile tools. See §4.

**7. Settings mounts everything, always.** All 13 panels are in the DOM on every tab; only CSS hides them. Every collapsed panel keeps a tabbable Save, Delete and Close account. This is exactly what the handoff's `inert` note is about — and it is currently worse than the handoff assumes, because it is not just collapsed accordions but *ten hidden tabs* of live controls.

---

## 6. Classification — every container, its level

### Already correct

| Surface | Class | Level | Note |
|---|---|---|---|
| Sidebar | `.side-nav` | L0 / 3 | Needs 42px rows + 9px radius; selected is already filled |
| Settings tab bar | `.settings-tabs` | L2 / 3 | Becomes the 216px vertical sub-nav |
| Billing tab bar | `.settings-tabs.billing-tabs` | L2 / 3 | Reuses the same component — good, keep it |
| Clients list | `.client-table` > `.client-row` | L3 / L4 | One border, hairline rows, 54px — the model to copy |
| Lesson types, Coaches, Locations | `.service-list` > `.service-row` | L3 / L4 | Compliant |
| Invoices, Expenses, Transactions | `.recent-invoices-table` | L3 / L4 | `<table>`, `border-bottom` rows |
| Profile history tabs | `.profile-history-panel` > `.profile-history-row` | L3 / L4 | Compliant |
| Products, Coupons | module tables | L3 / L4 | Compliant |

### Level-3 boxes that should be level 0 or 4

Seven surfaces wrap each row in its own bordered, rounded, gapped card. Under Rule 08 they become hairline rows inside one container:

| Surface | Class | Now | Should be |
|---|---|---|---|
| Player profiles | `.player-profile-card` | `1px --border`, 12px radius, 10px gap | L4 row, hairline, 54px |
| Lesson notes | `.lesson-note-card` | `1px --border`, 10px gap | L4 row |
| Player videos | `.player-video-card` | `1px --border`, 10px gap | L4 row |
| Ready-to-pull bookings | `.completed-booking-list` > button | `1px #e0e6dc`, 8px radius, 8px gap | L4 row, 54px |
| Invoice customer results | `.invoice-customer-results` | boxed buttons | L4 row |
| Invoice line options | `.invoice-option-list` | boxed buttons | L4 row |
| Integration event feed | `.integration-event` | `1px #dde2d8`, 9px radius, 8px margin | L4 `<details>` row, hairline between |
| Resource priority rows | `.resource-row` | rounded `#f0f3ed` chip | L4 row, tint on hover only |

The last two are mine, from this week. Worth saying plainly: the pattern reproduces itself unless the rule is written down, which is the argument for the lint rule in §7.

### Boxes that are correct but doubled

`.data-card` inside `.settings-section` inside `.settings-grid` inside `.workspace` — up to four nested bordered containers. Under the nesting law, only the outermost keeps its border; the rest drop to hairlines or nothing. This is where the handoff's "236px → 130px" figure comes from.

### Modals that should be inline edits

Rule 11 says *edit where you read — no modal for one field.* Four qualify:

| Modal | Fields | Becomes |
|---|---|---|
| Invoice line picker (`23165`) | 1 (search) | Inline row at the bottom of the item list |
| Player add (`22090`) | 3 | Inline row at the top of the People list |
| Client profile edit (`27740`) | 5 | Inline rows in the profile pane, one edit at a time |
| Client merge review (`27648`) | 4 radios | Stays a modal — it is a decision, not an edit |

**The template already exists in this codebase.** `discountEditing` (`5037`), `datesEditing` (`5040`), `pullRangeEditing` (`5134`) and `editingInvoiceNumber` (`4995`) are four working implementations of resting → editing → saved. Rule 06 does not need inventing here; it needs extracting into one component and applied everywhere.

Genuinely-modal surfaces that stay modal: Appointment details (`27591`), POS checkout, service delete confirm, client merge. All are decisions or multi-section forms — the exception Rule 06 already carves out.

---

## 7. What follows from this

**One nesting lint.** "No `border` on an element whose nearest bordered ancestor is within the same card" catches every violation in §6 and every future one. Cheap to write against the stylesheet, and it is the only one of the eleven rules that decays silently — the other ten are visible the moment you look at the screen.

**One `width:100%` lint.** The handoff calls this "the regression that keeps returning". A bare `width:100%` on an input, a `1fr` form-grid column, or a stretching flex child are all the same bug in three costumes.

**One inline-edit component,** extracted from the four that already work, replacing both the four ad-hoc copies and `EditableSettingsBlock` — which is today's answer to the same problem but panel-shaped rather than row-shaped.

**Tokens as aliases first,** exactly as the handoff says: define `--c-*` on `:root`, point `--page`, `--pt-page` and `--va-bg` at it. Nothing has to be rewritten in one pass, and the four token systems converge without a big-bang commit.

**Order of work.** Tokens → nesting law → lists → inline edit → the settings screen. The settings screen last, because it is the worked example of all four and it is the only one that also needs the filing changes in §4.

---

## Decisions

Settled 18 Aug.

**1. People merges.** Clients and Player Profiles become one destination: one person record, tabs for Bookings · Notes · Videos · Emails · Transactions. The notes duplication was a bug, not two audiences.

**2. Developer stays inside Settings** as its last section — the sidebar keeps five rows for coaches who never open it. That leaves the question the promotion was meant to solve: a five-tab nav inside a Settings pane would be a third navigation mechanism where every other section has accordions.

It does not have to be. **Developer's five tabs become five accordions**, identical in kind to every other Settings section's contents:

```
Settings › Developer
  Connection  [ Optix ▾ ]        ← a picker, not a nav level
  ▸ Webhooks     what they send us
  ▸ API          what we send them
  ▸ Mapping      their words → ours
  ▸ Activity     everything that moved
  ▸ Health       can I use this now
```

The provider becomes a **filter, not a level**. With one connection it renders as a static label; with two it is a select. Nothing gains a level, the app stays two deep everywhere, and Developer looks like the rest of Settings instead of a foreign object inside it.

Worth noting the direction of travel: the tabs I built two commits ago become accordions. The five names and their contents survive intact — only the disclosure mechanism changes, which is a `<details>` swap rather than a rewrite.

**3. Coaches and Locations become accordions under Business.** Business = who you are, where you are, who works for you.

**4. Embed mode is the player density plus a `chrome: none` flag** — not a third density. Checked while asking: `isEmbedMode` is the public booking widget in an iframe (`App.tsx:4727`), so its audience is a customer, the same audience as the player portal. `compact-iframe.css` is then two things — the player density (already needed) and "drop the sidebar, topbar and background" (one boolean). Most of the file goes.

---

## Settings, settled

Seven sub-nav rows:

| Section | Accordions |
|---|---|
| **Business** | Identity · Branding · Coaches · Locations |
| **Booking** | Availability · Booking page · Policy & notice |
| **Lesson types** | Catalogue |
| **Payments** | Invoicing defaults · Payment methods · Discounts · Tax |
| **Notifications** | Email · SMS · Browser · Reminders |
| **Account** | Subscription · Security · Export & import · Close account |
| **Developer** | Webhooks · API · Mapping · Activity · Health *(admin only)* |
