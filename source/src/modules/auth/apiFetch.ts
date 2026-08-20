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
async function preferences(): Promise<PreferencesPlugin | null> {
  if (!NATIVE) return null;
  try {
    const module = await import("@capacitor/preferences");
    return module.Preferences as PreferencesPlugin;
  } catch {
    return null;
  }
}

/** Read the stored token into memory. Await this before the first API call. */
export async function loadAuthToken(): Promise<void> {
  if (!NATIVE) return;
  const store = await preferences();
  token = store
    ? ((await store.get({ key: TOKEN_KEY })).value ?? "")
    : (window.localStorage.getItem(TOKEN_KEY) ?? "");
}

export async function setAuthToken(next: string): Promise<void> {
  token = next;
  if (!NATIVE) return;
  const store = await preferences();
  if (store) await store.set({ key: TOKEN_KEY, value: next });
  else window.localStorage.setItem(TOKEN_KEY, next);
}

export async function clearAuthToken(): Promise<void> {
  token = "";
  if (!NATIVE) return;
  const store = await preferences();
  if (store) await store.remove({ key: TOKEN_KEY });
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
