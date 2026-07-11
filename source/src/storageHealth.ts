import type {
  ManagedLocalVideoLibraryStatus,
  SavedVideoItem,
} from "./modules/video-analysis/utils/savedVideoLibrary";

export type GoogleDriveTransferState =
  | "not_connected"
  | "connected"
  | "permission_upgrade_required"
  | "reconnect_required"
  | "blocked"
  | "error";

export type GoogleDriveTransferStatus = {
  ok?: boolean;
  configured: boolean;
  connected: boolean;
  state: GoogleDriveTransferState;
  calendarConnected: boolean;
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
      statusLabel: "Ready";
      message: string;
      detail: string;
    }
  | {
      state: "needs-folder";
      statusLabel: "Needs folder access";
      message: string;
      detail: string;
      action: "choose-folder";
    }
  | {
      state: "reconnect-required";
      statusLabel: "Reconnect required";
      message: string;
      detail: string;
      action: "reconnect-folder";
    }
  | {
      state: "library-missing";
      statusLabel: "Library not found";
      message: string;
      detail: string;
      action: "locate-library";
    }
  | {
      state: "cache-only";
      statusLabel: "Using browser backup";
      message: string;
      detail: string;
      action?: "reconnect-folder";
      safeErrorCode?: string;
    }
  | {
      state: "unsupported";
      statusLabel: "Browser-only storage";
      message: string;
      detail: string;
    }
  | {
      state: "error";
      statusLabel: "Needs attention";
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
      statusLabel: "Ready";
      message: string;
      provider: ClarityCloudProviderId;
      providerLabel: string;
    }
  | {
      state: "not-connected";
      statusLabel: "Not connected";
      message: string;
      provider: ClarityCloudProviderId;
      providerLabel: string;
      action: "connect";
    }
  | {
      state: "permission-required";
      statusLabel: "Permission required";
      message: string;
      provider: ClarityCloudProviderId;
      providerLabel: string;
      action: "grant-permission";
    }
  | {
      state: "reconnect-required";
      statusLabel: "Reconnect required";
      message: string;
      provider: ClarityCloudProviderId;
      providerLabel: string;
      action: "reconnect";
    }
  | {
      state: "setup-incomplete";
      statusLabel: "Setup incomplete";
      message: string;
      provider: ClarityCloudProviderId;
      providerLabel: string;
      action: "open-setup-details" | "retry-setup";
      safeErrorCode?: string;
    }
  | {
      state: "temporarily-unavailable";
      statusLabel: "Temporarily unavailable";
      message: string;
      provider: ClarityCloudProviderId;
      providerLabel: string;
      action: "retry";
      safeErrorCode?: string;
    }
  | {
      state: "beta";
      statusLabel: "Beta";
      message: string;
      provider: ClarityCloudProviderId;
      providerLabel: string;
    }
  | {
      state: "error";
      statusLabel: "Needs attention";
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
      statusLabel: "Browser-only storage",
      message: "This browser cannot use a managed computer folder. Videos stay in browser storage on this device.",
      detail: "Browser IndexedDB cache and recovery",
    };
  }

  if (!status.configured || status.health === "not-configured") {
    return {
      state: "needs-folder",
      statusLabel: "Needs folder access",
      message: "Choose where Clarity should store videos on this computer.",
      detail: "Clarity Video Library",
      action: "choose-folder",
    };
  }

  if (status.health === "healthy") {
    return {
      state: "ready",
      statusLabel: "Ready",
      message: "Videos are safely stored on this computer.",
      detail: "Clarity Video Library",
    };
  }

  if (status.health === "permission-lost" || status.health === "read-only") {
    return {
      state: "reconnect-required",
      statusLabel: "Reconnect required",
      message: "Clarity no longer has access to the selected video library.",
      detail: "Clarity Video Library",
      action: "reconnect-folder",
    };
  }

  if (status.health === "missing" || status.health === "moved") {
    return {
      state: "library-missing",
      statusLabel: "Library not found",
      message: "The selected Clarity Video Library may have been moved or renamed.",
      detail: "Clarity Video Library",
      action: "locate-library",
    };
  }

  if (status.health === "repair-required") {
    return {
      state: "cache-only",
      statusLabel: "Using browser backup",
      message: "Videos are protected in browser storage, but the managed local library needs attention.",
      detail: "Browser IndexedDB cache and recovery",
      action: "reconnect-folder",
      safeErrorCode: "LOCAL_LIBRARY_REPAIR_REQUIRED",
    };
  }

  return {
    state: "error",
    statusLabel: "Needs attention",
    message: "Local Storage needs attention before it can be used as the durable video library.",
    detail: "Browser IndexedDB cache and recovery",
    safeErrorCode: safeCode(status.health, "LOCAL_STORAGE_UNAVAILABLE"),
  };
}

export function getLocalStorageActionLabel(action?: LocalStorageAction) {
  if (action === "choose-folder") return "Choose folder";
  if (action === "reconnect-folder") return "Reconnect folder";
  if (action === "locate-library") return "Locate library";
  return "";
}

export function getClarityCloudHealth(status: GoogleDriveTransferStatus): ClarityCloudHealth {
  if (!status.configured || status.safeErrorCode === "CLOUD_OAUTH_NOT_CONFIGURED") {
    return {
      ...cloudBase,
      state: "setup-incomplete",
      statusLabel: "Setup incomplete",
      message: "Clarity Cloud is not configured for this environment.",
      action: "open-setup-details",
      safeErrorCode: "CLOUD_OAUTH_NOT_CONFIGURED",
    };
  }

  if (status.state === "permission_upgrade_required") {
    return {
      ...cloudBase,
      state: "permission-required",
      statusLabel: "Permission required",
      message: "Clarity needs permission to transfer saved videos.",
      action: "grant-permission",
    };
  }

  if (status.state === "reconnect_required") {
    return {
      ...cloudBase,
      state: "reconnect-required",
      statusLabel: "Reconnect required",
      message: "Your cloud connection needs to be refreshed.",
      action: "reconnect",
    };
  }

  if (!status.connected || status.state === "not_connected") {
    return {
      ...cloudBase,
      state: "not-connected",
      statusLabel: "Not connected",
      message: "Connect Clarity Cloud to transfer saved videos between your devices.",
      action: "connect",
    };
  }

  if (!status.providerStorageConfigured || !status.tokenEncryptionConfigured) {
    return {
      ...cloudBase,
      state: "setup-incomplete",
      statusLabel: "Setup incomplete",
      message: "Secure provider storage is unavailable.",
      action: "open-setup-details",
      safeErrorCode: safeCode(status.safeErrorCode || status.blocker, "PROVIDER_STORAGE_UNAVAILABLE"),
    };
  }

  if (!status.driveScopeGranted) {
    return {
      ...cloudBase,
      state: "permission-required",
      statusLabel: "Permission required",
      message: "Clarity needs permission to transfer saved videos.",
      action: "grant-permission",
    };
  }

  if (status.state === "blocked") {
    return {
      ...cloudBase,
      state: "setup-incomplete",
      statusLabel: "Setup incomplete",
      message: "Cloud storage is connected, but transfer setup is not complete.",
      action: "open-setup-details",
      safeErrorCode: safeCode(status.safeErrorCode || status.blocker || status.message, "CLARITY_CLOUD_SETUP_INCOMPLETE"),
    };
  }

  if (status.state === "error") {
    return {
      ...cloudBase,
      state: "temporarily-unavailable",
      statusLabel: "Temporarily unavailable",
      message: "Clarity Cloud could not be reached. Your local videos are still safe.",
      action: "retry",
      safeErrorCode: safeCode(status.blocker || status.message, "CLARITY_CLOUD_UNAVAILABLE"),
    };
  }

  if (!status.inboxFolderId || !status.importedFolderId || !status.failedFolderId) {
    return {
      ...cloudBase,
      state: "setup-incomplete",
      statusLabel: "Setup incomplete",
      message: "Transfer folder could not be prepared.",
      action: "retry-setup",
      safeErrorCode: "TRANSFER_FOLDER_UNAVAILABLE",
    };
  }

  if (status.uploadRouteReady === false || status.chunkedTransportReady === false) {
    return {
      ...cloudBase,
      state: "temporarily-unavailable",
      statusLabel: "Temporarily unavailable",
      message: "Your local video is safe. The cloud transfer service could not be reached.",
      action: "retry",
      safeErrorCode: safeCode(status.safeErrorCode, "CHUNK_UPLOAD_UNAVAILABLE"),
    };
  }

  if (status.incomingImportReady !== true) {
    return {
      ...cloudBase,
      state: "temporarily-unavailable",
      statusLabel: "Temporarily unavailable",
      message: "Your local video is safe. The cloud transfer service could not be reached.",
      action: "retry",
      safeErrorCode: safeCode(status.safeErrorCode, "CLARITY_CLOUD_IMPORT_LIST_UNAVAILABLE"),
    };
  }

  return {
    ...cloudBase,
    state: "ready",
    statusLabel: "Ready",
    message: "Transfer saved videos between your devices.",
  };
}

export const googleDriveClarityCloudProvider: ClarityCloudProvider = {
  id: "google-drive",
  displayName: googleDriveProviderLabel,
  getHealth: getClarityCloudHealth,
};

export function getClarityCloudActionLabel(action?: ClarityCloudAction) {
  if (action === "connect") return "Connect Clarity Cloud";
  if (action === "grant-permission") return "Grant permission";
  if (action === "reconnect") return "Reconnect Clarity Cloud";
  if (action === "open-setup-details") return "Open setup details";
  if (action === "retry-setup") return "Retry setup";
  if (action === "retry") return "Retry";
  return "";
}

export function getSavedVideoLocalStatusLabel(video: SavedVideoItem) {
  const managedStatus = video.local.managed?.status;
  if (managedStatus === "healthy") return "Local - Saved";
  if (managedStatus && video.local.status !== "missing") return "Local - Cache only";
  if (video.local.status === "available") return "Local - Saved";
  if (video.local.status === "recovery-only") return "Local - Cache only";
  if (video.local.status === "missing") return "Local - Missing";
  return "Local - Needs attention";
}

export function getSavedVideoCloudStatusLabel(
  video: SavedVideoItem,
  options: {
    isUploading: boolean;
    cloudConnected: boolean;
    cloudState: GoogleDriveTransferState;
    cloudHealth?: ClarityCloudHealth;
  }
) {
  if (video.cloud?.status === "ready") return "Cloud - Ready to import";
  if (video.cloud?.status === "imported") return "Cloud - Imported locally";
  if (options.cloudHealth?.state === "setup-incomplete") return "Cloud - Setup incomplete";
  if (options.cloudHealth?.state === "temporarily-unavailable") return "Cloud - Temporarily unavailable";
  if (options.cloudHealth?.state === "not-connected") return "Cloud - Not connected";
  if (options.cloudHealth?.state === "permission-required") return "Cloud - Permission required";
  if (options.cloudHealth?.state === "reconnect-required") return "Cloud - Reconnect required";
  if (video.cloud?.status === "paused") return "Cloud - Paused";
  if (video.cloud?.status === "verifying") return "Cloud - Verifying";
  if (video.cloud?.status === "preparing") return "Cloud - Preparing";
  if (video.cloud?.status === "cancelled") return "Cloud - Cancelled";
  if (options.isUploading) {
    const progress = Math.max(0, Math.min(100, Math.round(video.cloud?.progress || 0)));
    return `Cloud - Sending ${progress}%`;
  }
  if (video.cloud?.status === "failed") return "Cloud - Failed - Retry";
  if (options.cloudState === "permission_upgrade_required") return "Cloud - Permission required";
  if (options.cloudState === "reconnect_required") return "Cloud - Reconnect required";
  if (options.cloudState === "blocked") return "Cloud - Setup incomplete";
  if (options.cloudState === "error") return "Cloud - Service unavailable";
  if (!options.cloudConnected || options.cloudState === "not_connected") return "Cloud - Connect Clarity Cloud";
  return "Cloud - Not sent";
}
