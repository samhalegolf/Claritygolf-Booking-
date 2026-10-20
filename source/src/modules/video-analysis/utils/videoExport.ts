import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  UrlSource,
  canEncodeVideo,
  type InputVideoTrack,
  type Source,
  type WrappedCanvas,
} from "mediabunny";

import type { DrawingObject } from "../models/Drawing";
import { t } from "../../../lib/i18n";
import { drawAnalysisObject, getRecordingFileName } from "./analysisRecorder";

// Export the analysis view as a video file the coach can send anywhere.
//
// The screen recorder plays the clip in real time and films a canvas. An export
// can't work that way: two clips playing side by side drift, a phone drops
// frames under load, and a 20-second clip would take 20 seconds. So each frame
// is decoded straight out of the file at an exact time, the drawings are painted
// on, and it is encoded with its own timestamp. Two clips stay frame-for-frame
// in step, nothing is filmed, and the coach's player on screen is never touched.
//
// Always H.264 in MP4, because that is what Messages, WhatsApp, Mail and every
// phone's photo library take without converting. No sound: a lesson clip's
// audio is range noise, and two clips side by side would have two soundtracks.

export const EXPORT_FRAME_RATE = 30;
/** Neither side of the finished video is longer than this. Never upscaled. */
const MAX_EXPORT_EDGE = 1920;

export type ExportPane = {
  sourceUrl: string;
  objects: DrawingObject[];
  /** Width the drawings were made at on screen, so strokes keep their weight. */
  overlayWidth: number;
  /** Where this clip sits on the export's clock: clip time = export time + offsetS. */
  offsetS: number;
};

export type PaneRect = { x: number; y: number; width: number; height: number };

export type VideoExportResult = { blob: Blob; fileName: string };

const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);

/**
 * Clips side by side at one shared height. Even pixel sizes, because H.264
 * encoders refuse odd ones.
 */
export function layoutExportPanes(
  sizes: Array<{ width: number; height: number }>,
  maxEdge = MAX_EXPORT_EDGE
): { width: number; height: number; rects: PaneRect[] } {
  const aspects = sizes.map((size) => (size.width > 0 && size.height > 0 ? size.width / size.height : 16 / 9));
  const totalAspect = aspects.reduce((sum, aspect) => sum + aspect, 0);
  // The shortest clip's own height is the ceiling: blowing a clip up adds
  // file size and nothing anyone can see.
  const nativeHeight = Math.min(...sizes.map((size) => (size.height > 0 ? size.height : maxEdge)));
  const height = even(Math.min(maxEdge, nativeHeight, maxEdge / totalAspect));
  let x = 0;
  const rects = aspects.map((aspect) => {
    const rect = { x, y: 0, width: even(aspect * height), height };
    x += rect.width;
    return rect;
  });
  return { width: x, height, rects };
}

/**
 * The export's clock runs from the first moment either clip is showing to the
 * last, so nothing either clip holds is cut off.
 */
export function exportTimeline(
  panes: Array<{ durationS: number; offsetS: number }>,
  fps = EXPORT_FRAME_RATE
): { startS: number; frameCount: number } {
  const startS = Math.min(...panes.map((pane) => -pane.offsetS));
  const endS = Math.max(...panes.map((pane) => pane.durationS - pane.offsetS));
  return { startS, frameCount: Math.max(1, Math.round((endS - startS) * fps)) };
}

/**
 * The clip time to show on a given export frame. Before a clip starts it holds
 * its first frame, after it ends its last, so the shorter clip waits rather
 * than going black.
 */
export function clipTimeAt(
  frame: number,
  timeline: { startS: number },
  pane: { durationS: number; offsetS: number },
  fps = EXPORT_FRAME_RATE
) {
  const time = timeline.startS + frame / fps + pane.offsetS;
  // A hair inside the end: a frame is found at or before the asked time, and
  // asking at the end exactly can fall past the last one.
  return Math.min(Math.max(0, time), Math.max(0, pane.durationS - 0.001));
}

async function openSource(url: string, signal?: AbortSignal): Promise<Source> {
  // A clip loaded from this device is a blob: URL, which is already in memory.
  // Anything else is streamed with range requests rather than downloaded whole.
  if (url.startsWith("blob:") || url.startsWith("data:")) {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(t("Could not load the video."));
    return new BlobSource(await response.blob());
  }
  return new UrlSource(url, { requestInit: { credentials: "same-origin", signal } });
}

// Never shown: a cancelled export just closes.
const abortError = () => new DOMException("Export cancelled", "AbortError");

type OpenedPane = {
  pane: ExportPane;
  track: InputVideoTrack;
  firstS: number;
  durationS: number;
  width: number;
  height: number;
};

export async function exportAnalysisVideo(
  panes: ExportPane[],
  options: { title: string; signal?: AbortSignal; onProgress?: (fraction: number) => void }
): Promise<VideoExportResult> {
  if (!panes.length) throw new Error(t("Load a video before exporting."));
  options.signal?.throwIfAborted();
  // An untouched single video already is the deliverable. Copy it directly;
  // re-encoding every frame needlessly blocks sharing and uses large buffers.
  if (panes.length === 1 && panes[0].objects.length === 0 && panes[0].offsetS === 0) {
    const response = await fetch(panes[0].sourceUrl, { signal: options.signal, credentials: "same-origin" });
    if (!response.ok) throw new Error(t("Could not load the video."));
    const blob = await response.blob();
    options.signal?.throwIfAborted();
    if (blob.type.split(";")[0].toLowerCase() === "video/mp4" && blob.size > 0) {
      options.onProgress?.(1);
      const label = options.title.trim().replace(/\.(mp4|mov|webm|m4v)$/i, "")
        .replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
      return { blob, fileName: (label || "clarity-video") + ".mp4" };
    }
  }
  if (typeof VideoEncoder === "undefined") {
    throw new Error(t("This browser can't create video files. Try the latest Chrome or Safari."));
  }
  const { signal, onProgress } = options;
  const inputs: Input[] = [];
  const streams: Array<AsyncIterator<WrappedCanvas | null>> = [];
  let output: Output | null = null;

  // Dispose decoders immediately on cancellation, including while metadata or
  // a frame promise is pending. Never wait for iterator.return before dispose.
  const disposeInputs = () => inputs.forEach((input) => input.dispose());
  const cancelOutput = () => {
    if (output && output.state !== "finalized" && output.state !== "canceled") {
      void output.cancel().catch(() => undefined);
    }
  };
  const cancel = () => { disposeInputs(); cancelOutput(); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    signal?.throwIfAborted();
    const opened: OpenedPane[] = [];
    for (const pane of panes) {
      const input = new Input({ formats: ALL_FORMATS, source: await openSource(pane.sourceUrl, signal) });
      inputs.push(input);
      signal?.throwIfAborted();
      const track = await input.getPrimaryVideoTrack();
      if (!track || !(await track.canDecode())) {
        throw new Error(t("This video can't be read for export."));
      }
      const firstS = await track.getFirstTimestamp();
      opened.push({
        pane,
        track,
        firstS,
        durationS: Math.max(0, (await track.computeDuration()) - firstS),
        width: await track.getDisplayWidth(),
        height: await track.getDisplayHeight(),
      });
    }
    if (signal?.aborted) throw abortError();

    const layout = layoutExportPanes(opened);
    if (!(await canEncodeVideo("avc", { width: layout.width, height: layout.height }))) {
      throw new Error(t("This browser can't create video files. Try the latest Chrome or Safari."));
    }
    const timeline = exportTimeline(opened.map((entry) => ({ durationS: entry.durationS, offsetS: entry.pane.offsetS })));

    const canvas = document.createElement("canvas");
    canvas.width = layout.width;
    canvas.height = layout.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error(t("Could not export the video."));

    output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
    const source = new CanvasSource(canvas, { codec: "avc", bitrate: QUALITY_HIGH });
    output.addVideoTrack(source, { frameRate: EXPORT_FRAME_RATE });
    await output.start();

    opened.forEach((entry, index) => {
      const rect = layout.rects[index];
      const sink = new CanvasSink(entry.track, { width: rect.width, height: rect.height, fit: "contain", poolSize: 2 });
      const pane = { durationS: entry.durationS, offsetS: entry.pane.offsetS };
      function* times() {
        for (let frame = 0; frame < timeline.frameCount; frame += 1) {
          yield entry.firstS + clipTimeAt(frame, timeline, pane);
        }
      }
      streams.push(sink.canvasesAtTimestamps(times())[Symbol.asyncIterator]());
    });

    for (let frame = 0; frame < timeline.frameCount; frame += 1) {
      if (signal?.aborted) throw abortError();
      const decoded = await Promise.all(streams.map((stream) => stream.next()));
      ctx.fillStyle = "black";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      decoded.forEach((result, index) => {
        const rect = layout.rects[index];
        const { pane } = opened[index];
        if (!result.done && result.value) {
          ctx.drawImage(result.value.canvas, rect.x, rect.y, rect.width, rect.height);
        }
        ctx.save();
        // A line drawn off the edge of one clip must not spill onto the other.
        ctx.beginPath();
        ctx.rect(rect.x, rect.y, rect.width, rect.height);
        ctx.clip();
        ctx.translate(rect.x, rect.y);
        const strokeScale = pane.overlayWidth > 0 ? rect.width / pane.overlayWidth : 1;
        pane.objects.forEach((object) => drawAnalysisObject(ctx, object, rect.width, rect.height, strokeScale));
        ctx.restore();
      });
      await source.add(frame / EXPORT_FRAME_RATE, 1 / EXPORT_FRAME_RATE);
      onProgress?.((frame + 1) / timeline.frameCount);
    }

    source.close();
    await output.finalize();
    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer) throw new Error(t("Could not export the video."));
    const label = options.title.trim().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
    return {
      blob: new Blob([buffer], { type: "video/mp4" }),
      fileName: getRecordingFileName(label || "clarity-analysis", "video/mp4"),
    };
  } catch (error) {
    cancelOutput();
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    disposeInputs();
    // An iterator waiting on a decoder may never resolve return(). Cleanup
    // must not prevent the caller from seeing the error or trying again.
    streams.forEach((stream) => { void stream.return?.().catch(() => undefined); });
  }
}
