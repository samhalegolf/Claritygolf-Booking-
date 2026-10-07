/**
 * The small, pure decisions about a saved video. Kept apart from
 * savedVideoLibrary so the app shell (status labels, profile pairing) can use
 * them without pulling IndexedDB and cloud-transfer code into first paint.
 */
import type {
  SavedVideoCloudCatalogueState,
  SavedVideoDeviceStateRecord,
  SavedVideoItem,
} from "./savedVideoLibrary";
import { pairSameSwingAngles, type SwingAngleCandidate } from "./sameSwingAngles";

export const getSavedVideoCloudCatalogueState = (item: SavedVideoItem): SavedVideoCloudCatalogueState => {
  if (item.cloud?.status === "ready" || item.cloud?.status === "imported") return "ready";
  if (item.cloud?.status === "preparing" || item.cloud?.status === "session-created") return "preparing";
  if (item.cloud?.status === "uploading") return "uploading";
  if (item.cloud?.status === "verifying") return "verifying";
  if (item.cloud?.status === "paused") return "paused";
  if (item.cloud?.status === "failed" || item.cloud?.status === "expired" || item.cloud?.status === "cancelled") return "failed";
  if (item.local.managed?.status === "healthy" && item.cloud?.status === "not-uploaded") return "archived-locally";
  return "waiting-to-upload";
};

export const getSavedVideoDeviceState = (item: SavedVideoItem): SavedVideoDeviceStateRecord => {
  if (item.local.managed?.status === "healthy") {
    return {
      status: "permanent",
      source: "my-library",
      availableOnThisDevice: true,
      keepOnDevice: true,
      sizeBytes: item.source.sizeBytes,
      checksumSha256: item.source.checksumSha256,
      updatedAt: item.local.managed.verifiedAt || item.updatedAt,
    };
  }
  if (item.local.status === "available") {
    return {
      status: "cached",
      source: "device-cache",
      availableOnThisDevice: true,
      keepOnDevice: false,
      sizeBytes: item.source.sizeBytes,
      checksumSha256: item.source.checksumSha256,
      updatedAt: item.updatedAt,
    };
  }
  if (item.local.status === "recovery-only") {
    return {
      status: "recovery-only",
      source: "temporary-recovery",
      availableOnThisDevice: true,
      keepOnDevice: false,
      sizeBytes: item.source.sizeBytes,
      checksumSha256: item.source.checksumSha256,
      updatedAt: item.updatedAt,
      errorMessage: item.local.managed?.lastError,
    };
  }
  if (item.local.status === "error") {
    return {
      status: "download-failed",
      source: "device-cache",
      availableOnThisDevice: false,
      keepOnDevice: false,
      sizeBytes: item.source.sizeBytes,
      checksumSha256: item.source.checksumSha256,
      updatedAt: item.updatedAt,
      errorMessage: item.local.managed?.lastError,
    };
  }
  return {
    status: "not-downloaded",
    source: "clarity-cloud",
    availableOnThisDevice: false,
    keepOnDevice: false,
    sizeBytes: item.source.sizeBytes,
    checksumSha256: item.source.checksumSha256,
    updatedAt: item.updatedAt,
  };
};

/**
 * The id the video workspace used to file saves under when it was opened
 * without a player. It matches no client, so those videos sat on no profile
 * until the coach reassigns them.
 */
export const LEGACY_UNASSIGNED_PLAYER_ID = "player-demo-1";

/** What `sameSwingAngles` needs to know about a saved video. */
export const swingAngleCandidateOf = (item: SavedVideoItem): SwingAngleCandidate => ({
  id: item.savedVideoId,
  playerId: item.playerId,
  recordedAt: item.source.recordedAt,
  durationS: item.source.duration,
  linkedTo: item.swingAngles?.linkedTo,
  refused: item.swingAngles?.refused,
});

/** Each saved video's same-swing partner, both ways round. */
export const pairSavedVideoAngles = (items: readonly SavedVideoItem[]): Map<string, string> =>
  pairSameSwingAngles(items.map(swingAngleCandidateOf));
