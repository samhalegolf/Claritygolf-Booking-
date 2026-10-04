# Tap to Pay on Android — setup

The Android half of Tap to Pay. Everything in
[stripe-terminal-ios-setup.md](stripe-terminal-ios-setup.md) about how a
payment works — the server pricing the sale, "Checking payment" instead of
"failed", the webhook, test mode — is the same here. This page is only what
differs.

## What is the same

- **One staff app.** `booking-app/` builds for both phones
  (`app.claritygolf.booking`). It opens the live Booking site, so the coach
  signs in exactly as on the web.
- **One plugin.** `native/clarity-terminal/android/` is the Kotlin twin of the
  Swift plugin: same name (`ClarityTerminal`), same methods, same events, same
  results. The page does not care which phone it is on.
- **One server.** Nothing on `/api/billing/terminal/*` changed. The sale is
  recorded with the `terminal_tap_to_pay` channel either way; the device name
  on the attempt says "Android (Tap to Pay)".

## What is different

| | iPhone | Android |
| --- | --- | --- |
| Tap screen | Ours, with Apple's sheet over it | Stripe draws its own full-screen tap screen |
| Where the customer taps | Top of the phone | Back of the phone (NFC spot) |
| Terms to accept | Apple's Tap to Pay terms, first connection | None from Google |
| "How to tap" | Apple's guide (iOS 18+) | Our own short text |
| Button wording | "Tap to Pay on iPhone" (Apple's rule) | "Tap to Pay" |
| Entitlement | Apple must grant one | None needed |

The words the coach sees switch on `onAndroid()` in
`src/native/clarityTerminal.ts`.

## Before it will work

### Stripe

- Tap to Pay on Android must be available in the business's country. Stripe's
  list is not the same as the iPhone one — check it before offering it to a
  new market.
- Everything else (Clarity Pay, location address, the webhook) is as on iPhone.

### The phone

- NFC, a recent Android version and a phone Stripe trusts (not rooted).
  Stripe keeps the exact list and checks it itself; when a phone falls short
  Settings says "This phone cannot take Tap to Pay."
- **Live payments refuse a debug build** (Stripe treats it as insecure). Test
  in a sandbox (test mode) business, or with a release build.
- Location permission is asked the first time the coach sets up Tap to Pay.

## Build and run

You need Android Studio (it brings the Android SDK and Java 21).

```bash
cd source/booking-app
npm install
npm run android      # cap sync android + open Android Studio
```

Run it from Android Studio on a real phone. Point it at a deploy preview
instead of production the same way as iPhone:

```bash
CLARITY_BOOKING_URL=https://deploy-preview-123--clarity.netlify.app npx cap sync android
```

## How the app starts Stripe

`ClarityBookingApplication.java` (in `booking-app/android/app/`) does the one
thing the plugin cannot: it is the app's Application class, so it calls
`TerminalApplicationDelegate.onCreate` and steps aside when Android starts it
inside Stripe's own tap-screen process. Do not add anything above that check.

## Releasing

- Signing and Play Console listing are not set up yet for this app (the
  Player app's CI signing is separate). The version is `1` / `1.0` in
  `android/app/build.gradle` until it is.
- Play asks for a data-safety form: location (payments only, not shared
  beyond Stripe) and payment info (handled by Stripe).
