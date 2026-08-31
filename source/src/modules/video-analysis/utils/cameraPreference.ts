/**
 * The coach's default recording camera.
 *
 * This is a workstation preference, not lesson data: it belongs to the browser
 * profile in front of the coach and is deliberately not tied to a player, a
 * lesson, an analysis, a recording, or a comparison side. It is chosen once in
 * Video Settings and then honoured silently by the Video Analysis workspace.
 *
 * The one rule that shapes everything here: once a camera has been chosen, we
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
