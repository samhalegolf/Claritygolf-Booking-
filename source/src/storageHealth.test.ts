import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getClarityCloudActionLabel,
  getClarityCloudHealth,
  getLocalStorageActionLabel,
  getLocalStorageHealth,
  getSavedVideoCloudStatusLabel,
  getSavedVideoDeviceStatusLabel,
  type GoogleDriveTransferStatus,
} from "./storageHealth";
import type {
  ManagedLocalVideoLibraryStatus,
  SavedVideoItem,
} from "./modules/video-analysis/utils/savedVideoLibrary";

const localStatus = (overrides: Partial<ManagedLocalVideoLibraryStatus>): ManagedLocalVideoLibraryStatus => ({
  supported: true,
  configured: true,
  health: "healthy",
  message: "Healthy",
  ...overrides,
});

const cloudStatus = (overrides: Partial<GoogleDriveTransferStatus> = {}): GoogleDriveTransferStatus => ({
  configured: true,
  connected: false,
  state: "not_connected",
  calendarConnected: false,
  driveScopeGranted: false,
  accountEmail: "",
  redirectUri: "/api/google-drive/callback",
  scope: "https://www.googleapis.com/auth/drive.file",
  requestedScopes: "https://www.googleapis.com/auth/drive.file",
  rootFolderId: "",
  inboxFolderId: "",
  importedFolderId: "",
  failedFolderId: "",
  tokenEncryptionConfigured: true,
  providerStorageConfigured: true,
  blocker: "",
  message: "",
  uploadRouteReady: true,
  chunkedTransportReady: true,
  incomingImportReady: false,
  ...overrides,
});

const readyCloudStatus = (overrides: Partial<GoogleDriveTransferStatus> = {}) =>
  cloudStatus({
    connected: true,
    state: "connected",
    calendarConnected: true,
    driveScopeGranted: true,
    accountEmail: "coach@example.com",
    rootFolderId: "root",
    inboxFolderId: "inbox",
    importedFolderId: "imported",
    failedFolderId: "failed",
    incomingImportReady: true,
    ...overrides,
  });

const savedVideo = (overrides: Partial<SavedVideoItem> = {}): SavedVideoItem => ({
  version: 1,
  savedVideoId: "saved-1",
  playerId: "player-1",
  analysisId: "analysis-1",
  title: "Swing",
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z",
  sourceSide: "left",
  source: {
    mimeType: "video/mp4",
    sizeBytes: 100,
  },
  local: {
    status: "available",
    managed: { status: "healthy" },
  },
  analysisSnapshot: {
    id: "analysis-1",
    playerId: "player-1",
    videoId: "video-1",
    videoMeta: {
      title: "Swing",
      duration: 12,
      width: 1280,
      height: 720,
    },
    drawings: [],
    markers: [],
    notes: [],
    focusViews: [],
    focusSnapshots: [],
    narrationRefs: [],
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  },
  workspaceSnapshot: {
    version: 1,
    mode: "single",
    activeSide: "left",
    savedVideoIds: {},
    linkedPlayback: false,
    focusWindowOpen: false,
    focusWindowMode: "area",
    focusWindowSide: "left",
    focusAreaRect: null,
  },
  ...overrides,
});

describe("storage health model", () => {
  it("maps healthy local storage to Ready without a maintenance action", () => {
    const health = getLocalStorageHealth(localStatus({ health: "healthy" }));

    assert.equal(health.state, "ready");
    assert.equal(health.statusLabel, "Ready");
    assert.equal("action" in health, false);
  });

  it("maps missing local folder setup to an in-place Choose folder action", () => {
    const health = getLocalStorageHealth(localStatus({ configured: false, health: "not-configured" }));

    assert.equal(health.state, "needs-folder");
    assert.equal(getLocalStorageActionLabel("action" in health ? health.action : undefined), "Choose folder");
  });

  it("maps lost local permission to Reconnect folder", () => {
    const health = getLocalStorageHealth(localStatus({ health: "permission-lost" }));

    assert.equal(health.state, "reconnect-required");
    assert.equal(getLocalStorageActionLabel("action" in health ? health.action : undefined), "Reconnect folder");
  });

  it("does not call cache-only local storage Ready", () => {
    const health = getLocalStorageHealth(localStatus({ health: "repair-required" }));

    assert.equal(health.state, "cache-only");
    assert.notEqual(health.statusLabel, "Ready");
  });

  it("labels unsupported browsers as browser-only storage", () => {
    const health = getLocalStorageHealth(localStatus({ supported: false, configured: false, health: "unsupported" }));

    assert.equal(health.state, "unsupported");
    assert.equal(health.statusLabel, "Browser-only storage");
  });

  it("maps disconnected Cloud to Connect Clarity Cloud", () => {
    const health = getClarityCloudHealth(cloudStatus());

    assert.equal(health.state, "not-connected");
    assert.equal(getClarityCloudActionLabel("action" in health ? health.action : undefined), "Connect Clarity Cloud");
  });

  it("maps missing OAuth configuration to setup incomplete with setup details", () => {
    const health = getClarityCloudHealth(cloudStatus({
      configured: false,
      state: "blocked",
      safeErrorCode: "CLOUD_OAUTH_NOT_CONFIGURED",
      missingConfiguration: ["GOOGLE_CLIENT_ID or GOOGLE_CALENDAR_CLIENT_ID"],
    }));

    assert.equal(health.state, "setup-incomplete");
    assert.equal(health.statusLabel, "Setup incomplete");
    assert.equal(health.message, "Clarity Cloud is not configured for this environment.");
    assert.equal("safeErrorCode" in health ? health.safeErrorCode : "", "CLOUD_OAUTH_NOT_CONFIGURED");
    assert.equal(getClarityCloudActionLabel("action" in health ? health.action : undefined), "Open setup details");
  });

  it("maps missing Drive permission to Clarity Cloud permission required", () => {
    const health = getClarityCloudHealth(cloudStatus({
      connected: true,
      state: "permission_upgrade_required",
      calendarConnected: true,
    }));

    assert.equal(health.state, "permission-required");
    assert.equal(health.statusLabel, "Permission required");
    assert.match(health.message, /Clarity needs permission/);
  });

  it("does not show Cloud Ready when provider setup is incomplete", () => {
    const health = getClarityCloudHealth(readyCloudStatus({ inboxFolderId: "" }));

    assert.equal(health.state, "setup-incomplete");
    assert.notEqual(health.statusLabel, "Ready");
  });

  it("maps a fully operational Cloud provider to Ready", () => {
    const health = getClarityCloudHealth(readyCloudStatus());

    assert.equal(health.state, "ready");
    assert.equal(health.statusLabel, "Ready");
  });

  it("does not show Cloud Ready when transfer routes are unavailable", () => {
    const health = getClarityCloudHealth(readyCloudStatus({
      uploadRouteReady: false,
      incomingImportReady: false,
      safeErrorCode: "CLARITY_CLOUD_IMPORT_LIST_UNAVAILABLE",
    }));

    assert.equal(health.state, "temporarily-unavailable");
    assert.equal(health.statusLabel, "Temporarily unavailable");
    assert.equal(health.message, "Your local video is safe. The cloud transfer service could not be reached.");
  });

  it("keeps connect and disconnect out of the same primary Cloud action", () => {
    const connectedHealth = getClarityCloudHealth(readyCloudStatus());
    const disconnectedHealth = getClarityCloudHealth(cloudStatus());

    assert.equal("action" in connectedHealth, false);
    assert.equal(getClarityCloudActionLabel("action" in disconnectedHealth ? disconnectedHealth.action : undefined), "Connect Clarity Cloud");
  });

  it("keeps Advanced diagnostics collapsed by default through the product model", () => {
    const local = getLocalStorageHealth(localStatus({ health: "healthy" }));
    const cloud = getClarityCloudHealth(readyCloudStatus());

    assert.equal(local.state, "ready");
    assert.equal(cloud.providerLabel, "Google Drive");
  });

  it("keeps the provider name subtle and out of the Cloud product title", () => {
    const health = getClarityCloudHealth(readyCloudStatus());

    assert.equal(health.providerLabel, "Google Drive");
    assert.equal(health.statusLabel, "Ready");
    assert.notEqual(health.providerLabel, "Clarity Cloud");
  });

  it("does not surface raw provider errors in normal Cloud copy", () => {
    const health = getClarityCloudHealth(readyCloudStatus({
      state: "error",
      blocker: "Google 500 {raw stack https://example.com}",
      message: "Google 500 {raw stack https://example.com}",
    }));

    assert.equal(health.state, "temporarily-unavailable");
    assert.equal(health.message.includes("Google 500"), false);
    assert.equal(health.message.includes("https://"), false);
  });

  it("labels Cloud catalogue availability separately from device downloads", () => {
    const cloudOnly = savedVideo({
      local: { status: "missing" },
      cloud: { status: "ready", provider: "google-drive" },
    });
    const uploading = savedVideo({
      cloud: { status: "uploading", provider: "google-drive", progress: 42 },
    });

    assert.equal(getSavedVideoDeviceStatusLabel(cloudOnly), "Device • Not downloaded");
    assert.equal(
      getSavedVideoCloudStatusLabel(cloudOnly, {
        isUploading: false,
        cloudConnected: true,
        cloudState: "connected",
      }),
      "Cloud • Available",
    );
    assert.equal(
      getSavedVideoCloudStatusLabel(uploading, {
        isUploading: true,
        cloudConnected: true,
        cloudState: "connected",
      }),
      "Cloud • Uploading 42%",
    );
  });

  it("keeps device state successful when Cloud transfer fails", () => {
    const video = savedVideo({
      cloud: {
        status: "failed",
        provider: "google-drive",
        lastUploadErrorCode: "CHUNK_UPLOAD_UNAVAILABLE",
      },
    });

    assert.equal(getSavedVideoDeviceStatusLabel(video), "My Library • Saved permanently");
    assert.equal(
      getSavedVideoCloudStatusLabel(video, {
        isUploading: false,
        cloudConnected: true,
        cloudState: "connected",
      }),
      "Cloud • Upload failed - Retry",
    );
  });

  it("labels failed session creation as an upload retry state", () => {
    const video = savedVideo({
      cloud: {
        status: "failed",
        provider: "google-drive",
        lastUploadErrorCode: "DRIVE_UPLOAD_SESSION_FAILED",
      },
    });

    assert.equal(
      getSavedVideoCloudStatusLabel(video, {
        isUploading: false,
        cloudConnected: true,
        cloudState: "connected",
      }),
      "Cloud • Upload failed - Retry",
    );
  });

  it("shows separate Player Profile device and cloud labels", () => {
    const video = savedVideo({
      local: { status: "available", managed: { status: "permission-lost" } },
      cloud: { status: "not-uploaded" },
    });

    assert.equal(getSavedVideoDeviceStatusLabel(video), "Device • Available on this device");
    assert.equal(
      getSavedVideoCloudStatusLabel(video, {
        isUploading: false,
        cloudConnected: true,
        cloudState: "connected",
      }),
      "Cloud • Waiting to upload",
    );
  });

  it("shows waiting to upload when Cloud is not connected", () => {
    assert.equal(
      getSavedVideoCloudStatusLabel(savedVideo({ cloud: { status: "not-uploaded" } }), {
        isUploading: false,
        cloudConnected: false,
        cloudState: "not_connected",
      }),
      "Cloud • Waiting to upload",
    );
  });

  it("keeps setup and service blockers in the waiting-to-upload state", () => {
    const setupHealth = getClarityCloudHealth(cloudStatus({
      configured: false,
      state: "blocked",
      safeErrorCode: "CLOUD_OAUTH_NOT_CONFIGURED",
    }));
    assert.equal(
      getSavedVideoCloudStatusLabel(savedVideo({ cloud: { status: "not-uploaded" } }), {
        isUploading: false,
        cloudConnected: true,
        cloudState: "blocked",
        cloudHealth: setupHealth,
      }),
      "Cloud • Waiting to upload",
    );
    assert.equal(
      getSavedVideoCloudStatusLabel(savedVideo({ cloud: { status: "not-uploaded" } }), {
        isUploading: false,
        cloudConnected: true,
        cloudState: "error",
      }),
      "Cloud • Waiting to upload",
    );
  });

  it("keeps migration and reconnect actions available through local action labels", () => {
    const health = getLocalStorageHealth(localStatus({ health: "permission-lost" }));

    assert.equal(getLocalStorageActionLabel("action" in health ? health.action : undefined), "Reconnect folder");
  });

  it("never combines Ready with a blocked visible Cloud state", () => {
    const health = getClarityCloudHealth(readyCloudStatus({
      state: "blocked",
      blocker: "TRANSFER_SESSION_STORAGE_UNAVAILABLE",
    }));

    assert.equal(health.state, "setup-incomplete");
    assert.notEqual(health.statusLabel, "Ready");
  });
});
