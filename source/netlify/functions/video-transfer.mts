import type { Config } from "@netlify/functions";
import { createHash, randomUUID } from "node:crypto";
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
export const defaultChunkSizeBytes = 8 * 1024 * 1024;
export const maxChunkSizeBytes = defaultChunkSizeBytes;
export const googleChunkGranularityBytes = 256 * 1024;
const transferSessionTtlMs = 1000 * 60 * 60 * 24;
const transferSessionTable = "video_transfer_sessions";

type TransferStatus =
  | "preparing"
  | "uploading"
  | "paused"
  | "verifying"
  | "ready"
  | "failed"
  | "cancelled"
  | "expired";

type TransferErrorCode =
  | "DRIVE_NOT_CONNECTED"
  | "DRIVE_SCOPE_MISSING"
  | "GOOGLE_RECONNECT_REQUIRED"
  | "DRIVE_FOLDER_PROVISION_FAILED"
  | "DRIVE_UPLOAD_SESSION_FAILED"
  | "DRIVE_UPLOAD_PROXY_FAILED"
  | "DRIVE_UPLOAD_TOO_LARGE"
  | "DRIVE_UPLOAD_SESSION_EXPIRED"
  | "DRIVE_UPLOAD_INTERRUPTED"
  | "DRIVE_UPLOAD_VERIFY_FAILED"
  | "DRIVE_FINALIZE_FAILED"
  | "SAVED_VIDEO_BLOB_MISSING"
  | "SAVED_VIDEO_SOURCE_MISSING"
  | "TRANSFER_PAUSED"
  | "TRANSFER_CANCELLED";

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

export type VideoTransferSession = {
  version: 1;
  transferId: string;
  savedVideoId: string;
  accountId: string;
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
  createdAt: string;
  updatedAt: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
};

class TransferError extends Error {
  constructor(
    public readonly code: TransferErrorCode,
    message: string,
    public readonly status = 400
  ) {
    super(message);
    this.name = "TransferError";
  }
}

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
  return {
    version: session.version,
    transferId: session.transferId,
    savedVideoId: session.savedVideoId,
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
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastErrorCode: session.lastErrorCode,
    lastErrorMessage: session.lastErrorMessage,
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
  if (!["preparing", "uploading"].includes(session.status)) {
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

async function ensureDriveReady(accountId: string) {
  const connection = await loadGoogleProviderConnection(accountId);
  if (!connection?.driveEnabled) {
    throw new TransferError("DRIVE_NOT_CONNECTED", "Connect Google Drive before sending saved videos.", 409);
  }
  if (connection.connectionStatus === "reconnect_required") {
    throw new TransferError("GOOGLE_RECONNECT_REQUIRED", "Reconnect Google before sending saved videos.", 409);
  }
  if (!hasGoogleScopes(connection, [googleDriveFileScope])) {
    throw new TransferError("DRIVE_SCOPE_MISSING", "Grant Google Drive permission before sending saved videos.", 409);
  }
  return getGoogleAccessToken(accountId, [googleDriveFileScope]);
}

async function googleJson<T>(accessToken: string, url: string, init: RequestInit = {}, errorCode: TransferErrorCode): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new TransferError(errorCode, "Google Drive returned an unexpected non-JSON response.", 502);
  }
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new TransferError(errorCode, data.error?.message || "Google Drive request failed.", response.status);
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

async function findDriveFile(accessToken: string, props: Record<string, string>, parentId?: string) {
  const query = driveQueryForAppProperties(props, parentId);
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q", query);
  url.searchParams.set("spaces", "drive");
  url.searchParams.set("fields", "files(id,name,mimeType,size,md5Checksum,parents,appProperties,webViewLink)");
  url.searchParams.set("pageSize", "1");
  const data = await googleJson<{ files?: DriveFile[] }>(accessToken, url.toString(), {}, "DRIVE_FOLDER_PROVISION_FAILED");
  return data.files?.[0] || null;
}

async function createDriveFile(accessToken: string, metadata: Record<string, unknown>) {
  return googleJson<DriveFile>(
    accessToken,
    "https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,size,parents,appProperties,webViewLink",
    {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(metadata),
    },
    "DRIVE_FOLDER_PROVISION_FAILED"
  );
}

async function ensureFolder(accessToken: string, name: string, props: Record<string, string>, parentId?: string) {
  const existing = await findDriveFile(accessToken, props, parentId);
  if (existing) return existing;
  return createDriveFile(accessToken, {
    name,
    mimeType: "application/vnd.google-apps.folder",
    ...(parentId ? { parents: [parentId] } : {}),
    appProperties: props,
  });
}

export async function ensureTransferFolders(accessToken: string, accountId: string, settings: Record<string, string>) {
  const root = settings.googleDriveRootFolderId
    ? ({ id: settings.googleDriveRootFolderId, name: "Clarity Golf" } as DriveFile)
    : await ensureFolder(accessToken, "Clarity Golf", {
        clarityType: "root-folder",
        clarityAccountId: accountId,
        clarityVersion,
      });
  const transfer = await ensureFolder(accessToken, "Video Transfer", {
    clarityType: "video-transfer-folder",
    clarityAccountId: accountId,
    clarityVersion,
  }, root.id);
  const inbox = await ensureFolder(accessToken, "Inbox", {
    clarityType: "video-transfer-inbox",
    clarityAccountId: accountId,
    clarityVersion,
  }, transfer.id);
  const imported = await ensureFolder(accessToken, "Imported", {
    clarityType: "video-transfer-imported",
    clarityAccountId: accountId,
    clarityVersion,
  }, transfer.id);
  const failed = await ensureFolder(accessToken, "Failed", {
    clarityType: "video-transfer-failed",
    clarityAccountId: accountId,
    clarityVersion,
  }, transfer.id);
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

async function ensureAssetFolder(accessToken: string, accountId: string, savedVideo: SafeSavedVideo, inboxFolderId: string) {
  return ensureFolder(accessToken, savedVideo.savedVideoId, appProperties(accountId, savedVideo, "video-transfer-asset-folder"), inboxFolderId);
}

async function uploadJsonFile(accessToken: string, folderId: string, name: string, props: Record<string, string>, payload: unknown) {
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
    "DRIVE_FINALIZE_FAILED"
  );
}

async function startResumableUpload(accessToken: string, accountId: string, savedVideo: SafeSavedVideo, folderId: string, video: UploadVideoMetadata) {
  const extension = extensionFor(video.fileName, video.mimeType);
  const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,md5Checksum,appProperties", {
    method: "POST",
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
  if (!response.ok) {
    throw new TransferError("DRIVE_UPLOAD_SESSION_FAILED", "Google Drive could not start a resumable upload.", response.status);
  }
  const uploadUrl = response.headers.get("location") || "";
  if (!uploadUrl) {
    throw new TransferError("DRIVE_UPLOAD_SESSION_FAILED", "Google Drive did not return a resumable upload URL.", 502);
  }
  const id = new URL(uploadUrl).searchParams.get("id") || "";
  return { uploadUrl, videoFileId: id };
}

async function uploadedFile(accessToken: string, fileId: string) {
  return googleJson<DriveFile>(
    accessToken,
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,size,md5Checksum,parents,appProperties`,
    {},
    "DRIVE_UPLOAD_VERIFY_FAILED"
  );
}

function rowToSession(row: any): VideoTransferSession {
  return {
    version: 1,
    transferId: row.transfer_id,
    savedVideoId: row.saved_video_id,
    accountId: row.account_id,
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
    last_error_code: session.lastErrorCode || null,
    last_error_message: session.lastErrorMessage || null,
  };
}

async function readTransferSession(accountId: string, savedVideoId: string) {
  const rows = await supabase(transferSessionTable, {
    query: `select=*&account_id=eq.${encodeURIComponent(accountId)}&saved_video_id=eq.${encodeURIComponent(savedVideoId)}&status=in.(preparing,uploading,paused,verifying,ready,failed)&order=created_at.desc&limit=1`,
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
  status: "preparing" | "uploading" | "ready" | "failed";
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

async function handleSession(req: Request, accountId: string, accessToken: string, settings: Record<string, string>, savedVideoId: string) {
  if (req.method === "GET") {
    const session = await readTransferSession(accountId, savedVideoId);
    if (!session) return json({ ok: true, status: "not-uploaded" });
    return json({ ok: true, session: publicTransferSession(session), ...publicTransferSession(session) });
  }

  const body = await readJson(req) as any;
  const { savedVideo, video } = validateUploadSessionPayload(body, savedVideoId);
  const existing = await readTransferSession(accountId, savedVideoId);
  if (existing?.status === "ready") return json({ ok: true, status: "ready", session: publicTransferSession(existing), ...publicTransferSession(existing) });
  if (existing && ["preparing", "uploading", "paused", "failed"].includes(existing.status)) {
    if (existing.expectedSizeBytes === video.sizeBytes && existing.checksumSha256 === video.checksumSha256) {
      const nextStatus: TransferStatus = existing.status === "paused" || existing.status === "failed" ? "uploading" : existing.status;
      const resumed = await patchTransferSession(existing, { status: nextStatus, lastErrorCode: undefined, lastErrorMessage: undefined });
      return json({ ok: true, status: resumed.status, session: publicTransferSession(resumed), ...publicTransferSession(resumed) });
    }
    await patchTransferSession(existing, {
      status: "failed",
      lastErrorCode: "DRIVE_UPLOAD_VERIFY_FAILED",
      lastErrorMessage: "Saved source changed before transfer completed.",
    });
  }

  const folders = await ensureTransferFolders(accessToken, accountId, settings);
  const assetFolder = await ensureAssetFolder(accessToken, accountId, savedVideo, folders.inbox.id);
  const existingReady = await findDriveFile(accessToken, appProperties(accountId, savedVideo, "manifest"), assetFolder.id);
  if (existingReady) {
    const ready = await saveTransferSession({
      version: 1,
      transferId: randomUUID(),
      savedVideoId,
      accountId,
      playerId: savedVideo.playerId,
      lessonId: savedVideo.lessonId,
      analysisId: savedVideo.analysisId,
      status: "ready",
      expectedSizeBytes: video.sizeBytes,
      checksumSha256: video.checksumSha256,
      acceptedOffsetBytes: video.sizeBytes,
      chunkSizeBytes: defaultChunkSizeBytes,
      driveAssetFolderId: assetFolder.id,
      driveManifestFileId: existingReady.id,
      resumableSessionUrl: "ready",
      resumableSessionCreatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return json({ ok: true, status: "ready", session: publicTransferSession(ready), ...publicTransferSession(ready) });
  }

  const uploadSession = await startResumableUpload(accessToken, accountId, savedVideo, assetFolder.id, video);
  const now = new Date();
  const session = await saveTransferSession({
    version: 1,
    transferId: randomUUID(),
    savedVideoId,
    accountId,
    playerId: savedVideo.playerId,
    lessonId: savedVideo.lessonId,
    analysisId: savedVideo.analysisId,
    status: "uploading",
    expectedSizeBytes: video.sizeBytes,
    checksumSha256: video.checksumSha256,
    acceptedOffsetBytes: 0,
    chunkSizeBytes: defaultChunkSizeBytes,
    driveAssetFolderId: assetFolder.id,
    driveVideoFileId: uploadSession.videoFileId,
    resumableSessionUrl: uploadSession.uploadUrl,
    resumableSessionCreatedAt: now.toISOString(),
    resumableSessionExpiresAt: new Date(now.getTime() + transferSessionTtlMs).toISOString(),
    sourceDeviceId: cleanString(body?.sourceDevice?.deviceId, "", 160) || undefined,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  await uploadJsonFile(
    accessToken,
    assetFolder.id,
    "manifest.json",
    appProperties(accountId, savedVideo, "provisional-manifest"),
    transferManifest({ accountId, savedVideo, video, assetFolderId: assetFolder.id, videoFileId: uploadSession.videoFileId, sourceDeviceId: session.sourceDeviceId, status: "uploading" })
  );
  console.info("video_transfer:resumable_session_created", {
    transferId: session.transferId,
    savedVideoId,
    accountId,
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

async function handleChunk(req: Request, accountId: string, savedVideoId: string) {
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
  const response = await fetch(session.resumableSessionUrl, {
    method: "PUT",
    headers: {
      "Content-Type": req.headers.get("content-type") || "application/octet-stream",
      "Content-Length": String(bytes.byteLength),
      "Content-Range": `bytes ${startByte}-${endByte}/${totalSize}`,
    },
    body: bytes,
  });

  if (response.status === 308) {
    const acceptedOffsetBytes = acceptedOffsetFromGoogle(response, endByte + 1);
    const next = await patchTransferSession(session, {
      status: "uploading",
      acceptedOffsetBytes,
      lastErrorCode: undefined,
      lastErrorMessage: undefined,
    });
    return json({ ok: true, status: "uploading", session: publicTransferSession(next), ...publicTransferSession(next) });
  }

  if (response.status === 200 || response.status === 201) {
    const data = await response.json().catch(() => ({})) as DriveFile;
    const next = await patchTransferSession(session, {
      status: "verifying",
      acceptedOffsetBytes: session.expectedSizeBytes,
      driveVideoFileId: data.id || session.driveVideoFileId,
      lastErrorCode: undefined,
      lastErrorMessage: undefined,
    });
    return json({ ok: true, status: "verifying", videoFileId: next.driveVideoFileId, session: publicTransferSession(next), ...publicTransferSession(next) });
  }

  if (response.status === 401 || response.status === 403) {
    const next = await patchTransferSession(session, {
      status: "failed",
      lastErrorCode: response.status === 401 ? "GOOGLE_RECONNECT_REQUIRED" : "DRIVE_SCOPE_MISSING",
      lastErrorMessage: "Reconnect Google Drive to continue.",
    });
    return json({ ok: false, error: next.lastErrorCode, message: next.lastErrorMessage, session: publicTransferSession(next) }, 409);
  }
  if (response.status === 404 || response.status === 410) {
    const next = await patchTransferSession(session, {
      status: "expired",
      lastErrorCode: "DRIVE_UPLOAD_SESSION_EXPIRED",
      lastErrorMessage: "Google resumable upload session expired. Start a new transfer session.",
    });
    return json({ ok: false, error: "DRIVE_UPLOAD_SESSION_EXPIRED", message: next.lastErrorMessage, session: publicTransferSession(next) }, 409);
  }
  if (response.status === 429 || response.status >= 500) {
    const next = await patchTransferSession(session, {
      status: "uploading",
      lastErrorCode: "DRIVE_UPLOAD_INTERRUPTED",
      lastErrorMessage: "Google Drive upload was interrupted. Retry the same chunk.",
    });
    return json({ ok: false, error: "DRIVE_UPLOAD_INTERRUPTED", message: next.lastErrorMessage, session: publicTransferSession(next) }, 503);
  }
  const next = await patchTransferSession(session, {
    status: "failed",
    lastErrorCode: "DRIVE_UPLOAD_PROXY_FAILED",
    lastErrorMessage: "Clarity could not complete the chunk upload.",
  });
  return json({ ok: false, error: "DRIVE_UPLOAD_PROXY_FAILED", message: next.lastErrorMessage, session: publicTransferSession(next) }, response.status || 502);
}

async function handleFinalize(req: Request, accountId: string, accessToken: string, savedVideoId: string) {
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
  const file = await uploadedFile(accessToken, driveVideoFileId);
  if (Number(file.size || 0) !== video.sizeBytes || Number(file.size || 0) !== session.expectedSizeBytes) {
    throw new TransferError("DRIVE_UPLOAD_VERIFY_FAILED", "Uploaded Drive video size did not match the saved source.", 409);
  }
  if (file.appProperties?.claritySavedVideoId !== savedVideo.savedVideoId || file.appProperties?.clarityAccountId !== accountId) {
    throw new TransferError("DRIVE_UPLOAD_VERIFY_FAILED", "Uploaded Drive file ownership metadata did not match.", 409);
  }
  const assetFolderId = file.parents?.[0] || session.driveAssetFolderId;
  const analysis = await uploadJsonFile(accessToken, assetFolderId, "analysis.json", appProperties(accountId, savedVideo, "analysis"), analysisJson);
  const manifestPayload = transferManifest({
    accountId,
    savedVideo,
    video,
    assetFolderId,
    videoFileId: file.id,
    analysisFileId: analysis.id,
    sourceDeviceId: session.sourceDeviceId,
    status: "ready",
  });
  const manifest = await uploadJsonFile(accessToken, assetFolderId, "manifest.json", appProperties(accountId, savedVideo, "manifest"), {
    ...manifestPayload,
    manifestFileId: undefined,
  });
  const ready = await patchTransferSession(session, {
    status: "ready",
    acceptedOffsetBytes: session.expectedSizeBytes,
    driveVideoFileId: file.id,
    driveAnalysisFileId: analysis.id,
    driveManifestFileId: manifest.id,
    lastErrorCode: undefined,
    lastErrorMessage: undefined,
  });
  return json({
    ok: true,
    status: "ready",
    message: "Ready on primary computer",
    assetFolderId,
    videoFileId: file.id,
    analysisFileId: analysis.id,
    manifestFileId: manifest.id,
    uploadedAt: new Date().toISOString(),
    session: publicTransferSession(ready),
  });
}

async function handleStatus(accountId: string, accessToken: string, settings: Record<string, string>, savedVideoId: string) {
  const session = await readTransferSession(accountId, savedVideoId);
  if (session) return json({ ok: true, status: session.status, session: publicTransferSession(session), ...publicTransferSession(session) });
  const folders = await ensureTransferFolders(accessToken, accountId, settings);
  const assetFolder = await findDriveFile(accessToken, {
    clarityType: "video-transfer-asset-folder",
    claritySavedVideoId: savedVideoId,
    clarityAccountId: accountId,
    clarityVersion,
  }, folders.inbox.id);
  if (!assetFolder) return json({ ok: true, status: "not-uploaded" });
  return json({ ok: true, status: "uploading", message: "Upload is not finalized.", assetFolderId: assetFolder.id });
}

async function updateSessionStatus(accountId: string, savedVideoId: string, status: TransferStatus, message?: string) {
  const session = await readTransferSession(accountId, savedVideoId);
  if (!session) throw new TransferError("DRIVE_UPLOAD_SESSION_EXPIRED", "Transfer session was not found.", 404);
  const next = await patchTransferSession(session, {
    status,
    lastErrorCode: status === "failed" ? "DRIVE_UPLOAD_INTERRUPTED" : undefined,
    lastErrorMessage: message,
  });
  return json({ ok: true, status: next.status, session: publicTransferSession(next), ...publicTransferSession(next) });
}

export default async function handler(req: Request) {
  const url = new URL(req.url);
  const parts = url.pathname
    .replace(/^\/api\/video-transfer\/?/, "")
    .replace(/^\/\.netlify\/functions\/video-transfer\/?/, "")
    .split("/")
    .filter(Boolean);

  try {
    if (!(await requireAdmin(req))) return json({ error: "unauthorized", message: "Admin login required." }, 401);
    const settings = await readSettings();
    const accountId = resolveGoogleAccountId(settings);
    const accessToken = await ensureDriveReady(accountId);

    if (req.method === "POST" && parts[0] === "upload-session") {
      const body = await req.clone().json().catch(() => ({})) as any;
      const savedVideoId = cleanString(body?.savedVideoId || body?.savedVideo?.savedVideoId, "", 160);
      if (!savedVideoId) throw new TransferError("DRIVE_UPLOAD_VERIFY_FAILED", "Saved video id is required.", 400);
      return handleSession(req, accountId, accessToken, settings, savedVideoId);
    }
    if ((req.method === "POST" || req.method === "GET") && parts[1] === "session") {
      return handleSession(req, accountId, accessToken, settings, parts[0]);
    }
    if (req.method === "PUT" && (parts[1] === "chunk" || parts[1] === "upload")) {
      return handleChunk(req, accountId, parts[0]);
    }
    if (req.method === "POST" && parts[1] === "pause") return updateSessionStatus(accountId, parts[0], "paused", "Paused");
    if (req.method === "POST" && (parts[1] === "resume" || parts[1] === "retry")) return updateSessionStatus(accountId, parts[0], "uploading");
    if (req.method === "POST" && parts[1] === "finalize") return handleFinalize(req, accountId, accessToken, parts[0]);
    if (req.method === "GET" && parts[1] === "status") return handleStatus(accountId, accessToken, settings, parts[0]);
    if (req.method === "DELETE" && (parts[1] === "session" || parts[0])) {
      const savedVideoId = parts[1] === "session" ? parts[0] : parts[0];
      return updateSessionStatus(accountId, savedVideoId, "cancelled", "Transfer cancelled. Local source was not deleted.");
    }
    return json({ error: "not_found", message: "Video transfer route not found." }, 404);
  } catch (error: any) {
    console.error("video_transfer:failed", parts.join("/") || "root", error?.code || "", error?.message || error);
    if (error instanceof TransferError) {
      return json({ ok: false, error: error.code, message: error.message }, error.status);
    }
    const code = error?.code === "GOOGLE_RECONNECT_REQUIRED" ? "GOOGLE_RECONNECT_REQUIRED" : "DRIVE_FINALIZE_FAILED";
    const status = error?.status || (code === "GOOGLE_RECONNECT_REQUIRED" ? 409 : 500);
    return json({ ok: false, error: code, message: error instanceof Error ? error.message : "Video transfer failed." }, status);
  }
}

export const config: Config = {
  path: "/api/video-transfer/*",
};
