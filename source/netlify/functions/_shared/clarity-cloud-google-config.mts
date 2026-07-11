export type ClarityCloudGoogleMissingField = "clientId" | "clientSecret" | "redirectUri";

export type ClarityCloudGoogleConfigSource =
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CALENDAR_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
  | "GOOGLE_CALENDAR_CLIENT_SECRET"
  | "GOOGLE_DRIVE_REDIRECT_URI"
  | "GOOGLE_CALENDAR_REDIRECT_URI"
  | "production-safe-callback-fallback"
  | "";

export type ClarityCloudGoogleConfig = {
  configured: boolean;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  clientIdSource: ClarityCloudGoogleConfigSource;
  clientSecretSource: ClarityCloudGoogleConfigSource;
  redirectUriSource: ClarityCloudGoogleConfigSource;
  missingFields: ClarityCloudGoogleMissingField[];
};

export type SafeClarityCloudGoogleRuntimeDiagnostic = {
  googleClientIdPresent: boolean;
  googleClientSecretPresent: boolean;
  driveRedirectUriPresent: boolean;
  encryptionKeyPresent: boolean;
  clientIdSource: ClarityCloudGoogleConfigSource;
  clientSecretSource: ClarityCloudGoogleConfigSource;
  redirectUriSource: ClarityCloudGoogleConfigSource;
  configured: boolean;
  missingFields: ClarityCloudGoogleMissingField[];
};

type EnvReader = (name: string) => string | undefined;

const googleClientIdNames = ["GOOGLE_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_ID"] as const;
const googleClientSecretNames = ["GOOGLE_CLIENT_SECRET", "GOOGLE_CALENDAR_CLIENT_SECRET"] as const;
const googleDriveRedirectUriNames = ["GOOGLE_DRIVE_REDIRECT_URI", "GOOGLE_CALENDAR_REDIRECT_URI"] as const;

function env(name: string, reader?: EnvReader) {
  if (reader) return reader(name) || "";
  return globalThis.Netlify?.env?.get(name) || process.env[name] || "";
}

function cleanString(value: unknown, max = 4000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function firstConfiguredEnv(names: readonly string[], reader?: EnvReader) {
  for (const name of names) {
    const value = cleanString(env(name, reader));
    if (value) return { value, source: name as ClarityCloudGoogleConfigSource };
  }
  return { value: "", source: "" as ClarityCloudGoogleConfigSource };
}

function productionSafeDriveCallback(req?: Request) {
  if (!req) return "https://claritygolf.app/api/google-drive/callback";
  const url = new URL(req.url);
  const isLocalHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (!isLocalHost) return "https://claritygolf.app/api/google-drive/callback";
  return `${url.origin}/api/google-drive/callback`;
}

export function getClarityCloudGoogleConfig(
  req?: Request,
  options: { env?: EnvReader } = {},
): ClarityCloudGoogleConfig {
  const clientId = firstConfiguredEnv(googleClientIdNames, options.env);
  const clientSecret = firstConfiguredEnv(googleClientSecretNames, options.env);
  const configuredRedirectUri = firstConfiguredEnv(googleDriveRedirectUriNames, options.env);
  const redirectUri = configuredRedirectUri.value || productionSafeDriveCallback(req);
  const redirectUriSource = configuredRedirectUri.source || "production-safe-callback-fallback";
  const missingFields: ClarityCloudGoogleMissingField[] = [
    clientId.value ? "" : "clientId",
    clientSecret.value ? "" : "clientSecret",
    redirectUri ? "" : "redirectUri",
  ].filter(Boolean) as ClarityCloudGoogleMissingField[];

  return {
    configured: missingFields.length === 0,
    clientId: clientId.value,
    clientSecret: clientSecret.value,
    redirectUri,
    clientIdSource: clientId.source,
    clientSecretSource: clientSecret.source,
    redirectUriSource,
    missingFields,
  };
}

export function clarityCloudGoogleMissingConfigurationLabels(fields: readonly ClarityCloudGoogleMissingField[]) {
  return fields.map((field) => {
    if (field === "clientId") return "GOOGLE_CLIENT_ID or GOOGLE_CALENDAR_CLIENT_ID";
    if (field === "clientSecret") return "GOOGLE_CLIENT_SECRET or GOOGLE_CALENDAR_CLIENT_SECRET";
    return "GOOGLE_DRIVE_REDIRECT_URI or GOOGLE_CALENDAR_REDIRECT_URI";
  });
}

export function isClarityCloudProviderTokenEncryptionConfigured(options: { env?: EnvReader } = {}) {
  return Boolean(cleanString(env("GOOGLE_PROVIDER_TOKEN_ENCRYPTION_KEY_V1", options.env)));
}

export function getSafeClarityCloudGoogleRuntimeDiagnostic(
  req?: Request,
  options: { env?: EnvReader } = {},
): SafeClarityCloudGoogleRuntimeDiagnostic {
  const config = getClarityCloudGoogleConfig(req, options);
  return {
    googleClientIdPresent: Boolean(config.clientId),
    googleClientSecretPresent: Boolean(config.clientSecret),
    driveRedirectUriPresent: Boolean(config.redirectUri),
    encryptionKeyPresent: isClarityCloudProviderTokenEncryptionConfigured(options),
    clientIdSource: config.clientIdSource,
    clientSecretSource: config.clientSecretSource,
    redirectUriSource: config.redirectUriSource,
    configured: config.configured,
    missingFields: config.missingFields,
  };
}
