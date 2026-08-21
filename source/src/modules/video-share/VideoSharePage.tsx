import { useCallback, useEffect, useState } from "react";

import { videoShareToken } from "../shared/bookingHandoff";

// The coach's view of a video someone with no account sent them.
//
// Genuinely no-login: this page never asks who is looking, because the token in
// the URL is the whole credential. That is a deliberate trade -- forwarding the
// email forwards the video -- bounded by the token expiring with the bytes it
// points at, and by there being exactly one video behind it.
//
// Styling is the existing .login-shell / .login-card pair from styles.css, the
// same shell the login screen uses, so this needs no stylesheet of its own.

type ShareResponse = {
  ok?: boolean;
  video?: {
    title: string;
    sizeBytes: number;
    mimeType: string;
    duration: number | null;
    createdAt: string;
  };
  sender?: { name: string; email: string; verified: boolean };
  message?: string;
  expiresAt?: string;
};

const shareUrl = (token: string, action = "") =>
  `/api/video-transfer/share/${encodeURIComponent(token)}${action ? `/${action}` : ""}`;

function formatBytes(bytes: number) {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function formatDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function VideoSharePage() {
  const [token] = useState(videoShareToken);
  const [state, setState] = useState<"loading" | "ready" | "gone">("loading");
  const [share, setShare] = useState<ShareResponse | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [downloadError, setDownloadError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(shareUrl(token), { cache: "no-store" });
        if (!response.ok) throw new Error("gone");
        const data = (await response.json()) as ShareResponse;
        if (cancelled) return;
        setShare(data);
        setState("ready");
      } catch {
        if (!cancelled) setState("gone");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  /**
   * Fetched in slices rather than one request.
   *
   * Netlify's synchronous functions have roughly a ten second wall clock, and
   * the video behind this link can be 150 MB -- a single GET would need to
   * sustain 15 MB/s to survive, which it will not. Playback is fine because
   * the <video> element issues its own Range requests; the explicit download
   * has to do the same thing by hand and reassemble the pieces.
   */
  const download = useCallback(async () => {
    if (downloading) return;
    const total = share?.video?.sizeBytes || 0;
    if (!total) return;
    setDownloading(true);
    setDownloadError("");
    setDownloadPercent(0);
    const sliceBytes = 8 * 1024 * 1024;
    const parts: BlobPart[] = [];
    try {
      for (let start = 0; start < total; start += sliceBytes) {
        const end = Math.min(start + sliceBytes - 1, total - 1);
        const response = await fetch(shareUrl(token, "download"), {
          cache: "no-store",
          headers: { Range: `bytes=${start}-${end}` },
        });
        if (!response.ok && response.status !== 206) throw new Error("slice failed");
        parts.push(await response.arrayBuffer());
        setDownloadPercent(Math.min(100, Math.round(((end + 1) / total) * 100)));
      }
      const blob = new Blob(parts, { type: share?.video?.mimeType || "video/mp4" });
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `${(share?.video?.title || "swing-video").replace(/[\\/:*?"<>|]+/g, "-")}.mp4`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Give the browser a moment to start the save before revoking.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    } catch {
      setDownloadError("The download stopped part way. Try again, or play it above.");
    } finally {
      setDownloading(false);
    }
  }, [downloading, share, token]);

  if (state === "loading") {
    return (
      <main className="login-shell">
        <div className="login-card">
          <p>Loading…</p>
        </div>
      </main>
    );
  }

  // One message for expired, wrong and never-existed alike -- the server does
  // not distinguish them either.
  if (state === "gone" || !share?.video) {
    return (
      <main className="login-shell">
        <div className="login-card">
          <h1>This link has expired</h1>
          <p>
            Videos sent by someone without an account are kept for a limited time. Ask them to
            send it again, or add them as a player in Clarity Golf Booking to keep their videos
            for good.
          </p>
        </div>
      </main>
    );
  }

  const sender = share.sender;

  return (
    <main className="login-shell">
      <div className="login-card">
        <div>
          <p className="eyebrow">Video</p>
          <h1>{share.video.title}</h1>
          {sender && (
            <p>
              Sent by {sender.name}
              {sender.email ? ` (${sender.email})` : ""}.{" "}
              {/* Never let this page imply the identity was checked. It wasn't. */}
              {!sender.verified && "They typed this themselves and do not have an account yet."}
            </p>
          )}
        </div>

        <video
          controls
          playsInline
          preload="metadata"
          src={shareUrl(token, "download")}
          style={{ width: "100%", borderRadius: 9, background: "#000" }}
        />

        {share.message && <p>Their note: {share.message}</p>}

        <p>
          {formatBytes(share.video.sizeBytes)}
          {formatDate(share.video.createdAt) ? ` · ${formatDate(share.video.createdAt)}` : ""}
          {formatDate(share.expiresAt) ? ` · link expires ${formatDate(share.expiresAt)}` : ""}
        </p>

        {downloadError && <div className="auth-error">{downloadError}</div>}

        <button className="primary-button" type="button" onClick={() => void download()} disabled={downloading}>
          {downloading ? `Downloading ${downloadPercent}%` : "Download video"}
        </button>

        <p>
          Add them as a player in Clarity Golf Booking and this video is kept for good, in their
          profile.
        </p>
      </div>
    </main>
  );
}
