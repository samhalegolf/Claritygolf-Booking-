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
 *
 * NOTHING FROM THE MOTION LAYER IS DRAWN HERE. No anchoring, no leash, no
 * constraint, no smoothing. The only Clarity decisions in this file are which
 * marks to show, and a click that says what a mark is.
 */

import { useEffect, useRef, type MouseEvent } from "react";

import { MP_CONNECTIONS } from "../../observe/mediapipe/connections";
import type { ObservationFrame, RawLandmark } from "../../observe/observation";

export interface RawOverlayProps {
  readonly frame: ObservationFrame | null;
  readonly width: number;
  readonly height: number;
  /** Draw every landmark, including ones below the mapping's visibility floor. */
  readonly showLowConfidence: boolean;
  /** The same toggles the 3D Space uses: bones and joint markers. */
  readonly showSkeleton: boolean;
  readonly showLandmarks: boolean;
  /** Landmark index the viewer clicked, or null. Drawn with a halo. */
  readonly selected: number | null;
  readonly onSelect: (index: number | null) => void;
}

/** Below this, a landmark is drawn faintly rather than confidently. */
const WEAK_VISIBILITY = 0.5;
/** How close a click must land to a landmark, CSS pixels. */
const PICK_RADIUS_PX = 14;

export function RawOverlay({
  frame,
  width,
  height,
  showLowConfidence,
  showSkeleton,
  showLandmarks,
  selected,
  onSelect,
}: RawOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const floor = showLowConfidence ? 0 : 0.1;

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

    const at = (landmark: RawLandmark): [number, number] => [
      landmark.x * displayWidth,
      landmark.y * displayHeight,
    ];

    // Connections first, so the joint dots sit on top of them.
    if (showSkeleton) {
      context.lineWidth = 2;
      for (const [from, to] of MP_CONNECTIONS) {
        const a = landmarks[from];
        const b = landmarks[to];
        if (!a || !b) continue;
        if (a.visibility < floor || b.visibility < floor) continue;

        // A link is only as certain as its weaker end, and it is drawn that
        // way rather than at a uniform confident opacity.
        const strength = Math.min(a.visibility, b.visibility);
        context.strokeStyle = `rgba(124, 246, 160, ${0.12 + strength * 0.55})`;
        const [ax, ay] = at(a);
        const [bx, by] = at(b);
        context.beginPath();
        context.moveTo(ax, ay);
        context.lineTo(bx, by);
        context.stroke();
      }
    }

    if (showLandmarks) {
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
    }

    // The selected landmark gets a halo whatever else is shown, so the card
    // beside the video always points at something on screen.
    const chosen = selected === null ? null : landmarks[selected];
    if (chosen) {
      const [x, y] = at(chosen);
      context.strokeStyle = "rgba(255, 255, 255, 0.9)";
      context.lineWidth = 1.5;
      context.beginPath();
      context.arc(x, y, 11, 0, Math.PI * 2);
      context.stroke();
    }
  }, [frame, floor, showSkeleton, showLandmarks, selected, width, height]);

  const onClick = (event: MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !frame?.image) {
      onSelect(null);
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;

    let best: number | null = null;
    let bestDistance = PICK_RADIUS_PX;
    frame.image.forEach((landmark, index) => {
      if (!landmark || landmark.visibility < floor) return;
      const dx = landmark.x * rect.width - px;
      const dy = landmark.y * rect.height - py;
      const d = Math.hypot(dx, dy);
      if (d < bestDistance) {
        bestDistance = d;
        best = index;
      }
    });
    onSelect(best);
  };

  return <canvas ref={canvasRef} className="lab-raw-overlay" onClick={onClick} />;
}
