import type { Config } from "@netlify/functions";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  guestResidentBytesPerAccount,
  guestRetentionDays,
  guestSubmissionMaxBytes,
  guestSubmissionsLifetime,
  guestSubmissionsPerAccountPerDay,
} from "./_shared/guest-limits.mts";
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
  setSettings,
} from "./_shared/google-provider.mts";
import { requireCoachActor } from "./_shared/coach-auth.mts";
import { deliverEmail } from "./_shared/email-delivery.mts";
import {
  isSwingReviewLessonId,
  reviewAt,
  reviewEmail,
  reviewSendVerdict,
  reviewShareExpiry,
  reviewShareUrl,
  reviewShareVideo,
  type ReviewSharePayload,
} from "./_shared/swing-review-share.mts";
import { canonicalPhoneKey, cleanPhoneCountry } from "./_shared/phone.mts";
import {
  MAX_SNAPSHOT_IMAGE_BYTES,
  carryImageFileIds,
  publicSnapshots,
  safeSnapshotId,
  snapshotHasImage,
  snapshotImageAppProperties,
  snapshotImageFileName,
  snapshotUploadVerdict,
} from "./_shared/swing-review-snapshots.mts";

// Player portal sessions (see booking-core.mts). Player video routes are scoped
// to the player's own player_id; the admin transfer surface is untouched.
const playerSessionCookieName = "clarity_player_session";
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

export type TransferDirection =
  | "coach-device"
  | "player-submission"
  | "guest-submission"
  | "coach-return";

/** Set only for player submissions; forced from the session, never the body. */
export type PlayerSubmission = {
  playerId: string;
  portalPlayerId: string;
  name: string;
  message: string;
};

/**
 * Set only for guest submissions; forced from the guest_senders row, never the
 * body. playerId is always `guest-<guestSenderId>` -- a guest has no person
 * record to file the video under, and the id the client sends is a placeholder.
 */
export type GuestSubmission = {
  guestSenderId: string;
  playerId: string;
  name: string;
  email: string;
  message: string;
};

/**
 * Set only for coach returns; the coach names a person, and everything here is
 * resolved from that person's portal_players row rather than from the body.
 * The player never authorises this upload -- the coach does -- so the only
 * thing the player's side contributes is proof they have portal access at all.
 */
export type CoachReturn = {
  /** Forced onto the manifest so the return lands in that player's imports. */
  playerId: string;
  portalPlayerId: string;
  playerEmail: string;
  playerName: string;
  message: string;
  /**
   * The coach is sending a whole swing review, and this is one video out of it.
   * The return still happens; only its own email is held, because the review
   * sends one email naming all of it.
   */
  deferNotification: boolean;
};

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
  /**
   * 'coach-device' is the original flow: the coach's library syncing to their
   * own Drive and back down to another of their devices. 'player-submission'
   * is a portal player sending a video in. 'guest-submission' is someone with
   * no account at all doing the same. 'coach-return' is the coach sending an
   * annotated video back out to a player. Same engine, same Drive account --
   * what differs is the credential that authorised it and who is waiting.
   */
  direction?: TransferDirection;
  submittedByPortalPlayerId?: string;
  submittedByName?: string;
  playerMessage?: string;
  coachSeenAt?: string;
  /**
   * Coach returns only, and the mirror image of the three above: the note the
   * coach sent back, whether the player has opened it, and who it went to.
   */
  coachMessage?: string;
  playerSeenAt?: string;
  returnedToPortalPlayerId?: string;
  returnedAt?: string;
  /**
   * Set when this return is one video out of a swing review being sent as a
   * whole. The video is still delivered and still stamped returnedAt -- it is
   * just not announced on its own, because the review sends one email naming
   * all of it. See deliverCoachReturn.
   */
  suppressReturnEmail?: boolean;
  /** Guest submissions only: the guest_senders row that authorised this. */
  guestSenderId?: string;
  submittedByEmail?: string;
  /** sha256 of the no-login coach view link. The raw token is never stored. */
  coachViewTokenHash?: string;
  coachViewExpiresAt?: string;
  /** Set when the coach adds this guest as a player; stops the purge job. */
  claimedAt?: string;
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

type PlayerScope = {
  /** The business the player's session belongs to. */
  accountId: string;
  personId: string;
  email: string;
  phone: string;
  portalPlayerId: string;
  name: string;
};

/**
 * The native app is served from capacitor://localhost, so its requests here are
 * cross-site and the player cookie is never sent. It carries the same
 * player_sessions token in an Authorization header instead. Kept in step with
 * the identical pair in booking-core.mts.
 */
function bearerTokenFromRequest(req: Request): string {
  const header = req.headers.get("authorization") || "";
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : "";
}

const nativeAppOrigins = new Set([
  "capacitor://localhost",
  "http://localhost",
  "https://localhost",
]);

function corsHeaders(req: Request): Record<string, string> | null {
  const origin = req.headers.get("origin") || "";
  if (!nativeAppOrigins.has(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, Accept, X-Clarity-Client, X-Clarity-Guest-Token",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

async function readPlayerScope(req: Request): Promise<PlayerScope | null> {
  const token =
    bearerTokenFromRequest(req) || parseCookies(req)[playerSessionCookieName] || "";
  if (!token) return null;
  const rows = await supabase("player_sessions", {
    query:
      `select=account_id,person_id,email,phone,portal_player_id` +
      `&token_hash=eq.${encodeURIComponent(hashToken(token))}` +
      `&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`,
  });
  const row = rows[0];
  if (!row) return null;
  const personId = cleanString(row.person_id, "", 160);
  // The display name is only used to label the submission for the coach, so a
  // failed lookup is not worth failing the upload over.
  const accountId = cleanString(row.account_id, "", 120);
  let name = "";
  if (personId && accountId) {
    const people = await supabase("people", {
      // Scoped: a person id from a session must not read another business's
      // client record, even for something as small as a display name.
      query: `select=name&id=eq.${encodeURIComponent(personId)}&account_id=eq.${encodeURIComponent(accountId)}&limit=1`,
    }).catch(() => []);
    name = cleanString(people[0]?.name, "", 180);
  }
  return {
    accountId,
    personId,
    email: cleanString(row.email, "", 180).toLowerCase(),
    phone: cleanString(row.phone, "", 80),
    portalPlayerId: cleanString(row.portal_player_id, "", 80),
    name,
  };
}

// A player session is the one credential that can write to the coach's Drive
// without being the coach, so submissions are bounded on both size and rate.
const playerSubmissionMaxBytes = 750 * 1024 * 1024;
const playerSubmissionsPerDay = 20;

async function playerSubmissionsToday(accountId: string, portalPlayerId: string) {
  if (!portalPlayerId) return 0;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows = await supabase(transferSessionTable, {
    query:
      `select=transfer_id&account_id=eq.${encodeURIComponent(accountId)}` +
      `&direction=eq.player-submission` +
      `&submitted_by_portal_player_id=eq.${encodeURIComponent(portalPlayerId)}` +
      `&created_at=gt.${encodeURIComponent(since)}`,
  }).catch(() => []);
  return Array.isArray(rows) ? rows.length : 0;
}

const guestTokenHeaderName = "x-clarity-guest-token";

export type GuestScope = {
  id: string;
  accountId: string;
  name: string;
  email: string;
  claimedAt: string;
};

/**
 * The guest credential. Deliberately its own header and its own table: it is
 * not a player session and must never satisfy a check written for one.
 *
 * There is no expiry here on purpose -- the app has to survive a relaunch
 * without re-asking for a name and an email. What is bounded is what the token
 * can do, not how long it lasts.
 */
async function readGuestScope(req: Request): Promise<GuestScope | null> {
  const token = cleanString(req.headers.get(guestTokenHeaderName), "", 400);
  if (!token) return null;
  const rows = await supabase("guest_senders", {
    query: `select=id,account_id,name,email,claimed_at&token_hash=eq.${encodeURIComponent(hashToken(token))}&limit=1`,
  }).catch(() => []);
  const row = rows[0];
  if (!row) return null;
  return {
    id: cleanString(row.id, "", 80),
    accountId: cleanString(row.account_id, "", 120),
    name: cleanString(row.name, "", 180),
    email: cleanString(row.email, "", 180).toLowerCase(),
    claimedAt: cleanString(row.claimed_at, "", 80),
  };
}

/**
 * How many videos this guest has sent, ever. Cancelled, failed and expired
 * rows are excluded so a dropped connection does not silently burn one of
 * their three attempts.
 */
async function guestSubmissionCount(accountId: string, guestSenderId: string) {
  if (!guestSenderId) return Number.MAX_SAFE_INTEGER;
  const rows = await supabase(transferSessionTable, {
    query:
      `select=transfer_id&account_id=eq.${encodeURIComponent(accountId)}` +
      `&direction=eq.guest-submission` +
      `&guest_sender_id=eq.${encodeURIComponent(guestSenderId)}` +
      `&status=not.in.(cancelled,failed,expired)`,
  }).catch(() => []);
  return Array.isArray(rows) ? rows.length : 0;
}

/** Burst brake: how many strangers the account has absorbed in 24h. */
async function guestSubmissionsTodayForAccount(accountId: string) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows = await supabase(transferSessionTable, {
    query:
      `select=transfer_id&account_id=eq.${encodeURIComponent(accountId)}` +
      `&direction=eq.guest-submission` +
      `&created_at=gt.${encodeURIComponent(since)}`,
  }).catch(() => []);
  return Array.isArray(rows) ? rows.length : 0;
}

/**
 * Unclaimed guest bytes currently resident in the coach's Drive. This is the
 * cap that actually bounds their storage bill -- a rate limit only bounds how
 * fast an abuser paces themselves, not the total they can leave behind.
 */
async function guestResidentBytes(accountId: string) {
  const rows = await supabase(transferSessionTable, {
    query:
      `select=expected_size_bytes&account_id=eq.${encodeURIComponent(accountId)}` +
      `&direction=eq.guest-submission&claimed_at=is.null` +
      `&status=in.(preparing,session-created,uploading,paused,verifying,ready)`,
  }).catch(() => []);
  return (Array.isArray(rows) ? rows : []).reduce(
    (sum: number, row: any) => sum + Number(row?.expected_size_bytes || 0),
    0,
  );
}

function playerVideoBase64(value: string) {
  try {
    return Buffer.from(String(value ?? ""), "utf8").toString("base64");
  } catch {
    return "";
  }
}

// Mirrors playerProfileIdCandidates in booking-core.mts so a session's stored
// player_id (whatever historical form it took) matches this player.
function playerVideoIdCandidates(scope: PlayerScope, country: string): Set<string> {
  const ids = new Set<string>();
  if (scope.personId) ids.add(scope.personId);
  if (scope.email) {
    ids.add(scope.email);
    const encoded = playerVideoBase64(scope.email);
    if (encoded) {
      ids.add(`email-${encoded}`);
      ids.add(`email-${encoded.replace(/=+$/, "")}`);
    }
  }
  const canonicalPhone = canonicalPhoneKey(scope.phone, cleanPhoneCountry(country));
  if (canonicalPhone) ids.add(`phone-${canonicalPhone}`);
  return ids;
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
    direction: session.direction || "coach-device",
    submittedByName: session.submittedByName,
    playerMessage: session.playerMessage,
    coachSeenAt: session.coachSeenAt,
    coachMessage: session.coachMessage,
    playerSeenAt: session.playerSeenAt,
    returnedToPortalPlayerId: session.returnedToPortalPlayerId,
    returnedAt: session.returnedAt,
    // Deliberately no coachViewTokenHash: it never leaves the server.
    guestSenderId: session.guestSenderId,
    submittedByEmail: session.submittedByEmail,
    claimedAt: session.claimedAt,
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
    await setSettings(accountId, {
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

/** Swap the bytes of a file Clarity already wrote, keeping its id, name and
 *  appProperties. Used for a screenshot re-sent after an edit and for an
 *  analysis file refreshed on a later send. */
async function replaceDriveFileContent(
  accessToken: string,
  fileId: string,
  mimeType: string,
  body: BodyInit,
  errorCode: TransferErrorCode,
  diagnostics: ProviderDiagnostics = {}
) {
  return googleJson<DriveFile>(
    accessToken,
    `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,name,size,appProperties`,
    { method: "PATCH", headers: { "Content-Type": mimeType }, body },
    errorCode,
    { ...diagnostics, endpointClass: "drive-upload-media" }
  );
}

async function uploadBinaryFile(
  accessToken: string,
  folderId: string,
  name: string,
  mimeType: string,
  props: Record<string, string>,
  bytes: Uint8Array,
  diagnostics: ProviderDiagnostics = {}
) {
  const boundary = `clarity_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const encoder = new TextEncoder();
  const head = encoder.encode(
    [
      `--${boundary}`,
      "Content-Type: application/json; charset=utf-8",
      "",
      JSON.stringify({ name, parents: [folderId], mimeType, appProperties: props }),
      `--${boundary}`,
      `Content-Type: ${mimeType}`,
      "",
      "",
    ].join("\r\n")
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.byteLength + bytes.byteLength + tail.byteLength);
  body.set(head, 0);
  body.set(bytes, head.byteLength);
  body.set(tail, head.byteLength + bytes.byteLength);
  return googleJson<DriveFile>(
    accessToken,
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,appProperties",
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    },
    "DRIVE_FINALIZE_FAILED",
    { ...diagnostics, endpointClass: "drive-upload-multipart" }
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
      const response = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(context.assetFolderId)}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } },
      );
      // 404/410 means it is already gone, which is the outcome we wanted.
      // Anything else has to throw: the purge job marks rows complete on a
      // clean return, and a silent failure there would leave the coach's Drive
      // filling up behind a retention policy that reports success.
      if (!response.ok && response.status !== 404 && response.status !== 410) {
        throw new TransferError(
          "CLARITY_CLOUD_PROVIDER_FAILED",
          `Could not delete the transfer folder (${response.status}).`,
          response.status,
        );
      }
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

// Exported for the round-trip test: these two are pure and the guest/coach
// direction mapping between them is security-relevant.
export function rowToSession(row: any): VideoTransferSession {
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
    direction:
      row.direction === "player-submission"
        ? "player-submission"
        : row.direction === "guest-submission"
          ? "guest-submission"
          : row.direction === "coach-return"
            ? "coach-return"
            : "coach-device",
    submittedByPortalPlayerId: row.submitted_by_portal_player_id || undefined,
    submittedByName: row.submitted_by_name || undefined,
    playerMessage: row.player_message || undefined,
    coachSeenAt: row.coach_seen_at || undefined,
    coachMessage: row.coach_message || undefined,
    playerSeenAt: row.player_seen_at || undefined,
    returnedToPortalPlayerId: row.returned_to_portal_player_id || undefined,
    returnedAt: row.returned_at || undefined,
    suppressReturnEmail: row.suppress_return_email === true,
    guestSenderId: row.guest_sender_id || undefined,
    submittedByEmail: row.submitted_by_email || undefined,
    coachViewTokenHash: row.coach_view_token_hash || undefined,
    coachViewExpiresAt: row.coach_view_expires_at || undefined,
    claimedAt: row.claimed_at || undefined,
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

export function sessionToRow(session: VideoTransferSession) {
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
    direction: session.direction || "coach-device",
    submitted_by_portal_player_id: session.submittedByPortalPlayerId || null,
    submitted_by_name: session.submittedByName || null,
    player_message: session.playerMessage || null,
    coach_seen_at: session.coachSeenAt || null,
    // Guest columns are emitted only for guest rows. Sending them
    // unconditionally would make PostgREST reject every transfer write --
    // including the coach's own -- on any deploy that reached production
    // before the migration did.
    ...(session.direction === "guest-submission" || session.guestSenderId
      ? {
          guest_sender_id: session.guestSenderId || null,
          submitted_by_email: session.submittedByEmail || null,
          coach_view_token_hash: session.coachViewTokenHash || null,
          coach_view_expires_at: session.coachViewExpiresAt || null,
          claimed_at: session.claimedAt || null,
        }
      : {}),
    // Same reasoning as the guest columns above: emitted only for the rows
    // that have them, so a deploy that lands before the migration cannot
    // break every unrelated transfer write with an unknown-column rejection.
    ...(session.direction === "coach-return" || session.returnedToPortalPlayerId
      ? {
          coach_message: session.coachMessage || null,
          player_seen_at: session.playerSeenAt || null,
          returned_to_portal_player_id: session.returnedToPortalPlayerId || null,
          returned_at: session.returnedAt || null,
        }
      : {}),
    // Emitted only when it is true, unlike the block above. A review send is
    // the only thing that sets it, so an ordinary return must not carry the
    // column at all on a deploy that lands ahead of the migration.
    ...(session.suppressReturnEmail ? { suppress_return_email: true } : {}),
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
  diagnostics: ProviderDiagnostics = {},
  submission: PlayerSubmission | null = null,
  guest: GuestSubmission | null = null,
  coachReturn: CoachReturn | null = null
) {
  if (req.method === "GET") {
    const session = await readTransferSession(accountId, savedVideoId);
    if (!session) return json({ ok: true, status: "not-uploaded" });
    return json({ ok: true, session: publicTransferSession(session), ...publicTransferSession(session) });
  }

  const body = await readJson(req) as any;
  const { savedVideo, video } = validateUploadSessionPayload(body, savedVideoId);
  // A player's own id comes from their session, never from the body they sent.
  // Without this, a portal player could file a video under someone else.
  if (submission) savedVideo.playerId = submission.playerId;
  // Same rule for a guest, and it matters more: they have no person record at
  // all, and the client sends a placeholder id.
  if (guest) savedVideo.playerId = guest.playerId;
  // A return is addressed to a person, and the id it is filed under is what
  // decides whose portal it shows up in. The coach's local copy may be filed
  // under an email- or phone-derived id, so the canonical person id resolved
  // from portal_players wins over whatever the body carried.
  if (coachReturn) savedVideo.playerId = coachReturn.playerId;
  const submissionFields = submission
    ? {
        direction: "player-submission" as const,
        submittedByPortalPlayerId: submission.portalPlayerId,
        submittedByName: submission.name,
        playerMessage: submission.message || cleanString(body?.message, "", 600),
      }
    : guest
      ? {
          // Reusing submittedByName and playerMessage is what makes the coach's
          // existing catalogue row render a guest submission with no new
          // plumbing on that side.
          direction: "guest-submission" as const,
          guestSenderId: guest.guestSenderId,
          submittedByName: guest.name,
          submittedByEmail: guest.email,
          playerMessage: guest.message || cleanString(body?.message, "", 600),
        }
      : coachReturn
        ? {
            direction: "coach-return" as const,
            returnedToPortalPlayerId: coachReturn.portalPlayerId,
            coachMessage: coachReturn.message || cleanString(body?.message, "", 600),
            suppressReturnEmail: coachReturn.deferNotification,
          }
        : { direction: "coach-device" as const };
  const existing = await readTransferSession(accountId, savedVideoId);
  const sourceMatchesExisting = Boolean(
    existing && existing.expectedSizeBytes === video.sizeBytes && existing.checksumSha256 === video.checksumSha256
  );
  if (existing?.status === "ready" && sourceMatchesExisting) {
    // The bytes are already up. For an ordinary sync that is the whole answer,
    // but a coach asking to return a video they had already synced would
    // otherwise get a silent no-op: the row stays 'coach-device', no dot
    // appears, and no email goes out.
    //
    // Converting is only ever allowed from the coach's own library sync. A
    // submission row is the player's video coming in, and rewriting one into a
    // return would relabel their upload as the coach's reply.
    if (coachReturn && existing.direction !== "coach-return") {
      if (existing.direction === "player-submission" || existing.direction === "guest-submission") {
        throw new TransferError(
          "CLARITY_CLOUD_PROVIDER_FAILED",
          "That video was sent in by a player. Save your annotated copy and send that back instead.",
          409,
        );
      }
      const converted = await patchTransferSession(existing, {
        direction: "coach-return",
        returnedToPortalPlayerId: coachReturn.portalPlayerId,
        coachMessage: coachReturn.message || cleanString(body?.message, "", 600),
        playerId: coachReturn.playerId,
        suppressReturnEmail: coachReturn.deferNotification,
      });
      const delivered = await deliverCoachReturn(converted);
      return json({ ok: true, status: "ready", session: publicTransferSession(delivered), ...publicTransferSession(delivered) });
    }
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

  const transferFolders = await provider.ensureTransferStorage(accountId);
  // Player submissions land in their own Drive folder rather than mixed in with
  // the coach's own device-to-device transfers.
  const folders = submission
    ? {
        ...transferFolders,
        inbox: await ensureFolder(
          accessToken,
          "Player Submissions",
          {
            clarityType: "video-transfer-player-submissions",
            clarityAccountId: accountId,
            clarityVersion,
          },
          transferFolders.transfer.id,
          { ...diagnostics, step: "drive-player-submissions-folder-provision" }
        ),
      }
    : guest
      ? {
          ...transferFolders,
          // Strangers get their own bucket, beside Player Submissions rather
          // than inside it, so the coach can see and empty the whole lot in
          // one place.
          inbox: await ensureFolder(
            accessToken,
            "Guest Submissions",
            {
              clarityType: "video-transfer-guest-submissions",
              clarityAccountId: accountId,
              clarityVersion,
            },
            transferFolders.transfer.id,
            { ...diagnostics, step: "drive-guest-submissions-folder-provision" }
          ),
        }
      : transferFolders;
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
        ...submissionFields,
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
      // The bytes were already in Drive, so finalize never runs and the
      // notification would never fire. A return reaching "ready" is the event,
      // not the route it arrived by.
      const delivered = await deliverCoachReturn(ready);
      return json({ ok: true, status: "ready", session: publicTransferSession(delivered), ...publicTransferSession(delivered) });
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
      ...submissionFields,
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
  // A coach-device transfer is the coach's own sync and needs no telling. A
  // player submission is someone waiting for them to look at it.
  if (ready.direction === "player-submission") {
    await notifyCoachOfPlayerSubmission(ready).catch((error) => {
      console.warn("video_transfer:submission_notify_failed", redactForLogs(error?.message || error));
    });
  }
  // A return is the coach handing work back. The player is the one waiting,
  // and unlike the coach they have no console open to notice.
  if (ready.direction === "coach-return") {
    await deliverCoachReturn(ready);
  }
  // A guest submission is ephemeral and its recipient has no app open, so it
  // needs two more things than a player's: a clock, and a link that works
  // without a login. Both are set here rather than at session-create -- an
  // abandoned half-upload has no bytes worth a retention policy.
  if (ready.direction === "guest-submission") {
    const coachViewToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + guestRetentionDays * 86400000).toISOString();
    const readyGuest = await patchTransferSession(ready, {
      coachViewTokenHash: hashToken(coachViewToken),
      coachViewExpiresAt: expiresAt,
      cleanupAfter: expiresAt,
      cleanupScheduledAt: new Date().toISOString(),
      cleanupStatus: "scheduled",
    });
    // The raw token lives only long enough to reach the email.
    await notifyCoachOfGuestSubmission(readyGuest, coachViewToken).catch((error) => {
      console.warn("video_transfer:guest_notify_failed", redactForLogs(error?.message || error));
    });
  }
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

/* --- Screenshot pictures ---------------------------------------------------
 *
 * One JPEG per screenshot, beside the video in its Drive asset folder. The
 * upload is idempotent on the screenshot id, so a send that is retried, or a
 * review re-sent after an edit, replaces the picture rather than piling up
 * copies. Reading one back always goes through the analysis file first: a
 * screenshot id the analysis does not list as having a picture is a 404 with
 * no Drive lookup, and the Drive lookup itself is keyed on account, saved
 * video and screenshot so it cannot land on another video's picture.
 * ------------------------------------------------------------------------- */

async function handleSnapshotUpload(
  req: Request,
  accessToken: string,
  session: VideoTransferSession,
  snapshotIdRaw: string,
  diagnostics: ProviderDiagnostics = {}
) {
  if (!session.driveAssetFolderId) {
    throw new TransferError("DRIVE_UPLOAD_SESSION_EXPIRED", "Start the video upload before sending its screenshots.", 409);
  }
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_SNAPSHOT_IMAGE_BYTES) {
    return errorJson("DRIVE_UPLOAD_TOO_LARGE", "That screenshot is too large to upload.", 413);
  }
  const bytes = new Uint8Array(await req.arrayBuffer());
  const snapshotId = safeSnapshotId(snapshotIdRaw);
  const verdict = snapshotUploadVerdict({
    snapshotId,
    contentType: req.headers.get("content-type"),
    sizeBytes: bytes.byteLength,
  });
  if (verdict.ok === false) {
    return json({ error: "invalid_snapshot", message: verdict.reason }, verdict.status);
  }
  const props = snapshotImageAppProperties({
    accountId: session.accountId,
    savedVideoId: session.savedVideoId,
    snapshotId,
    clarityVersion,
  });
  const existing = await findDriveFile(accessToken, props, session.driveAssetFolderId, diagnostics);
  const file = existing?.id
    ? await replaceDriveFileContent(accessToken, existing.id, verdict.mimeType, bytes, "DRIVE_FINALIZE_FAILED", diagnostics)
    : await uploadBinaryFile(
        accessToken,
        session.driveAssetFolderId,
        snapshotImageFileName(snapshotId, verdict.mimeType),
        verdict.mimeType,
        props,
        bytes,
        diagnostics
      );
  return json({ ok: true, snapshotId, imageFileId: file.id });
}

async function readSessionAnalysis(provider: ClarityCloudProviderAdapter, session: VideoTransferSession) {
  if (!session.driveAnalysisFileId) return null;
  return provider.readJsonFile({ fileId: session.driveAnalysisFileId }).catch(() => null);
}

async function handleSnapshotList(provider: ClarityCloudProviderAdapter, session: VideoTransferSession) {
  const analysis = await readSessionAnalysis(provider, session);
  return json({ ok: true, snapshots: publicSnapshots(analysis) });
}

async function snapshotImageResponse(
  accessToken: string,
  provider: ClarityCloudProviderAdapter,
  session: VideoTransferSession,
  snapshotIdRaw: string,
  headers: Record<string, string>,
  diagnostics: ProviderDiagnostics = {}
) {
  const snapshotId = safeSnapshotId(snapshotIdRaw);
  const notFound = () =>
    new Response(JSON.stringify({ error: "not_found", message: "Screenshot not found." }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...headers },
    });
  if (!snapshotId || !session.driveAssetFolderId) return notFound();
  const analysis = await readSessionAnalysis(provider, session);
  if (!snapshotHasImage(analysis, snapshotId)) return notFound();
  const file = await findDriveFile(
    accessToken,
    snapshotImageAppProperties({
      accountId: session.accountId,
      savedVideoId: session.savedVideoId,
      snapshotId,
      clarityVersion,
    }),
    session.driveAssetFolderId,
    diagnostics
  );
  if (!file?.id) return notFound();
  const result = await provider.readFileRange({ fileId: file.id });
  const body =
    result instanceof Response
      ? await result.arrayBuffer()
      : (result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) as ArrayBuffer);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": file.mimeType || "image/jpeg",
      ...headers,
    },
  });
}

/** A send after the first one used to leave analysis.json exactly as the first
 *  upload wrote it, so a note typed or a screenshot taken afterwards never
 *  reached the player. The coach's later send now rewrites it in place. */
async function handleAnalysisRefresh(
  req: Request,
  accessToken: string,
  provider: ClarityCloudProviderAdapter,
  session: VideoTransferSession,
  diagnostics: ProviderDiagnostics = {}
) {
  if (session.status !== "ready" || !session.driveAnalysisFileId) {
    throw new TransferError("CLARITY_CLOUD_IMPORT_NOT_READY", "This video has not finished uploading yet.", 409);
  }
  const body = (await readJson(req)) as any;
  const analysisJson = removeDataUrls(body?.analysisJson || {}) as Record<string, unknown>;
  if (!analysisJson || typeof analysisJson !== "object" || !(analysisJson as any).analysis) {
    return json({ error: "invalid_analysis", message: "The analysis to save was missing." }, 400);
  }
  // A device that never held a picture (a copy imported before pictures
  // travelled, say) must not unlink one another device already uploaded.
  const previous = await readSessionAnalysis(provider, session);
  const merged = carryImageFileIds(previous, analysisJson);
  await replaceDriveFileContent(
    accessToken,
    session.driveAnalysisFileId,
    "application/json; charset=utf-8",
    JSON.stringify({ ...merged, savedVideoId: session.savedVideoId }, null, 2),
    "DRIVE_FINALIZE_FAILED",
    diagnostics
  );
  return json({ ok: true, analysisFileId: session.driveAnalysisFileId });
}

const privateImageHeaders = { "Cache-Control": "private, max-age=3600" };

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

async function listImportableSessions(accountId: string, playerId?: string) {
  // playerId narrows the query in Postgres rather than after the fact, so a
  // busy account's 50-row cap doesn't silently drop an older video that
  // belongs to the one player a coach is actually picking for.
  const playerFilter = playerId ? `&player_id=eq.${encodeURIComponent(playerId)}` : "";
  const rows = await supabase(transferSessionTable, {
    query: `select=*&account_id=eq.${encodeURIComponent(accountId)}${playerFilter}&catalogue_status=in.(ready_to_import,importing,imported,cleanup_scheduled,complete,repair_required)&order=ready_to_import_at.desc.nullslast,updated_at.desc&limit=50`,
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

async function handleImportList(accountId: string, provider: ClarityCloudProviderAdapter, playerId?: string) {
  const sessions = await listImportableSessions(accountId, playerId);
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
  // A coach-device transfer is retired once the coach's own device has taken
  // custody of it. A return is not: the coach importing their own returned
  // clip onto a second device says nothing about whether the player has
  // downloaded it, and scheduling cleanup here would start a clock on
  // somebody else's video.
  const schedulesCleanup = session.direction !== "coach-return";
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
    ...(schedulesCleanup
      ? {
          cleanupScheduledAt: now.toISOString(),
          cleanupAfter,
          cleanupStatus: "scheduled" as const,
        }
      : {}),
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

// Player-scoped video routes (/api/video-transfer/player/*). A logged-in player
// may only list and download videos whose transfer session player_id matches
// their own identity -- never another player's, and never the admin routes.
/**
 * Emails the coach that a player has sent them a video, and leaves a row in
 * notification_history so it shows up alongside every other message the system
 * sends. Both are best effort -- a failed email must never fail an upload that
 * has already landed in Drive.
 */
/**
 * Resolves the person a coach is returning a video to.
 *
 * A return may only ever be addressed to someone who already has portal
 * access, because the portal is the only place they could watch it. That is
 * also the authorisation check: the coach is proven by requireCoachActor, and
 * portal_players is scoped to their account, so a person id belonging to
 * another business resolves to nothing rather than to somebody else's client.
 *
 * A disabled portal player is refused rather than silently accepted. Revoking
 * access signs them out everywhere; filing a video for them to never see is
 * worse than saying so.
 */
async function readPortalPlayerForReturn(accountId: string, personId: string) {
  if (!accountId || !personId) return null;
  const rows = await supabase("portal_players", {
    query:
      `select=id,person_id,email,status&account_id=eq.${encodeURIComponent(accountId)}` +
      `&person_id=eq.${encodeURIComponent(personId)}&limit=1`,
  }).catch(() => []);
  const row = rows[0];
  if (!row) return null;
  if (cleanString(row.status, "", 40) === "disabled") return null;
  let name = "";
  const people = await supabase("people", {
    query: `select=name&id=eq.${encodeURIComponent(personId)}&account_id=eq.${encodeURIComponent(accountId)}&limit=1`,
  }).catch(() => []);
  name = cleanString(people[0]?.name, "", 180);
  return {
    portalPlayerId: cleanString(row.id, "", 80),
    playerId: cleanString(row.person_id, "", 160),
    playerEmail: cleanString(row.email, "", 180).toLowerCase(),
    playerName: name,
  };
}

/**
 * Reads "this upload is a return" off a coach's request body, or answers null
 * for the ordinary library sync that every other coach upload is.
 *
 * Deliberately explicit: nothing here infers a return from the fact that a
 * saved video happens to carry a player's id. The coach's whole library is
 * filed under player ids, and treating that as intent would email a player
 * every time their coach's laptop synced.
 */
async function resolveCoachReturn(req: Request, accountId: string): Promise<CoachReturn | null> {
  const body = (await req.clone().json().catch(() => ({}))) as any;
  if (body?.returnToPlayer !== true) return null;
  const personId = cleanString(
    body?.returnToPersonId || body?.savedVideo?.playerId || body?.playerId,
    "",
    160,
  );
  const target = personId ? await readPortalPlayerForReturn(accountId, personId) : null;
  if (!target) {
    throw new TransferError(
      "CLARITY_CLOUD_PROVIDER_FAILED",
      "That player does not have portal access, so they have nowhere to watch this. Give them portal access first.",
      409,
    );
  }
  return {
    ...target,
    message: cleanString(body?.message, "", 600),
    // Only the review send asks for this, and it asks per video as it uploads
    // them. Anything else sending a return gets its own email as before.
    deferNotification: body?.deferNotification === true,
  };
}

/**
 * Marks a return delivered and tells the player once.
 *
 * `returnedAt` is the idempotence key rather than a flag on the send path: a
 * retried finalize, a resumed upload and the already-in-Drive fast path all
 * arrive here, and a player should be told once about one video.
 */
async function deliverCoachReturn(session: VideoTransferSession): Promise<VideoTransferSession> {
  if (session.direction !== "coach-return" || session.returnedAt) return session;
  const delivered = await patchTransferSession(session, { returnedAt: new Date().toISOString() });
  // Delivered either way. What is held is the telling, not the handing over:
  // this video is one of several in a swing review, and the review send that
  // asked for it emails once, about all of them, when the last one is up.
  if (delivered.suppressReturnEmail) return delivered;
  await notifyPlayerOfCoachReturn(delivered).catch((error: any) => {
    console.warn("video_transfer:return_notify_failed", redactForLogs(error?.message || error));
  });
  return delivered;
}

/**
 * Emails the player that their coach has sent a video back.
 *
 * Unlike the coach's own alerts this goes to a real client address, so the
 * recipient is read from portal_players rather than from an env var, and the
 * body carries no video link -- the bytes live in the coach's Drive and are
 * only ever reachable through an authenticated portal session.
 */
async function notifyPlayerOfCoachReturn(session: VideoTransferSession) {
  const accountId = cleanString(session.accountId, "", 120);
  const portalPlayerId = cleanString(session.returnedToPortalPlayerId, "", 80);
  if (!portalPlayerId) return;
  const rows = await supabase("portal_players", {
    query:
      `select=email&id=eq.${encodeURIComponent(portalPlayerId)}` +
      `&account_id=eq.${encodeURIComponent(accountId)}&limit=1`,
  }).catch(() => []);
  const to = cleanString(rows[0]?.email, "", 180);
  const siteUrl =
    env("URL") || env("DEPLOY_PRIME_URL") || env("CLARITY_SITE_URL", "https://claritygolf.app");
  const subject = "Your coach sent you a video";
  const message = cleanString(session.coachMessage, "", 600);
  const lines = [
    "Your coach has sent a video back to your player portal.",
    message ? `\nTheir note: ${message}` : "",
    `\nSign in and open Videos to watch it: ${siteUrl}`,
  ].filter(Boolean);

  const delivery = await deliverEmail({
    accountId,
    to,
    subject,
    text: lines.join("\n"),
    idempotencyKey: `coach-return-${session.transferId}`,
  });

  await supabase("notification_history", {
    method: "POST",
    prefer: "return=minimal",
    body: {
      id: randomUUID(),
      account_id: accountId,
      person_key: session.playerId,
      recipient: to || "",
      subject,
      kind: "coach_video_return",
      status: delivery.sent ? "sent" : "skipped",
      provider: "resend",
      provider_id: delivery.id || "",
      error: delivery.reason || "",
      created_at: new Date().toISOString(),
    },
  }).catch(() => {
    // A log, not a dependency of the return.
  });
}

async function notifyCoachOfPlayerSubmission(session: VideoTransferSession) {
  // The transfer session names the business whose coach is being notified.
  const accountId = cleanString(session.accountId, "", 120);
  const to = env("CLARITY_ALERT_EMAIL") || env("CLARITY_COACH_EMAIL");
  const playerName = cleanString(session.submittedByName, "A player", 180);
  const subject = `${playerName} sent you a video`;
  const message = cleanString(session.playerMessage, "", 600);
  const lines = [
    `${playerName} has sent you a swing video through the player portal.`,
    message ? `\nTheir note: ${message}` : "",
    "\nOpen Player Profiles in Clarity Golf Booking to watch it.",
  ].filter(Boolean);

  const delivery = await deliverEmail({
    accountId,
    to,
    subject,
    text: lines.join("\n"),
    idempotencyKey: `player-submission-${session.transferId}`,
  });

  await supabase("notification_history", {
    method: "POST",
    prefer: "return=minimal",
    body: {
      id: randomUUID(),
      // notification_history is account-owned since the boundary migration and
      // the column is NOT NULL, so this insert needs the business the session
      // belongs to -- it used to write no owner at all.
      account_id: accountId,
      person_key: session.playerId,
      recipient: to || "",
      subject,
      kind: "player_video_submission",
      status: delivery.sent ? "sent" : "skipped",
      provider: "resend",
      provider_id: delivery.id || "",
      error: delivery.reason || "",
      created_at: new Date().toISOString(),
    },
  }).catch(() => {
    // notification_history is a log, not a dependency of the upload.
  });
}

/**
 * Emails the coach that someone with no account has sent them a video.
 *
 * The recipient is always the configured coach address and never the address
 * the sender typed. That single rule is what stops this being an open "someone
 * sent you a video" spam relay, and it is also why no verification email is
 * sent at registration: there is no address we are willing to mail.
 *
 * text/plain only. submittedByName, submittedByEmail and playerMessage are all
 * attacker-controlled -- a plaintext body has no injection surface. If an HTML
 * variant is ever added, every one of those three must go through escapeHtml.
 */
async function notifyCoachOfGuestSubmission(session: VideoTransferSession, coachViewToken: string) {
  const accountId = cleanString(session.accountId, "", 120);
  const to = env("CLARITY_ALERT_EMAIL") || env("CLARITY_COACH_EMAIL");
  const senderName = cleanString(session.submittedByName, "Someone", 180);
  const senderEmail = cleanString(session.submittedByEmail, "", 180);
  const message = cleanString(session.playerMessage, "", 600);
  const appUrl = (env("CLARITY_APP_URL", "") || "").replace(/\/$/, "");
  const shareUrl = appUrl
    ? `${appUrl}/?videoShare=${encodeURIComponent(coachViewToken)}`
    : "";
  const expiryLabel = session.coachViewExpiresAt
    ? new Date(session.coachViewExpiresAt).toDateString()
    : `${guestRetentionDays} days from now`;
  const subject = `${senderName} sent you a video`;
  const lines = [
    `${senderName} has sent you a swing video.`,
    "",
    // Say plainly that none of this is verified. They typed it themselves.
    `They say they are ${senderName}${senderEmail ? ` (${senderEmail})` : ""}. They do not have an account yet, so none of that has been checked.`,
    message ? `\nTheir note: ${message}` : "",
    shareUrl ? `\nWatch or download it here:\n${shareUrl}` : "\nOpen Clarity Golf Booking to watch it.",
    `\nThis link and the video expire on ${expiryLabel}. Adding them as a player from Clarity Golf Booking keeps the video for good.`,
  ].filter(Boolean);

  const delivery = await deliverEmail({
    accountId,
    to,
    subject,
    text: lines.join("\n"),
    idempotencyKey: `guest-submission-${session.transferId}`,
  });

  await supabase("notification_history", {
    method: "POST",
    prefer: "return=minimal",
    body: {
      id: randomUUID(),
      // notification_history is account-owned since the boundary migration and
      // the column is NOT NULL, so this insert needs the business the session
      // belongs to -- it used to write no owner at all.
      account_id: accountId,
      person_key: session.playerId,
      recipient: to || "",
      subject,
      kind: "guest_video_submission",
      status: delivery.sent ? "sent" : "skipped",
      provider: "resend",
      provider_id: delivery.id || "",
      error: delivery.reason || "",
      created_at: new Date().toISOString(),
    },
  }).catch(() => {
    // A log, not a dependency of the upload.
  });
}

/**
 * Guest-scoped video routes (/api/video-transfer/guest/*).
 *
 * A guest may create, upload to, finalize and cancel their own submissions.
 * That is all. There is deliberately no imports, download, import, pause or
 * seen route here: a guest can put bytes into the coach's Drive and can never
 * read a single one back out.
 *
 * Ownership is guest_sender_id and nothing else -- never the email/phone
 * candidate matching the player route uses, because a guest picks their own
 * email and every candidate form is therefore attacker-chosen. Misses answer
 * 404 rather than 403 so a guest cannot probe which saved video ids exist.
 */
async function handleGuestVideoRoute(
  req: Request,
  scope: GuestScope,
  sub: string[],
  diagnostics: ProviderDiagnostics,
) {
  assertClarityCloudServerConfigured(req);
  // The guest token names the business it was minted against. It used to be
  // compared against a settings-derived account, which was the same one for
  // everybody -- so the comparison below could never fail.
  const accountId = cleanString(scope.accountId, "", 120);
  if (!accountId) {
    throw Object.assign(new Error("This guest link is not attached to a business."), { status: 403 });
  }
  const settings = await readSettings(accountId);
  if (scope.accountId && scope.accountId !== accountId) {
    return json({ error: "not_found", message: "Video route not found." }, 404);
  }

  const savedVideoId = cleanString(sub[0], "", 160);
  if (!savedVideoId) return json({ error: "not_found", message: "Guest video route not found." }, 404);
  const owned = await readTransferSession(accountId, savedVideoId);
  const ownedByGuest = Boolean(
    owned && owned.direction === "guest-submission" && owned.guestSenderId === scope.id,
  );

  if (req.method === "POST" && sub[1] === "session") {
    if (owned && !ownedByGuest) {
      return json({ error: "not_found", message: "Video not found." }, 404);
    }
    const body = (await req.clone().json().catch(() => ({}))) as any;
    const sizeBytes = Number(body?.video?.sizeBytes || 0);
    if (sizeBytes > guestSubmissionMaxBytes) {
      return errorJson(
        "DRIVE_UPLOAD_TOO_LARGE",
        `That video is too large to send. The limit is ${Math.round(guestSubmissionMaxBytes / (1024 * 1024))} MB.`,
        413,
      );
    }
    // Resuming an interrupted upload must not count again.
    if (!owned) {
      if ((await guestSubmissionCount(accountId, scope.id)) >= guestSubmissionsLifetime) {
        return errorJson(
          "CLARITY_CLOUD_PROVIDER_FAILED",
          `You can send ${guestSubmissionsLifetime} videos without an account. Ask your coach to add you to keep sending.`,
          429,
        );
      }
      // The two account-wide brakes. Both answer with the same vague message:
      // a stranger has no business learning how full the coach's Drive is.
      if ((await guestSubmissionsTodayForAccount(accountId)) >= guestSubmissionsPerAccountPerDay) {
        return errorJson(
          "CLARITY_CLOUD_PROVIDER_FAILED",
          "Your coach is not accepting new videos right now. Try again tomorrow.",
          429,
        );
      }
      if ((await guestResidentBytes(accountId)) + sizeBytes > guestResidentBytesPerAccount) {
        return errorJson(
          "CLARITY_CLOUD_PROVIDER_FAILED",
          "Your coach is not accepting new videos right now. Try again tomorrow.",
          429,
        );
      }
    }

    const accessToken = await ensureDriveReady(accountId, diagnostics);
    return await handleSession(
      req,
      accountId,
      accessToken,
      settings,
      googleDriveProviderAdapter(accessToken, settings, diagnostics),
      savedVideoId,
      diagnostics,
      null,
      {
        guestSenderId: scope.id,
        playerId: `guest-${scope.id}`,
        name: scope.name,
        email: scope.email,
        message: cleanString(body?.message, "", 600),
      },
    );
  }

  if (!ownedByGuest) return json({ error: "not_found", message: "Video not found." }, 404);

  if (req.method === "GET" && (sub[1] === "session" || !sub[1])) {
    return json({ ok: true, session: publicTransferSession(owned!) });
  }
  if (req.method === "PUT" && (sub[1] === "chunk" || sub[1] === "upload")) {
    return await handleChunk(req, accountId, savedVideoId, googleDriveProviderAdapter("", settings, diagnostics));
  }
  if (req.method === "POST" && sub[1] === "finalize") {
    const accessToken = await ensureDriveReady(accountId, diagnostics);
    return await handleFinalize(
      req,
      accountId,
      accessToken,
      googleDriveProviderAdapter(accessToken, settings, diagnostics),
      savedVideoId,
    );
  }
  if (req.method === "DELETE" && (sub[1] === "session" || !sub[1])) {
    return await updateSessionStatus(
      accountId,
      savedVideoId,
      "cancelled",
      "Send cancelled. Your copy on this device was not deleted.",
    );
  }
  return json({ error: "not_found", message: "Guest video route not found." }, 404);
}

/**
 * The coach's no-login view of a guest submission. The token in the emailed
 * link is the whole credential, so it is deliberately narrow: one video,
 * read-only, expiring with the bytes it points at.
 */
async function readShareSession(token: string) {
  if (!token) return null;
  const rows = await supabase(transferSessionTable, {
    query: `select=*&coach_view_token_hash=eq.${encodeURIComponent(hashToken(token))}&limit=1`,
  }).catch(() => []);
  const session = rows[0] ? rowToSession(rows[0]) : null;
  if (!session || session.direction !== "guest-submission") return null;
  if (!session.coachViewExpiresAt) return null;
  if (new Date(session.coachViewExpiresAt).getTime() <= Date.now()) return null;
  if (session.status !== "ready" || !session.driveVideoFileId) return null;
  return session;
}

const shareResponseHeaders = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
};

async function handleShareRoute(
  req: Request,
  token: string,
  action: string,
  diagnostics: ProviderDiagnostics,
) {
  const session = await readShareSession(cleanString(token, "", 400));
  // One flat 404 for expired, wrong and never-existed alike.
  if (!session) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...shareResponseHeaders },
    });
  }

  const accountId = cleanString(session.accountId, "", 120);
  if (!accountId) {
    throw Object.assign(new Error("This share link is not attached to a business."), { status: 403 });
  }
  const settings = await readSettings(accountId);

  if (!action) {
    let manifest: any = {};
    try {
      const accessToken = await ensureDriveReady(accountId, diagnostics);
      const provider = googleDriveProviderAdapter(accessToken, settings, diagnostics);
      manifest = session.driveManifestFileId
        ? await provider.readJsonFile({ fileId: session.driveManifestFileId }).catch(() => ({}))
        : {};
    } catch {
      // Metadata is a nicety; the page still renders without it.
    }
    // Deliberately narrow: no Drive ids, no account id, no saved video id, and
    // nothing at all about the coach's other transfers.
    return new Response(
      JSON.stringify({
        ok: true,
        video: {
          title: cleanString(manifest?.title, "Swing video", 180),
          sizeBytes: session.expectedSizeBytes,
          mimeType: cleanString(manifest?.video?.mimeType, "video/mp4", 80),
          duration: Number(manifest?.video?.duration || 0) || null,
          createdAt: session.createdAt,
        },
        sender: {
          name: cleanString(session.submittedByName, "Someone", 180),
          email: cleanString(session.submittedByEmail, "", 180),
          // Never let this page imply the identity was checked.
          verified: false,
        },
        message: cleanString(session.playerMessage, "", 600),
        expiresAt: session.coachViewExpiresAt,
      }),
      { status: 200, headers: { "Content-Type": "application/json", ...shareResponseHeaders } },
    );
  }

  if (action === "download") {
    const accessToken = await ensureDriveReady(accountId, diagnostics);
    const provider = googleDriveProviderAdapter(accessToken, settings, diagnostics);
    // Streamed server-side with the coach's own token. The Drive file's own
    // sharing is never touched, so the bytes never leave their account.
    const result = await provider.readFileRange({
      fileId: session.driveVideoFileId || "",
      range: req.headers.get("range") || undefined,
    });
    if (result instanceof Response) {
      const headers = new Headers(result.headers);
      Object.entries(shareResponseHeaders).forEach(([key, value]) => headers.set(key, value));
      return new Response(result.body, { status: result.status, statusText: result.statusText, headers });
    }
    const body = result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) as ArrayBuffer;
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/octet-stream", ...shareResponseHeaders },
    });
  }

  return new Response(JSON.stringify({ error: "not_found" }), {
    status: 404,
    headers: { "Content-Type": "application/json", ...shareResponseHeaders },
  });
}

async function handlePlayerVideoRoute(
  req: Request,
  scope: PlayerScope,
  sub: string[],
  diagnostics: ProviderDiagnostics,
) {
  assertClarityCloudServerConfigured(req);
  // The player's session names their coach's business.
  const accountId = cleanString(scope.accountId, "", 120);
  if (!accountId) {
    throw Object.assign(new Error("This player session is not attached to a business."), { status: 403 });
  }
  const settings = await readSettings(accountId);
  // The business's own country, from its own settings -- not a module-level
  // value left behind by whichever business this warm instance served last.
  const candidates = playerVideoIdCandidates(scope, settings.accountCountry);

  if (req.method === "GET" && sub[0] === "imports") {
    const accessToken = await ensureDriveReady(accountId, diagnostics);
    const provider = googleDriveProviderAdapter(accessToken, settings, diagnostics);
    const sessions = (await listImportableSessions(accountId)).filter((s) => candidates.has(s.playerId));
    const transfers = await Promise.all(
      sessions.map(async (s) => importSummaryFromManifest(s, await readManifestForSession(provider, s))),
    );
    return json({ ok: true, transfers });
  }

  const savedVideoId = cleanString(sub[0], "", 160);
  if (!savedVideoId) return json({ error: "not_found", message: "Player video route not found." }, 404);
  const owned = await readTransferSession(accountId, savedVideoId);

  // --- Sending a video to the coach -------------------------------------
  //
  // Starting an upload is the one player route with no existing session to
  // check ownership against, so the guard is the other way round: if a session
  // for this saved video already exists it has to be theirs, and the player id
  // written to the new one is forced from their session rather than read from
  // the request.
  if (req.method === "POST" && sub[1] === "session") {
    if (owned && !candidates.has(owned.playerId)) {
      return json({ error: "not_found", message: "Video not found for this player." }, 404);
    }
    if (!scope.portalPlayerId) {
      return json(
        { error: "forbidden", message: "Ask your coach to set up portal access before sending videos." },
        403,
      );
    }

    const body = await req.clone().json().catch(() => ({})) as any;
    const sizeBytes = Number(body?.video?.sizeBytes || 0);
    if (sizeBytes > playerSubmissionMaxBytes) {
      return errorJson(
        "DRIVE_UPLOAD_TOO_LARGE",
        `That video is too large to send. The limit is ${Math.round(playerSubmissionMaxBytes / (1024 * 1024))} MB.`,
        413,
      );
    }
    // Resuming an interrupted upload must not count again.
    if (!owned && (await playerSubmissionsToday(accountId, scope.portalPlayerId)) >= playerSubmissionsPerDay) {
      return errorJson(
        "CLARITY_CLOUD_PROVIDER_FAILED",
        "You have sent a lot of videos today. Try again tomorrow, or talk to your coach.",
        429,
      );
    }

    const accessToken = await ensureDriveReady(accountId, diagnostics);
    return await handleSession(
      req,
      accountId,
      accessToken,
      settings,
      googleDriveProviderAdapter(accessToken, settings, diagnostics),
      savedVideoId,
      diagnostics,
      {
        playerId: scope.personId || scope.email,
        portalPlayerId: scope.portalPlayerId,
        name: scope.name,
        message: cleanString(body?.message, "", 600),
      },
    );
  }

  if (!owned || !candidates.has(owned.playerId)) {
    return json({ error: "not_found", message: "Video not found for this player." }, 404);
  }

  // Everything below acts on a transfer the player already owns. Mutating one
  // is restricted to their own submissions: a coach-device transfer that
  // happens to carry this player's id is the coach's, not theirs.
  const ownedSubmission = owned.direction === "player-submission";
  const mutating =
    req.method === "PUT" ||
    req.method === "DELETE" ||
    (req.method === "POST" && sub[1] !== "seen");
  if (mutating && !ownedSubmission) {
    return json({ error: "not_found", message: "Video not found for this player." }, 404);
  }

  // Opening a returned video clears its unseen dot in the portal.
  //
  // The one write a player is allowed to make to a row they did not create,
  // and it is narrow in both directions: only on a coach-return, and only to
  // player_seen_at. A player must never be able to reach coach_seen_at -- that
  // dot is the coach's record of what they have watched, and letting the
  // sender clear it would let a player mark their own submission read.
  if (req.method === "POST" && sub[1] === "seen") {
    if (owned.direction !== "coach-return") {
      return json({ error: "not_found", message: "Video not found for this player." }, 404);
    }
    const seen = await patchTransferSession(owned, {
      playerSeenAt: owned.playerSeenAt || new Date().toISOString(),
    });
    return json({ ok: true, session: publicTransferSession(seen) });
  }

  if (req.method === "PUT" && (sub[1] === "chunk" || sub[1] === "upload")) {
    return await handleChunk(req, accountId, savedVideoId, googleDriveProviderAdapter("", settings, diagnostics));
  }
  if (req.method === "POST" && sub[1] === "finalize") {
    const accessToken = await ensureDriveReady(accountId, diagnostics);
    return await handleFinalize(
      req,
      accountId,
      accessToken,
      googleDriveProviderAdapter(accessToken, settings, diagnostics),
      savedVideoId,
    );
  }
  if (req.method === "POST" && sub[1] === "pause") {
    return await updateSessionStatus(accountId, savedVideoId, "paused", "Paused");
  }
  if (req.method === "POST" && (sub[1] === "resume" || sub[1] === "retry")) {
    return await updateSessionStatus(accountId, savedVideoId, "uploading");
  }
  if (req.method === "DELETE" && (sub[1] === "session" || !sub[1])) {
    return await updateSessionStatus(
      accountId,
      savedVideoId,
      "cancelled",
      "Send cancelled. Your copy on this device was not deleted.",
    );
  }
  if (req.method === "GET" && sub[1] === "session") {
    const accessToken = "";
    return await handleSession(
      req,
      accountId,
      accessToken,
      settings,
      googleDriveProviderAdapter(accessToken, settings, diagnostics),
      savedVideoId,
      diagnostics,
    );
  }

  if (req.method === "GET" && sub[1] === "download") {
    const accessToken = await ensureDriveReady(accountId, diagnostics);
    return await handleImportDownload(req, accountId, googleDriveProviderAdapter(accessToken, settings, diagnostics), savedVideoId);
  }
  // The screenshots on a video the player can already see. Read-only, so the
  // coach-return rows their coach sent are as readable as their own uploads.
  if (req.method === "GET" && sub[1] === "snapshots") {
    const accessToken = await ensureDriveReady(accountId, diagnostics);
    const provider = googleDriveProviderAdapter(accessToken, settings, diagnostics);
    if (sub[2]) {
      return await snapshotImageResponse(accessToken, provider, owned, sub[2], privateImageHeaders, diagnostics);
    }
    return await handleSnapshotList(provider, owned);
  }
  if (req.method === "GET" && sub[1] === "import") {
    const accessToken = await ensureDriveReady(accountId, diagnostics);
    return await handleImportPackage(accountId, googleDriveProviderAdapter(accessToken, settings, diagnostics), savedVideoId);
  }
  return json({ error: "not_found", message: "Player video route not found." }, 404);
}

/**
 * `options.resolveAccountId` is a test seam, the same shape
 * handlePublicBookingSlotsRequest uses: auth now resolves through Postgres, and
 * a unit test asserting the Drive-configuration error shapes has no database.
 * Netlify never passes it, so production always goes through requireCoachActor.
 */
export default async function handler(
  req: Request,
  _context?: unknown,
  options: { resolveAccountId?: (req: Request) => Promise<string> } = {},
) {
  const cors = corsHeaders(req);
  if (!cors) return routeVideoTransferRequest(req, options);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const response = await routeVideoTransferRequest(req, options);
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(cors)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Deletes guest videos whose retention has run out.
 *
 * Scope is the load-bearing part of this function and MUST NOT WIDEN.
 * cleanup_after is also written by handleImportReceipt for coach-device
 * transfers the coach has already imported -- those rows carry
 * cleanup_status 'scheduled' too, and nothing has ever read them. Sweeping
 * them would delete the coach's own imported videos out of their own Drive.
 * The `direction = guest-submission` clause is what prevents that, and
 * `claimed_at is null` is the second guard: a guest the coach has added is a
 * player now, and players' videos are kept.
 *
 * Lives here rather than in the scheduled function because everything it needs
 * -- the Drive adapter, the token refresh, the session table -- is private to
 * this module. The scheduled function is a thin wrapper, the same way
 * akahu-poll wraps _shared/akahu.
 */
export async function purgeExpiredGuestSubmissions(limit = 25) {
  const now = new Date().toISOString();
  const rows = await supabase(transferSessionTable, {
    query:
      `select=*&direction=eq.guest-submission&claimed_at=is.null` +
      `&cleanup_after=not.is.null&cleanup_after=lt.${encodeURIComponent(now)}` +
      `&cleanup_status=in.(scheduled,failed)` +
      `&order=cleanup_after.asc&limit=${limit}`,
  }).catch(() => []);
  const sessions = (Array.isArray(rows) ? rows : []).map(rowToSession);
  if (!sessions.length) return { scanned: 0, purged: 0, failed: 0 };

  let purged = 0;
  let failed = 0;

  for (const session of sessions) {
    try {
      // Each expired session names its own business; the purge walks them
      // rather than assuming one Drive for everybody.
      const accountId = cleanString(session.accountId, "", 120);
      if (!accountId) {
        console.warn("video_transfer:purge_session_without_account", session.transferId);
        failed += 1;
        continue;
      }
      const settings = await readSettings(accountId);
      const accessToken = await ensureDriveReady(accountId, {});
      const provider = googleDriveProviderAdapter(accessToken, settings, {});
      await provider.deleteTransferAsset({ assetFolderId: session.driveAssetFolderId });
      await patchTransferSession(session, {
        status: "expired",
        catalogueStatus: "expired",
        cleanupStatus: "complete",
        // The emailed link has to die with the bytes, not 404 on a token that
        // still resolves to a row.
        coachViewTokenHash: undefined,
        coachViewExpiresAt: undefined,
      });
      purged += 1;
    } catch (error) {
      failed += 1;
      // Left as 'failed' rather than 'complete', and the query above picks
      // failed rows back up, so the next run retries it.
      await patchTransferSession(session, { cleanupStatus: "failed" }).catch(() => {});
      console.error(
        "guest_submission_purge:row_failed",
        redactForLogs(error instanceof Error ? error.message : String(error)),
      );
    }
  }

  return { scanned: sessions.length, purged, failed };
}

/**
 * Guest sender rows outlive their videos by design -- the token has to keep
 * working so the app can ask whether a coach has added them. But an unclaimed
 * sender who has not opened the app in three months is never coming back, and
 * the table would otherwise grow without bound behind the daily-registration
 * counter's index.
 */
export async function purgeStaleGuestSenders(days = 90) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const rows = await supabase("guest_senders", {
    query:
      `select=id&claimed_at=is.null&last_seen_at=lt.${encodeURIComponent(cutoff)}&limit=200`,
  }).catch(() => []);
  let removed = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = cleanString(row?.id, "", 80);
    if (!id) continue;
    // Never orphan a live transfer: if anything of theirs is still in Drive,
    // leave the sender row alone until the video purge has been through.
    const live = await supabase(transferSessionTable, {
      query: `select=transfer_id&guest_sender_id=eq.${encodeURIComponent(id)}&cleanup_status=neq.complete&limit=1`,
    }).catch(() => [{}]);
    if (Array.isArray(live) && live.length) continue;
    await supabase("guest_senders", {
      method: "DELETE",
      prefer: "return=minimal",
      query: `id=eq.${encodeURIComponent(id)}`,
    }).catch(() => {});
    removed += 1;
  }
  return { removed };
}


/* ---------------------------------------------------------------------------
 * A swing review, handed over.
 *
 * Three routes. One is the coach's ("send this review"), two are the player's
 * and neither asks who they are -- the token in the emailed link is the whole
 * credential, exactly as it is for the guest share above, and bounded the same
 * way: one review, read-only, expiring.
 *
 * The review is still not a record. These routes re-gather it from the same
 * places both apps do -- the returned videos wearing its lesson id, the lesson
 * notes filed under it, the practice hanging off its videos -- so a review
 * shared on Monday and added to on Tuesday shows Tuesday's work too, without
 * the coach re-sending. What the share row holds is the act of sending, not a
 * copy of what was sent.
 * ------------------------------------------------------------------------- */

const reviewShareTable = "swing_review_shares";

/** Lesson notes live in one settings row per business, the same JSON array
 *  booking-core reads and writes. Named here rather than inlined so the two
 *  stay findable together. */
function lessonNotesSettingKey(accountId: string) {
  return `lessonNotes.v1.${accountId}`;
}

type ReviewShareRecord = {
  id: string;
  accountId: string;
  lessonId: string;
  playerId: string;
  portalPlayerId: string;
  coachMessage: string;
  expiresAt: string;
};

/**
 * The share behind a link, or null.
 *
 * One flat null for revoked, expired, wrong and never-existed alike -- the page
 * renders one message for all four, and distinguishing them out loud would turn
 * the endpoint into an oracle for guessing tokens.
 */
async function readReviewShare(token: string): Promise<ReviewShareRecord | null> {
  if (!token) return null;
  const rows = await supabase(reviewShareTable, {
    query: `select=*&token_hash=eq.${encodeURIComponent(hashToken(token))}&limit=1`,
  }).catch(() => []);
  const row = rows[0];
  if (!row) return null;
  if (row.revoked_at) return null;
  const expiresAt = cleanString(row.expires_at, "", 40);
  if (!expiresAt || new Date(expiresAt).getTime() <= Date.now()) return null;
  return {
    id: cleanString(row.id, "", 80),
    accountId: cleanString(row.account_id, "", 120),
    lessonId: cleanString(row.lesson_id, "", 160),
    playerId: cleanString(row.player_id, "", 160),
    portalPlayerId: cleanString(row.portal_player_id, "", 80),
    coachMessage: cleanString(row.coach_message, "", 600),
    expiresAt,
  };
}

/**
 * The videos in a review, as the player was actually sent them.
 *
 * Deliberately only coach-returns. The coach's library syncs constantly and is
 * filed under player ids throughout, so a plain "every cloud video wearing this
 * lesson id" would put working footage the coach never chose to send in front
 * of the player.
 */
async function reviewReturnedSessions(accountId: string, playerId: string, lessonId: string) {
  const rows = await supabase(transferSessionTable, {
    query:
      `select=*&account_id=eq.${encodeURIComponent(accountId)}` +
      `&player_id=eq.${encodeURIComponent(playerId)}` +
      `&lesson_id=eq.${encodeURIComponent(lessonId)}` +
      `&direction=eq.coach-return&status=eq.ready&order=created_at.asc`,
  }).catch(() => []);
  return (rows as any[]).map(rowToSession).filter((session) => session.driveVideoFileId);
}

/** The review's notes: this business's lesson notes, narrowed to this review
 *  and this player. Both filters matter -- the setting holds every note the
 *  business has ever written. */
async function reviewLessonNotes(accountId: string, playerId: string, lessonId: string) {
  const rows = await supabase("settings", {
    query:
      `select=value&account_id=eq.${encodeURIComponent(accountId)}` +
      `&key=eq.${encodeURIComponent(lessonNotesSettingKey(accountId))}&limit=1`,
  }).catch(() => []);
  let parsed: any[] = [];
  try {
    const value = rows[0]?.value;
    parsed = value ? JSON.parse(value) : [];
  } catch {
    // A settings row that will not parse is an empty notes list, not a 500.
    parsed = [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(
      (note) =>
        cleanString(note?.lessonId, "", 160) === lessonId &&
        cleanString(note?.playerId, "", 160) === playerId,
    )
    .map((note, index) => ({
      id: cleanString(note?.id, "", 120) || `note-${index}`,
      title: cleanString(note?.title, "", 180) || "Lesson note",
      body: cleanString(note?.body, "", 8000),
      createdAt: cleanString(note?.createdAt || note?.updatedAt, "", 40),
    }))
    .filter((note) => note.body);
}

/** Practice is filed against a video, never against a review, so the only way
 *  back to it is through the review's own videos. Same rule as the portal. */
async function reviewPracticeBlocks(accountId: string, playerId: string, savedVideoIds: string[]) {
  if (!savedVideoIds.length) return [];
  const list = savedVideoIds.map((id) => `"${id.replace(/"/g, "")}"`).join(",");
  const rows = await supabase("practice_blocks", {
    query:
      `select=id,title,content,dose,status,linked_video_id&account_id=eq.${encodeURIComponent(accountId)}` +
      `&player_id=eq.${encodeURIComponent(playerId)}` +
      `&linked_video_id=in.(${encodeURIComponent(list)})&order=created_at.asc`,
  }).catch(() => []);
  return (rows as any[]).map((row, index) => ({
    id: cleanString(row?.id, "", 120) || `practice-${index}`,
    title: cleanString(row?.title, "", 180) || "Practice",
    content: cleanString(row?.content, "", 4000),
    dose: cleanString(row?.dose, "", 120),
    status: cleanString(row?.status, "", 40),
  }));
}

/** The business's own name and its coach's, which is who the player thinks
 *  sent this. Same three settings keys the From header is built from. */
async function reviewSenderIdentity(settings: Record<string, string>) {
  return {
    businessName: cleanString(settings.accountBusinessName, "", 120),
    coachName:
      cleanString(settings.notificationFromName, "", 120) ||
      cleanString(settings.accountCoachName, "", 120) ||
      cleanString(settings.accountBusinessName, "", 120),
  };
}

/**
 * Everything behind the link, assembled.
 *
 * Note what the payload does not carry: no Drive ids, no account id, no person
 * id, no transfer ids, nothing about any other review. The page is reachable by
 * whoever holds the token, so it is handed this review and no way to ask about
 * anything else. Videos are addressed by savedVideoId, which the stream route
 * re-checks against this same share.
 */
async function buildReviewSharePayload(
  share: ReviewShareRecord,
  settings: Record<string, string>,
  provider: ClarityCloudProviderAdapter,
): Promise<ReviewSharePayload> {
  const sessions = await reviewReturnedSessions(share.accountId, share.playerId, share.lessonId);
  const files = await Promise.all(
    sessions.map(async (session) => {
      // A manifest or analysis file that will not load costs that video its
      // title and its notes, not the whole page.
      const [manifest, analysis] = await Promise.all([
        session.driveManifestFileId
          ? provider.readJsonFile({ fileId: session.driveManifestFileId }).catch(() => ({}))
          : Promise.resolve({}),
        session.driveAnalysisFileId
          ? provider.readJsonFile({ fileId: session.driveAnalysisFileId }).catch(() => null)
          : Promise.resolve(null),
      ]);
      return { session, manifest: manifest as any, analysis: analysis as any };
    }),
  );

  const videos = files.map(({ session, manifest, analysis }) =>
    reviewShareVideo(
      {
        savedVideoId: session.savedVideoId,
        title: cleanString(manifest?.title, "", 180),
        mimeType: cleanString(manifest?.video?.mimeType, "", 80),
        sizeBytes: session.expectedSizeBytes,
        durationSeconds: Number(manifest?.video?.duration || 0) || null,
        createdAt: cleanString(manifest?.createdAt, "", 40) || session.createdAt,
      },
      analysis,
    ),
  );

  const [notes, practice, people] = await Promise.all([
    reviewLessonNotes(share.accountId, share.playerId, share.lessonId),
    reviewPracticeBlocks(
      share.accountId,
      share.playerId,
      sessions.map((session) => session.savedVideoId),
    ),
    supabase("people", {
      query:
        `select=name&id=eq.${encodeURIComponent(share.playerId)}` +
        `&account_id=eq.${encodeURIComponent(share.accountId)}&limit=1`,
    }).catch(() => []),
  ]);

  const identity = await reviewSenderIdentity(settings);
  return {
    playerName: cleanString(people[0]?.name, "", 180),
    coachName: identity.coachName,
    businessName: identity.businessName,
    reviewAt: reviewAt(share.lessonId, [
      ...videos.map((video) => video.createdAt),
      ...notes.map((note) => note.createdAt),
    ]),
    coachMessage: share.coachMessage,
    expiresAt: share.expiresAt,
    videos,
    notes,
    practice,
  };
}

/** Opening the link is worth recording -- it is the only signal the coach gets
 *  that the review landed. A log, never a gate: a failed write must not cost
 *  the player their page. */
async function recordReviewShareOpen(share: ReviewShareRecord) {
  const now = new Date().toISOString();
  await supabase(reviewShareTable, {
    method: "PATCH",
    prefer: "return=minimal",
    query: `id=eq.${encodeURIComponent(share.id)}`,
    body: { last_opened_at: now, first_opened_at: now },
  }).catch(() => {});
}

async function handleReviewShareRoute(
  req: Request,
  token: string,
  sub: string[],
  diagnostics: ProviderDiagnostics,
) {
  const share = await readReviewShare(cleanString(token, "", 400));
  if (!share) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...shareResponseHeaders },
    });
  }
  const settings = await readSettings(share.accountId);

  // The video itself. Streamed server-side with the coach's own token, exactly
  // as the guest share does, so the Drive file's own sharing is never touched
  // and the bytes never leave the coach's account.
  if (sub[0] === "video" && sub[1]) {
    const savedVideoId = cleanString(sub[1], "", 160);
    const sessions = await reviewReturnedSessions(share.accountId, share.playerId, share.lessonId);
    // The token addresses a review, so a saved video id outside it is a 404
    // rather than a stream. Without this check the link would read any video
    // in the business.
    const session = sessions.find((entry) => entry.savedVideoId === savedVideoId);
    if (!session?.driveVideoFileId) {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...shareResponseHeaders },
      });
    }
    const accessToken = await ensureDriveReady(share.accountId, diagnostics);
    const provider = googleDriveProviderAdapter(accessToken, settings, diagnostics);
    const result = await provider.readFileRange({
      fileId: session.driveVideoFileId,
      range: req.headers.get("range") || undefined,
    });
    if (result instanceof Response) {
      const headers = new Headers(result.headers);
      Object.entries(shareResponseHeaders).forEach(([key, value]) => headers.set(key, value));
      return new Response(result.body, { status: result.status, statusText: result.statusText, headers });
    }
    const body = result.buffer.slice(
      result.byteOffset,
      result.byteOffset + result.byteLength,
    ) as ArrayBuffer;
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/octet-stream", ...shareResponseHeaders },
    });
  }

  // A screenshot's picture, under the same rule as the video: only one from a
  // video inside this review.
  if (sub[0] === "snapshot" && sub[1] && sub[2]) {
    const savedVideoId = cleanString(sub[1], "", 160);
    const sessions = await reviewReturnedSessions(share.accountId, share.playerId, share.lessonId);
    const session = sessions.find((entry) => entry.savedVideoId === savedVideoId);
    if (!session) {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...shareResponseHeaders },
      });
    }
    const accessToken = await ensureDriveReady(share.accountId, diagnostics);
    return await snapshotImageResponse(
      accessToken,
      googleDriveProviderAdapter(accessToken, settings, diagnostics),
      session,
      sub[2],
      shareResponseHeaders,
      diagnostics
    );
  }

  if (sub.length) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...shareResponseHeaders },
    });
  }

  const accessToken = await ensureDriveReady(share.accountId, diagnostics);
  const payload = await buildReviewSharePayload(
    share,
    settings,
    googleDriveProviderAdapter(accessToken, settings, diagnostics),
  );
  await recordReviewShareOpen(share);
  return new Response(JSON.stringify({ ok: true, review: payload }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...shareResponseHeaders },
  });
}

/**
 * The coach's send.
 *
 * Runs after the review's videos have been uploaded as returns, because it is
 * the announcement rather than the delivery -- the videos are already in the
 * player's portal by the time this is called, and would be even if the email
 * failed. That ordering is deliberate: nothing here can leave a player holding
 * a link to a review that is not there.
 *
 * Re-sending is allowed and mints a fresh link. A coach who added a note the
 * day after is sending the same review again, not a second one, so the old
 * link is revoked rather than left alive beside the new one.
 */
async function handleReviewSend(req: Request, accountId: string, diagnostics: ProviderDiagnostics) {
  const body = (await readJson(req)) as any;
  const lessonId = cleanString(body?.lessonId, "", 160);
  const personId = cleanString(body?.personId, "", 160);
  const message = cleanString(body?.message, "", 600);
  if (!isSwingReviewLessonId(lessonId)) {
    throw new TransferError("CLARITY_CLOUD_PROVIDER_FAILED", "That is not a swing review.", 400);
  }

  const target = await readPortalPlayerForReturn(accountId, personId);
  const sessions = target
    ? await reviewReturnedSessions(accountId, target.playerId, lessonId)
    : [];
  const [notes, practice] = target
    ? await Promise.all([
        reviewLessonNotes(accountId, target.playerId, lessonId),
        reviewPracticeBlocks(
          accountId,
          target.playerId,
          sessions.map((session) => session.savedVideoId),
        ),
      ])
    : [[], []];

  const verdict = reviewSendVerdict({
    target: target
      ? {
          portalPlayerId: target.portalPlayerId,
          personId: target.playerId,
          email: target.playerEmail,
          name: target.playerName,
        }
      : null,
    videoCount: sessions.length,
    noteCount: notes.length,
    practiceCount: practice.length,
  });
  if (verdict.ok === false) {
    throw new TransferError("CLARITY_CLOUD_PROVIDER_FAILED", verdict.reason, 409);
  }
  const player = target!;

  // One live link per review. The previous one is revoked in the same breath
  // as the new one is written, so a re-send never leaves two doors open.
  await supabase(reviewShareTable, {
    method: "PATCH",
    prefer: "return=minimal",
    query:
      `account_id=eq.${encodeURIComponent(accountId)}` +
      `&lesson_id=eq.${encodeURIComponent(lessonId)}&revoked_at=is.null`,
    body: { revoked_at: new Date().toISOString() },
  }).catch(() => {
    // A failed revoke leaves an older link alive. Worth logging, not worth
    // refusing to send the review the coach just finished.
    console.warn("video_transfer:review_share_revoke_failed", { lessonId });
  });

  const token = randomBytes(32).toString("base64url");
  const expiresAt = reviewShareExpiry();
  const shareId = randomUUID();
  await supabase(reviewShareTable, {
    method: "POST",
    prefer: "return=minimal",
    body: {
      id: shareId,
      account_id: accountId,
      lesson_id: lessonId,
      player_id: player.playerId,
      portal_player_id: player.portalPlayerId,
      token_hash: hashToken(token),
      recipient_email: player.playerEmail,
      coach_message: message,
      expires_at: expiresAt,
      created_at: new Date().toISOString(),
    },
  });

  const settings = await readSettings(accountId);
  const identity = await reviewSenderIdentity(settings);
  const appUrl = (env("CLARITY_APP_URL", "") || env("URL") || env("DEPLOY_PRIME_URL") || "").replace(/\/$/, "");
  const { subject, text } = reviewEmail({
    playerName: player.playerName,
    coachName: identity.coachName,
    coachMessage: message,
    shareUrl: reviewShareUrl(appUrl, token),
    portalUrl: appUrl,
    expiresAt,
    videoCount: sessions.length,
    noteCount: notes.length,
    practiceCount: practice.length,
  });

  const delivery = await deliverEmail({
    accountId,
    to: player.playerEmail,
    subject,
    text,
    // One review, one email, however many times a flaky network retried it.
    idempotencyKey: `swing-review-${shareId}`,
  });

  await supabase("notification_history", {
    method: "POST",
    prefer: "return=minimal",
    body: {
      id: randomUUID(),
      account_id: accountId,
      person_key: player.playerId,
      recipient: player.playerEmail,
      subject,
      kind: "swing_review_sent",
      status: delivery.sent ? "sent" : "skipped",
      provider: "resend",
      provider_id: delivery.id || "",
      error: delivery.reason || "",
      created_at: new Date().toISOString(),
    },
  }).catch(() => {
    // A log, not a dependency of the send.
  });

  void diagnostics;
  return json({
    ok: true,
    emailed: delivery.sent,
    emailReason: delivery.reason || "",
    recipient: player.playerEmail,
    shareUrl: reviewShareUrl(appUrl, token),
    expiresAt,
    videoCount: sessions.length,
    noteCount: notes.length,
    practiceCount: practice.length,
  });
}

async function routeVideoTransferRequest(
  req: Request,
  options: { resolveAccountId?: (req: Request) => Promise<string> } = {},
) {
  const url = new URL(req.url);
  const parts = url.pathname
    .replace(/^\/api\/video-transfer\/?/, "")
    .replace(/^\/\.netlify\/functions\/video-transfer\/?/, "")
    .split("/")
    .filter(Boolean);
  const diagnostics: ProviderDiagnostics = {};

  try {
    // Player-scoped routes run before the admin gate and require a player
    // session instead; the admin gate below is intentionally left untouched.
    if (parts[0] === "player") {
      const scope = await readPlayerScope(req);
      if (!scope) return json({ error: "unauthorized", message: "Player login required." }, 401);
      return await handlePlayerVideoRoute(req, scope, parts.slice(1), diagnostics);
    }

    // Same shape as the player branch above: its own credential, checked
    // before the admin gate, and nothing below this point is reachable with it.
    if (parts[0] === "guest") {
      const guestScope = await readGuestScope(req);
      if (!guestScope) return json({ error: "unauthorized", message: "Guest session required." }, 401);
      return await handleGuestVideoRoute(req, guestScope, parts.slice(1), diagnostics);
    }

    // The coach's emailed no-login link. Unauthenticated by design -- the token
    // is the credential -- so it also sits ahead of the admin gate.
    if (parts[0] === "share" && req.method === "GET") {
      return await handleShareRoute(req, parts[1] || "", parts[2] || "", diagnostics);
    }

    // The player's emailed no-login link to a whole swing review. Same bargain
    // as the share route above and for the same reason: asking someone to
    // remember a password before they can watch what their coach made for them
    // is exactly the friction the link exists to remove. Ahead of the admin
    // gate, and reachable with nothing but the token.
    if (parts[0] === "review" && parts[1] === "share" && req.method === "GET") {
      return await handleReviewShareRoute(req, parts[2] || "", parts.slice(3), diagnostics);
    }

    // Drive, folders and saved videos all belong to one business, so the coach
    // routes need the business the caller administers rather than "a session
    // exists". requireCoachActor throws 401/403 and the outer catch renders it.
    const accountId = options.resolveAccountId
      ? await options.resolveAccountId(req)
      : (await requireCoachActor(req)).accountId;
    if (req.method === "GET" && parts[0] === "diagnostics") {
      return json(getSafeClarityCloudGoogleRuntimeDiagnostic(req));
    }
    assertClarityCloudServerConfigured(req);
    const settings = await readSettings(accountId);
    // Only routes that talk to the Drive API need an access token. Chunk
    // uploads go straight to the stored resumable URL, so skipping the
    // refresh-token exchange here removes several round-trips per chunk.

    // Sending a finished review. Not a transfer of bytes -- those went up as
    // returns already -- so it needs no Drive token, only the coach's session.
    if (req.method === "POST" && parts[0] === "review" && parts[1] === "send") {
      return await handleReviewSend(req, accountId, diagnostics);
    }
    if (req.method === "POST" && parts[0] === "upload-session") {
      const body = await req.clone().json().catch(() => ({})) as any;
      const savedVideoId = cleanString(body?.savedVideoId || body?.savedVideo?.savedVideoId, "", 160);
      if (!savedVideoId) throw new TransferError("DRIVE_UPLOAD_VERIFY_FAILED", "Saved video id is required.", 400);
      const coachReturn = await resolveCoachReturn(req, accountId);
      const accessToken = await ensureDriveReady(accountId, diagnostics);
      // NOTE: every route below must use `return await` so rejections are caught
      // by this try/catch. A bare `return somePromise` escapes the try block and
      // crashes the function process (Netlify then returns an opaque 502).
      return await handleSession(req, accountId, accessToken, settings, googleDriveProviderAdapter(accessToken, settings, diagnostics), savedVideoId, diagnostics, null, null, coachReturn);
    }
    if (req.method === "GET" && parts[0] === "imports") {
      const accessToken = await ensureDriveReady(accountId, diagnostics);
      const playerId = cleanString(url.searchParams.get("playerId"), "", 160);
      return await handleImportList(accountId, googleDriveProviderAdapter(accessToken, settings, diagnostics), playerId || undefined);
    }
    if ((req.method === "POST" || req.method === "GET") && parts[1] === "session") {
      const coachReturn = req.method === "POST" ? await resolveCoachReturn(req, accountId) : null;
      const accessToken = req.method === "POST" ? await ensureDriveReady(accountId, diagnostics) : "";
      return await handleSession(req, accountId, accessToken, settings, googleDriveProviderAdapter(accessToken, settings, diagnostics), parts[0], diagnostics, null, null, coachReturn);
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
    if (parts[1] === "snapshots" || (req.method === "PUT" && parts[1] === "analysis")) {
      const session = await readTransferSession(accountId, parts[0]);
      if (!session) return json({ error: "not_found", message: "Transfer not found." }, 404);
      const accessToken = await ensureDriveReady(accountId, diagnostics);
      const provider = googleDriveProviderAdapter(accessToken, settings, diagnostics);
      if (req.method === "PUT" && parts[1] === "analysis") {
        return await handleAnalysisRefresh(req, accessToken, provider, session, diagnostics);
      }
      if (req.method === "PUT" && parts[2]) {
        return await handleSnapshotUpload(req, accessToken, session, parts[2], diagnostics);
      }
      if (req.method === "GET" && parts[2]) {
        return await snapshotImageResponse(accessToken, provider, session, parts[2], privateImageHeaders, diagnostics);
      }
      if (req.method === "GET") return await handleSnapshotList(provider, session);
      return json({ error: "not_found", message: "Video transfer route not found." }, 404);
    }
    // Opening a submission clears its unseen dot in Player Profiles.
    if (req.method === "POST" && parts[1] === "seen") {
      const session = await readTransferSession(accountId, parts[0]);
      if (!session) return json({ error: "not_found", message: "Transfer not found." }, 404);
      // coach_seen_at is the coach's dot on an incoming submission. A return is
      // outgoing and carries the player's dot instead, so this route leaves it
      // alone rather than quietly marking the wrong column.
      if (session.direction === "coach-return") {
        return json({ ok: true, session: publicTransferSession(session) });
      }
      const seen = await patchTransferSession(session, {
        coachSeenAt: session.coachSeenAt || new Date().toISOString(),
      });
      return json({ ok: true, session: publicTransferSession(seen) });
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
    // The auth boundary answers for itself. Without this, "not logged in" and
    // "no workspace membership" were both flattened into
    // CLARITY_CLOUD_PROVIDER_FAILED, which reads as a Google outage.
    if (error?.status === 401 || error?.status === 403) {
      // Same shape the old inline gate returned, so the client's handling of
      // "you are signed out" is unchanged.
      return json(
        {
          error: error.code || "unauthorized",
          message: error instanceof Error ? error.message : "Admin login required.",
        },
        error.status,
      );
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
