import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { t } from "../../lib/i18n";
import {
  PREVIEW_ICE_SERVERS,
  attachTerminal,
  createTerminal,
  deleteTerminal,
  listTerminals,
  offerTerminalPreview,
  readTerminal,
  startTerminalRecording,
  stopTerminalRecording,
  terminalLink,
  waitForIceGathering,
  type CoachTerminal,
  type TerminalPlayer,
  type TerminalTake,
} from "./terminalApi";
import "./clarityTerminal.css";

// The coach's end of Clarity Terminal, inside the video workspace.
//
// Record and Stop here drive the cameras on the terminal computer. The terminal
// records at full quality and sends each take to Clarity Cloud, filed under the
// player this workspace is open for; this panel waits for the takes to land
// and hands them to the workspace to open. The picture shown here is only a
// live preview -- the recording is never streamed.

const POLL_MS = 1000;
/** No answer to a preview request by then, and it is asked again. */
const PREVIEW_ANSWER_TIMEOUT_MS = 10_000;
/**
 * A preview that has dropped -- usually the terminal page being reloaded --
 * is asked for again after this long, rather than waiting out the browser's
 * own much longer failure timer.
 */
const PREVIEW_DISCONNECT_GRACE_MS = 5000;
/** A Record the terminal has not picked up by then is reported, not waited on. */
const START_TIMEOUT_MS = 15_000;
const TERMINAL_CHOICE_KEY = "clarity-remote-terminal";

type Phase = "idle" | "starting" | "recording" | "stopping" | "receiving";

type RemoteCameraPanelProps = {
  player: TerminalPlayer;
  /** The finished takes, in Clarity Cloud and filed under the player. */
  onTakesReady: (takes: TerminalTake[]) => Promise<void>;
  onClose: () => void;
};

const readChoice = () => {
  try {
    return window.localStorage.getItem(TERMINAL_CHOICE_KEY) || "";
  } catch {
    return "";
  }
};

const saveChoice = (id: string) => {
  try {
    window.localStorage.setItem(TERMINAL_CHOICE_KEY, id);
  } catch {
    // Only means choosing the terminal again next time.
  }
};

function PreviewTile({ stream, label }: { stream: MediaStream; label: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <figure className="terminal-tile">
      <video ref={ref} autoPlay muted playsInline />
      <figcaption>
        <span>{label}</span>
      </figcaption>
    </figure>
  );
}

export function RemoteCameraPanel({ player, onTakesReady, onClose }: RemoteCameraPanelProps) {
  const [terminals, setTerminals] = useState<CoachTerminal[] | null>(null);
  const [terminalId, setTerminalId] = useState("");
  const [terminal, setTerminal] = useState<CoachTerminal | null>(null);
  const [takes, setTakes] = useState<TerminalTake[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  // Separate from error: a missed poll clears itself on the next good one.
  const [unreachable, setUnreachable] = useState(false);
  const [managing, setManaging] = useState(false);
  const [newName, setNewName] = useState("");
  const [previews, setPreviews] = useState<MediaStream[]>([]);
  const [copied, setCopied] = useState("");

  const phaseRef = useRef<Phase>("idle");
  const takesRef = useRef<TerminalTake[]>([]);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const previewSessionRef = useRef("");
  const previewAskedAtRef = useRef(0);
  const previewCamerasRef = useRef(0);
  const disconnectedSinceRef = useRef(0);
  const startedAtRef = useRef(0);
  const playerRef = useRef(player);
  // A ref, so a parent that re-renders with a fresh callback does not restart
  // the poll.
  const onTakesReadyRef = useRef(onTakesReady);
  phaseRef.current = phase;
  takesRef.current = takes;
  playerRef.current = player;
  onTakesReadyRef.current = onTakesReady;

  const loadTerminals = useCallback(async () => {
    try {
      const list = await listTerminals();
      setTerminals(list);
      const remembered = readChoice();
      setTerminalId((current) =>
        list.some((entry) => entry.id === current)
          ? current
          : list.find((entry) => entry.id === remembered)?.id || list[0]?.id || "",
      );
      if (!list.length) setManaging(true);
    } catch (reason) {
      setTerminals([]);
      setError(reason instanceof Error ? reason.message : t("Clarity Terminal could not be reached."));
    }
  }, []);

  useEffect(() => {
    void loadTerminals();
  }, [loadTerminals]);

  // --- Preview ---------------------------------------------------------------

  const closePreview = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    previewSessionRef.current = "";
    previewCamerasRef.current = 0;
    disconnectedSinceRef.current = 0;
    setPreviews([]);
  }, []);

  const askForPreview = useCallback(
    async (id: string, cameraCount: number) => {
      closePreview();
      const sessionId = crypto.randomUUID();
      previewSessionRef.current = sessionId;
      previewAskedAtRef.current = Date.now();
      previewCamerasRef.current = cameraCount;
      const pc = new RTCPeerConnection({ iceServers: PREVIEW_ICE_SERVERS });
      pcRef.current = pc;
      for (let index = 0; index < cameraCount; index += 1) {
        pc.addTransceiver("video", { direction: "recvonly" });
      }
      try {
        await pc.setLocalDescription(await pc.createOffer());
        await waitForIceGathering(pc);
        if (pcRef.current !== pc) return;
        await offerTerminalPreview(id, sessionId, pc.localDescription?.sdp || "");
      } catch {
        // The poll asks again once the answer timeout passes.
      }
    },
    [closePreview],
  );

  const acceptPreviewAnswer = useCallback(async (answer: string) => {
    const pc = pcRef.current;
    if (!pc || pc.signalingState !== "have-local-offer") return;
    try {
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
      setPreviews(
        pc
          .getTransceivers()
          .map((transceiver) => transceiver.receiver.track)
          .filter(Boolean)
          .map((track) => new MediaStream([track])),
      );
    } catch {
      closePreview();
    }
  }, [closePreview]);

  useEffect(() => closePreview, [closePreview]);

  // --- Following the terminal ------------------------------------------------

  // Tell the terminal who it is recording for as soon as it is chosen, so the
  // screen in the bay says so before anyone presses anything.
  useEffect(() => {
    if (!terminalId) return;
    saveChoice(terminalId);
    closePreview();
    setTakes([]);
    setPhase("idle");
    void attachTerminal(terminalId, playerRef.current).catch(() => undefined);
  }, [closePreview, terminalId]);

  const finishTakes = useCallback(
    async (finished: TerminalTake[]) => {
      const ready = finished.filter((take) => take.status === "ready");
      const failed = finished.filter((take) => take.status === "failed");
      setPhase("receiving");
      try {
        if (ready.length) await onTakesReadyRef.current(ready);
        setError(failed.length ? failed[0].message || t("A recording could not be sent.") : "");
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : t("The recording could not be opened."));
      }
      setTakes([]);
      setPhase("idle");
    },
    [],
  );

  useEffect(() => {
    if (!terminalId) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const snapshot = await readTerminal(terminalId, previewSessionRef.current);
        if (stopped) return;
        setUnreachable(false);
        const next = snapshot.terminal;
        setTerminal(next);

        // The preview follows the terminal: ask when it has cameras and there
        // is no connection, ask again when the camera count moves or an ask
        // went unanswered, and let go when it drops off.
        const cameraCount = next.online ? next.cameras.length : 0;
        const pc = pcRef.current;
        if (pc?.connectionState === "disconnected") {
          disconnectedSinceRef.current ||= Date.now();
        } else {
          disconnectedSinceRef.current = 0;
        }
        const dropped =
          disconnectedSinceRef.current > 0 && Date.now() - disconnectedSinceRef.current > PREVIEW_DISCONNECT_GRACE_MS;
        if (!cameraCount) {
          if (pc) closePreview();
        } else if (
          !pc ||
          previewCamerasRef.current !== cameraCount ||
          pc.connectionState === "failed" ||
          pc.connectionState === "closed" ||
          dropped ||
          (pc.signalingState === "have-local-offer" && Date.now() - previewAskedAtRef.current > PREVIEW_ANSWER_TIMEOUT_MS)
        ) {
          void askForPreview(terminalId, cameraCount);
        } else if (snapshot.previewAnswer && pc.signalingState === "have-local-offer") {
          void acceptPreviewAnswer(snapshot.previewAnswer);
        }

        // Only the takes of the press this panel made. Until the Record
        // request has answered there are none, and the row may still be
        // showing an earlier press's.
        const current = phaseRef.current;
        const tracked = snapshot.takes.filter((take) =>
          takesRef.current.some((mine) => mine.savedVideoId === take.savedVideoId),
        );
        if (current === "starting" && next.state === "recording") setPhase("recording");
        if ((current === "stopping" || current === "recording") && tracked.length) {
          setTakes(tracked);
          if (current === "stopping" && tracked.every((take) => take.status === "ready" || take.status === "failed")) {
            void finishTakes(tracked);
          }
        }
        if (current === "starting") {
          const failed = tracked.length > 0 && tracked.every((take) => take.status === "failed");
          if (failed || Date.now() - startedAtRef.current > START_TIMEOUT_MS) {
            setError(
              (failed && tracked[0].message) || t("The terminal did not start recording. Check it is still open."),
            );
            setTakes([]);
            setPhase("idle");
          }
        }
      } catch {
        if (!stopped) setUnreachable(true);
      }
      if (!stopped) timer = window.setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [acceptPreviewAnswer, askForPreview, closePreview, finishTakes, terminalId]);

  // --- Actions ---------------------------------------------------------------

  const record = async () => {
    if (!terminalId) return;
    setError("");
    startedAtRef.current = Date.now();
    setPhase("starting");
    try {
      const started = await startTerminalRecording(terminalId, playerRef.current);
      setTakes(started.takes);
      setTerminal(started.terminal);
    } catch (reason) {
      setPhase("idle");
      setError(reason instanceof Error ? reason.message : t("The terminal could not start recording."));
    }
  };

  const stop = async () => {
    if (!terminalId) return;
    setPhase("stopping");
    try {
      await stopTerminalRecording(terminalId);
    } catch (reason) {
      setPhase("recording");
      setError(reason instanceof Error ? reason.message : t("Clarity Terminal could not be reached."));
    }
  };

  // Closing mid-take stops the cameras rather than leaving them rolling until
  // the terminal's own limit. Whatever was recorded still lands in the
  // player's Clarity Cloud videos.
  const close = () => {
    if (terminalId && (phase === "starting" || phase === "recording")) {
      void stopTerminalRecording(terminalId).catch(() => undefined);
    }
    onClose();
  };

  const addTerminal = async (event: FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    try {
      const created = await createTerminal(name);
      setNewName("");
      setTerminals((current) => [...(current || []), created]);
      setTerminalId(created.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("Clarity Terminal could not be reached."));
    }
  };

  const removeTerminal = async (entry: CoachTerminal) => {
    if (!window.confirm(t("Remove {name}? Its link will stop working.", { name: entry.name }))) return;
    try {
      await deleteTerminal(entry.id);
      if (entry.id === terminalId) setTerminalId("");
      await loadTerminals();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("Clarity Terminal could not be reached."));
    }
  };

  const copyLink = async (entry: CoachTerminal) => {
    try {
      await navigator.clipboard.writeText(terminalLink(entry.code));
      setCopied(entry.id);
      window.setTimeout(() => setCopied(""), 2000);
    } catch {
      // The link is on screen to copy by hand.
    }
  };

  // --- Screen ----------------------------------------------------------------

  const cameras = terminal?.online ? terminal.cameras : [];
  const busy = phase !== "idle";
  const canRecord = Boolean(terminal?.online && cameras.length && terminal.state !== "recording" && !busy);
  const uploading = phase === "stopping" && terminal?.state === "uploading";
  const status = error
    ? error
    : unreachable
      ? t("Clarity Terminal could not be reached.")
      : !terminal
      ? t("Choose a terminal.")
      : !terminal.online
        ? t("{name} is offline. Open its link on the camera computer.", { name: terminal.name })
        : !cameras.length
          ? t("No camera switched on")
          : phase === "starting"
            ? t("Starting…")
            : phase === "recording"
              ? t("Recording")
              : phase === "stopping"
                ? uploading && terminal.uploadProgress != null
                  ? t("Sending to Clarity Cloud {progress}%", { progress: Math.round(terminal.uploadProgress) })
                  : t("Saving the recording…")
                : phase === "receiving"
                  ? t("Opening the recording…")
                  : t("Ready to record");

  return (
    <section className="remote-camera-panel" aria-label="Clarity Terminal">
      <div className="remote-camera-head">
        <h2>Clarity Terminal</h2>
        {terminals && terminals.length > 1 ? (
          <select
            value={terminalId}
            onChange={(event) => setTerminalId(event.target.value)}
            disabled={busy}
            aria-label={t("Terminals")}
          >
            {terminals.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        ) : terminal ? (
          <span>{terminal.name}</span>
        ) : null}
      </div>

      {terminal ? (
        <div className="remote-camera-previews">
          {previews.length ? (
            previews.map((stream, index) => (
              <PreviewTile key={stream.id} stream={stream} label={cameras[index]?.label || ""} />
            ))
          ) : (
            <div className="remote-camera-placeholder">
              {cameras.length ? t("Connecting the live picture…") : status}
            </div>
          )}
        </div>
      ) : null}

      <div className="remote-camera-actions">
        {phase === "recording" || phase === "starting" ? (
          <button
            type="button"
            className="terminal-button is-record"
            onClick={() => void stop()}
            disabled={phase === "starting"}
          >
            {t("Stop")}
          </button>
        ) : (
          <button
            type="button"
            className="terminal-button is-record"
            onClick={() => void record()}
            disabled={!canRecord}
          >
            {t("Record")}
          </button>
        )}
        <span className={`remote-camera-status${error || unreachable ? " is-error" : ""}`} aria-live="polite">
          {status}
        </span>
        <button
          type="button"
          className="terminal-button"
          onClick={() => setManaging((open) => !open)}
          disabled={busy}
        >
          {t("Terminals")}
        </button>
        <button type="button" className="terminal-button" onClick={close}>
          {t("Close")}
        </button>
      </div>

      {managing ? (
        <div className="remote-camera-setup">
          <p className="terminal-hint">
            {t("Open a terminal's link on the computer the cameras are plugged into, and leave it running.")}
          </p>
          {terminals?.length ? (
            <ul className="remote-camera-links">
              {terminals.map((entry) => (
                <li key={entry.id}>
                  <strong>{entry.name}</strong>
                  <code>{terminalLink(entry.code)}</code>
                  <button type="button" className="terminal-button" onClick={() => void copyLink(entry)}>
                    {copied === entry.id ? t("Copied") : t("Copy link")}
                  </button>
                  <button type="button" className="terminal-button" onClick={() => void removeTerminal(entry)}>
                    {t("Remove")}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <form onSubmit={(event) => void addTerminal(event)}>
            <input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder={t("Bay 1")}
              aria-label={t("Terminal name")}
              maxLength={60}
            />
            <button type="submit" className="terminal-button is-primary" disabled={!newName.trim()}>
              {t("Add terminal")}
            </button>
          </form>
        </div>
      ) : null}
    </section>
  );
}
