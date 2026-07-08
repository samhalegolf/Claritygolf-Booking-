import React, { useCallback, useEffect, useRef, useState } from "react";
import { DrawingObject } from "../models/Drawing";
import { Dimensions } from "../engines/DrawingEngine";
import { DrawingPoint } from "../models/Drawing";

export interface VideoCanvasProps {
  sourceUrl: string | null;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onLoadMetadata: () => void;
  objects: DrawingObject[];
  draftObject: DrawingObject | null;
  selectedObjectId: string | null;
  draggedObjectId?: string | null;
  onTrashDrop?: (objectId: string) => boolean;
  onPointerDown: (point: DrawingPoint) => void;
  onPointerMove: (point: DrawingPoint) => void;
  onPointerUp: (point: DrawingPoint) => void;
  overlayDimensions: Dimensions;
  onDimensionsChange: (dimensions: Dimensions) => void;
  onTogglePlay?: () => void;
}

const toPath = (points: DrawingPoint[], width: number, height: number) => {
  if (!points.length) return "";
  const [first, ...rest] = points;
  return `M ${first.x * width} ${first.y * height} ${rest
    .map((point) => `L ${point.x * width} ${point.y * height}`)
    .join(" ")}`;
};

const toScreen = (point: DrawingPoint, dimensions: Dimensions) => ({
  x: point.x * dimensions.width,
  y: point.y * dimensions.height,
});

const HANDLE_VISUAL_RADIUS = 5.4;
const HANDLE_PICK_RADIUS = 11;
const SELECT_OUTLINE = 3;
const TRASH_ZONE_SIZE = 34;
const TRASH_ZONE_MARGIN = 10;
const TRASH_HIT_PADDING = 18;

const HandlePoint = ({
  point,
  color,
}: {
  point: { x: number; y: number };
  color: string;
}) => (
  <>
    <circle
      cx={point.x}
      cy={point.y}
      r={HANDLE_PICK_RADIUS}
      fill="transparent"
      stroke="transparent"
      className="drawing-handle-hit"
    />
    <circle
      cx={point.x}
      cy={point.y}
      r={HANDLE_VISUAL_RADIUS}
      fill="white"
      stroke={color}
      strokeWidth={1.2}
      className="drawing-handle"
    />
  </>
);

export function VideoCanvas({
  sourceUrl,
  videoRef,
  onLoadMetadata,
  objects,
  draftObject,
  selectedObjectId,
  draggedObjectId,
  onTrashDrop,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  overlayDimensions,
  onDimensionsChange,
  onTogglePlay,
}: VideoCanvasProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dimensionsRef = useRef(overlayDimensions);
  dimensionsRef.current = overlayDimensions;
  const [isTrashHovered, setIsTrashHovered] = useState(false);
  const isTrashDropEnabled = !!draggedObjectId;

  const trashTarget = {
    size: TRASH_ZONE_SIZE,
    x: Math.max(TRASH_ZONE_MARGIN, overlayDimensions.width - TRASH_ZONE_SIZE - TRASH_ZONE_MARGIN),
    y: Math.max(TRASH_ZONE_MARGIN, overlayDimensions.height - TRASH_ZONE_SIZE - TRASH_ZONE_MARGIN),
  };

  const isPointOverTrash = (point: { x: number; y: number }) => {
    const centerX = trashTarget.x + trashTarget.size / 2;
    const centerY = trashTarget.y + trashTarget.size / 2;
    const hitRadius = TRASH_ZONE_SIZE / 2 + TRASH_HIT_PADDING;
    return Math.hypot(point.x - centerX, point.y - centerY) <= hitRadius;
  };

  const measure = useCallback(() => {
    const element = overlayRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const next = { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
    if (next.width === dimensionsRef.current.width && next.height === dimensionsRef.current.height) return;
    dimensionsRef.current = next;
    onDimensionsChange(next);
  }, [onDimensionsChange]);

  useEffect(() => {
    measure();
    const element = overlayRef.current;
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure());
    if (resizeObserver && element) {
      resizeObserver.observe(element);
    }
    window.addEventListener("resize", measure);
    return () => {
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      window.removeEventListener("resize", measure);
    };
  }, [measure, onDimensionsChange]);

  const allObjects = [...objects];
  if (draftObject) {
    allObjects.push(draftObject);
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    onPointerDown({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    event.preventDefault();
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const point = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    onPointerMove(point);
    if (isTrashDropEnabled) {
      const isOverTrash = isPointOverTrash(point);
      setIsTrashHovered(isOverTrash);
    } else if (isTrashHovered) {
      setIsTrashHovered(false);
    }
    event.preventDefault();
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const point = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    if (isTrashDropEnabled && draggedObjectId && onTrashDrop && isPointOverTrash(point)) {
      const wasDeleted = onTrashDrop(draggedObjectId);
      if (wasDeleted) {
        setIsTrashHovered(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        event.preventDefault();
        return;
      }
    }
    onPointerUp(point);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (isTrashHovered) {
      setIsTrashHovered(false);
    }
    event.preventDefault();
  };

  return (
    <div
      className="video-frame"
      ref={overlayRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onDoubleClick={onTogglePlay}
    >
      <video
        ref={videoRef}
        src={sourceUrl ?? undefined}
        controls={false}
        playsInline
        preload="metadata"
        onLoadedMetadata={onLoadMetadata}
      />
      <div className="video-overlay">
        <svg
          width={overlayDimensions.width}
          height={overlayDimensions.height}
          style={{ pointerEvents: "none" }}
        >
          {allObjects.map((obj) => {
            if (obj.type === "line") {
              const start = toScreen({ x: obj.x1, y: obj.y1 }, overlayDimensions);
              const end = toScreen({ x: obj.x2, y: obj.y2 }, overlayDimensions);
              const isSelected = obj.id === selectedObjectId;
              return (
                <g key={obj.id}>
                  {isSelected ? (
                    <line
                      x1={start.x}
                      y1={start.y}
                      x2={end.x}
                      y2={end.y}
                      stroke={obj.color}
                      strokeWidth={obj.strokeWidth + SELECT_OUTLINE}
                      opacity={0.26}
                    />
                  ) : null}
                  <line
                    x1={start.x}
                    y1={start.y}
                    x2={end.x}
                    y2={end.y}
                    stroke={obj.color}
                    strokeWidth={obj.strokeWidth}
                    opacity={obj.opacity}
                  />
                  {isSelected && (
                    <>
                      <HandlePoint point={start} color={obj.color} />
                      <HandlePoint point={end} color={obj.color} />
                    </>
                  )}
                </g>
              );
            }
            if (obj.type === "angle") {
              const p1 = toScreen({ x: obj.x1, y: obj.y1 }, overlayDimensions);
              const p2 = toScreen({ x: obj.x2, y: obj.y2 }, overlayDimensions);
              const p3 = toScreen({ x: obj.x3, y: obj.y3 }, overlayDimensions);
              const isSelected = obj.id === selectedObjectId;
              return (
                <g key={obj.id}>
                  {isSelected ? (
                    <>
                      <line
                        x1={p1.x}
                        y1={p1.y}
                        x2={p2.x}
                        y2={p2.y}
                        stroke={obj.color}
                        strokeWidth={obj.strokeWidth + SELECT_OUTLINE}
                        opacity={0.24}
                      />
                      <line
                        x1={p1.x}
                        y1={p1.y}
                        x2={p3.x}
                        y2={p3.y}
                        stroke={obj.color}
                        strokeWidth={obj.strokeWidth + SELECT_OUTLINE}
                        opacity={0.24}
                      />
                    </>
                  ) : null}
                  <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={obj.color} strokeWidth={obj.strokeWidth} opacity={obj.opacity} />
                  <line x1={p1.x} y1={p1.y} x2={p3.x} y2={p3.y} stroke={obj.color} strokeWidth={obj.strokeWidth} opacity={obj.opacity} />
                  {isSelected && (
                    <>
                      <HandlePoint point={p1} color={obj.color} />
                      <HandlePoint point={p2} color={obj.color} />
                      <HandlePoint point={p3} color={obj.color} />
                    </>
                  )}
                </g>
              );
            }
            if (obj.type === "circle") {
              const center = toScreen({ x: obj.cx, y: obj.cy }, overlayDimensions);
              const rx = obj.rx * overlayDimensions.width;
              const ry = obj.ry * overlayDimensions.height;
              const isSelected = obj.id === selectedObjectId;
              const rightHandle = { x: center.x + Math.max(1, rx), y: center.y };
              const bottomHandle = { x: center.x, y: center.y + Math.max(1, ry) };
              return (
                <g key={obj.id}>
                  {isSelected ? (
                    <ellipse
                      cx={center.x}
                      cy={center.y}
                      rx={Math.max(0.5, rx)}
                      ry={Math.max(0.5, ry)}
                      fill="none"
                      stroke={obj.color}
                      strokeWidth={obj.strokeWidth + SELECT_OUTLINE}
                      opacity={0.22}
                    />
                  ) : null}
                  <ellipse
                    cx={center.x}
                    cy={center.y}
                    rx={rx}
                    ry={ry}
                    fill="none"
                    stroke={obj.color}
                    strokeWidth={obj.strokeWidth}
                    opacity={obj.opacity}
                  />
                  <line
                    x1={center.x}
                    y1={center.y}
                    x2={rightHandle.x}
                    y2={rightHandle.y}
                    stroke={obj.color}
                    strokeWidth={0.9}
                    opacity={obj.opacity}
                    strokeDasharray="3 3"
                    className="drawing-guide"
                  />
                  <line
                    x1={center.x}
                    y1={center.y}
                    x2={bottomHandle.x}
                    y2={bottomHandle.y}
                    stroke={obj.color}
                    strokeWidth={0.9}
                    opacity={obj.opacity}
                    strokeDasharray="3 3"
                    className="drawing-guide"
                  />
                  {isSelected && (
                    <>
                      <HandlePoint point={rightHandle} color={obj.color} />
                      <HandlePoint point={bottomHandle} color={obj.color} />
                    </>
                  )}
                </g>
              );
            }
            const path = toPath(obj.points, overlayDimensions.width, overlayDimensions.height);
            const isSelected = obj.id === selectedObjectId;
            return (
              <g key={obj.id}>
                {isSelected ? (
                  <path
                    d={path}
                    fill="none"
                    stroke={obj.color}
                    strokeWidth={obj.strokeWidth + SELECT_OUTLINE}
                    opacity={0.22}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                ) : null}
                <path
                  d={path}
                  fill="none"
                  stroke={obj.color}
                  strokeWidth={obj.strokeWidth}
                  opacity={obj.opacity}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {isSelected && (
                  <circle
                    cx={obj.points.length ? obj.points[0].x * overlayDimensions.width : 0}
                    cy={obj.points.length ? obj.points[0].y * overlayDimensions.height : 0}
                    r={HANDLE_VISUAL_RADIUS}
                    fill="white"
                    stroke={obj.color}
                    strokeWidth={1.2}
                    className="drawing-handle"
                  />
                )}
              </g>
            );
          })}
        </svg>
        {isTrashDropEnabled ? (
          <div
            className={`video-trash-target ${isTrashHovered ? "is-active" : ""}`}
            style={{
              width: `${trashTarget.size}px`,
              height: `${trashTarget.size}px`,
              left: `${trashTarget.x}px`,
              top: `${trashTarget.y}px`,
            }}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path
                d="M4 6.5h12M7 6.5V5.5c0-.7.5-1.2 1.1-1.2h1.8c.6 0 1.1.5 1.1 1.2v1M8 6.5V17m4-10.5V17M11 6.5V17"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M6.4 6.5 6.8 17m6.4-10.5 0.4 10.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                opacity="0.6"
              />
              <path
                d="M6.5 5.5h7M8.4 2.8h3.2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </div>
        ) : null}
      </div>
    </div>
  );
}
