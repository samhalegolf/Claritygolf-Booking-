import assert from "node:assert/strict";
import test from "node:test";
import { PoseSwingDetector, type PoseFrame, type PosePoint } from "./poseSwingDetector";

const frame = (timestampMs: number, wristOffset = 0): PoseFrame => {
  const landmarks: PosePoint[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }));
  for (const index of [11, 12, 13, 14, 23, 24]) {
    landmarks[index] = { x: 0.5, y: 0.5, visibility: 1 };
  }
  landmarks[15] = { x: 0.45 + wristOffset, y: 0.55, visibility: 1 };
  landmarks[16] = { x: 0.55 + wristOffset, y: 0.55, visibility: 1 };
  return { timestampMs, landmarks };
};

test("arms after a stable address and finishes after settling", () => {
  const detector = new PoseSwingDetector({
    addressHoldMs: 600,
    settleHoldMs: 400,
    minimumSwingMs: 300,
  });

  detector.sample(frame(0));
  detector.sample(frame(300));
  const address = detector.sample(frame(650));
  assert.equal(address.event?.type, "address");

  const swingStart = detector.sample(frame(700, 0.12));
  assert.equal(swingStart.event?.type, "swing-start");

  detector.sample(frame(1050, 0.18));
  detector.sample(frame(1150, 0.18));
  const finish = detector.sample(frame(1600, 0.18));
  assert.equal(finish.event?.type, "swing-finish");
});

test("does not arm when the tracked body is not visible", () => {
  const detector = new PoseSwingDetector({ addressHoldMs: 100 });
  const missing = frame(0);
  missing.landmarks[15].visibility = 0.1;
  const result = detector.sample(missing);
  assert.equal(result.bodyVisible, false);
  assert.equal(result.state, "searching");
});
