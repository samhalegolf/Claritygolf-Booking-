/**
 * The coach's recording setup: which camera, and which way up.
 *
 * Both are workstation preferences, not lesson data. They belong to the browser
 * profile in front of the coach and are deliberately not tied to a player, a
 * lesson, an analysis, a recording, or a comparison side. They are chosen once
 * in Video Settings and then honoured silently by the Video Analysis workspace.
 *
 * The one rule that shapes the camera half: once a camera has been chosen, we
 * never quietly record with a different one. A coach who mounts an iPhone and
 * picks it has told us which picture they want; falling back to the built-in
 * MacBook camera because the phone is asleep would hand them a recording of the
 * wrong thing, and they would not find out until they played it back.
 */

/** The shape we persist. `MediaDeviceInfo` satisfies it structurally. */
export interface CameraDevice {
  deviceId: string;
  label: string;
}

export interface PreferredCamera {
  deviceId: string;
  label: string;
}

const PREFERRED_CAMERA_KEY = "clarity.video.default-camera";
/**
 * The old key held whatever camera happened to be used last -- it was written
 * on every recorder open, never chosen. Promoting that to a hard preference
 * would block recording on a camera the coach never picked, so it is dropped
 * rather than migrated; the coach picks once in Video Settings instead.
 */
const LEGACY_PREFERRED_CAMERA_KEY = "clarity.video.preferred-camera";

/**
 * Device labels are close to stable but not exactly stable: browsers vary the
 * apostrophe in "Sam's iPhone", pad the string, and Chrome appends a USB
 * vendor:product pair to attached hardware. Normalising those away lets a
 * label survive a Continuity Camera reconnection that renumbered the device id.
 *
 * It deliberately stops there. Matching is exact equality on the normalised
 * string, so "Sam's iPhone Camera" and "Sam's iPhone Desk View Camera" stay two
 * different sources -- which is the whole point, because they are two different
 * pictures of the swing.
 */
export const normalizeCameraLabel = (label: string): string =>
  label
    .replace(/[‘’ʼ´`]/g, "'")
    .replace(/\s*\([0-9a-f]{4}[:-][0-9a-f]{4}\)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const readStorage = (key: string): string | null => {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const removeStorage = (key: string) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // A browser with storage disabled simply forgets the preference.
  }
};

export const parsePreferredCamera = (raw: string | null): PreferredCamera | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as Record<string, unknown>;
    const deviceId = typeof candidate.deviceId === "string" ? candidate.deviceId : "";
    const label = typeof candidate.label === "string" ? candidate.label : "";
    // A record with neither half cannot be resolved against anything.
    if (!deviceId && !label) return null;
    return { deviceId, label };
  } catch {
    return null;
  }
};

export const loadPreferredCamera = (): PreferredCamera | null => {
  removeStorage(LEGACY_PREFERRED_CAMERA_KEY);
  return parsePreferredCamera(readStorage(PREFERRED_CAMERA_KEY));
};

export const savePreferredCamera = (camera: PreferredCamera) => {
  if (typeof window === "undefined") return;
  if (!camera.deviceId && !camera.label) return;
  try {
    window.localStorage.setItem(
      PREFERRED_CAMERA_KEY,
      JSON.stringify({ deviceId: camera.deviceId, label: camera.label })
    );
  } catch {
    // The workspace stays usable; the choice just will not outlive the tab.
  }
};

export const clearPreferredCamera = () => {
  removeStorage(PREFERRED_CAMERA_KEY);
};

/**
 * Find the saved camera among the devices the browser can currently see.
 *
 * Returns null when it is not there -- that is the "Camera not connected"
 * state, and it is a real answer, not a reason to substitute another camera.
 *
 * Order matters: the device id is the browser's own handle on the source, so it
 * wins. The label is the fallback for macOS Continuity Camera, where an iPhone
 * that reconnects can come back under a fresh id.
 */
export const resolvePreferredCamera = <T extends CameraDevice>(
  devices: readonly T[],
  preferred: PreferredCamera | null
): T | null => {
  if (!preferred) return null;

  if (preferred.deviceId) {
    const byId = devices.find((device) => device.deviceId === preferred.deviceId);
    if (byId) return byId;
  }

  if (!preferred.label) return null;
  const wanted = normalizeCameraLabel(preferred.label);
  if (!wanted) return null;

  // Devices with no label are devices we have not been given permission to
  // name yet; they cannot be matched this way and must not be guessed at.
  return (
    devices.find((device) => device.label && normalizeCameraLabel(device.label) === wanted) || null
  );
};

/** True when this device is the saved default, by either match. */
export const isPreferredCamera = (
  device: CameraDevice,
  preferred: PreferredCamera | null
): boolean => {
  if (!preferred) return false;
  if (preferred.deviceId && device.deviceId === preferred.deviceId) return true;
  if (!preferred.label || !device.label) return false;
  return normalizeCameraLabel(device.label) === normalizeCameraLabel(preferred.label);
};

/** What to call the saved camera in the UI when it is not currently present. */
export const describePreferredCamera = (preferred: PreferredCamera | null): string => {
  if (!preferred) return "";
  return preferred.label || "Saved camera";
};


/* -------------------------------------------------------------------------
   Recording orientation
   ------------------------------------------------------------------------- */

export type RecordingOrientation = "portrait" | "landscape";

/**
 * Portrait, because the workflow this is built around is a phone mounted
 * upright behind the swing. Landscape is there for coaches shooting on a
 * tripod-mounted camera that has no portrait mode worth using.
 */
export const DEFAULT_RECORDING_ORIENTATION: RecordingOrientation = "portrait";

const ORIENTATION_KEY = "clarity.video.recording-orientation";

export const parseRecordingOrientation = (raw: string | null): RecordingOrientation =>
  raw === "landscape" || raw === "portrait" ? raw : DEFAULT_RECORDING_ORIENTATION;

export const loadRecordingOrientation = (): RecordingOrientation =>
  parseRecordingOrientation(readStorage(ORIENTATION_KEY));

export const saveRecordingOrientation = (orientation: RecordingOrientation) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ORIENTATION_KEY, orientation);
  } catch {
    // The workspace stays usable; the choice just will not outlive the tab.
  }
};

/** Width / height of the chosen orientation, for sizing the stage. */
export const orientationAspectRatio = (orientation: RecordingOrientation): number =>
  orientation === "portrait" ? 9 / 16 : 16 / 9;

/**
 * The video half of `getUserMedia` for this orientation.
 *
 * Every dimension is an `ideal`, never an `exact`. A camera that cannot shoot
 * the requested way round should still open -- refusing to connect would put
 * the coach back in front of "camera not connected" for a camera that is
 * plainly sitting there. What a camera actually returns is its own business,
 * and MediaRecorder records that, not this request.
 */
export const orientationVideoConstraints = (
  orientation: RecordingOrientation
): MediaTrackConstraints =>
  orientation === "portrait"
    ? {
        width: { ideal: 1080 },
        height: { ideal: 1920 },
        aspectRatio: { ideal: 9 / 16 },
        frameRate: { ideal: 60 },
      }
    : {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        aspectRatio: { ideal: 16 / 9 },
        frameRate: { ideal: 60 },
      };

/** Whether a track that came back matches the orientation that was asked for. */
export const trackMatchesOrientation = (
  settings: { width?: number; height?: number } | null | undefined,
  orientation: RecordingOrientation
): boolean => {
  if (!settings?.width || !settings?.height) return true;
  const isPortrait = settings.height > settings.width;
  return isPortrait === (orientation === "portrait");
};


/* -------------------------------------------------------------------------
   Opening the saved camera
   ------------------------------------------------------------------------- */

export interface OpenPreferredCameraOptions<TStream> {
  preferred: PreferredCamera;
  orientation: RecordingOrientation;
  /** Opens a stream for the given constraints, or throws. */
  openStream: (constraints: MediaStreamConstraints) => Promise<TStream>;
  /** The video inputs the browser will admit to right now. */
  listCameras: () => Promise<readonly CameraDevice[]>;
}

export interface OpenPreferredCameraResult<TStream> {
  stream: TStream | null;
  /** The browser refused on permission grounds; trying harder will not help. */
  blocked: boolean;
}

/**
 * Open the saved camera, and only the saved camera.
 *
 * Two attempts, both pinned with `exact` on a device id:
 *
 *   1. The id we saved. Pinning makes it safe to try a camera the device list
 *      has not mentioned, and that is the point -- a Continuity Camera iPhone
 *      is often not advertised until something asks for a camera. Gating the
 *      attempt on enumeration was a closed loop: the phone stayed absent
 *      because nothing woke it, and nothing woke it because it was absent.
 *   2. Whatever the saved camera resolves to after re-enumerating, which is
 *      how a phone that came back under a fresh id is picked up. Skipped when
 *      it resolves to the id we already tried.
 *
 * There is deliberately no third attempt. If neither works the answer is
 * "not connected" -- never the MacBook camera, never Desk View, never
 * whatever the browser would have chosen. A coach who mounted a phone and
 * picked it would not discover the substitution until playback.
 */
export const openPreferredCameraStream = async <TStream>({
  preferred,
  orientation,
  openStream,
  listCameras,
}: OpenPreferredCameraOptions<TStream>): Promise<OpenPreferredCameraResult<TStream>> => {
  const tried = new Set<string>();
  let blocked = false;

  const attempt = async (deviceId: string): Promise<TStream | null> => {
    if (!deviceId || tried.has(deviceId)) return null;
    tried.add(deviceId);
    try {
      return await openStream({
        video: {
          // Orientation is only ever ideal, so a camera that cannot shoot the
          // requested way round still opens instead of reading as absent.
          ...orientationVideoConstraints(orientation),
          deviceId: { exact: deviceId },
        },
        audio: false,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "NotAllowedError") blocked = true;
      return null;
    }
  };

  const bySavedId = await attempt(preferred.deviceId);
  if (bySavedId) return { stream: bySavedId, blocked: false };
  if (blocked) return { stream: null, blocked: true };

  const resolved = resolvePreferredCamera(await listCameras(), preferred);
  const byResolvedId = resolved ? await attempt(resolved.deviceId) : null;
  if (byResolvedId) return { stream: byResolvedId, blocked: false };

  return { stream: null, blocked };
};
