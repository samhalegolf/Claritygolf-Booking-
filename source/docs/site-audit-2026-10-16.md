# Site audit: structure, speed and cohesion

**Date:** 16 Oct 2026
**Scope:** everything under `source/` (coach app, player portal, public booking, Netlify functions, native shells)
**Baseline:** `tsc --noEmit` clean, 1298 tests passing, production build 18 s

## Where things stand

The app is in far better shape than the August filing doc describes. Since then the shells were split and lazy-loaded, Settings panels stopped mounting all at once, the workspace and client logic moved into hooks, the `--c-*` tokens are read in 2,600 places, and there is no dead module, no TODO marker, and no stray `console.log` anywhere in `src`. Those are not the problems any more.

What is left is concentrated in four places:

1. **`App.tsx` is still a 23,000-line component.** Players, Billing and Settings render about 6,000 lines of inline JSX between them, and the component holds 247 `useState` calls. Everything that was extracted recently went well; these three screens were simply never reached.
2. **The coach shell downloads code and data it never uses.** The server's email translations (about 200 KB) and the full phone-number metadata ship to the browser, and the 418 KB `styles.css` loads for players and the public booking widget as well as coaches.
3. **Styling has one token system but four dialects on top of it.** The legacy `--border`/`--muted` aliases, the player-portal `--pt-*` aliases, the independent `--booking-*` palette, and 650 literal hex colours that mostly already have a token.
4. **One Netlify library file is bundled into 33 functions.** Every one of those functions pays `booking-core.mts`'s 12,000 lines on a cold start, including the five auth endpoints.

Nothing here is a rewrite. Each item is a contained piece of work, and the order at the end keeps the app shippable at every step.

## 1. Speed

### What the browser downloads

Measured from `vite build` with source maps, so the attribution is exact.

| Chunk | Minified | Gzip | What is in it |
|---|---|---|---|
| `App` (coach shell) | 721 KB | 196 KB | `App.tsx` is 1,174 KB of the 1,760 KB source |
| `boot` | 258 KB | 81 KB | React and the shells' router. Fine. |
| `serviceModel` | 249 KB | 55 KB | **~200 KB is the server's email translations and time-zone table** |
| `activeCountry` | 121 KB | 30 KB | **libphonenumber-js with full metadata** |
| `VideoAnalysisPage` | 162 KB | 51 KB | Loaded on demand. Fine. |
| `PlayerPortal` | 87 KB | 23 KB | Fine. |
| Each locale JSON | 350–415 KB | 115–125 KB | Whole-app strings, loaded before first paint for non-English browsers |
| `styles.css` + `switches.css` | 283 KB | | Loaded by nine shells including the player portal |

**Findings, largest first.**

- **The server's email translations are shipped to every coach.** `src/modules/workspace/workspaceModel.ts:8` imports `cleanMessageLanguage` from `netlify/functions/_shared/message-language.mts`. That module statically imports all twelve `message-locales/*.mts` files, so a three-line validator drags about 200 KB of server-side email wording into the `serviceModel` chunk. `RegionSettings.tsx:13` does the same for `MESSAGE_LANGUAGES`. Fix: move `MESSAGE_LANGUAGES` and `cleanMessageLanguage` into their own tiny module that both sides import. Saves about 50 KB gzip on every coach load with no behaviour change.
- **Full phone metadata.** `_shared/phone.mts:22` imports from `libphonenumber-js` (full build, 237 KB source). The client only needs parsing and formatting, which `libphonenumber-js/min` or `/mobile` provide at a fraction of the size. The server can keep the full build if it needs the extra validation. Needs a quick check that the functions the client uses are the same across builds.
- **The app stylesheet loads for players and booking widgets.** `src/appStyles.ts` is imported by nine shells. The player portal already has its own 56 KB stylesheet but still pulls the 418 KB coach stylesheet first. Players are the biggest audience on the slowest connections. Fix is a longer piece of work (section 3) because `playerPortal.css` leans on shared classes from `styles.css`. A first step is measurable: find which `styles.css` selectors the player portal DOM actually hits and move those into a `shared.css` both shells import.
- **Each language file carries every string in the app.** `src/locales/*.json` is one flat file per language and `main.tsx` waits for it before importing `boot`. A Japanese player waits for 125 KB gzip of mostly coach-only strings before anything paints. Splitting per shell (coach / player / public) is possible because `t()` keys are the English text, so the build step in `scripts/i18n-keys.mjs` can be told which files feed which shell. Medium effort, meaningful for the player app on mobile.
- **`SandboxBar` and `PublicSite` are static imports in `boot.tsx`.** Both land in the entry chunk for every page with their stylesheets (`sandbox.css` 8 KB, `publicSite.css` 7 KB). `PublicSite` only renders at `/`, `/privacy`, `/terms` and `/support`; it should be lazy like the other shells. `SandboxBar` is deliberately static per its comment; keep it but it does not need `sandbox.css` for the bar alone.
- **`BusinessHubPanel` and `CoachProfilePanel` are static imports in `App.tsx`** (lines 150–151) while every other screen panel is lazy. Together they are about 37 KB of source on the Profile view only.
- **Breakpoints are inconsistent.** `styles.css` has width queries at 480, 720, 760, 820, 980 and 1120 px. Six breakpoints for one app means phone layouts switch at different widths on different screens. Pick two (phone and narrow desktop) and move them to tokens.

### What the server does

- **`booking-core.mts` (11,987 lines) is imported by 33 function files.** Netlify bundles each function separately, so each of the 33 carries its own copy and pays the cold start. The five `auth-*` functions, `notes`, `locations`, `coaches` and `people` each import the whole thing for one handler. The Oct 7 commit "Answer the coach session check without loading the booking core" already did this for `auth-session`; the same split applies to the rest. The handlers themselves do not need to move; only the import graph does, by lifting the shared helpers they use out of `booking-core.mts` into `_shared/`.
- **`billing-api.mts` is 6,027 lines in one file** with its own `formatMoney` and value cleaners. Same shape of problem, smaller.
- **Database pooling is right** (`_shared/database.mts`: cached pool, max 3, transaction pooler). No change needed.
- **The wildcard exclusion test has a soft spot.** `uiRules.test.ts:315` treats `/api/passes` as covering `/api/passes/inbox`, but Netlify's `excludedPath` is a literal match unless it ends in `/*`. `booking-api.mts` lists neither `/api/passes/*` nor `/api/practice-block-presets/*`, and the client calls both. If those routes work today it is because their own functions match first; the test should still say what it checks. Add the two `/*` entries and drop the prefix shortcut.

## 2. Structure

### `App.tsx`

The main `App` component runs from line 2034 to 24950. The recent extractions (calendar, booking flow, clients, workspace sync, diagnostics) left the component with 247 `useState`, 62 `useMemo` and 52 `useEffect` calls, and about 6,100 lines of inline JSX. Three screens account for almost all of it.

| Screen | Lines | Where | Note |
|---|---|---|---|
| Players (Player profiles) | ~1,600 | 19216–20823 | Tool tabs for bookings, reviews, emails, transactions, passes, portals, notes, practice, video. The newest UI patterns live here, but inline. |
| Billing | ~2,100 | 20903–23023 | Dashboard, invoice list, **the 1,020-line invoice editor** (21359–22380), transactions, and Billing › Settings. |
| Settings | ~1,670 + panel consts | 23074–24741 and 14179–16776 | Services (731), Google Calendar (658), Locations (329), Availability (215), Booking (196), Account, Notifications, Theme, Branding, Import clients. |
| Appointment drawer | 410 | 16788–17198 | `selectedAppointmentDetails` |
| Billing grouped sections | 786 | 18033–18819 | Expenses, bank reconcile, CSV import |

State to go with them: 34 `useState` for expenses and bank reconcile (nine of them for CSV column mapping), 26 for the invoice editor, 22 for player profiles, 13 for the client profile, 11 for POS, 10 each for video library, service editor and passes.

The pattern that already worked for clients (`useClientProfileController` + `ClientProfileView`) is the template. Each screen becomes a controller hook and a view module, and `App.tsx` keeps the shell, the view switch and the cross-screen state (session, workspace, people, toast). Done in the order Players, invoice editor, Settings panels, Billing settings, `App.tsx` lands around 8,000 lines and the coach chunk drops because each screen becomes its own lazy chunk.

### Things filed twice

- **Billing Settings is still two editors for one state.** `billing-settings-block` (App.tsx:22703, Billing › Settings) and `billing-settings-account-block` (App.tsx:23373, Settings › Account) both bind `billingSettingsEditor` under the same `startEditableBlock("billing-settings")` key. One should go. Billing › Settings is the one coaches find; Settings › Account should link to it.
- **Two `SettingsGroup`s share `id="google-calendar"`.** App.tsx:15480 (section Booking, "Google Calendar") and App.tsx:23576 (section Developer, "Calendar feed & video storage"). `setRequestedSettingsGroup("google-calendar")` at 15406 cannot tell them apart. The Developer one still holds video storage, the Clarity Cloud catalogue and storage diagnostics under a calendar title. It is the last filing error from the August doc still standing.
- **Client import exists in two places.** `ClientsPanel` receives `importOpen`/`onImport` (App.tsx:19186–19211) and Settings › Account has its own "Import clients" panel (24693–24739). Keep the one on the Clients screen.
- **`people-import.mts` and `people-import-lite.mts`** both route to the same handler (`booking-core.mts:11858`); the client only calls `import-lite`.
- **`public-reschedule-lookup.mts` and `public-reschedule-lookup-api.mts`** are byte-identical; the client calls only the `-api` route.
- **`optix-booking-trigger.mts`** says in its own header it is a compatibility endpoint that always returns 409. It and its `excludedPath` entry can go.
- **Old alias routes** `/api/optix-booking-status` and `/api/optix-booking-reconcile` sit beside the `/api/resource-*` routes the client uses. Confirm nothing external calls them, then drop the aliases.

### Logic written twice, client and server

The repo already imports 22 `_shared/*.mts` modules from `src`, so the pattern is established. Pairs that still have two copies and could drift:

| Concept | Client | Server |
|---|---|---|
| Plan catalogue and entitlements | `workspaceModel.ts:423,480` | `_shared/permissions.mts:39,61` |
| `cleanEmail`, `cleanUrl`, `cleanSlug`, `cleanHexColor` | `workspaceModel.ts` | `_shared/values.mts`, plus copies in six function files |
| `baseWeekStart`, `itemWeek`, `sameSlot`, `isExternallyOwned`, `defaultAvailability` | `calendarModel.ts` | `_shared/bookings.mts`, `workspace.mts`, `external-reschedule.mts`, and four more copies of `baseWeekStart` |
| `defaultCalendarColors`, `defaultCoachAccount` | `workspaceModel.ts` | `workspace-state.mts`, `coach-account.mts` |
| `calculateCustomGroupPrice`, `defaultServices`, `cleanBundleItems` | `serviceModel.ts` | `_shared/services.mts`, `passes.mts` |
| `generateCouponCode`, `normaliseCouponCode` | `billing/couponMath.ts` | `_shared/coupon-codes.mts` |
| `formatMoney` | `lib/money.ts:23`, plus local `money`/`formatAmount` in `PublicBookingApp`, `IntegrationPanel`, `PassInboxPanel` | `billing-api.mts:142` |
| `timeToMinutes` | `lib/date.ts:11` | `_shared/values.mts` |

The plan catalogue is the one that matters: a client that thinks a plan includes a feature the server denies is a support ticket. Import it from `_shared/permissions.mts` and delete the copy.

Inside `App.tsx` there are also three `m:ss` duration formatters (`formatVideoDurationLabel` 1340, `formatClipDuration` 1641, and `PlayerVideoShelf.tsx:45`), two date formatters that overlap `player-portal/format.ts`, a `readJsonResponse` that overlaps three module `readJson`s, and `loadImage` duplicated in `savedVideoLibrary.ts:1059`. `BillingSection`, `BillingGroup` and `BookingPullFilter` types live in `App.tsx` (741–867) rather than `modules/billing/types.ts`.

## 3. Cohesion and styling

### Tokens

`--c-*` is the system and it is used in 2,624 places across 23 files. Four dialects sit on top of it:

| Dialect | Refs | Where | Status |
|---|---|---|---|
| Legacy bare names (`--border`, `--muted`, `--text`, `--panel`, `--heading`, `--danger`, …) | ~450 | `styles.css:4917–5008` | Mostly aliases of `--c-*`, but `--danger-soft`, `--success-soft`, `--grid-bg`, `--primary-soft`, `--grid-line` are near-duplicates with their own values |
| `--pt-*` | 232 | `playerPortal.css:13–26` | Pure alias of `--c-*`, 14 names |
| `--booking-*` | 59 | `styles.css:6127–6151, 6544` | **Independent palette** with its own dark set. `--booking-border #dfe5d8` vs `--c-border #deded8`; `--booking-text #101612` vs `#171717`. This is why the booking widget looks a shade greener than the rest. |
| `--va-*` | 366 | `videoAnalysisTheme.ts:66–115` | Chrome aliases `--c-*`; signal colours (`#57e59c`, `#ff6b8a`, `#ff834c`) are deliberately its own. `--va-radius-md: 13px` does not match `--c-radius-card` 12px. |

Four names are read but never defined and work only through their fallbacks: `--line` and `--surface-2` (`playerProfiles.css:659–739`), `--accent` (`styles.css:12799`), `--surface-muted` (`styles.css:13022`).

Fix order: delete `--pt-*` and the legacy aliases with a find-and-replace to `--c-*` (both are aliases, so this is a no-op on screen); then re-point `--booking-*` at tokens, which is a visible change to the widget and wants a look.

### Literal colours

651 literal hex values outside `tokens.css`, 602 of them in `styles.css`. The ratchet test allows 687. Of the 602:

- 220 are exact copies of a token value (`#ffffff` 106 times, `#deded8` 54, `#171717` 49, `#a52e15` 9, `#ecebe5` 6). A mechanical replace.
- 234 more are within a hair of a token (`#111111`, `#76736d`, `#f7f7f3`, `#fbfbf9`, `#5d5a54`). These are the "almost the same grey" that makes two panels look subtly different. Replace with the nearest token and accept the one-step shift.
- Radii: `8px` 74 times, `10px` 50, `12px` 38, `9px` 25, `7px` 12 as literals, against `--c-radius-control` 110 and `--c-radius-card` 47. The 9/12/999 literals are token values written out.

After that pass, lower the ratchet in `uiRules.test.ts:505` to about 150 so the number only goes down.

### Dead CSS

Dead CSS is low, which is good news. The exception is one block:

- **`styles.css:8045–8902`, about 19 KB, is the old invoice editor.** Fifty `invoice-*` classes (`invoice-document-card`, `invoice-side-panel`, `invoice-line-picker`, `invoice-total-box`, `invoice-footer-fields`, `invoice-customer-results`, `invoice-option-list`, …) with zero references in any `.tsx`. The editor is `invoice-paper-layout` / `ip-*` now. Delete the block.
- `.settings-grid > .settings-section { display: none !important }` at `styles.css:547` is the old "mount everything, hide with CSS" rule. `SettingsGroup` returns `null` for inactive sections now, so the rule does nothing. Delete.
- `quick-client-ghost` (4529), `.lab` (`videoAnalysis.css:2437`) are unreferenced.
- Comments are 80 KB of `styles.css` (19%). Many are useful; a pass to drop the ones that narrate a change rather than explain a rule would be worthwhile when the file is being touched anyway.

### The same primitive styled many times

| Primitive | Distinct class families | Examples |
|---|---|---|
| Button | 68 across 8 files | `.primary-button` has one base (`styles.css:369`) and 12 scoped overrides; parallel primaries `.player-portal-primary`, `.api-access-primary`, `.terminal-button.is-primary`, `.va-bar-btn` |
| Tabs | 15 | `.client-list-tabs`, `.availability-coach-tabs`, `.practice-type-tabs`, `.player-tool-tabs`, `.settings-tabs` |
| Card | 35 across 10 files | `.data-card` (38 rule blocks), `.booking-card`, `.player-portal-card`, `.terminal-card`, `.membership-card`, `.ip-card`, `.dash-card`, `.cp-card` |
| Modal / sheet | 24, no shared base | `.details-modal`, `.client-profile-modal`, `.pos-checkout-modal`, `.mt-sheet`, `.it-sheet`, `.va-sheet`, `.srs-sheet`, `.player-add-overlay` |
| Input | 117 rules under 60 scopes | `.settings-field input`, `.memberships-panel input`, `.api-access-form input`, `.integration-grid input` (literal `#d9ded2`, 8px) |
| Row / list | 85 (63 in styles.css) | `.client-row`, `.service-row`, `.today-row`, `.mt-row`, `.player-tool-row`, `.drill-row`, `.api-access-row` |

This is where "legacy UI that doesn't match the new styling" actually comes from. The newer modules (passes, memberships, rewards, today, quick-book, settings layout) each styled their own rows and cards from tokens, so they look right individually, but there are now eight ways to draw a card. The fix is not to restyle each one; it is to give `styles.css` one base class per primitive (`.card`, `.row`, `.sheet`, `.field`, `.tabs`) and have module classes extend it. Do this after the token pass so the base classes are born clean.

### The August rules, re-checked

Of the eight row surfaces the filing doc said should lose their own border, six are fixed, two (`.invoice-customer-results`, `.invoice-option-list`) are moot because the markup is gone, and one is still wrong: `.resource-row button` (`styles.css:637`) carries `1px solid #d9ded2`, `7px` radius and `#fff`, all literals, inside a row that is otherwise compliant. `.resource-services label` (657) is still a `#f0f3ed` chip. Both are in the integration panel.

### Icons

Two icon systems by design: `ClarityIcons` (38 brand icons, 33 files) for anything the set covers, `lucide-react` (41 files) for utility glyphs. The header of `ClarityIcons.tsx` states the rule clearly. Worth a quick sweep for lucide icons used where a Clarity one exists, but this is working as intended.

### Phone layout

The phone layout (Oct 4–11) covers Today, Book, Calendar, Players, Sell, Clients, Billing and Settings. `profile`, `video` and `putting-lab` have no phone-specific handling. Video and putting lab are desktop tools and that is probably fine; the Profile view on a phone should be checked.

## 4. Not finished, stale or left over

**User-facing**

- **"Track focus beta"** in the video workspace (`components/FocusPalette.tsx:27–40`, wired at `VideoWorkspace.tsx:4925`) renders only the string "Track focus is placeholder-only in this foundation." (`FocusWindow.tsx:176`). It is the one visible half-built feature. Hide the button until it does something.
- **"3D motion" is web-only** in the native player app (`VideoWorkspace.tsx:276`) because the WASM is not bundled. Stated in the UI, so acceptable, but worth a decision on whether it ever ships natively.
- **iOS Tap to Pay** is disabled pending Apple's entitlement (`booking-app/capacitor.config.ts`). Known.

**Code**

- `legacyVideoRecords` and `createMigrationAnalysis` in `App.tsx` are one-time migration paths for pre-library videos. Once you are confident every coach's videos have moved, they can go.
- `typecheck:functions` covers six named files out of about 60 functions. Everything else in `netlify/` is only type-checked by esbuild at deploy, which does not check types at all. Widening this to the whole functions directory is cheap insurance.
- `package-lock.json` is deliberately untracked (`.gitignore:83`). That means every Netlify build resolves dependency versions fresh, so a build can change without a commit. Now that the project is moving out of development, committing the lockfile is the single easiest robustness win in the repo.

**Repo hygiene**

- `PROJECT_SOURCE_OF_TRUTH.md` warns about root `src/`, `netlify/` and `server/` folders that no longer exist.
- `HARDCODED_IDENTITY_AUDIT.md`, `SECURITY_ACTION_REQUIRED.md`, `MULTI_COUNTRY_REPORT.md`, `CALENDAR_PEOPLE_SAVE_FIX.md`, `SMOKE_TEST_REPORT.md`, `README_DEPLOY_HANDOFF.md` and `BOOK_BAY_REFINEMENT_PLAN_2026-09-06.md` all cite files or processes that are gone. The design docs (`PASS_SYSTEM_DESIGN.md`, `INTEGRATIONS_DEVELOPER_DESIGN.md`, `INTEGRATION_FIELD_SCHEMA.md`, `UI_FILING_AND_CLASSIFICATION.md`) belong in `source/docs/` with the rest.
- `.idea/workspace.xml` is committed IDE state.
- `.github/workflows/export-app-source.yml` uploads a file that no longer exists; `netlify-production-deploy.yml` carries a hard-coded deploy message from a past change and only fires when it edits itself. Netlify's Git integration does the real deploys.
- `claude/` holds two August session notes.

**Tests**

Server coverage is good (75 test files). On the client, the big untested areas are `App.tsx` itself, `workspace/useWorkspaceSync` (1,642 lines), `calendar/calendarModel` and `useCalendarController`, and `billing-api.mts` on the server (6,027 lines, tested only indirectly). Extracting the screens in section 2 is what makes these testable, so the two go together.

## 5. Proposed order

Each step leaves the app deployable. Steps 1–3 are mechanical and low-risk; 4–6 are the real work.

1. **Quick wins, one PR.** Split `cleanMessageLanguage`/`MESSAGE_LANGUAGES` out of the locale module; switch the client to `libphonenumber-js/min`; lazy-load `PublicSite`, `BusinessHubPanel`, `CoachProfilePanel`; delete the dead invoice CSS block and the `display:none` settings rule; fix the two wildcard exclusions; delete `optix-booking-trigger`, `public-reschedule-lookup`, `people-import`; commit the lockfile. Roughly 70 KB gzip off every coach load and 20 KB off the stylesheet.
2. **Token pass, one PR.** Replace `--pt-*` and the legacy aliases with `--c-*`; replace the 220 exact-match literals and the 234 near-matches in `styles.css`; tokenise `.resource-row button`; fix the four undefined names; lower the hex ratchet. Then re-point `--booking-*` at tokens and look at the widget.
3. **Repo hygiene.** Delete the stale root docs, move the design docs to `source/docs/`, gitignore `.idea/`, remove the two vestigial workflows, rewrite `PROJECT_SOURCE_OF_TRUTH.md` to say what is true now.
4. **Extract Players.** Controller hook plus view, following `useClientProfileController`/`ClientProfileView`. It is the newest UI and the one most worth having as a module.
5. **Extract the invoice editor and Billing Settings.** Remove the duplicate Billing Settings editor from Settings › Account at the same time. Move the billing types out of `App.tsx`.
6. **Extract the Settings panels** (Services, Google Calendar, Locations, Availability, Booking, Account, Notifications). Resolve the duplicate `google-calendar` id and move video storage out of the calendar group while doing it. Remove the duplicate client import.
7. **Shared primitives.** One base class each for card, row, sheet, field and tabs in `styles.css`; migrate the module variants onto them. Then the player portal can stop loading the coach stylesheet.
8. **Server import graph.** Lift the helpers the 33 small functions need out of `booking-core.mts` into `_shared/`, so cold starts shrink. Import the plan catalogue from `permissions.mts` and delete the client copy. Widen `typecheck:functions` to the whole directory.

**Decisions needed before starting**

- Steps 1 and 3 delete things (routes, docs, workflows). Everything listed has been checked for callers, but the `/api/optix-booking-*` aliases and `people-import` may have external users I cannot see.
- Step 2 changes the booking widget's colours visibly when `--booking-*` is re-pointed. It can be split out and done last if you want to look at it in isolation.
- Whether "Track focus" should be hidden or finished.
- Whether `legacyVideoRecords` migration code can go.
