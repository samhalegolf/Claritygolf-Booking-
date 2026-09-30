import { getDatabase } from "@netlify/database";
import type { Config } from "@netlify/functions";
import { randomBytes, randomUUID } from "node:crypto";

import { requireCoachActor } from "./_shared/coach-auth.mts";

/**
 * Clarity Terminal: the computer in the bay with the cameras plugged into it.
 *
 * The terminal is never signed in. It opens /terminal, shows a short pairing
 * code, and the coach types that code into Settings when adding it. The
 * computer is then handed its credential (the terminal's code), keeps it, and
 * sends it as X-Clarity-Terminal-Code from then on. The coach's laptop drives
 * it from the video workspace with the ordinary coach session.
 *
 * Both sides poll the terminal's one row. There is no socket to keep alive and
 * nothing to reconnect: a terminal that drops off the network is just a row
 * whose last_seen_at stops moving.
 *
 * Coach (signed in):
 *   GET    /api/camera-terminal                 this business's terminals
 *   POST   /api/camera-terminal                 { name, pairCode } -> a new terminal, paired
 *   DELETE /api/camera-terminal/:id
 *   GET    /api/camera-terminal/:id             live state, this press's takes, preview answer
 *   POST   /api/camera-terminal/:id/attach      { playerId, playerName, lessonId }
 *   POST   /api/camera-terminal/:id/start       { playerId, playerName, lessonId }
 *   POST   /api/camera-terminal/:id/stop
 *   POST   /api/camera-terminal/:id/preview     { sessionId, sdp } -- a WebRTC offer
 *
 * Pairing (no credential yet):
 *   POST   /api/camera-terminal/pair            -> { pairCode, pairToken, expiresAt }
 *   POST   /api/camera-terminal/pair/check      { pairToken } -> { code } once claimed
 *
 * Terminal (code header):
 *   POST   /api/camera-terminal/station         heartbeat in, instructions out
 *   POST   /api/camera-terminal/station/answer  { sessionId, sdp }
 *   POST   /api/camera-terminal/station/take    { savedVideoId, status, message }
 *
 * The recordings themselves go up through /api/video-transfer/terminal/*, the
 * same Clarity Cloud engine every other video uses.
 */

export const terminalCodeHeaderName = "x-clarity-terminal-code";

/** Seen within this long counts as online. The terminal beats every second. */
const onlineWindowMs = 10_000;
/**
 * A command the terminal has not picked up within this long is dropped. A
 * terminal that was off when Record was pressed must not start recording the
 * moment someone switches it on an hour later.
 */
const commandTtlMs = 20_000;
const maxCameras = 2;
const maxSdpLength = 20_000;
/** How long a pairing code on the terminal's screen stays valid. */
const pairingTtlMs = 10 * 60 * 1000;

function db() {
  return getDatabase();
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function cleanText(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

const codeAlphabet = "abcdefghjkmnpqrstuvwxyz23456789";

function randomCode(length: number) {
  return Array.from(randomBytes(length), (byte) => codeAlphabet[byte % codeAlphabet.length]).join("");
}

/** The terminal's credential. Nobody types it: pairing hands it over. */
export function newTerminalCode() {
  return randomCode(32);
}

/** Six characters, shown big on the terminal and typed once by the coach. */
export function newPairCode() {
  return randomCode(6);
}

/** What the coach typed, however they typed it: "k7m 4qp", "K7M-4QP". */
export function cleanPairCode(value: unknown) {
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) : "";
}

export function isTerminalOnline(lastSeenAt: unknown, now = Date.now()) {
  const seen = lastSeenAt ? new Date(String(lastSeenAt)).getTime() : 0;
  return Number.isFinite(seen) && now - seen < onlineWindowMs;
}

type TerminalCamera = { label: string };

export function cleanCameras(value: unknown): TerminalCamera[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((camera) => ({ label: cleanText((camera as { label?: unknown })?.label, 120) || "Camera" }))
    .slice(0, maxCameras);
}

const terminalStates = new Set(["idle", "recording", "uploading", "no-camera", "error"]);

function cleanState(value: unknown) {
  const state = cleanText(value, 20);
  return terminalStates.has(state) ? state : "idle";
}

function iso(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function jsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** What the coach sees about a terminal. Never its credential. */
function coachTerminal(row: any) {
  const online = isTerminalOnline(row.last_seen_at);
  return {
    id: row.id,
    name: row.name,
    online,
    // A terminal that has gone quiet is offline whatever it last said.
    state: online ? row.state : "offline",
    message: online ? row.state_message || "" : "",
    cameras: cleanCameras(jsonArray(row.cameras)),
    uploadProgress: online && row.upload_progress != null ? Number(row.upload_progress) : null,
    player: row.player_id ? { id: row.player_id, name: row.player_name || "" } : null,
    lastSeenAt: iso(row.last_seen_at),
  };
}

async function readJson(req: Request) {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// --- Pairing ---------------------------------------------------------------

async function handleNewPairing() {
  // Old pairings are only clutter; sweep them as new ones are made.
  await db().sql`DELETE FROM public.camera_terminal_pairings WHERE expires_at < NOW()`;
  const pairToken = randomCode(32);
  const expiresAt = new Date(Date.now() + pairingTtlMs);
  // Six characters from 31 is nearly a billion codes, but a clash is still
  // possible; a fresh code on the next try is all it takes.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const pairCode = newPairCode();
    const rows = await db().sql`
      INSERT INTO public.camera_terminal_pairings (pair_code, pair_token, expires_at)
      VALUES (${pairCode}, ${pairToken}, ${expiresAt.toISOString()})
      ON CONFLICT (pair_code) DO NOTHING
      RETURNING pair_code`;
    if (rows[0]) return json({ ok: true, pairCode, pairToken, expiresAt: expiresAt.toISOString() }, 201);
  }
  return json({ error: "server_error", message: "Could not make a pairing code. Try again." }, 500);
}

async function handlePairingCheck(req: Request) {
  const pairToken = cleanText((await readJson(req)).pairToken, 80);
  if (!pairToken) return json({ error: "bad_request", message: "Missing pairing." }, 400);
  const rows = await db().sql`
    SELECT terminal_code FROM public.camera_terminal_pairings
    WHERE pair_token = ${pairToken} AND expires_at > NOW()
    LIMIT 1`;
  if (!rows[0]) return json({ error: "expired", message: "This pairing code has run out." }, 410);
  return json({ ok: true, code: rows[0].terminal_code || null });
}

// --- The terminal's side ----------------------------------------------------

async function readTerminalByCode(req: Request) {
  const code = cleanText(req.headers.get(terminalCodeHeaderName), 64).toLowerCase();
  if (!code) return null;
  const rows = await db().sql`SELECT * FROM public.camera_terminals WHERE code = ${code} LIMIT 1`;
  return rows[0] || null;
}

/**
 * The heartbeat. The terminal says what it is doing; the answer is whatever it
 * should do next. Only a command it has not already acknowledged, and only one
 * fresh enough to still mean anything, is handed back.
 */
async function handleStationBeat(req: Request, terminal: any) {
  const body = await readJson(req);
  const ackedCommandId = cleanText(body.ackedCommandId, 80) || terminal.acked_command_id || null;
  const progress = Number(body.uploadProgress);
  const rows = await db().sql`
    UPDATE public.camera_terminals SET
      last_seen_at = NOW(),
      state = ${cleanState(body.state)},
      state_message = ${cleanText(body.message, 240) || null},
      cameras = ${JSON.stringify(cleanCameras(body.cameras))}::jsonb,
      upload_progress = ${Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.round(progress))) : null},
      acked_command_id = ${ackedCommandId}
    WHERE id = ${terminal.id}
    RETURNING *`;
  const row = rows[0] || terminal;

  const commandAt = row.command_at ? new Date(row.command_at).getTime() : 0;
  const command =
    row.command_id &&
    row.command_id !== row.acked_command_id &&
    Date.now() - commandAt < commandTtlMs
      ? {
          id: row.command_id,
          command: row.command,
          takes: jsonArray(row.command_takes),
        }
      : null;

  return json({
    ok: true,
    terminal: { name: row.name },
    player: row.player_id ? { name: row.player_name || "" } : null,
    command,
    // An offer nobody has answered yet. Once answered it is not handed out
    // again, so a terminal does not tear down a working preview every beat.
    preview:
      row.rtc_session_id && row.rtc_offer && !row.rtc_answer
        ? { sessionId: row.rtc_session_id, offer: row.rtc_offer }
        : null,
  });
}

async function handleStationAnswer(req: Request, terminal: any) {
  const body = await readJson(req);
  const sessionId = cleanText(body.sessionId, 80);
  const sdp = typeof body.sdp === "string" ? body.sdp.slice(0, maxSdpLength) : "";
  if (!sessionId || !sdp) return json({ error: "bad_request", message: "An answer needs a session and an SDP." }, 400);
  // Keyed on the session so an answer to an offer the laptop has already
  // replaced lands nowhere, rather than on the newer offer.
  await db().sql`
    UPDATE public.camera_terminals SET rtc_answer = ${sdp}
    WHERE id = ${terminal.id} AND rtc_session_id = ${sessionId}`;
  return json({ ok: true });
}

async function handleStationTake(req: Request, terminal: any) {
  const body = await readJson(req);
  const savedVideoId = cleanText(body.savedVideoId, 160);
  const status = cleanText(body.status, 20);
  // "ready" is not the terminal's to say: the upload engine sets it when the
  // bytes are verified in Clarity Cloud.
  if (!savedVideoId || (status !== "uploading" && status !== "failed")) {
    return json({ error: "bad_request", message: "Unknown take update." }, 400);
  }
  await db().sql`
    UPDATE public.camera_terminal_takes SET
      status = ${status},
      message = ${cleanText(body.message, 240) || null},
      updated_at = NOW()
    WHERE saved_video_id = ${savedVideoId} AND terminal_id = ${terminal.id} AND status <> 'ready'`;
  return json({ ok: true });
}

// --- The coach's side -------------------------------------------------------

async function readCoachTerminal(accountId: string, id: string) {
  const rows = await db().sql`
    SELECT * FROM public.camera_terminals WHERE id = ${id} AND account_id = ${accountId} LIMIT 1`;
  return rows[0] || null;
}

function playerFromBody(body: Record<string, unknown>) {
  return {
    playerId: cleanText(body.playerId, 160),
    playerName: cleanText(body.playerName, 180),
    lessonId: cleanText(body.lessonId, 160) || null,
  };
}

async function readCommandTakes(row: any) {
  const ids = jsonArray(row.command_takes)
    .map((take) => cleanText((take as { savedVideoId?: unknown })?.savedVideoId, 160))
    .filter(Boolean);
  if (!ids.length) return [];
  const rows = await db().sql`
    SELECT saved_video_id, side, camera_label, status, message
    FROM public.camera_terminal_takes
    WHERE terminal_id = ${row.id} AND saved_video_id = ANY(${ids})`;
  return rows.map((take: any) => ({
    savedVideoId: take.saved_video_id,
    side: take.side,
    cameraLabel: take.camera_label || "",
    status: take.status,
    message: take.message || "",
  }));
}

async function handleStart(accountId: string, row: any, body: Record<string, unknown>) {
  const player = playerFromBody(body);
  if (!player.playerId) return json({ error: "bad_request", message: "Choose a player before recording." }, 400);
  if (!isTerminalOnline(row.last_seen_at)) {
    return json({ error: "terminal_offline", message: `${row.name} is not connected.` }, 409);
  }
  const cameras = cleanCameras(jsonArray(row.cameras));
  if (!cameras.length) {
    return json({ error: "no_camera", message: `${row.name} has no camera switched on.` }, 409);
  }
  if (row.state === "recording") {
    return json({ error: "busy", message: `${row.name} is already recording.` }, 409);
  }

  // One saved video per camera, minted here so the terminal never picks the
  // id it uploads under or the player it is filed under.
  const takes = cameras.map((camera, index) => ({
    savedVideoId: `terminal-${randomUUID()}`,
    side: index === 0 ? "left" : "right",
    cameraLabel: camera.label,
  }));
  for (const take of takes) {
    await db().sql`
      INSERT INTO public.camera_terminal_takes
        (saved_video_id, terminal_id, account_id, player_id, lesson_id, side, camera_label)
      VALUES
        (${take.savedVideoId}, ${row.id}, ${accountId}, ${player.playerId}, ${player.lessonId}, ${take.side}, ${take.cameraLabel})`;
  }
  const commandId = randomUUID();
  const updated = await db().sql`
    UPDATE public.camera_terminals SET
      player_id = ${player.playerId},
      player_name = ${player.playerName || null},
      lesson_id = ${player.lessonId},
      command_id = ${commandId},
      command = 'start',
      command_takes = ${JSON.stringify(takes)}::jsonb,
      command_at = NOW(),
      updated_at = NOW()
    WHERE id = ${row.id}
    RETURNING *`;
  return json({ ok: true, terminal: coachTerminal(updated[0]), commandId, takes: await readCommandTakes(updated[0]) });
}

async function handleStop(row: any) {
  // Stop keeps the takes of the press it is stopping: they are what the coach
  // is about to wait for.
  const commandId = randomUUID();
  const updated = await db().sql`
    UPDATE public.camera_terminals SET
      command_id = ${commandId},
      command = 'stop',
      command_at = NOW(),
      updated_at = NOW()
    WHERE id = ${row.id}
    RETURNING *`;
  return json({ ok: true, terminal: coachTerminal(updated[0]), commandId, takes: await readCommandTakes(updated[0]) });
}

async function handleCoachRoute(req: Request, accountId: string, parts: string[]) {
  if (!parts.length) {
    if (req.method === "GET") {
      const rows = await db().sql`
        SELECT * FROM public.camera_terminals WHERE account_id = ${accountId} ORDER BY created_at`;
      return json({ ok: true, terminals: rows.map(coachTerminal) });
    }
    if (req.method === "POST") {
      const body = await readJson(req);
      const name = cleanText(body.name, 60);
      const pairCode = cleanPairCode(body.pairCode);
      if (!name) return json({ error: "bad_request", message: "Give the terminal a name." }, 400);
      if (!pairCode) return json({ error: "bad_request", message: "Type the code shown on the terminal." }, 400);
      // Claim the code and fill in the credential in one step, so two coaches
      // typing the same code cannot both have it.
      const code = newTerminalCode();
      const claimed = await db().sql`
        UPDATE public.camera_terminal_pairings SET terminal_code = ${code}
        WHERE pair_code = ${pairCode} AND terminal_code IS NULL AND expires_at > NOW()
        RETURNING pair_code`;
      if (!claimed[0]) {
        return json(
          { error: "bad_pair_code", message: "That code doesn't match a terminal. Check the code on the terminal's screen." },
          400,
        );
      }
      const rows = await db().sql`
        INSERT INTO public.camera_terminals (id, account_id, name, code)
        VALUES (${randomUUID()}, ${accountId}, ${name}, ${code})
        RETURNING *`;
      return json({ ok: true, terminal: coachTerminal(rows[0]) }, 201);
    }
    return json({ error: "method_not_allowed" }, 405);
  }

  const row = await readCoachTerminal(accountId, cleanText(parts[0], 80));
  if (!row) return json({ error: "not_found", message: "Terminal not found." }, 404);
  const action = parts[1] || "";

  if (!action && req.method === "DELETE") {
    await db().sql`DELETE FROM public.camera_terminals WHERE id = ${row.id} AND account_id = ${accountId}`;
    return json({ ok: true });
  }
  if (!action && req.method === "GET") {
    const sessionId = cleanText(new URL(req.url).searchParams.get("preview"), 80);
    return json({
      ok: true,
      terminal: coachTerminal(row),
      commandId: row.command_id || null,
      takes: await readCommandTakes(row),
      // Only the answer to the offer this laptop made. Two laptops on one
      // terminal would otherwise each take the other's answer.
      previewAnswer: sessionId && row.rtc_session_id === sessionId ? row.rtc_answer || null : null,
    });
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const body = await readJson(req);
  if (action === "attach") {
    const player = playerFromBody(body);
    const rows = await db().sql`
      UPDATE public.camera_terminals SET
        player_id = ${player.playerId || null},
        player_name = ${player.playerName || null},
        lesson_id = ${player.lessonId},
        updated_at = NOW()
      WHERE id = ${row.id}
      RETURNING *`;
    return json({ ok: true, terminal: coachTerminal(rows[0]) });
  }
  if (action === "start") return await handleStart(accountId, row, body);
  if (action === "stop") return await handleStop(row);
  if (action === "preview") {
    const sessionId = cleanText(body.sessionId, 80);
    const sdp = typeof body.sdp === "string" ? body.sdp.slice(0, maxSdpLength) : "";
    if (!sessionId || !sdp) return json({ error: "bad_request", message: "A preview needs a session and an SDP." }, 400);
    await db().sql`
      UPDATE public.camera_terminals SET
        rtc_session_id = ${sessionId},
        rtc_offer = ${sdp},
        rtc_answer = NULL
      WHERE id = ${row.id}`;
    return json({ ok: true });
  }
  return json({ error: "not_found", message: "Terminal route not found." }, 404);
}

export default async function handler(req: Request) {
  const parts = new URL(req.url).pathname
    .replace(/^\/api\/camera-terminal\/?/, "")
    .split("/")
    .filter(Boolean);

  try {
    // The terminal's own credential, checked before the coach gate, and
    // nothing past that gate is reachable with it.
    if (parts[0] === "pair") {
      if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      if (!parts[1]) return await handleNewPairing();
      if (parts[1] === "check") return await handlePairingCheck(req);
      return json({ error: "not_found" }, 404);
    }
    if (parts[0] === "station") {
      if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      const terminal = await readTerminalByCode(req);
      if (!terminal) return json({ error: "unauthorized", message: "This terminal has been removed." }, 401);
      if (parts[1] === "answer") return await handleStationAnswer(req, terminal);
      if (parts[1] === "take") return await handleStationTake(req, terminal);
      if (!parts[1]) return await handleStationBeat(req, terminal);
      return json({ error: "not_found" }, 404);
    }

    const actor = await requireCoachActor(req);
    return await handleCoachRoute(req, actor.accountId, parts);
  } catch (error: any) {
    if (error?.status === 401 || error?.status === 403) {
      return json(
        {
          error: error.code || "unauthorized",
          message: error instanceof Error ? error.message : "Admin login required.",
        },
        error.status,
      );
    }
    console.error("camera_terminal:failed", error instanceof Error ? error.message : error);
    return json({ error: "server_error", message: "Clarity Terminal could not be reached." }, 500);
  }
}

export const config: Config = {
  path: ["/api/camera-terminal", "/api/camera-terminal/*"],
};
