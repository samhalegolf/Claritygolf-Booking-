// Draws the lab's view of the green over the camera picture. Everything is
// held in world millimetres or frame pixels; `toScreen` turns frame pixels
// into canvas pixels (it knows the letterboxing).

import type { Point, PuttingLabSnapshot } from "./engine/engine";
import { apply3, radians, RigidTransform, Vec2 } from "./engine/geometry";
import { BALL_BOX_HALF_MM } from "./engine/ball";
import { faceLine, type PutterSource } from "./engine/putter";
import { gateTolerance } from "./engine/stroke";
import type { PutterSample } from "./engine/tracker";

export const DEBUG_LAYERS = [
  "calibrationPoints",
  "physicalAxis",
  "worldAxes",
  "ballSearch",
  "ballCentre",
  "putterMarkers",
  "featurePoints",
  "edgePoints",
  "putterCentre",
  "confidence",
  "timing",
  "impactTime",
  "keepTraces",
] as const;
export type DebugLayer = (typeof DEBUG_LAYERS)[number];

type ToScreen = (p: Point) => Point | null;

const v = (p: Point) => new Vec2(p.x, p.y);
const poseOf = (s: PutterSample) => new RigidTransform(-s.faceAngleWorld, new Vec2(s.x, s.y));

export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  s: PuttingLabSnapshot,
  toScreen: ToScreen,
  layers: ReadonlySet<DebugLayer>,
  keptTraces: PutterSample[][],
  pixelRatio: number,
) {
  const lw = (w: number) => w * pixelRatio;
  const fromWorld = (p: Point): Point | null => {
    if (!s.surface) return null;
    const px = apply3(s.surface.worldToImage, v(p));
    return px ? toScreen(px) : null;
  };
  const path = (points: Point[], project: (p: Point) => Point | null) => {
    ctx.beginPath();
    let started = false;
    for (const p of points) {
      const q = project(p);
      if (!q) continue;
      if (started) ctx.lineTo(q.x, q.y);
      else ctx.moveTo(q.x, q.y);
      started = true;
    }
  };
  const strokeLine = (points: Point[], colour: string, width: number, dash: number[] = [], project = fromWorld) => {
    ctx.save();
    ctx.strokeStyle = colour;
    ctx.lineWidth = lw(width);
    ctx.lineCap = "round";
    ctx.setLineDash(dash.map(lw));
    path(points, project);
    ctx.stroke();
    ctx.restore();
  };
  const dot = (p: Point | null, r: number, colour: string) => {
    if (!p) return;
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.arc(p.x, p.y, lw(r), 0, Math.PI * 2);
    ctx.fill();
  };

  if (layers.has("calibrationPoints") || s.phase === "findingTemplate") {
    // During setup the found marks are the alignment feedback, not just debug.
    ctx.strokeStyle = "#ffd60a";
    ctx.lineWidth = lw(2);
    for (const p of s.templatePoints) {
      const q = toScreen(p);
      if (!q) continue;
      ctx.beginPath();
      ctx.arc(q.x, q.y, lw(8), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  if (!s.surface) return;

  const aim = Vec2.direction(s.target.aimOffset);
  const origin = v(s.surface.ballOrigin);
  if (layers.has("worldAxes")) {
    strokeLine([origin, origin.add(new Vec2(100, 0))], "#ff453a", 1.5);
    strokeLine([origin, origin.add(new Vec2(0, 100))], "#32d74b", 1.5);
  }
  if (layers.has("physicalAxis")) strokeLine([new Vec2(0, -150), new Vec2(0, 900)], "rgba(200,200,200,0.8)", 1, [4, 4]);

  // The virtual aim line: always shown once calibrated.
  strokeLine([origin.sub(aim.mul(150)), origin.add(aim.mul(1500))], "rgba(255,255,255,0.55)", 1.5);

  if (s.phase === "live") {
    // The box the ball goes in, squared to the aim: white while empty, green once the ball is set.
    const across = new Vec2(aim.y, -aim.x);
    const h = BALL_BOX_HALF_MM;
    const box = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([a, b]) => origin.add(across.mul(a * h)).add(aim.mul(b * h)));
    const colour = s.gate === "ready" ? "#32d74b" : s.gate === "waitingForBall" ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.35)";
    strokeLine(box, colour, 2);

    // Practice gates: the start lines that pass clean, as a wedge from where the ball sits.
    const from = s.ballRest ? v(s.ballRest) : origin;
    for (const g of s.target.gates) {
      const tolerance = gateTolerance(g);
      for (const side of [-1, 1]) {
        strokeLine([from, from.add(Vec2.direction(s.target.aimOffset + side * tolerance).mul(g.distance))], "rgba(255,159,10,0.8)", 1.5, [6, 4]);
      }
    }
  }

  if (layers.has("ballSearch") && s.ballSearch) {
    const c = toScreen(s.ballSearch.center);
    const e = toScreen({ x: s.ballSearch.center.x + s.ballSearch.radius, y: s.ballSearch.center.y });
    if (c && e) {
      ctx.strokeStyle = "#64d2ff";
      ctx.lineWidth = lw(1);
      ctx.beginPath();
      ctx.arc(c.x, c.y, Math.hypot(e.x - c.x, e.y - c.y), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  if (layers.has("ballCentre") && s.ball) dot(fromWorld(s.ball), 3, "#64d2ff");

  const shape = s.putterShape;
  const drawTrace = (samples: PutterSample[], impact: number | null, faded: boolean) => {
    if (samples.length < 2 || !shape) return;
    const alpha = faded ? 0.3 : 1;
    // Split at the top of the backswing: the furthest point back along the aim.
    let top = 0;
    samples.forEach((p, i) => {
      if (v(p).dot(aim) < v(samples[top]).dot(aim)) top = i;
    });
    strokeLine(samples.slice(0, top + 1), `rgba(10,132,255,${0.85 * alpha})`, 2);
    strokeLine(samples.slice(top), `rgba(255,255,255,${0.95 * alpha})`, 2.5);
    if (impact === null) return;
    // Face lines every few milliseconds through the impact zone: the face's journey.
    const zone = samples.filter((p) => Math.abs(p.timestamp - impact) <= 0.05);
    const step = Math.max(1, Math.floor(zone.length / 12));
    zone.forEach((p, i) => {
      if (i % step !== 0) return;
      const line = faceLine(shape, poseOf(p));
      strokeLine([line.heel, line.toe], `rgba(255,55,95,${0.8 * alpha})`, 1);
    });
    const nearest = samples.reduce((a, b) => (Math.abs(b.timestamp - impact) < Math.abs(a.timestamp - impact) ? b : a));
    dot(fromWorld(nearest), 5, "#ff375f");
  };
  for (const trace of keptTraces) drawTrace(trace, null, true);
  drawTrace(s.trace, s.gate === "showingResult" ? (s.lastStroke?.impact.time ?? null) : null, false);

  if (s.ballTrace.length >= 2) {
    strokeLine(s.ballTrace, "#ffd60a", 2);
    const start = s.lastStroke?.metrics.start;
    if (s.gate === "showingResult" && start && s.lastStroke) {
      const rest = v(s.lastStroke.ballRest);
      const direction = Vec2.direction(radians(start.value) + s.target.aimOffset);
      strokeLine([rest, rest.add(direction.mul(1500))], "rgba(255,214,10,0.6)", 1, [6, 4]);
    }
  }

  // The putter face as tracked right now.
  if (s.putter && shape) {
    const line = faceLine(shape, poseOf(s.putter));
    const colour = s.putter.confidence > 0.7 ? "#32d74b" : "#ffd60a";
    strokeLine([line.heel, line.toe], colour, 3);
    if (layers.has("putterCentre")) dot(fromWorld(line.center), 3, colour);
  }

  const sources: Array<[DebugLayer, PutterSource, string]> = [
    ["putterMarkers", "markers", "#ff9f0a"],
    ["featurePoints", "features", "#bf5af2"],
    ["edgePoints", "edge", "#32d74b"],
  ];
  for (const [layer, source, colour] of sources) {
    if (!layers.has(layer)) continue;
    for (const p of s.sourcePoints[source] ?? []) dot(toScreen(p), 2, colour);
  }
}

/** The debug readouts, as lines of text (numbers only; nothing here needs translating). */
export function debugText(s: PuttingLabSnapshot, layers: ReadonlySet<DebugLayer>) {
  const lines: string[] = [];
  if (layers.has("timing")) {
    lines.push(`${s.inputFPS.toFixed(0)} fps · ${s.processingMilliseconds.toFixed(2)} ms/frame`);
    if (s.cameraTiltDegrees !== null) lines.push(`tilt ${s.cameraTiltDegrees.toFixed(1)}° · ${s.movement ?? "-"}`);
    if (s.surface) lines.push(`${s.surface.mmPerPixelAtBall.toFixed(2)} mm/px · solve ${s.surface.reprojectionErrorMM.toFixed(2)} mm`);
  }
  if (layers.has("confidence")) {
    lines.push(`putter ${s.putterStatus} ${(s.putter?.confidence ?? 0).toFixed(2)}`);
    const sources = (["markers", "features", "edge"] as const).flatMap((k) =>
      s.sourceConfidence[k] !== undefined ? [`${k} ${s.sourceConfidence[k]!.toFixed(2)}`] : [],
    );
    if (sources.length) lines.push(sources.join(" · "));
    lines.push(`ball ${s.ballStatus} ${(s.ball?.confidence ?? 0).toFixed(2)}`);
  }
  if (layers.has("impactTime") && s.lastStroke) {
    const i = s.lastStroke.impact;
    lines.push(`impact ${i.time.toFixed(4)} s (ball ${i.fromBall?.toFixed(4) ?? "-"}, putter ${i.fromPutter?.toFixed(4) ?? "-"})`);
  }
  return lines;
}
