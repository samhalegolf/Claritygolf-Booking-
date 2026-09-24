import { Loading } from "../shared/Loading";
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";

import "./playerPortal.css";
import { apiFetch } from "../auth/apiFetch";
import { signOut, type Session } from "../auth/session";
import { hasGuestToken, NATIVE } from "../auth/apiFetch";
import { isPlayerBookingMode, slotDate } from "../shared/bookingHandoff";
import { useBackNavigation } from "../shared/backNavigation";
import {
  PlayerTerminalNav,
  type PlayerTerminalDestination,
} from "./PlayerTerminalNav";
import { PlayerVideoShelf } from "./PlayerVideoShelf";
import {
  PlayerBookingEmbed,
  isPlayerBookingEmbedConfigured,
  type PlayerBookingEmbedConfig,
} from "./PlayerBookingEmbed";
import { formatClock, formatDate } from "./format";
import { groupSwingReviews } from "./swingReviews";
import { SwingReviewFlow, type ReviewOffer, type SwingReviewDraft } from "./SwingReviewFlow";
import { stashReviewDraft, takeReviewDraft } from "./reviewDraftStore";
import { recentActivityList } from "./recentActivity";
import {
  effectiveTheme,
  portalThemeAttribute,
  readPortalTheme,
  systemPrefersDark,
  togglePortalTheme,
  writePortalTheme,
  type PortalTheme,
} from "./portalTheme";
import "../practice/practice.css";
import { PracticeWall } from "../practice/PracticeWall";
import {
  practiceBlockMeta,
  practiceExpiryLabel,
  practiceSteps,
  practiceTypeList,
  practiceTypeMeta,
  type PracticeBlockType,
  type PracticeTypeMeta,
} from "../practice/practiceModel";
import {
  createIndexedDbSavedVideoLibrary,
  fetchGuestStatus,
  importSavedVideoFromClarityCloud,
  listClarityCloudImportTransfers,
  markClarityCloudReturnSeen,
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
const BookingWidget = lazy(() => import("../public-booking/PublicBookingApp"));

type Booking = {
  id: string;
  serviceName?: string;
  /** "video-review" is a deadline, not a time to turn up at. */
  lessonFormat?: string;
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
  /** The sitting this note was taken in. Present on a note the coach typed
   *  during a swing review, which is how the Reviews tab finds it again. */
  lessonId?: string;
  /** The booking this note was taken against, when there was one. */
  calendarItemId?: string;
  createdAt?: string;
  updatedAt?: string;
};

type PortalTab =
  | "home"
  | "lessons"
  | "reviews"
  | "passes"
  | "practice"
  | "notes"
  | "videos"
  | "book";

type PracticeExpiryType = "next_lesson" | "set_date" | "none";
type PracticeStatus = "active" | "completed" | "expired" | "archived";

/** A Practice Block, as the player's profile hands it over. */
type PracticeItem = {
  id: string;
  title: string;
  content: string;
  blockType: PracticeBlockType;
  dose: string;
  assignedAt: string;
  expiryType: PracticeExpiryType;
  expiryDate: string | null;
  linkedVideoId: string | null;
  status: PracticeStatus;
  completedAt: string | null;
};

/** Where an activity row goes, in the words on the bar. */
const ACTIVITY_TAB_LABELS: Record<string, string> = {
  reviews: "Reviews",
  practice: "Practice",
  notes: "Notes",
  videos: "Videos",
  passes: "Passes",
};

/* What the big number on a pass says.
 *
 * Four states, and only one of them is a count. The other three are the
 * reasons a count would be misleading: a pass that has not started, one that
 * ran out, and one that timed out. Saying "0 left" for the last two is
 * technically true and useless -- a player wants to know whether to book or to
 * buy, and those are different answers. */
function passBalanceLabel(pass: PlayerPass) {
  if (pass.status === "scheduled") return "Not started";
  if (pass.status === "expired") return "Expired";
  if (pass.status === "exhausted" || pass.creditsAvailable < 1) return "All used";
  return `${pass.creditsAvailable} left`;
}

/** A pass, as playerPassViews() hands it over. Deliberately not the coach's
 *  PassView -- the note, the source and who pressed the button stay behind. */
type PlayerPass = {
  id: string;
  name: string;
  creditsAvailable: number;
  creditsAllocated: number;
  creditsRedeemed: number;
  expiresAt: string | null;
  status: "active" | "exhausted" | "expired" | "scheduled" | "void";
  covers: string[];
  issuedAt: string;
  history: Array<{ id: string; redeemedAt: string; bookingId: string | null }>;
};

/** Something the coach sells that a player can buy for themselves. Every one
 *  of them resolves to a pass -- see _shared/player-shop.mts. */
type ShopItem = {
  serviceId: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  credits: number;
  coversServiceIds: string[];
  kind: "package" | "video-review";
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

function isReviewBooking(booking: Booking) {
  return booking.lessonFormat === "video-review";
}

function formatBookingWhen(booking: Booking) {
  const date = slotDate(booking.week, booking.day, booking.start);
  const dateLabel = date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
  // A review's slot is the day the coach owes it back. Printing the hour it
  // happens to sit on would read as an appointment to attend, which is the one
  // thing it is not.
  if (isReviewBooking(booking)) return `Back with you by ${dateLabel}`;
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
const PRIVACY_URL = "https://claritygolf.app/privacy";
const SUPPORT_URL = "https://claritygolf.app/support";
const TERMS_URL = "https://claritygolf.app/terms";

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
  const [playerPhone, setPlayerPhone] = useState("");
  const [playerId, setPlayerId] = useState("");
  const [caddy, setCaddy] = useState<CaddyAccess | null>(null);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [practice, setPractice] = useState<PracticeItem[]>([]);
  const [practiceBlockTypes, setPracticeBlockTypes] = useState<PracticeTypeMeta[]>([]);
  const [passes, setPasses] = useState<PlayerPass[]>([]);
  const [flexibleValueCents, setFlexibleValueCents] = useState(0);
  const [passCurrency, setPassCurrency] = useState("");
  const [shop, setShop] = useState<ShopItem[]>([]);
  /** Which item is mid-purchase, so only its own button goes quiet. */
  const [buyingId, setBuyingId] = useState("");
  const [reviewOffer, setReviewOffer] = useState<ReviewOffer | null>(null);
  /** The New Swing Review screen, which takes over the tab while it is up. */
  const [reviewFlowOpen, setReviewFlowOpen] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState("");
  /** Which half of Lessons is showing, and which way its Book toggle is set. */
  const [lessonsView, setLessonsView] = useState<"book" | "past">("book");
  const [bookMode, setBookMode] = useState<"in-person" | "review">("in-person");
  const [openBookingId, setOpenBookingId] = useState("");
  /* Light or dark. "system" until the player touches the switch, which is why
     it is a real state rather than the absence of one -- see portalTheme.ts. */
  const [theme, setTheme] = useState<PortalTheme>(readPortalTheme);
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);
  const [purchaseNote, setPurchaseNote] = useState("");
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileError, setProfileError] = useState("");
  const [deletionOpen, setDeletionOpen] = useState(false);
  const [deletionBusy, setDeletionBusy] = useState(false);
  const [deletionMessage, setDeletionMessage] = useState("");
  const [deletionError, setDeletionError] = useState("");
  const [expandedPracticeId, setExpandedPracticeId] = useState<string | null>(null);
  /** Which swing review is open. Empty means the list, which is how it lands. */
  const [openReviewId, setOpenReviewId] = useState("");
  const [completingPracticeId, setCompletingPracticeId] = useState<string | null>(null);
  const [practiceVideos, setPracticeVideos] = useState<ClarityCloudImportTransfer[]>([]);
  // The business's outside booking widget, if it runs one. Null until the
  // profile lands, and null forever for a business that has not set one up --
  // which is what keeps the tab out of the nav.
  const [bookingEmbed, setBookingEmbed] = useState<PlayerBookingEmbedConfig | null>(null);

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
        practiceBlockTypes?: PracticeTypeMeta[];
        passes?: PlayerPass[];
        flexibleValueCents?: number;
        passCurrency?: string;
        shop?: ShopItem[];
        review?: ReviewOffer | null;
        bookingEmbed?: PlayerBookingEmbedConfig;
      };
      if (!res.ok) throw new Error(data?.message || "We couldn't load your profile.");
      setBookings(Array.isArray(data.bookings) ? data.bookings : []);
      setNotes(Array.isArray(data.notes) ? data.notes : []);
      setPractice(Array.isArray(data.practice) ? data.practice : []);
      // The coach's own names and colours, so the player's wall is the same
      // object the coach is looking at. Empty means this workspace never
      // edited them and both ends fall back to the same defaults.
      setPracticeBlockTypes(Array.isArray(data.practiceBlockTypes) ? data.practiceBlockTypes : []);
      setPasses(Array.isArray(data.passes) ? data.passes : []);
      setFlexibleValueCents(Math.max(0, Math.round(Number(data.flexibleValueCents) || 0)));
      setPassCurrency(String(data.passCurrency || ""));
      // Empty when the business has no card payments set up, which is the
      // server's answer rather than something the portal works out.
      // The App Store build is a companion to the coach's service. Existing
      // passes work here, but this binary never sells or links out to buy one.
      setShop(__CLARITY_NATIVE__ ? [] : Array.isArray(data.shop) ? data.shop : []);
      // Null when the coach sells no video review, or sells more than one and
      // the catalogue cannot say which is "the" review.
      setReviewOffer(
        data.review
          ? { ...data.review, canBuy: __CLARITY_NATIVE__ ? false : Boolean(data.review.canBuy) }
          : null,
      );
      setBookingEmbed(isPlayerBookingEmbedConfigured(data.bookingEmbed) ? data.bookingEmbed : null);
      if (data.player?.email) setPlayerEmail(data.player.email);
      if (data.player?.name) setPlayerName(data.player.name);
      if (data.player?.phone) setPlayerPhone(data.player.phone);
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

  // Titles for any linked videos, fetched once a practice block actually
  // references one. Best-effort: a linked video that's since become
  // unavailable must never block the rest of the Practice tab from loading.
  useEffect(() => {
    if (isGuest || !practice.some((block) => block.linkedVideoId)) return;
    let cancelled = false;
    void (async () => {
      try {
        const transfers = await listClarityCloudImportTransfers("player");
        if (!cancelled) setPracticeVideos(transfers);
      } catch {
        // Leave practiceVideos empty -- detail view falls back to "unavailable".
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isGuest, practice]);

  const markPracticeComplete = useCallback(
    async (id: string) => {
      if (completingPracticeId) return;
      setCompletingPracticeId(id);
      try {
        const res = await apiFetch("/api/practice-blocks/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        if (res.status === 401) {
          onSignedOut();
          return;
        }
        if (!res.ok) throw new Error("Could not mark that complete.");
        const data = (await res.json().catch(() => ({}))) as { block?: PracticeItem };
        setPractice((current) =>
          current.map((block) => (block.id === id && data.block ? { ...block, ...data.block } : block)),
        );
      } catch {
        // The list still reflects the last successful load; a retry from the
        // same button is the simplest recovery here.
      } finally {
        setCompletingPracticeId(null);
      }
    },
    [completingPracticeId, onSignedOut],
  );

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

  // Videos the coach has sent back that this player has not opened yet.
  // Counted off the full cloud list rather than the missing one: the number is
  // "how much is waiting for you", and that does not change because one of
  // them happens to already be on this phone.
  const unseenReturnCount = useMemo(
    () =>
      cloudVideos.filter(
        (transfer) => transfer.direction === "coach-return" && !transfer.playerSeenAt,
      ).length,
    [cloudVideos],
  );

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
        // Pulling a returned video down is the player acting on it, which is
        // the same gesture the coach's side treats as "seen". Only returns
        // carry a player dot; the call is a no-op on anything else and its
        // failure is deliberately not allowed to fail the download.
        const pulled = cloudVideos.find((transfer) => transfer.savedVideoId === savedVideoId);
        if (pulled?.direction === "coach-return" && !pulled.playerSeenAt) {
          await markClarityCloudReturnSeen(savedVideoId);
        }
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
    [cloudVideos, downloadingIds, refreshCloudVideos, refreshSavedVideos, savedVideoLibrary],
  );

  async function handleSignOut() {
    await signOut();
    onSignedOut();
  }

  const requestAccountDeletion = useCallback(async () => {
    if (isGuest || deletionBusy) return;
    const confirmed = window.confirm(
      "Request deletion of your Clarity Player account and associated personal data? " +
        "Some booking or payment records may be retained where legally required. We will email you when the review is complete.",
    );
    if (!confirmed) return;

    setDeletionBusy(true);
    setDeletionError("");
    setDeletionMessage("");
    try {
      const response = await apiFetch("/api/player/account-deletion", { method: "POST" });
      const data = (await response.json().catch(() => ({}))) as {
        message?: string;
        requestedAt?: string;
        expectedCompletionDays?: number;
      };
      if (response.status === 401) {
        onSignedOut();
        return;
      }
      if (!response.ok) throw new Error(data.message || "Could not submit the deletion request.");
      setDeletionMessage(
        `Request received. We will review it and email you within ${data.expectedCompletionDays || 7} days.`,
      );
    } catch (error) {
      setDeletionError(
        error instanceof Error ? error.message : "Could not submit the deletion request.",
      );
    } finally {
      setDeletionBusy(false);
    }
  }, [deletionBusy, isGuest, onSignedOut]);

  const openCaddy = useCallback(() => {
    if (!caddy?.appUrl) return;
    window.open(caddy.appUrl, "_blank", "noopener,noreferrer");
  }, [caddy]);

  /* Buy something.
   *
   * The price is not sent -- only which item. The server reprices from the
   * catalogue, because a price that came from the browser is a price the
   * browser can change. */
  const buyShopItem = useCallback(async (serviceId: string) => {
    // The native App Store binary is a companion app. Existing entitlements
    // remain usable, but purchase and purchase links belong to the web client.
    if (__CLARITY_NATIVE__) return;
    setBuyingId(serviceId);
    setPurchaseNote("");
    try {
      const response = await apiFetch("/api/player/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceId }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        url?: string;
        message?: string;
        paid?: boolean;
        passes?: PlayerPass[];
        flexibleValueCents?: number;
      };
      if (!response.ok) {
        throw new Error(data?.message || "Could not start that purchase.");
      }
      if (data.paid && Array.isArray(data.passes)) {
        setPasses(data.passes);
        setFlexibleValueCents(Math.max(0, Math.round(Number(data.flexibleValueCents) || 0)));
        setPurchaseNote("Paid with Clarity credit. It is on your account now.");
        setBuyingId("");
        setTab("passes");
        return;
      }
      if (!data.url) throw new Error(data?.message || "Could not start that purchase.");
      // Stripe owns the next screen. Replacing rather than opening a tab keeps
      // the back button meaningful on a phone.
      window.location.assign(data.url);
    } catch (error) {
      setPurchaseNote(
        error instanceof Error ? error.message : "Could not start that purchase.",
      );
      setBuyingId("");
    }
  }, []);

  /* Coming back from Stripe.
   *
   * The session id arrives in the URL. Confirming is a poll and is safe to run
   * repeatedly -- issuing is keyed on that id -- so a refresh mid-purchase
   * cannot buy the credits twice.
   *
   * The URL is cleaned either way: a session id left in the address bar is
   * something a player can bookmark, share, or re-trigger by reloading. */
  useEffect(() => {
    if (__CLARITY_NATIVE__ || isGuest) return;
    const params = new URLSearchParams(window.location.search);
    const purchase = params.get("purchase");
    const reservation = params.get("reservation");
    if (!purchase) return;

    window.history.replaceState(window.history.state, "", window.location.pathname);
    if (purchase === "cancelled") {
      setPurchaseNote("Purchase cancelled — nothing was charged.");
      if (reservation) {
        void apiFetch("/api/player/checkout/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transactionId: reservation }),
        }).then(() => loadProfile()).catch(() => null);
      }
      return;
    }

    let cancelled = false;
    void (async () => {
      setPurchaseNote("Finishing your purchase…");
      try {
        const response = await apiFetch("/api/player/checkout/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: purchase }),
        });
        const data = (await response.json().catch(() => ({}))) as {
          ok?: boolean;
          status?: string;
          message?: string;
          passes?: PlayerPass[];
        };
        if (cancelled) return;
        if (data.ok && Array.isArray(data.passes)) {
          setPasses(data.passes);
          // They were half-way through a review when they went to pay. The
          // credit is theirs now either way, so a draft that did not survive
          // costs the typing and nothing else.
          const draft = takeReviewDraft();
          if (draft) {
            setPurchaseNote("Paid. Sending your review…");
            await loadProfile();
            await submitReview(
              { notes: draft.notes, savedVideoId: draft.savedVideoId },
              "",
            );
            return;
          }
          setPurchaseNote("Paid. It is on your account now.");
          setTab("passes");
          return;
        }
        setPurchaseNote(
          data.message ||
            (data.status === "pending"
              ? "Your payment is still going through. Give it a moment and refresh."
              : "We could not confirm that purchase. Your coach can sort it out."),
        );
      } catch {
        if (!cancelled) {
          setPurchaseNote("We could not confirm that purchase. Your coach can sort it out.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isGuest]);

  useEffect(() => {
    // Only matters while the choice is "system", but the listener is cheap and
    // unconditional avoids re-subscribing every time the theme changes.
    let query: MediaQueryList;
    try {
      query = window.matchMedia("(prefers-color-scheme: dark)");
    } catch {
      return;
    }
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const shownTheme = effectiveTheme(theme, prefersDark);

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next = togglePortalTheme(current, prefersDark);
      writePortalTheme(next);
      return next;
    });
  }, [prefersDark]);

  const navigateTerminal = useCallback((destination: PlayerTerminalDestination) => {
    setRecording(false);
    setOpenVideoId("");
    // Leaving Reviews shuts the review that was open, so coming back lands on
    // the list rather than mid-way inside whatever was read last.
    setOpenReviewId("");
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

  /* Send a swing review, paid for with a credit.
   *
   * Three things have to happen and only the first is this app's own: the
   * booking and its deadline, the credit, and the note all land server-side in
   * one request. The video follows separately, because bytes do not belong in
   * a JSON route -- and it is stamped with the review's lesson id first, which
   * is the whole reason the coach's swing review screen shows the video and
   * the note as one sitting rather than two unrelated arrivals.
   *
   * The upload is deliberately not awaited before the screen closes. It can
   * take minutes on a bay's wifi, and the request itself is already safely
   * recorded; the Videos shelf shows the progress, as it does for any other
   * send. */
  const submitReview = useCallback(
    async (draft: SwingReviewDraft, passId: string) => {
      setReviewBusy(true);
      setReviewError("");
      try {
        const response = await apiFetch("/api/player/reviews", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            notes: draft.notes,
            hasVideo: Boolean(draft.savedVideoId),
            passId,
          }),
        });
        const data = (await response.json().catch(() => ({}))) as {
          ok?: boolean;
          message?: string;
          lessonId?: string;
        };
        if (!response.ok || !data.ok) {
          throw new Error(data?.message || "Could not send that review.");
        }

        if (draft.savedVideoId && savedVideoLibrary && data.lessonId) {
          try {
            const item = await savedVideoLibrary.getItem(draft.savedVideoId);
            if (item) {
              await savedVideoLibrary.putItem({ ...item, lessonId: data.lessonId });
              await refreshSavedVideos();
            }
          } catch {
            // The review still stands without the link; it just arrives as a
            // note and a loose video rather than as one sitting.
          }
          void sendToCoach(draft.savedVideoId);
        }

        setReviewFlowOpen(false);
        setPurchaseNote("Sent. Your coach has it.");
        await loadProfile();
        setTab("reviews");
      } catch (error) {
        setReviewError(
          error instanceof Error ? error.message : "Could not send that review.",
        );
      } finally {
        setReviewBusy(false);
      }
    },
    [loadProfile, refreshSavedVideos, savedVideoLibrary, sendToCoach],
  );

  /* Buy a review when they hold no credit.
   *
   * Deliberately the same checkout as anything else on the shelf: paying for a
   * review buys a review credit, and the credit is then spent on the request.
   * One payment path, one notion of paid, and a purchase that survives a
   * dropped connection as a credit they still own.
   *
   * The draft is stashed first because Stripe takes the page. */
  const buyReview = useCallback(
    async (draft: SwingReviewDraft) => {
      if (!reviewOffer) return;
      stashReviewDraft(draft);
      await buyShopItem(reviewOffer.serviceId);
    },
    [buyShopItem, reviewOffer],
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

  /* Swing reviews, assembled out of the four lists that are already on this
     screen. Nothing is fetched for them: a review is a lesson id stamped on
     notes, videos and practice the portal has anyway, so this is a regrouping
     of what is here rather than a new source of truth. See swingReviews.ts. */
  const swingReviews = useMemo(
    () => (isGuest ? [] : groupSwingReviews({ savedVideos, cloudVideos, notes, practice })),
    [cloudVideos, isGuest, notes, practice, savedVideos],
  );

  /* A review holding a returned video the player has not opened. Counted off
     the reviews rather than the raw transfer list so the dot on the Reviews
     card and the reviews themselves can never disagree. */
  const unseenReviewCount = useMemo(
    () => swingReviews.filter((review) => review.unseen).length,
    [swingReviews],
  );

  /* Credits they can actually spend right now. Scheduled and exhausted passes
     are still shown -- see the Lessons tab -- but neither is an answer to "can
     I book without paying", so neither counts here. */
  const spendableCredits = useMemo(
    () =>
      passes
        .filter((pass) => pass.status === "active")
        .reduce((sum, pass) => sum + pass.creditsAvailable, 0),
    [passes],
  );

  /* The soonest any spendable credit goes off. Worth surfacing on its own
     because it is the one fact about a pass that costs the player money to
     ignore, and it is not visible from the balance. */
  const nextPassExpiry = useMemo(
    () =>
      passes
        .filter((pass) => pass.status === "active" && pass.creditsAvailable > 0 && pass.expiresAt)
        .map((pass) => pass.expiresAt as string)
        .sort()
        .at(0) || "",
    [passes],
  );

  /* The one line the home screen leads with. Derived from what is already
     loaded -- see recentActivity.ts -- rather than from a feed nothing writes. */
  const activityFeed = useMemo(
    () =>
      isGuest
        ? []
        : recentActivityList({
            unseenReturns: unseenReturnCount,
            newestReturnAt:
              cloudVideos.find((transfer) => transfer.direction === "coach-return")?.readyToImportAt || "",
            practice,
            notes,
            passes: passes.map((pass) => ({
              name: pass.name,
              issuedAt: pass.issuedAt,
              creditsAvailable: pass.creditsAvailable,
            })),
          }),
    [cloudVideos, isGuest, notes, passes, practice, unseenReturnCount],
  );

  /** What's outstanding -- the portal's Practice landing view leads with this. */
  const activePractice = useMemo(() => practice.filter((block) => block.status === "active"), [practice]);

  /**
   * The one block the player has opened off the wall. Nothing is expanded by
   * default: the wall is the view, and a brick is a thing you choose to read.
   */
  const practiceTypes = useMemo(() => practiceTypeList(practiceBlockTypes), [practiceBlockTypes]);

  const openPracticeBlock = useMemo(
    () => practice.find((block) => block.id === expandedPracticeId) || null,
    [expandedPracticeId, practice],
  );

  // Reviews are pulled out of the lesson list entirely. "Next lesson" has to
  // mean a time to be somewhere; a review that happens to be due sooner than
  // the next lesson would otherwise take that card and tell the player to turn
  // up to nothing.
  const upcomingLessons = useMemo(() => upcomingBookings.filter((b) => !isReviewBooking(b)), [upcomingBookings]);
  const upcomingReviews = useMemo(() => upcomingBookings.filter(isReviewBooking), [upcomingBookings]);
  const nextLesson = upcomingLessons[0] || null;
  const laterLessons = upcomingLessons.slice(1);

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

  // The outside booking tab can go away under the player -- the coach clears
  // the URL, or a reload lands before the profile does. Either way, sitting on
  // a tab with no link in the bar and nothing in it is worse than being home.
  useEffect(() => {
    if (tab === "book" && !bookingEmbed) setTab("home");
    // Reviews come from a coach, so a guest has no link to it in the bar. A
    // deep link or a stale tab could still land on it; home is the honest
    // answer rather than an empty screen with no way out of it.
    if (tab === "reviews" && isGuest) setTab("home");
  }, [bookingEmbed, isGuest, tab]);

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
      externalBooking={bookingEmbed ? { label: bookingEmbed.label } : null}
      theme={shownTheme}
      onToggleTheme={toggleTheme}
      balance={isGuest || !spendableCredits ? null : { credits: spendableCredits }}
      onOpenBalance={() => navigateTerminal("passes")}
    />
  );

  /**
   * What is open over the tab, bottom of the stack first.
   *
   * The video studio counts: it takes the whole screen and the player got
   * there from a tab, so Back belongs to it before it belongs to the tab bar.
   * The accordions in the lists -- an expanded booking, review, or practice
   * block -- deliberately do not: they are disclosure inside a page, and
   * giving each one a history entry would turn Back into an undo button for
   * scrolling.
   */
  const backLayers: { id: string; close: () => void }[] = [];
  // Already leaving counts as closed. The studio stays mounted for the slide
  // out, but a layer that lingers past its own close would read as a second
  // thing to dismiss, and Back would eat an extra entry when the teardown
  // finally ran.
  if ((recording || openVideoId) && !leavingWorkspace) {
    backLayers.push({ id: "video-studio", close: () => closeWorkspace() });
  }
  if (reviewFlowOpen && reviewOffer) {
    backLayers.push({
      id: "review-flow",
      close: () => {
        setReviewFlowOpen(false);
        setReviewError("");
      },
    });
  }
  if (guestSheetVideoId) backLayers.push({ id: "guest-sheet", close: () => setGuestSheetVideoId("") });
  const backLayerIds = backLayers.map((layer) => layer.id);

  // Browser Back steps back through what the player has actually opened --
  // closing the studio or a sheet first, then walking back through the tabs --
  // rather than leaving the portal.
  //
  // Layers are recorded by name, not by content, so Back closes one but
  // Forward does not reopen it: the video the studio was on is not carried in
  // the entry. A Forward onto such an entry rewrites it instead.
  //
  // A tab can also stop existing while the player is in the portal -- the coach
  // clears the booking URL, or a sign-out turns them into a guest -- and the
  // effects above bounce them home when that happens. Back onto such a tab is
  // refused here instead, so the hook rewrites the stale entry rather than the
  // bounce pushing a fresh one: otherwise the next Back would land on the same
  // dead tab again and Back would look broken.
  useBackNavigation({
    depth: (snapshot) => snapshot.layers.length,
    state: { tab, lessonsSubtab, layers: backLayerIds },
    restore: (snapshot) => {
      const wanted = new Set(snapshot.layers);
      // Topmost first: the guest sheet goes before the screen underneath it.
      for (let index = backLayers.length - 1; index >= 0; index -= 1) {
        if (!wanted.has(backLayers[index].id)) backLayers[index].close();
      }
      // Leaving the studio lands on Videos, wherever it was opened from --
      // that is what its own Back button does, and the two should not disagree
      // about where Back goes. Its teardown sets the tab, so this leaves it be.
      if (backLayers.some((layer) => layer.id === "video-studio") && !wanted.has("video-studio")) return;
      if (snapshot.tab === "book" && !bookingEmbed) return;
      if (isGuest && (snapshot.tab === "reviews" || snapshot.tab === "lessons" || snapshot.tab === "practice")) return;
      setTab(snapshot.tab);
      setLessonsSubtab(snapshot.lessonsSubtab);
    },
  });

  if (recording || openVideoId) {
    return (
      <div className="player-terminal" data-portal-theme={portalThemeAttribute(theme)}>
        {renderNav(null, { label: "Videos", onBack: () => closeWorkspace() })}
        <div
          className={`player-portal player-portal-video-host${leavingWorkspace ? " is-leaving" : ""}`}
        >
          <Suspense fallback={<Loading size="panel" what="video" className="player-portal-card" />}>
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
    <div className="player-terminal" data-portal-theme={portalThemeAttribute(theme)}>
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
        <div
          className={`player-portal-card${
            tab === "home" && !isGuest && !reviewFlowOpen ? " is-wide" : ""
          }`}
        >
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

          {purchaseNote && (
            <p className="player-portal-purchase-note" role="status">
              {purchaseNote}
            </p>
          )}

          {reviewFlowOpen && reviewOffer ? (
            <SwingReviewFlow
              review={reviewOffer}
              savedVideos={savedVideos}
              busy={reviewBusy}
              error={reviewError}
              onRecord={startRecording}
              onRedeem={(draft, passId) => void submitReview(draft, passId)}
              onBuy={(draft) => void buyReview(draft)}
              onCancel={() => {
                setReviewFlowOpen(false);
                setReviewError("");
              }}
            />
          ) : profileError ? (
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
                  {/* Home, per the Player Portal v2 layout.
                      One hero and three panels: what is next, what has
                      happened, what to practise, what is on the phone. Each
                      panel is a preview of its tab rather than a summary of
                      it -- a count tells a player nothing they can act on,
                      and the wall and the tiles are recognisable at a glance.

                      Two columns on a wide screen, one on a phone, by wrapping
                      rather than by a breakpoint: the panels have a natural
                      minimum and the layout follows it. */}
                  {!isGuest && (
                    <div className="player-portal-dashboard">
                      <button
                        type="button"
                        className="player-portal-next-up"
                        onClick={() => navigateTerminal("lessons")}
                      >
                        <span className="player-portal-next-up-main">
                          <span className="player-portal-dash-label">Next up</span>
                          <strong>
                            {profileLoading && !bookings.length
                              ? "Loading…"
                              : nextLesson
                                ? nextLesson.serviceName || "Lesson"
                                : "Nothing booked"}
                          </strong>
                        </span>
                        <span className="player-portal-next-up-when">
                          <span>
                            {nextLesson
                              ? formatBookingWhen(nextLesson)
                              : "Book a lesson or a swing review"}
                          </span>
                          {nextLesson?.location?.name && <em>{nextLesson.location.name}</em>}
                        </span>
                      </button>

                      <div className="player-portal-panels">
                        <div className="player-portal-panel-column">
                          <section className="player-portal-panel">
                            <div className="player-portal-panel-head">
                              <h2>Practice</h2>
                              <span>
                                {activePractice.length
                                  ? `${activePractice.length} to work on`
                                  : "Nothing set"}
                              </span>
                            </div>
                            {practice.length ? (
                              <PracticeWall
                                blocks={practice}
                                types={practiceTypes}
                                openId={null}
                                onOpen={() => navigateTerminal("practice")}
                                emptyNote=""
                              />
                            ) : (
                              <p className="player-portal-empty">
                                Your coach adds these after a lesson.
                              </p>
                            )}
                            <button
                              className="player-portal-panel-more"
                              type="button"
                              onClick={() => navigateTerminal("practice")}
                            >
                              Open Practice
                            </button>
                          </section>

                          <section className="player-portal-panel">
                            <div className="player-portal-panel-head">
                              <h2>Videos</h2>
                              <span>
                                {[
                                  savedVideos.length
                                    ? `${savedVideos.length} on this device`
                                    : "",
                                  missingCloudVideos.length
                                    ? `${missingCloudVideos.length} to download`
                                    : "",
                                ]
                                  .filter(Boolean)
                                  .join(" · ") || "Nothing yet"}
                              </span>
                            </div>
                            {savedVideos.length || missingCloudVideos.length ? (
                              <div className="player-portal-video-preview">
                                {savedVideos.slice(0, 3).map((video) => (
                                  <button
                                    type="button"
                                    key={video.savedVideoId}
                                    onClick={() => setOpenVideoId(video.savedVideoId)}
                                  >
                                    <span className="player-portal-video-preview-media">
                                      {video.thumbnailDataUrl && (
                                        <img src={video.thumbnailDataUrl} alt="" />
                                      )}
                                    </span>
                                    <strong>{video.title}</strong>
                                    <small>{formatDate(video.capturedAt || video.createdAt)}</small>
                                  </button>
                                ))}
                                {/* A dashed tile is one still in the cloud --
                                    the same language the Videos shelf uses for
                                    the same thing. */}
                                {missingCloudVideos.slice(0, 1).map((transfer) => (
                                  <button
                                    type="button"
                                    key={transfer.savedVideoId}
                                    onClick={() => navigateTerminal("videos")}
                                  >
                                    <span className="player-portal-video-preview-media is-cloud" />
                                    <strong>{transfer.savedVideo?.title || "From your coach"}</strong>
                                    <small>Tap to download</small>
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <p className="player-portal-empty">Film a swing to get started.</p>
                            )}
                            <button
                              className="player-portal-panel-more"
                              type="button"
                              onClick={() => navigateTerminal("videos")}
                            >
                              Open Videos
                            </button>
                          </section>
                        </div>

                        <section className="player-portal-panel">
                          <div className="player-portal-panel-head">
                            <h2>Recent activity</h2>
                            <span>
                              {unseenReturnCount ? `${unseenReturnCount} new` : "Up to date"}
                            </span>
                          </div>
                          {activityFeed.length ? (
                            <div className="player-portal-activity">
                              {activityFeed.map((item) => (
                                <button
                                  type="button"
                                  key={`${item.tab}-${item.label}`}
                                  className={item.unseen ? "is-unseen" : ""}
                                  onClick={() => navigateTerminal(item.tab)}
                                >
                                  <span className="player-portal-activity-main">
                                    <span className="player-portal-activity-dot" aria-hidden="true" />
                                    <span>
                                      <strong>{item.label}</strong>
                                      <small>{ACTIVITY_TAB_LABELS[item.tab]}</small>
                                    </span>
                                  </span>
                                  <span className="player-portal-activity-at">
                                    {formatDate(item.at)}
                                  </span>
                                </button>
                              ))}
                            </div>
                          ) : (
                            <p className="player-portal-empty">
                              Nothing yet. Send your coach a swing and it will show up here.
                            </p>
                          )}
                        </section>
                      </div>
                    </div>
                  )}

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
                        {/* Only for a player who actually holds one. A card
                            reading "no passes" is clutter on every home screen
                            in the business for the sake of the few who buy
                            them. */}
                        {passes.length > 0 && (
                          <button
                            type="button"
                            className="player-portal-home-card"
                            onClick={() => navigateTerminal("lessons")}
                          >
                            <span className="player-portal-home-card-title">Your passes</span>
                            <span className="player-portal-home-card-sub">
                              {spendableCredits
                                ? `${spendableCredits} lesson${spendableCredits === 1 ? "" : "s"} left`
                                : "None left to use"}
                            </span>
                          </button>
                        )}
                        <button
                          type="button"
                          className="player-portal-home-card"
                          onClick={() => navigateTerminal("reviews")}
                        >
                          <span className="player-portal-home-card-title">Swing reviews</span>
                          <span className="player-portal-home-card-sub">
                            {(profileLoading || cloudLoading) && !swingReviews.length
                              ? "Loading\u2026"
                              : unseenReviewCount
                                ? `${unseenReviewCount} new from your coach`
                                : swingReviews.length
                                  ? formatDate(swingReviews[0].at)
                                    ? `Last one ${formatDate(swingReviews[0].at)}`
                                    : `${swingReviews.length} review${swingReviews.length === 1 ? "" : "s"}`
                                  : "Nothing reviewed yet"}
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
                              : activePractice.length
                                ? `${activePractice.length} thing${activePractice.length === 1 ? "" : "s"} to work on`
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
                            {unseenReturnCount
                              ? `${unseenReturnCount} new from your coach`
                              : missingCloudVideos.length
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
                      <Loading what="your lessons" className="player-portal-empty" />
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

                  {/* Reviews sit above the booking tabs, not inside them. A
                      player who has sent a swing and is waiting on it wants one
                      answer -- when -- and it is not on the same axis as
                      "which lesson shall I book". */}
                  {upcomingReviews.length > 0 && (
                    <section className="player-portal-section">
                      <h2>Video reviews</h2>
                      <ul className="player-portal-list">
                        {upcomingReviews.map((review) => (
                          <li key={review.id}>
                            <strong>{review.serviceName || "Video review"}</strong>
                            <span>{formatBookingWhen(review)}</span>
                            <em>Send your swing from Videos if you have not already.</em>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}

                  <div className="player-portal-pill-toggle" role="tablist" aria-label="Lessons view">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={lessonsSubtab === "book"}
                      className={lessonsSubtab === "book" ? "active" : ""}
                      onClick={() => setLessonsSubtab("book")}
                    >
                      Book now
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={lessonsSubtab === "upcoming"}
                      className={lessonsSubtab === "upcoming" ? "active" : ""}
                      onClick={() => setLessonsSubtab("upcoming")}
                    >
                      Past bookings
                    </button>
                  </div>

                  {lessonsSubtab === "book" ? (
                    <>
                      {/* Two ways to book the same coach's time, so they are one
                          control rather than two places. In person is the
                          default because it is what most people came for; the
                          review is the same pathway as the Reviews tab's hero,
                          not a second version of it. */}
                      {reviewOffer && (
                        <div
                          className="player-portal-pill-toggle is-inner"
                          role="tablist"
                          aria-label="What to book"
                        >
                          <button
                            type="button"
                            role="tab"
                            aria-selected={bookMode === "in-person"}
                            className={bookMode === "in-person" ? "active" : ""}
                            onClick={() => setBookMode("in-person")}
                          >
                            In person
                          </button>
                          <button
                            type="button"
                            role="tab"
                            aria-selected={bookMode === "review"}
                            className={bookMode === "review" ? "active" : ""}
                            onClick={() => setBookMode("review")}
                          >
                            Swing review
                          </button>
                        </div>
                      )}

                      {bookMode === "review" && reviewOffer ? (
                        <section className="player-portal-section player-portal-review-hero">
                          <h2>Swing review</h2>
                          <p className="player-portal-lead">
                            Send a swing or a question — no time to turn up to. Back with you
                            within {reviewOffer.turnaroundDays} day
                            {reviewOffer.turnaroundDays === 1 ? "" : "s"}.
                          </p>
                          <button
                            className="player-portal-primary"
                            type="button"
                            onClick={() => {
                              setReviewError("");
                              setReviewFlowOpen(true);
                            }}
                          >
                            Start a swing review
                          </button>
                        </section>
                      ) : (
                        <div className="player-portal-inline-booking">
                          <Suspense fallback={<Loading what="booking" className="player-portal-empty" />}>
                            <BookingWidget
                              customer={{ name: playerName, email: playerEmail, phone: playerPhone }}
                              onBookingComplete={() => void loadProfile()}
                            />
                          </Suspense>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      {laterLessons.length > 0 && (
                        <section className="player-portal-section">
                          <h2>Still to come</h2>
                          <ul className="player-portal-list">{laterLessons.map(renderBooking)}</ul>
                        </section>
                      )}

                      {/* The record, newest first, each one opening to
                          everything known about it. A flat list that shows only
                          a name and a date makes a player ask their coach what
                          a lesson was; the detail is already here. */}
                      {pastBookings.length > 0 && (
                        <section className="player-portal-section">
                          <h2>Past bookings</h2>
                          <ul className="player-portal-list">
                            {pastBookings.map((booking) => {
                              const open = booking.id === openBookingId;
                              const review = isReviewBooking(booking);
                              return (
                                <li
                                  className={`player-portal-history${open ? " is-open" : ""}`}
                                  key={booking.id}
                                >
                                  <button
                                    type="button"
                                    className="player-portal-history-toggle"
                                    aria-expanded={open}
                                    onClick={() => setOpenBookingId(open ? "" : booking.id)}
                                  >
                                    <span className="player-portal-history-head">
                                      <strong>{booking.serviceName || "Lesson"}</strong>
                                      <span>{formatBookingWhen(booking)}</span>
                                    </span>
                                    <span aria-hidden="true">{open ? "\u2013" : "+"}</span>
                                  </button>
                                  {open && (
                                    <div className="player-portal-history-body">
                                      {review && (
                                        <span className="player-portal-history-fact">
                                          Swing review — no time to turn up to
                                        </span>
                                      )}
                                      {booking.location?.name && (
                                        <span className="player-portal-history-fact">
                                          {booking.location.name}
                                        </span>
                                      )}
                                      {booking.client && (
                                        <span className="player-portal-history-fact">
                                          Booked as {booking.client}
                                        </span>
                                      )}
                                      {/* Notes taken against this booking.
                                          Matched on the id the note carries,
                                          not on the day -- two lessons in one
                                          afternoon would otherwise each show
                                          the other's notes. */}
                                      {sortedNotes
                                        .filter((note) => note.calendarItemId === booking.id)
                                        .map((note) => (
                                          <div className="player-portal-history-note" key={note.id}>
                                            <strong>{note.title || "Lesson note"}</strong>
                                            {note.body && <p>{note.body}</p>}
                                          </div>
                                        ))}
                                    </div>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        </section>
                      )}

                      {!laterLessons.length && !pastBookings.length && !profileLoading && (
                        <p className="player-portal-empty">No bookings yet.</p>
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

              {tab === "book" && bookingEmbed && <PlayerBookingEmbed config={bookingEmbed} />}

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

              {tab === "reviews" && !isGuest && (
                <>
                  {/* The hero is asking for a new one, not reading old ones.
                      A player opens this tab far more often to send a swing
                      than to re-read a review from three weeks ago, so the
                      history sits underneath rather than in front. */}
                  {reviewOffer && (
                    <section className="player-portal-section player-portal-review-hero">
                      <h2>New swing review</h2>
                      <p className="player-portal-lead">
                        Send a swing or a question. Back with you within{" "}
                        {reviewOffer.turnaroundDays} day
                        {reviewOffer.turnaroundDays === 1 ? "" : "s"}.
                      </p>
                      <button
                        className="player-portal-primary"
                        type="button"
                        onClick={() => {
                          setReviewError("");
                          setReviewFlowOpen(true);
                        }}
                      >
                        Start a swing review
                      </button>
                      <p className="player-portal-empty">
                        {reviewOffer.passOptions.length
                          ? `${reviewOffer.passOptions[0].creditsAvailable} credit${
                              reviewOffer.passOptions[0].creditsAvailable === 1 ? "" : "s"
                            } ready to use`
                          : !__CLARITY_NATIVE__ && reviewOffer.canBuy
                            ? `${reviewOffer.currency} ${reviewOffer.price.toFixed(2)} each`
                            : "No review credit available"}
                      </p>
                    </section>
                  )}

                <section className="player-portal-section">
                  <h2>Past reviews</h2>
                  {/* One sitting with the coach, kept whole: the videos they
                      worked on, the screenshots they marked up, what they wrote
                      and what they set you to practise. The same pieces are
                      each reachable on their own tab -- this is the only place
                      they are back together. */}
                  <p className="player-portal-lead">
                    {swingReviews.length
                      ? "Everything from one sitting with your coach, kept together."
                      : "When your coach reviews your swing, the whole sitting lands here."}
                  </p>

                  {(profileLoading || cloudLoading) && !swingReviews.length ? (
                    <Loading what="your swing reviews" className="player-portal-empty" />
                  ) : swingReviews.length ? (
                    <ul className="player-portal-list">
                      {swingReviews.map((review) => {
                        const expanded = review.id === openReviewId;
                        return (
                          <li
                            className={`player-portal-review${expanded ? " is-expanded" : ""}${
                              review.unseen ? " is-unseen" : ""
                            }`}
                            key={review.id}
                          >
                            <button
                              type="button"
                              className="player-portal-review-toggle"
                              aria-expanded={expanded}
                              onClick={() => setOpenReviewId(expanded ? "" : review.id)}
                            >
                              <span className="player-portal-review-head">
                                <strong>
                                  Swing review
                                  {review.unseen && (
                                    <span
                                      className="player-portal-review-dot"
                                      aria-label="Not opened yet"
                                    />
                                  )}
                                </strong>
                                <span>
                                  {[
                                    formatDate(review.at),
                                    `${review.itemCount} item${review.itemCount === 1 ? "" : "s"}`,
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </span>
                              </span>
                              <span aria-hidden="true">{expanded ? "\u2013" : "+"}</span>
                            </button>

                            {expanded && (
                              <div className="player-portal-review-body">
                                {review.coachMessage && (
                                  <p className="player-portal-review-message">
                                    {review.coachMessage}
                                  </p>
                                )}

                                {review.videos.map((video) => (
                                  <button
                                    type="button"
                                    className="player-portal-review-video"
                                    key={video.savedVideoId}
                                    onClick={() => setOpenVideoId(video.savedVideoId)}
                                  >
                                    {video.thumbnailDataUrl ? (
                                      <img src={video.thumbnailDataUrl} alt="" />
                                    ) : (
                                      <span className="player-portal-review-video-blank" />
                                    )}
                                    <span>
                                      <strong>{video.title}</strong>
                                      <small>Watch</small>
                                    </span>
                                  </button>
                                ))}

                                {/* In the cloud, not on this phone. Pulling it
                                    down is also what clears its dot -- the same
                                    gesture the Videos shelf treats as seen. */}
                                {review.cloudVideos.map((transfer) => (
                                  <button
                                    type="button"
                                    className="player-portal-review-video is-cloud"
                                    key={transfer.savedVideoId}
                                    disabled={downloadingIds.has(transfer.savedVideoId)}
                                    onClick={() => void downloadFromCloud(transfer.savedVideoId)}
                                  >
                                    <span className="player-portal-review-video-blank" />
                                    <span>
                                      <strong>{transfer.savedVideo?.title || "Video"}</strong>
                                      <small>
                                        {downloadingIds.has(transfer.savedVideoId)
                                          ? "Downloading\u2026"
                                          : "Download to watch"}
                                      </small>
                                    </span>
                                  </button>
                                ))}

                                {/* A screenshot the coach marked up. The picture
                                    is stripped on upload, so one that came over
                                    the cloud arrives as its words and the second
                                    it was taken at -- which the video above can
                                    still be wound to. */}
                                {review.screenshots.length > 0 && (
                                  <ul className="player-portal-review-shots">
                                    {review.screenshots.map((shot) => (
                                      <li key={`${shot.savedVideoId}-${shot.id}`}>
                                        {shot.imageDataUrl ? (
                                          <img src={shot.imageDataUrl} alt={shot.title} />
                                        ) : (
                                          <span className="player-portal-review-shot-time">
                                            {formatClock(shot.currentTime)}
                                          </span>
                                        )}
                                        <div>
                                          <strong>{shot.title}</strong>
                                          {shot.note && <p>{shot.note}</p>}
                                        </div>
                                      </li>
                                    ))}
                                  </ul>
                                )}

                                {review.analysisNotes.map((note) => (
                                  <div className="player-portal-review-note" key={note.id}>
                                    <strong>{formatClock(note.time)}</strong>
                                    <p>{note.text}</p>
                                  </div>
                                ))}

                                {review.notes.map((note) => (
                                  <div className="player-portal-review-note" key={note.id}>
                                    <strong>{note.title || "Lesson note"}</strong>
                                    {note.body && <p>{note.body}</p>}
                                  </div>
                                ))}

                                {/* Practice set out of this review. It lives on
                                    the Practice wall -- this is a way in, not a
                                    second copy, so completing it stays in the
                                    one place that can. */}
                                {review.practice.map((block) => (
                                  <button
                                    type="button"
                                    className="player-portal-review-note is-practice"
                                    key={block.id}
                                    onClick={() => {
                                      setExpandedPracticeId(block.id);
                                      navigateTerminal("practice");
                                    }}
                                  >
                                    <strong>{block.title}</strong>
                                    <small>Open on your practice wall</small>
                                  </button>
                                ))}

                                {review.itemCount === 0 && (
                                  <p className="player-portal-empty">
                                    Your coach has started this one. Nothing in it yet.
                                  </p>
                                )}
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="player-portal-empty">No swing reviews yet.</p>
                  )}
                </section>
                </>
              )}

              {tab === "passes" && !isGuest && (
                <>
                  {/* What they hold and what they can get, on one screen.
                      They are the same subject -- "what am I able to book" --
                      and the question is asked in both directions at once. */}
                  {/* Passes sit above the booking toggle for the same reason
                      the reviews do: "how many have I got left" is the question
                      a player asks immediately before booking, and answering it
                      after they have picked a slot is answering it too late.

                      Everything is shown, not just what is spendable. A pass
                      that has run out or timed out is the answer to "why can't
                      I book on my pass" -- hiding it turns that into a message
                      to the coach. */}
                  {(passes.length > 0 || flexibleValueCents > 0) && (
                    <section className="player-portal-section">
                      <h2>Your passes</h2>
                      {flexibleValueCents > 0 && (
                        <p className="player-portal-lead">
                          +{passCurrency} {(flexibleValueCents / 100).toFixed(2)} Clarity credit
                        </p>
                      )}
                      {spendableCredits > 0 && (
                        <p className="player-portal-lead">
                          {spendableCredits === 1
                            ? "1 lesson paid for and ready to book."
                            : `${spendableCredits} lessons paid for and ready to book.`}
                          {nextPassExpiry && formatDate(nextPassExpiry)
                            ? ` Use them by ${formatDate(nextPassExpiry)}.`
                            : ""}
                        </p>
                      )}
                      <ul className="player-portal-list">
                        {passes.map((pass) => {
                          // The line is "can I book on this right now", not
                          // "is it used up". A pass that has not started yet is
                          // as unbookable as one that ran out, and styling it
                          // like a live balance is the version of this screen
                          // that gets someone turned away at the bay.
                          const spendable = pass.status === "active";
                          return (
                            <li
                              className={`player-portal-pass${spendable ? "" : " is-inactive"}`}
                              key={pass.id}
                            >
                              <div className="player-portal-pass-head">
                                <strong>{pass.name}</strong>
                                <span className="player-portal-pass-count">
                                  {passBalanceLabel(pass)}
                                </span>
                              </div>
                              <span className="player-portal-pass-meta">
                                {[
                                  pass.creditsAllocated
                                    ? `${pass.creditsRedeemed} of ${pass.creditsAllocated} used`
                                    : "",
                                  pass.covers.length ? `Covers ${pass.covers.join(", ")}` : "",
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </span>
                              {pass.expiresAt && formatDate(pass.expiresAt) && (
                                <span className="player-portal-pass-meta">
                                  {pass.status === "expired" ? "Expired" : "Expires"}{" "}
                                  {formatDate(pass.expiresAt)}
                                </span>
                              )}
                              {/* Where the credits went. Dates only: naming the
                                  lesson would mean a join the portal does not
                                  have, and "used on these days" is enough to
                                  settle a disagreement about the balance. */}
                              {pass.history.length > 0 && (
                                <span className="player-portal-pass-meta">
                                  Used{" "}
                                  {pass.history
                                    .map((entry) => formatDate(entry.redeemedAt))
                                    .filter(Boolean)
                                    .slice(0, 4)
                                    .join(", ")}
                                  {pass.history.length > 4 ? "…" : ""}
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  )}

                  {/* What the coach sells, directly above the passes it adds
                      to. Buying and holding are the same subject -- "how many
                      have I got, and can I get more" -- and splitting them
                      across two screens makes the second one hard to find.

                      Absent entirely when the business has not set up card
                      payments: the server sends an empty shop, and a "Buy"
                      button that cannot take money is worse than no button. */}
                  {!__CLARITY_NATIVE__ && shop.length > 0 && (
                    <section className="player-portal-section">
                      <h2>{passes.length ? "Buy more" : "Buy lessons or a review"}</h2>
                      <p className="player-portal-lead">
                        Paid for here, straight onto your account. Book it whenever you like.
                      </p>
                      <ul className="player-portal-list">
                        {shop.map((item) => (
                          <li className="player-portal-shop-item" key={item.serviceId}>
                            <div className="player-portal-shop-main">
                              <strong>{item.name}</strong>
                              <span>
                                {item.credits === 1
                                  ? "1 credit"
                                  : `${item.credits} credits`}
                                {item.description ? ` · ${item.description}` : ""}
                              </span>
                            </div>
                            <button
                              className="player-portal-primary player-portal-shop-buy"
                              type="button"
                              disabled={Boolean(buyingId)}
                              onClick={() => void buyShopItem(item.serviceId)}
                            >
                              {buyingId === item.serviceId
                                ? "Opening…"
                                : `${item.currency} ${item.price.toFixed(2)}`}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}

                  {!passes.length && !shop.length && (
                    <p className="player-portal-empty">
                      Nothing here yet. Passes added to your account show up on this screen.
                    </p>
                  )}
                </>
              )}

              {tab === "practice" && !isGuest && (
                <section className="player-portal-section">
                  <h2>Practice</h2>
                  {/* The wall, not a list. Every block the coach has ever set,
                      oldest at the bottom -- so what a player sees first is how
                      much they have built, and only then what is outstanding. */}
                  <p className="player-portal-lead">
                    {activePractice.length
                      ? `${activePractice.length} thing${activePractice.length === 1 ? "" : "s"} to work on. Tap a block to read it.`
                      : "Everything your coach has set you. Tap a block to read it."}
                  </p>
                  {profileLoading && !practice.length ? (
                    <Loading what="your practice" className="player-portal-empty" />
                  ) : (
                    <>
                      <PracticeWall
                        blocks={practice}
                        types={practiceTypes}
                        openId={expandedPracticeId}
                        onOpen={(id) => setExpandedPracticeId(expandedPracticeId === id ? null : id)}
                        emptyNote="Nothing to practise yet. Your coach will put it here after your next lesson."
                      />

                      {openPracticeBlock && (
                        <div
                          className="practice-detail"
                          data-practice-type={openPracticeBlock.blockType}
                          style={
                            {
                              "--practice-tone": practiceTypeMeta(practiceTypes, openPracticeBlock.blockType).tone,
                            } as CSSProperties
                          }
                        >
                          <div className="practice-detail-head">
                            <div>
                              <span className="practice-detail-kind">
                                {practiceTypeMeta(practiceTypes, openPracticeBlock.blockType).label}
                              </span>
                              <strong>{openPracticeBlock.title}</strong>
                              <span className="practice-detail-meta">
                                {practiceBlockMeta(openPracticeBlock)} · {practiceExpiryLabel(openPracticeBlock)}
                              </span>
                            </div>
                            <button
                              type="button"
                              className="practice-detail-close"
                              title="Close"
                              aria-label="Close"
                              onClick={() => setExpandedPracticeId(null)}
                            >
                              ×
                            </button>
                          </div>

                          <ol>
                            {practiceSteps(openPracticeBlock.content).map((line, index) => (
                              <li key={index}>{line}</li>
                            ))}
                          </ol>

                          <div className="practice-detail-actions">
                            {openPracticeBlock.linkedVideoId && (
                              <button
                                type="button"
                                className="player-portal-practice-video"
                                onClick={() => setOpenVideoId(openPracticeBlock.linkedVideoId as string)}
                              >
                                {practiceVideos.find(
                                  (t) => t.savedVideo?.savedVideoId === openPracticeBlock.linkedVideoId,
                                )?.savedVideo?.title
                                  ? `Watch: ${
                                      practiceVideos.find(
                                        (t) => t.savedVideo?.savedVideoId === openPracticeBlock.linkedVideoId,
                                      )?.savedVideo?.title
                                    }`
                                  : "Watch linked video"}
                              </button>
                            )}
                            {openPracticeBlock.status === "active" ? (
                              <button
                                type="button"
                                className="player-portal-primary"
                                disabled={completingPracticeId === openPracticeBlock.id}
                                onClick={() => void markPracticeComplete(openPracticeBlock.id)}
                              >
                                {completingPracticeId === openPracticeBlock.id ? "Marking complete…" : "Mark Complete"}
                              </button>
                            ) : (
                              <span
                                className={`practice-status-badge practice-status-${openPracticeBlock.status}`}
                              >
                                {openPracticeBlock.status === "completed"
                                  ? openPracticeBlock.completedAt
                                    ? `Completed ${formatDate(openPracticeBlock.completedAt)}`
                                    : "Completed"
                                  : "Expired"}
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </section>
              )}

              {tab === "notes" && !isGuest && (
                <section className="player-portal-section">
                  <h2>Lesson notes</h2>
                  {profileLoading && !notes.length ? (
                    <Loading what="your lesson notes" className="player-portal-empty" />
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

          <footer className="player-portal-legal">
            <nav aria-label="Legal and support">
              <a href={PRIVACY_URL} target="_blank" rel="noreferrer noopener">Privacy Policy</a>
              <a href={SUPPORT_URL} target="_blank" rel="noreferrer noopener">Support</a>
              <a href={TERMS_URL} target="_blank" rel="noreferrer noopener">Terms</a>
              {!isGuest && (
                <button
                  type="button"
                  onClick={() => {
                    setDeletionOpen((current) => !current);
                    setDeletionError("");
                  }}
                  aria-expanded={deletionOpen}
                >
                  Delete account
                </button>
              )}
            </nav>

            {!isGuest && deletionOpen && (
              <section className="player-account-deletion" aria-label="Delete account">
                <strong>Delete your account</strong>
                <p>
                  This requests deletion of your player login and associated personal data. We review
                  booking and payment records before removal because some records may need to be retained
                  by law. Your Clarity Caddy login may use the same identity and will be included in that review.
                </p>
                {deletionMessage ? (
                  <p className="player-account-deletion-success" role="status">{deletionMessage}</p>
                ) : (
                  <button
                    className="player-account-deletion-submit"
                    type="button"
                    disabled={deletionBusy}
                    onClick={() => void requestAccountDeletion()}
                  >
                    {deletionBusy ? "Submitting…" : "Request account deletion"}
                  </button>
                )}
                {deletionError && <p className="player-portal-error-line" role="alert">{deletionError}</p>}
              </section>
            )}
          </footer>
        </div>
      </div>
    </div>
  );
}
