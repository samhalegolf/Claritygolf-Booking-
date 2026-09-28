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
 * What the app adds is native: the Stripe Terminal plugin for Tap to Pay. The
 * page finds it at window.Capacitor.Plugins.ClarityTerminal and hides Tap to
 * Pay everywhere else.
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
  },
};

export default config;
