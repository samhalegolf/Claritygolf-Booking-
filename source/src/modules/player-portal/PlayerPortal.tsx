import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import "./playerPortal.css";
import { apiFetch } from "../auth/apiFetch";
import { signOut, type Session } from "../auth/session";
import { hasGuestToken } from "../auth/apiFetch";
import { isPlayerBookingMode, slotDate } from "../shared/bookingHandoff";
import {
  PlayerTerminalNav,
  type PlayerTerminalDestination,
} from "./PlayerTerminalNav";
import {
  createIndexedDbSavedVideoLibrary,
  fetchGuestStatus,
  importSavedVideoFromClarityCloud,
  listClarityCloudImportTransfers,
  registerGuestSender,
  saveSavedVideoToCloud,
  type ClarityCloudImportTransfer,
  type GuestSender,
  type GuestStatus,
  type SavedVideoItem,
  type SavedVideoLibraryStore,
} from "../video-analysis/utils/savedVideoLibrary";
import type {
  VideoWorkspaceNavigationContext,
  VideoWorkspaceSaveResult,
} from "../video-analysis/VideoWorkspace";
import { deleteGuestNote, listGuestNotes, saveGuestNote, type GuestNote } from "./guestNotesStore";

// The player's own app. It is chosen by the entry point from the session role,
// not by hostname any more, and it never renders a login form of its own --
// there is one login screen for the whole product.
const VideoAnalysisPage = lazy(() =>
  import("../video-analysis/VideoAnalysisPage").then((module) => ({
    default: module.VideoAnalysisPage,
  })),
);

// The booking widget is the same component the public site embeds -- one
// booking flow, not a player-shaped copy of it. It renders inline inside the
// Lessons tab's "Book" subtab now, so the navigation bar and the rest of the
// terminal stay exactly where the player left them.
const BookingWidget = lazy(() => import("../../App"));

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

type PortalTab = "home" | "lessons" | "notes" | "videos";

type CaddyAccess = {
  appUrl: string;
  connected: boolean;
  access: string;
  active: boolean;
  expiresAt: string | null;
};

// Caddy's own words for what a player has. "free" is an account with no pass.
function caddyAccessLabel(caddy: CaddyAccess) {
  if (!caddy.connected) return "Not set up yet";
  if (!caddy.active || caddy.access === "free" || caddy.access === "none") return "Free";
  if (caddy.access === "month_pass") return "Month Pass active";
  if (caddy.access === "member") return "Member";
  return caddy.access.replaceAll("_", " ");
}

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

// What a cloud video is doing here, in the player's words. A coach-device
// transfer is something the coach put in the cloud for them; a player
// submission is their own video coming back to a device that has never held
// it -- a new phone, or one whose local library was cleared.
function cloudVideoLabel(transfer: ClarityCloudImportTransfer) {
  return transfer.direction === "coach-device" ? "From your coach" : "You sent this";
}

function formatSize(bytes?: number) {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.max(1, Math.round(mb))} MB`;
}

function formatDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatDuration(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export type PlayerPortalProps = {
  session: Session;
  onSignedOut: () => void;
  /** Present only for a guest session -- opens the login screen. There is
   *  nothing to call when a real player is signed in, so it is optional. */
  onRequestSignIn?: () => void;
};

export default function PlayerPortal({ session, onSignedOut, onRequestSignIn }: PlayerPortalProps) {
  // No account yet. The terminal still opens -- the video tool and personal
  // notes both work right away -- but Lessons (and booking with it) has
  // nothing to show without one, so it isn't in the nav at all for a guest.
  const isGuest = session.role !== "player";

  // The deep-link check is still real (a push notification can land straight
  // on booking) -- it now just selects Lessons + the Book subtab instead of
  // the old separate full-screen mode.
  const [tab, setTab] = useState<PortalTab>(() => (!isGuest && isPlayerBookingMode() ? "lessons" : "home"));
  const [lessonsSubtab, setLessonsSubtab] = useState<"book" | "upcoming">(() =>
    !isGuest && isPlayerBookingMode() ? "book" : "upcoming",
  );
  const [playerEmail, setPlayerEmail] = useState(session.email);
  const [playerName, setPlayerName] = useState(session.name);
  const [playerId, setPlayerId] = useState("");
  const [caddy, setCaddy] = useState<CaddyAccess | null>(null);
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

  // Videos that exist in the cloud but not on this device. A guest never has
  // any -- a guest can put bytes into the coach's Drive and can never read one
  // back out -- so the portal does not ask on their behalf.
  const [cloudVideos, setCloudVideos] = useState<ClarityCloudImportTransfer[]>([]);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(() => new Set());

  // Sending as a guest. The identity is a name and an email -- not an account
  // -- captured inline the first time they send, so nothing about the screen
  // they are on has to change.
  const guestIdentityRef = useRef<GuestSender | null>(null);
  const [guestSheetVideoId, setGuestSheetVideoId] = useState("");
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [guestNote, setGuestNote] = useState("");
  const [guestBusy, setGuestBusy] = useState(false);
  const [guestError, setGuestError] = useState("");
  const [guestStatus, setGuestStatus] = useState<GuestStatus | null>(null);
  const lastGuestStatusAtRef = useRef(0);

  // A guest's own notes -- local only, same on-device-first philosophy as
  // their videos. Separate from `notes` above, which is the coach-authored
  // list a signed-in player gets from the server.
  const [guestNotes, setGuestNotes] = useState<GuestNote[]>(() => (isGuest ? listGuestNotes() : []));
  const [addingNote, setAddingNote] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteDraftTitle, setNoteDraftTitle] = useState("");
  const [noteDraftBody, setNoteDraftBody] = useState("");

  useEffect(() => {
    if (isGuest) setGuestNotes(listGuestNotes());
  }, [isGuest]);

  const loadProfile = useCallback(async () => {
    // A guest has no account to load one for, and 401 here would otherwise
    // read as "signed out" and bounce them off a screen they never signed
    // into in the first place.
    if (isGuest) {
      setProfileLoading(false);
      return;
    }
    setProfileLoading(true);
    setProfileError("");
    try {
      const res = await apiFetch("/api/player/profile");
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
      if (data.player?.id) setPlayerId(data.player.id);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "We couldn't load your profile.");
    } finally {
      setProfileLoading(false);
    }
  }, [isGuest, onSignedOut]);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  // Caddy is a separate product with its own source of truth. The portal only
  // asks where it is and what this player has, and stays usable if it cannot
  // be reached at all.
  useEffect(() => {
    if (isGuest) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch("/api/player/caddy");
        if (!res.ok) return;
        const data = (await res.json().catch(() => null)) as {
          appUrl?: string;
          status?: { connected?: boolean; access?: string; active?: boolean; expiresAt?: string | null };
        } | null;
        if (cancelled || !data?.appUrl) return;
        setCaddy({
          appUrl: data.appUrl,
          connected: Boolean(data.status?.connected),
          access: String(data.status?.access || "none"),
          active: Boolean(data.status?.active),
          expiresAt: data.status?.expiresAt || null,
        });
      } catch {
        // Leave the Caddy entry hidden rather than showing a link that may not
        // go anywhere.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isGuest]);

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

  const refreshCloudVideos = useCallback(async () => {
    if (isGuest) return;
    setCloudLoading(true);
    try {
      const transfers = await listClarityCloudImportTransfers();
      // Only what the server would actually hand over: the catalogue keeps
      // rows whose Drive copy has since been cleaned up, and a shell that
      // cannot be downloaded is worse than no shell at all.
      setCloudVideos(transfers.filter((transfer) => transfer.status === "ready" && transfer.driveVideoFileId));
    } catch {
      // The device library is the portal's source of truth. A cloud list that
      // will not load hides the extra rows and nothing else.
      setCloudVideos([]);
    } finally {
      setCloudLoading(false);
    }
  }, [isGuest]);

  useEffect(() => {
    void refreshCloudVideos();
  }, [refreshCloudVideos]);

  // A cloud row is only worth showing while this device has no copy.
  const missingCloudVideos = useMemo(() => {
    const onDevice = new Set(savedVideos.map((item) => item.savedVideoId));
    return cloudVideos.filter((transfer) => !onDevice.has(transfer.savedVideoId));
  }, [cloudVideos, savedVideos]);

  const downloadFromCloud = useCallback(
    async (savedVideoId: string) => {
      if (!savedVideoLibrary || downloadingIds.has(savedVideoId)) return;
      setVideoError("");
      setDownloadingIds((current) => new Set(current).add(savedVideoId));
      try {
        // No receipt: pulling a copy is a read. The receipt is the coach
        // taking custody, and it schedules the Drive original for deletion.
        await importSavedVideoFromClarityCloud(savedVideoId, savedVideoLibrary, { sendReceipt: false });
        await refreshSavedVideos();
        await refreshCloudVideos();
      } catch (error) {
        setVideoError(
          error instanceof Error ? error.message : "Could not download that video. Try again.",
        );
      } finally {
        setDownloadingIds((current) => {
          const next = new Set(current);
          next.delete(savedVideoId);
          return next;
        });
      }
    },
    [downloadingIds, refreshCloudVideos, refreshSavedVideos, savedVideoLibrary],
  );

  async function handleSignOut() {
    await signOut();
    onSignedOut();
  }

  const openCaddy = useCallback(() => {
    if (!caddy?.appUrl) return;
    window.open(caddy.appUrl, "_blank", "noopener,noreferrer");
  }, [caddy]);

  const navigateTerminal = useCallback((destination: PlayerTerminalDestination) => {
    setRecording(false);
    setOpenVideoId("");
    setTab(destination);
  }, []);

  const startRecording = useCallback(() => {
    setOpenVideoId("");
    setRecording(true);
  }, []);

  const refreshGuestStatus = useCallback(async () => {
    if (!isGuest || !hasGuestToken()) return;
    lastGuestStatusAtRef.current = Date.now();
    setGuestStatus(await fetchGuestStatus());
  }, [isGuest]);

  /**
   * The actual send. Identical to the player path but for the scope string --
   * same engine, same coach, different credential.
   */
  const sendAsGuest = useCallback(
    async (savedVideoId: string) => {
      if (!savedVideoLibrary || sendingIds.has(savedVideoId)) return;
      setVideoError("");
      setSendingIds((current) => new Set(current).add(savedVideoId));
      try {
        await saveSavedVideoToCloud(savedVideoId, savedVideoLibrary, {
          scope: "guest",
          message: guestNote.trim(),
          onProgress: (progress) =>
            setSendProgress((current) => ({ ...current, [savedVideoId]: progress })),
        });
        // The note belongs to the video it was written for. Leaving it set
        // would silently attach it to the next one too.
        setGuestNote("");
        await refreshSavedVideos();
        void refreshGuestStatus();
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
    [guestNote, refreshGuestStatus, refreshSavedVideos, savedVideoLibrary, sendingIds],
  );

  const sendToCoach = useCallback(
    async (savedVideoId: string) => {
      if (isGuest) {
        // Ask for a name and an email inline, once. No navigation, no account:
        // the screen must not change until a coach is actually connected.
        //
        // hasGuestToken() matters as much as the ref: the ref only lives as
        // long as this component, so on the next launch it is empty while the
        // stored token is still perfectly good. Going by the ref alone would
        // mint a second sender row and orphan the first one's quota -- and any
        // claim the coach had already made against it.
        if (!guestIdentityRef.current && !hasGuestToken()) {
          setGuestError("");
          setGuestSheetVideoId(savedVideoId);
          return;
        }
        await sendAsGuest(savedVideoId);
        return;
      }
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
    [isGuest, refreshSavedVideos, savedVideoLibrary, sendAsGuest, sendingIds],
  );

  const submitGuestIdentity = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const name = guestName.trim();
      const email = guestEmail.trim();
      if (!name || !email || guestBusy) return;
      setGuestBusy(true);
      setGuestError("");
      const videoId = guestSheetVideoId;
      try {
        guestIdentityRef.current = await registerGuestSender({ name, email });
        setGuestSheetVideoId("");
        if (videoId) await sendAsGuest(videoId);
        void refreshGuestStatus();
      } catch (error) {
        setGuestError(error instanceof Error ? error.message : "Could not set that up.");
      } finally {
        setGuestBusy(false);
      }
    },
    [guestBusy, guestEmail, guestName, guestSheetVideoId, refreshGuestStatus, sendAsGuest],
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
      // A guest with no identity yet would otherwise open the sheet once per
      // item. Open it once, for the first, and let them send the rest after.
      if (isGuest && !guestIdentityRef.current) {
        setGuestSheetVideoId(result.savedItems[0]?.savedVideoId ?? "");
        return;
      }
      for (const item of result.savedItems) {
        await sendToCoach(item.savedVideoId);
      }
    },
    [isGuest, sendToCoach],
  );

  const startGuestNoteDraft = useCallback(() => {
    setEditingNoteId(null);
    setNoteDraftTitle("");
    setNoteDraftBody("");
    setAddingNote(true);
  }, []);

  const editGuestNoteDraft = useCallback((note: GuestNote) => {
    setEditingNoteId(note.id);
    setNoteDraftTitle(note.title);
    setNoteDraftBody(note.body);
    setAddingNote(true);
  }, []);

  const cancelGuestNoteDraft = useCallback(() => {
    setAddingNote(false);
    setEditingNoteId(null);
  }, []);

  const handleSaveGuestNote = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!noteDraftTitle.trim() && !noteDraftBody.trim()) return;
      setGuestNotes(saveGuestNote({ id: editingNoteId ?? undefined, title: noteDraftTitle, body: noteDraftBody }));
      setAddingNote(false);
      setEditingNoteId(null);
    },
    [editingNoteId, noteDraftTitle, noteDraftBody],
  );

  const handleDeleteGuestNote = useCallback((id: string) => {
    setGuestNotes(deleteGuestNote(id));
  }, []);

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

  const nextLesson = upcomingBookings[0] || null;
  const laterLessons = upcomingBookings.slice(1);

  const mostRecentVideo = useMemo(() => {
    if (!savedVideos.length) return null;
    return [...savedVideos].sort((a, b) =>
      String(b.capturedAt || b.createdAt || "").localeCompare(String(a.capturedAt || a.createdAt || "")),
    )[0];
  }, [savedVideos]);

  // Deliberately not a setInterval. The coach adding someone is a rare event,
  // and the realistic case is: player puts the phone down, coach acts, player
  // picks the phone back up. So: once on mount, once after each send, and on
  // becoming visible again -- throttled, because iOS fires that generously.
  useEffect(() => {
    if (!isGuest || !hasGuestToken()) return;
    void refreshGuestStatus();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastGuestStatusAtRef.current < 60000) return;
      void refreshGuestStatus();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [isGuest, refreshGuestStatus]);

  const wasGuestRef = useRef(isGuest);
  useEffect(() => {
    // Lessons doesn't exist for a guest any more -- if a sign-out happens
    // while sitting on it, land back on Home instead of rendering a dead tab.
    if (!wasGuestRef.current && isGuest && tab === "lessons") setTab("home");
    wasGuestRef.current = isGuest;
  }, [isGuest, tab]);

  // Every screen in the terminal wears the same bar, including the ones that
  // take the whole viewport.
  const renderNav = (
    active: PlayerTerminalDestination | null,
    back?: { label: string; onBack: () => void } | null,
  ) => (
    <PlayerTerminalNav
      active={active}
      back={back}
      onNavigate={navigateTerminal}
      onSignOut={() => void handleSignOut()}
      onRecord={startRecording}
      guest={isGuest}
      onSignIn={onRequestSignIn}
    />
  );

  if (recording || openVideoId) {
    return (
      <div className="player-terminal">
        {renderNav(null, { label: "Videos", onBack: () => closeWorkspace() })}
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
    <div className="player-terminal">
      {renderNav(tab)}
      <div className="player-portal">
        <div className="player-portal-card">
          <h1>{isGuest ? "Welcome" : playerName ? `Hi, ${playerName.split(/\s+/)[0]}` : "Your profile"}</h1>
          {playerEmail && <p className="player-portal-lead">{playerEmail}</p>}

          {isGuest && (
            <div className="player-portal-guest-banner">
              {guestStatus?.connected ? (
                // The coach has acted. Say so -- but the screen stays exactly
                // as it is: they are still a guest until they finish the invite.
                <p>
                  {guestStatus.coachName} has added you — check your email to set a password.
                </p>
              ) : (
                <p>Browsing as a guest -- your videos stay on this device until you sign in.</p>
              )}
              <button className="player-portal-primary" type="button" onClick={() => onRequestSignIn?.()}>
                Sign in
              </button>
            </div>
          )}

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
              {tab === "home" && (
                <section className="player-portal-home">
                  <div className="player-portal-home-grid">
                    {isGuest ? (
                      <>
                        <button
                          type="button"
                          className="player-portal-home-card"
                          onClick={() => navigateTerminal("notes")}
                        >
                          <span className="player-portal-home-card-title">Notes</span>
                          <span className="player-portal-home-card-sub">Quick notes for yourself</span>
                        </button>
                        <button
                          type="button"
                          className="player-portal-home-card"
                          onClick={() => navigateTerminal("videos")}
                        >
                          <span className="player-portal-home-card-title">Videos</span>
                          <span className="player-portal-home-card-sub">
                            {savedVideos.length ? `${savedVideos.length} saved` : "Saved on this device"}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="player-portal-home-card player-portal-home-card-wide"
                          onClick={startRecording}
                        >
                          <span className="player-portal-home-card-title">Record a video</span>
                          <span className="player-portal-home-card-sub">Opens your camera</span>
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="player-portal-home-card"
                          onClick={() => navigateTerminal("lessons")}
                        >
                          <span className="player-portal-home-card-title">Next lesson</span>
                          <span className="player-portal-home-card-sub">
                            {profileLoading && !bookings.length
                              ? "Loading…"
                              : nextLesson
                                ? formatBookingWhen(nextLesson)
                                : "No upcoming lessons"}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="player-portal-home-card"
                          onClick={() => navigateTerminal("notes")}
                        >
                          <span className="player-portal-home-card-title">Notes</span>
                          <span className="player-portal-home-card-sub">
                            {sortedNotes.length
                              ? `${sortedNotes.length} lesson note${sortedNotes.length === 1 ? "" : "s"}`
                              : "Lesson notes"}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="player-portal-home-card"
                          onClick={() => navigateTerminal("videos")}
                        >
                          <span className="player-portal-home-card-title">Videos</span>
                          <span className="player-portal-home-card-sub">
                            {missingCloudVideos.length
                              ? `${missingCloudVideos.length} to download`
                              : mostRecentVideo
                                ? `Last saved ${formatDate(mostRecentVideo.capturedAt || mostRecentVideo.createdAt)}`
                                : "No videos yet"}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="player-portal-home-card player-portal-home-card-wide"
                          onClick={startRecording}
                        >
                          <span className="player-portal-home-card-title">Record a video</span>
                          <span className="player-portal-home-card-sub">Opens your camera</span>
                        </button>
                      </>
                    )}
                  </div>
                </section>
              )}

              {tab === "lessons" && !isGuest && (
                <>
                  {/* The next lesson is the one thing a player opens this for, so
                      it gets its own place above the list rather than being the
                      first row of it. */}
                  <section className="player-portal-section">
                    <h2>Next lesson</h2>
                    {profileLoading && !bookings.length ? (
                      <p className="player-portal-empty">Loading your lessons…</p>
                    ) : nextLesson ? (
                      <div className="player-portal-next">
                        <strong>{nextLesson.serviceName || "Lesson"}</strong>
                        <span>{formatBookingWhen(nextLesson)}</span>
                        {nextLesson.location?.name && <em>{nextLesson.location.name}</em>}
                      </div>
                    ) : (
                      <p className="player-portal-empty">No upcoming lessons booked.</p>
                    )}
                  </section>

                  <div className="player-portal-pill-toggle" role="tablist" aria-label="Lessons view">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={lessonsSubtab === "book"}
                      className={lessonsSubtab === "book" ? "active" : ""}
                      onClick={() => setLessonsSubtab("book")}
                    >
                      Book
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={lessonsSubtab === "upcoming"}
                      className={lessonsSubtab === "upcoming" ? "active" : ""}
                      onClick={() => setLessonsSubtab("upcoming")}
                    >
                      Upcoming
                    </button>
                  </div>

                  {lessonsSubtab === "book" ? (
                    <div className="player-portal-inline-booking">
                      <Suspense fallback={<p className="player-portal-empty">Loading booking…</p>}>
                        <BookingWidget bookingEntry="player" />
                      </Suspense>
                    </div>
                  ) : (
                    <>
                      {laterLessons.length > 0 && (
                        <section className="player-portal-section">
                          <h2>Upcoming lessons</h2>
                          <ul className="player-portal-list">{laterLessons.map(renderBooking)}</ul>
                        </section>
                      )}

                      {pastBookings.length > 0 && (
                        <details className="player-portal-past">
                          <summary>Past lessons ({pastBookings.length})</summary>
                          <ul className="player-portal-list">{pastBookings.slice(0, 20).map(renderBooking)}</ul>
                        </details>
                      )}

                      {!laterLessons.length && !pastBookings.length && !profileLoading && (
                        <p className="player-portal-empty">No other lessons yet.</p>
                      )}
                    </>
                  )}

                  {/* Caddy is its own product with its own billing. The portal
                      shows where the player stands and opens the door --
                      nothing more, and only from the Lessons tab. */}
                  {caddy?.appUrl && (
                    <section className="player-portal-section player-portal-caddy">
                      <h2>Clarity Caddy</h2>
                      <div className="player-portal-caddy-row">
                        <span className="player-portal-caddy-access">{caddyAccessLabel(caddy)}</span>
                        <button className="player-portal-ghost" type="button" onClick={openCaddy}>
                          Open Clarity Caddy ↗
                        </button>
                      </div>
                    </section>
                  )}
                </>
              )}

              {tab === "notes" && isGuest && (
                <section className="player-portal-section">
                  <h2>Notes</h2>
                  <p className="player-portal-lead">Quick notes for yourself. Saved on this device.</p>

                  {addingNote ? (
                    <form className="player-portal-note-form" onSubmit={handleSaveGuestNote}>
                      <label className="player-portal-field">
                        <span>Title</span>
                        <input
                          value={noteDraftTitle}
                          onChange={(event) => setNoteDraftTitle(event.target.value)}
                          placeholder="Title"
                        />
                      </label>
                      <label className="player-portal-field">
                        <span>Note</span>
                        <textarea
                          value={noteDraftBody}
                          onChange={(event) => setNoteDraftBody(event.target.value)}
                          rows={4}
                          placeholder="Write a note…"
                        />
                      </label>
                      <div className="player-portal-note-form-actions">
                        <button className="player-portal-ghost" type="button" onClick={cancelGuestNoteDraft}>
                          Cancel
                        </button>
                        <button
                          className="player-portal-primary"
                          type="submit"
                          disabled={!noteDraftTitle.trim() && !noteDraftBody.trim()}
                        >
                          Save
                        </button>
                      </div>
                    </form>
                  ) : (
                    <button className="player-portal-primary" type="button" onClick={startGuestNoteDraft}>
                      Add a note
                    </button>
                  )}

                  {guestNotes.length ? (
                    <ul className="player-portal-list">
                      {guestNotes.map((note) => (
                        <li className="player-portal-note" key={note.id}>
                          <div className="player-portal-note-head">
                            <strong>{note.title || "Note"}</strong>
                            {formatDate(note.updatedAt) && <span>{formatDate(note.updatedAt)}</span>}
                          </div>
                          {note.body && <p>{note.body}</p>}
                          <div className="player-portal-note-actions">
                            <button
                              className="player-portal-ghost"
                              type="button"
                              onClick={() => editGuestNoteDraft(note)}
                            >
                              Edit
                            </button>
                            <button
                              className="player-portal-ghost"
                              type="button"
                              onClick={() => handleDeleteGuestNote(note.id)}
                            >
                              Delete
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    !addingNote && <p className="player-portal-empty">No notes yet.</p>
                  )}
                </section>
              )}

              {tab === "notes" && !isGuest && (
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
                    {isGuest
                      ? "Videos are saved on this device. Send one to your coach when you want them to see it."
                      : "Videos are saved on this device. Anything in the cloud shows a download arrow — tap it to bring that video onto this device."}
                  </p>

                  {isGuest && guestStatus && guestStatus.sent.limit > 0 && !guestStatus.connected && (
                    <p className="player-portal-lead">
                      {guestStatus.sent.count} of {guestStatus.sent.limit} sent. Videos you send are
                      kept for {guestStatus.retentionDays} days until your coach adds you.
                    </p>
                  )}

                  {guestSheetVideoId && (
                    <form className="player-portal-note-form" onSubmit={submitGuestIdentity}>
                      <p className="player-portal-lead">
                        Your coach needs to know who this is from. No account needed.
                      </p>
                      <label className="player-portal-field">
                        <span>Your name</span>
                        <input
                          value={guestName}
                          onChange={(event) => setGuestName(event.target.value)}
                          autoComplete="name"
                          placeholder="Your name"
                        />
                      </label>
                      <label className="player-portal-field">
                        <span>Your email</span>
                        <input
                          value={guestEmail}
                          onChange={(event) => setGuestEmail(event.target.value)}
                          type="email"
                          autoComplete="email"
                          placeholder="you@example.com"
                        />
                      </label>
                      <label className="player-portal-field">
                        <span>Note for your coach (optional)</span>
                        <textarea
                          value={guestNote}
                          onChange={(event) => setGuestNote(event.target.value)}
                          rows={3}
                          placeholder="Anything you want them to look at?"
                        />
                      </label>
                      {guestError && (
                        <div className="player-portal-error" role="alert">
                          <p style={{ margin: 0 }}>{guestError}</p>
                        </div>
                      )}
                      <div className="player-portal-note-form-actions">
                        <button
                          className="player-portal-ghost"
                          type="button"
                          onClick={() => setGuestSheetVideoId("")}
                        >
                          Cancel
                        </button>
                        <button
                          className="player-portal-primary"
                          type="submit"
                          disabled={guestBusy || !guestName.trim() || !guestEmail.trim()}
                        >
                          {guestBusy ? "Sending…" : "Send to coach"}
                        </button>
                      </div>
                    </form>
                  )}

                  {!savedVideoLibrary ? (
                    <p className="player-portal-empty">
                      This browser cannot store videos. Try Chrome or Safari on your phone or laptop.
                    </p>
                  ) : (
                    <>
                      <button
                        className="player-portal-primary"
                        type="button"
                        onClick={startRecording}
                      >
                        Record a video
                      </button>

                      {videoError && (
                        <div className="player-portal-error" role="alert">
                          <p style={{ margin: 0 }}>{videoError}</p>
                        </div>
                      )}

                      {savedVideos.length || missingCloudVideos.length ? (
                        <ul className="player-portal-list">
                          {missingCloudVideos.map((transfer) => {
                            const downloading = downloadingIds.has(transfer.savedVideoId);
                            const title = transfer.savedVideo?.title || "Swing video";
                            const size = formatSize(transfer.video?.sizeBytes || transfer.expectedSizeBytes);
                            return (
                              <li
                                className="player-portal-video player-portal-video-cloud"
                                key={transfer.savedVideoId}
                              >
                                <div className="player-portal-video-thumb" aria-hidden="true">
                                  <span className="player-portal-video-thumb-cloud" />
                                  {transfer.video?.duration != null && (
                                    <span className="player-portal-video-thumb-duration">
                                      {formatDuration(transfer.video.duration)}
                                    </span>
                                  )}
                                </div>
                                <div className="player-portal-video-main">
                                  <strong>{title}</strong>
                                  <span>
                                    {formatDate(transfer.savedVideo?.createdAt || transfer.readyToImportAt)}
                                  </span>
                                  <span className="player-portal-video-status">
                                    {downloading
                                      ? "Downloading…"
                                      : [cloudVideoLabel(transfer), size].filter(Boolean).join(" · ")}
                                  </span>
                                </div>
                                <div className="player-portal-video-actions">
                                  <button
                                    className="player-portal-primary player-portal-video-download"
                                    type="button"
                                    disabled={downloading}
                                    onClick={() => void downloadFromCloud(transfer.savedVideoId)}
                                    aria-label={`Download ${title} to this device`}
                                  >
                                    <span aria-hidden="true">↓</span>
                                    {downloading ? "Downloading…" : "Download"}
                                  </button>
                                </div>
                              </li>
                            );
                          })}
                          {savedVideos.map((item) => {
                            const sending = sendingIds.has(item.savedVideoId);
                            const progress = sendProgress[item.savedVideoId] ?? item.cloud?.progress ?? 0;
                            const sent = item.cloud?.status === "ready" || item.cloud?.status === "imported";
                            return (
                              <li className="player-portal-video" key={item.savedVideoId}>
                                <div className="player-portal-video-thumb" aria-hidden="true">
                                  {item.thumbnailDataUrl ? (
                                    <img
                                      src={item.thumbnailDataUrl}
                                      alt=""
                                      className="player-portal-video-thumb-img"
                                    />
                                  ) : (
                                    <span className="player-portal-video-thumb-play" />
                                  )}
                                  {item.source.duration != null && (
                                    <span className="player-portal-video-thumb-duration">
                                      {formatDuration(item.source.duration)}
                                    </span>
                                  )}
                                </div>
                                <div className="player-portal-video-main">
                                  <strong>{item.title || "Swing video"}</strong>
                                  <span>{formatDate(item.capturedAt || item.createdAt)}</span>
                                  <span className="player-portal-video-status">
                                      {sending
                                        ? `Sending… ${Math.round(progress)}%`
                                        : sendStatusLabel(item, isGuest, Boolean(guestStatus?.connected))}
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
                        <p className="player-portal-empty">
                          {cloudLoading ? "Looking for your videos…" : "No videos on this device yet."}
                        </p>
                      )}
                    </>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
