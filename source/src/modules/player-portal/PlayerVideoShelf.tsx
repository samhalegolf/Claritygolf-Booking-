import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { formatDate } from "./format";
import type {
  ClarityCloudImportTransfer,
  SavedVideoItem,
} from "../video-analysis/utils/savedVideoLibrary";

/* The player's video library, and the way videos leave it.
 *
 * Deleting borrows the iPhone home screen wholesale, because that is the
 * gesture every one of these players already knows: hold a tile, everything
 * shakes loose, a bin appears, drag one in. Nothing about it needs explaining
 * and nothing about it is reachable by accident -- a stray tap opens a video,
 * and only a deliberate half-second hold arms the grid.
 *
 * Two rules keep it honest:
 *
 *   - Only videos on this device can go. A cloud tile is a video sitting in
 *     the coach's Drive that this phone has not downloaded; deleting one would
 *     be reaching into somebody else's storage, so those tiles stay still
 *     while the rest shake.
 *   - Nothing is destroyed while Undo is on screen. The drop hides the tile
 *     and starts a clock; the actual delete runs when the clock runs out. So
 *     Undo has nothing to restore -- the video was never touched -- and a
 *     mis-drag costs five seconds rather than a swing.
 */

const HOLD_TO_EDIT_MS = 450;
/** Past this much movement a press is a scroll, not a hold. */
const HOLD_SLOP_PX = 10;
const UNDO_WINDOW_MS = 5000;
/** The bin catches a little wider than it looks, the way a real target should. */
const TRASH_CATCH_MARGIN_PX = 28;

function formatDuration(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function formatSize(bytes?: number) {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.max(1, Math.round(mb))} MB`;
}

/** A coach-device transfer is something the coach put in the cloud for them; a
 *  player submission is their own video coming back to a device that has never
 *  held it -- a new phone, or one whose local library was cleared. */
function cloudVideoLabel(transfer: ClarityCloudImportTransfer) {
  return transfer.direction === "coach-device" ? "From your coach" : "You sent this";
}

// The coach-side label speaks in Clarity Cloud and Drive terms. A player only
// needs to know whether their coach has it.
function sendStatusLabel(item: SavedVideoItem, isGuest = false, connected = false) {
  switch (item.cloud?.status) {
    case "ready":
    case "imported":
      // "Sent to your coach" over-promises for a guest: nobody has accepted it
      // yet, and it expires if nobody does.
      if (isGuest && !connected) return "Sent — waiting for your coach";
      return "Sent to your coach";
    case "preparing":
    case "session-created":
    case "uploading":
    case "verifying":
      return "Sending…";
    case "paused":
      return "Paused";
    case "cancelled":
      return "Not sent";
    case "failed":
    case "expired":
      return "Could not send — try again";
    default:
      return "On this device only";
  }
}

const IconBin = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    <path d="M4 7h16" strokeLinecap="round" />
    <path d="M10 4h4a1 1 0 0 1 1 1v2H9V5a1 1 0 0 1 1-1Z" strokeLinejoin="round" />
    <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" strokeLinejoin="round" />
    <path d="M10.5 11v6M13.5 11v6" strokeLinecap="round" />
  </svg>
);

export type PlayerVideoShelfProps = {
  /** Videos held on this device. These are the deletable ones. */
  savedVideos: SavedVideoItem[];
  /** In the cloud, not on this device. Read-only here. */
  cloudVideos: ClarityCloudImportTransfer[];
  sendingIds: Set<string>;
  sendProgress: Record<string, number>;
  downloadingIds: Set<string>;
  isGuest: boolean;
  guestConnected: boolean;
  cloudLoading: boolean;
  onOpen: (savedVideoId: string) => void;
  onSend: (savedVideoId: string) => void;
  onDownload: (savedVideoId: string) => void;
  /** Runs when the undo window closes. This is the destructive step. */
  onDelete: (savedVideoId: string) => void | Promise<void>;
};

export function PlayerVideoShelf({
  savedVideos,
  cloudVideos,
  sendingIds,
  sendProgress,
  downloadingIds,
  isGuest,
  guestConnected,
  cloudLoading,
  onOpen,
  onSend,
  onDownload,
  onDelete,
}: PlayerVideoShelfProps) {
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const [overTrash, setOverTrash] = useState(false);
  const [pending, setPending] = useState<{ id: string; title: string } | null>(null);

  const trashRef = useRef<HTMLDivElement | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const pressRef = useRef<{ id: string; x: number; y: number; dragging: boolean } | null>(null);
  const undoTimerRef = useRef<number | null>(null);

  // onDelete is called from a timer, so the timer must not capture a stale one.
  const onDeleteRef = useRef(onDelete);
  onDeleteRef.current = onDelete;
  // Read by the unmount handler and by a second delete. Kept in a ref because
  // both of those run outside the render that would see the state.
  const pendingIdRef = useRef<string | null>(null);
  pendingIdRef.current = pending?.id ?? null;

  const clearHold = useCallback(() => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  /** Runs the delete for real and takes the undo bar down. */
  const commitPending = useCallback((id: string) => {
    if (undoTimerRef.current !== null) {
      window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    setPending((current) => (current?.id === id ? null : current));
    void onDeleteRef.current(id);
  }, []);

  const beginDelete = useCallback(
    (id: string, title: string) => {
      // One undo bar at a time. A second delete lets the first one through
      // straight away rather than quietly cancelling it.
      const outstanding = pendingIdRef.current;
      if (outstanding && outstanding !== id) commitPending(outstanding);
      pendingIdRef.current = id;
      setPending({ id, title });
      if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = window.setTimeout(() => commitPending(id), UNDO_WINDOW_MS);
    },
    [commitPending],
  );

  const undoDelete = useCallback(() => {
    // Nothing to restore: the video was never deleted, only hidden.
    if (undoTimerRef.current !== null) {
      window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    setPending(null);
  }, []);

  // Leaving the screen with a delete still on the clock has to resolve one way
  // or the other. It resolves the way the user asked: the video goes.
  useEffect(
    () => () => {
      clearHold();
      if (undoTimerRef.current !== null) {
        window.clearTimeout(undoTimerRef.current);
        undoTimerRef.current = null;
      }
    },
    [clearHold],
  );
  useEffect(
    () => () => {
      if (pendingIdRef.current) void onDeleteRef.current(pendingIdRef.current);
    },
    [],
  );

  const visibleSaved = savedVideos.filter((item) => item.savedVideoId !== pending?.id);

  // Nothing left to shake.
  useEffect(() => {
    if (editing && visibleSaved.length === 0) setEditing(false);
  }, [editing, visibleSaved.length]);

  useEffect(() => {
    if (!editing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEditing(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing]);

  const isOverTrash = (x: number, y: number) => {
    const rect = trashRef.current?.getBoundingClientRect();
    if (!rect) return false;
    return (
      x >= rect.left - TRASH_CATCH_MARGIN_PX &&
      x <= rect.right + TRASH_CATCH_MARGIN_PX &&
      y >= rect.top - TRASH_CATCH_MARGIN_PX &&
      y <= rect.bottom + TRASH_CATCH_MARGIN_PX
    );
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>, id: string) => {
    // A mouse right-click, or a second finger mid-drag, is not a press.
    if (event.button !== 0 || pressRef.current) return;
    const target = event.currentTarget;
    pressRef.current = { id, x: event.clientX, y: event.clientY, dragging: false };

    const lift = () => {
      holdTimerRef.current = null;
      const press = pressRef.current;
      if (!press || press.id !== id) return;
      press.dragging = true;
      setEditing(true);
      setDragging({ id, dx: 0, dy: 0 });
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        // Capture is what keeps the moves coming once the finger leaves the
        // tile it started on. Without it the drag simply stops short, which
        // is worse than the alternative but not broken.
      }
      // currentTarget is read at the top of the handler on purpose: React
      // clears it once dispatch is over, and this runs half a second later.
    };

    // Already shaking? Then a press is a grab straight away -- exactly as an
    // iPhone behaves once the home screen is in edit mode.
    if (editing) lift();
    else holdTimerRef.current = window.setTimeout(lift, HOLD_TO_EDIT_MS);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const press = pressRef.current;
    if (!press) return;
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;

    if (!press.dragging) {
      // Moved before the hold landed: they are scrolling the page.
      if (Math.abs(dx) > HOLD_SLOP_PX || Math.abs(dy) > HOLD_SLOP_PX) {
        clearHold();
        pressRef.current = null;
      }
      return;
    }

    event.preventDefault();
    setDragging({ id: press.id, dx, dy });
    setOverTrash(isOverTrash(event.clientX, event.clientY));
  };

  const endPress = (event: ReactPointerEvent<HTMLElement>, title: string) => {
    clearHold();
    const press = pressRef.current;
    pressRef.current = null;
    setDragging(null);
    setOverTrash(false);
    if (!press?.dragging) return;
    if (isOverTrash(event.clientX, event.clientY)) beginDelete(press.id, title);
  };

  const handlePointerCancel = () => {
    clearHold();
    pressRef.current = null;
    setDragging(null);
    setOverTrash(false);
  };

  const hasAnything = visibleSaved.length > 0 || cloudVideos.length > 0;

  return (
    <>
      {visibleSaved.length > 0 && (
        <div className="player-portal-shelf-bar">
          {editing ? (
            <>
              <span className="player-portal-shelf-hint">Drag a video to the bin to delete it.</span>
              <button
                className="player-portal-shelf-done"
                type="button"
                onClick={() => setEditing(false)}
              >
                Done
              </button>
            </>
          ) : (
            <span className="player-portal-shelf-hint">Hold a video to delete.</span>
          )}
        </div>
      )}

      {hasAnything ? (
        <ul className={`player-portal-video-grid${editing ? " is-editing" : ""}`}>
          {cloudVideos.map((transfer) => {
            const downloading = downloadingIds.has(transfer.savedVideoId);
            const title = transfer.savedVideo?.title || "Swing video";
            const size = formatSize(transfer.video?.sizeBytes || transfer.expectedSizeBytes);
            return (
              // Not deletable and so never shaken: this video lives in the
              // coach's Drive, and this phone is only borrowing a view of it.
              <li
                className="player-portal-video-tile player-portal-video-tile-cloud"
                key={transfer.savedVideoId}
              >
                {/* The tile and the pill both download -- the tile because it
                    is the thing your thumb goes to, the pill because it says
                    what the tap will do. */}
                <button
                  type="button"
                  className="player-portal-video-media player-portal-video-media-cloud"
                  disabled={downloading}
                  onClick={() => onDownload(transfer.savedVideoId)}
                  aria-label={`Download ${title} to this device`}
                >
                  <span className="player-portal-video-cloud-glyph" aria-hidden="true" />
                  {transfer.video?.duration != null && (
                    <span className="player-portal-video-duration">
                      {formatDuration(transfer.video.duration)}
                    </span>
                  )}
                </button>
                <div className="player-portal-video-meta">
                  <strong>{title}</strong>
                  <span>{formatDate(transfer.savedVideo?.createdAt || transfer.readyToImportAt)}</span>
                  <span>{[cloudVideoLabel(transfer), size].filter(Boolean).join(" · ")}</span>
                </div>
                <button
                  className="player-portal-video-action"
                  type="button"
                  disabled={downloading}
                  onClick={() => onDownload(transfer.savedVideoId)}
                >
                  {downloading ? "Downloading…" : "Download"}
                </button>
              </li>
            );
          })}

          {visibleSaved.map((item) => {
            const id = item.savedVideoId;
            const sending = sendingIds.has(id);
            const progress = sendProgress[id] ?? item.cloud?.progress ?? 0;
            const cloudStatus = item.cloud?.status;
            const sent = cloudStatus === "ready" || cloudStatus === "imported";
            const failed = cloudStatus === "failed" || cloudStatus === "expired";
            // A tile at rest says nothing -- the screen's lead already covers
            // "on this device". The state line appears only when there is
            // state: in flight, sent, stalled or failed.
            const showState = sending || sent || failed || cloudStatus === "paused";
            const title = item.title || "Swing video";
            const isDragging = dragging?.id === id;
            return (
              <li
                className={`player-portal-video-tile${isDragging ? " is-dragging" : ""}`}
                key={id}
                style={
                  isDragging
                    ? ({
                        "--tile-dx": `${dragging.dx}px`,
                        "--tile-dy": `${dragging.dy}px`,
                      } as CSSProperties)
                    : undefined
                }
              >
                <button
                  type="button"
                  className="player-portal-video-media"
                  // While the grid is shaking a tap does nothing, the way a
                  // jiggling app icon does nothing. The minus badge and the
                  // bin are the only live targets.
                  onClick={() => {
                    if (!editing) onOpen(id);
                  }}
                  onPointerDown={(event) => handlePointerDown(event, id)}
                  onPointerMove={handlePointerMove}
                  onPointerUp={(event) => endPress(event, title)}
                  onPointerCancel={handlePointerCancel}
                  onContextMenu={(event) => event.preventDefault()}
                  aria-label={editing ? title : `Open ${title}`}
                >
                  {item.thumbnailDataUrl ? (
                    <img src={item.thumbnailDataUrl} alt="" loading="lazy" draggable={false} />
                  ) : (
                    <span className="player-portal-video-play-glyph" aria-hidden="true" />
                  )}
                  {item.source.duration != null && (
                    <span className="player-portal-video-duration">
                      {formatDuration(item.source.duration)}
                    </span>
                  )}
                  {sending && (
                    <span className="player-portal-video-progress" aria-hidden="true">
                      <span style={{ width: `${Math.min(100, Math.max(4, progress))}%` }} />
                    </span>
                  )}
                </button>

                {/* The corner minus. It is what makes deleting reachable
                    without a drag -- by keyboard, by screen reader, and by
                    anyone who would rather tap than drag. */}
                {editing && (
                  <button
                    type="button"
                    className="player-portal-video-remove"
                    onClick={() => beginDelete(id, title)}
                    aria-label={`Delete ${title}`}
                  >
                    <span aria-hidden="true">−</span>
                  </button>
                )}

                <div className="player-portal-video-meta">
                  <strong>{title}</strong>
                  <span>{formatDate(item.capturedAt || item.createdAt)}</span>
                </div>
                {showState && (
                  <span
                    className={`player-portal-video-state${sent ? " is-sent" : ""}${failed ? " is-error" : ""}`}
                  >
                    {sending
                      ? `Sending… ${Math.round(progress)}%`
                      : sendStatusLabel(item, isGuest, guestConnected)}
                  </span>
                )}
                {!sent && !editing && (
                  <button
                    className="player-portal-video-action"
                    type="button"
                    disabled={sending}
                    onClick={() => onSend(id)}
                  >
                    {sending ? "Sending…" : failed ? "Try again" : "Send to coach"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="player-portal-empty">
          {cloudLoading
            ? "Looking for your videos…"
            : "No videos on this device yet. Record a swing to get started."}
        </p>
      )}

      {editing && (
        <div
          className={`player-portal-trash${overTrash ? " is-hot" : ""}`}
          ref={trashRef}
          aria-hidden="true"
        >
          <IconBin />
          <span>{overTrash ? "Release to delete" : "Drag here"}</span>
        </div>
      )}

      {pending && (
        <div className="player-portal-undo" role="status">
          <span>Deleted “{pending.title}”</span>
          <button type="button" onClick={undoDelete}>
            Undo
          </button>
        </div>
      )}
    </>
  );
}
