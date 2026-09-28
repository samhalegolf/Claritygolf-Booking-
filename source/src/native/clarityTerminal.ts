// Tap to Pay on iPhone, as the page sees it.
//
// The Clarity Booking staff app (booking-app/) is a native shell around the live
// site, so this code runs in the ordinary web bundle. The shell injects
// window.Capacitor, and with it the ClarityTerminal plugin
// (native/clarity-terminal). In a browser neither exists, nativeTerminal()
// returns null, and every Tap to Pay control stays hidden.
//
// Read off window rather than imported from @capacitor/core on purpose: the web
// bundle should not carry Capacitor for the one screen that uses it, and in the
// shell the injected bridge is the real one anyway.
//
// The plugin is deliberately small. It holds no keys and prices nothing; the
// page fetches everything from Clarity's server and passes the plugin only what
// the Stripe SDK needs.

export type CollectOutcome = {
  outcome: "confirmed" | "failed" | "cancelled";
  // How far it got. A failure before "confirm" charged nothing; one at
  // "confirm" might have, and only the server can say.
  stage: "retrieve" | "collect" | "confirm";
  paymentIntentId?: string;
  status?: "succeeded" | "processing";
  message?: string;
  code?: string;
  declineCode?: string;
};

type Listener = { remove: () => Promise<void> | void };

export type ClarityTerminalPlugin = {
  isSupported(options?: { simulated?: boolean }): Promise<{ supported: boolean; reason: string }>;
  prepare(options: { stripeLocationId: string; simulated?: boolean }): Promise<{ connected: boolean }>;
  collectPayment(options: { clientSecret: string }): Promise<CollectOutcome>;
  cancel(): Promise<{ cancelled: boolean }>;
  disconnect(): Promise<void>;
  provideConnectionToken(options: { requestId: string; secret?: string; error?: string }): Promise<void>;
  addListener(
    event: "connectionTokenRequest",
    handler: (data: { requestId: string }) => void,
  ): Promise<Listener> | Listener;
  addListener(event: "readerMessage", handler: (data: { message: string }) => void): Promise<Listener> | Listener;
  addListener(
    event: "readerUpdate",
    handler: (data: { state: string; progress: number }) => void,
  ): Promise<Listener> | Listener;
  addListener(event: "disconnected", handler: () => void): Promise<Listener> | Listener;
};

type CapacitorGlobal = {
  isNativePlatform?: () => boolean;
  isPluginAvailable?: (name: string) => boolean;
  Plugins?: Record<string, unknown>;
};

/** The plugin when running inside the staff app, otherwise null. */
export function nativeTerminal(): ClarityTerminalPlugin | null {
  const capacitor = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
  if (!capacitor?.isNativePlatform?.() || !capacitor.isPluginAvailable?.("ClarityTerminal")) return null;
  return (capacitor.Plugins?.ClarityTerminal as ClarityTerminalPlugin | undefined) || null;
}

let tokenBridgeInstalled = false;

/**
 * Answer the SDK's connection-token requests for as long as the page lives.
 *
 * The SDK asks whenever it needs one (connecting, reconnecting, after expiry);
 * each ask is answered with a fresh token from the server using the coach's own
 * session. Tokens are never kept.
 */
export function installConnectionTokenBridge(
  plugin: ClarityTerminalPlugin,
  fetchToken: () => Promise<string>,
) {
  if (tokenBridgeInstalled) return;
  tokenBridgeInstalled = true;
  void plugin.addListener("connectionTokenRequest", ({ requestId }) => {
    fetchToken()
      .then((secret) => plugin.provideConnectionToken({ requestId, secret }))
      .catch((error: unknown) =>
        plugin.provideConnectionToken({
          requestId,
          error: error instanceof Error ? error.message : "Could not get permission from Clarity.",
        }),
      );
  });
}
