import type {
  ManagedLocalVideoLibraryStatus,
  SavedVideoItem,
} from "./modules/video-analysis/utils/savedVideoLibrary";
import {
  getSavedVideoCloudCatalogueState,
  getSavedVideoDeviceState,
} from "./modules/video-analysis/utils/savedVideoLibrary";
import { t } from "./lib/i18n";

export type GoogleDriveTransferState =
  | "not_connected"
  | "connected"
  | "reconnect_required"
  | "blocked"
  | "error";

export type GoogleDriveTransferStatus = {
  ok?: boolean;
  configured: boolean;
  connected: boolean;
  state: GoogleDriveTransferState;
  driveScopeGranted: boolean;
  accountEmail: string;
  redirectUri: string;
  scope: string;
  requestedScopes: string;
  rootFolderId: string;
  inboxFolderId: string;
  importedFolderId: string;
  failedFolderId: string;
  tokenEncryptionConfigured: boolean;
  providerStorageConfigured: boolean;
  blocker: string;
  message: string;
  uploadRouteReady?: boolean;
  chunkedTransportReady?: boolean;
  incomingImportReady?: boolean;
  safeErrorCode?: string;
  missingConfiguration?: string[];
};

export type LocalStorageAction =
  | "choose-folder"
  | "reconnect-folder"
  | "locate-library";

export type LocalStorageHealth =
  | {
      state: "ready";
      statusLabel: string;
      message: string;
      detail: string;
    }
  | {
      state: "needs-folder";
      statusLabel: string;
      message: string;
      detail: string;
      action: "choose-folder";
    }
  | {
      state: "reconnect-required";
      statusLabel: string;
      message: string;
      detail: string;
      action: "reconnect-folder";
    }
  | {
      state: "library-missing";
      statusLabel: string;
      message: string;
      detail: string;
      action: "locate-library";
    }
  | {
      state: "cache-only";
      statusLabel: string;
      message: string;
      detail: string;
      action?: "reconnect-folder";
      safeErrorCode?: string;
    }
  | {
      state: "unsupported";
      statusLabel: string;
      message: string;
      detail: string;
    }
  | {
      state: "error";
      statusLabel: string;
      message: string;
      detail: string;
      safeErrorCode?: string;
    };

export type ClarityCloudAction =
  | "connect"
  | "grant-permission"
  | "reconnect"
  | "open-setup-details"
  | "retry-setup"
  | "retry";

export type ClarityCloudProviderId = "google-drive";

export type ClarityCloudHealth =
  | {
      state: "ready";
      statusLabel: string;
      message: string;
      provider: ClarityCloudProviderId;
      providerLabel: string;
    }
  | {
      state: "not-connected";
      statusLabel: string;
      message: string;
      provider: ClarityCloudProviderId;
      providerLabel: string;
      action: "connect";
    }
  | {
      state: "permission-required";
      statusLabel: string;
      message: string;
      provider: ClarityCloudProviderId;
      providerLabel: string;
      action: "grant-permission";
    }
  | {
      state: "reconnect-required";
      statusLabel: string;
      message: string;
      provider: ClarityCloudProviderId;
      providerLabel: string;
      action: "reconnect";
    }
  | {
      state: "setup-incomplete";
      statusLabel: string;
      message: string;
      provider: ClarityCloudProviderId;
      providerLabel: string;
      action: "open-setup-details" | "retry-setup";
      safeErrorCode?: string;
    }
  | {
      state: "temporarily-unavailable";
      statusLabel: string;
      message: string;
      provider: ClarityCloudProviderId;
      providerLabel: string;
      action: "retry";
      safeErrorCode?: string;
    }
  | {
      state: "beta";
      statusLabel: string;
      message: string;
      provider: ClarityCloudProviderId;
      providerLabel: string;
    }
  | {
      state: "error";
      statusLabel: string;
      message: string;
      provider: ClarityCloudProviderId;
      providerLabel: string;
      safeErrorCode?: string;
    };

export type ClarityCloudProvider = {
  id: ClarityCloudProviderId;
  displayName: string;
  getHealth(status: GoogleDriveTransferStatus): ClarityCloudHealth;
};

const googleDriveProviderLabel = "Google Drive";

const cloudBase = {
  provider: "google-drive" as const,
  providerLabel: googleDriveProviderLabel,
};

const safeCode = (value: string | undefined, fallback: string) => {
  const code = (value || fallback)
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return code || fallback;
};

export function getLocalStorageHealth(status: ManagedLocalVideoLibraryStatus): LocalStorageHealth {
  if (!status.supported || status.health === "unsupported") {
    return {
      state: "unsupported",
      statusLabel: t("Browser-only storage"),
      message: t("This browser cannot use a managed computer folder. Videos stay in browser storage on this device."),
      detail: t("Browser IndexedDB cache and recovery"),
    };
  }

  if (!status.configured || status.health === "not-configured") {
    return {
      state: "needs-folder",
      statusLabel: t("Needs folder access"),
      message: t("Choose where Clarity should keep videos permanently on this computer."),
      detail: t("My Library"),
      action: "choose-folder",
    };
  }

  if (status.health === "healthy") {
    return {
      state: "ready",
      statusLabel: t("Ready"),
      message: t("My Library can keep permanent copies on this computer."),
      detail: t("My Library"),
    };
  }

  if (status.health === "permission-lost" || status.health === "read-only") {
    return {
      state: "reconnect-required",
      statusLabel: t("Reconnect required"),
      message: t("Clarity no longer has access to My Library."),
      detail: t("My Library"),
      action: "reconnect-folder",
    };
  }

  if (status.health === "missing" || status.health === "moved") {
    return {
      state: "library-missing",
      statusLabel: t("Library not found"),
      message: t("My Library may have been moved or renamed."),
      detail: t("My Library"),
      action: "locate-library",
    };
  }

  if (status.health === "repair-required") {
    return {
      state: "cache-only",
      statusLabel: t("Using browser backup"),
      message: t("Videos are protected on this device, but My Library needs attention."),
      detail: t("Browser IndexedDB cache and recovery"),
      action: "reconnect-folder",
      safeErrorCode: "LOCAL_LIBRARY_REPAIR_REQUIRED",
    };
  }

  return {
    state: "error",
    statusLabel: t("Needs attention"),
    message: t("My Library needs attention before it can keep permanent local copies."),
    detail: t("Browser IndexedDB cache and recovery"),
    safeErrorCode: safeCode(status.health, "LOCAL_STORAGE_UNAVAILABLE"),
  };
}

export function getLocalStorageActionLabel(action?: LocalStorageAction) {
  if (action === "choose-folder") return t("Choose folder");
  if (action === "reconnect-folder") return t("Reconnect folder");
  if (action === "locate-library") return t("Locate library");
  return "";
}

export function getClarityCloudHealth(status: GoogleDriveTransferStatus): ClarityCloudHealth {
  if (!status.configured || status.safeErrorCode === "CLOUD_OAUTH_NOT_CONFIGURED") {
    return {
      ...cloudBase,
      state: "setup-incomplete",
      statusLabel: t("Setup incomplete"),
      message: t("Clarity Cloud is not configured for this environment."),
      action: "open-setup-details",
      safeErrorCode: "CLOUD_OAUTH_NOT_CONFIGURED",
    };
  }

  if (status.state === "reconnect_required") {
    return {
      ...cloudBase,
      state: "reconnect-required",
      statusLabel: t("Reconnect required"),
      message: t("Your cloud connection needs to be refreshed."),
      action: "reconnect",
    };
  }

  if (!status.connected || status.state === "not_connected") {
    return {
      ...cloudBase,
      state: "not-connected",
      statusLabel: t("Not connected"),
      message: t("Connect Clarity Cloud to transfer saved videos between your devices."),
      action: "connect",
    };
  }

  if (!status.providerStorageConfigured || !status.tokenEncryptionConfigured) {
    return {
      ...cloudBase,
      state: "setup-incomplete",
      statusLabel: t("Setup incomplete"),
      message: t("Secure provider storage is unavailable."),
      action: "open-setup-details",
      safeErrorCode: safeCode(status.safeErrorCode || status.blocker, "PROVIDER_STORAGE_UNAVAILABLE"),
    };
  }

  if (!status.driveScopeGranted) {
    return {
      ...cloudBase,
      state: "permission-required",
      statusLabel: t("Permission required"),
      message: t("Clarity needs permission to transfer saved videos."),
      action: "grant-permission",
    };
  }

  if (status.state === "blocked") {
    return {
      ...cloudBase,
      state: "setup-incomplete",
      statusLabel: t("Setup incomplete"),
      message: t("Cloud storage is connected, but transfer setup is not complete."),
      action: "open-setup-details",
      safeErrorCode: safeCode(status.safeErrorCode || status.blocker || status.message, "CLARITY_CLOUD_SETUP_INCOMPLETE"),
    };
  }

  if (status.state === "error") {
    return {
      ...cloudBase,
      state: "temporarily-unavailable",
      statusLabel: t("Temporarily unavailable"),
      message: t("Clarity Cloud could not be reached. Your local videos are still safe."),
      action: "retry",
      safeErrorCode: safeCode(status.blocker || status.message, "CLARITY_CLOUD_UNAVAILABLE"),
    };
  }

  if (!status.inboxFolderId || !status.importedFolderId || !status.failedFolderId) {
    return {
      ...cloudBase,
      state: "setup-incomplete",
      statusLabel: t("Setup incomplete"),
      message: t("Transfer folder could not be prepared."),
      action: "retry-setup",
      safeErrorCode: "TRANSFER_FOLDER_UNAVAILABLE",
    };
  }

  if (status.uploadRouteReady === false || status.chunkedTransportReady === false) {
    return {
      ...cloudBase,
      state: "temporarily-unavailable",
      statusLabel: t("Temporarily unavailable"),
      message: t("Your local video is safe. The cloud transfer service could not be reached."),
      action: "retry",
      safeErrorCode: safeCode(status.safeErrorCode, "CHUNK_UPLOAD_UNAVAILABLE"),
    };
  }

  if (status.incomingImportReady !== true) {
    return {
      ...cloudBase,
      state: "temporarily-unavailable",
      statusLabel: t("Temporarily unavailable"),
      message: t("Your local video is safe. The cloud transfer service could not be reached."),
      action: "retry",
      safeErrorCode: safeCode(status.safeErrorCode, "CLARITY_CLOUD_IMPORT_LIST_UNAVAILABLE"),
    };
  }

  return {
    ...cloudBase,
    state: "ready",
    statusLabel: t("Ready"),
    message: t("Transfer saved videos between your devices."),
  };
}

export const googleDriveClarityCloudProvider: ClarityCloudProvider = {
  id: "google-drive",
  displayName: googleDriveProviderLabel,
  getHealth: getClarityCloudHealth,
};

export function getClarityCloudActionLabel(action?: ClarityCloudAction) {
  if (action === "connect") return t("Connect Clarity Cloud");
  if (action === "grant-permission") return t("Grant permission");
  if (action === "reconnect") return t("Reconnect Clarity Cloud");
  if (action === "open-setup-details") return t("Open setup details");
  if (action === "retry-setup") return t("Retry setup");
  if (action === "retry") return t("Retry");
  return "";
}

export function getSavedVideoDeviceStatusLabel(video: SavedVideoItem) {
  const device = getSavedVideoDeviceState(video);
  if (device.status === "permanent") return t("My Library • Saved permanently");
  if (device.status === "cached") return t("Device • Available on this device");
  if (device.status === "recovery-only") return t("Device • Recovery copy safe");
  if (device.status === "downloading") return t("Device • Downloading");
  if (device.status === "download-failed") return t("Device • Download failed");
  return t("Device • Not downloaded");
}

export const getSavedVideoLocalStatusLabel = getSavedVideoDeviceStatusLabel;

export function getSavedVideoCloudStatusLabel(
  video: SavedVideoItem,
  options: {
    isUploading: boolean;
    cloudConnected: boolean;
    cloudState: GoogleDriveTransferState;
    cloudHealth?: ClarityCloudHealth;
  }
) {
  const catalogueState = getSavedVideoCloudCatalogueState(video);
  if (catalogueState === "ready") return t("Cloud • Available");
  if (catalogueState === "paused") return t("Cloud • Upload paused");
  if (catalogueState === "verifying") return t("Cloud • Verifying");
  if (catalogueState === "preparing") return t("Cloud • Preparing Clarity Cloud");
  if (options.isUploading) {
    const progress = Math.max(0, Math.min(100, Math.round(video.cloud?.progress || 0)));
    return t("Cloud • Uploading {progress}%", { progress });
  }
  if (catalogueState === "uploading") {
    const progress = Math.max(0, Math.min(100, Math.round(video.cloud?.progress || 0)));
    return t("Cloud • Uploading {progress}%", { progress });
  }
  if (catalogueState === "failed") {
    const setupBlocked =
      video.cloud?.lastUploadErrorCode === "CLOUD_OAUTH_NOT_CONFIGURED" ||
      video.cloud?.lastUploadErrorCode === "PROVIDER_STORAGE_UNAVAILABLE" ||
      video.cloud?.lastUploadErrorCode === "DRIVE_NOT_CONNECTED" ||
      video.cloud?.lastUploadErrorCode === "DRIVE_SCOPE_MISSING" ||
      video.cloud?.lastUploadErrorCode === "GOOGLE_RECONNECT_REQUIRED";
    return setupBlocked ? t("Cloud • Waiting to upload") : t("Cloud • Upload failed - Retry");
  }
  if (
    options.cloudHealth?.state === "setup-incomplete" ||
    options.cloudHealth?.state === "temporarily-unavailable" ||
    options.cloudHealth?.state === "not-connected" ||
    options.cloudHealth?.state === "permission-required" ||
    options.cloudHealth?.state === "reconnect-required" ||
    !options.cloudConnected ||
    options.cloudState === "not_connected" ||
    options.cloudState === "blocked" ||
    options.cloudState === "error" ||
    options.cloudState === "reconnect_required"
  ) {
    return t("Cloud • Waiting to upload");
  }
  if (catalogueState === "archived-locally") return t("Cloud • Waiting to upload");
  return t("Cloud • Waiting to upload");
}
