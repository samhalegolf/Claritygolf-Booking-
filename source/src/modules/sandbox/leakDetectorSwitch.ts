// Whether the sandbox leak detector is on, in this browser.
//
// A per-viewer convenience, so browser storage is the right home: it is not
// shared, not reported back, and losing it (a private window, cleared data)
// just means the detector starts off. Every access is guarded for that reason.

const STORAGE_KEY = "clarity.sandbox.leakDetector";
export const LEAK_DETECTOR_EVENT = "clarity:leak-detector";

export function leakDetectorEnabled(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setLeakDetectorEnabled(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(STORAGE_KEY, "1");
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage refused: the switch still flips for this page via the event.
  }
  window.dispatchEvent(new CustomEvent(LEAK_DETECTOR_EVENT, { detail: on }));
}
