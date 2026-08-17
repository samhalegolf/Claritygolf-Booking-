/**
 * Browser (web push) notifications for the coach.
 *
 * A subscription belongs to one browser on one device, not to the account, so
 * everything here is per-device: the coach turns them on separately on the
 * laptop and on the phone, and turning them off on one leaves the other alone.
 */

const SERVICE_WORKER_URL = "/sw.js";
const API = "/api/push-subscriptions";

export type PushStatus = {
  /** This browser can do web push at all. */
  supported: boolean;
  /** The server has VAPID keys, so subscribing is possible. */
  configured: boolean;
  permission: NotificationPermission | "unsupported";
  /** This browser is registered with the server right now. */
  enabled: boolean;
  /** How many browsers the account has registered in total. */
  deviceCount: number;
  /** iOS only offers push once the app is installed to the home screen. */
  needsHomeScreenInstall: boolean;
};

export function pushSupported() {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * Safari on iPhone and iPad exposes the push APIs only to a web app that has
 * been added to the home screen. Detecting it lets the panel say so instead of
 * showing a button that can never succeed.
 */
export function needsHomeScreenInstall() {
  if (typeof window === "undefined") return false;
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (!isIos) return false;
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  return !standalone;
}

/** VAPID keys travel as base64url text; PushManager wants the raw bytes. */
function urlBase64ToUint8Array(base64: string) {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) output[index] = raw.charCodeAt(index);
  return output;
}

async function registerServiceWorker() {
  const existing = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL);
  const registration = existing || (await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: "/" }));
  await navigator.serviceWorker.ready;
  return registration;
}

async function currentSubscription() {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL);
  if (!registration) return null;
  return registration.pushManager.getSubscription();
}

async function readServerStatus(endpoint: string) {
  const query = endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : "";
  const response = await fetch(`${API}${query}`, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error("Could not read notification settings.");
  return (await response.json()) as { configured: boolean; publicKey: string; subscribed: boolean; deviceCount: number };
}

export async function loadPushStatus(): Promise<PushStatus> {
  if (!pushSupported()) {
    return {
      supported: false,
      configured: false,
      permission: "unsupported",
      enabled: false,
      deviceCount: 0,
      needsHomeScreenInstall: needsHomeScreenInstall(),
    };
  }

  const subscription = await currentSubscription();
  const server = await readServerStatus(subscription?.endpoint || "");
  return {
    supported: true,
    configured: server.configured,
    permission: Notification.permission,
    // Both sides have to agree. A subscription the server has forgotten is not
    // going to deliver anything, and a server row for a subscription this
    // browser has dropped is a device that will never ring.
    enabled: Boolean(subscription) && server.subscribed,
    deviceCount: server.deviceCount,
    needsHomeScreenInstall: needsHomeScreenInstall(),
  };
}

export async function enablePush(): Promise<PushStatus> {
  if (!pushSupported()) throw new Error("This browser cannot show notifications.");

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(
      permission === "denied"
        ? "Notifications are blocked for this site. Allow them in the browser's site settings, then try again."
        : "Notification permission was not granted.",
    );
  }

  const server = await readServerStatus("");
  if (!server.configured || !server.publicKey) {
    throw new Error("Browser notifications are not set up on the server yet.");
  }

  const registration = await registerServiceWorker();
  // An existing subscription made against a different VAPID key would be
  // refused by the push service on send, so replace rather than reuse.
  const existing = await registration.pushManager.getSubscription();
  if (existing) await existing.unsubscribe();

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(server.publicKey),
  });

  const response = await fetch(API, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subscription: subscription.toJSON(), label: navigator.userAgent }),
  });
  if (!response.ok) {
    await subscription.unsubscribe();
    throw new Error("Could not register this browser for notifications.");
  }

  return loadPushStatus();
}

export async function disablePush(): Promise<PushStatus> {
  const subscription = await currentSubscription();
  const endpoint = subscription?.endpoint || "";
  if (subscription) await subscription.unsubscribe();
  if (endpoint) {
    await fetch(API, {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
  }
  return loadPushStatus();
}

export async function sendTestPush() {
  const response = await fetch(API, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ test: true }),
  });
  const payload = await response.json().catch(() => ({}) as any);
  if (!response.ok && response.status !== 207) {
    throw new Error(payload?.message || "Could not send the test notification.");
  }
  return payload as { ok: boolean; sent: number; failed: number; pruned: number };
}
