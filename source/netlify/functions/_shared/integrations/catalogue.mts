import { optixAdapter } from "./providers/optix.mts";
import type {
  ConnectionSpec,
  IntegrationAudience,
  IntegrationDescriptor,
  IntegrationId,
} from "./types.mts";

/**
 * Every integration Clarity has code for.
 *
 * Five of these six had no screen at all before this file. They were
 * environment variables, set by editing Netlify and redeploying, with nothing
 * anywhere saying whether they were configured, working, or subtly wrong. Optix
 * got a screen because it broke often enough to earn one; the other five break
 * quietly, which is worse.
 *
 * A descriptor here does NOT mean an adapter exists. Only Optix sends events
 * Clarity has to interpret; the rest are outbound, and an integration with
 * nothing to normalise is still a complete integration. That is the whole
 * reason this is a separate list from the adapter registry.
 */

/**
 * Stripe: Clarity Pay at the counter, and invoices and charges in Billing.
 *
 * Each business signs in to its own Stripe (Connect) and the money lands
 * there. Clarity's platform key and its one Connect webhook are set once in
 * Netlify, never per business -- see _shared/stripe.mts.
 */
const stripe: IntegrationDescriptor = {
  id: "stripe",
  label: "Stripe",
  audience: "integration",
  category: "payments",
  caveat: "A sandbox connects in Stripe's test mode, so it takes no real money.",
  summary: "Card payments from your clients, and your Stripe invoices and charges in Billing.",
  connections: [
    {
      kind: "oauth2",
      title: "Stripe account",
      summary: "One sign-in. Payments go straight to your own Stripe account.",
      connectPath: "/api/stripe-connect/connect",
      operations: [
        { id: "checkout.session", label: "Open a hosted checkout" },
        { id: "payment_link", label: "Add a payment link to an invoice" },
        { id: "invoices.read", label: "Read your invoices and charges into Billing" },
      ],
      fields: [
        {
          key: "__connect",
          type: "oauth",
          label: "Connection",
          help: "Sign in to the Stripe account your clients' payments should go to.",
          required: false,
        },
      ],
    },
  ],
};

/** Akahu: the bank feed behind expense reconciliation. */
const akahu: IntegrationDescriptor = {
  id: "akahu",
  label: "Akahu",
  audience: "integration",
  category: "accounting",
  summary: "Reads your bank transactions so expenses and payments can be reconciled.",
  docsUrl: "https://developers.akahu.nz",
  connections: [
    {
      kind: "api-key-pair",
      title: "API tokens",
      summary: "Two tokens: one identifies the app, one the connected bank account.",
      transport: "rest",
      operations: [
        { id: "transactions", label: "List transactions" },
        { id: "accounts", label: "List accounts" },
      ],
      fields: [
        {
          key: "AKAHU_APP_TOKEN",
          type: "secret",
          label: "App token",
          help: "Akahu › My Apps › your app › App ID token. Identifies Clarity, not your bank account — starts app_token_.",
          required: true,
        },
        {
          key: "AKAHU_USER_TOKEN",
          type: "secret",
          label: "User token",
          help: "Issued when you connect a bank account. Identifies whose transactions are being read, so revoking it stops the feed without touching the app.",
          required: true,
        },
      ],
    },
  ],
};

/** Resend: every email Clarity sends. */
const resend: IntegrationDescriptor = {
  id: "resend",
  label: "Resend",
  audience: "admin",
  category: "email",
  summary: "Sends booking confirmations, reminders and invoices.",
  docsUrl: "https://resend.com/api-keys",
  connections: [
    {
      kind: "api-token",
      title: "API",
      summary: "What we send Resend.",
      transport: "rest",
      operations: [{ id: "emails.send", label: "Send an email" }],
      fields: [
        {
          key: "RESEND_API_KEY",
          type: "secret",
          label: "API key",
          help: "Resend › API Keys. Without it every notification silently does not send — the booking still works, the email just never arrives.",
          required: true,
        },
        {
          key: "CLARITY_EMAIL_FROM",
          type: "text",
          label: "From address",
          help: "Must be on a domain verified in Resend. Unset falls back to onboarding@resend.dev, which sends but looks like it came from nobody.",
          required: false,
        },
        {
          key: "NOTIFICATION_REPLY_TO",
          type: "text",
          label: "Reply-to address",
          help: "Where a client's reply goes. Usually your own inbox rather than the sending domain. Falls back to RESEND_FROM_EMAIL.",
          required: false,
        },
      ],
    },
  ],
};

/**
 * Clarity Caddy: the sibling app.
 *
 * The one member of `service-link`, and on probation for exactly that reason —
 * if nothing else ever links to a peer service this should collapse into
 * api-token, which is nearly what it is. Kept separate for now because the
 * secret is shared rather than issued: both ends hold the same string, which
 * is a different failure mode from a revocable token.
 */
const caddy: IntegrationDescriptor = {
  id: "caddy",
  label: "Clarity Caddy",
  audience: "admin",
  category: "clarity-apps",
  summary: "Links a coach's player profiles to the Caddy app.",
  connections: [
    {
      kind: "service-link",
      title: "Service link",
      summary: "A shared secret between two apps we both own.",
      transport: "rest",
      operations: [{ id: "profile.link", label: "Link a player profile" }],
      fields: [
        {
          key: "CLARITY_CADDY_URL",
          type: "url",
          label: "Caddy URL",
          help: "The default is correct unless Caddy has moved.",
          required: false,
          defaultValue: "https://caddy.claritygolf.app",
        },
        {
          key: "CLARITY_SERVICE_SECRET",
          type: "secret",
          label: "Shared secret",
          help: "The same string must be set on both ends. Shared rather than issued, so rotating it means changing two places at once or the link drops.",
          required: true,
        },
        {
          key: "CLARITY_CADDY_COACH_ACCOUNT_ID",
          type: "text",
          label: "Coach account ID",
          help: "Which Caddy account this workspace's profiles belong to. Optional — caddyConfigured() checks only the secret and the URL.",
          required: false,
        },
        {
          key: "CLARITY_CADDY_COACH_EMAIL",
          type: "text",
          label: "Coach email",
          help: "The identity Caddy recognises on the far side.",
          required: false,
        },
      ],
    },
  ],
};

/**
 * Google, listed twice and connected once.
 *
 * One OAuth grant does two jobs that belong to different people. The calendar
 * is the coach's own diary, connected because they want their lessons in it —
 * an integration. Drive is where Clarity keeps lesson video, which is the
 * software's storage decision and not something a coach chooses — admin.
 *
 * Filing it once would have put "connect my diary" inside an admin area, or
 * Clarity's storage inside the coach's list. So both entries appear, both show
 * the same connected account, and both lead to the same Connect. Nobody signs
 * in twice.
 *
 * Worth knowing, because it caused a real bug: one grant means one scope list,
 * and a narrower re-consent for one product silently narrows the other. The
 * calendar sync failed for exactly this reason while every screen said the
 * scope was present.
 */
const googleConnection: ConnectionSpec = {
  kind: "oauth2",
  title: "Google account",
  summary: "One sign-in. Calendar and Drive are separate permissions on it.",
  connectPath: "/api/google-calendar/connect",
  // Signing in is the whole setup. The OAuth client ID and secret are
  // Clarity's own app, set once in Netlify for every business (see
  // clarity-cloud-google-config.mts) — nothing a coach has or should paste.
  fields: [
    {
      key: "__connect",
      type: "oauth",
      label: "Connection",
      help: "Sign in with the Google account whose calendar your lessons should go in.",
      required: false,
    },
  ],
};

const googleCalendar: IntegrationDescriptor = {
  id: "google-calendar",
  label: "Google Calendar",
  audience: "integration",
  category: "calendar",
  summary: "Puts your lessons in your own diary, and keeps them in step.",
  connections: [googleConnection],
};

const googleDrive: IntegrationDescriptor = {
  id: "google-drive",
  label: "Google Drive",
  audience: "admin",
  category: "storage",
  summary: "Where lesson video is kept once it leaves the browser.",
  sharesGrantWith: "google-calendar",
  connections: [googleConnection],
};

const CATALOGUE: IntegrationDescriptor[] = [
  optixAdapter.descriptor,
  googleCalendar,
  akahu,
  googleDrive,
  stripe,
  resend,
  caddy,
];

export function integrationsFor(audience: IntegrationAudience): IntegrationDescriptor[] {
  return CATALOGUE.filter((entry) => entry.audience === audience);
}

export function allIntegrations(): IntegrationDescriptor[] {
  return CATALOGUE;
}

export function integrationById(id: unknown): IntegrationDescriptor | null {
  return CATALOGUE.find((entry) => entry.id === id) ?? null;
}

export function isIntegrationId(value: unknown): value is IntegrationId {
  return CATALOGUE.some((entry) => entry.id === value);
}
