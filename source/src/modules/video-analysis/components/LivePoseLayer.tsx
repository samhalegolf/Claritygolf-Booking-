import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Dimensions } from "../engines/DrawingEngine";
import { MediaPipePoseProvider } from "../utils/mediaPipePoseProvider";
import type { PoseFrame, PosePoint } from "../utils/poseSwingDetector";
import { MP } from "../../../../motion-lab/src/observe/mediapipe/landmarks";
import { MP_CONNECTIONS } from "../../../../motion-lab/src/observe/mediapipe/connections";

// The two live reads on the flat picture: the detector's markers drawn over
// the body, and a ground-force estimate built from the same landmarks.
//
// Both come from ONE detector run on the <video> the coach is looking at, per
// displayed frame -- playing, stepping or scrubbing, the markers follow the
// picture because they are computed from it. Nothing is precomputed, so there
// is no "analysing…" pass to wait for and nothing to go stale when the clip
// changes. The 3D lab is the other half: it detects the whole clip up front
// and reconstructs. This layer does not reconstruct anything.

/** Below this a landmark is drawn faint and left out of the force estimate. */
const VISIBLE = 0.5;

type PairOf = readonly [number, number];

/**
 * Segment masses as fractions of the body (Dempster's table, rounded), each
 * placed at the midpoint of the landmarks that bound it. A 2D centre of mass
 * from these is an estimate on the image plane, not a measurement.
 */
const SEGMENTS: readonly { share: number; ends: PairOf | readonly [PairOf, PairOf] }[] = [
  { share: 0.081, ends: [MP.LEFT_EAR, MP.RIGHT_EAR] },
  { share: 0.497, ends: [[MP.LEFT_SHOULDER, MP.RIGHT_SHOULDER], [MP.LEFT_HIP, MP.RIGHT_HIP]] },
  { share: 0.028, ends: [MP.LEFT_SHOULDER, MP.LEFT_ELBOW] },
  { share: 0.028, ends: [MP.RIGHT_SHOULDER, MP.RIGHT_ELBOW] },
  { share: 0.022, ends: [MP.LEFT_ELBOW, MP.LEFT_WRIST] },
  { share: 0.022, ends: [MP.RIGHT_ELBOW, MP.RIGHT_WRIST] },
  { share: 0.1, ends: [MP.LEFT_HIP, MP.LEFT_KNEE] },
  { share: 0.1, ends: [MP.RIGHT_HIP, MP.RIGHT_KNEE] },
  { share: 0.0465, ends: [MP.LEFT_KNEE, MP.LEFT_ANKLE] },
  { share: 0.0465, ends: [MP.RIGHT_KNEE, MP.RIGHT_ANKLE] },
  { share: 0.0145, ends: [MP.LEFT_HEEL, MP.LEFT_FOOT_INDEX] },
  { share: 0.0145, ends: [MP.RIGHT_HEEL, MP.RIGHT_FOOT_INDEX] },
];

const midX = (points: PosePoint[], [a, b]: PairOf) => (points[a].x + points[b].x) / 2;

export type GroundForceRead =
  | { kind: "none"; reason: string }
  | {
      kind: "split";
      /** The body's left foot, 0..1 of the load. Right is the remainder. */
      left: number;
      /** Mean landmark visibility over the feet and hips, 0..1. */
      confidence: number;
    };

/**
 * Where the weight sits between the feet, face-on.
 *
 * The centre of mass is dropped straight down and placed on the line between
 * the two foot centres; the share falls out of where it lands -- the same
 * idea as the lab's distributeFootLoad, on the image plane instead of in 3D.
 * Down the line the feet overlap and there is no line to place it on, so
 * that is reported as no read rather than a guess.
 */
export const readGroundForce = (frame: PoseFrame | null): GroundForceRead => {
  const points = frame?.landmarks;
  if (!points || points.length < 33) return { kind: "none", reason: "No body found" };

  const feet = [MP.LEFT_HEEL, MP.LEFT_FOOT_INDEX, MP.RIGHT_HEEL, MP.RIGHT_FOOT_INDEX];
  if (feet.some((index) => (points[index].visibility ?? 1) < VISIBLE)) {
    return { kind: "none", reason: "Feet not in view" };
  }

  const leftX = midX(points, [MP.LEFT_HEEL, MP.LEFT_FOOT_INDEX]);
  const rightX = midX(points, [MP.RIGHT_HEEL, MP.RIGHT_FOOT_INDEX]);
  if (Math.abs(rightX - leftX) < 0.03) {
    return { kind: "none", reason: "Needs a face-on view" };
  }

  let massX = 0;
  for (const segment of SEGMENTS) {
    const x =
      typeof segment.ends[0] === "number"
        ? midX(points, segment.ends as PairOf)
        : (midX(points, segment.ends[0] as PairOf) + midX(points, segment.ends[1] as PairOf)) / 2;
    massX += x * segment.share;
  }

  const t = Math.min(1, Math.max(0, (massX - leftX) / (rightX - leftX)));
  const trusted = [...feet, MP.LEFT_HIP, MP.RIGHT_HIP, MP.LEFT_SHOULDER, MP.RIGHT_SHOULDER];
  const confidence =
    trusted.reduce((sum, index) => sum + (points[index].visibility ?? 1), 0) / trusted.length;
  return { kind: "split", left: 1 - t, confidence };
};

type TrackerStatus = "idle" | "loading" | "ready" | "error";

export type LivePoseLayerProps = {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  showMarkers: boolean;
  showGroundForce: boolean;
  dimensions: Dimensions;
  /**
   * Where the ground-force card goes. The picture's box clips, and the card
   * would cover the swing it describes, so it is put beside the picture in
   * the panel instead of inside it.
   */
  widgetHost: HTMLElement | null;
  onCloseGroundForce?: () => void;
};

/**
 * Sits inside the picture's overlay, so it is measured from the same box as
 * the drawings and lands on the body rather than on the letterbox.
 */
export function LivePoseLayer({
  videoRef,
  showMarkers,
  showGroundForce,
  dimensions,
  widgetHost,
  onCloseGroundForce,
}: LivePoseLayerProps) {
  const active = showMarkers || showGroundForce;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<PoseFrame | null>(null);
  const showMarkersRef = useRef(showMarkers);
  const showForceRef = useRef(showGroundForce);
  const [status, setStatus] = useState<TrackerStatus>("idle");
  const [force, setForce] = useState<GroundForceRead>({ kind: "none", reason: "Finding the body…" });

  showMarkersRef.current = showMarkers;
  showForceRef.current = showGroundForce;

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const points = frameRef.current?.landmarks;
    if (!showMarkersRef.current || !points?.length) return;

    const colour = getComputedStyle(canvas).getPropertyValue("--va-accent").trim() || "white";
    const seen = (index: number) => (points[index]?.visibility ?? 1) >= VISIBLE;

    context.lineWidth = 2.5;
    context.lineCap = "round";
    context.strokeStyle = colour;
    for (const [a, b] of MP_CONNECTIONS) {
      if (!points[a] || !points[b]) continue;
      context.globalAlpha = seen(a) && seen(b) ? 0.9 : 0.25;
      context.beginPath();
      context.moveTo(points[a].x * width, points[a].y * height);
      context.lineTo(points[b].x * width, points[b].y * height);
      context.stroke();
    }

    context.fillStyle = colour;
    points.forEach((point, index) => {
      // The face is five points in a thumbnail's worth of pixels; its lines
      // say enough without dots on top.
      if (index > MP.NOSE && index < MP.LEFT_SHOULDER) return;
      context.globalAlpha = seen(index) ? 1 : 0.3;
      context.beginPath();
      context.arc(point.x * width, point.y * height, 3.5, 0, Math.PI * 2);
      context.fill();
    });
    context.globalAlpha = 1;
  };

  // One detector for as long as either read is wanted. It keys off what the
  // video element is showing rather than off play/seek events, so stepping a
  // frame, scrubbing and playing all go through the same path.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let raf = 0;
    let lastTime = -1;
    let lastStamp = 0;
    let lastForceAt = 0;
    let smoothed: number | null = null;
    const provider = new MediaPipePoseProvider();

    const tick = () => {
      if (cancelled) return;
      const video = videoRef.current;
      if (video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        // VIDEO mode insists on rising timestamps; a scrub backwards is still
        // a later call.
        const stamp = Math.max(performance.now(), lastStamp + 1);
        lastStamp = stamp;
        try {
          frameRef.current = provider.detect(video, stamp);
        } catch {
          frameRef.current = null;
        }
        draw();

        if (showForceRef.current) {
          const read = readGroundForce(frameRef.current);
          if (read.kind === "split") {
            // Lightly smoothed: the raw landmarks shimmer a few percent frame
            // to frame, which reads as noise, not as weight moving.
            smoothed = smoothed === null ? read.left : smoothed + (read.left - smoothed) * 0.4;
          }
          const now = performance.now();
          if (now - lastForceAt > 80) {
            lastForceAt = now;
            setForce(read.kind === "split" && smoothed !== null ? { ...read, left: smoothed } : read);
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };

    setStatus("loading");
    provider
      .initialise()
      .then(() => {
        if (cancelled) return;
        setStatus("ready");
        tick();
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      provider.close();
      frameRef.current = null;
      setStatus("idle");
    };
    // draw reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, videoRef]);

  // Toggling the markers off (or resizing) should not wait for the next frame.
  useEffect(() => {
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMarkers, dimensions.width, dimensions.height]);

  if (!active) return null;

  return (
    <>
      <canvas ref={canvasRef} className="va-pose-canvas" aria-hidden="true" />
      {status === "loading" || status === "error" ? (
        <span className={`va-pose-status${status === "error" ? " is-error" : ""}`} role="status">
          {status === "loading" ? "Loading body tracking…" : "Body tracking could not start"}
        </span>
      ) : null}
      {showGroundForce && widgetHost
        ? createPortal(
            <GroundForceWidget
              read={status === "ready" ? force : status === "error" ? { kind: "none", reason: "Body tracking could not start" } : null}
              onClose={onCloseGroundForce}
            />,
            widgetHost
          )
        : null}
    </>
  );
}

/** The sole from the Clarity Pressure View design, drawn as a left foot. */
const SOLE =
  "M 30 10 C 40 1 56 -1 68 4 C 80 9 90 20 90 34 C 90 48 86 62 82 78 C 78 94 76 106 76 120 C 76 136 79 152 79 168 C 79 190 66 208 48 210 C 30 212 17 196 17 176 C 17 160 21 146 24 130 C 27 112 26 96 22 80 C 18 62 14 48 16 34 C 18 20 23 13 30 10 Z";
const TRAIL_FOOT = "translate(146,36) scale(-0.62,0.62)";
const LEAD_FOOT = "translate(230,36) scale(0.62,0.62)";

/** 0..1 onto the eight --c-load stops. */
const loadStop = (share: number) => `var(--c-load-${Math.min(7, Math.max(0, Math.round(share * 7)))})`;

export type GroundForceWidgetProps = {
  read: GroundForceRead | null;
  /** The body side that is the lead foot. Left for a right-handed player. */
  leadSide?: "left" | "right";
  onClose?: () => void;
};

/**
 * The "Estimated" state of the pressure widget (Clarity Pressure View, "When
 * the data is thin"). Video gives a whole-foot split and nothing finer, so
 * each foot is one hatched fill on the load ramp, and there is no kPa figure,
 * no centre-of-pressure path and no map inside the foot -- inventing those
 * from a picture is the thing the design exists to refuse.
 */
export function GroundForceWidget({ read, leadSide = "left", onClose }: GroundForceWidgetProps) {
  const split = read?.kind === "split" ? read : null;
  const lead = split ? (leadSide === "left" ? split.left : 1 - split.left) : 0;
  const trail = split ? 1 - lead : 0;
  const trailPct = Math.round(trail * 100);

  return (
    <section className="va-force-card" aria-label="Ground force estimate">
      <header className="va-force-head">
        <h2>Ground force</h2>
        <span className="va-force-tag">
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 8 8 2M5 11l6-9" />
          </svg>
          Estimated
        </span>
        {onClose ? (
          <button type="button" className="va-force-close" aria-label="Close ground force" onClick={onClose}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
            </svg>
          </button>
        ) : null}
      </header>

      <svg
        className="va-force-feet"
        viewBox="0 0 376 210"
        role="img"
        aria-label={
          split
            ? `Whole-foot estimate: trail ${trailPct}%, lead ${100 - trailPct}%`
            : "No estimate for this frame"
        }
      >
        <defs>
          <pattern id="va-force-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="7" className="va-force-hatch-line" />
          </pattern>
          <clipPath id="va-force-trail">
            <path d={SOLE} transform={TRAIL_FOOT} />
          </clipPath>
          <clipPath id="va-force-lead">
            <path d={SOLE} transform={LEAD_FOOT} />
          </clipPath>
        </defs>
        <rect x="2" y="4" width="372" height="202" rx="9" className="va-force-area" />
        <text x="112" y="24" textAnchor="middle" className="va-force-foot-label">TRAIL</text>
        <text x="264" y="24" textAnchor="middle" className="va-force-foot-label">LEAD</text>
        {[
          { clip: "va-force-trail", x: 86, share: trail, transform: TRAIL_FOOT },
          { clip: "va-force-lead", x: 237, share: lead, transform: LEAD_FOOT },
        ].map((foot) => (
          <g key={foot.clip}>
            {split ? (
              <g clipPath={`url(#${foot.clip})`}>
                <rect x={foot.x} y="36" width="54" height="136" style={{ fill: loadStop(foot.share) }} />
                <rect x={foot.x} y="36" width="54" height="136" fill="url(#va-force-hatch)" />
              </g>
            ) : null}
            <path d={SOLE} transform={foot.transform} className="va-force-sole" />
          </g>
        ))}
        <text x="188" y="194" textAnchor="middle" className="va-force-caption">
          {split ? "Whole-foot estimate · no map inside the foot" : read?.kind === "none" ? read.reason : "Starting…"}
        </text>
      </svg>

      {split ? (
        <div className="va-force-split">
          <div className="va-force-split-row">
            <b>{trailPct}%</b>
            <span className="va-force-bar" aria-hidden="true">
              <span style={{ width: `${trailPct}%`, background: loadStop(trail) }} />
              <span className="va-force-bar-gap" />
              <span style={{ flexGrow: 1, background: loadStop(lead) }} />
            </span>
            <b>{100 - trailPct}%</b>
          </div>
          <div className="va-force-split-names">
            <span>Trail</span>
            <span>Lead</span>
          </div>
          <p className="va-force-note">
            Worked out from body position. Confidence {Math.round(split.confidence * 100)}%. No
            pressure was measured, so there is no kPa figure and no path.
          </p>
        </div>
      ) : (
        <div className="va-force-split">
          <p className="va-force-empty">No split</p>
          <p className="va-force-note">
            A percentage here would be invented. Face-on, with both feet in frame, gives a read.
          </p>
        </div>
      )}
    </section>
  );
}
