import { useEffect, useState } from "react";
import { t } from "../../../lib/i18n";
import { canShareFile, exportFile, hasAppShareSheet, shareFile } from "../../../native/nativeFiles";

type Props = {
  video: { id: string; title: string; action: "export" | "share" };
  resolveUrl: (id: string) => Promise<string | null>;
  onClose: () => void;
};

/** Prepare first, then take a fresh tap so browser share activation is retained. */
export function VideoFileDialog({ video, resolveUrl, onClose }: Props) {
  const [file, setFile] = useState<{ blob: Blob; name: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setFile(null);
    setError("");
    void (async () => {
      const url = await resolveUrl(video.id);
      if (!url) throw new Error(t("This video is unavailable. Reconnect its storage and try again."));
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(t("Could not load the video."));
      const blob = await response.blob();
      if (!blob.size) throw new Error(t("The video file is empty."));
      const extension = blob.type.includes("webm") ? "webm" : blob.type.includes("quicktime") ? "mov" : "mp4";
      const title = video.title.replace(/[\\/:*?"<>|]+/g, "-").replace(/\.(mp4|mov|webm)$/i, "") || "Clarity-video";
      if (live) setFile({ blob, name: title + "." + extension });
    })().catch((reason: unknown) => {
      if (live) setError(reason instanceof Error ? reason.message : t("Could not load the video."));
    });
    return () => { live = false; controller.abort(); };
  }, [video.id, video.title, resolveUrl]);

  const deliver = async (action: "export" | "share") => {
    if (!file || busy) return;
    setBusy(true);
    setError("");
    try {
      if (action === "share") await shareFile(file.blob, file.name);
      else await exportFile(file.blob, file.name);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("Could not send the video."));
    } finally { setBusy(false); }
  };
  return (
    <section className="save-destination-prompt" role="dialog" aria-modal="true" aria-label={video.action === "share" ? t("Share") : t("Export")}>
      <div className="save-destination-copy">
        <strong>{file ? t("Video ready") : error ? t("Video unavailable") : t("Preparing video…")}</strong>
        <span>{file?.name || video.title}</span>
        {hasAppShareSheet() ? <span>{t("To export a copy to your device, choose Export, then Save to Files.")}</span> : null}
        {file && !canShareFile(file.blob, file.name) ? <span>{t("File sharing is unavailable here. Export the video, then open it in another app.")}</span> : null}
        {error ? <span role="alert">{error}</span> : null}
      </div>
      <div className="save-destination-actions">
        <button type="button" className="upload-button" disabled={!file || busy} onClick={() => void deliver("export")}>{t("Export")}</button>
        <button type="button" className="upload-button" disabled={!file || busy || !canShareFile(file.blob, file.name)} onClick={() => void deliver("share")}>{t("Share")}</button>
        <button type="button" className="upload-button is-subtle" disabled={busy} onClick={onClose}>{t("Done")}</button>
      </div>
    </section>
  );
}
