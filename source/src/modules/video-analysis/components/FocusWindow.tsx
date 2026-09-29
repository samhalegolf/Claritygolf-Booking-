import React, { useCallback, useEffect, useRef, useState } from "react";
import type { FocusAreaRect, FocusMode } from "../models/Focus";
import type { ComparisonSide } from "../utils/localPersistence";
import { t } from "../../../lib/i18n";

type ScreenshotResult = { ok: boolean; error?: string };
type ScreenshotStatus = "idle" | "saving" | "success" | "error";

interface FocusWindowProps {
  mode: FocusMode;
  area?: FocusAreaRect | null;
  sideLabel: ComparisonSide;
  onClose: () => void;
  onReselect: () => void;
  enabled: boolean;
  sourceVideo?: HTMLVideoElement | null;
  sourceDimensions: { width: number; height: number };
  onHoverChange?: (isHovering: boolean) => void;
  onScreenshot?: (previewDataUrl: string) => ScreenshotResult | Promise<ScreenshotResult>;
}

export function FocusWindow({
  enabled,
  mode,
  area,
  sideLabel,
  onClose,
  onReselect,
  sourceVideo,
  sourceDimensions,
  onHoverChange,
  onScreenshot,
}: FocusWindowProps) {
  const isArea = mode === "area" && !!area && area.width > 0 && area.height > 0;
  const [cropRenderError, setCropRenderError] = useState(false);
  const [screenshotStatus, setScreenshotStatus] = useState<ScreenshotStatus>("idle");
  const [screenshotMessage, setScreenshotMessage] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(-1);
  const screenshotTimerRef = useRef<number>(-1);
  const hasSource = Boolean(sourceVideo);
  const canCapture = mode === "area" && isArea && hasSource;

  const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), max);

  const setFeedback = useCallback((status: ScreenshotStatus, message: string) => {
    if (screenshotTimerRef.current !== -1) {
      clearTimeout(screenshotTimerRef.current);
      screenshotTimerRef.current = -1;
    }
    setScreenshotStatus(status);
    setScreenshotMessage(message);
    if (status === "success" || status === "error") {
      screenshotTimerRef.current = window.setTimeout(() => {
        setScreenshotStatus("idle");
        setScreenshotMessage("");
      }, 1400);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (screenshotTimerRef.current !== -1) {
        clearTimeout(screenshotTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    setCropRenderError(false);
    if (!isArea || !sourceVideo) {
      return;
    }

    const contextSource = sourceDimensions;
    const previewWidth = 220;
    const dpr = window.devicePixelRatio || 1;

    const safeRenderSize = () => {
      const ratio = contextSource.width > 0 && contextSource.height > 0
        ? (area.height * contextSource.height) / (area.width * contextSource.width)
        : 1;
      const targetHeight = Math.max(100, Math.round(previewWidth * clamp(ratio, 0.25, 3)));
      return {
        width: previewWidth,
        height: targetHeight,
      };
    };

    const previewSize = safeRenderSize();

    if (canvasRef.current) {
      canvasRef.current.width = Math.max(1, Math.round(previewWidth * dpr));
      canvasRef.current.height = Math.max(1, Math.round(previewSize.height * dpr));
      const canvasStyle = canvasRef.current.style;
      canvasStyle.width = `${previewWidth}px`;
      canvasStyle.height = `${previewSize.height}px`;
    }

    const render = () => {
      const canvas = canvasRef.current;
      if (!canvas || !sourceVideo || !area) {
        rafRef.current = requestAnimationFrame(render);
        return;
      }

      const context = canvas.getContext("2d");
      if (!context) {
        setCropRenderError(true);
        rafRef.current = requestAnimationFrame(render);
        return;
      }

      const sourceWidth = Math.max(1, sourceDimensions.width || sourceVideo.videoWidth || 1);
      const sourceHeight = Math.max(1, sourceDimensions.height || sourceVideo.videoHeight || 1);

      const sourceX = clamp(Math.floor(area.x * sourceWidth), 0, sourceWidth - 1);
      const sourceY = clamp(Math.floor(area.y * sourceHeight), 0, sourceHeight - 1);
      const sourceWidthCrop = Math.max(1, Math.floor(area.width * sourceWidth));
      const sourceHeightCrop = Math.max(1, Math.floor(area.height * sourceHeight));

      const clampedWidth = clamp(sourceWidthCrop, 1, sourceWidth - sourceX);
      const clampedHeight = clamp(sourceHeightCrop, 1, sourceHeight - sourceY);

      if (clampedWidth <= 0 || clampedHeight <= 0 || !sourceVideo.readyState) {
        setCropRenderError(true);
        rafRef.current = requestAnimationFrame(render);
        return;
      }

      try {
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(
          sourceVideo,
          sourceX,
          sourceY,
          clampedWidth,
          clampedHeight,
          0,
          0,
          canvas.width,
          canvas.height
        );
        setCropRenderError(false);
      } catch {
        setCropRenderError(true);
      }

      rafRef.current = requestAnimationFrame(render);
    };

    rafRef.current = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(rafRef.current);
    };
  }, [area, enabled, isArea, sourceDimensions, sourceVideo]);

  const areaDetails = area
    ? `x ${Math.round(area.x * 100)}% • y ${Math.round(area.y * 100)}% • w ${Math.round(
        area.width * 100
      )}% • h ${Math.round(area.height * 100)}%`
    : t("No area selected");

  // Structural ability to render a crop, independent of transient decode
  // errors. The canvas stays mounted whenever this is true so the render loop
  // can recover once the source is ready again.
  const canRenderCrop = mode === "area" && isArea && hasSource;
  const showPlaceholder = !canRenderCrop || cropRenderError;

  const renderFallback = showPlaceholder
    ? mode === "track"
      ? t("Track focus is placeholder-only in this foundation.")
      : hasSource
        ? t("Live crop is not available for the selected area right now.")
        : t("No {side} video is available for live focus rendering.", { side: sideLabel })
    : t("Live area focus lens active.");

  const trackMouseEnter = useCallback(() => onHoverChange?.(true), [onHoverChange]);
  const trackMouseLeave = useCallback(() => onHoverChange?.(false), [onHoverChange]);
  const doNothing = useCallback(() => undefined, []);

  // A capture no longer lands in the analysis on its own -- it opens a note
  // beside the crop and is filed from there, so the wording stops at "taken".
  const screenshotButtonText = screenshotStatus === "saving"
    ? t("Capturing...")
    : screenshotStatus === "success"
      ? t("Captured")
      : screenshotStatus === "error"
        ? t("Retry")
        : t("Screenshot");

  const handleScreenshot = useCallback(async () => {
    if (!onScreenshot) {
      setFeedback("error", t("Screenshot action is unavailable."));
      return;
    }

    if (!canCapture) {
      setFeedback("error", t("No active area crop to capture yet."));
      return;
    }

    setFeedback("saving", t("Capturing crop..."));
    try {
      const imageDataUrl = canvasRef.current ? canvasRef.current.toDataURL("image/png") : "";
      const result = await Promise.resolve(onScreenshot(imageDataUrl));
      if (result.ok) {
        setFeedback("success", t("Add your note, then Save."));
        return;
      }
      setFeedback("error", result.error || t("Could not capture snapshot."));
    } catch {
      setFeedback("error", t("Could not capture snapshot."));
    }
  }, [canCapture, onScreenshot, setFeedback]);

  if (!enabled) return null;

  return (
    <div
      className="focus-window"
      onMouseEnter={trackMouseEnter}
      onMouseLeave={trackMouseLeave}
    >
      <div className="focus-window-header">
        <div className="focus-window-title">
          <strong>{t("Focus lens")}</strong>
          <span className="focus-window-subtitle">
            {mode === "track" ? t("Track focus beta") : t("Area focus · {sideLabel}", { sideLabel: sideLabel.toUpperCase() })}
          </span>
        </div>
      </div>

      <div className="focus-window-preview-shell">
        {canRenderCrop ? (
          <canvas
            ref={canvasRef}
            className="focus-window-preview"
            style={cropRenderError ? { display: "none" } : undefined}
          />
        ) : null}
        {showPlaceholder ? (
          <div className="focus-window-placeholder">{renderFallback}</div>
        ) : null}
      </div>

      {mode === "area" ? (
        <div className="focus-window-metadata">{t("Live area: {areaDetails}", { areaDetails })}</div>
      ) : null}

      {screenshotMessage ? (
        <div
          className={`focus-window-feedback focus-window-feedback--${screenshotStatus}`}
          role="status"
        >
          {screenshotMessage}
        </div>
      ) : null}

      <div className="focus-window-controls">
        <button type="button" className="focus-window-control" onClick={onReselect}>{t("Reselect")}</button>
        <button
          type="button"
          className="focus-window-control"
          onClick={handleScreenshot}
          disabled={screenshotStatus === "saving"}
          title={canCapture ? t("Capture current focus crop") : t("Capture unavailable")}
        >
          {screenshotButtonText}
        </button>
        <button
          type="button"
          className="focus-window-control focus-window-control--disabled"
          disabled
          title={t("Save clip (coming later)")}
        >{t("Save clip (coming later)")}</button>
        <button type="button" className="focus-window-control" onClick={doNothing}>{t("Expand")}</button>
        <button type="button" className="focus-window-control focus-window-control--danger" onClick={onClose}>{t("Close")}</button>
      </div>
    </div>
  );
}
