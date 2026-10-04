# Tap to Pay on iPhone — setup

How Clarity Pay takes a contactless card on a coach's iPhone, and what has to
happen outside the code before it works. Android is the same app and the same
plugin; what differs is in [stripe-terminal-android-setup.md](stripe-terminal-android-setup.md).

## How the pieces fit

| Piece | Where | What it does |
| --- | --- | --- |
| Staff app | `booking-app/` | Its own Capacitor app, `app.claritygolf.booking`. Opens the **live** Booking site, so the coach signs in exactly as on the web (same cookie). No new login path into the admin API. |
| Native plugin | `native/clarity-terminal/` | Swift over the Stripe Terminal iOS SDK (`ios/`), Kotlin over the Android SDK (`android/`). Same methods and results on both. Holds no keys and prices nothing. |
| Page bridge | `src/native/clarityTerminal.ts` | Finds the plugin at `window.Capacitor.Plugins.ClarityTerminal`. In a browser it is absent and Tap to Pay is hidden. |
| Screen | `src/modules/billing/TerminalPayment.tsx`, `terminal.ts` | The tap flow and its states, used by the checkout modal and the Sell screen. |
| Server | `/api/billing/terminal/*` in `billing-api.mts`, `_shared/terminal.mts` | Status, location, connection tokens, the PaymentIntent, reconcile, cancel. |
| Settlement | `_shared/pos-settlement.mts` | The one path every Clarity Pay card payment (QR or tap) settles through. |

The Player app (`source/`, `app.claritygolf.player`) is untouched: the plugin
is a dependency of `booking-app/package.json` only, so `npx cap sync` for the
Player never sees it.

### A payment, end to end

1. Coach presses **Tap card** on a Clarity Pay sale. The sale already exists
   (`billing_pos_transactions`, status `pending`).
2. Page → `POST /terminal/location` → Stripe Terminal location for this Clarity
   location (created with Stripe the first time).
3. Plugin connects the iPhone's Tap to Pay reader there. Whenever the SDK needs
   a connection token the plugin raises an event; the page fetches one from
   `POST /terminal/connection-token` with the coach's session.
4. Page → `POST /terminal/payment-intent { transactionId }`. The **server**
   prices it from the stored sale (total less any voucher). The client never
   sends an amount that counts. One open intent per sale; a repeat call gets
   the same one back.
5. Plugin collects the card and confirms.
6. Page → `GET /terminal/payment-intent/:id/status` until the server knows.
   The server asks Stripe and, on success, settles the sale through
   `settlePosTransaction` — stock, voucher, passes, tenders, exactly once.
   If the phone never gets that far, Stripe's `payment_intent.succeeded`
   webhook settles it the same way.

If anything is uncertain after a card is read, the screen says **Checking
payment… Do not charge again yet** and keeps asking. It never says "failed" on
its own. Even a retry cannot double-charge: it reuses the same PaymentIntent,
and Stripe lets an intent succeed only once.

## Before it will work

### 1. Stripe

- The business must be on **Clarity Pay** (own-Stripe businesses do not get
  Terminal) with `card_payments` active. `GET /api/billing/terminal/status`
  says why not when it is not available.
- Each Clarity location used for Tap to Pay needs a street address in
  **Settings › Locations**. Stripe needs street, city and postcode for a
  Terminal location. If Stripe refuses the address the coach is told to fill it
  in.
- Tap to Pay on iPhone must be available in the business's country. Check
  Stripe's current list before offering it to a new market.
- **Webhook event.** On Clarity's platform Stripe account, the Connect
  webhook endpoint (`/api/stripe-billing-webhook`, both live and test) must
  also send **`payment_intent.succeeded`**. That settles a tap whose phone
  never heard the answer (app closed, signal lost). Without it such a sale
  stays pending until someone touches its payment again. The phone and the
  webhook can both settle the same payment; the second finds it done.
- Each connected account accepts **Apple's Tap to Pay terms** once, the first
  time it connects on any iPhone (Apple ID sign-in). Stripe's SDK presents
  this. Stripe also offers onboarding links to do it on the web first.

### 2. Apple

- **Entitlement.** Request the Tap to Pay on iPhone entitlement
  (`com.apple.developer.proximity-reader.payment.acceptance`) for
  `app.claritygolf.booking` in the Apple Developer account. Development first;
  a separate **distribution** entitlement is needed before TestFlight / App
  Store. It is already in `booking-app/ios/App/App/App.entitlements` and wired
  into the target (`CODE_SIGN_ENTITLEMENTS`); it will not sign until Apple
  approves it for the bundle id.
- **Signing.** Set the team in Xcode for the App target. Automatic signing
  picks up the entitlement once Apple has granted it.
- **Permissions.** `Info.plist` has `NSLocationWhenInUseUsageDescription`
  (Stripe requires location for card acceptance and disables payments without
  it) and `NSBluetoothAlwaysUsageDescription` (App Store requires it for any
  app linking the Terminal SDK, and it is needed for card readers later).
- **Review.** Apple reviews Tap to Pay apps against its Tap to Pay marketing
  and UX guidelines (the checkout button wording, the tap screen, education
  for merchants). Stripe's Tap to Pay guide (linked from the Stripe docs page
  "Tap to Pay: iPhone") walks through Apple's checklist. Expect to supply a
  demo account and a test-mode business for the reviewer. Where Clarity stands
  on each point, and the notes to give the reviewer, are in
  [tap-to-pay-apple-review.md](tap-to-pay-apple-review.md).

### 3. Devices

- iPhone XS or later on a current, non-beta iOS. PIN entry needs iOS 16.4+.
- The first connection on a phone runs a one-off Apple setup that can take a
  minute or two; the screen shows progress.
- A phone can connect to at most three different Stripe accounts in 24 hours
  (Apple's limit), which matters only for someone testing several businesses.

## Build and run

```bash
cd source/booking-app
npm install          # its own install, separate from source/
npm run ios          # cap sync ios + open Xcode
```

Point it at a deploy preview instead of production:

```bash
CLARITY_BOOKING_URL=https://deploy-preview-123--clarity.netlify.app npx cap sync ios
```

`www/` only holds the page shown when the site cannot be reached.

## Test mode

A sandbox business connects in Stripe test mode (see `_shared/stripe.mts`), and
Terminal follows it: the tap screen shows **Test mode – no real money moves**.

- On a real iPhone, test mode takes Stripe's physical test cards, or any real
  card without charging it (Stripe declines live cards in test mode with a
  test-card message — use the physical test cards for success paths).
- Amounts ending in `.03` test PIN entry where PIN is supported.

## Live mode

Nothing to switch in the app. A live business connects in live mode and the
platform's live key serves it. Before the first live payment, check:

- distribution entitlement granted and the build signed with it;
- location address complete for each location that will take taps;
- the business has accepted Apple's terms (first connection does this).

## Not built yet

- **Physical readers.** The data model (`terminal_reader` channel, locations,
  device on each attempt) is ready; the plugin only discovers Tap to Pay.
- **Part refunds.** **Refund** in the transactions list returns the whole
  card payment through Stripe (QR or tap), puts stock and any voucher value
  back, and returns Clarity's fee to the business. Refunding part of a sale is
  still done in the Stripe dashboard, and leaves the sale paid in Clarity. A
  full refund made in the dashboard marks the sale refunded in Clarity too.
- **Choosing another method after starting.** "Cancel sale" voids the pending
  Clarity Pay sale and the coach starts a new one on Cash etc. That spends a
  receipt number on the voided sale, as the QR flow already does.
