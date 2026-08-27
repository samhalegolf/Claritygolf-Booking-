import type { Config } from "@netlify/functions";
import { createHash, randomUUID } from "node:crypto";
import {
  clarityCloudGoogleMissingConfigurationLabels,
  getClarityCloudGoogleConfig,
  isClarityCloudProviderTokenEncryptionConfigured,
  type ClarityCloudGoogleConfig,
} from "./_shared/clarity-cloud-google-config.mts";
import {
  getGoogleAccessToken,
  googleCalendarScopes,
  googleDriveFileScope,
  hasGoogleScopes,
  loadGoogleProviderConnection,
  publicGoogleProviderStatus,
  readSettings,
  saveGoogleAuthorization,
  setSettings,
} from "./_shared/google-provider.mts";
import { requireCoachActor } from "./_shared/coach-auth.mts";

const driveFileScope = googleDriveFileScope;
const requiredDriveScopes = [...googleCalendarScopes, googleDriveFileScope];

type DriveStatusState =
  | "not_connected"
  | "connected"
  | "permission_upgrade_required"
  | "reconnect_required"
  | "blocked"
  | "error";

function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function cleanString(value: unknown, fallback = "", max = 1200) {
  return typeof value === "string" ? value.trim().slice(0, max) || fallback : fallback;
}

function supabaseConfig() {
  const url = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
  if (!url || !key) throw new Error("Supabase is not configured.");
  return { url, key };
}

async function supabase(table: string, options: { method?: string; query?: string; body?: unknown; prefer?: string } = {}) {
  const { url, key } = supabaseConfig();
  const response = await fetch(`${url}/rest/v1/${table}${options.query ? `?${options.query}` : ""}`, {
    method: options.method || "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(options.prefer ? { Prefer: options.prefer } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${options.method || "GET"} ${table} failed ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : [];
}

async function tokenRequest(params: Record<string, string>) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw Object.assign(new Error(data.error_description || data.error || "Google token request failed."), {
      status: response.status,
    });
  }
  return data;
}

async function userProfile(accessToken: string) {
  try {
    const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = response.ok ? await response.json() : {};
    return {
      email: cleanString(data.email, "", 180),
      id: cleanString(data.id, "", 180),
    };
  } catch {
    return { email: "", id: "" };
  }
}

function requireConfiguredGoogleConfig(config: ClarityCloudGoogleConfig) {
  if (config.configured) return config;
  throw Object.assign(new Error("Clarity Cloud is not configured for this environment."), {
    code: "CLOUD_OAUTH_NOT_CONFIGURED",
    status: 503,
  });
}

async function driveStatusFromSettings(accountId: string, req: Request, settings: Record<string, string>) {
  const config = getClarityCloudGoogleConfig(req);
  const configured = config.configured;
  const connection = await loadGoogleProviderConnection(accountId);
  const providerStatus = publicGoogleProviderStatus(connection, requiredDriveScopes);
  const calendarConnected = Boolean(connection?.calendarEnabled && hasGoogleScopes(connection, googleCalendarScopes));
  const driveScopeGranted = Boolean(connection && hasGoogleScopes(connection, [driveFileScope]));
  const encryptionConfigured = isClarityCloudProviderTokenEncryptionConfigured();
  const providerStorageConfigured = true;
  const oauthBlocker = configured ? "" : "Clarity Cloud is not configured for this environment.";
  const blocker = oauthBlocker ||
    (!encryptionConfigured
    ? "Secure provider storage is unavailable."
    : "");
  const safeErrorCode = oauthBlocker
    ? "CLOUD_OAUTH_NOT_CONFIGURED"
    : !encryptionConfigured
      ? "PROVIDER_STORAGE_UNAVAILABLE"
      : "";
  const foldersReady = Boolean(
    settings.googleDriveInboxFolderId &&
      settings.googleDriveImportedFolderId &&
      settings.googleDriveFailedFolderId
  );

  let state: DriveStatusState = "not_connected";
  if (!configured) state = "blocked";
  else if (blocker) state = "blocked";
  else if (calendarConnected && !driveScopeGranted) state = "permission_upgrade_required";
  else if (driveScopeGranted && connection?.driveEnabled && connection.connectionStatus === "connected") state = "connected";
  else if (connection?.connectionStatus === "reconnect_required") state = "reconnect_required";
  else if (connection?.connectionStatus === "error") state = "error";
  const connected = state === "connected";
  const routeReady = configured && encryptionConfigured && connected && foldersReady;

  return {
    ok: true,
    configured,
    connected,
    state,
    accountId,
    calendarConnected,
    driveScopeGranted,
    accountEmail: providerStatus.accountEmail || settings.googleCalendarAccountEmail || "",
    redirectUri: config.redirectUri,
    scope: driveFileScope,
    requestedScopes: requiredDriveScopes.join(" "),
    rootFolderId: settings.googleDriveRootFolderId || "",
    inboxFolderId: settings.googleDriveInboxFolderId || "",
    importedFolderId: settings.googleDriveImportedFolderId || "",
    failedFolderId: settings.googleDriveFailedFolderId || "",
    tokenEncryptionConfigured: encryptionConfigured,
    providerStorageConfigured,
    uploadRouteReady: routeReady,
    chunkedTransportReady: routeReady,
    incomingImportReady: routeReady,
    safeErrorCode,
    missingConfiguration: clarityCloudGoogleMissingConfigurationLabels(config.missingFields),
    blocker,
    message:
      blocker ||
      (state === "permission_upgrade_required"
        ? "Clarity Cloud permission required."
        : state === "connected"
          ? "Clarity Cloud can send saved videos."
          : state === "reconnect_required"
            ? "Reconnect the Clarity Cloud provider before transfers can be prepared."
          : configured
            ? "Clarity Cloud is ready to connect."
            : "Clarity Cloud is not configured for this environment."),
  };
}

async function createGoogleDriveAuthUrl(accountId: string, req: Request) {
  const config = requireConfiguredGoogleConfig(getClarityCloudGoogleConfig(req));
  const state = randomUUID().replaceAll("-", "");
  await setSettings(accountId, {
    googleDriveOAuthState: state,
    googleDriveOAuthAccountId: accountId,
    googleDriveOAuthStartedAt: new Date().toISOString(),
  });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", requiredDriveScopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return {
    authUrl: url.toString(),
    redirectUri: config.redirectUri,
    scope: driveFileScope,
    requestedScopes: requiredDriveScopes.join(" "),
  };
}

/**
 * Which business started this Drive OAuth flow.
 *
 * The state is a 128-bit random value written into that business's settings
 * when the authorize URL was built, so the lookup is the CSRF check and the
 * account resolution at once. A browser cannot simply assert a slug.
 */
async function accountForOAuthState(state: string): Promise<string> {
  if (!state) return "";
  const rows = await supabase("settings", {
    query: [
      "select=account_id",
      `key=eq.${encodeURIComponent("googleDriveOAuthState")}`,
      `value=eq.${encodeURIComponent(state)}`,
      "limit=2",
    ].join("&"),
  });
  // Exactly one business may hold a given nonce; anything else is a collision
  // or tampering, and neither should pick a winner.
  return rows.length === 1 ? cleanString(rows[0]?.account_id, "", 80) : "";
}

async function finishGoogleDriveOAuth(req: Request) {
  const url = new URL(req.url);
  const oauthError = cleanString(url.searchParams.get("error"), "", 200);
  const oauthErrorDescription = cleanString(url.searchParams.get("error_description"), "", 600);
  if (oauthError) {
    throw Object.assign(new Error(oauthErrorDescription || oauthError), { status: 400 });
  }
  const code = cleanString(url.searchParams.get("code"), "", 2000);
  const state = cleanString(url.searchParams.get("state"), "", 200);
  if (!code || !state) {
    throw Object.assign(new Error("Google did not return the required authorization code."), { status: 400 });
  }
  // The callback carries no session, so the business comes out of the flow
  // itself: the state is a 128-bit value this server wrote into that business's
  // settings when it built the authorize URL, so looking the account up by the
  // state is both the CSRF check and the account resolution.
  const accountId = await accountForOAuthState(state);
  if (!accountId) {
    throw Object.assign(new Error("Google Drive connection could not be verified."), { status: 400 });
  }
  const settings = await readSettings(accountId);
  const expectedState = settings.googleDriveOAuthState || "";
  if (!expectedState || state !== expectedState) {
    throw Object.assign(new Error("Google Drive connection could not be verified."), { status: 400 });
  }
  const startedAt = Date.parse(settings.googleDriveOAuthStartedAt || "");
  if (!Number.isFinite(startedAt) || Date.now() - startedAt > 15 * 60 * 1000) {
    throw Object.assign(new Error("Google Drive connection expired. Start again."), { status: 400 });
  }

  const config = requireConfiguredGoogleConfig(getClarityCloudGoogleConfig(req));
  const token = await tokenRequest({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    code,
    grant_type: "authorization_code",
  });
  const profile = token.access_token ? await userProfile(token.access_token) : { email: "", id: "" };
  await saveGoogleAuthorization({
    accountId,
    refreshToken: cleanString(token.refresh_token, "", 4000) || undefined,
    grantedScopes: cleanString(token.scope, "", 3000).split(/\s+/).filter(Boolean).length
      ? cleanString(token.scope, "", 3000).split(/\s+/).filter(Boolean)
      : requiredDriveScopes,
    // Google told us; anything else is a guess and must not overwrite the truth.
    scopesFromProvider: cleanString(token.scope, "", 3000).split(/\s+/).filter(Boolean).length > 0,
    providerEmail: profile.email || settings.googleCalendarAccountEmail || "",
    providerUserId: profile.id,
    enableCalendar: true,
    enableDrive: true,
  });
  await setSettings(accountId, {
    googleDriveOAuthState: "",
    googleDriveOAuthAccountId: "",
    googleDriveOAuthStartedAt: "",
  });
  return driveStatusFromSettings(accountId, req, await readSettings(accountId));
}

function html(value: string, status = 200) {
  return new Response(value, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function callbackPage(ok: boolean, message: string) {
  const escaped = message.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] || char);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Clarity Cloud ${ok ? "Connected" : "Connection Failed"}</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Inter, system-ui, sans-serif; background: #f5f5f3; color: #171717; }
      main { width: min(440px, calc(100vw - 32px)); padding: 24px; border: 1px solid #deded8; border-radius: 12px; background: #fff; }
      h1 { margin: 0 0 8px; font-size: 28px; }
      p { margin: 0 0 18px; color: #5d5a54; line-height: 1.45; }
      a { display: inline-flex; min-height: 42px; align-items: center; padding: 0 16px; border-radius: 8px; background: #111; color: #fff; text-decoration: none; font-weight: 800; }
    </style>
  </head>
  <body>
    <main>
      <h1>${ok ? "Clarity Cloud connected" : "Clarity Cloud not connected"}</h1>
      <p>${escaped}</p>
      <a href="/?view=settings">Back to Clarity Booking</a>
    </main>
  </body>
</html>`;
}

/**
 * `options.resolveAccountId` is a test seam (see video-transfer.mts): auth now
 * resolves through Postgres, and the unit tests covering the Drive setup error
 * shapes have no database. Netlify never passes it.
 */
export default async function handler(
  req: Request,
  _context?: unknown,
  options: { resolveAccountId?: (req: Request) => Promise<string> } = {},
) {
  const url = new URL(req.url);
  const action =
    url.pathname
      .replace(/^\/api\/google-drive\/?/, "")
      .replace(/^\/\.netlify\/functions\/google-drive\/?/, "") || "status";

  try {
    if (req.method === "GET" && action === "callback") {
      const status = await finishGoogleDriveOAuth(req);
      return html(callbackPage(true, `Connected${status.accountEmail ? ` as ${status.accountEmail}` : ""}. Clarity Cloud can send saved videos.`));
    }

    // Drive is connected per business, so the route needs the business the
    // caller administers, not just "a session exists".
    const accountId = options.resolveAccountId
      ? await options.resolveAccountId(req)
      : (await requireCoachActor(req)).accountId;
    const settings = await readSettings(accountId);
    const status = await driveStatusFromSettings(accountId, req, settings);

    if (req.method === "GET" && action === "status") return json(status);
    if (req.method === "POST" && action === "test") {
      if (status.state !== "connected") {
        return json({
          ...status,
          ok: false,
          error: {
            code: status.safeErrorCode || status.state,
            message: status.message,
          },
        }, status.safeErrorCode ? 503 : 409);
      }
      await getGoogleAccessToken(status.accountId, [driveFileScope]);
      return json({
        ...status,
        ok: true,
        message: "Clarity Cloud can send saved videos.",
      });
    }
    if ((req.method === "GET" || req.method === "POST") && action === "connect") {
      if (!status.configured) {
        return json({
          ...status,
          ok: false,
          error: {
            code: "CLOUD_OAUTH_NOT_CONFIGURED",
            message: "Clarity Cloud is not configured for this environment.",
          },
        }, 503);
      }
      if (status.blocker) {
        return json({
          ...status,
          ok: false,
          error: {
            code: status.safeErrorCode || "CLARITY_CLOUD_SETUP_INCOMPLETE",
            message: status.message,
          },
        }, 412);
      }
      return json({ ...status, ...(await createGoogleDriveAuthUrl(accountId, req)) });
    }
    if (req.method === "POST" && action === "disconnect") {
      return json({
        ...status,
        ok: false,
        error: "clarity_cloud_disconnect_blocked",
        message: "Clarity Cloud disconnect is blocked until transfer cleanup rules are implemented.",
      }, 412);
    }

    return json({ error: "not_found", message: "Google Drive route not found." }, 404);
  } catch (error: any) {
    console.error("google_drive:failed", action, error);
    const status = error?.status || 500;
    if (req.method === "GET" && action === "callback") {
      return html(callbackPage(false, error instanceof Error ? error.message : "Google Drive connection failed."), status);
    }
    return json(
      {
        error: status === 500 ? "google_drive_error" : "request_error",
        message: error instanceof Error ? error.message : "Google Drive request failed.",
      },
      status,
    );
  }
}

export const config: Config = {
  path: "/api/google-drive/*",
};
