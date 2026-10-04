# Booking alerts on the staff app — setup

The Clarity Booking staff app (`booking-app/`) can show an alert on the coach's
phone when a client books, moves or cancels a lesson, and when a booking
arrives from a connected system. These are the same alerts browsers already
get (`notification-engine.mts` → `sendCoachPush`). A phone and a browser are
just two kinds of device on the business.

## How it fits together

| Piece | File |
| --- | --- |
| The plugin in the app shell | `booking-app/package.json` (`@capacitor/push-notifications`) |
| iPhone: hands Apple's token to the plugin | `booking-app/ios/App/App/AppDelegate.swift` |
| iPhone: the push entitlement | `booking-app/ios/App/App/App.entitlements` (`aps-environment`) |
| The page: permission, registering, tapped alerts | `src/native/nativePush.ts` |
| Settings → notifications, on the phone | `src/modules/notifications/PhoneNotificationsPanel.tsx` |
| Storing phones, sending to Apple and Google | `netlify/functions/_shared/native-push.mts` |
| The route both browsers and phones use | `netlify/functions/push-subscriptions.mts` |

Each phone is stored in `native_push_devices`, one row per push token. A
phone registers again each time the app opens, so a changed token or a
changed language is picked up without the coach doing anything.

A phone is only forgotten when Apple answers 410 or Google answers
UNREGISTERED. Any other error is recorded on the row (`last_error`) and the
phone is kept. A wrong key or the wrong Apple server makes every phone fail
at once, and that must not delete them all.

## What you need to set up

Each half works on its own, so iPhone and Android can be set up at different
times.

### iPhone (Apple Push Notification service)

1. In the Apple Developer account, under **Certificates, Identifiers &
   Profiles → Keys**, create a key with **Apple Push Notifications service
   (APNs)** turned on. Download the `.p8` file; it can only be downloaded
   once. Note its **Key ID**, and the **Team ID** shown at the top right.
2. Under **Identifiers**, open `app.claritygolf.booking` and tick **Push
   Notifications**.
3. In Xcode, open `booking-app/ios/App`. Signing & Capabilities should show
   **Push Notifications** (the entitlement is already in the project).
4. In Netlify → Site configuration → Environment variables, add:
   - `APNS_KEY_ID`: the Key ID
   - `APNS_TEAM_ID`: the Team ID
   - `APNS_PRIVATE_KEY`: the whole contents of the `.p8` file, including the
     BEGIN/END lines
   - `APNS_ENVIRONMENT`: `sandbox` while testing with a build run from Xcode.
     Remove it, or set it to `production`, for TestFlight and App Store builds.
   - `APNS_TOPIC` only if the bundle id is not `app.claritygolf.booking`

### Android (Firebase Cloud Messaging)

1. In the Firebase console, create a project (or use an existing one) and add
   an Android app with the package name `app.claritygolf.booking`.
2. Download `google-services.json` and put it in
   `booking-app/android/app/`. The build turns on Google's push service only
   when that file is present.
3. In Firebase → Project settings → **Service accounts**, generate a new
   private key. That downloads a JSON file.
4. In Netlify, add `FCM_SERVICE_ACCOUNT`: the whole contents of that JSON file
   as one value.

Redeploy after adding the variables.

## Trying it

1. Run the staff app on a phone (`npm run ios` or `npm run android` in
   `booking-app/`) and sign in.
2. Settings → Email → **Phone notifications** → **Turn on for this phone**,
   and allow notifications when the phone asks.
3. **Send a test**. The alert also goes to any browsers that have alerts on.

If nothing arrives, the phone's row in `native_push_devices` has the last
error from Apple or Google in `last_error`.
