import type { Config } from "@netlify/functions";
import { createHash, randomUUID } from "node:crypto";
import {
  getGoogleAccessToken,
  googleCalendarScopes,
  googleDriveFileScope,
  hasGoogleScopes,
  loadGoogleProviderConnection,
  publicGoogleProviderStatus,
  readSettings,
  resolveGoogleAccountId,
  saveGoogleAuthorization,
  setSettings,
} from "./_shared/google-provider.mts";

const sessionCookieName = "clarity_session";
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

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function parseCookies(req: Request) {
  const cookieHeaderValue = req.headers.get("cookie") || "";
  return Object.fromEntries(
    cookieHeaderValue
      .split(";")
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const index = pair.indexOf("=");
        return index === -1
          ? [decodeURIComponent(pair), ""]
          : [decodeURIComponent(pair.slice(0, index)), decodeURIComponent(pair.slice(index + 1))];
      }),
  );
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

async function requireAdmin(req: Request) {
  const token = parseCookies(req)[sessionCookieName] || "";
  if (!token) return false;
  const rows = await supabase("admin_sessions", {
    query: `select=id&token_hash=eq.${encodeURIComponent(hashToken(token))}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`,
  });
  return rows.length > 0;
}

function configuredRedirectUri(req: Request) {
  const configured = env("GOOGLE_DRIVE_REDIRECT_URI", "") || env("GOOGLE_CALENDAR_REDIRECT_URI", "");
  if (configured) return configured;
  const url = new URL(req.url);
  const isLocalHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (!isLocalHost) return "https://claritygolf.app/api/google-drive/callback";
  return `${url.origin}/api/google-drive/callback`;
}

function googleConfig(req: Request) {
  return {
    clientId: env("GOOGLE_CLIENT_ID", "") || env("GOOGLE_CALENDAR_CLIENT_ID", ""),
    clientSecret: env("GOOGLE_CLIENT_SECRET", "") || env("GOOGLE_CALENDAR_CLIENT_SECRET", ""),
    redirectUri: configuredRedirectUri(req),
  };
}

function tokenEncryptionConfigured() {
  return Boolean(env("GOOGLE_PROVIDER_TOKEN_ENCRYPTION_KEY_V1", ""));
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

async function driveStatusFromSettings(req: Request, settings: Record<string, string>) {
  const config = googleConfig(req);
  const configured = Boolean(config.clientId && config.clientSecret && config.redirectUri);
  const accountId = resolveGoogleAccountId(settings);
  const connection = await loadGoogleProviderConnection(accountId);
  const providerStatus = publicGoogleProviderStatus(connection, requiredDriveScopes);
  const calendarConnected = Boolean(connection?.calendarEnabled && hasGoogleScopes(connection, googleCalendarScopes));
  const driveScopeGranted = Boolean(connection && hasGoogleScopes(connection, [driveFileScope]));
  const encryptionConfigured = tokenEncryptionConfigured();
  const providerStorageConfigured = true;
  const blocker = !encryptionConfigured
    ? "Secure provider storage is unavailable."
    : "";

  let state: DriveStatusState = "not_connected";
  if (!configured) state = "error";
  else if (blocker) state = "blocked";
  else if (calendarConnected && !driveScopeGranted) state = "permission_upgrade_required";
  else if (driveScopeGranted && connection?.driveEnabled && connection.connectionStatus === "connected") state = "connected";
  else if (connection?.connectionStatus === "reconnect_required") state = "reconnect_required";
  else if (connection?.connectionStatus === "error") state = "error";

  return {
    ok: true,
    configured,
    connected: state === "connected",
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
    blocker,
    message:
      blocker ||
      (state === "permission_upgrade_required"
        ? "Clarity Cloud permission required."
        : state === "connected"
          ? "Clarity Cloud can send saved videos."
          : state === "reconnect_required"
            ? "Google needs to be reconnected before Drive transfer can be prepared."
          : configured
            ? "Clarity Cloud is ready to connect."
            : "Google OAuth credentials are not configured."),
  };
}

async function createGoogleDriveAuthUrl(req: Request, settings: Record<string, string>) {
  const config = googleConfig(req);
  if (!config.clientId || !config.clientSecret) {
    throw Object.assign(new Error("Google OAuth is not configured."), { status: 400 });
  }
  const accountId = resolveGoogleAccountId(settings);
  const state = randomUUID().replaceAll("-", "");
  await setSettings({
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
  const settings = await readSettings();
  const expectedState = settings.googleDriveOAuthState || "";
  if (!expectedState || state !== expectedState) {
    throw Object.assign(new Error("Google Drive connection could not be verified."), { status: 400 });
  }
  const startedAt = Date.parse(settings.googleDriveOAuthStartedAt || "");
  if (!Number.isFinite(startedAt) || Date.now() - startedAt > 15 * 60 * 1000) {
    throw Object.assign(new Error("Google Drive connection expired. Start again."), { status: 400 });
  }

  const config = googleConfig(req);
  const token = await tokenRequest({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    code,
    grant_type: "authorization_code",
  });
  const profile = token.access_token ? await userProfile(token.access_token) : { email: "", id: "" };
  await saveGoogleAuthorization({
    accountId: settings.googleDriveOAuthAccountId || resolveGoogleAccountId(settings),
    refreshToken: cleanString(token.refresh_token, "", 4000) || undefined,
    grantedScopes: cleanString(token.scope, "", 3000).split(/\s+/).filter(Boolean).length
      ? cleanString(token.scope, "", 3000).split(/\s+/).filter(Boolean)
      : requiredDriveScopes,
    providerEmail: profile.email || settings.googleCalendarAccountEmail || "",
    providerUserId: profile.id,
    enableCalendar: true,
    enableDrive: true,
  });
  await setSettings({
    googleDriveOAuthState: "",
    googleDriveOAuthAccountId: "",
    googleDriveOAuthStartedAt: "",
  });
  return driveStatusFromSettings(req, await readSettings());
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

export default async function handler(req: Request) {
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

    if (!(await requireAdmin(req))) return json({ error: "unauthorized", message: "Admin login required." }, 401);
    const settings = await readSettings();
    const status = await driveStatusFromSettings(req, settings);

    if (req.method === "GET" && action === "status") return json(status);
    if (req.method === "POST" && action === "test") {
      if (status.state !== "connected") return json({ ...status, ok: false, error: status.state }, 409);
      await getGoogleAccessToken(status.accountId, [driveFileScope]);
      return json({
        ...status,
        ok: true,
        message: "Clarity Cloud can send saved videos.",
      });
    }
    if ((req.method === "GET" || req.method === "POST") && action === "connect") {
      if (!status.configured) return json({ ...status, ok: false, error: "google_oauth_not_configured" }, 400);
      if (status.blocker) {
        return json({ ...status, ok: false, error: "drive_prerequisite_required" }, 412);
      }
      return json({ ...status, ...(await createGoogleDriveAuthUrl(req, settings)) });
    }
    if (req.method === "POST" && action === "disconnect") {
      return json({
        ...status,
        ok: false,
        error: "drive_transfer_not_implemented",
        message: "Drive disconnect is blocked until Drive folder ownership and transfer lifecycle rules are implemented.",
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
