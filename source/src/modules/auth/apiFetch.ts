// Where the API is, and how this client proves who it is.
//
// On the web the browser answers both questions for us: /api is same-origin,
// and the session is an HttpOnly cookie it attaches to every request.
//
// In the native app neither is true. The page is served from
// capacitor://localhost, so a call to claritygolf.app is cross-site and a
// SameSite=Lax cookie is never sent -- login would appear to succeed and the
// very next request would come back as a guest. The app carries the same
// player_sessions token as a bearer header instead, and keeps it in native
// storage between launches. Same token, same table, same 30-day expiry; only
// the transport differs.
//
// One wrapper owns that difference so no call site has to know about it.

// Vite replaces these at build time. The unit tests import this module under
// `tsx` in plain Node, where import.meta has no `env` at all -- reading it
// defensively is what keeps a build-time constant from becoming a load-time
// crash in the test runner.
const buildEnv: Partial<ImportMetaEnv> = import.meta.env ?? {};

/** True in the Capacitor build only. Set by vite.app.config.ts. */
export const NATIVE = buildEnv.VITE_NATIVE === "1";

/** Absolute on native, empty (same-origin) on the web. */
const API_BASE = NATIVE ? (buildEnv.VITE_API_BASE ?? "").replace(/\/$/, "") : "";

const TOKEN_KEY = "clarity-player-token";

// Held in memory so apiFetch stays synchronous after startup. loadAuthToken()
// fills it once, before the first request.
let token = "";

type PreferencesPlugin = {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
};

// Native storage survives a WebKit data clear, which localStorage does not.
// The import is dynamic and NATIVE is a build-time constant, so the plugin is
// dropped from the web bundle entirely rather than shipped and never called.
// A missing plugin falls back to localStorage rather than failing sign-in.
//
// The plugin object itself must never be `return`ed straight out of an async
// function. Capacitor's plugin objects are Proxies that treat every property
// access as a native method call -- and returning a value from an async
// function makes the engine probe it for a `.then` property to see if it is
// itself a promise. That probe reads as a call to a native method named
// "then", which does not exist, and the plugin rejects with exactly that:
// `"Preferences.then() is not implemented on ios"`. Boxing it in a plain
// object keeps it away from that check.
async function preferences(): Promise<{ plugin: PreferencesPlugin } | null> {
  if (!NATIVE) return null;
  try {
    const module = await import("@capacitor/preferences");
    return { plugin: module.Preferences as PreferencesPlugin };
  } catch {
    return null;
  }
}

// The Preferences bridge call has been observed to neither resolve nor
// reject on some simulator/cold-start states -- it just goes silent. Every
// call into it goes through here so a stuck native call can never hang the
// caller (loading a session, or saving one right after a successful login)
// forever. On timeout or rejection it falls back to whatever the caller
// decides is safe to assume.
const NATIVE_STORAGE_TIMEOUT_MS = 3000;

function withTimeout<T>(promise: Promise<T>, fallback: () => T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(fallback());
      }
    }, NATIVE_STORAGE_TIMEOUT_MS);
    promise.then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(fallback());
        }
      },
    );
  });
}

/** Read the stored token into memory. Await this before the first API call. */
export async function loadAuthToken(): Promise<void> {
  if (!NATIVE) return;
  const boxed = await preferences();
  if (!boxed) {
    token = window.localStorage.getItem(TOKEN_KEY) ?? "";
    return;
  }
  const result = await withTimeout(boxed.plugin.get({ key: TOKEN_KEY }), () => ({ value: null }));
  token = result.value ?? "";
}

export async function setAuthToken(next: string): Promise<void> {
  // Set in memory first: even if native storage never answers, the rest of
  // this launch can still use the token. Only persisting it for next launch
  // is at risk, not signing in right now.
  token = next;
  if (!NATIVE) return;
  const boxed = await preferences();
  if (boxed) await withTimeout(boxed.plugin.set({ key: TOKEN_KEY, value: next }), () => undefined);
  else window.localStorage.setItem(TOKEN_KEY, next);
}

export async function clearAuthToken(): Promise<void> {
  token = "";
  if (!NATIVE) return;
  const boxed = await preferences();
  if (boxed) await withTimeout(boxed.plugin.remove({ key: TOKEN_KEY }), () => undefined);
  else window.localStorage.removeItem(TOKEN_KEY);
}

/**
 * fetch() for the Clarity API. Takes the same absolute path either build uses
 * ("/api/player/profile") and adds whatever that build needs to reach it.
 */
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (NATIVE) {
    // Tells the server this client cannot hold a cookie, so a successful login
    // should return the session token in its body. A browser never sends this
    // and so never sees the token, which is the safer default.
    headers.set("X-Clarity-Client", "app");
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }
  return fetch(`${API_BASE}${path}`, {
    cache: "no-store",
    ...init,
    headers,
    // Cookies are useless cross-site, and sending them would force the server
    // into credentialed CORS for no gain.
    credentials: NATIVE ? "omit" : "same-origin",
  });
}
