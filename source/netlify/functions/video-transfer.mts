import type { Config } from "@netlify/functions";
import { createHash } from "node:crypto";
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

type TransferErrorCode =
  | "DRIVE_NOT_CONNECTED"
  | "DRIVE_SCOPE_MISSING"
  | "GOOGLE_RECONNECT_REQUIRED"
  | "DRIVE_FOLDER_PROVISION_FAILED"
  | "DRIVE_UPLOAD_SESSION_FAILED"
  | "DRIVE_UPLOAD_VERIFY_FAILED"
  | "DRIVE_FINALIZE_FAILED"
  | "SAVED_VIDEO_BLOB_MISSING";

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
  };
  analysisSnapshot?: unknown;
  workspaceSnapshot?: unknown;
  thumbnailDataUrl?: string;
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
  parents?: string[];
  appProperties?: Record<string, string>;
  webViewLink?: string;
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
    analysisSnapshot: candidate?.analysisSnapshot,
    workspaceSnapshot: candidate?.workspaceSnapshot,
    thumbnailDataUrl: cleanString(candidate?.thumbnailDataUrl, "", 4_000_000),
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
  url.searchParams.set("fields", "files(id,name,mimeType,size,parents,appProperties,webViewLink)");
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

async function ensureFolder(
  accessToken: string,
  name: string,
  props: Record<string, string>,
  parentId?: string
) {
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
  return ensureFolder(
    accessToken,
    savedVideo.savedVideoId,
    appProperties(accountId, savedVideo, "video-transfer-asset-folder"),
    inboxFolderId
  );
}

async function uploadJsonFile(
  accessToken: string,
  folderId: string,
  name: string,
  props: Record<string, string>,
  payload: unknown
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
    "DRIVE_FINALIZE_FAILED"
  );
}

async function startResumableUpload(
  accessToken: string,
  accountId: string,
  savedVideo: SafeSavedVideo,
  folderId: string,
  video: UploadVideoMetadata
) {
  const extension = extensionFor(video.fileName, video.mimeType);
  const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,appProperties", {
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
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,size,parents,appProperties`,
    {},
    "DRIVE_UPLOAD_VERIFY_FAILED"
  );
}

function transferManifest(args: {
  accountId: string;
  savedVideo: SafeSavedVideo;
  video: UploadVideoMetadata;
  assetFolderId: string;
  videoFileId?: string;
  analysisFileId?: string;
  manifestFileId?: string;
  snapshotFileIds?: string[];
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
      deviceId: "browser",
    },
    status: args.status,
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
    snapshotFileIds: args.snapshotFileIds || [],
  };
}

async function handleUploadSession(req: Request, accountId: string, accessToken: string, settings: Record<string, string>) {
  const body = await readJson(req) as any;
  const savedVideo = validateSavedVideo(body.savedVideo);
  const video = validateVideoMetadata(body.video);
  const folders = await ensureTransferFolders(accessToken, accountId, settings);
  const assetFolder = await ensureAssetFolder(accessToken, accountId, savedVideo, folders.inbox.id);
  const existingReady = await findDriveFile(accessToken, appProperties(accountId, savedVideo, "manifest"), assetFolder.id);
  if (existingReady) {
    return json({
      ok: true,
      status: "ready",
      assetFolderId: assetFolder.id,
      manifestFileId: existingReady.id,
      message: "Ready on primary computer",
    });
  }
  const session = await startResumableUpload(accessToken, accountId, savedVideo, assetFolder.id, video);
  await uploadJsonFile(
    accessToken,
    assetFolder.id,
    "manifest.json",
    appProperties(accountId, savedVideo, "provisional-manifest"),
    transferManifest({ accountId, savedVideo, video, assetFolderId: assetFolder.id, videoFileId: session.videoFileId, status: "uploading" })
  );
  return json({
    ok: true,
    status: "uploading",
    uploadUrl: session.uploadUrl,
    videoFileId: session.videoFileId,
    assetFolderId: assetFolder.id,
  });
}

async function handleFinalize(req: Request, accountId: string, accessToken: string, savedVideoId: string) {
  const body = await readJson(req) as any;
  const savedVideo = validateSavedVideo(body.savedVideo, savedVideoId);
  const video = validateVideoMetadata(body.video);
  if (!video.driveFileId) {
    throw new TransferError("DRIVE_UPLOAD_VERIFY_FAILED", "Uploaded Drive video file id is required.", 400);
  }
  const file = await uploadedFile(accessToken, video.driveFileId);
  if (Number(file.size || 0) !== video.sizeBytes) {
    throw new TransferError("DRIVE_UPLOAD_VERIFY_FAILED", "Uploaded Drive video size did not match the saved source.", 409);
  }
  if (file.appProperties?.claritySavedVideoId !== savedVideo.savedVideoId || file.appProperties?.clarityAccountId !== accountId) {
    throw new TransferError("DRIVE_UPLOAD_VERIFY_FAILED", "Uploaded Drive file ownership metadata did not match.", 409);
  }
  const assetFolderId = file.parents?.[0] || "";
  if (!assetFolderId) {
    throw new TransferError("DRIVE_UPLOAD_VERIFY_FAILED", "Uploaded Drive video was not placed in the transfer folder.", 409);
  }
  const analysis = await uploadJsonFile(
    accessToken,
    assetFolderId,
    "analysis.json",
    appProperties(accountId, savedVideo, "analysis"),
    {
      savedVideoId: savedVideo.savedVideoId,
      analysis: savedVideo.analysisSnapshot,
      workspace: savedVideo.workspaceSnapshot,
      thumbnailDataUrl: savedVideo.thumbnailDataUrl || undefined,
    }
  );
  const manifestPayload = transferManifest({
    accountId,
    savedVideo,
    video,
    assetFolderId,
    videoFileId: file.id,
    analysisFileId: analysis.id,
    status: "ready",
  });
  const manifest = await uploadJsonFile(
    accessToken,
    assetFolderId,
    "manifest.json",
    appProperties(accountId, savedVideo, "manifest"),
    { ...manifestPayload, manifestFileId: undefined }
  );
  const uploadedAt = new Date().toISOString();
  return json({
    ok: true,
    status: "ready",
    message: "Ready on primary computer",
    assetFolderId,
    videoFileId: file.id,
    analysisFileId: analysis.id,
    manifestFileId: manifest.id,
    uploadedAt,
  });
}

async function handleStatus(accountId: string, accessToken: string, settings: Record<string, string>, savedVideoId: string) {
  const folders = await ensureTransferFolders(accessToken, accountId, settings);
  const pseudoVideo = {
    savedVideoId,
    playerId: "",
    analysisId: "",
    title: savedVideoId,
    createdAt: "",
    updatedAt: "",
  };
  const assetFolder = await findDriveFile(accessToken, {
    clarityType: "video-transfer-asset-folder",
    claritySavedVideoId: savedVideoId,
    clarityAccountId: accountId,
    clarityVersion,
  }, folders.inbox.id);
  if (!assetFolder) return json({ ok: true, status: "not-uploaded" });
  const manifest = await findDriveFile(accessToken, appProperties(accountId, pseudoVideo, "manifest"), assetFolder.id);
  return json({
    ok: true,
    status: manifest ? "ready" : "uploading",
    message: manifest ? "Ready on primary computer" : "Upload is not finalized.",
    assetFolderId: assetFolder.id,
    manifestFileId: manifest?.id,
  });
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
      return handleUploadSession(req, accountId, accessToken, settings);
    }
    if (req.method === "POST" && parts[1] === "finalize") {
      return handleFinalize(req, accountId, accessToken, parts[0]);
    }
    if (req.method === "GET" && parts[1] === "status") {
      return handleStatus(accountId, accessToken, settings, parts[0]);
    }
    if (req.method === "POST" && parts[1] === "retry") {
      return json({ ok: true, status: "retryable", message: "Start a new upload session to retry." });
    }
    if (req.method === "DELETE" && parts[0]) {
      return json({ ok: true, status: "cancelled", message: "Local retry state cleared. Drive cleanup is limited to finalized ownership validation." });
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
