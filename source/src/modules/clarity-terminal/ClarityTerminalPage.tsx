import { useCallback, useEffect, useRef, useState } from "react";

import { setTerminalCode } from "../auth/apiFetch";
import { t } from "../../lib/i18n";
import { getPreferredRecordingMimeType } from "../video-analysis/utils/analysisRecorder";
import {
  createMemorySavedVideoLibraryStore,
  saveSavedVideoToCloud,
} from "../video-analysis/utils/savedVideoLibrary";
import {
  PREVIEW_ICE_SERVERS,
  TerminalApiError,
  answerStationPreview,
  reportStationTake,
  sendStationBeat,
  terminalCodeFromPath,
  waitForIceGathering,
  type StationInstructions,
  type TakeSide,
} from "./terminalApi";
import "./clarityTerminal.css";

// Clarity Terminal: the page the camera computer in the bay is left sitting
// on. Nobody is meant to touch it after the cameras are switched on -- the
// coach drives it from the video workspace on their laptop.
//
// Its whole job:
//   1. hold the cameras open at full quality,
//   2. record them when the coach presses Record, stop when they press Stop,
//   3. send each recording to Clarity Cloud, filed under the coach's player,
//   4. answer the laptop's request for a live preview.

const MAX_CAMERAS = 2;
const BEAT_MS = 1000;
/** A forgotten Stop must not fill the coach's Drive. */
const MAX_RECORDING_MS = 3 * 60 * 1000;
const RECORDING_BITS_PER_SECOND = 16_000_000;
/** The preview is a window onto the bay, not the recording: keep it light. */
const PREVIEW_MAX_BITRATE = 1_500_000;
const UPLOAD_ATTEMPTS = 3;
const SELECTION_KEY = "clarity-terminal-cameras";

type CameraOption = { deviceId: string; label: string };

type ActiveCamera = {
  deviceId: string;
  label: string;
  stream: MediaStream;
  width?: number;
  height?: number;
  fps?: number;
};

type Take = { savedVideoId: string; side: TakeSide; cameraLabel: string };

type ActiveRecording = {
  commandId: string;
  startedAt: number;
  parts: { take: Take; camera: ActiveCamera; recorder: MediaRecorder; chunks: Blob[]; mimeType: string }[];
};

type Upload = {
  take: Take;
  takeCount: number;
  blob: Blob;
  durationMs: number;
  width?: number;
  height?: number;
  fps?: number;
  status: "waiting" | "uploading" | "done" | "failed";
  progress: number;
  error: string;
};

const readSavedSelection = (): string[] => {
  try {
    const raw = window.localStorage.getItem(SELECTION_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
};

const saveSelection = (ids: string[]) => {
  try {
    window.localStorage.setItem(SELECTION_KEY, JSON.stringify(ids));
  } catch {
    // A blocked store only means choosing the cameras again next time.
  }
};

const stopStream = (stream: MediaStream | null | undefined) =>
  stream?.getTracks().forEach((track) => track.stop());

/** Full HD at the highest frame rate the camera offers, up to 60. */
const openCamera = async (option: CameraOption): Promise<ActiveCamera> => {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      deviceId: { exact: option.deviceId },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 60 },
    },
  });
  const settings = stream.getVideoTracks()[0]?.getSettings() || {};
  return {
    deviceId: option.deviceId,
    label: option.label,
    stream,
    width: settings.width,
    height: settings.height,
    fps: settings.frameRate ? Math.round(settings.frameRate) : undefined,
  };
};

const listCameraOptions = async (): Promise<CameraOption[]> => {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === "videoinput" && device.deviceId)
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || t("Camera {number}", { number: index + 1 }),
    }));
};

const formatClock = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** A tiny preview tile. The stream is set on the element, not through React. */
function CameraTile({ camera, recording }: { camera: ActiveCamera; recording: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== camera.stream) ref.current.srcObject = camera.stream;
  }, [camera.stream]);
  return (
    <figure className={`terminal-tile${recording ? " is-recording" : ""}`}>
      <video ref={ref} autoPlay muted playsInline />
      <figcaption>
        <span>{camera.label}</span>
        {camera.width && camera.height ? (
          <span className="terminal-tile-spec">
            {camera.height}p{camera.fps ? ` · ${camera.fps} fps` : ""}
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}

export default function ClarityTerminalPage() {
  const code = terminalCodeFromPath();
  const [linkError, setLinkError] = useState("");
  const [permission, setPermission] = useState<"unknown" | "asking" | "granted" | "blocked">("unknown");
  const [options, setOptions] = useState<CameraOption[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [cameras, setCameras] = useState<ActiveCamera[]>([]);
  const [cameraError, setCameraError] = useState("");
  const [instructions, setInstructions] = useState<StationInstructions | null>(null);
  const [connected, setConnected] = useState(false);
  const [recording, setRecording] = useState<ActiveRecording | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [now, setNow] = useState(Date.now());

  // The heartbeat reads these rather than closing over state, so one loop
  // runs for the life of the page and always reports the present.
  const camerasRef = useRef<ActiveCamera[]>([]);
  const recordingRef = useRef<ActiveRecording | null>(null);
  const uploadsRef = useRef<Upload[]>([]);
  const ackedCommandRef = useRef("");
  const previewSessionRef = useRef("");
  const previewPcRef = useRef<RTCPeerConnection | null>(null);
  const uploadingRef = useRef(false);
  const autoStopRef = useRef<number | null>(null);

  camerasRef.current = cameras;
  recordingRef.current = recording;
  uploadsRef.current = uploads;

  useEffect(() => {
    setTerminalCode(code);
    document.title = "Clarity Terminal";
  }, [code]);

  // --- Cameras ---------------------------------------------------------------

  const openSelection = useCallback(async (ids: string[], available: CameraOption[]) => {
    const wanted = ids
      .map((id) => available.find((option) => option.deviceId === id))
      .filter((option): option is CameraOption => Boolean(option))
      .slice(0, MAX_CAMERAS);
    const current = camerasRef.current;
    const next: ActiveCamera[] = [];
    const errors: string[] = [];
    for (const option of wanted) {
      const kept = current.find((camera) => camera.deviceId === option.deviceId);
      if (kept) {
        next.push(kept);
        continue;
      }
      try {
        next.push(await openCamera(option));
      } catch {
        errors.push(t("{camera} could not be opened.", { camera: option.label }));
      }
    }
    current
      .filter((camera) => !next.some((kept) => kept.deviceId === camera.deviceId))
      .forEach((camera) => stopStream(camera.stream));
    camerasRef.current = next;
    setCameras(next);
    setCameraError(errors.join(" "));

    // An open preview is carrying the old cameras. Swap the pictures in place
    // when the count is unchanged; otherwise drop it and let the laptop ask
    // again, which it does as soon as it sees the camera count move.
    const pc = previewPcRef.current;
    if (pc) {
      const senders = pc.getSenders().filter((sender) => sender.track);
      if (senders.length === next.length) {
        senders.forEach((sender, index) => {
          const track = next[index].stream.getVideoTracks()[0];
          if (track && sender.track !== track) void sender.replaceTrack(track).catch(() => undefined);
        });
      } else {
        pc.close();
        previewPcRef.current = null;
        previewSessionRef.current = "";
      }
    }
  }, []);

  const connectCameras = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setPermission("blocked");
      setCameraError(t("This browser cannot use cameras. Open this link in Chrome or Edge."));
      return;
    }
    setPermission("asking");
    try {
      // Asking once for any camera is what makes the browser hand over the
      // real names and ids of all of them.
      stopStream(await navigator.mediaDevices.getUserMedia({ video: true, audio: false }));
    } catch {
      setPermission("blocked");
      setCameraError(t("Camera access was blocked. Allow cameras for this site in the browser's address bar, then try again."));
      return;
    }
    setPermission("granted");
    const available = await listCameraOptions();
    setOptions(available);
    const remembered = readSavedSelection().filter((id) => available.some((option) => option.deviceId === id));
    const ids = remembered.length ? remembered : available.slice(0, 1).map((option) => option.deviceId);
    setSelected(ids);
    await openSelection(ids, available);
  }, [openSelection]);

  // A terminal that was already allowed cameras -- the usual case after a
  // restart -- switches them straight back on with nobody at the keyboard.
  useEffect(() => {
    let cancelled = false;
    const permissions = navigator.permissions as Permissions | undefined;
    if (!permissions?.query) return;
    permissions
      .query({ name: "camera" as PermissionName })
      .then((status) => {
        if (!cancelled && status.state === "granted") void connectCameras();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [connectCameras]);

  // Plugging a camera in or out updates the list; the selection stays put.
  useEffect(() => {
    if (permission !== "granted" || !navigator.mediaDevices) return;
    const refresh = () => {
      void listCameraOptions().then((available) => {
        setOptions(available);
        if (!recordingRef.current) {
          const ids = readSavedSelection();
          void openSelection(ids.length ? ids : available.slice(0, 1).map((option) => option.deviceId), available);
        }
      });
    };
    navigator.mediaDevices.addEventListener("devicechange", refresh);
    return () => navigator.mediaDevices.removeEventListener("devicechange", refresh);
  }, [openSelection, permission]);

  const toggleCamera = (deviceId: string) => {
    if (recordingRef.current) return;
    const next = selected.includes(deviceId)
      ? selected.filter((id) => id !== deviceId)
      : [...selected, deviceId].slice(-MAX_CAMERAS);
    setSelected(next);
    saveSelection(next);
    void openSelection(next, options);
  };

  // Screens that sleep stop cameras. Ask the browser to keep this one awake.
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const request = () => {
      const wakeLock = (navigator as Navigator & {
        wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
      }).wakeLock;
      if (document.visibilityState === "visible" && wakeLock) {
        void wakeLock.request("screen").then((next) => (lock = next)).catch(() => undefined);
      }
    };
    request();
    document.addEventListener("visibilitychange", request);
    return () => {
      document.removeEventListener("visibilitychange", request);
      void lock?.release().catch(() => undefined);
    };
  }, []);

  // Closing the window mid-take loses the swing.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      const busy =
        recordingRef.current ||
        uploadsRef.current.some((upload) => upload.status === "waiting" || upload.status === "uploading");
      if (busy) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [recording]);

  // --- Uploads ---------------------------------------------------------------

  const patchUpload = useCallback((savedVideoId: string, patch: Partial<Upload>) => {
    setUploads((current) => {
      const next = current.map((upload) =>
        upload.take.savedVideoId === savedVideoId ? { ...upload, ...patch } : upload,
      );
      uploadsRef.current = next;
      return next;
    });
  }, []);

  const uploadOne = useCallback(
    async (upload: Upload) => {
      const { take } = upload;
      const store = createMemorySavedVideoLibraryStore();
      const createdAt = new Date().toISOString();
      const title = `${instructions?.terminal.name || "Clarity Terminal"} · ${take.cameraLabel}`;
      const duration = upload.durationMs / 1000;
      await store.saveItem({
        savedVideoId: take.savedVideoId,
        // Placeholder: the server files the take under the player the coach
        // chose when they pressed Record, whatever this says.
        playerId: "terminal",
        title,
        sourceSide: take.side,
        sourceVideo: {
          id: take.savedVideoId,
          playerId: "terminal",
          sourceUrl: "",
          title,
          createdAt,
          duration,
          fps: upload.fps,
          width: upload.width,
          height: upload.height,
        },
        sourceBlob: upload.blob,
        analysisSnapshot: {
          id: `analysis-${take.savedVideoId}`,
          playerId: "terminal",
          videoId: take.savedVideoId,
          videoMeta: { title, duration, fps: upload.fps, width: upload.width, height: upload.height },
          title,
          drawings: [],
          markers: [],
          notes: [],
          focusSnapshots: [],
          focusViews: [],
          narrationRefs: [],
          createdAt,
          updatedAt: createdAt,
        },
        // Two cameras from one press open side by side on the laptop.
        workspaceSnapshot: {
          version: 1,
          mode: upload.takeCount > 1 ? "compare" : "single",
          activeSide: take.side,
          linkedPlayback: upload.takeCount > 1,
          focusWindowOpen: false,
          focusWindowMode: "area",
          focusWindowSide: take.side,
          focusAreaRect: null,
        },
      });
      await saveSavedVideoToCloud(take.savedVideoId, store, {
        scope: "terminal",
        onProgress: (progress) => patchUpload(take.savedVideoId, { progress }),
      });
    },
    [instructions?.terminal.name, patchUpload],
  );

  const runUploads = useCallback(async () => {
    if (uploadingRef.current) return;
    uploadingRef.current = true;
    try {
      for (;;) {
        const next = uploadsRef.current.find((upload) => upload.status === "waiting");
        if (!next) break;
        const id = next.take.savedVideoId;
        patchUpload(id, { status: "uploading", progress: 1, error: "" });
        void reportStationTake(id, "uploading").catch(() => undefined);
        let lastError = "";
        let done = false;
        for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS && !done; attempt += 1) {
          try {
            await uploadOne(next);
            done = true;
          } catch (error) {
            lastError = error instanceof Error ? error.message : t("Upload failed.");
            // The transfer resumes from the last accepted chunk, so a retry
            // after a dropped connection does not start again from zero.
            if (attempt < UPLOAD_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
          }
        }
        if (done) {
          // Sent: the bytes are in Clarity Cloud, so this copy can go.
          patchUpload(id, { status: "done", progress: 100, blob: new Blob() });
        } else {
          patchUpload(id, { status: "failed", error: lastError });
          void reportStationTake(id, "failed", lastError).catch(() => undefined);
        }
      }
    } finally {
      uploadingRef.current = false;
    }
  }, [patchUpload, uploadOne]);

  const retryUpload = (savedVideoId: string) => {
    patchUpload(savedVideoId, { status: "waiting", error: "", progress: 0 });
    void runUploads();
  };

  // --- Recording -------------------------------------------------------------

  const stopRecording = useCallback(async () => {
    const active = recordingRef.current;
    if (!active) return;
    recordingRef.current = null;
    setRecording(null);
    if (autoStopRef.current) window.clearTimeout(autoStopRef.current);
    const durationMs = Date.now() - active.startedAt;
    const finished = await Promise.all(
      active.parts.map(
        (part) =>
          new Promise<Upload>((resolve) => {
            const finish = () =>
              resolve({
                take: part.take,
                takeCount: active.parts.length,
                blob: new Blob(part.chunks, { type: part.mimeType }),
                durationMs,
                width: part.camera.width,
                height: part.camera.height,
                fps: part.camera.fps,
                status: "waiting",
                progress: 0,
                error: "",
              });
            if (part.recorder.state === "inactive") finish();
            else {
              part.recorder.addEventListener("stop", finish, { once: true });
              part.recorder.stop();
            }
          }),
      ),
    );
    const usable = finished.filter((upload) => upload.blob.size > 0);
    finished
      .filter((upload) => !upload.blob.size)
      .forEach((upload) => void reportStationTake(upload.take.savedVideoId, "failed", t("Nothing was recorded.")).catch(() => undefined));
    setUploads((current) => {
      // Newest first. Finished ones beyond the last few only clutter the screen.
      const next = [
        ...usable,
        ...current.filter((upload) => upload.status !== "done"),
        ...current.filter((upload) => upload.status === "done").slice(0, 4),
      ];
      uploadsRef.current = next;
      return next;
    });
    void runUploads();
  }, [runUploads]);

  const startRecording = useCallback(
    (commandId: string, takes: Take[]) => {
      // A second Record while one is rolling. Its takes will never be
      // recorded, so say so rather than leave the laptop waiting on them.
      if (recordingRef.current) {
        takes.forEach((take) =>
          void reportStationTake(take.savedVideoId, "failed", t("Already recording.")).catch(() => undefined),
        );
        return;
      }
      const active = camerasRef.current;
      const mimeType = getPreferredRecordingMimeType();
      const parts: ActiveRecording["parts"] = [];
      takes.forEach((take, index) => {
        const camera = active[index];
        if (!camera) {
          void reportStationTake(take.savedVideoId, "failed", t("That camera was switched off.")).catch(() => undefined);
          return;
        }
        try {
          const recorder = new MediaRecorder(camera.stream, {
            ...(mimeType ? { mimeType } : {}),
            videoBitsPerSecond: RECORDING_BITS_PER_SECOND,
          });
          const chunks: Blob[] = [];
          recorder.ondataavailable = (event) => {
            if (event.data.size > 0) chunks.push(event.data);
          };
          recorder.start(1000);
          parts.push({ take, camera, recorder, chunks, mimeType: mimeType || recorder.mimeType || "video/webm" });
        } catch (error) {
          const message = error instanceof Error ? error.message : t("The terminal could not start recording.");
          void reportStationTake(take.savedVideoId, "failed", message).catch(() => undefined);
        }
      });
      if (!parts.length) return;
      const next = { commandId, startedAt: Date.now(), parts };
      recordingRef.current = next;
      setRecording(next);
      setNow(Date.now());
      autoStopRef.current = window.setTimeout(() => void stopRecording(), MAX_RECORDING_MS);
    },
    [stopRecording],
  );

  // --- Live preview ----------------------------------------------------------

  const answerPreview = useCallback(async (sessionId: string, offer: string) => {
    previewSessionRef.current = sessionId;
    previewPcRef.current?.close();
    const pc = new RTCPeerConnection({ iceServers: PREVIEW_ICE_SERVERS });
    previewPcRef.current = pc;
    try {
      await pc.setRemoteDescription({ type: "offer", sdp: offer });
      // Added after the offer so each camera fills one of the laptop's
      // requested slots, in order.
      camerasRef.current.forEach((camera) => {
        const track = camera.stream.getVideoTracks()[0];
        if (track) pc.addTrack(track, camera.stream);
      });
      await pc.setLocalDescription(await pc.createAnswer());
      for (const sender of pc.getSenders()) {
        const parameters = sender.getParameters();
        if (!parameters.encodings?.length) continue;
        parameters.encodings = parameters.encodings.map((encoding) => ({ ...encoding, maxBitrate: PREVIEW_MAX_BITRATE }));
        await sender.setParameters(parameters).catch(() => undefined);
      }
      await waitForIceGathering(pc);
      if (previewPcRef.current !== pc) return;
      await answerStationPreview(sessionId, pc.localDescription?.sdp || "");
    } catch {
      // The laptop asks again when no answer arrives.
      if (previewPcRef.current === pc) {
        pc.close();
        previewPcRef.current = null;
      }
    }
  }, []);

  // --- Heartbeat -------------------------------------------------------------

  useEffect(() => {
    if (!code) return;
    let stopped = false;
    let timer: number | undefined;

    const beat = async () => {
      const active = camerasRef.current;
      const pending = uploadsRef.current.filter((upload) => upload.status === "waiting" || upload.status === "uploading");
      const failed = uploadsRef.current.find((upload) => upload.status === "failed");
      const state = recordingRef.current
        ? "recording"
        : pending.length
          ? "uploading"
          : !active.length
            ? "no-camera"
            : failed
              ? "error"
              : "idle";
      const progress = pending.length
        ? pending.reduce((sum, upload) => sum + upload.progress, 0) / pending.length
        : null;
      try {
        const response = await sendStationBeat({
          state,
          message: state === "error" ? failed?.error || "" : "",
          cameras: active.map((camera) => ({ label: camera.label })),
          uploadProgress: progress,
          ackedCommandId: ackedCommandRef.current || undefined,
        });
        if (stopped) return;
        setConnected(true);
        setInstructions(response);
        const command = response.command;
        if (command && command.id !== ackedCommandRef.current) {
          ackedCommandRef.current = command.id;
          if (command.command === "start") startRecording(command.id, command.takes);
          else void stopRecording();
        }
        const preview = response.preview;
        if (preview && preview.sessionId !== previewSessionRef.current) {
          void answerPreview(preview.sessionId, preview.offer);
        }
      } catch (error) {
        if (stopped) return;
        if (error instanceof TerminalApiError && error.status === 401) {
          setLinkError(t("This terminal link is not recognised. Ask your coach for a new one."));
          stopped = true;
          return;
        }
        setConnected(false);
      }
      if (!stopped) timer = window.setTimeout(beat, BEAT_MS);
    };
    void beat();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [answerPreview, code, startRecording, stopRecording]);

  // Let go of everything on the way out.
  useEffect(
    () => () => {
      camerasRef.current.forEach((camera) => stopStream(camera.stream));
      previewPcRef.current?.close();
    },
    [],
  );

  // --- Screen ----------------------------------------------------------------

  if (!code || linkError) {
    return (
      <main className="terminal-shell">
        <section className="terminal-card terminal-message">
          <h1>Clarity Terminal</h1>
          <p>{linkError || t("This terminal link is not recognised. Ask your coach for a new one.")}</p>
        </section>
      </main>
    );
  }

  const name = instructions?.terminal.name || "Clarity Terminal";
  const player = instructions?.player?.name || "";
  const activeUploads = uploads.filter((upload) => upload.status !== "done");
  const status = recording
    ? { tone: "recording", text: t("Recording {time}", { time: formatClock(now - recording.startedAt) }) }
    : !connected
      ? { tone: "warning", text: t("Connecting to Clarity…") }
      : !cameras.length
        ? { tone: "warning", text: t("No camera switched on") }
        : activeUploads.some((upload) => upload.status !== "failed")
          ? { tone: "busy", text: t("Sending to Clarity Cloud…") }
          : { tone: "ready", text: t("Ready. Record from Clarity on your laptop.") };

  return (
    <main className="terminal-shell">
      <header className="terminal-header">
        <div>
          <p className="terminal-eyebrow">Clarity Terminal</p>
          <h1>{name}</h1>
        </div>
        <p className={`terminal-status is-${status.tone}`} aria-live="polite">
          {status.text}
        </p>
      </header>

      <p className="terminal-player">
        {player ? t("Recording for {name}", { name: player }) : t("Waiting for your coach to choose a player.")}
      </p>

      {permission !== "granted" ? (
        <section className="terminal-card terminal-connect">
          <h2>{t("Connect cameras")}</h2>
          <p>{t("Plug in the cameras for this bay, then allow Clarity to use them. This computer only needs setting up once.")}</p>
          <button
            type="button"
            className="terminal-button is-primary"
            onClick={() => void connectCameras()}
            disabled={permission === "asking"}
          >
            {permission === "asking" ? t("Waiting for permission…") : t("Connect cameras")}
          </button>
          {cameraError ? <p className="terminal-error" role="alert">{cameraError}</p> : null}
        </section>
      ) : (
        <>
          <section className="terminal-grid" aria-label={t("Cameras")}>
            {cameras.length ? (
              cameras.map((camera) => (
                <CameraTile key={camera.deviceId} camera={camera} recording={Boolean(recording)} />
              ))
            ) : (
              <p className="terminal-empty">{t("Switch on a camera below.")}</p>
            )}
          </section>

          <section className="terminal-card">
            <h2>{t("Cameras")}</h2>
            <p className="terminal-hint">{t("Up to two. The first fills the left side on your laptop, the second the right.")}</p>
            <ul className="terminal-camera-list">
              {options.map((option) => {
                const index = selected.indexOf(option.deviceId);
                return (
                  <li key={option.deviceId}>
                    <label>
                      <input
                        type="checkbox"
                        checked={index >= 0}
                        disabled={Boolean(recording)}
                        onChange={() => toggleCamera(option.deviceId)}
                      />
                      <span>{option.label}</span>
                      {index >= 0 ? (
                        <span className="terminal-side">{index === 0 ? t("Left") : t("Right")}</span>
                      ) : null}
                    </label>
                  </li>
                );
              })}
            </ul>
            {cameraError ? <p className="terminal-error" role="alert">{cameraError}</p> : null}
          </section>
        </>
      )}

      {uploads.length ? (
        <section className="terminal-card">
          <h2>{t("Recordings")}</h2>
          <ul className="terminal-uploads">
            {uploads.map((upload) => (
              <li key={upload.take.savedVideoId} className={`is-${upload.status}`}>
                <span>{upload.take.cameraLabel}</span>
                <span>
                  {upload.status === "done"
                    ? t("In Clarity Cloud")
                    : upload.status === "failed"
                      ? upload.error || t("Upload failed.")
                      : upload.status === "uploading"
                        ? t("Sending {progress}%", { progress: Math.round(upload.progress) })
                        : t("Waiting to send")}
                </span>
                {upload.status === "failed" ? (
                  <button type="button" className="terminal-button" onClick={() => retryUpload(upload.take.savedVideoId)}>
                    {t("Retry")}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <footer className="terminal-footer">
        {t("Leave this window open. Your coach controls recording from their laptop.")}
      </footer>
    </main>
  );
}
