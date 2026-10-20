import { hasDeferredVideoExport, hasDeferredVideoShare, shareVideoDeferred } from "../../../native/deferredVideoShare";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../../../lib/i18n";
import {
  canShareFile, chooseVideoExportDestination, exportFile, hasAppShareSheet, shareFile, writeVideoExport,
} from "../../../native/nativeFiles";
import "./videoFileDialog.css";

export type VideoFileAction = "export" | "share";
export type PreparedVideoFile = { blob: Blob; fileName: string };
type PrepareVideo = (signal: AbortSignal, progress: (value: number) => void) => Promise<PreparedVideoFile>;
type DeliveryState = {
  action: VideoFileAction;
  phase: "choosing" | "preparing" | "ready" | "sending" | "saved" | "error" | "native-choosing" | "native-preparing" | "native-handover";
  percent: number;
  file?: PreparedVideoFile;
  savedName?: string;
  error?: string;
};

export function videoFileName(title: string, mimeType = "video/mp4") {
  const name = title.replace(/[\\/:*?"<>|]+/g, "-").trim() || "Clarity-video";
  if (/\.(mp4|mov|webm|m4v)$/i.test(name)) return name;
  return name + "." + (mimeType.includes("webm") ? "webm" : mimeType.includes("quicktime") ? "mov" : "mp4");
}

/** Own one delivery at a time. Save As always precedes loading or encoding. */
export function useVideoFileDelivery() {
  const [state, setState] = useState<DeliveryState | null>(null);
  const operation = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const dialogRef = useRef<HTMLElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const open = Boolean(state && !state.phase.startsWith("native-"));
  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
    return () => returnFocus.current?.focus();
  }, [open]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; operation.current?.abort(); };
  }, []);
  const close = useCallback(() => {
    operation.current?.abort();
    operation.current = null;
    setState(null);
  }, []);

  const begin = useCallback((action: VideoFileAction, suggestedName: string, prepare: PrepareVideo) => {
    if (operation.current) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const controller = new AbortController();
    operation.current = controller;
    const live = () => mounted.current && operation.current === controller && !controller.signal.aborted;
    if ((action === "share" && hasDeferredVideoShare()) || (action === "export" && hasDeferredVideoExport())) {
      void shareVideoDeferred(suggestedName, prepare, controller.signal, (stage, fraction) => {
        if (live()) setState({ action, phase: stage === "choosing" ? "native-choosing" : stage === "preparing" ? "native-preparing" : "native-handover", percent: Math.floor(fraction * 100) });
      }, action).then((sent) => { if (live()) setState(sent && action === "export" ? { action, phase: "saved", percent: 100, savedName: suggestedName } : null); }).catch((error: unknown) => {
        if (live()) setState({ action, phase: "error", percent: 0, error: error instanceof Error ? error.message : t("Could not share video.") });
      }).finally(() => { if (operation.current === controller) operation.current = null; });
      return;
    }
    // No await, fetch, encoding or render before asking for a destination.
    let destination;
    try {
      destination = action === "export" ? chooseVideoExportDestination(suggestedName) : Promise.resolve(null);
    } catch (error) {
      operation.current = null;
      setState({ action, phase: "error", percent: 0, error: error instanceof Error ? error.message : t("Could not choose a save location.") });
      return;
    }
    setState({ action, phase: action === "export" ? "choosing" : "preparing", percent: 0 });
    void (async () => {
      const handle = await destination;
      if (!live()) return;
      setState({ action, phase: "preparing", percent: 0 });
      const file = await prepare(controller.signal, (fraction) => {
        if (live()) setState({ action, phase: "preparing", percent: Math.floor(fraction * 100) });
      });
      if (!live()) return;
      if (!file.blob.size) throw new Error(t("The video file is empty."));
      if (action === "export" && handle) {
        setState({ action, phase: "sending", percent: 100 });
        await writeVideoExport(handle, file.blob);
        if (live()) setState({ action, phase: "saved", percent: 100, savedName: handle.name });
      } else {
        // Web Share needs a fresh tap after asynchronous video preparation.
        setState({ action, phase: "ready", percent: 100, file });
      }
    })().catch((reason: unknown) => {
      if (!live()) return;
      if (reason instanceof Error && reason.name === "AbortError") { setState(null); return; }
      setState({ action, phase: "error", percent: 0, error: reason instanceof Error ? reason.message : t("Could not prepare the video.") });
    }).finally(() => {
      if (operation.current === controller) operation.current = null;
    });
  }, []);

  const deliver = async () => {
    if (state?.phase !== "ready" || !state.file || operation.current) return;
    const current = state;
    const controller = new AbortController();
    operation.current = controller;
    const live = () => mounted.current && operation.current === controller && !controller.signal.aborted;
    setState({ ...current, phase: "sending", error: undefined });
    try {
      if (current.action === "share") {
        const sent = await shareFile(current.file!.blob, current.file!.fileName);
        if (live()) setState(sent ? null : current);
      } else {
        await exportFile(current.file!.blob, current.file!.fileName);
        if (live()) setState(hasAppShareSheet() ? current : { ...current, phase: "saved", savedName: current.file!.fileName });
      }
    } catch (reason) {
      if (live()) setState({ ...current, phase: "ready", error: reason instanceof Error ? reason.message : t("Could not send the video.") });
    } finally { if (operation.current === controller) operation.current = null; }
  };

  const nativeWorking = state?.phase === "native-preparing" || state?.phase === "native-handover";
  const nativeChoosing = state?.phase === "native-choosing";
  const busy = nativeChoosing || nativeWorking || state?.phase === "choosing" || state?.phase === "preparing" || state?.phase === "sending";
  const dialog = state && nativeChoosing ? null : state && nativeWorking ? createPortal(
    <aside className="va-file-working" role="status" aria-live="polite">
      <span>{state.phase === "native-handover" ? t("Handing video to app…") : t("Working…")}</span>
      <progress max={100} value={state.phase === "native-handover" ? undefined : state.percent || undefined} aria-label={t("Preparing video")} />
      <button type="button" className="upload-button is-subtle" onClick={close}>{t("Cancel")}</button>
    </aside>, document.body,
  ) : state ? createPortal(
    <div className="va-file-dialog-backdrop" onClick={() => { if (!busy) close(); }}>
      <section className="va-file-dialog" role="dialog" aria-modal="true" aria-label={state.action === "export" ? t("Export") : t("Share")}
        tabIndex={-1} ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape" && state.phase !== "sending") { event.stopPropagation(); close(); }
          if (event.key === "Tab") {
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
            const first = buttons[0], last = buttons[buttons.length - 1];
            if (!first) { event.preventDefault(); return; }
            if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) { event.preventDefault(); first.focus(); }
          }
        }}>
        <strong>{state.phase === "saved" ? t("Video saved") : state.phase === "choosing" ? t("Choose where to save") : state.phase === "preparing" ? t("Preparing video…") : state.phase === "sending" ? t("Sending video…") : state.phase === "error" ? t("Video unavailable") : state.action === "share" ? t("Share video") : t("Export video")}</strong>
        {state.phase === "preparing" ? <progress max={100} value={state.percent || undefined} aria-label={t("Preparing video")} /> : null}
        {state.savedName || state.file ? <span>{state.savedName || state.file?.fileName}</span> : null}
        {state.phase === "ready" && state.action === "export" ? <p>{hasAppShareSheet()
          ? t("Choose Export, then Save to Files in the system sheet.")
          : t("This browser does not provide a Save As picker. Export uses its download location. Use Chrome or Edge to choose a folder before export, or enable “Ask where to save each file” in your browser.")}</p> : null}
        {state.phase === "ready" && state.action === "share" ? <p>{t("Choose Share to pick AirDrop or an app. A copy does not need to be exported to your device first.")}</p> : null}
        {state.file && state.action === "share" && !canShareFile(state.file.blob, state.file.fileName) ? <p role="status">{t("This browser cannot share video files. Use a browser that supports file sharing, or close this and choose Export.")}</p> : null}
        {state.error ? <p role="alert">{state.error}</p> : null}
        <div className="va-file-dialog-actions">
          {state.phase === "ready" ? <button type="button" className="upload-button" disabled={state.action === "share" && !!state.file && !canShareFile(state.file.blob, state.file.fileName)} onClick={() => void deliver()}>{state.action === "export" ? t("Export") : t("Share")}</button> : null}
          <button type="button" className="upload-button is-subtle" disabled={state.phase === "sending"} onClick={close}>{busy ? t("Cancel") : t("Done")}</button>
        </div>
      </section>
    </div>, document.body,
  ) : null;
  return { begin, busy: Boolean(busy), dialog };
}
