import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Clarity Booking -- the staff app. Not the Player app (../capacitor.config.ts).
 *
 * It opens the live Booking site rather than a bundled copy. That is the whole
 * point of the design: the coach signs in exactly as on the web, with the same
 * HttpOnly session cookie, because the page's origin *is* claritygolf.app.
 * There is no second way into the admin API -- no bearer token, no CORS
 * exception -- to secure and keep secure.
 *
 * What the app adds is native: the Stripe Terminal plugin for Tap to Pay, and
 * push notifications. The page finds them at window.Capacitor.Plugins
 * (ClarityTerminal, PushNotifications) and hides both everywhere else.
 *
 * www/ is only what shows when the site cannot be reached.
 */
const config: CapacitorConfig = {
  appId: "app.claritygolf.booking",
  appName: "Clarity Booking",
  webDir: "www",
  server: {
    url: process.env.CLARITY_BOOKING_URL || "https://claritygolf.app",
    errorPath: "offline.html",
  },
  ios: {
    contentInset: "never",
    // Tap to Pay (ClarityTerminal) is in the build. Signing needs Apple's
    // Tap to Pay entitlement for app.claritygolf.booking: development for
    // local builds, distribution for TestFlight and the App Store
    // (docs/stripe-terminal-ios-setup.md, docs/tap-to-pay-apple-review.md).
    // Without the plugin the page hides every Tap to Pay control.
    //
    // Filesystem and Share: downloads (invoice PDFs, reports, videos) open
    // the share sheet instead of doing nothing (src/native/nativeFiles.ts).
    includePlugins: [
      "@capacitor/push-notifications",
      "@capacitor/filesystem",
      "@capacitor/share",
      "@claritygolf/capacitor-terminal",
    ],
  },
  plugins: {
    // A booking alert that arrives while the app is open still shows as a
    // banner, rather than being swallowed because the app was in front.
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
  },
};

export default config;
