// Booking alerts on the Clarity Booking staff app's phones, as the page sees it.
//
// Same arrangement as clarityTerminal.ts: the staff app (booking-app/) is a
// native shell around the live site, and injects window.Capacitor with the
// PushNotifications plugin. In a browser it is absent, nativePush() returns
// null, and the page offers browser notifications instead (browserPush.ts) --
// which cannot work inside the shell, where there is no service worker.
//
// The server half is netlify/functions/_shared/native-push.mts, reached through
// the same /api/push-subscriptions route as browsers.

import { activeLanguage, t } from "../lib/i18n";

type Listener = { remove: () => Promise<void> | void };
type PermissionState = "prompt" | "prompt-with-rationale" | "granted" | "denied";

type PushNotificationsPlugin = {
  checkPermissions(): Promise<{ receive: PermissionState }>;
  requestPermissions(): Promise<{ receive: PermissionState }>;
  register(): Promise<void>;
  addListener(event: "registration", handler: (token: { value: string }) => void): Promise<Listener> | Listener;
  addListener(event: "registrationError", handler: (error: { error: string }) => void): Promise<Listener> | Listener;
  addListener(
    event: "pushNotificationActionPerformed",
    handler: (action: { notification: { data?: Record<string, unknown> } }) => void,
  ): Promise<Listener> | Listener;
};

type CapacitorGlobal = {
  getPlatform?: () => string;
  isNativePlatform?: () => boolean;
  isPluginAvailable?: (name: string) => boolean;
  Plugins?: Record<string, unknown>;
};

const API = "/api/push-subscriptions";
// The token this phone last registered, kept so the panel can ask the server
// "do you still know this phone?" and so a launch can refresh it.
const TOKEN_KEY = "clarity.nativePushToken";

function capacitor() {
  return (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
}

/** The push plugin when running inside the staff app, otherwise null. */
export function nativePush(): PushNotificationsPlugin | null {
  const native = capacitor();
  if (!native?.isNativePlatform?.() || !native.isPluginAvailable?.("PushNotifications")) return null;
  return (native.Plugins?.PushNotifications as PushNotificationsPlugin | undefined) || null;
}

function platform(): "ios" | "android" | "" {
  const name = capacitor()?.getPlatform?.();
  return name === "ios" || name === "android" ? name : "";
}

function storedToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

function storeToken(token: string) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private storage unavailable: the next launch registers again, which is harmless.
  }
}

export type NativePushStatus = {
  /** The server can send to this kind of phone. */
  configured: boolean;
  permission: PermissionState;
  /** This phone is registered with the server right now. */
  enabled: boolean;
  /** Browsers and phones registered on the account, together. */
  deviceCount: number;
};

async function readServerStatus(token: string) {
  const response = await fetch(`${API}${token ? `?nativeToken=${encodeURIComponent(token)}` : ""}`, {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(t("Could not read notification settings."));
  return (await response.json()) as {
    native?: { ios?: boolean; android?: boolean };
    nativeRegistered?: boolean;
    deviceCount: number;
  };
}

export async function loadNativePushStatus(): Promise<NativePushStatus> {
  const plugin = nativePush();
  const kind = platform();
  if (!plugin || !kind) return { configured: false, permission: "denied", enabled: false, deviceCount: 0 };
  const [{ receive }, server] = await Promise.all([plugin.checkPermissions(), readServerStatus(storedToken())]);
  return {
    configured: server.native?.[kind] === true,
    permission: receive,
    // Both sides have to agree, as for browsers: permission without a server
    // row rings nothing, and a row for a phone that has said no rings nothing.
    enabled: receive === "granted" && server.nativeRegistered === true,
    deviceCount: server.deviceCount,
  };
}

/** Ask the phone for its push token. Resolves once the OS answers. */
function requestToken(plugin: PushNotificationsPlugin) {
  return new Promise<string>((resolve, reject) => {
    const listeners: Array<Promise<Listener> | Listener> = [];
    const done = () => listeners.forEach((listener) => void Promise.resolve(listener).then((handle) => handle.remove()));
    const timer = window.setTimeout(() => {
      done();
      reject(new Error(t("This phone did not answer. Check it has a connection, then try again.")));
    }, 20_000);
    listeners.push(
      plugin.addListener("registration", (token) => {
        window.clearTimeout(timer);
        done();
        resolve(token.value);
      }),
      plugin.addListener("registrationError", () => {
        window.clearTimeout(timer);
        done();
        reject(new Error(t("This phone could not be registered for notifications.")));
      }),
    );
    void plugin.register().catch((error: unknown) => {
      window.clearTimeout(timer);
      done();
      reject(error instanceof Error ? error : new Error(t("This phone could not be registered for notifications.")));
    });
  });
}

async function registerWithServer(plugin: PushNotificationsPlugin) {
  const kind = platform();
  const token = await requestToken(plugin);
  const response = await fetch(API, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ native: { platform: kind, token, language: activeLanguage() } }),
  });
  if (!response.ok) throw new Error(t("This phone could not be registered for notifications."));
  storeToken(token);
}

export async function enableNativePush(): Promise<NativePushStatus> {
  const plugin = nativePush();
  if (!plugin) throw new Error(t("This phone could not be registered for notifications."));
  const { receive } = await plugin.requestPermissions();
  if (receive !== "granted") {
    throw new Error(t("Notifications are blocked for this app. Allow them in the phone's Settings, then try again."));
  }
  await registerWithServer(plugin);
  return loadNativePushStatus();
}

export async function disableNativePush(): Promise<NativePushStatus> {
  const token = storedToken();
  if (token) {
    await fetch(API, {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nativeToken: token }),
    });
  }
  storeToken("");
  return loadNativePushStatus();
}

/**
 * Once per launch, inside the staff app: open the right screen when an alert
 * is tapped, and, if this phone has alerts on, register again. A push token
 * can change (a restore, an OS update), and registering also carries the
 * language the coach now reads Clarity in, so this keeps both current.
 */
export function startNativePush() {
  const plugin = nativePush();
  if (!plugin) return;
  void plugin.addListener("pushNotificationActionPerformed", (action) => {
    const url = typeof action.notification.data?.url === "string" ? action.notification.data.url : "";
    // "/" is the workspace the app is already showing; anything more specific
    // is a screen to open.
    if (url && url !== "/" && url !== window.location.pathname + window.location.search) window.location.assign(url);
  });
  if (!storedToken()) return;
  void plugin
    .checkPermissions()
    .then(({ receive }) => (receive === "granted" ? registerWithServer(plugin) : undefined))
    .catch(() => undefined);
}
