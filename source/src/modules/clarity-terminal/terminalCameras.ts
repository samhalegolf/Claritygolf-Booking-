// The camera side of Clarity Terminal: which cameras were chosen, finding
// them again, and opening them at the best quality each will give.
//
// Kept apart from the page so the rules -- the ones that decide whether a
// bay's cameras come back by themselves after a restart -- can be tested
// without a browser.

import { normalizeCameraLabel, type PreferredCamera } from "../video-analysis/utils/cameraPreference";

/** One per side of the coach's compare view. */
export const MAX_CAMERAS = 2;
const SELECTION_KEY = "clarity-terminal-cameras";

export type CameraOption = { deviceId: string; label: string };

export type ActiveCamera = {
  deviceId: string;
  label: string;
  stream: MediaStream;
  width?: number;
  height?: number;
  fps?: number;
};

/**
 * The chosen cameras, remembered by id and by name. The name is what finds a
 * camera again when it comes back under a new id -- an iPhone used as a
 * Continuity Camera does that, and so do some USB cameras moved to another
 * port. Same rule as the workspace's own saved camera (cameraPreference.ts).
 */
export const readSavedSelection = (): PreferredCamera[] => {
  try {
    const raw = window.localStorage.getItem(SELECTION_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) =>
        typeof entry === "string"
          ? { deviceId: entry, label: "" }
          : {
              deviceId: typeof entry?.deviceId === "string" ? entry.deviceId : "",
              label: typeof entry?.label === "string" ? entry.label : "",
            },
      )
      .filter((entry) => entry.deviceId || entry.label)
      .slice(0, MAX_CAMERAS);
  } catch {
    return [];
  }
};

export const saveSelection = (selection: PreferredCamera[]) => {
  try {
    window.localStorage.setItem(SELECTION_KEY, JSON.stringify(selection));
  } catch {
    // A blocked store only means choosing the cameras again next time.
  }
};

export const stopStream = (stream: MediaStream | null | undefined) =>
  stream?.getTracks().forEach((track) => track.stop());

/**
 * Which remembered camera this device is, if any. The id decides whenever the
 * id is still around; the name only stands in for an id that has gone. Two
 * cameras of the same model share a name, so a name match must never claim a
 * camera another entry already holds by id.
 */
export const selectionIndex = (
  device: CameraOption,
  selection: readonly PreferredCamera[],
  present: readonly CameraOption[],
) => {
  const byId = selection.findIndex((entry) => entry.deviceId && entry.deviceId === device.deviceId);
  if (byId >= 0) return byId;
  if (!device.label) return -1;
  const name = normalizeCameraLabel(device.label);
  return selection.findIndex(
    (entry) =>
      entry.label &&
      !present.some((other) => other.deviceId === entry.deviceId) &&
      normalizeCameraLabel(entry.label) === name,
  );
};

/** A camera with this name that nobody else is using. */
export const findByName = (list: readonly CameraOption[], wanted: PreferredCamera, taken: Set<string>) => {
  if (!wanted.label) return null;
  const name = normalizeCameraLabel(wanted.label);
  return list.find((device) => !taken.has(device.deviceId) && device.label && normalizeCameraLabel(device.label) === name) || null;
};

export const isLive = (camera: ActiveCamera) =>
  camera.stream.getVideoTracks().some((track) => track.readyState === "live");

/**
 * What to ask a camera for, best first. Every step is only ever `ideal`, so a
 * camera answers with the nearest mode it has -- but some refuse outright
 * rather than negotiate: cheaper webcams asked for more than they can do, and
 * two cameras sharing one USB port that cannot both run at full size. Each
 * refusal steps down, and the last step asks for nothing but the camera.
 */
export const QUALITY_LADDER: MediaTrackConstraints[] = [
  { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } },
  { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
  { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  {},
];

export class CameraBlockedError extends Error {}

/**
 * Opens one camera by id, stepping down the ladder when it refuses. Null when
 * the id is not a camera that is here. Throws only when the browser has
 * blocked camera access, which no retry will change.
 */
export const openCameraById = async (
  deviceId: string,
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream> = (constraints) =>
    navigator.mediaDevices.getUserMedia(constraints),
): Promise<MediaStream | null> => {
  for (const quality of QUALITY_LADDER) {
    try {
      return await getUserMedia({
        audio: false,
        video: { ...quality, deviceId: { exact: deviceId } },
      });
    } catch (error) {
      // DOMException and OverconstrainedError are not both Errors everywhere.
      const name = (error as { name?: string } | null)?.name || "";
      if (name === "NotAllowedError" || name === "SecurityError") throw new CameraBlockedError();
      // Gone, or never here: a lower quality will not find it.
      if (name === "NotFoundError") return null;
      // NotReadableError, AbortError, OverconstrainedError: busy or fussy.
    }
  }
  return null;
};

export const cameraFromStream = (deviceId: string, fallbackLabel: string, stream: MediaStream): ActiveCamera => {
  const track = stream.getVideoTracks()[0];
  const settings = track?.getSettings() || {};
  return {
    deviceId: settings.deviceId || deviceId,
    label: track?.label || fallbackLabel,
    stream,
    width: settings.width,
    height: settings.height,
    fps: settings.frameRate ? Math.round(settings.frameRate) : undefined,
  };
};
