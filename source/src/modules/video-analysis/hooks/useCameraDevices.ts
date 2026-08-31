import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * The video input devices this browser can currently see, kept live.
 *
 * The workspace needs this for one reason: to answer "is the coach's saved
 * camera plugged in right now?" without ever opening a camera to find out. A
 * Continuity Camera iPhone appears and disappears from this list as it wakes,
 * sleeps, and reconnects, so we listen for `devicechange` and re-enumerate --
 * that is what lets Record come back on its own instead of making the coach
 * pick their phone again every time.
 */

export interface CameraDevicesState {
  devices: MediaDeviceInfo[];
  /** False when the browser has no media device API at all. */
  supported: boolean;
  /**
   * Labels are blank until the origin has been granted camera access once.
   * With no labels there is nothing to show in a device list, and the label
   * half of camera matching cannot work.
   */
  labelsAvailable: boolean;
  /** Re-read the device list now, and hand back what it found. */
  refresh: () => Promise<MediaDeviceInfo[]>;
  /**
   * Open and immediately close a camera purely to earn device labels, then
   * re-enumerate. Only ever called from an explicit action in Video Settings:
   * it is the browser's only route to a named device list.
   */
  requestLabels: () => Promise<void>;
  error: string;
}

export function useCameraDevices(enabled = true): CameraDevicesState {
  const supported =
    typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.enumerateDevices);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [error, setError] = useState("");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<MediaDeviceInfo[]> => {
    if (!supported) return [];
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const cameras = all.filter((device) => device.kind === "videoinput");
      if (mountedRef.current) {
        setDevices(cameras);
        setError("");
      }
      return cameras;
    } catch (enumerationError) {
      if (mountedRef.current) {
        setError(
          enumerationError instanceof Error
            ? enumerationError.message
            : "Could not read the camera list."
        );
      }
      return [];
    }
  }, [supported]);

  const requestLabels = useCallback(async () => {
    if (!supported || !navigator.mediaDevices.getUserMedia) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach((track) => track.stop());
      setError("");
    } catch (permissionError) {
      if (!mountedRef.current) return;
      setError(
        permissionError instanceof Error
          ? permissionError.message
          : "Camera access was not granted."
      );
    }
    await refresh();
  }, [refresh, supported]);

  useEffect(() => {
    if (!enabled || !supported) return;
    void refresh();
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices.addEventListener) return;
    const handleChange = () => {
      void refresh();
    };
    mediaDevices.addEventListener("devicechange", handleChange);
    return () => {
      mediaDevices.removeEventListener("devicechange", handleChange);
    };
  }, [enabled, refresh, supported]);

  // Memoised: callers hold this object in effect and callback dependency
  // lists, and a fresh literal every render would churn all of them.
  return useMemo(
    () => ({
      devices,
      supported,
      labelsAvailable: devices.some((device) => Boolean(device.label)),
      refresh,
      requestLabels,
      error,
    }),
    [devices, error, refresh, requestLabels, supported]
  );
}
