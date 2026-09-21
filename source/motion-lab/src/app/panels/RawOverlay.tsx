/**
 * The raw observation overlay. THE EVIDENCE LAYER.
 *
 * Its whole job is to stay honest about what the detector could actually see.
 * It draws MediaPipe's own 33 landmarks, in MediaPipe's own topology,
 * at the visibility MediaPipe reported -- including the face and thumbs that
 * Clarity discards, because leaving them out would already be interpretation.
 *
 * Specifically, it does NOT:
 *   - carry a landmark forward when the detector loses it
 *   - smooth anything between frames
 *   - hide a low-confidence point to make the picture tidier
 *
 * A limb that flickers here IS flickering in the data. The 3D Space's job is
 * to show the reconstructed journey; this one's is to show the evidence that
 * journey was built from, so the two can be compared. If they ever agree
 * perfectly, the reconstruction is not doing anything.
 */

import { useEffect, useRef } from "react";

import { MP_CONNECTIONS } from "../../observe/mediapipe/connections";
import type { ObservationFrame, RawLandmark } from "../../observe/observation";

export interface RawOverlayProps {
  readonly frame: ObservationFrame | null;
  readonly width: number;
  readonly height: number;
  /** Draw every landmark, including ones below the mapping's visibility floor. */
  readonly showLowConfidence: boolean;
}

/** Below this, a landmark is drawn faintly rather than confidently. */
const WEAK_VISIBILITY = 0.5;

export function RawOverlay({ frame, width, height, showLowConfidence }: RawOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const displayWidth = canvas.clientWidth;
    const displayHeight = canvas.clientHeight;
    if (displayWidth <= 0 || displayHeight <= 0) return;

    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(displayWidth * ratio);
    canvas.height = Math.round(displayHeight * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, displayWidth, displayHeight);

    if (!frame) return;

    if (!frame.detected || !frame.image) {
      // An undetected frame is a fact, and saying so is the honest thing. A
      // blank overlay would read as "the overlay is broken".
      context.fillStyle = "rgba(255, 138, 101, 0.92)";
      context.font = "13px ui-sans-serif, system-ui, sans-serif";
      context.fillText("no pose detected in this frame", 12, 22);
      return;
    }

    const landmarks = frame.image;
    const floor = showLowConfidence ? 0 : 0.1;

    const at = (landmark: RawLandmark): [number, number] => [
      landmark.x * displayWidth,
      landmark.y * displayHeight,
    ];

    // Connections first, so the joint dots sit on top of them.
    context.lineWidth = 2;
    for (const [from, to] of MP_CONNECTIONS) {
      const a = landmarks[from];
      const b = landmarks[to];
      if (!a || !b) continue;
      if (a.visibility < floor || b.visibility < floor) continue;

      // A link is only as certain as its weaker end, and it is drawn that way
      // rather than at a uniform confident opacity.
      const strength = Math.min(a.visibility, b.visibility);
      context.strokeStyle = `rgba(124, 246, 160, ${0.12 + strength * 0.55})`;
      const [ax, ay] = at(a);
      const [bx, by] = at(b);
      context.beginPath();
      context.moveTo(ax, ay);
      context.lineTo(bx, by);
      context.stroke();
    }

    landmarks.forEach((landmark) => {
      if (!landmark || landmark.visibility < floor) return;
      const [x, y] = at(landmark);
      const weak = landmark.visibility < WEAK_VISIBILITY;

      context.beginPath();
      context.arc(x, y, weak ? 2.5 : 4, 0, Math.PI * 2);
      context.fillStyle = weak
        ? `rgba(255, 213, 79, ${0.3 + landmark.visibility})`
        : `rgba(124, 246, 160, ${0.45 + landmark.visibility * 0.5})`;
      context.fill();

      // A ring around anything the detector is unsure of, so low confidence
      // is visible as a shape and not only as a slightly dimmer dot.
      if (weak) {
        context.strokeStyle = "rgba(255, 213, 79, 0.65)";
        context.lineWidth = 1;
        context.beginPath();
        context.arc(x, y, 7, 0, Math.PI * 2);
        context.stroke();
      }
    });
  }, [frame, showLowConfidence, width, height]);

  return <canvas ref={canvasRef} className="lab-raw-overlay" />;
}
