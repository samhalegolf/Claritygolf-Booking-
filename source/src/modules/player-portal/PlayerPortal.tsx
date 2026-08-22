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
import { hasGuestToken, NATIVE } from "../auth/apiFetch";
import { isPlayerBookingMode, slotDate } from "../shared/bookingHandoff";
import {
  PlayerTerminalNav,
  type PlayerTerminalDestination,
} from "./PlayerTerminalNav";
import { PlayerVideoShelf } from "./PlayerVideoShelf";
import { formatDate } from "./format";
import {
  createIndexedDbSavedVideoLibrary,
  fetchGuestStatus,
  importSavedVideoFromClarityCloud,
  listClarityCloudImportTransfers,
  registerGuestSender,
  removeSavedVideoCloudTransfer,
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

type PortalTab = "home" | "lessons" | "practice" | "notes" | "videos";

/** Prescribed practice, as the player's profile hands it over. */
type PracticeItem = {
  id: string;
  categoryName?: string;
  subcategoryName?: string;
  body?: string;
  createdAt?: string;
  updatedAt?: string;
};

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

/**
 * Which way "Record a video" should go on this device.
 *
 * The native build and any touch device get the operating system's own sheet
 * -- Photo Library, Take Video, Choose File -- because that is one tap to
 * either the camera or a clip they already have, and it is the camera app
 * rather than a webview approximation of one.
 *
 * A desktop browser has no such sheet. A file dialog there offers no camera at
 * all, so the workspace's in-page recorder is the only way to actually record
 * something and it stays the default.
 *
 * NATIVE decides this before the media query is ever asked, so the app build
 * never depends on the pointer heuristic being right.
 */
function shouldUseDevicePicker() {
  if (NATIVE) return true;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(pointer: coarse)").matches;
}

/** Kept in step with the slide-out in playerPortal.css. */
const WORKSPACE_EXIT_MS = 190;

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
  const [practice, setPractice] = useState<PracticeItem[]>([]);
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
        practice?: PracticeItem[];
      };
      if (!res.ok) throw new Error(data?.message || "We couldn't load your profile.");
      setBookings(Array.isArray(data.bookings) ? data.bookings : []);
      setNotes(Array.isArray(data.notes) ? data.notes : []);
      setPractice(Array.isArray(data.practice) ? data.practice : []);
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
      const transfers = await listClarityCloudImportTransfers("player");
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
        // Player scope: the portal has a player session, never the coach's.
        // The scope also settles the receipt -- pulling a copy is a read, and
        // a receipt would schedule the coach's Drive original for deletion.
        await importSavedVideoFromClarityCloud(savedVideoId, savedVideoLibrary, { scope: "player" });
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

  // Tapping Record opens the phone's own camera/library sheet, not a page.
  //
  // The click has to happen inside the tap that triggered it -- iOS ignores a
  // file input opened from a promise or a later render -- so this stays
  // synchronous and does not wait for the workspace chunk to download. The
  // workspace mounts afterwards, around whatever file came back.
  const recordInputRef = useRef<HTMLInputElement>(null);
  const [pendingVideoFile, setPendingVideoFile] = useState<File | null>(null);
  const [liveRecordRequested, setLiveRecordRequested] = useState(false);
  // Say what the tap actually does, which is not the same on both.
  const recordCardSub = useMemo(
    () => (shouldUseDevicePicker() ? "Record one or pick an existing one" : "Opens your camera"),
    [],
  );

  const startRecording = useCallback(() => {
    setOpenVideoId("");
    const input = recordInputRef.current;
    if (!input || !shouldUseDevicePicker()) {
      // Desktop, or no input in the tree. Open the workspace straight onto its
      // own camera rather than a file dialog that cannot record anything.
      setLiveRecordRequested(true);
      setRecording(true);
      return;
    }
    setLiveRecordRequested(false);
    // Picking the same file twice in a row fires no change event unless the
    // value is cleared first.
    input.value = "";
    input.click();
  }, []);

  const handleRecordInputChange = useCallback((event: FormEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    // Dismissing the sheet is a decision, not a failure -- stay where we are.
    if (!file) return;
    setPendingVideoFile(file);
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

  // Leaving the video screen is two steps: the screen slides out, and then it
  // is torn down. Tearing it down first would make the video vanish and the
  // library appear in the same frame, which is the jump this replaces.
  const [leavingWorkspace, setLeavingWorkspace] = useState(false);

  const closeWorkspace = useCallback((_context?: VideoWorkspaceNavigationContext) => {
    setLeavingWorkspace(true);
  }, []);

  useEffect(() => {
    if (!leavingWorkspace) return;
    // A timer rather than onAnimationEnd: an animation that never runs -- a
    // hidden tab, a reduced-motion setting, a browser that skips it -- would
    // otherwise strand the player on a screen that is already on its way out.
    const timer = window.setTimeout(() => {
      setLeavingWorkspace(false);
      setRecording(false);
      setOpenVideoId("");
      // Holding the File would pin the whole video in memory, and reopening
      // the workspace would silently load the last one again.
      setPendingVideoFile(null);
      setLiveRecordRequested(false);
      setTab("videos");
      void refreshSavedVideos();
    }, WORKSPACE_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [leavingWorkspace, refreshSavedVideos]);

  /**
   * Deletes the copy on this device, and nothing else.
   *
   * A video already delivered to the coach stays delivered -- sending is
   * final, and the copy in their Drive is theirs. What that means in practice
   * is that a sent video deleted here can come back as a cloud tile to
   * download again, which is the honest picture of where it now lives.
   *
   * An upload still in flight is called off first. Leaving it running against
   * a video this device is about to stop holding is how a transfer ends up
   * stuck half-finished for good.
   */
  const deleteSavedVideo = useCallback(
    async (savedVideoId: string) => {
      if (!savedVideoLibrary) return;
      setVideoError("");
      try {
        const item = await savedVideoLibrary.getItem(savedVideoId);
        const status = item?.cloud?.status;
        const inFlight =
          status === "preparing" ||
          status === "session-created" ||
          status === "uploading" ||
          status === "verifying" ||
          status === "paused";
        if (inFlight) {
          await removeSavedVideoCloudTransfer(
            savedVideoId,
            savedVideoLibrary,
            isGuest ? "guest" : "player",
          );
        }
        await savedVideoLibrary.deleteItem(savedVideoId);
      } catch (error) {
        setVideoError(
          error instanceof Error ? error.message : "Could not delete that video. Try again.",
        );
      } finally {
        await refreshSavedVideos();
        // A sent video that has just left this device belongs in the cloud
        // list now, so that list has to be asked again.
        void refreshCloudVideos();
      }
    },
    [isGuest, refreshCloudVideos, refreshSavedVideos, savedVideoLibrary],
  );

  // Saving is the end of the visit to the video screen. The workspace empties
  // itself after a durable save, so staying put would land the player on the
  // blank upload screen -- the library is where the thing they just saved is.
  const handleLocalSaveComplete = useCallback(
    async (_result: VideoWorkspaceSaveResult) => {
      closeWorkspace();
    },
    [closeWorkspace],
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

  /**
   * Practice, grouped under its category heading.
   *
   * Insertion order rather than alphabetical: the server hands these over
   * newest first, so the category a coach touched most recently is the one at
   * the top of the screen. Alphabetical would put "Chipping" above whatever
   * was set after this morning's lesson.
   */
  const practiceGroups = useMemo(() => {
    const groups = new Map<string, PracticeItem[]>();
    for (const block of practice) {
      const name = block.categoryName?.trim() || "Practice";
      const existing = groups.get(name);
      if (existing) existing.push(block);
      else groups.set(name, [block]);
    }
    return [...groups].map(([name, blocks]) => ({ name, blocks }));
  }, [practice]);

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
    if (!wasGuestRef.current && isGuest && (tab === "lessons" || tab === "practice")) setTab("home");
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
        <div
          className={`player-portal player-portal-video-host${leavingWorkspace ? " is-leaving" : ""}`}
        >
          <Suspense fallback={<div className="player-portal-card">Loading video…</div>}>
            <VideoAnalysisPage
              variant="player"
              playerId={playerId || playerEmail}
              playerName={playerName}
              savedVideoId={openVideoId || undefined}
              initialVideoFile={openVideoId ? null : pendingVideoFile}
              autoStartLiveRecording={!openVideoId && liveRecordRequested}
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
      {/* No `capture` attribute on purpose: with it iOS goes straight to the
          camera, without it the player gets the sheet -- Photo Library, Take
          Video, Choose File -- which is the choice they actually want. */}
      <input
        ref={recordInputRef}
        type="file"
        accept="video/*"
        style={{ display: "none" }}
        onChange={handleRecordInputChange}
      />
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
            <div className="player-portal-profile-error">
              <p className="player-portal-error-line" role="alert">
                {profileError}
              </p>
              <button className="player-portal-ghost" type="button" onClick={() => void loadProfile()}>
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
                          <span className="player-portal-home-card-sub">{recordCardSub}</span>
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
                          onClick={() => navigateTerminal("practice")}
                        >
                          <span className="player-portal-home-card-title">Practice</span>
                          <span className="player-portal-home-card-sub">
                            {profileLoading && !practice.length
                              ? "Loading…"
                              : practice.length
                                ? `${practice.length} thing${practice.length === 1 ? "" : "s"} to work on`
                                : "Nothing set yet"}
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
                          <span className="player-portal-home-card-sub">{recordCardSub}</span>
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

              {tab === "practice" && !isGuest && (
                <section className="player-portal-section">
                  <h2>Practice</h2>
                  <p className="player-portal-lead">
                    What your coach has asked you to work on between lessons.
                  </p>
                  {profileLoading && !practice.length ? (
                    <p className="player-portal-empty">Loading your practice…</p>
                  ) : practiceGroups.length ? (
                    // Grouped by category, so a screen full of blocks reads as
                    // "here is the drilling, here is the playing" rather than
                    // as one long undifferentiated list.
                    practiceGroups.map((group) => (
                      <div className="player-portal-practice-group" key={group.name}>
                        <h3>{group.name}</h3>
                        <ul className="player-portal-list">
                          {group.blocks.map((block) => (
                            <li className="player-portal-practice" key={block.id}>
                              <div className="player-portal-note-head">
                                <strong>{block.subcategoryName || group.name}</strong>
                                {formatDate(block.updatedAt || block.createdAt) && (
                                  <span>{formatDate(block.updatedAt || block.createdAt)}</span>
                                )}
                              </div>
                              {block.body && <p>{block.body}</p>}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))
                  ) : (
                    <p className="player-portal-empty">
                      Nothing to practise yet. Your coach will put it here after your next lesson.
                    </p>
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
                        <p className="player-portal-error-line" role="alert">
                          {guestError}
                        </p>
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
                        <p className="player-portal-error-line" role="alert">
                          {videoError}
                        </p>
                      )}

                      <PlayerVideoShelf
                        savedVideos={savedVideos}
                        cloudVideos={missingCloudVideos}
                        sendingIds={sendingIds}
                        sendProgress={sendProgress}
                        downloadingIds={downloadingIds}
                        isGuest={isGuest}
                        guestConnected={Boolean(guestStatus?.connected)}
                        cloudLoading={cloudLoading}
                        onOpen={setOpenVideoId}
                        onSend={(id) => void sendToCoach(id)}
                        onDownload={(id) => void downloadFromCloud(id)}
                        onDelete={(id) => void deleteSavedVideo(id)}
                      />
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
