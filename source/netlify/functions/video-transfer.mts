import type { Config } from "@netlify/functions";
import { createHash, randomUUID } from "node:crypto";
import {
  getClarityCloudGoogleConfig,
  getSafeClarityCloudGoogleRuntimeDiagnostic,
  isClarityCloudProviderTokenEncryptionConfigured,
} from "./_shared/clarity-cloud-google-config.mts";
import {
  getGoogleAccessToken,
  googleDriveFileScope,
  hasGoogleScopes,
  loadGoogleProviderConnection,
  readSettings,
  resolveGoogleAccountId,
  setSettings,
} from "./_shared/google-provider.mts";

const sessionCookieName = "clarity_session";
const clarityVersion = "1";
// Netlify buffers synchronous function request bodies with a 6 MB payload limit,
// so chunks must stay safely below it. 4 MB is also a multiple of Google's
// 256 KB resumable-upload granularity (see googleChunkGranularityBytes).
export const defaultChunkSizeBytes = 4 * 1024 * 1024;
export const maxChunkSizeBytes = defaultChunkSizeBytes;
export const googleChunkGranularityBytes = 256 * 1024;
const transferSessionTtlMs = 1000 * 60 * 60 * 24;
const transferSessionTable = "video_transfer_sessions";

type TransferStatus =
  | "preparing"
  | "session-created"
  | "uploading"
  | "paused"
  | "verifying"
  | "ready"
  | "failed"
  | "cancelled"
  | "expired";

export type ClarityCloudProviderId = "google-drive";

type ClarityCloudCatalogueStatus =
  | "uploading"
  | "ready_to_import"
  | "importing"
  | "imported"
  | "cleanup_scheduled"
  | "complete"
  | "repair_required"
  | "failed"
  | "cancelled"
  | "expired";

type TransferErrorCode =
  | "CLOUD_OAUTH_NOT_CONFIGURED"
  | "PROVIDER_STORAGE_UNAVAILABLE"
  | "DRIVE_NOT_CONNECTED"
  | "DRIVE_SCOPE_MISSING"
  | "GOOGLE_RECONNECT_REQUIRED"
  | "GOOGLE_TOKEN_REFRESH_FAILED"
  | "DRIVE_FOLDER_PROVISION_FAILED"
  | "DRIVE_TRANSFER_FOLDER_FAILED"
  | "DRIVE_UPLOAD_SESSION_FAILED"
  | "DRIVE_TRANSFER_STATE_FAILED"
  | "DRIVE_UPLOAD_PROXY_FAILED"
  | "DRIVE_UPLOAD_TOO_LARGE"
  | "DRIVE_UPLOAD_SESSION_EXPIRED"
  | "DRIVE_UPLOAD_INTERRUPTED"
  | "DRIVE_UPLOAD_VERIFY_FAILED"
  | "DRIVE_FINALIZE_FAILED"
  | "SAVED_VIDEO_BLOB_MISSING"
  | "SAVED_VIDEO_SOURCE_MISSING"
  | "TRANSFER_PAUSED"
  | "TRANSFER_CANCELLED"
  | "CLARITY_CLOUD_IMPORT_NOT_READY"
  | "CLARITY_CLOUD_IMPORT_VERIFY_FAILED"
  | "CLARITY_CLOUD_IMPORT_RECEIPT_FAILED"
  | "CLARITY_CLOUD_PROVIDER_FAILED";

type TransferPhase = "preparing" | "session-created" | "uploading" | "verifying" | "ready";

type ProviderDiagnostics = {
  step?: string;
  endpointClass?: string;
  googleStatus?: number;
  googleReason?: string;
  accessTokenRefreshed?: boolean;
  rootFolderReady?: boolean;
  transferFolderReady?: boolean;
  inboxFolderReady?: boolean;
  assetFolderReady?: boolean;
  resumableSessionReturned?: boolean;
  afterResumableSession?: boolean;
};

type SafeSavedVideo = {
  savedVideoId: string;
  playerId: string;
  lessonId?: string;
  analysisId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  source?: {
    originalFileName?: string;
    mimeType?: string;
    sizeBytes?: number;
    duration?: number;
    width?: number;
    height?: number;
    checksumSha256?: string;
    sourceDeviceId?: string;
  };
};

type UploadVideoMetadata = {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
  driveFileId?: string;
};

type DriveFile = {
  id: string;
  name?: string;
  mimeType?: string;
  size?: string;
  md5Checksum?: string;
  parents?: string[];
  appProperties?: Record<string, string>;
  webViewLink?: string;
};

type ProviderHealth = {
  connected: boolean;
  state: "connected" | "not_connected" | "permission_required" | "reconnect_required" | "error";
  message: string;
};

type ProviderTransferStorage = Awaited<ReturnType<typeof ensureTransferFolders>>;

type ProviderUploadContext = {
  accountId: string;
  savedVideo: SafeSavedVideo;
  video: UploadVideoMetadata;
  storage: ProviderTransferStorage;
};

type ProviderUploadSession = {
  assetFolderId: string;
  videoFileId?: string;
  resumableSessionUrl: string;
  folderLink?: string | null;
};

type ProviderUploadChunkContext = {
  sessionUrl: string;
  contentType: string;
  startByte: number;
  endByte: number;
  totalSize: number;
  bytes: Buffer;
};

type ProviderChunkResult = {
  status: "uploading" | "verifying" | "interrupted" | "expired" | "auth_failed" | "failed";
  acceptedOffsetBytes: number;
  videoFileId?: string;
  responseStatus: number;
};

type ProviderFinalizeContext = {
  accountId: string;
  session: VideoTransferSession;
  savedVideo: SafeSavedVideo;
  video: UploadVideoMetadata;
  analysisJson: Record<string, unknown>;
};

type ProviderFinalizeResult = {
  assetFolderId: string;
  videoFileId: string;
  analysisFileId: string;
  manifestFileId: string;
  manifest: Record<string, unknown>;
};

type ProviderFileContext = {
  fileId: string;
};

type ProviderReadRangeContext = ProviderFileContext & {
  range?: string;
};

type ProviderFileMetadata = DriveFile;

type ProviderDeleteContext = {
  assetFolderId: string;
};

type ProviderFolderContext = {
  folderId: string;
};

export type ClarityCloudProviderAdapter = {
  id: ClarityCloudProviderId;
  displayName: string;
  getConnectionHealth(accountId: string): Promise<ProviderHealth>;
  ensureTransferStorage(accountId: string): Promise<ProviderTransferStorage>;
  createUploadSession(context: ProviderUploadContext): Promise<ProviderUploadSession>;
  uploadChunk(context: ProviderUploadChunkContext): Promise<ProviderChunkResult>;
  finalizeUpload(context: ProviderFinalizeContext): Promise<ProviderFinalizeResult>;
  readJsonFile(context: ProviderFileContext): Promise<unknown>;
  readFileRange(context: ProviderReadRangeContext): Promise<Uint8Array | Response>;
  getFileMetadata(context: ProviderFileContext): Promise<ProviderFileMetadata>;
  deleteTransferAsset(context: ProviderDeleteContext): Promise<void>;
  getTransferFolderLink?(context: ProviderFolderContext): Promise<string | null>;
};

export type VideoTransferSession = {
  version: 1;
  transferId: string;
  savedVideoId: string;
  accountId: string;
  providerId: ClarityCloudProviderId;
  catalogueStatus: ClarityCloudCatalogueStatus;
  playerId: string;
  lessonId?: string;
  analysisId: string;
  status: TransferStatus;
  expectedSizeBytes: number;
  checksumSha256: string;
  acceptedOffsetBytes: number;
  chunkSizeBytes: number;
  driveAssetFolderId: string;
  driveVideoFileId?: string;
  driveManifestFileId?: string;
  driveAnalysisFileId?: string;
  resumableSessionUrl: string;
  resumableSessionCreatedAt: string;
  resumableSessionExpiresAt?: string;
  sourceDeviceId?: string;
  readyToImportAt?: string;
  destinationDeviceId?: string;
  destinationDeviceName?: string;
  destinationPlatform?: string;
  importedAt?: string;
  importVerifiedAt?: string;
  cleanupScheduledAt?: string;
  cleanupAfter?: string;
  cleanupStatus?: "not_scheduled" | "scheduled" | "complete" | "failed";
  importReceiptJson?: string;
  providerFolderLink?: string;
  createdAt: string;
  updatedAt: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
};

class TransferError extends Error {
  constructor(
    public readonly code: TransferErrorCode,
    message: string,
    public readonly status = 400,
    public readonly options: {
      phase?: TransferPhase;
      retryable?: boolean;
      diagnostics?: ProviderDiagnostics;
    } = {}
  ) {
    super(message);
    this.name = "TransferError";
  }
}

function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function assertClarityCloudServerConfigured(req: Request) {
  const googleConfig = getClarityCloudGoogleConfig(req);
  if (!googleConfig.configured) {
    throw new TransferError(
      "CLOUD_OAUTH_NOT_CONFIGURED",
      "Clarity Cloud is not configured for this environment.",
      503
    );
  }
  if (!isClarityCloudProviderTokenEncryptionConfigured()) {
    throw new TransferError(
      "PROVIDER_STORAGE_UNAVAILABLE",
      "Secure provider storage is unavailable.",
      503
    );
  }
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

function errorJson(
  code: TransferErrorCode | string,
  message: string,
  status = 400,
  options: { phase?: TransferPhase; retryable?: boolean; session?: unknown } = {}
) {
  return json({
    ok: false,
    ...(options.phase ? { status: "failed", phase: options.phase } : {}),
    ...(typeof options.retryable === "boolean" ? { retryable: options.retryable } : {}),
    error: {
      code,
      message,
    },
    code,
    message,
    ...(options.session ? { session: options.session } : {}),
  }, status);
}

function cleanString(value: unknown, fallback = "", max = 1200) {
  return typeof value === "string" ? value.trim().slice(0, max) || fallback : fallback;
}

function redactForLogs(value: unknown, max = 300) {
  return cleanString(value, "", max)
    .replace(/https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?[^"'\s)]+/gi, "[redacted-google-upload-url]")
    .replace(/(authorization|cookie|token|refresh_token|access_token|client_secret|secret|api[_-]?key)\s*[:=]\s*["']?[^"',\s)]+/gi, "$1=[redacted]");
}

function safeGoogleReason(data: any, fallback = "") {
  return cleanString(
    data?.error?.errors?.[0]?.reason ||
      data?.error?.status ||
      data?.error?.reason ||
      data?.error ||
      fallback,
    fallback,
    160
  );
}

async function readGoogleError(response: Response) {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text().catch(() => "");
  let data: any = {};
  if (contentType.toLowerCase().includes("application/json")) {
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
  }
  const reason = safeGoogleReason(data, contentType ? "google_error" : "empty_google_response");
  const message = redactForLogs(data?.error?.message || data?.error_description || text || response.statusText || "Google Drive request failed.");
  return { contentType, data, reason, message };
}

function statusForGoogleProviderFailure(responseStatus: number, reason: string, fallbackStatus = 502) {
  if (responseStatus === 401) return 403;
  if (responseStatus === 403 && /auth|permission|scope|insufficientPermissions/i.test(reason)) return 403;
  return fallbackStatus;
}

function codeForGoogleProviderFailure(
  fallbackCode: TransferErrorCode,
  responseStatus: number,
  reason: string
): TransferErrorCode {
  if (responseStatus === 401 || /authError|invalidCredentials/i.test(reason)) return "GOOGLE_RECONNECT_REQUIRED";
  if (responseStatus === 403 && /insufficientPermissions|forbidden|scope/i.test(reason)) return "DRIVE_SCOPE_MISSING";
  return fallbackCode;
}

function providerErrorOptions(
  diagnostics: ProviderDiagnostics,
  phase: TransferPhase = "preparing"
) {
  return {
    phase,
    retryable: true,
    diagnostics,
  };
}

function logProviderFailure(route: string, error: any, trace: ProviderDiagnostics = {}) {
  const diagnostics: ProviderDiagnostics = {
    ...trace,
    ...(error instanceof TransferError ? error.options.diagnostics || {} : {}),
  };
  console.error("video_transfer:failed", route || "root", {
    code: error?.code || "CLARITY_CLOUD_PROVIDER_FAILED",
    message: redactForLogs(error?.message || error),
    step: diagnostics.step || "unknown",
    endpointClass: diagnostics.endpointClass || "unknown",
    googleStatus: diagnostics.googleStatus,
    googleReason: diagnostics.googleReason,
    accessTokenRefreshed: diagnostics.accessTokenRefreshed === true,
    rootFolderReady: diagnostics.rootFolderReady === true,
    transferFolderReady: diagnostics.transferFolderReady === true,
    inboxFolderReady: diagnostics.inboxFolderReady === true,
    assetFolderReady: diagnostics.assetFolderReady === true,
    resumableSessionReturned: diagnostics.resumableSessionReturned === true,
    afterResumableSession: diagnostics.afterResumableSession === true,
  });
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

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
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

async function readJson(req: Request) {
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new TransferError("DRIVE_FINALIZE_FAILED", "Expected a JSON request body.", 415);
  }
  return req.json();
}

function safeFileName(name: unknown, fallback: string) {
  return cleanString(name, fallback, 180).replace(/[\\/:*?"<>|]+/g, "-") || fallback;
}

function extensionFor(fileName: string, mimeType: string) {
  const match = fileName.match(/\.([a-z0-9]{2,8})$/i);
  if (match) return match[1].toLowerCase();
  if (mimeType === "video/quicktime") return "mov";
  if (mimeType === "video/webm") return "webm";
  if (mimeType === "video/mp4") return "mp4";
  return "bin";
}

function appProperties(accountId: string, savedVideo: SafeSavedVideo, clarityType: string) {
  return {
    clarityType,
    claritySavedVideoId: savedVideo.savedVideoId,
    clarityPlayerId: savedVideo.playerId,
    clarityAccountId: accountId,
    clarityVersion,
  };
}

export function publicTransferSession(session: VideoTransferSession) {
  const phase: TransferPhase =
    session.status === "ready"
      ? "ready"
      : session.status === "verifying"
        ? "verifying"
        : session.status === "uploading" || session.status === "paused"
          ? "uploading"
          : session.status === "session-created"
            ? "session-created"
            : "preparing";
  return {
    version: session.version,
    transferId: session.transferId,
    savedVideoId: session.savedVideoId,
    provider: session.providerId,
    providerId: session.providerId,
    providerLabel: session.providerId === "google-drive" ? "Google Drive" : "Provider",
    catalogueStatus: session.catalogueStatus,
    transferState: session.catalogueStatus,
    playerId: session.playerId,
    lessonId: session.lessonId,
    analysisId: session.analysisId,
    status: session.status,
    expectedSizeBytes: session.expectedSizeBytes,
    checksumSha256: session.checksumSha256,
    acceptedOffsetBytes: session.acceptedOffsetBytes,
    chunkSizeBytes: session.chunkSizeBytes,
    driveAssetFolderId: session.driveAssetFolderId,
    driveVideoFileId: session.driveVideoFileId,
    driveManifestFileId: session.driveManifestFileId,
    driveAnalysisFileId: session.driveAnalysisFileId,
    resumableSessionCreatedAt: session.resumableSessionCreatedAt,
    resumableSessionExpiresAt: session.resumableSessionExpiresAt,
    sourceDeviceId: session.sourceDeviceId,
    readyToImportAt: session.readyToImportAt,
    destinationDeviceId: session.destinationDeviceId,
    destinationDeviceName: session.destinationDeviceName,
    destinationPlatform: session.destinationPlatform,
    importedAt: session.importedAt,
    importVerifiedAt: session.importVerifiedAt,
    cleanupScheduledAt: session.cleanupScheduledAt,
    cleanupAfter: session.cleanupAfter,
    cleanupStatus: session.cleanupStatus,
    providerFolderLink: session.providerFolderLink,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastErrorCode: session.lastErrorCode,
    lastErrorMessage: session.lastErrorMessage,
    phase,
    retryable: ["failed", "expired", "cancelled"].includes(session.status),
  };
}

export function validateChunkRequest(
  session: Pick<VideoTransferSession, "accountId" | "savedVideoId" | "status" | "acceptedOffsetBytes" | "expectedSizeBytes" | "chunkSizeBytes">,
  args: { accountId: string; savedVideoId: string; transferId?: string; startByte: number; endByte: number; totalSize: number; chunkLength: number }
) {
  if (session.accountId !== args.accountId || session.savedVideoId !== args.savedVideoId) {
    throw new TransferError("DRIVE_UPLOAD_VERIFY_FAILED", "Saved video ownership metadata did not match the transfer session.", 403);
  }
  if (session.status === "paused") throw new TransferError("TRANSFER_PAUSED", "Transfer is paused.", 409);
  if (session.status === "cancelled") throw new TransferError("TRANSFER_CANCELLED", "Transfer was cancelled.", 409);
  if (!["preparing", "session-created", "uploading"].includes(session.status)) {
    throw new TransferError("DRIVE_UPLOAD_SESSION_EXPIRED", "Start or resume an upload session before sending chunks.", 409);
  }
  if (args.startByte !== session.acceptedOffsetBytes) {
    throw new TransferError("DRIVE_UPLOAD_VERIFY_FAILED", "Chunk start did not match the accepted transfer offset.", 409);
  }
  if (args.totalSize !== session.expectedSizeBytes) {
    throw new TransferError("DRIVE_UPLOAD_VERIFY_FAILED", "Chunk total size did not match the saved source.", 409);
  }
  if (args.chunkLength <= 0 || args.chunkLength > maxChunkSizeBytes || args.chunkLength > session.chunkSizeBytes) {
    throw new TransferError("DRIVE_UPLOAD_TOO_LARGE", "Chunk size exceeds the configured transfer limit.", 413);
  }
  if (args.endByte < args.startByte || args.endByte - args.startByte + 1 !== args.chunkLength) {
    throw new TransferError("DRIVE_UPLOAD_VERIFY_FAILED", "Chunk byte range did not match the request body.", 409);
  }
  if (args.endByte >= session.expectedSizeBytes) {
    throw new TransferError("DRIVE_UPLOAD_VERIFY_FAILED", "Chunk byte range exceeded the saved source size.", 409);
  }
  return true;
}

function validateSavedVideo(candidate: any, savedVideoIdFromPath?: string): SafeSavedVideo {
  const savedVideoId = cleanString(candidate?.savedVideoId, "", 160);
  const playerId = cleanString(candidate?.playerId, "", 160);
  const analysisId = cleanString(candidate?.analysisId, "", 160);
  if (!savedVideoId || !playerId || !analysisId) {
    throw new TransferError("DRIVE_UPLOAD_VERIFY_FAILED", "Saved video ownership metadata is required.", 400);
  }
  if (savedVideoIdFromPath && savedVideoId !== savedVideoIdFromPath) {
    throw new TransferError("DRIVE_UPLOAD_VERIFY_FAILED", "Saved video id does not match the route.", 400);
  }
  return {
    savedVideoId,
    playerId,
    lessonId: cleanString(candidate?.lessonId, "", 160) || undefined,
    analysisId,
    title: cleanString(candidate?.title, "Saved video", 240),
    createdAt: cleanString(candidate?.createdAt, new Date().toISOString(), 80),
    updatedAt: cleanString(candidate?.updatedAt, new Date().toISOString(), 80),
    source: candidate?.source || {},
  };
}

function validateVideoMetadata(candidate: any): UploadVideoMetadata {
  const sizeBytes = Number(candidate?.sizeBytes);
  const checksumSha256 = cleanString(candidate?.checksumSha256, "", 128);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new TransferError("SAVED_VIDEO_BLOB_MISSING", "Saved video blob size is required.", 400);
  }
  if (!/^[a-f0-9]{64}$/i.test(checksumSha256)) {
    throw new TransferError("DRIVE_UPLOAD_VERIFY_FAILED", "Saved video checksum is required.", 400);
  }
  return {
    fileName: safeFileName(candidate?.fileName, "video.mp4"),
    mimeType: cleanString(candidate?.mimeType, "application/octet-stream", 180),
    sizeBytes,
    checksumSha256: checksumSha256.toLowerCase(),
    driveFileId: cleanString(candidate?.driveFileId, "", 180) || undefined,
  };
}

function removeDataUrls(value: unknown): unknown {
  if (typeof value === "string") return value.startsWith("data:") ? undefined : value;
  if (Array.isArray(value)) return value.map(removeDataUrls).filter((entry) => entry !== undefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, removeDataUrls(entry)] as const)
      .filter(([, entry]) => entry !== undefined),
  );
}

export function validateUploadSessionPayload(body: any, savedVideoIdFromPath?: string) {
  const savedVideo = validateSavedVideo(body?.savedVideo || body, savedVideoIdFromPath);
  const video = validateVideoMetadata(body?.video);
  return { savedVideo, video };
}

export function validateFinalizePayload(body: any, savedVideoIdFromPath: string) {
  const savedVideo = validateSavedVideo(body?.savedVideo || body, savedVideoIdFromPath);
  const video = validateVideoMetadata(body?.video);
  const analysisJson = removeDataUrls(body?.analysisJson || {}) as Record<string, unknown>;
  return { savedVideo, video, analysisJson };
}

async function ensureDriveReady(accountId: string, diagnostics: ProviderDiagnostics = {}) {
  diagnostics.step = "provider-token-load";
  const connection = await loadGoogleProviderConnection(accountId);
  if (!connection?.driveEnabled) {
    throw new TransferError(
      "DRIVE_NOT_CONNECTED",
      "Connect Clarity Cloud before sending saved videos.",
      403,
      providerErrorOptions({
        ...diagnostics,
        endpointClass: "provider-token-store",
        accessTokenRefreshed: false,
      })
    );
  }
  if (connection.connectionStatus === "reconnect_required") {
    throw new TransferError(
      "GOOGLE_RECONNECT_REQUIRED",
      "Reconnect Clarity Cloud to continue.",
      403,
      providerErrorOptions({
        ...diagnostics,
        endpointClass: "provider-token-store",
        accessTokenRefreshed: false,
      })
    );
  }
  if (!hasGoogleScopes(connection, [googleDriveFileScope])) {
    throw new TransferError(
      "DRIVE_SCOPE_MISSING",
      "Grant Clarity Cloud permission before sending saved videos.",
      403,
      providerErrorOptions({
        ...diagnostics,
        endpointClass: "provider-token-store",
        accessTokenRefreshed: false,
      })
    );
  }
  diagnostics.step = "provider-token-refresh";
  diagnostics.endpointClass = "oauth-token";
  try {
    const accessToken = await getGoogleAccessToken(accountId, [googleDriveFileScope]);
    diagnostics.accessTokenRefreshed = true;
    return accessToken;
  } catch (error: any) {
    diagnostics.accessTokenRefreshed = false;
    const code: TransferErrorCode =
      error?.code === "GOOGLE_RECONNECT_REQUIRED" || error?.code === "GOOGLE_TOKEN_DECRYPT_FAILED"
        ? "GOOGLE_RECONNECT_REQUIRED"
        : error?.code === "GOOGLE_SCOPE_MISSING"
          ? "DRIVE_SCOPE_MISSING"
          : error?.code === "GOOGLE_TOKEN_ENCRYPTION_KEY_MISSING" || error?.code === "GOOGLE_TOKEN_ENCRYPTION_KEY_INVALID"
            ? "PROVIDER_STORAGE_UNAVAILABLE"
            : "GOOGLE_TOKEN_REFRESH_FAILED";
    throw new TransferError(
      code,
      code === "GOOGLE_RECONNECT_REQUIRED"
        ? "Reconnect Clarity Cloud to continue."
        : code === "DRIVE_SCOPE_MISSING"
          ? "Grant Clarity Cloud permission before sending saved videos."
          : code === "PROVIDER_STORAGE_UNAVAILABLE"
            ? "Secure provider storage is unavailable."
            : "Clarity Cloud could not refresh the Google connection.",
      code === "PROVIDER_STORAGE_UNAVAILABLE" ? 503 : code === "GOOGLE_TOKEN_REFRESH_FAILED" ? 502 : 403,
      providerErrorOptions({
        ...diagnostics,
        googleStatus: Number(error?.status) || undefined,
        googleReason: cleanString(error?.code, "token_refresh_failed", 160),
      })
    );
  }
}

async function googleJson<T>(
  accessToken: string,
  url: string,
  init: RequestInit = {},
  errorCode: TransferErrorCode,
  diagnostics: ProviderDiagnostics = {}
): Promise<T> {
  const endpointClass = diagnostics.endpointClass || "drive-json";
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...(init.headers || {}),
      },
    });
  } catch (error: any) {
    throw new TransferError(
      errorCode,
      "Google Drive could not be reached.",
      502,
      providerErrorOptions({
        ...diagnostics,
        endpointClass,
        googleReason: "fetch_failed",
      })
    );
  }
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new TransferError(
      errorCode,
      "Google Drive returned an unexpected non-JSON response.",
      502,
      providerErrorOptions({
        ...diagnostics,
        endpointClass,
        googleStatus: response.status,
        googleReason: contentType ? "non_json_response" : "empty_content_type",
      })
    );
  }
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new TransferError(
      errorCode,
      "Google Drive returned invalid JSON.",
      502,
      providerErrorOptions({
        ...diagnostics,
        endpointClass,
        googleStatus: response.status,
        googleReason: "invalid_json_response",
      })
    );
  }
  if (!response.ok) {
    const reason = safeGoogleReason(data, "google_error");
    const code = codeForGoogleProviderFailure(errorCode, response.status, reason);
    throw new TransferError(
      code,
      code === "GOOGLE_RECONNECT_REQUIRED"
        ? "Reconnect Clarity Cloud to continue."
        : code === "DRIVE_SCOPE_MISSING"
          ? "Grant Clarity Cloud permission before sending saved videos."
          : "Google Drive request failed.",
      statusForGoogleProviderFailure(response.status, reason),
      providerErrorOptions({
        ...diagnostics,
        endpointClass,
        googleStatus: response.status,
        googleReason: reason,
      })
    );
  }
  return data as T;
}

function driveQueryForAppProperties(props: Record<string, string>, parentId?: string) {
  const propertyTerms = Object.entries(props).map(
    ([key, value]) => `appProperties has { key='${key.replaceAll("'", "\\'")}' and value='${value.replaceAll("'", "\\'")}' }`
  );
  return [
    "trashed = false",
    parentId ? `'${parentId}' in parents` : "",
    ...propertyTerms,
  ].filter(Boolean).join(" and ");
}

async function findDriveFile(accessToken: string, props: Record<string, string>, parentId?: string, diagnostics: ProviderDiagnostics = {}) {
  const query = driveQueryForAppProperties(props, parentId);
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q", query);
  url.searchParams.set("spaces", "drive");
  url.searchParams.set("fields", "files(id,name,mimeType,size,md5Checksum,parents,appProperties,webViewLink)");
  url.searchParams.set("pageSize", "1");
  const data = await googleJson<{ files?: DriveFile[] }>(
    accessToken,
    url.toString(),
    {},
    "DRIVE_TRANSFER_FOLDER_FAILED",
    {
      ...diagnostics,
      endpointClass: "drive-files-list",
    }
  );
  return data.files?.[0] || null;
}

async function getDriveFile(accessToken: string, fileId: string, diagnostics: ProviderDiagnostics = {}) {
  return googleJson<DriveFile>(
    accessToken,
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,md5Checksum,parents,appProperties,webViewLink`,
    {},
    "DRIVE_TRANSFER_FOLDER_FAILED",
    {
      ...diagnostics,
      endpointClass: "drive-files-metadata",
    }
  );
}

async function createDriveFile(accessToken: string, metadata: Record<string, unknown>, diagnostics: ProviderDiagnostics = {}) {
  return googleJson<DriveFile>(
    accessToken,
    "https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,size,parents,appProperties,webViewLink",
    {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(metadata),
    },
    "DRIVE_TRANSFER_FOLDER_FAILED",
    {
      ...diagnostics,
      endpointClass: "drive-files-create",
    }
  );
}

async function ensureFolder(accessToken: string, name: string, props: Record<string, string>, parentId?: string, diagnostics: ProviderDiagnostics = {}) {
  const existing = await findDriveFile(accessToken, props, parentId, diagnostics);
  if (existing) return existing;
  return createDriveFile(accessToken, {
    name,
    mimeType: "application/vnd.google-apps.folder",
    ...(parentId ? { parents: [parentId] } : {}),
    appProperties: props,
  }, diagnostics);
}

function matchesAppProperties(file: DriveFile | null, props: Record<string, string>) {
  if (!file || file.mimeType !== "application/vnd.google-apps.folder") return false;
  return Object.entries(props).every(([key, value]) => file.appProperties?.[key] === value);
}

async function loadStoredRootFolder(accessToken: string, folderId: string, props: Record<string, string>, diagnostics: ProviderDiagnostics) {
  if (!folderId) return null;
  try {
    const folder = await getDriveFile(accessToken, folderId, {
      ...diagnostics,
      step: "drive-root-folder-verify",
    });
    return matchesAppProperties(folder, props) ? folder : null;
  } catch (error: any) {
    const googleStatus = error instanceof TransferError ? error.options.diagnostics?.googleStatus : undefined;
    if (googleStatus === 404 || googleStatus === 403) return null;
    throw error;
  }
}

export async function ensureTransferFolders(
  accessToken: string,
  accountId: string,
  settings: Record<string, string>,
  diagnostics: ProviderDiagnostics = {}
) {
  const rootProps = {
    clarityType: "root-folder",
    clarityAccountId: accountId,
    clarityVersion,
  };
  const storedRoot = await loadStoredRootFolder(accessToken, settings.googleDriveRootFolderId || "", rootProps, diagnostics);
  const root = storedRoot || await ensureFolder(accessToken, "Clarity Golf", rootProps, undefined, {
    ...diagnostics,
    step: "drive-root-folder-provision",
  });
  diagnostics.rootFolderReady = true;
  const transfer = await ensureFolder(accessToken, "Video Transfer", {
    clarityType: "video-transfer-folder",
    clarityAccountId: accountId,
    clarityVersion,
  }, root.id, {
    ...diagnostics,
    step: "drive-transfer-folder-provision",
  });
  diagnostics.transferFolderReady = true;
  const inbox = await ensureFolder(accessToken, "Inbox", {
    clarityType: "video-transfer-inbox",
    clarityAccountId: accountId,
    clarityVersion,
  }, transfer.id, {
    ...diagnostics,
    step: "drive-inbox-folder-provision",
  });
  diagnostics.inboxFolderReady = true;
  const imported = await ensureFolder(accessToken, "Imported", {
    clarityType: "video-transfer-imported",
    clarityAccountId: accountId,
    clarityVersion,
  }, transfer.id, {
    ...diagnostics,
    step: "drive-imported-folder-provision",
  });
  const failed = await ensureFolder(accessToken, "Failed", {
    clarityType: "video-transfer-failed",
    clarityAccountId: accountId,
    clarityVersion,
  }, transfer.id, {
    ...diagnostics,
    step: "drive-failed-folder-provision",
  });
  if (
    root.id !== settings.googleDriveRootFolderId ||
    inbox.id !== settings.googleDriveInboxFolderId ||
    imported.id !== settings.googleDriveImportedFolderId ||
    failed.id !== settings.googleDriveFailedFolderId
  ) {
    await setSettings({
      googleDriveRootFolderId: root.id,
      googleDriveTransferFolderId: transfer.id,
      googleDriveInboxFolderId: inbox.id,
      googleDriveImportedFolderId: imported.id,
      googleDriveFailedFolderId: failed.id,
    });
  }
  return { root, transfer, inbox, imported, failed };
}

async function ensureAssetFolder(
  accessToken: string,
  accountId: string,
  savedVideo: SafeSavedVideo,
  inboxFolderId: string,
  diagnostics: ProviderDiagnostics = {}
) {
  const folder = await ensureFolder(
    accessToken,
    savedVideo.savedVideoId,
    appProperties(accountId, savedVideo, "video-transfer-asset-folder"),
    inboxFolderId,
    {
      ...diagnostics,
      step: "drive-asset-folder-provision",
    }
  );
  diagnostics.assetFolderReady = true;
  return folder;
}

async function uploadJsonFile(
  accessToken: string,
  folderId: string,
  name: string,
  props: Record<string, string>,
  payload: unknown,
  diagnostics: ProviderDiagnostics = {}
) {
  const boundary = `clarity_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=utf-8",
    "",
    JSON.stringify({ name, parents: [folderId], mimeType: "application/json", appProperties: props }),
    `--${boundary}`,
    "Content-Type: application/json; charset=utf-8",
    "",
    JSON.stringify(payload, null, 2),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return googleJson<DriveFile>(
    accessToken,
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,appProperties",
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    },
    "DRIVE_FINALIZE_FAILED",
    {
      ...diagnostics,
      endpointClass: "drive-upload-multipart",
    }
  );
}

async function startResumableUpload(
  accessToken: string,
  accountId: string,
  savedVideo: SafeSavedVideo,
  folderId: string,
  video: UploadVideoMetadata,
  diagnostics: ProviderDiagnostics = {}
) {
  const extension = extensionFor(video.fileName, video.mimeType);
  const endpointClass = "drive-upload-resumable";
  let response: Response;
  try {
    response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,md5Checksum,appProperties", {
      method: "POST",
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=utf-8",
        "X-Upload-Content-Type": video.mimeType,
        "X-Upload-Content-Length": String(video.sizeBytes),
      },
      body: JSON.stringify({
        name: `video.${extension}`,
        parents: [folderId],
        mimeType: video.mimeType,
        appProperties: appProperties(accountId, savedVideo, "video"),
      }),
    });
  } catch {
    throw new TransferError(
      "DRIVE_UPLOAD_SESSION_FAILED",
      "Clarity Cloud could not start the video upload.",
      502,
      providerErrorOptions({
        ...diagnostics,
        step: "drive-resumable-session-create",
        endpointClass,
        googleReason: "fetch_failed",
        resumableSessionReturned: false,
        afterResumableSession: false,
      })
    );
  }
  if (!response.ok) {
    const googleError = await readGoogleError(response);
    const code = codeForGoogleProviderFailure("DRIVE_UPLOAD_SESSION_FAILED", response.status, googleError.reason);
    throw new TransferError(
      code,
      code === "GOOGLE_RECONNECT_REQUIRED"
        ? "Reconnect Clarity Cloud to continue."
        : code === "DRIVE_SCOPE_MISSING"
          ? "Grant Clarity Cloud permission before sending saved videos."
          : "Clarity Cloud could not start the video upload.",
      statusForGoogleProviderFailure(response.status, googleError.reason),
      providerErrorOptions({
        ...diagnostics,
        step: "drive-resumable-session-create",
        endpointClass,
        googleStatus: response.status,
        googleReason: googleError.reason,
        resumableSessionReturned: false,
        afterResumableSession: false,
      })
    );
  }
  const uploadUrl = response.headers.get("location") || "";
  if (!uploadUrl) {
    throw new TransferError(
      "DRIVE_UPLOAD_SESSION_FAILED",
      "Clarity Cloud could not start the video upload.",
      502,
      providerErrorOptions({
        ...diagnostics,
        step: "drive-resumable-session-create",
        endpointClass,
        googleStatus: response.status,
        googleReason: "missing_location_header",
        resumableSessionReturned: false,
        afterResumableSession: false,
      })
    );
  }
  diagnostics.resumableSessionReturned = true;
  diagnostics.afterResumableSession = true;
  const id = new URL(uploadUrl).searchParams.get("id") || "";
  return { uploadUrl, videoFileId: id };
}

async function uploadedFile(accessToken: string, fileId: string) {
  return googleJson<DriveFile>(
    accessToken,
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,size,md5Checksum,parents,appProperties`,
    {},
    "DRIVE_UPLOAD_VERIFY_FAILED",
    {
      step: "drive-uploaded-file-verify",
      endpointClass: "drive-files-metadata",
    }
  );
}

function googleDriveProviderAdapter(
  accessToken: string,
  settings: Record<string, string>,
  diagnostics: ProviderDiagnostics = {}
): ClarityCloudProviderAdapter {
  return {
    id: "google-drive",
    displayName: "Google Drive",

    async getConnectionHealth(accountId) {
      const connection = await loadGoogleProviderConnection(accountId);
      if (!connection?.driveEnabled) {
        return { connected: false, state: "not_connected", message: "Connect Clarity Cloud before transferring saved videos." };
      }
      if (connection.connectionStatus === "reconnect_required") {
        return { connected: false, state: "reconnect_required", message: "Reconnect Google before transferring saved videos." };
      }
      if (!hasGoogleScopes(connection, [googleDriveFileScope])) {
        return { connected: false, state: "permission_required", message: "Grant Clarity Cloud provider permission before transferring saved videos." };
      }
      return { connected: true, state: "connected", message: "Provider ready." };
    },

    ensureTransferStorage(accountId) {
      return ensureTransferFolders(accessToken, accountId, settings, diagnostics);
    },

    async createUploadSession(context) {
      const assetFolder = await ensureAssetFolder(
        accessToken,
        context.accountId,
        context.savedVideo,
        context.storage.inbox.id,
        diagnostics
      );
      const uploadSession = await startResumableUpload(
        accessToken,
        context.accountId,
        context.savedVideo,
        assetFolder.id,
        context.video,
        diagnostics
      );
      const folderLink = await this.getTransferFolderLink?.({ folderId: assetFolder.id });
      return {
        assetFolderId: assetFolder.id,
        videoFileId: uploadSession.videoFileId,
        resumableSessionUrl: uploadSession.uploadUrl,
        folderLink,
      };
    },

    async uploadChunk(context) {
      const body = context.bytes.buffer.slice(
        context.bytes.byteOffset,
        context.bytes.byteOffset + context.bytes.byteLength
      ) as ArrayBuffer;
      const response = await fetch(context.sessionUrl, {
        method: "PUT",
        headers: {
          "Content-Type": context.contentType,
          "Content-Length": String(context.bytes.byteLength),
          "Content-Range": `bytes ${context.startByte}-${context.endByte}/${context.totalSize}`,
        },
        body,
      });

      if (response.status === 308) {
        return {
          status: "uploading",
          acceptedOffsetBytes: acceptedOffsetFromGoogle(response, context.endByte + 1),
          responseStatus: response.status,
        };
      }

      if (response.status === 200 || response.status === 201) {
        const data = await response.json().catch(() => ({})) as DriveFile;
        return {
          status: "verifying",
          acceptedOffsetBytes: context.totalSize,
          videoFileId: data.id,
          responseStatus: response.status,
        };
      }

      if (response.status === 401 || response.status === 403) {
        return {
          status: "auth_failed",
          acceptedOffsetBytes: context.startByte,
          responseStatus: response.status,
        };
      }

      if (response.status === 404 || response.status === 410) {
        return {
          status: "expired",
          acceptedOffsetBytes: context.startByte,
          responseStatus: response.status,
        };
      }

      if (response.status === 429 || response.status >= 500) {
        return {
          status: "interrupted",
          acceptedOffsetBytes: context.startByte,
          responseStatus: response.status,
        };
      }

      return {
        status: "failed",
        acceptedOffsetBytes: context.startByte,
        responseStatus: response.status || 502,
      };
    },

    async finalizeUpload(context) {
      const file = await uploadedFile(accessToken, context.video.driveFileId || context.session.driveVideoFileId || "");
      if (Number(file.size || 0) !== context.video.sizeBytes || Number(file.size || 0) !== context.session.expectedSizeBytes) {
        throw new TransferError("DRIVE_UPLOAD_VERIFY_FAILED", "Uploaded provider video size did not match the saved source.", 409);
      }
      if (file.appProperties?.claritySavedVideoId !== context.savedVideo.savedVideoId || file.appProperties?.clarityAccountId !== context.accountId) {
        throw new TransferError("DRIVE_UPLOAD_VERIFY_FAILED", "Uploaded provider file ownership metadata did not match.", 409);
      }
      const assetFolderId = file.parents?.[0] || context.session.driveAssetFolderId;
      const analysis = await uploadJsonFile(
        accessToken,
        assetFolderId,
        "analysis.json",
        appProperties(context.accountId, context.savedVideo, "analysis"),
        context.analysisJson
      );
      const manifestPayload = transferManifest({
        accountId: context.accountId,
        savedVideo: context.savedVideo,
        video: context.video,
        assetFolderId,
        videoFileId: file.id,
        analysisFileId: analysis.id,
        sourceDeviceId: context.session.sourceDeviceId,
        status: "ready_to_import",
        providerId: this.id,
      });
      const manifest = await uploadJsonFile(
        accessToken,
        assetFolderId,
        "manifest.json",
        appProperties(context.accountId, context.savedVideo, "manifest"),
        { ...manifestPayload, manifestFileId: undefined }
      );
      return {
        assetFolderId,
        videoFileId: file.id,
        analysisFileId: analysis.id,
        manifestFileId: manifest.id,
        manifest: manifestPayload,
      };
    },

    async readJsonFile(context) {
      const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(context.fileId)}?alt=media`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      });
      const text = await response.text();
      if (!response.ok) {
        throw new TransferError("CLARITY_CLOUD_PROVIDER_FAILED", "Clarity Cloud provider file could not be read.", response.status);
      }
      return text ? JSON.parse(text) : {};
    },

    async readFileRange(context) {
      const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(context.fileId)}?alt=media`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(context.range ? { Range: context.range } : {}),
        },
      });
      if (!response.ok && response.status !== 206) {
        throw new TransferError("CLARITY_CLOUD_PROVIDER_FAILED", "Clarity Cloud provider bytes could not be read.", response.status);
      }
      return response;
    },

    getFileMetadata(context) {
      return uploadedFile(accessToken, context.fileId);
    },

    async deleteTransferAsset(context) {
      await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(context.assetFolderId)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    },

    async getTransferFolderLink(context) {
      try {
        const metadata = await googleJson<DriveFile>(
          accessToken,
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(context.folderId)}?fields=webViewLink`,
          {},
          "CLARITY_CLOUD_PROVIDER_FAILED",
          {
            ...diagnostics,
            step: "drive-transfer-folder-link",
            endpointClass: "drive-files-metadata",
          }
        );
        return metadata.webViewLink || null;
      } catch {
        return null;
      }
    },
  };
}

function rowToSession(row: any): VideoTransferSession {
  return {
    version: 1,
    transferId: row.transfer_id,
    savedVideoId: row.saved_video_id,
    accountId: row.account_id,
    providerId: row.provider_id || "google-drive",
    catalogueStatus: row.catalogue_status || (row.status === "ready" ? "ready_to_import" : row.status === "failed" ? "failed" : row.status === "cancelled" ? "cancelled" : row.status === "expired" ? "expired" : "uploading"),
    playerId: row.player_id,
    lessonId: row.lesson_id || undefined,
    analysisId: row.analysis_id,
    status: row.status,
    expectedSizeBytes: Number(row.expected_size_bytes || 0),
    checksumSha256: row.checksum_sha256,
    acceptedOffsetBytes: Number(row.accepted_offset_bytes || 0),
    chunkSizeBytes: Number(row.chunk_size_bytes || defaultChunkSizeBytes),
    driveAssetFolderId: row.drive_asset_folder_id,
    driveVideoFileId: row.drive_video_file_id || undefined,
    driveManifestFileId: row.drive_manifest_file_id || undefined,
    driveAnalysisFileId: row.drive_analysis_file_id || undefined,
    resumableSessionUrl: row.resumable_session_url,
    resumableSessionCreatedAt: row.resumable_session_created_at,
    resumableSessionExpiresAt: row.resumable_session_expires_at || undefined,
    sourceDeviceId: row.source_device_id || undefined,
    readyToImportAt: row.ready_to_import_at || undefined,
    destinationDeviceId: row.destination_device_id || undefined,
    destinationDeviceName: row.destination_device_name || undefined,
    destinationPlatform: row.destination_platform || undefined,
    importedAt: row.imported_at || undefined,
    importVerifiedAt: row.import_verified_at || undefined,
    cleanupScheduledAt: row.cleanup_scheduled_at || undefined,
    cleanupAfter: row.cleanup_after || undefined,
    cleanupStatus: row.cleanup_status || "not_scheduled",
    importReceiptJson: row.import_receipt_json || "{}",
    providerFolderLink: row.provider_folder_link || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastErrorCode: row.last_error_code || undefined,
    lastErrorMessage: row.last_error_message || undefined,
  };
}

function sessionToRow(session: VideoTransferSession) {
  return {
    transfer_id: session.transferId,
    saved_video_id: session.savedVideoId,
    account_id: session.accountId,
    provider_id: session.providerId || "google-drive",
    catalogue_status: session.catalogueStatus || "uploading",
    player_id: session.playerId,
    lesson_id: session.lessonId || null,
    analysis_id: session.analysisId,
    status: session.status,
    expected_size_bytes: session.expectedSizeBytes,
    checksum_sha256: session.checksumSha256,
    accepted_offset_bytes: session.acceptedOffsetBytes,
    chunk_size_bytes: session.chunkSizeBytes,
    drive_asset_folder_id: session.driveAssetFolderId,
    drive_video_file_id: session.driveVideoFileId || null,
    drive_manifest_file_id: session.driveManifestFileId || null,
    drive_analysis_file_id: session.driveAnalysisFileId || null,
    resumable_session_url: session.resumableSessionUrl,
    resumable_session_created_at: session.resumableSessionCreatedAt,
    resumable_session_expires_at: session.resumableSessionExpiresAt || null,
    source_device_id: session.sourceDeviceId || null,
    ready_to_import_at: session.readyToImportAt || null,
    destination_device_id: session.destinationDeviceId || null,
    destination_device_name: session.destinationDeviceName || null,
    destination_platform: session.destinationPlatform || null,
    imported_at: session.importedAt || null,
    import_verified_at: session.importVerifiedAt || null,
    cleanup_scheduled_at: session.cleanupScheduledAt || null,
    cleanup_after: session.cleanupAfter || null,
    cleanup_status: session.cleanupStatus || "not_scheduled",
    import_receipt_json: session.importReceiptJson || "{}",
    provider_folder_link: session.providerFolderLink || null,
    last_error_code: session.lastErrorCode || null,
    last_error_message: session.lastErrorMessage || null,
  };
}

async function readTransferSession(accountId: string, savedVideoId: string) {
  const rows = await supabase(transferSessionTable, {
    query: `select=*&account_id=eq.${encodeURIComponent(accountId)}&saved_video_id=eq.${encodeURIComponent(savedVideoId)}&status=in.(preparing,session-created,uploading,paused,verifying,ready,failed)&order=created_at.desc&limit=1`,
  });
  return rows[0] ? rowToSession(rows[0]) : null;
}

async function saveTransferSession(session: VideoTransferSession) {
  const rows = await supabase(transferSessionTable, {
    method: "POST",
    query: "on_conflict=transfer_id&select=*",
    prefer: "resolution=merge-duplicates,return=representation",
    body: sessionToRow({ ...session, updatedAt: new Date().toISOString() }),
  });
  return rowToSession(rows[0]);
}

async function patchTransferSession(session: VideoTransferSession, patch: Partial<VideoTransferSession>) {
  const rows = await supabase(transferSessionTable, {
    method: "PATCH",
    query: `transfer_id=eq.${encodeURIComponent(session.transferId)}&select=*`,
    prefer: "return=representation",
    body: sessionToRow({ ...session, ...patch, updatedAt: new Date().toISOString() }),
  });
  return rowToSession(rows[0]);
}

function transferManifest(args: {
  accountId: string;
  savedVideo: SafeSavedVideo;
  video: UploadVideoMetadata;
  assetFolderId: string;
  videoFileId?: string;
  analysisFileId?: string;
  manifestFileId?: string;
  sourceDeviceId?: string;
  providerId?: ClarityCloudProviderId;
  status: "preparing" | "uploading" | "ready_to_import" | "imported" | "complete" | "failed";
}) {
  const uploadedAt = new Date().toISOString();
  return {
    version: 1,
    savedVideoId: args.savedVideo.savedVideoId,
    accountId: args.accountId,
    playerId: args.savedVideo.playerId,
    lessonId: args.savedVideo.lessonId,
    analysisId: args.savedVideo.analysisId,
    title: args.savedVideo.title,
    createdAt: args.savedVideo.createdAt,
    updatedAt: args.savedVideo.updatedAt,
    uploadedAt,
    sourceDevice: {
      deviceId: args.sourceDeviceId || args.savedVideo.source?.sourceDeviceId || "browser",
    },
    status: args.status,
    lifecycle: {
      uploadCompleteMeans: "ready_to_import",
      importCompleteMeans: "verified_local_storage_copy",
      readyToImportAt: args.status === "ready_to_import" ? uploadedAt : undefined,
    },
    provider: {
      id: args.providerId || "google-drive",
      displayName: "Google Drive",
      assetFolderId: args.assetFolderId,
    },
    transfer: {
      chunkSizeBytes: defaultChunkSizeBytes,
      checksumSemantics: "Drive v3 exposes md5Checksum for binary uploads; SHA-256 is stored in the manifest for import-side verification.",
    },
    driveAssetFolderId: args.assetFolderId,
    video: {
      fileName: args.video.fileName,
      mimeType: args.video.mimeType,
      sizeBytes: args.video.sizeBytes,
      checksumSha256: args.video.checksumSha256,
      driveFileId: args.videoFileId,
      duration: args.savedVideo.source?.duration,
      width: args.savedVideo.source?.width,
      height: args.savedVideo.source?.height,
    },
    analysisFileId: args.analysisFileId,
    manifestFileId: args.manifestFileId,
  };
}

async function handleSession(
  req: Request,
  accountId: string,
  accessToken: string,
  settings: Record<string, string>,
  provider: ClarityCloudProviderAdapter,
  savedVideoId: string,
  diagnostics: ProviderDiagnostics = {}
) {
  if (req.method === "GET") {
    const session = await readTransferSession(accountId, savedVideoId);
    if (!session) return json({ ok: true, status: "not-uploaded" });
    return json({ ok: true, session: publicTransferSession(session), ...publicTransferSession(session) });
  }

  const body = await readJson(req) as any;
  const { savedVideo, video } = validateUploadSessionPayload(body, savedVideoId);
  const existing = await readTransferSession(accountId, savedVideoId);
  const sourceMatchesExisting = Boolean(
    existing && existing.expectedSizeBytes === video.sizeBytes && existing.checksumSha256 === video.checksumSha256
  );
  if (existing?.status === "ready" && sourceMatchesExisting) {
    return json({ ok: true, status: "ready", session: publicTransferSession(existing), ...publicTransferSession(existing) });
  }
  // "verifying" must be resumable: a failed finalize leaves the row in
  // "verifying", and inserting a second active session for the same saved
  // video would violate the one-active-session unique index.
  if (existing && ["preparing", "session-created", "uploading", "paused", "verifying"].includes(existing.status)) {
    if (sourceMatchesExisting) {
      const nextStatus: TransferStatus = existing.status === "paused" ? "uploading" : existing.status;
      const resumed = await patchTransferSession(existing, {
        status: nextStatus,
        catalogueStatus: "uploading",
        // Older sessions may carry a chunk size above the current transport
        // limit; clamp so resumed chunk uploads stay accepted.
        chunkSizeBytes: Math.min(existing.chunkSizeBytes, defaultChunkSizeBytes),
        lastErrorCode: undefined,
        lastErrorMessage: undefined,
      });
      return json({ ok: true, status: resumed.status, session: publicTransferSession(resumed), ...publicTransferSession(resumed) });
    }
    await patchTransferSession(existing, {
      status: "failed",
      catalogueStatus: "failed",
      lastErrorCode: "DRIVE_UPLOAD_VERIFY_FAILED",
      lastErrorMessage: "Saved source changed before transfer completed.",
    });
  }

  const folders = await provider.ensureTransferStorage(accountId);
  // If we know the saved source changed since the last completed upload, the
  // finalized manifest in Drive is stale — skip the ready shortcut and
  // re-upload the new bytes.
  const sourceChangedAfterReady = existing?.status === "ready" && !sourceMatchesExisting;
  const assetFolder = await ensureAssetFolder(accessToken, accountId, savedVideo, folders.inbox.id, diagnostics);
  const existingReady = sourceChangedAfterReady
    ? null
    : await findDriveFile(accessToken, appProperties(accountId, savedVideo, "manifest"), assetFolder.id, {
        ...diagnostics,
        step: "drive-ready-manifest-lookup",
      });
  if (existingReady) {
    const manifest = await provider.readJsonFile({ fileId: existingReady.id }).catch(() => ({})) as any;
    const readyVideoFileId = cleanString(manifest?.video?.driveFileId, "", 180);
    if (readyVideoFileId) {
      const now = new Date().toISOString();
      const ready = await saveTransferSession({
        version: 1,
        transferId: randomUUID(),
        savedVideoId,
        accountId,
        providerId: provider.id,
        catalogueStatus: "ready_to_import",
        playerId: savedVideo.playerId,
        lessonId: savedVideo.lessonId,
        analysisId: savedVideo.analysisId,
        status: "ready",
        expectedSizeBytes: video.sizeBytes,
        checksumSha256: video.checksumSha256,
        acceptedOffsetBytes: video.sizeBytes,
        chunkSizeBytes: defaultChunkSizeBytes,
        driveAssetFolderId: assetFolder.id,
        driveVideoFileId: readyVideoFileId,
        driveManifestFileId: existingReady.id,
        driveAnalysisFileId: cleanString(manifest?.analysisFileId, "", 180) || undefined,
        resumableSessionUrl: "ready",
        resumableSessionCreatedAt: now,
        readyToImportAt: now,
        providerFolderLink: await provider.getTransferFolderLink?.({ folderId: assetFolder.id }) || undefined,
        cleanupStatus: "not_scheduled",
        createdAt: now,
        updatedAt: now,
      });
      return json({ ok: true, status: "ready", session: publicTransferSession(ready), ...publicTransferSession(ready) });
    }
  }

  const uploadSession = await provider.createUploadSession({ accountId, savedVideo, video, storage: folders });
  const now = new Date();
  let session: VideoTransferSession;
  try {
    session = await saveTransferSession({
      version: 1,
      transferId: randomUUID(),
      savedVideoId,
      accountId,
      providerId: provider.id,
      catalogueStatus: "uploading",
      playerId: savedVideo.playerId,
      lessonId: savedVideo.lessonId,
      analysisId: savedVideo.analysisId,
      status: "session-created",
      expectedSizeBytes: video.sizeBytes,
      checksumSha256: video.checksumSha256,
      acceptedOffsetBytes: 0,
      chunkSizeBytes: defaultChunkSizeBytes,
      driveAssetFolderId: uploadSession.assetFolderId,
      driveVideoFileId: uploadSession.videoFileId,
      resumableSessionUrl: uploadSession.resumableSessionUrl,
      resumableSessionCreatedAt: now.toISOString(),
      resumableSessionExpiresAt: new Date(now.getTime() + transferSessionTtlMs).toISOString(),
      sourceDeviceId: cleanString(body?.sourceDevice?.deviceId, "", 160) || undefined,
      providerFolderLink: uploadSession.folderLink || undefined,
      cleanupStatus: "not_scheduled",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
  } catch {
    throw new TransferError(
      "DRIVE_TRANSFER_STATE_FAILED",
      "Clarity Cloud could not store the upload session.",
      503,
      providerErrorOptions({
        ...diagnostics,
        step: "transfer-session-store",
        endpointClass: "transfer-session-table",
        resumableSessionReturned: true,
        afterResumableSession: true,
      }, "session-created")
    );
  }
  try {
    await uploadJsonFile(
      accessToken,
      uploadSession.assetFolderId,
      "manifest.json",
      appProperties(accountId, savedVideo, "provisional-manifest"),
      transferManifest({ accountId, savedVideo, video, assetFolderId: uploadSession.assetFolderId, videoFileId: uploadSession.videoFileId, sourceDeviceId: session.sourceDeviceId, status: "uploading", providerId: provider.id }),
      {
        ...diagnostics,
        step: "drive-provisional-manifest-create",
      }
    );
  } catch (error: any) {
    console.warn("video_transfer:provisional_manifest_failed", {
      transferId: session.transferId,
      savedVideoId,
      accountId,
      code: error?.code || "DRIVE_FINALIZE_FAILED",
      message: redactForLogs(error?.message || error),
      googleStatus: error instanceof TransferError ? error.options.diagnostics?.googleStatus : undefined,
      googleReason: error instanceof TransferError ? error.options.diagnostics?.googleReason : undefined,
    });
  }
  console.info("video_transfer:resumable_session_created", {
    transferId: session.transferId,
    savedVideoId,
    accountId,
    status: session.status,
    expectedSizeBytes: session.expectedSizeBytes,
    chunkSizeBytes: session.chunkSizeBytes,
  });
  return json({ ok: true, status: session.status, session: publicTransferSession(session), ...publicTransferSession(session) });
}

function parseIntegerHeader(req: Request, name: string) {
  const value = Number(req.headers.get(name));
  return Number.isFinite(value) ? value : NaN;
}

function acceptedOffsetFromGoogle(response: Response, fallback: number) {
  const range = response.headers.get("range") || "";
  const match = range.match(/bytes=0-(\d+)/i);
  return match ? Number(match[1]) + 1 : fallback;
}

async function handleChunk(req: Request, accountId: string, savedVideoId: string, provider: ClarityCloudProviderAdapter) {
  const session = await readTransferSession(accountId, savedVideoId);
  if (!session) throw new TransferError("DRIVE_UPLOAD_SESSION_EXPIRED", "Start a transfer session before sending chunks.", 409);
  const bytes = Buffer.from(await req.arrayBuffer());
  const startByte = parseIntegerHeader(req, "x-clarity-start-byte");
  const endByte = parseIntegerHeader(req, "x-clarity-end-byte");
  const totalSize = parseIntegerHeader(req, "x-clarity-total-size");
  const transferId = cleanString(req.headers.get("x-clarity-transfer-id"), "", 160);
  if (transferId && transferId !== session.transferId) {
    throw new TransferError("DRIVE_UPLOAD_VERIFY_FAILED", "Transfer id did not match the server session.", 409);
  }
  validateChunkRequest(session, { accountId, savedVideoId, transferId, startByte, endByte, totalSize, chunkLength: bytes.byteLength });
  const providerResult = await provider.uploadChunk({
    sessionUrl: session.resumableSessionUrl,
    contentType: req.headers.get("content-type") || "application/octet-stream",
    startByte,
    endByte,
    totalSize,
    bytes,
  });

  if (providerResult.status === "uploading") {
    const next = await patchTransferSession(session, {
      status: "uploading",
      catalogueStatus: "uploading",
      acceptedOffsetBytes: providerResult.acceptedOffsetBytes,
      lastErrorCode: undefined,
      lastErrorMessage: undefined,
    });
    return json({ ok: true, status: "uploading", session: publicTransferSession(next), ...publicTransferSession(next) });
  }

  if (providerResult.status === "verifying") {
    const next = await patchTransferSession(session, {
      status: "verifying",
      catalogueStatus: "uploading",
      acceptedOffsetBytes: session.expectedSizeBytes,
      driveVideoFileId: providerResult.videoFileId || session.driveVideoFileId,
      lastErrorCode: undefined,
      lastErrorMessage: undefined,
    });
    return json({ ok: true, status: "verifying", videoFileId: next.driveVideoFileId, session: publicTransferSession(next), ...publicTransferSession(next) });
  }

  if (providerResult.status === "auth_failed") {
    const next = await patchTransferSession(session, {
      status: "failed",
      catalogueStatus: "repair_required",
      lastErrorCode: providerResult.responseStatus === 401 ? "GOOGLE_RECONNECT_REQUIRED" : "DRIVE_SCOPE_MISSING",
      lastErrorMessage: "Reconnect Google Drive to continue.",
    });
    return errorJson(next.lastErrorCode || "GOOGLE_RECONNECT_REQUIRED", next.lastErrorMessage || "Reconnect Clarity Cloud to continue.", 403, {
      session: publicTransferSession(next),
    });
  }
  if (providerResult.status === "expired") {
    const next = await patchTransferSession(session, {
      status: "expired",
      catalogueStatus: "expired",
      lastErrorCode: "DRIVE_UPLOAD_SESSION_EXPIRED",
      lastErrorMessage: "Google resumable upload session expired. Start a new transfer session.",
    });
    return errorJson("DRIVE_UPLOAD_SESSION_EXPIRED", next.lastErrorMessage || "Google resumable upload session expired. Start a new transfer session.", 409, {
      session: publicTransferSession(next),
      phase: "uploading",
      retryable: true,
    });
  }
  if (providerResult.status === "interrupted") {
    const next = await patchTransferSession(session, {
      status: "uploading",
      catalogueStatus: "uploading",
      lastErrorCode: "DRIVE_UPLOAD_INTERRUPTED",
      lastErrorMessage: "Google Drive upload was interrupted. Retry the same chunk.",
    });
    return errorJson("DRIVE_UPLOAD_INTERRUPTED", next.lastErrorMessage || "Google Drive upload was interrupted. Retry the same chunk.", 503, {
      session: publicTransferSession(next),
      phase: "uploading",
      retryable: true,
    });
  }
  const next = await patchTransferSession(session, {
    status: "failed",
    catalogueStatus: "failed",
    lastErrorCode: "DRIVE_UPLOAD_PROXY_FAILED",
    lastErrorMessage: "Clarity could not complete the chunk upload.",
  });
  return errorJson("DRIVE_UPLOAD_PROXY_FAILED", next.lastErrorMessage || "Clarity could not complete the chunk upload.", providerResult.responseStatus || 502, {
    session: publicTransferSession(next),
    phase: "uploading",
    retryable: true,
  });
}

async function handleFinalize(
  req: Request,
  accountId: string,
  accessToken: string,
  provider: ClarityCloudProviderAdapter,
  savedVideoId: string
) {
  const body = await readJson(req) as any;
  const { savedVideo, video, analysisJson } = validateFinalizePayload(body, savedVideoId);
  const session = await readTransferSession(accountId, savedVideoId);
  if (!session) throw new TransferError("DRIVE_UPLOAD_SESSION_EXPIRED", "Start a transfer session before finalizing.", 409);
  if (session.acceptedOffsetBytes !== session.expectedSizeBytes) {
    throw new TransferError("DRIVE_UPLOAD_VERIFY_FAILED", "Upload cannot finalize before all bytes are accepted.", 409);
  }
  const driveVideoFileId = session.driveVideoFileId || video.driveFileId;
  if (!driveVideoFileId) throw new TransferError("DRIVE_UPLOAD_VERIFY_FAILED", "Uploaded Drive video file id is required.", 400);
  await patchTransferSession(session, { status: "verifying" });
  const finalized = await provider.finalizeUpload({
    accountId,
    session,
    savedVideo,
    video,
    analysisJson,
  });
  try {
    // Best-effort: remove the provisional manifest so the asset folder holds a
    // single authoritative manifest.json after finalize.
    const provisional = await findDriveFile(accessToken, appProperties(accountId, savedVideo, "provisional-manifest"), finalized.assetFolderId);
    if (provisional?.id && provisional.id !== finalized.manifestFileId) {
      await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(provisional.id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    }
  } catch {
    // The finalized manifest is authoritative; leftover provisional files are cosmetic.
  }
  const readyToImportAt = new Date().toISOString();
  const ready = await patchTransferSession(session, {
    status: "ready",
    catalogueStatus: "ready_to_import",
    acceptedOffsetBytes: session.expectedSizeBytes,
    driveVideoFileId: finalized.videoFileId,
    driveAnalysisFileId: finalized.analysisFileId,
    driveManifestFileId: finalized.manifestFileId,
    readyToImportAt,
    providerFolderLink: await provider.getTransferFolderLink?.({ folderId: finalized.assetFolderId }) || session.providerFolderLink,
    lastErrorCode: undefined,
    lastErrorMessage: undefined,
  });
  return json({
    ok: true,
    status: "ready",
    catalogueStatus: "ready_to_import",
    message: "Available in Clarity Cloud",
    assetFolderId: finalized.assetFolderId,
    videoFileId: finalized.videoFileId,
    analysisFileId: finalized.analysisFileId,
    manifestFileId: finalized.manifestFileId,
    uploadedAt: readyToImportAt,
    readyToImportAt,
    session: publicTransferSession(ready),
  });
}

async function handleStatus(accountId: string, accessToken: string, settings: Record<string, string>, savedVideoId: string, diagnostics: ProviderDiagnostics = {}) {
  const session = await readTransferSession(accountId, savedVideoId);
  if (session) return json({ ok: true, status: session.status, session: publicTransferSession(session), ...publicTransferSession(session) });
  const folders = await ensureTransferFolders(accessToken, accountId, settings, diagnostics);
  const assetFolder = await findDriveFile(accessToken, {
    clarityType: "video-transfer-asset-folder",
    claritySavedVideoId: savedVideoId,
    clarityAccountId: accountId,
    clarityVersion,
  }, folders.inbox.id, {
    ...diagnostics,
    step: "drive-status-asset-folder-lookup",
  });
  if (!assetFolder) return json({ ok: true, status: "not-uploaded" });
  return json({ ok: true, status: "uploading", message: "Upload is not finalized.", assetFolderId: assetFolder.id });
}

async function updateSessionStatus(accountId: string, savedVideoId: string, status: TransferStatus, message?: string) {
  const session = await readTransferSession(accountId, savedVideoId);
  if (!session) throw new TransferError("DRIVE_UPLOAD_SESSION_EXPIRED", "Transfer session was not found.", 404);
  if (status === "paused" && (session.status !== "uploading" || session.acceptedOffsetBytes <= 0)) {
    throw new TransferError(
      "DRIVE_UPLOAD_SESSION_EXPIRED",
      "Upload has not started yet.",
      409,
      { phase: session.status === "session-created" ? "session-created" : "preparing", retryable: true }
    );
  }
  const next = await patchTransferSession(session, {
    status,
    catalogueStatus:
      status === "cancelled"
        ? "cancelled"
        : status === "expired"
          ? "expired"
          : status === "failed"
            ? "failed"
            : status === "ready"
              ? "ready_to_import"
              : "uploading",
    lastErrorCode: status === "failed" ? "DRIVE_UPLOAD_INTERRUPTED" : undefined,
    // A pause is not an error; only keep messages for terminal states.
    lastErrorMessage: status === "paused" ? undefined : message,
  });
  return json({ ok: true, status: next.status, session: publicTransferSession(next), ...publicTransferSession(next) });
}

async function listImportableSessions(accountId: string) {
  const rows = await supabase(transferSessionTable, {
    query: `select=*&account_id=eq.${encodeURIComponent(accountId)}&catalogue_status=in.(ready_to_import,importing,imported,cleanup_scheduled,complete,repair_required)&order=ready_to_import_at.desc.nullslast,updated_at.desc&limit=50`,
  });
  return rows.map(rowToSession);
}

async function readManifestForSession(provider: ClarityCloudProviderAdapter, session: VideoTransferSession) {
  if (!session.driveManifestFileId) return {};
  return provider.readJsonFile({ fileId: session.driveManifestFileId }).catch(() => ({}));
}

function importSummaryFromManifest(session: VideoTransferSession, manifest: any) {
  const publicSession = publicTransferSession(session);
  const video = manifest?.video || {};
  return {
    ...publicSession,
    savedVideo: {
      savedVideoId: session.savedVideoId,
      playerId: session.playerId,
      lessonId: session.lessonId,
      analysisId: session.analysisId,
      title: cleanString(manifest?.title, "Saved video", 240),
      createdAt: cleanString(manifest?.createdAt, session.createdAt, 80),
      updatedAt: cleanString(manifest?.updatedAt, session.updatedAt, 80),
    },
    video: {
      fileName: cleanString(video.fileName, `${session.savedVideoId}.mp4`, 180),
      mimeType: cleanString(video.mimeType, "application/octet-stream", 180),
      sizeBytes: Number(video.sizeBytes || session.expectedSizeBytes || 0),
      checksumSha256: cleanString(video.checksumSha256, session.checksumSha256, 128),
      duration: Number.isFinite(Number(video.duration)) ? Number(video.duration) : undefined,
      width: Number.isFinite(Number(video.width)) ? Number(video.width) : undefined,
      height: Number.isFinite(Number(video.height)) ? Number(video.height) : undefined,
    },
  };
}

async function handleImportList(accountId: string, provider: ClarityCloudProviderAdapter) {
  const sessions = await listImportableSessions(accountId);
  const transfers = await Promise.all(
    sessions.map(async (session) => importSummaryFromManifest(session, await readManifestForSession(provider, session)))
  );
  return json({ ok: true, transfers });
}

function assertImportable(session: VideoTransferSession) {
  if (session.status !== "ready" || !session.driveVideoFileId || !session.driveManifestFileId) {
    throw new TransferError(
      "CLARITY_CLOUD_IMPORT_NOT_READY",
      "This video is not ready to download from Clarity Cloud.",
      409
    );
  }
}

async function handleImportPackage(accountId: string, provider: ClarityCloudProviderAdapter, savedVideoId: string) {
  const session = await readTransferSession(accountId, savedVideoId);
  if (!session) throw new TransferError("DRIVE_UPLOAD_SESSION_EXPIRED", "Transfer session was not found.", 404);
  assertImportable(session);
  const manifest = await readManifestForSession(provider, session) as any;
  const analysisFileId = session.driveAnalysisFileId || cleanString(manifest?.analysisFileId, "", 180);
  const analysisJson = analysisFileId ? await provider.readJsonFile({ fileId: analysisFileId }) : {};
  return json({
    ok: true,
    transfer: publicTransferSession(session),
    manifest,
    analysisJson,
    ...importSummaryFromManifest(session, manifest),
  });
}

async function handleImportDownload(req: Request, accountId: string, provider: ClarityCloudProviderAdapter, savedVideoId: string) {
  const session = await readTransferSession(accountId, savedVideoId);
  if (!session) throw new TransferError("DRIVE_UPLOAD_SESSION_EXPIRED", "Transfer session was not found.", 404);
  assertImportable(session);
  const result = await provider.readFileRange({
    fileId: session.driveVideoFileId || "",
    range: req.headers.get("range") || undefined,
  });
  if (result instanceof Response) {
    const headers = new Headers(result.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Clarity-Transfer-Id", session.transferId);
    return new Response(result.body, { status: result.status, statusText: result.statusText, headers });
  }
  const body = result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) as ArrayBuffer;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Clarity-Transfer-Id": session.transferId,
    },
  });
}

async function handleImportReceipt(req: Request, accountId: string, savedVideoId: string) {
  const session = await readTransferSession(accountId, savedVideoId);
  if (!session) throw new TransferError("DRIVE_UPLOAD_SESSION_EXPIRED", "Transfer session was not found.", 404);
  assertImportable(session);
  const body = await readJson(req) as any;
  const checksumSha256 = cleanString(body?.checksumSha256, "", 128).toLowerCase();
  const sizeBytes = Number(body?.sizeBytes);
  if (sizeBytes !== session.expectedSizeBytes || checksumSha256 !== session.checksumSha256) {
    throw new TransferError(
      "CLARITY_CLOUD_IMPORT_VERIFY_FAILED",
      "Device download verification did not match the Clarity Cloud catalogue.",
      409
    );
  }
  const now = new Date();
  const cleanupAfter = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 7).toISOString();
  const receipt = {
    version: 1,
    transferId: session.transferId,
    savedVideoId: session.savedVideoId,
    accountId,
    localSavedVideoId: cleanString(body?.localSavedVideoId, session.savedVideoId, 160),
    deviceId: cleanString(body?.deviceId, "browser", 160),
    deviceName: cleanString(body?.deviceName, "", 180),
    platform: cleanString(body?.platform, "", 180),
    libraryStatus: cleanString(body?.libraryStatus, "", 120),
    sizeBytes,
    checksumSha256,
    verifiedAt: cleanString(body?.verifiedAt, now.toISOString(), 80),
    receivedAt: now.toISOString(),
  };
  const next = await patchTransferSession(session, {
    catalogueStatus: "complete",
    destinationDeviceId: receipt.deviceId,
    destinationDeviceName: receipt.deviceName || undefined,
    destinationPlatform: receipt.platform || undefined,
    importedAt: now.toISOString(),
    importVerifiedAt: receipt.verifiedAt,
    cleanupScheduledAt: now.toISOString(),
    cleanupAfter,
    cleanupStatus: "scheduled",
    importReceiptJson: JSON.stringify(receipt),
    lastErrorCode: undefined,
    lastErrorMessage: undefined,
  });
  return json({
    ok: true,
    status: "imported",
    catalogueStatus: next.catalogueStatus,
    importedAt: next.importedAt,
    importVerifiedAt: next.importVerifiedAt,
    cleanupScheduledAt: next.cleanupScheduledAt,
    cleanupAfter: next.cleanupAfter,
    session: publicTransferSession(next),
  });
}

export default async function handler(req: Request) {
  const url = new URL(req.url);
  const parts = url.pathname
    .replace(/^\/api\/video-transfer\/?/, "")
    .replace(/^\/\.netlify\/functions\/video-transfer\/?/, "")
    .split("/")
    .filter(Boolean);
  const diagnostics: ProviderDiagnostics = {};

  try {
    if (!(await requireAdmin(req))) return json({ error: "unauthorized", message: "Admin login required." }, 401);
    if (req.method === "GET" && parts[0] === "diagnostics") {
      return json(getSafeClarityCloudGoogleRuntimeDiagnostic(req));
    }
    assertClarityCloudServerConfigured(req);
    const settings = await readSettings();
    const accountId = resolveGoogleAccountId(settings);
    // Only routes that talk to the Drive API need an access token. Chunk
    // uploads go straight to the stored resumable URL, so skipping the
    // refresh-token exchange here removes several round-trips per chunk.

    if (req.method === "POST" && parts[0] === "upload-session") {
      const body = await req.clone().json().catch(() => ({})) as any;
      const savedVideoId = cleanString(body?.savedVideoId || body?.savedVideo?.savedVideoId, "", 160);
      if (!savedVideoId) throw new TransferError("DRIVE_UPLOAD_VERIFY_FAILED", "Saved video id is required.", 400);
      const accessToken = await ensureDriveReady(accountId, diagnostics);
      // NOTE: every route below must use `return await` so rejections are caught
      // by this try/catch. A bare `return somePromise` escapes the try block and
      // crashes the function process (Netlify then returns an opaque 502).
      return await handleSession(req, accountId, accessToken, settings, googleDriveProviderAdapter(accessToken, settings, diagnostics), savedVideoId, diagnostics);
    }
    if (req.method === "GET" && parts[0] === "imports") {
      const accessToken = await ensureDriveReady(accountId, diagnostics);
      return await handleImportList(accountId, googleDriveProviderAdapter(accessToken, settings, diagnostics));
    }
    if ((req.method === "POST" || req.method === "GET") && parts[1] === "session") {
      const accessToken = req.method === "POST" ? await ensureDriveReady(accountId, diagnostics) : "";
      return await handleSession(req, accountId, accessToken, settings, googleDriveProviderAdapter(accessToken, settings, diagnostics), parts[0], diagnostics);
    }
    if (req.method === "PUT" && (parts[1] === "chunk" || parts[1] === "upload")) {
      return await handleChunk(req, accountId, parts[0], googleDriveProviderAdapter("", settings, diagnostics));
    }
    if (req.method === "POST" && parts[1] === "pause") return await updateSessionStatus(accountId, parts[0], "paused", "Paused");
    if (req.method === "POST" && (parts[1] === "resume" || parts[1] === "retry")) return await updateSessionStatus(accountId, parts[0], "uploading");
    if (req.method === "POST" && parts[1] === "finalize") {
      const accessToken = await ensureDriveReady(accountId, diagnostics);
      return await handleFinalize(req, accountId, accessToken, googleDriveProviderAdapter(accessToken, settings, diagnostics), parts[0]);
    }
    if (req.method === "GET" && parts[1] === "import") {
      const accessToken = await ensureDriveReady(accountId, diagnostics);
      return await handleImportPackage(accountId, googleDriveProviderAdapter(accessToken, settings, diagnostics), parts[0]);
    }
    if (req.method === "GET" && parts[1] === "download") {
      const accessToken = await ensureDriveReady(accountId, diagnostics);
      return await handleImportDownload(req, accountId, googleDriveProviderAdapter(accessToken, settings, diagnostics), parts[0]);
    }
    if (req.method === "POST" && parts[1] === "import-receipt") return await handleImportReceipt(req, accountId, parts[0]);
    if (req.method === "GET" && parts[1] === "status") return await handleStatus(accountId, await ensureDriveReady(accountId, diagnostics), settings, parts[0], diagnostics);
    if (req.method === "DELETE" && (parts[1] === "session" || parts[0])) {
      const savedVideoId = parts[1] === "session" ? parts[0] : parts[0];
      return await updateSessionStatus(accountId, savedVideoId, "cancelled", "Transfer cancelled. Local source was not deleted.");
    }
    return json({ error: "not_found", message: "Video transfer route not found." }, 404);
  } catch (error: any) {
    logProviderFailure(parts.join("/") || "root", error, diagnostics);
    if (error instanceof TransferError) {
      return errorJson(error.code, error.message, error.status, {
        phase: error.options.phase,
        retryable: error.options.retryable,
      });
    }
    const code =
      error?.code === "CLOUD_OAUTH_NOT_CONFIGURED"
        ? "CLOUD_OAUTH_NOT_CONFIGURED"
        : error?.code === "GOOGLE_RECONNECT_REQUIRED"
        ? "GOOGLE_RECONNECT_REQUIRED"
        : error?.code === "GOOGLE_CONNECTION_NOT_FOUND"
          ? "DRIVE_NOT_CONNECTED"
          : error?.code === "GOOGLE_TOKEN_REFRESH_FAILED"
            ? "GOOGLE_TOKEN_REFRESH_FAILED"
            : error?.code === "GOOGLE_SCOPE_MISSING"
              ? "DRIVE_SCOPE_MISSING"
              : error?.code === "GOOGLE_TOKEN_ENCRYPTION_KEY_MISSING" || error?.code === "GOOGLE_TOKEN_ENCRYPTION_KEY_INVALID"
                ? "PROVIDER_STORAGE_UNAVAILABLE"
                : "CLARITY_CLOUD_PROVIDER_FAILED";
    const status = error?.status || (code === "GOOGLE_RECONNECT_REQUIRED" || code === "DRIVE_NOT_CONNECTED" || code === "DRIVE_SCOPE_MISSING" ? 403 : code === "GOOGLE_TOKEN_REFRESH_FAILED" ? 502 : 503);
    const message =
      code === "CLOUD_OAUTH_NOT_CONFIGURED"
        ? "Clarity Cloud is not configured for this environment."
        : code === "PROVIDER_STORAGE_UNAVAILABLE"
        ? "Secure provider storage is unavailable."
        : code === "GOOGLE_TOKEN_REFRESH_FAILED"
          ? "Clarity Cloud could not refresh the Google connection."
        : code === "CLARITY_CLOUD_PROVIDER_FAILED"
          ? "Your local video is safe. The cloud transfer service could not be reached."
          : error instanceof Error
            ? error.message
            : "Video transfer failed.";
    return errorJson(code, message, status);
  }
}

export const config: Config = {
  path: "/api/video-transfer/*",
};
