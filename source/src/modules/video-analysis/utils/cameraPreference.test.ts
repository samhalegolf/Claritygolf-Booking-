import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_RECORDING_ORIENTATION,
  describePreferredCamera,
  isPreferredCamera,
  normalizeCameraLabel,
  orientationAspectRatio,
  orientationVideoConstraints,
  parsePreferredCamera,
  parseRecordingOrientation,
  resolvePreferredCamera,
  trackMatchesOrientation,
  type CameraDevice,
} from "./cameraPreference";

const camera = (deviceId: string, label: string): CameraDevice => ({ deviceId, label });

const macBook = camera("mac-cam-id", "MacBook Air Camera");
const iPhone = camera("iphone-cam-id", "Sam's iPhone Camera");
const iPhoneDeskView = camera("iphone-desk-id", "Sam's iPhone Desk View Camera");
const macDeskView = camera("mac-desk-id", "MacBook Air Desk View Camera");
const allDevices = [macBook, iPhone, iPhoneDeskView, macDeskView];

describe("normalizeCameraLabel", () => {
  it("folds case, padding and curly apostrophes", () => {
    assert.equal(normalizeCameraLabel("  Sam’s  iPhone Camera "), "sam's iphone camera");
  });

  it("drops the USB vendor:product suffix Chrome appends", () => {
    assert.equal(
      normalizeCameraLabel("FaceTime HD Camera (05ac:8514)"),
      "facetime hd camera"
    );
  });

  it("keeps a parenthetical that is not a hardware id", () => {
    assert.equal(normalizeCameraLabel("Studio Cam (Rear)"), "studio cam (rear)");
  });
});

describe("resolvePreferredCamera", () => {
  it("returns null when no camera has ever been chosen", () => {
    assert.equal(resolvePreferredCamera(allDevices, null), null);
  });

  it("matches the saved device id first", () => {
    const resolved = resolvePreferredCamera(allDevices, {
      deviceId: "iphone-cam-id",
      label: "Sam's iPhone Camera",
    });
    assert.equal(resolved?.deviceId, "iphone-cam-id");
  });

  it("falls back to the label when the device id has been renumbered", () => {
    // Continuity Camera reconnecting under a fresh id is the case this exists
    // for: same phone, same label, id the browser has never handed out before.
    const reconnected = [macBook, camera("iphone-cam-id-2", "Sam’s iPhone Camera")];
    const resolved = resolvePreferredCamera(reconnected, {
      deviceId: "iphone-cam-id",
      label: "Sam's iPhone Camera",
    });
    assert.equal(resolved?.deviceId, "iphone-cam-id-2");
  });

  it("never resolves a camera to the Desk View camera of the same phone", () => {
    const withoutTheIPhoneCamera = [macBook, iPhoneDeskView, macDeskView];
    const resolved = resolvePreferredCamera(withoutTheIPhoneCamera, {
      deviceId: "iphone-cam-id",
      label: "Sam's iPhone Camera",
    });
    assert.equal(resolved, null);
  });

  it("returns null rather than substituting another available camera", () => {
    const iPhoneUnplugged = [macBook, macDeskView];
    assert.equal(
      resolvePreferredCamera(iPhoneUnplugged, {
        deviceId: "iphone-cam-id",
        label: "Sam's iPhone Camera",
      }),
      null
    );
  });

  it("ignores unlabelled devices when matching by label", () => {
    // Before the permission prompt is answered, every label is "". Matching an
    // empty label against an empty label would resolve to whatever came first.
    const beforePermission = [camera("a", ""), camera("b", "")];
    assert.equal(
      resolvePreferredCamera(beforePermission, { deviceId: "gone", label: "" }),
      null
    );
    assert.equal(
      resolvePreferredCamera(beforePermission, {
        deviceId: "gone",
        label: "Sam's iPhone Camera",
      }),
      null
    );
  });
});

describe("isPreferredCamera", () => {
  it("marks the saved device and nothing else", () => {
    const preferred = { deviceId: "iphone-cam-id", label: "Sam's iPhone Camera" };
    assert.equal(isPreferredCamera(iPhone, preferred), true);
    assert.equal(isPreferredCamera(iPhoneDeskView, preferred), false);
    assert.equal(isPreferredCamera(macBook, preferred), false);
  });

  it("still marks the saved camera after a device id change", () => {
    assert.equal(
      isPreferredCamera(camera("new-id", "Sam's iPhone Camera"), {
        deviceId: "old-id",
        label: "Sam's iPhone Camera",
      }),
      true
    );
  });
});

describe("parsePreferredCamera", () => {
  it("reads a stored preference", () => {
    assert.deepEqual(
      parsePreferredCamera('{"deviceId":"a","label":"Camera A"}'),
      { deviceId: "a", label: "Camera A" }
    );
  });

  it("rejects the legacy bare-device-id string and other junk", () => {
    assert.equal(parsePreferredCamera("iphone-cam-id"), null);
    assert.equal(parsePreferredCamera("{}"), null);
    assert.equal(parsePreferredCamera(null), null);
  });
});

describe("describePreferredCamera", () => {
  it("prefers the saved label so a disconnected camera can still be named", () => {
    assert.equal(
      describePreferredCamera({ deviceId: "a", label: "Sam's iPhone Camera" }),
      "Sam's iPhone Camera"
    );
    assert.equal(describePreferredCamera({ deviceId: "a", label: "" }), "Saved camera");
    assert.equal(describePreferredCamera(null), "");
  });
});

describe("recording orientation", () => {
  it("defaults to portrait, which is what the phone-on-a-tripod workflow needs", () => {
    assert.equal(DEFAULT_RECORDING_ORIENTATION, "portrait");
    assert.equal(parseRecordingOrientation(null), "portrait");
    assert.equal(parseRecordingOrientation("sideways"), "portrait");
  });

  it("keeps a deliberate landscape choice", () => {
    assert.equal(parseRecordingOrientation("landscape"), "landscape");
  });

  it("describes the stage shape each way round", () => {
    assert.equal(orientationAspectRatio("portrait").toFixed(4), (9 / 16).toFixed(4));
    assert.equal(orientationAspectRatio("landscape").toFixed(4), (16 / 9).toFixed(4));
  });

  it("asks for the orientation without ever demanding it", () => {
    // `exact` here would refuse to open a camera that only shoots landscape,
    // stranding the coach on "camera not connected" for a camera in plain view.
    const portrait = orientationVideoConstraints("portrait");
    assert.deepEqual(portrait.width, { ideal: 1080 });
    assert.deepEqual(portrait.height, { ideal: 1920 });
    const landscape = orientationVideoConstraints("landscape");
    assert.deepEqual(landscape.width, { ideal: 1920 });
    assert.deepEqual(landscape.height, { ideal: 1080 });
    const serialised = JSON.stringify([portrait, landscape]);
    assert.equal(serialised.includes("exact"), false);
  });

  it("notices when the camera ignored the request", () => {
    assert.equal(trackMatchesOrientation({ width: 1080, height: 1920 }, "portrait"), true);
    assert.equal(trackMatchesOrientation({ width: 1920, height: 1080 }, "portrait"), false);
    assert.equal(trackMatchesOrientation({ width: 1920, height: 1080 }, "landscape"), true);
    // Nothing to judge yet: say nothing rather than warn about a phantom.
    assert.equal(trackMatchesOrientation(undefined, "portrait"), true);
    assert.equal(trackMatchesOrientation({}, "portrait"), true);
  });
});
