import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";

import "./playerPortal.css";
import { signOut, type Session } from "../auth/session";
import {
  openBookingEmbed,
  slotDate,
  storeBookingHandoff,
} from "../shared/bookingHandoff";
import {
  createIndexedDbSavedVideoLibrary,
  saveSavedVideoToCloud,
  type SavedVideoItem,
  type SavedVideoLibraryStore,
} from "../video-analysis/utils/savedVideoLibrary";
import type {
  VideoWorkspaceNavigationContext,
  VideoWorkspaceSaveResult,
} from "../video-analysis/VideoWorkspace";

// The player's own app. It is chosen by the entry point from the session role,
// not by hostname any more, and it never renders a login form of its own --
// there is one login screen for the whole product.
const VideoAnalysisPage = lazy(() =>
  import("../video-analysis/VideoAnalysisPage").then((module) => ({
    default: module.VideoAnalysisPage,
  })),
);

type Booking = {
  id: string;
  serviceName?: string;
  duration: number;
  week: number;
  day: number;
  start: number;
  client?: string;
  location?: { name?: string } | null;
};

type Note = {
  id: string;
  title?: string;
  body?: string;
  playerName?: string;
  createdAt?: string;
  updatedAt?: string;
};

type PortalTab = "lessons" | "notes" | "videos";

function formatMinutes(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const period = hours >= 12 ? "PM" : "AM";
  const hour12 = ((hours + 11) % 12) + 1;
  return mins === 0 ? `${hour12} ${period}` : `${hour12}:${String(mins).padStart(2, "0")} ${period}`;
}

function formatBookingWhen(booking: Booking) {
  const date = slotDate(booking.week, booking.day, booking.start);
  const dateLabel = date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
  return `${dateLabel} · ${formatMinutes(booking.start)}–${formatMinutes(booking.start + booking.duration)}`;
}

// The coach-side label speaks in Clarity Cloud and Drive terms. A player only
// needs to know whether their coach has it.
function sendStatusLabel(item: SavedVideoItem) {
  switch (item.cloud?.status) {
    case "ready":
    case "imported":
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

function formatDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export type PlayerPortalProps = {
  session: Session;
  onSignedOut: () => void;
};

export default function PlayerPortal({ session, onSignedOut }: PlayerPortalProps) {
  const [tab, setTab] = useState<PortalTab>("lessons");
  const [playerEmail, setPlayerEmail] = useState(session.email);
  const [playerName, setPlayerName] = useState(session.name);
  const [playerPhone, setPlayerPhone] = useState("");
  const [playerId, setPlayerId] = useState("");
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileError, setProfileError] = useState("");

  // Videos live on this device first. Nothing leaves it until the player
  // presses Send to coach.
  const savedVideoLibraryRef = useRef<SavedVideoLibraryStore | null>(null);
  if (savedVideoLibraryRef.current === null) {
    savedVideoLibraryRef.current = createIndexedDbSavedVideoLibrary();
  }
  const savedVideoLibrary = savedVideoLibraryRef.current;

  const [savedVideos, setSavedVideos] = useState<SavedVideoItem[]>([]);
  const [videoError, setVideoError] = useState("");
  const [sendingIds, setSendingIds] = useState<Set<string>>(() => new Set());
  const [sendProgress, setSendProgress] = useState<Record<string, number>>({});
  const [recording, setRecording] = useState(false);
  const [openVideoId, setOpenVideoId] = useState("");

  const loadProfile = useCallback(async () => {
    setProfileLoading(true);
    setProfileError("");
    try {
      const res = await fetch("/api/player/profile", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (res.status === 401) {
        onSignedOut();
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        message?: string;
        player?: { email?: string; name?: string; phone?: string; id?: string };
        bookings?: Booking[];
        notes?: Note[];
      };
      if (!res.ok) throw new Error(data?.message || "We couldn't load your profile.");
      setBookings(Array.isArray(data.bookings) ? data.bookings : []);
      setNotes(Array.isArray(data.notes) ? data.notes : []);
      if (data.player?.email) setPlayerEmail(data.player.email);
      if (data.player?.name) setPlayerName(data.player.name);
      if (data.player?.phone) setPlayerPhone(data.player.phone);
      if (data.player?.id) setPlayerId(data.player.id);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "We couldn't load your profile.");
    } finally {
      setProfileLoading(false);
    }
  }, [onSignedOut]);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  const refreshSavedVideos = useCallback(async () => {
    if (!savedVideoLibrary) return;
    try {
      setSavedVideos(await savedVideoLibrary.listItems());
    } catch (error) {
      setVideoError(error instanceof Error ? error.message : "Could not read your saved videos.");
    }
  }, [savedVideoLibrary]);

  useEffect(() => {
    void refreshSavedVideos();
  }, [refreshSavedVideos]);

  async function handleSignOut() {
    await signOut();
    onSignedOut();
  }

  // Hand off to the booking embed pre-filled, without ever putting personal
  // data in a URL.
  function startBooking() {
    const parts = (playerName || "").trim().split(/\s+/).filter(Boolean);
    storeBookingHandoff({
      firstName: parts[0] || "",
      lastName: parts.slice(1).join(" "),
      phone: playerPhone.trim(),
      email: playerEmail.trim(),
    });
    openBookingEmbed();
  }

  const sendToCoach = useCallback(
    async (savedVideoId: string) => {
      if (!savedVideoLibrary || sendingIds.has(savedVideoId)) return;
      setVideoError("");
      setSendingIds((current) => new Set(current).add(savedVideoId));
      try {
        await saveSavedVideoToCloud(savedVideoId, savedVideoLibrary, {
          scope: "player",
          onProgress: (progress) =>
            setSendProgress((current) => ({ ...current, [savedVideoId]: progress })),
        });
        await refreshSavedVideos();
      } catch (error) {
        setVideoError(
          error instanceof Error
            ? error.message
            : "Could not send that video. Your copy is still saved on this device.",
        );
      } finally {
        setSendingIds((current) => {
          const next = new Set(current);
          next.delete(savedVideoId);
          return next;
        });
      }
    },
    [refreshSavedVideos, savedVideoLibrary, sendingIds],
  );

  const closeWorkspace = useCallback(
    (_context?: VideoWorkspaceNavigationContext) => {
      setRecording(false);
      setOpenVideoId("");
      setTab("videos");
      void refreshSavedVideos();
    },
    [refreshSavedVideos],
  );

  const handleLocalSaveComplete = useCallback(
    async (_result: VideoWorkspaceSaveResult) => {
      await refreshSavedVideos();
    },
    [refreshSavedVideos],
  );

  // In the workspace, "save and send" means send it to the coach.
  const handleSaveAndSend = useCallback(
    async (result: VideoWorkspaceSaveResult) => {
      for (const item of result.savedItems) {
        await sendToCoach(item.savedVideoId);
      }
    },
    [sendToCoach],
  );

  const now = Date.now();
  const upcomingBookings = useMemo(
    () =>
      bookings
        .filter((b) => slotDate(b.week, b.day, b.start).getTime() + b.duration * 60 * 1000 >= now)
        .sort(
          (a, b) =>
            slotDate(a.week, a.day, a.start).getTime() - slotDate(b.week, b.day, b.start).getTime(),
        ),
    [bookings, now],
  );
  const pastBookings = useMemo(
    () =>
      bookings
        .filter((b) => slotDate(b.week, b.day, b.start).getTime() + b.duration * 60 * 1000 < now)
        .sort(
          (a, b) =>
            slotDate(b.week, b.day, b.start).getTime() - slotDate(a.week, a.day, a.start).getTime(),
        ),
    [bookings, now],
  );
  const sortedNotes = useMemo(
    () =>
      [...notes].sort((a, b) =>
        String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")),
      ),
    [notes],
  );

  if (recording || openVideoId) {
    return (
      <div className="player-portal player-portal-video-host">
        <Suspense fallback={<div className="player-portal-card">Loading video…</div>}>
          <VideoAnalysisPage
            variant="player"
            playerId={playerId || playerEmail}
            playerName={playerName}
            savedVideoId={openVideoId || undefined}
            savedVideoLibrary={savedVideoLibrary}
            onSavedVideoLibraryChange={() => void refreshSavedVideos()}
            onNavigateBack={closeWorkspace}
            onLocalSaveComplete={handleLocalSaveComplete}
            onSaveAndSend={handleSaveAndSend}
          />
        </Suspense>
      </div>
    );
  }

  const renderBooking = (booking: Booking) => (
    <li className="player-portal-booking" key={booking.id}>
      <div className="player-portal-booking-main">
        <strong>{booking.serviceName || "Lesson"}</strong>
        <span>{formatBookingWhen(booking)}</span>
      </div>
      {booking.location?.name && <span className="player-portal-booking-loc">{booking.location.name}</span>}
    </li>
  );

  return (
    <div className="player-portal">
      <div className="player-portal-card">
        <div className="player-portal-header">
          <div className="player-portal-brand">
            <strong>Clarity Golf</strong>
            <span>Player Portal</span>
          </div>
          <button className="player-portal-ghost" type="button" onClick={() => void handleSignOut()}>
            Sign out
          </button>
        </div>
        <h1>{playerName ? `Hi, ${playerName.split(/\s+/)[0]}` : "Your profile"}</h1>
        {playerEmail && <p className="player-portal-lead">{playerEmail}</p>}

        <button className="player-portal-primary" type="button" onClick={startBooking}>
          Book a lesson
        </button>

        <nav className="player-portal-tabs" aria-label="Portal sections">
          <button
            type="button"
            className={tab === "lessons" ? "active" : ""}
            onClick={() => setTab("lessons")}
          >
            Lessons
          </button>
          <button
            type="button"
            className={tab === "notes" ? "active" : ""}
            onClick={() => setTab("notes")}
          >
            Notes
          </button>
          <button
            type="button"
            className={tab === "videos" ? "active" : ""}
            onClick={() => setTab("videos")}
          >
            Videos
          </button>
        </nav>

        {profileError ? (
          <div className="player-portal-error" role="alert">
            <p style={{ margin: 0 }}>{profileError}</p>
            <button
              className="player-portal-ghost"
              type="button"
              onClick={() => void loadProfile()}
              style={{ marginTop: 10 }}
            >
              Try again
            </button>
          </div>
        ) : (
          <>
            {tab === "lessons" && (
              <>
                <section className="player-portal-section">
                  <h2>Upcoming lessons</h2>
                  {profileLoading && !bookings.length ? (
                    <p className="player-portal-empty">Loading your lessons…</p>
                  ) : upcomingBookings.length ? (
                    <ul className="player-portal-list">{upcomingBookings.map(renderBooking)}</ul>
                  ) : (
                    <p className="player-portal-empty">No upcoming lessons booked.</p>
                  )}
                </section>

                {pastBookings.length > 0 && (
                  <section className="player-portal-section">
                    <h2>Past lessons</h2>
                    <ul className="player-portal-list">{pastBookings.slice(0, 20).map(renderBooking)}</ul>
                  </section>
                )}
              </>
            )}

            {tab === "notes" && (
              <section className="player-portal-section">
                <h2>Lesson notes</h2>
                {profileLoading && !notes.length ? (
                  <p className="player-portal-empty">Loading your lesson notes…</p>
                ) : sortedNotes.length ? (
                  <ul className="player-portal-list">
                    {sortedNotes.map((note) => (
                      <li className="player-portal-note" key={note.id}>
                        <div className="player-portal-note-head">
                          <strong>{note.title || "Lesson note"}</strong>
                          {formatDate(note.updatedAt || note.createdAt) && (
                            <span>{formatDate(note.updatedAt || note.createdAt)}</span>
                          )}
                        </div>
                        {note.body && <p>{note.body}</p>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="player-portal-empty">No lesson notes yet.</p>
                )}
              </section>
            )}

            {tab === "videos" && (
              <section className="player-portal-section">
                <h2>Your videos</h2>
                <p className="player-portal-lead">
                  Videos are saved on this device. Send one to your coach when you want them to see it.
                </p>

                {!savedVideoLibrary ? (
                  <p className="player-portal-empty">
                    This browser cannot store videos. Try Chrome or Safari on your phone or laptop.
                  </p>
                ) : (
                  <>
                    <button
                      className="player-portal-primary"
                      type="button"
                      onClick={() => setRecording(true)}
                    >
                      Record a video
                    </button>

                    {videoError && (
                      <div className="player-portal-error" role="alert">
                        <p style={{ margin: 0 }}>{videoError}</p>
                      </div>
                    )}

                    {savedVideos.length ? (
                      <ul className="player-portal-list">
                        {savedVideos.map((item) => {
                          const sending = sendingIds.has(item.savedVideoId);
                          const progress = sendProgress[item.savedVideoId] ?? item.cloud?.progress ?? 0;
                          const sent = item.cloud?.status === "ready" || item.cloud?.status === "imported";
                          return (
                            <li className="player-portal-video" key={item.savedVideoId}>
                              <div className="player-portal-video-main">
                                <strong>{item.title || "Swing video"}</strong>
                                <span>{formatDate(item.capturedAt || item.createdAt)}</span>
                                <span className="player-portal-video-status">
                                    {sending
                                      ? `Sending… ${Math.round(progress)}%`
                                      : sendStatusLabel(item)}
                                </span>
                              </div>
                              <div className="player-portal-video-actions">
                                <button
                                  className="player-portal-ghost"
                                  type="button"
                                  onClick={() => setOpenVideoId(item.savedVideoId)}
                                >
                                  Open
                                </button>
                                <button
                                  className="player-portal-primary"
                                  type="button"
                                  disabled={sending || sent}
                                  onClick={() => void sendToCoach(item.savedVideoId)}
                                >
                                  {sent ? "Sent" : sending ? "Sending…" : "Send to coach"}
                                </button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p className="player-portal-empty">No videos on this device yet.</p>
                    )}
                  </>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
