/**
 * The 3D Space, as a React component.
 *
 * React owns WHAT is shown -- which frame, which layers, which camera. The
 * scene owns HOW, and is a plain class holding three.js objects. That split
 * keeps sixty-per-second mutation out of React's hands: re-rendering a
 * component tree every frame to move a skeleton would be a fight with the
 * reconciler that the reconciler would win.
 */

import { useEffect, useRef, useState } from "react";

import type { ClarityFrame, ClaritySequence, Vec3 } from "../contracts";
import { ClarityScene, type ScenePick } from "./ClarityScene";
import { PickCard } from "./PickCard";
import type { CameraPreset } from "./cameraRig";
import type { SceneLayers } from "./layers";

export interface ClaritySpace3DProps {
  readonly sequence: ClaritySequence;
  readonly frame: ClarityFrame;
  readonly layers: SceneLayers;
  readonly cameraPreset: CameraPreset;
  readonly ballPosition?: Vec3;
  /** Raised when the viewer drags, since that takes the camera off its preset. */
  readonly onCameraTakenOver?: () => void;
}

export function ClaritySpace3D(props: ClaritySpace3DProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<ClarityScene | null>(null);

  // The render loop reads these rather than closing over props, so it is
  // started once and never has to be torn down and rebuilt on every change.
  const latest = useRef(props);
  latest.current = props;

  const takeoverRef = useRef(props.onCameraTakenOver);
  takeoverRef.current = props.onCameraTakenOver;

  /** What the viewer last clicked on. Follows the playhead until dismissed. */
  const [pick, setPick] = useState<ScenePick | null>(null);

  /* ---- lifecycle: create the scene once ---- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const scene = new ClarityScene(canvas);
    sceneRef.current = scene;

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const { width, height } = parent.getBoundingClientRect();
      if (width > 0 && height > 0) {
        scene.resize(width, height, window.devicePixelRatio);
      }
    };
    resize();

    const observer = new ResizeObserver(resize);
    if (canvas.parentElement) observer.observe(canvas.parentElement);

    let raf = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const delta = Math.min(0.1, (now - previous) / 1000);
      previous = now;
      scene.render(delta);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  /* ---- pointer: orbit, pan, dolly ---- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let dragButton: number | null = null;
    let lastX = 0;
    let lastY = 0;
    let downX = 0;
    let downY = 0;
    let travelled = 0;

    const onPointerDown = (event: PointerEvent) => {
      dragButton = event.button;
      lastX = event.clientX;
      lastY = event.clientY;
      downX = event.clientX;
      downY = event.clientY;
      travelled = 0;
      canvas.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (dragButton === null) return;
      const scene = sceneRef.current;
      if (!scene) return;

      const deltaX = event.clientX - lastX;
      const deltaY = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      travelled = Math.hypot(event.clientX - downX, event.clientY - downY);

      // A press that has not gone anywhere yet is still a possible click, so
      // the camera is left alone until the pointer genuinely moves.
      if (travelled < CLICK_TRAVEL_PX) return;

      // Any drag means the viewer is steering, so the preset no longer
      // describes where the camera is. Say so rather than leaving a highlighted
      // button claiming a view that is no longer on screen.
      takeoverRef.current?.();
      if (dragButton === 0 && !event.shiftKey) scene.rig.orbit(deltaX, deltaY);
      else scene.rig.pan(deltaX, deltaY);
    };

    const endDrag = (event: PointerEvent) => {
      if (dragButton === null) return;
      const wasClick = dragButton === 0 && travelled < CLICK_TRAVEL_PX;
      dragButton = null;
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      if (!wasClick) return;

      const scene = sceneRef.current;
      if (!scene) return;
      const rect = canvas.getBoundingClientRect();
      const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
      setPick(scene.pick(ndcX, ndcY));
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      takeoverRef.current?.();
      sceneRef.current?.rig.dolly(event.deltaY);
    };

    // Right-drag pans, so the context menu has to stay out of the way.
    const onContextMenu = (event: Event) => event.preventDefault();

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onContextMenu);

    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", endDrag);
      canvas.removeEventListener("pointercancel", endDrag);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContextMenu);
    };
  }, []);

  /* ---- props -> scene ---- */

  useEffect(() => {
    sceneRef.current?.setSubject({
      sequence: props.sequence,
      ballPosition: props.ballPosition,
    });
  }, [props.sequence, props.ballPosition]);

  useEffect(() => {
    sceneRef.current?.setLayers(props.layers);
  }, [props.layers]);

  useEffect(() => {
    sceneRef.current?.showFrame(props.frame);
  }, [props.frame]);

  useEffect(() => {
    if (props.cameraPreset !== "free") {
      sceneRef.current?.setCameraPreset(props.cameraPreset);
    }
  }, [props.cameraPreset]);

  return (
    <>
      <canvas ref={canvasRef} className="clarity-space-canvas" />
      {pick && (
        <PickCard
          pick={pick}
          frame={props.frame}
          sequence={props.sequence}
          onClose={() => setPick(null)}
        />
      )}
    </>
  );
}

/** Pointer travel below which a press-and-release is a click, not a drag. */
const CLICK_TRAVEL_PX = 4;
