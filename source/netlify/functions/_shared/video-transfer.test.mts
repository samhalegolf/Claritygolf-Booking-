import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultChunkSizeBytes,
  default as videoTransferHandler,
  googleChunkGranularityBytes,
  maxChunkSizeBytes,
  publicTransferSession,
  validateChunkRequest,
  validateFinalizePayload,
  validateUploadSessionPayload,
} from "../video-transfer.mts";
import googleDriveHandler from "../google-drive.mts";

const netlifyBufferedPayloadLimitBytes = 6 * 1024 * 1024;

test("chunk size stays under Netlify's 6 MB buffered payload limit and on Google's 256 KB granularity", () => {
  assert.ok(defaultChunkSizeBytes < netlifyBufferedPayloadLimitBytes, "chunks must fit inside Netlify's buffered request body limit");
  assert.equal(defaultChunkSizeBytes % googleChunkGranularityBytes, 0, "chunks must align to Google's 256 KB resumable granularity");
  assert.equal(maxChunkSizeBytes, defaultChunkSizeBytes);
});

const compactPayload = {
  savedVideoId: "saved-video-1",
  playerId: "player-1",
  lessonId: "lesson-1",
  analysisId: "analysis-1",
  title: "Player Name - 10 Jul 26 6:34 PM",
  createdAt: "2026-07-10T08:34:00.000Z",
  updatedAt: "2026-07-10T08:34:00.000Z",
  video: {
    fileName: "swing.mp4",
    mimeType: "video/mp4",
    sizeBytes: 12345,
    checksumSha256: "a".repeat(64),
  },
};

const cloudRuntimeEnvKeys = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_CALENDAR_CLIENT_ID",
  "GOOGLE_CALENDAR_CLIENT_SECRET",
  "GOOGLE_DRIVE_REDIRECT_URI",
  "GOOGLE_CALENDAR_REDIRECT_URI",
  "GOOGLE_PROVIDER_TOKEN_ENCRYPTION_KEY_V1",
] as const;

function snapshotEnv() {
  return Object.fromEntries(cloudRuntimeEnvKeys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>) {
  Object.entries(snapshot).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
}

function useCloudRuntimeEnv(values: Record<string, string | undefined>) {
  const snapshot = snapshotEnv();
  cloudRuntimeEnvKeys.forEach((key) => delete process.env[key]);
  process.env.SUPABASE_URL = "https://supabase.example";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
  Object.entries(values).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  return () => restoreEnv(snapshot);
}

function mockSupabaseFetch() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/rest/v1/admin_sessions")) return Response.json([{ id: "session-1" }]);
    if (url.includes("/rest/v1/settings")) return Response.json([]);
    if (url.includes("/rest/v1/google_provider_connections")) return Response.json([]);
    return Response.json([]);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("upload-session accepts compact ownership and video metadata", () => {
  const { savedVideo, video } = validateUploadSessionPayload(compactPayload);

  assert.equal(savedVideo.savedVideoId, "saved-video-1");
  assert.equal(savedVideo.playerId, "player-1");
  assert.equal(savedVideo.analysisId, "analysis-1");
  assert.equal(video.sizeBytes, 12345);
  assert.equal(video.checksumSha256, "a".repeat(64));
});

test("upload-session validation ignores heavy saved-video fields", () => {
  const { savedVideo } = validateUploadSessionPayload({
    ...compactPayload,
    analysisSnapshot: { markers: [{ thumbnail: "data:image/png;base64,abc" }] },
    workspaceSnapshot: { preview: "data:image/png;base64,def" },
    thumbnailDataUrl: "data:image/png;base64,ghi",
  });

  assert.equal("analysisSnapshot" in savedVideo, false);
  assert.equal("workspaceSnapshot" in savedVideo, false);
  assert.equal("thumbnailDataUrl" in savedVideo, false);
});

test("upload-session requires ownership metadata and video checksum", () => {
  assert.throws(
    () => validateUploadSessionPayload({ ...compactPayload, playerId: "" }),
    /ownership metadata is required/i,
  );
  assert.throws(
    () => validateUploadSessionPayload({ ...compactPayload, video: { ...compactPayload.video, checksumSha256: "bad" } }),
    /checksum is required/i,
  );
});

test("finalize accepts compact analysis JSON and strips accidental data URLs", () => {
  const { savedVideo, video, analysisJson } = validateFinalizePayload({
    ...compactPayload,
    video: {
      ...compactPayload.video,
      driveFileId: "drive-video-1",
    },
    analysisJson: {
      savedVideoId: "saved-video-1",
      analysis: {
        drawings: [{ id: "draw-1", type: "line", x1: 0, y1: 0, x2: 1, y2: 1 }],
        markers: [{ id: "marker-1", label: "Impact", time: 1.2, thumbnail: "data:image/png;base64,abc" }],
        focusSnapshots: [{ id: "focus-1", currentTime: 1.2, cropRect: { x: 0, y: 0, width: 1, height: 1 }, imageDataUrl: "data:image/png;base64,def" }],
      },
      workspace: { mode: "single", preview: "data:image/png;base64,ghi" },
    },
  }, "saved-video-1");

  const serialized = JSON.stringify(analysisJson);
  assert.equal(savedVideo.savedVideoId, "saved-video-1");
  assert.equal(video.driveFileId, "drive-video-1");
  assert.equal(serialized.includes("data:image"), false);
  assert.equal((analysisJson.analysis as any).drawings[0].id, "draw-1");
  assert.equal((analysisJson.analysis as any).markers[0].time, 1.2);
  assert.equal((analysisJson.analysis as any).focusSnapshots[0].cropRect.width, 1);
});

test("chunk endpoint requires admin before upload handling", async () => {
  const response = await videoTransferHandler(new Request("https://example.test/api/video-transfer/saved-video-1/chunk", {
    method: "PUT",
    body: new Blob(["video-bytes"], { type: "video/mp4" }),
  }));
  const body = await response.json() as any;

  assert.equal(response.status, 401);
  assert.equal(body.error, "unauthorized");
});

test("transfer routes return typed setup JSON when OAuth configuration is missing", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_CALENDAR_CLIENT_ID: process.env.GOOGLE_CALENDAR_CLIENT_ID,
    GOOGLE_CALENDAR_CLIENT_SECRET: process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
    GOOGLE_PROVIDER_TOKEN_ENCRYPTION_KEY_V1: process.env.GOOGLE_PROVIDER_TOKEN_ENCRYPTION_KEY_V1,
  };
  process.env.SUPABASE_URL = "https://supabase.example";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_CALENDAR_CLIENT_ID;
  delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  process.env.GOOGLE_PROVIDER_TOKEN_ENCRYPTION_KEY_V1 = "a".repeat(43);
  globalThis.fetch = async () => Response.json([{ id: "session-1" }]);
  try {
    const response = await videoTransferHandler(new Request("https://example.test/api/video-transfer/imports", {
      headers: { cookie: "clarity_session=session-token" },
    }));
    const body = await response.json() as any;

    assert.equal(response.status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "CLOUD_OAUTH_NOT_CONFIGURED");
    assert.equal(body.error.message, "Clarity Cloud is not configured for this environment.");
  } finally {
    globalThis.fetch = originalFetch;
    Object.entries(originalEnv).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
});

test("status and transfer routes share legacy Calendar OAuth resolution", async () => {
  const restoreRuntimeEnv = useCloudRuntimeEnv({
    GOOGLE_CALENDAR_CLIENT_ID: "legacy-client-id",
    GOOGLE_CALENDAR_CLIENT_SECRET: "legacy-client-secret",
    GOOGLE_DRIVE_REDIRECT_URI: "https://claritygolf.app/api/google-drive/callback",
  });
  const restoreFetch = mockSupabaseFetch();
  try {
    const statusResponse = await googleDriveHandler(new Request("https://claritygolf.app/api/google-drive/status", {
      headers: { cookie: "clarity_session=session-token" },
    }));
    const statusBody = await statusResponse.json() as any;

    assert.equal(statusResponse.status, 200);
    assert.equal(statusBody.configured, true);
    assert.equal(statusBody.safeErrorCode, "PROVIDER_STORAGE_UNAVAILABLE");
    assert.notEqual(statusBody.safeErrorCode, "CLOUD_OAUTH_NOT_CONFIGURED");

    const transferResponse = await videoTransferHandler(new Request("https://claritygolf.app/api/video-transfer/imports", {
      headers: { cookie: "clarity_session=session-token" },
    }));
    const transferBody = await transferResponse.json() as any;

    assert.equal(transferResponse.status, 503);
    assert.equal(transferBody.error.code, "PROVIDER_STORAGE_UNAVAILABLE");
    assert.notEqual(transferBody.error.code, "CLOUD_OAUTH_NOT_CONFIGURED");
  } finally {
    restoreFetch();
    restoreRuntimeEnv();
  }
});

test("safe transfer runtime diagnostics expose no values or lengths", async () => {
  const restoreRuntimeEnv = useCloudRuntimeEnv({
    GOOGLE_CLIENT_ID: "generic-client-id-value",
    GOOGLE_CLIENT_SECRET: "generic-client-secret-value",
    GOOGLE_CALENDAR_CLIENT_ID: "legacy-client-id-value",
    GOOGLE_CALENDAR_CLIENT_SECRET: "legacy-client-secret-value",
    GOOGLE_DRIVE_REDIRECT_URI: "https://claritygolf.app/api/google-drive/callback",
    GOOGLE_PROVIDER_TOKEN_ENCRYPTION_KEY_V1: "encryption-key-value",
  });
  const restoreFetch = mockSupabaseFetch();
  try {
    const response = await videoTransferHandler(new Request("https://claritygolf.app/api/video-transfer/diagnostics", {
      headers: { cookie: "clarity_session=session-token" },
    }));
    const body = await response.json() as any;
    const serialized = JSON.stringify(body);

    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(body).sort(), [
      "clientIdSource",
      "clientSecretSource",
      "configured",
      "driveRedirectUriPresent",
      "encryptionKeyPresent",
      "googleClientIdPresent",
      "googleClientSecretPresent",
      "missingFields",
      "redirectUriSource",
    ].sort());
    assert.equal(body.googleClientIdPresent, true);
    assert.equal(body.googleClientSecretPresent, true);
    assert.equal(body.driveRedirectUriPresent, true);
    assert.equal(body.encryptionKeyPresent, true);
    assert.equal(body.clientIdSource, "GOOGLE_CLIENT_ID");
    assert.equal(body.clientSecretSource, "GOOGLE_CLIENT_SECRET");
    assert.equal(body.redirectUriSource, "GOOGLE_DRIVE_REDIRECT_URI");
    assert.equal(body.configured, true);
    assert.deepEqual(body.missingFields, []);
    assert.equal(serialized.includes("generic-client-id-value"), false);
    assert.equal(serialized.includes("generic-client-secret-value"), false);
    assert.equal(serialized.includes("legacy-client-id-value"), false);
    assert.equal(serialized.includes("legacy-client-secret-value"), false);
    assert.equal(serialized.includes("encryption-key-value"), false);
    assert.equal("clientId" in body, false);
    assert.equal("clientSecret" in body, false);
  } finally {
    restoreFetch();
    restoreRuntimeEnv();
  }
});

test("public transfer session never exposes the Google resumable URL", () => {
  const publicSession = publicTransferSession({
    version: 1,
    transferId: "transfer-1",
    savedVideoId: "saved-video-1",
    accountId: "account-1",
    providerId: "google-drive",
    catalogueStatus: "uploading",
    playerId: "player-1",
    analysisId: "analysis-1",
    status: "uploading",
    expectedSizeBytes: 10,
    checksumSha256: "a".repeat(64),
    acceptedOffsetBytes: 4,
    chunkSizeBytes: defaultChunkSizeBytes,
    driveAssetFolderId: "folder-1",
    resumableSessionUrl: "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&secret=1",
    resumableSessionCreatedAt: "2026-07-10T00:00:00.000Z",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  });

  const serialized = JSON.stringify(publicSession);
  assert.equal(serialized.includes("googleapis.com"), false);
  assert.equal(serialized.includes("resumableSessionUrl"), false);
  assert.equal(publicSession.acceptedOffsetBytes, 4);
});

test("chunk validation rejects out-of-order overlapping and oversized chunks", () => {
  const session = {
    accountId: "account-1",
    savedVideoId: "saved-video-1",
    status: "session-created" as const,
    acceptedOffsetBytes: 4,
    expectedSizeBytes: 20,
    chunkSizeBytes: 8,
  };

  assert.throws(
    () => validateChunkRequest(session, {
      accountId: "account-1",
      savedVideoId: "saved-video-1",
      startByte: 0,
      endByte: 3,
      totalSize: 20,
      chunkLength: 4,
    }),
    /accepted transfer offset/i,
  );
  assert.throws(
    () => validateChunkRequest(session, {
      accountId: "account-1",
      savedVideoId: "saved-video-1",
      startByte: 4,
      endByte: 14,
      totalSize: 20,
      chunkLength: 11,
    }),
    /chunk size/i,
  );
  assert.throws(
    () => validateChunkRequest(session, {
      accountId: "account-1",
      savedVideoId: "saved-video-1",
      startByte: 4,
      endByte: 9,
      totalSize: 21,
      chunkLength: 6,
    }),
    /total size/i,
  );

  assert.equal(
    validateChunkRequest(session, {
      accountId: "account-1",
      savedVideoId: "saved-video-1",
      startByte: 4,
      endByte: 11,
      totalSize: 20,
      chunkLength: 8,
    }),
    true,
  );
});
