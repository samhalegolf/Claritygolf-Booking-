/**
 * The timeline: a scrubber with a confidence ribbon under it.
 *
 * The ribbon is the reason this is a canvas rather than an <input type=range>
 * with a thumb. Seeing WHERE in a swing the reconstruction struggled is the
 * fastest route to understanding why -- a dip that lines up with transition
 * means something quite different from one that lines up with the moment the
 * hands pass in front of the body. A slider alone hides that.
 *
 * The range input is still there, underneath, doing the keyboard and
 * accessibility work; the canvas is decoration over the top of it.
 */

import { useEffect, useRef } from "react";

import type { ClaritySequence } from "../../contracts";
import { PROVENANCE_COLOURS } from "../../space3d/palette";

/**
 * The ribbon's CSS height. The canvas is drawn to its MEASURED height rather
 * than this, because the 1px border is inside the box: a canvas styled 34px
 * tall reports a 32px drawing surface, and drawing to 34 silently clips the
 * provenance strip along the bottom -- the one row whose whole job is to be
 * visible.
 */
const RIBBON_CSS_HEIGHT = 34;

const hexToCss = (hex: number) => `#${hex.toString(16).padStart(6, "0")}`;

export function Timeline({
  sequence,
  frameIndex,
  onSeek,
}: {
  sequence: ClaritySequence;
  frameIndex: number;
  onSeek: (index: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const draw = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight || RIBBON_CSS_HEIGHT;
      if (width <= 0 || height <= 0) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      const stripHeight = 5;
      const barArea = height - stripHeight - 1;

      const frames = sequence.frames;
      if (frames.length === 0) return;
      const columnWidth = width / frames.length;

      frames.forEach((frame, index) => {
        const x = index * columnWidth;

        // Bar height is the frame's overall confidence.
        const barHeight = Math.max(1, frame.confidence.overall * barArea);
        context.fillStyle = "#2b3a4a";
        context.fillRect(x, 0, Math.max(1, columnWidth), barArea);
        context.fillStyle = "#4b6b8a";
        context.fillRect(x, barArea - barHeight, Math.max(1, columnWidth), barHeight);

        // A strip along the bottom in the colour of the worst provenance on
        // that frame, so dropouts are findable at a glance even when the
        // confidence dip they cause is shallow.
        const worst = worstProvenance(frame);
        if (worst !== "observed") {
          context.fillStyle = hexToCss(PROVENANCE_COLOURS[worst]);
          context.fillRect(x, height - stripHeight, Math.max(1, columnWidth), stripHeight);
        }
      });

      // Playhead.
      const playheadX = (frameIndex + 0.5) * columnWidth;
      context.strokeStyle = "#ffffff";
      context.lineWidth = 1.5;
      context.beginPath();
      context.moveTo(playheadX, 0);
      context.lineTo(playheadX, height);
      context.stroke();
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [sequence, frameIndex]);

  const frame = sequence.frames[frameIndex];
  const seconds = frame ? frame.timestampMs / 1000 : 0;

  return (
    <div className="lab-timeline">
      <canvas ref={canvasRef} className="lab-timeline-ribbon" />
      <input
        className="lab-timeline-range"
        type="range"
        min={0}
        max={Math.max(0, sequence.frames.length - 1)}
        step={1}
        value={frameIndex}
        onChange={(event) => onSeek(Number(event.target.value))}
        aria-label="Frame"
      />
      <div className="lab-timeline-readout">
        <span>
          frame {frameIndex} / {sequence.frames.length - 1}
        </span>
        <span>{seconds.toFixed(3)}s</span>
        <span>{sequence.fps} fps</span>
      </div>
    </div>
  );
}

const SEVERITY = ["observed", "anchored", "constrained", "reconstructed", "extrapolated", "missing"] as const;

const worstProvenance = (frame: ClaritySequence["frames"][number]) => {
  let worstIndex = 0;
  for (const provenance of Object.values(frame.provenance.joints)) {
    const index = SEVERITY.indexOf(provenance.source);
    if (index > worstIndex) worstIndex = index;
  }
  return SEVERITY[worstIndex];
};
