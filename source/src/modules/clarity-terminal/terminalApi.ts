// Clarity Terminal: the shared vocabulary of the terminal page (the camera
// computer in the bay) and the remote panel (the coach's laptop).
//
// The two never talk directly except for the live preview. Everything else --
// Record, Stop, who is being recorded, how the upload is going -- goes through
// the terminal's row at /api/camera-terminal, which both sides poll.

import { apiFetch } from "../auth/apiFetch";

const TERMINAL_PATH_PREFIX = "/terminal/";

/** The code in /terminal/<code>, or "" when this page load is anything else. */
export function terminalCodeFromPath(pathname = typeof window === "undefined" ? "" : window.location.pathname) {
  if (!pathname.startsWith(TERMINAL_PATH_PREFIX)) return "";
  return pathname.slice(TERMINAL_PATH_PREFIX.length).replace(/\/+$/, "").trim().toLowerCase();
}

export function terminalLink(code: string) {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}${TERMINAL_PATH_PREFIX}${code}`;
}

export type TerminalState = "offline" | "idle" | "recording" | "uploading" | "no-camera" | "error";

export type TakeSide = "left" | "right";

export type TerminalTake = {
  savedVideoId: string;
  side: TakeSide;
  cameraLabel: string;
  status: "recording" | "uploading" | "ready" | "failed";
  message: string;
};

export type CoachTerminal = {
  id: string;
  name: string;
  code: string;
  online: boolean;
  state: TerminalState;
  message: string;
  cameras: { label: string }[];
  uploadProgress: number | null;
  player: { id: string; name: string } | null;
  lastSeenAt: string | null;
};

export type TerminalSnapshot = {
  terminal: CoachTerminal;
  commandId: string | null;
  takes: TerminalTake[];
  previewAnswer: string | null;
};

/** The heartbeat's answer on the terminal side. */
export type StationInstructions = {
  terminal: { name: string };
  player: { name: string } | null;
  command: {
    id: string;
    command: "start" | "stop";
    takes: { savedVideoId: string; side: TakeSide; cameraLabel: string }[];
  } | null;
  preview: { sessionId: string; offer: string } | null;
};

export class TerminalApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "TerminalApiError";
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(`/api/camera-terminal${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const data = (await response.json().catch(() => ({}))) as T & { message?: string };
  if (!response.ok) {
    throw new TerminalApiError(data?.message || "Clarity Terminal could not be reached.", response.status);
  }
  return data;
}

const post = <T>(path: string, body: unknown = {}) =>
  call<T>(path, { method: "POST", body: JSON.stringify(body) });

// --- Coach ------------------------------------------------------------------

export const listTerminals = async () =>
  (await call<{ terminals: CoachTerminal[] }>("")).terminals;

export const createTerminal = async (name: string) =>
  (await post<{ terminal: CoachTerminal }>("", { name })).terminal;

export const deleteTerminal = (id: string) =>
  call<{ ok: boolean }>(`/${encodeURIComponent(id)}`, { method: "DELETE" });

export const readTerminal = (id: string, previewSessionId = "") =>
  call<TerminalSnapshot>(
    `/${encodeURIComponent(id)}${previewSessionId ? `?preview=${encodeURIComponent(previewSessionId)}` : ""}`,
  );

export type TerminalPlayer = { playerId: string; playerName: string; lessonId?: string };

export const attachTerminal = (id: string, player: TerminalPlayer) =>
  post<{ terminal: CoachTerminal }>(`/${encodeURIComponent(id)}/attach`, player);

export const startTerminalRecording = (id: string, player: TerminalPlayer) =>
  post<TerminalSnapshot>(`/${encodeURIComponent(id)}/start`, player);

export const stopTerminalRecording = (id: string) =>
  post<TerminalSnapshot>(`/${encodeURIComponent(id)}/stop`);

export const offerTerminalPreview = (id: string, sessionId: string, sdp: string) =>
  post<{ ok: boolean }>(`/${encodeURIComponent(id)}/preview`, { sessionId, sdp });

// --- Terminal ---------------------------------------------------------------

export type StationBeat = {
  state: Exclude<TerminalState, "offline">;
  message?: string;
  cameras: { label: string }[];
  uploadProgress?: number | null;
  ackedCommandId?: string;
};

export const sendStationBeat = (beat: StationBeat) => post<StationInstructions>("/station", beat);

export const answerStationPreview = (sessionId: string, sdp: string) =>
  post<{ ok: boolean }>("/station/answer", { sessionId, sdp });

export const reportStationTake = (savedVideoId: string, status: "uploading" | "failed", message = "") =>
  post<{ ok: boolean }>("/station/take", { savedVideoId, status, message });

// --- Live preview -----------------------------------------------------------

/**
 * Public STUN only. The terminal and the laptop are nearly always on the same
 * network in the same building, where the host candidates connect directly;
 * STUN covers the rest. There is no relay, so a network that blocks
 * peer-to-peer gets no preview -- recording and uploading do not depend on it.
 */
export const PREVIEW_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

/**
 * Waits for every ICE candidate to be gathered, so the whole connection can be
 * handed over in one SDP rather than trickled through a polled row.
 */
export function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 4000) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    // What has been gathered by then is usually enough on a local network.
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", check);
  });
}
