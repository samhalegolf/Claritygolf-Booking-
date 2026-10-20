import type { RetiredVideoEntry } from "../video-analysis/utils/videoLibraryRetirement";
import { VIDEO_THUMBNAIL_PLACEHOLDER } from "../video-analysis/utils/videoThumbnails";
import { useVideoFileDelivery, videoFileName } from "../video-analysis/components/VideoFileDialog";
// The Player Profiles screen: the list of people with notes or video, and the
// tool panel for the selected one (bookings, reviews, emails, transactions,
// passes, portal access, notes, practice, video). Drawn here; the state and
// the handlers it calls still live in App.tsx and arrive as props, so this is
// the view half of the screen. Loaded with the view, not with the shell.
import { t, tn } from "../../lib/i18n";
import { ClarityAssessments, ClarityBookingPages, ClarityCalendar, ClarityEmail, ClarityFilesMedia, ClarityIntegrations, ClarityLessonsProgrammes, ClarityMore, ClarityPassesCredits, ClarityPayments, ClarityProfile, ClarityVideoAnalysis } from "../shared/ClarityIcons";
import { Suspense, lazy } from "react";
import { AnchoredMenu } from "../shared/AnchoredMenu";
import { Loading } from "../shared/Loading";
import { clientMatchesSearchTerm, hasAnyProfileId, preferredVideoPlayerId } from "../clients/clientMatching";
import { AlertTriangle, Archive, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Cloud, CloudOff, CloudUpload, Download, ExternalLink, ImagePlus, LayoutGrid, List, Pause, Pencil, Play, Plus, RefreshCw, Send, Share2, Trash2, X } from "lucide-react";
import { formatMoney } from "../../lib/money";
import { PRIMARY_PLAYER_TOOL_TABS, SECONDARY_PLAYER_TOOLS, SECONDARY_PLAYER_TOOL_TABS, playerToolAllowed } from "./playerTools";
import { notificationKindLabel, notificationStatusLabel } from "../notifications/notificationModel";
import { buildWeekDays, formatRange, formatTime, itemService, itemWeek } from "../calendar/calendarModel";
import { posMethodLabel } from "../billing/terminal";
import { groupSameSwingAngles } from "../video-analysis/utils/sameSwingAngles";
import { getSavedVideoCloudStatusLabel, isClarityCloudOperational } from "../../storageHealth";
import { formatClipDuration, formatTimestampForDisplay, formatVideoDurationLabel, profileRecordTitle, profileWhenParts, savedVideoCloudErrorLabel } from "./profileFormat";
import type { BusinessTerminology } from "../../../netlify/functions/_shared/business-terminology.mts";
import type { MarketCapabilities } from "../../../netlify/functions/_shared/market-profile.mts";
import type { ReviewBlock, ReviewDocument, ReviewDrillBlock } from "../../../netlify/functions/_shared/review-document.mts";
import type { SheetVideo } from "../swing-review/SwingReviewSheet";
import type { FrameViewerShot } from "../shared/SnapshotFrameViewer";
import type { ClarityCloudHealth, GoogleDriveTransferStatus } from "../../storageHealth";
import type { AuthStatus } from "../auth/authStatus";
import type { BillingSection } from "../billing/billingSections";
import type { BillingInvoiceRecord } from "../billing/types";
import type { CalendarItem } from "../calendar/calendarModel";
import type { ClientSummary, ClientTransactionRow } from "../clients/clientMatching";
import type { Person } from "../clients/clientsModel";
import type { NotificationRecord } from "../notifications/notificationModel";
import type { Service } from "../services/serviceModel";
import type { View } from "../shared/appView";
import type { Toast } from "../shared/toast";
import type { FocusSnapshotSourceImageMeta } from "../video-analysis/models/Analysis";
import type { FocusAreaRect } from "../video-analysis/models/Focus";
import type { ComparisonSide } from "../video-analysis/utils/localPersistence";
import type { ClarityCloudImportTransfer, ManagedLocalVideoLibraryStatus, SavedVideoItem } from "../video-analysis/utils/savedVideoLibrary";
import type { StoredVideoRecord } from "../video-analysis/utils/videoBlobStore";
import type { BrandSettings, CoachAccount } from "../workspace/workspaceModel";
import type { LessonNote, LessonNoteSource } from "./lessonNotesModel";
import type { PlayerPracticeSummary, PlayerProfileTool } from "./playerTools";
import type { CaddyStatus, PortalPlayer } from "./portalAccess";
import type { Dispatch, RefObject, SetStateAction } from "react";

const SwingReviewSheet = lazy(() =>
  import("../swing-review/SwingReviewSheet").then((module) => ({ default: module.SwingReviewSheet })),
);
const SnapshotFrameViewer = lazy(() =>
  import("../shared/SnapshotFrameViewer").then((module) => ({ default: module.SnapshotFrameViewer })),
);
const ClarityVoiceTextPanel = lazy(() =>
  import("../clarity-voice/ClarityVoiceTextPanel").then((module) => ({ default: module.ClarityVoiceTextPanel })),
);
// Owns its own loading and its own writes. The console only tells it which
// player it is looking at.
const PracticeBlockPanel = lazy(() =>
  import("../practice/PracticeBlockPanel").then((module) => ({ default: module.PracticeBlockPanel })),
);

/** One clip on the player's video shelf. Declared here, where the shelf is drawn;
 * App.tsx builds the groups and imports the type. */
export type ShelfClip = {
  key: string;
  savedVideoId: string;
  title: string;
  thumbnail: string;
  duration: number;
  at: string;
  kind: "saved" | "submission" | "recovery";
  unseen: boolean;
  playable: boolean;
  /** The same swing from the other camera: shown and opened as one package. */
  partner?: ShelfClip;
};

export type PlayerProfilesScreenProps = {
  notesWorkspaceClient: ClientSummary | null;
  playerProfileTool: PlayerProfileTool;
  playerToolExpanded: boolean;
  terms: BusinessTerminology;
  playerToolTabsExpanded: boolean;
  videoPlayerIds: Set<string>;
  openVideoAnalysisForClient: (client: { id: string; name: string; savedVideoId?: string; pairedSavedVideoId?: string; startRecording?: boolean; lessonId?: string; lessonTitle?: string; initialVideoFile?: File; }) => void;
  playerVideoView: "ledger" | "shelf";
  switchView: (view: View) => void;
  unassignedVideos: { savedVideoId: string; title: string; createdAt: string; }[];
  setToast: Dispatch<SetStateAction<Toast | null>>;
  managedLocalLibraryStatus: ManagedLocalVideoLibraryStatus;
  playerProfilesSourcesReady: { people: boolean; notes: boolean; portal: boolean; videos: boolean; };
  capabilities: MarketCapabilities;
  setPlayerProfileTool: Dispatch<SetStateAction<PlayerProfileTool>>;
  playerToolAppointments: CalendarItem[];
  playerSwingReviewGroups: { id: string; at: string; videos: SavedVideoItem[]; cloudVideos: ClarityCloudImportTransfer[]; notes: LessonNote[]; practice: PlayerPracticeSummary[]; screenshots: { savedVideoId: string; videoTitle: string; id: string; playerId: string; analysisId: string; title: string; note?: string; captureKind?: "frame" | "area"; side: ComparisonSide; sourceVideoId?: string; sourceVideoTitle?: string; sourceVideoMeta?: { fps?: number; duration?: number; width?: number; height?: number; }; sourceImageMeta?: FocusSnapshotSourceImageMeta; currentTime: number; currentFrame: number; cropRect: FocusAreaRect; imageDataUrl: string; imageFileId?: string; createdAt: string; }[]; analysisNotes: { videoTitle: string; id: string; time: number; text: string; createdAt: string; }[]; }[];
  playerPracticeLoadState: "idle" | "loading" | "loaded" | "error";
  reviewDocuments: Record<string, ReviewDocument>;
  sentSwingReviewLink: { id: string; url: string; } | null;
  transactionDateLabel: (value: string) => string;
  portalPlayers: PortalPlayer[];
  playerToolVideos: SavedVideoItem[];
  setPlayerPracticeComposer: Dispatch<SetStateAction<boolean>>;
  activePlayerPracticeBlocks: PlayerPracticeSummary[];
  assigningVideoId: string;
  playerProfiles: ClientSummary[];
  playerProfilesDataReady: boolean;
  selectPlayerProfileTool: (client: Pick<Person, "id" | "name">, tool?: PlayerProfileTool) => void;
  unseenSubmissionCounts: Map<string, number>;
  playerUnseenSubmissions: number;
  playerToolUpcomingCount: number;
  setDrillLibraryOpen: Dispatch<SetStateAction<{ lessonId?: string; index?: number; editId?: string; } | null>>;
  updateReviewDocument: (lessonId: string, playerId: string, next: { title: string; blocks: ReviewBlock[]; }, options?: { immediate?: boolean; }) => void;
  coachAccount: CoachAccount;
  brandSettings: BrandSettings;
  setSnapshotFrameView: Dispatch<SetStateAction<{ reviewId: string; key: string; } | null>>;
  sendingSwingReviewId: string | null;
  snapshotFrameView: { reviewId: string; key: string; } | null;
  playerToolNotifications: NotificationRecord[];
  playerTransactionsLoadState: "idle" | "loading" | "loaded" | "error";
  playerTransactions: ClientTransactionRow[];
  personDeleteBusyId: string;
  notesWorkspaceLessonNotes: LessonNote[];
  playerPracticeExpiringCount: number;
  playerVideoSummary: { total: number; detail: string; };
  setPlayerVideoView: Dispatch<SetStateAction<"ledger" | "shelf">>;
  playerVideoShelfGroups: { key: string; label: string; clips: ShelfClip[]; unseen: number; }[];
  playerToolCloudVideos: ClarityCloudImportTransfer[];
  playerToolLegacyVideoRecords: StoredVideoRecord[];
  clarityCloudHealth: ClarityCloudHealth;
  googleDriveTransfer: GoogleDriveTransferStatus;
  setOpenSavedVideoMenuId: Dispatch<SetStateAction<string | null>>;
  phonePlayerOpen: boolean;
  openPlayerAddDialog: () => void;
  setVideoCameraRequested: Dispatch<SetStateAction<boolean>>;
  setPlayerToolExpanded: Dispatch<SetStateAction<boolean>>;
  lessonNotePlayerIds: Set<string>;
  setPlayerToolTabsExpanded: Dispatch<SetStateAction<boolean>>;
  services: Service[];
  playerToolUpcomingIds: Set<string>;
  setSelectedId: Dispatch<SetStateAction<string>>;
  startSwingReviewForClient: (client: Pick<Person, "id" | "name" | "email" | "phone">) => void;
  openSwingReviewId: string | null;
  setOpenSwingReviewId: Dispatch<SetStateAction<string | null>>;
  reviewDisplayBlocks: (lessonId: string, savedVideoIds: string[]) => ReviewBlock[];
  reviewSaveStates: Record<string, "idle" | "error" | "saving" | "saved">;
  addVideoToReview: (lessonId: string, client: Pick<Person, "id" | "name" | "email" | "phone">, index: number) => void;
  reviewInsertRef: RefObject<{ lessonId: string; index: number; drillBlockId?: string; } | null>;
  reviewLessonTitle: (lessonId: string) => string;
  resolveReviewVideoUrl: (savedVideoId: string, signal?: AbortSignal) => Promise<string | null>;
  billingWorkspaceEnabled: boolean;
  openPosCheckoutForClient: (client: ClientSummary) => void;
  portalPlayerBusyId: string;
  includeCaddyPass: boolean;
  setIncludeCaddyPass: Dispatch<SetStateAction<boolean>>;
  caddyStatuses: Record<string, { status: CaddyStatus; deepLink: string; }>;
  isAdminUser: boolean;
  lessonNoteBusy: boolean;
  playerPracticeComposer: boolean;
  setAuthStatus: (next: AuthStatus) => void;
  playerVideoAnglePairs: Map<string, string>;
  uploadingSavedVideoIds: Set<string>;
  openSavedVideoMenuId: string | null;
  linkedLessonVideoIds: Set<string>;
  clarityCloudImportActionIds: Set<string>;
  refreshCaddyStatus: (personId: string) => Promise<void>;
  runManagedLibraryAction: (action: "choose" | "reconnect" | "move" | "verify" | "rescan" | "migrate") => Promise<void>;
  assignUnassignedVideo: (savedVideoId: string) => Promise<void>;
  makeDrillCopy: (lessonId: string, client: Pick<Person, "id" | "name" | "email" | "phone">, block: ReviewDrillBlock) => Promise<void>;
  discardEmptyReview: (lessonId: string) => Promise<void>;
  sendSwingReviewToPlayer: (review: { id: string; videos: SavedVideoItem[]; notes: unknown[]; practice: unknown[]; }, client: Pick<Person, "id" | "name">) => Promise<void>;
  fetchPlayerTransactions: (personId: string) => Promise<void>;
  openInvoiceForEdit: (record: BillingInvoiceRecord, from?: BillingSection) => Promise<void>;
  grantPortalAccess: (person: Pick<Person, "id" | "name" | "email">) => Promise<void>;
  revokePortalAccess: (portalPlayerId: string, personId: string) => Promise<void>;
  hardDeletePerson: (person: Pick<Person, "id" | "name" | "email">) => Promise<void>;
  saveLessonNoteForClient: (client: Pick<Person, "id" | "name"> | null | undefined, text: string, source?: LessonNoteSource, link?: { lessonId?: string; title?: string; }) => Promise<boolean>;
  deleteLessonNote: (noteId: string) => Promise<void>;
  sendSavedVideoToPrimaryComputer: (item: SavedVideoItem) => Promise<void>;
  sendSavedVideoToPlayer: (item: SavedVideoItem, personId: string) => Promise<void>;
  pauseSavedVideoTransfer: (item: SavedVideoItem) => Promise<void>;
  cancelSavedVideoTransfer: (item: SavedVideoItem) => Promise<void>;
  removeSavedVideoTransfer: (item: SavedVideoItem) => Promise<void>;
  showSavedVideoInFinder: (item: SavedVideoItem) => Promise<void>;
  revealSavedVideoFile: (item: SavedVideoItem) => Promise<void>;
  verifySavedVideoInLibrary: (item: SavedVideoItem) => Promise<void>;
  removeSavedVideoFromDevice: (item: SavedVideoItem) => Promise<void>;
  renameSavedVideo: (item: SavedVideoItem) => Promise<void>;
  deleteSavedVideo: (item: SavedVideoItem) => Promise<void>;
  retireLibraryEntry: (id: string, title: string, playerId: string) => Promise<void>;
  restoreLibraryEntry: (id: string) => Promise<void>;
  retiredLibraryEntries: RetiredVideoEntry[];
  openPlayerSubmissionOrCloudVideo: (transfer: ClarityCloudImportTransfer, playerName: string) => Promise<void>;
  migrateLegacyVideo: (record: StoredVideoRecord) => Promise<void>;
};

export function PlayerProfilesScreen(props: PlayerProfilesScreenProps) {
  const { begin: beginVideoDelivery, warmShare, dialog: videoDeliveryDialog } = useVideoFileDelivery();
  const {
    notesWorkspaceClient,
    playerProfileTool,
    playerToolExpanded,
    terms,
    playerToolTabsExpanded,
    videoPlayerIds,
    openVideoAnalysisForClient,
    playerVideoView,
    switchView,
    unassignedVideos,
    setToast,
    managedLocalLibraryStatus,
    playerProfilesSourcesReady,
    capabilities,
    setPlayerProfileTool,
    playerToolAppointments,
    playerSwingReviewGroups,
    playerPracticeLoadState,
    reviewDocuments,
    sentSwingReviewLink,
    transactionDateLabel,
    portalPlayers,
    playerToolVideos,
    setPlayerPracticeComposer,
    activePlayerPracticeBlocks,
    assigningVideoId,
    playerProfiles,
    playerProfilesDataReady,
    selectPlayerProfileTool,
    unseenSubmissionCounts,
    playerUnseenSubmissions,
    playerToolUpcomingCount,
    setDrillLibraryOpen,
    updateReviewDocument,
    coachAccount,
    brandSettings,
    setSnapshotFrameView,
    sendingSwingReviewId,
    snapshotFrameView,
    playerToolNotifications,
    playerTransactionsLoadState,
    playerTransactions,
    personDeleteBusyId,
    notesWorkspaceLessonNotes,
    playerPracticeExpiringCount,
    playerVideoSummary,
    setPlayerVideoView,
    playerVideoShelfGroups,
    playerToolCloudVideos,
    playerToolLegacyVideoRecords,
    clarityCloudHealth,
    googleDriveTransfer,
    setOpenSavedVideoMenuId,
    phonePlayerOpen,
    openPlayerAddDialog,
    setVideoCameraRequested,
    setPlayerToolExpanded,
    lessonNotePlayerIds,
    setPlayerToolTabsExpanded,
    services,
    playerToolUpcomingIds,
    setSelectedId,
    startSwingReviewForClient,
    openSwingReviewId,
    setOpenSwingReviewId,
    reviewDisplayBlocks,
    reviewSaveStates,
    addVideoToReview,
    reviewInsertRef,
    reviewLessonTitle,
    resolveReviewVideoUrl,
    billingWorkspaceEnabled,
    openPosCheckoutForClient,
    portalPlayerBusyId,
    includeCaddyPass,
    setIncludeCaddyPass,
    caddyStatuses,
    isAdminUser,
    lessonNoteBusy,
    playerPracticeComposer,
    setAuthStatus,
    playerVideoAnglePairs,
    uploadingSavedVideoIds,
    openSavedVideoMenuId,
    linkedLessonVideoIds,
    clarityCloudImportActionIds,
    refreshCaddyStatus,
    runManagedLibraryAction,
    assignUnassignedVideo,
    makeDrillCopy,
    discardEmptyReview,
    sendSwingReviewToPlayer,
    fetchPlayerTransactions,
    openInvoiceForEdit,
    grantPortalAccess,
    revokePortalAccess,
    hardDeletePerson,
    saveLessonNoteForClient,
    deleteLessonNote,
    sendSavedVideoToPrimaryComputer,
    sendSavedVideoToPlayer,
    pauseSavedVideoTransfer,
    cancelSavedVideoTransfer,
    removeSavedVideoTransfer,
    showSavedVideoInFinder,
    revealSavedVideoFile,
    verifySavedVideoInLibrary,
    removeSavedVideoFromDevice,
    renameSavedVideo,
    deleteSavedVideo,
    retireLibraryEntry,
    restoreLibraryEntry,
    retiredLibraryEntries,
    openPlayerSubmissionOrCloudVideo,
    migrateLegacyVideo,
  } = props;
  const libraryVideoDelivery = (id: string, title: string) => {
    const item = playerToolVideos.find((video) => video.savedVideoId === id);
    const fileName = videoFileName(item?.source.originalFileName || title, item?.source.mimeType);
    return { fileName, key: JSON.stringify([id, item?.updatedAt, fileName]), prepare: async (signal: AbortSignal) => {
      const url = await resolveReviewVideoUrl(id, signal);
      if (!url) throw new Error(t("This video is unavailable. Reconnect its storage and try again."));
      try {
        signal.throwIfAborted();
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(t("Could not load the video."));
        return { blob: await response.blob(), fileName };
      } finally {
        // The resolver returns a new object URL owned by this request.
        if (url.startsWith("blob:")) URL.revokeObjectURL(url);
      }
    } };
  };
  const warmLibraryShare = (id: string, title: string) => {
    const request = libraryVideoDelivery(id, title);
    warmShare(request.key, request.prepare);
  };
  const deliverLibraryVideo = (id: string, title: string, action: "export" | "share") => {
    const request = libraryVideoDelivery(id, title);
    beginVideoDelivery(action, request.fileName, request.prepare, request.key);
  };

  return (
    <section className={`module-page player-profiles-page${phonePlayerOpen ? " is-phone-detail" : ""}`}>
      <div className="player-profiles-toolbar">
        <div className="player-profiles-heading">
          <p>{t("{customerPlural} with {serviceSingular} notes or video, plus anyone you add.", { customerPlural: terms.customerPlural, serviceSingular: terms.serviceSingular.toLowerCase() })}</p>
        </div>
        <div className="player-profiles-actions">
          <button
            type="button"
            className="icon-button"
            onClick={openPlayerAddDialog}
            title={t("Add {customerSingular}", { customerSingular: terms.customerSingular.toLowerCase() })}
            aria-label={t("Add {customerSingular}", { customerSingular: terms.customerSingular.toLowerCase() })}
          >
            <Plus size={18} />
          </button>
          {capabilities.videoAnalysis && (
            <button
              type="button"
              className="icon-button new-video-button"
              onClick={() => {
                switchView("video");
                setVideoCameraRequested(true);
              }}
              title={t("Record a video")}
              aria-label={t("Record a video")}
            >
              <Plus size={16} />
              <ClarityVideoAnalysis size={18} />
            </button>
          )}
        </div>
      </div>

      {unassignedVideos.length > 0 && (
        <div className="player-unassigned-videos">
          <p>
            {unassignedVideos.length === 1
              ? t("1 video was saved without a player.")
              : t("{length} videos were saved without a player.", { length: unassignedVideos.length })}
          </p>
          {unassignedVideos.map((video) => (
            <div className="player-unassigned-video" key={video.savedVideoId}>
              <span>
                {video.title || t("Saved video")}
                <span className="muted"> · {formatTimestampForDisplay(video.createdAt)}</span>
              </span>
              <button
                type="button"
                className="outline-button"
                disabled={Boolean(assigningVideoId)}
                onClick={() => void assignUnassignedVideo(video.savedVideoId)}
              >
                {assigningVideoId === video.savedVideoId ? t("Moving…") : t("Assign to player")}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="player-profiles-layout">
        <div className="player-profiles-list">
          {playerProfiles.length === 0 && playerProfilesDataReady ? (
            <div className="player-profiles-empty">
              <h2>{t("No {customerSingular} profiles yet", { customerSingular: terms.customerSingular.toLowerCase() })}</h2>
              <p>{t("Add a {serviceSingular} note or video to a {customerSingular}, or use + to add one.", { serviceSingular: terms.serviceSingular.toLowerCase(), customerSingular: terms.customerSingular.toLowerCase() })}</p>
            </div>
          ) : (
            playerProfiles.map((player) => {
              const isSelectedPlayer = notesWorkspaceClient?.id === player.id;
              return (
                <div
                  className={`player-profile-entry${isSelectedPlayer ? " is-expanded" : ""}${
                    isSelectedPlayer && !playerToolExpanded ? " is-collapsed" : ""
                  }`}
                  key={player.id}
                >
                  <article
                    className={`player-profile-card${isSelectedPlayer ? " active" : ""}`}
                    onClick={() => {
                      if (isSelectedPlayer) {
                        setPlayerToolExpanded((expanded) => !expanded);
                      } else {
                        selectPlayerProfileTool(player);
                      }
                    }}
                  >
                    <div className="player-profile-avatar">
                      <ClarityProfile size={18} />
                    </div>
                    <div className="player-profile-body">
                      <h3>{player.name}</h3>
                      <span>{player.email || player.phone || t("No contact yet")}</span>
                      <div className="player-profile-tags">
                        {hasAnyProfileId(videoPlayerIds, player) && (
                          <span className="tag">
                            <ClarityVideoAnalysis size={12} />{" "}{t("Video")}</span>
                        )}
                        {hasAnyProfileId(lessonNotePlayerIds, player) && (
                          <span className="tag">
                            <ClarityBookingPages size={12} />{" "}{t("Lesson notes")}</span>
                        )}
                        {unseenSubmissionCounts.get(player.id) ? (
                          <span className="tag is-unseen-submission">
                            <ClarityVideoAnalysis size={12} /> {unseenSubmissionCounts.get(player.id)}{" "}{t("new")}</span>
                        ) : null}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="icon-button"
                      title={t("Show videos")}
                      aria-label={t("Show videos for {name}", { name: player.name })}
                      onClick={(event) => {
                        event.stopPropagation();
                        selectPlayerProfileTool(
                          { id: preferredVideoPlayerId(player, videoPlayerIds), name: player.name },
                          "videos",
                        );
                      }}
                    >
                      <ClarityVideoAnalysis size={16} />
                    </button>
                  </article>

                  {isSelectedPlayer && notesWorkspaceClient ? (
                    <div className={`player-profile-tool-panel${playerToolExpanded ? "" : " collapsed"}`}>
                      <div className="player-tool-header">
                        <div>
                          <span>{t("Player")}</span>
                          <h3>{notesWorkspaceClient.name}</h3>
                          <p>{notesWorkspaceClient.email || notesWorkspaceClient.phone || t("No contact yet")}</p>
                          <p
                            className="player-tool-id"
                            title={t("Copy this player's id")}
                            onClick={() => {
                              void navigator.clipboard?.writeText(notesWorkspaceClient.id).catch(() => {});
                              setToast({ message: t("Player id copied.") });
                            }}
                          >{t("ID: {id}", { id: notesWorkspaceClient.id })}</p>
                        </div>
                      </div>

                      {playerToolExpanded && (
                        <div
                          className={`player-tool-tabs${playerToolTabsExpanded ? " is-expanded" : ""}`}
                          role="tablist"
                          aria-label={t("Player profile tools")}
                        >
                          {PRIMARY_PLAYER_TOOL_TABS.filter((tab) => playerToolAllowed(tab.id, capabilities)).map((tab) => (
                            <button
                              type="button"
                              key={tab.id}
                              className={playerProfileTool === tab.id ? "active" : ""}
                              onClick={() => setPlayerProfileTool(tab.id)}
                              role="tab"
                              aria-selected={playerProfileTool === tab.id}
                            >
                              <tab.Icon size={15} />
                              {tab.id === "practice" ? terms.assignmentPlural : tab.label}
                              {tab.id === "videos" && playerUnseenSubmissions ? (
                                <span className="player-tool-tab-count">{playerUnseenSubmissions}</span>
                              ) : null}
                            </button>
                          ))}
                          {playerToolTabsExpanded && (
                            <>
                              <span className="player-tool-tab-divider" aria-hidden="true" />
                              {SECONDARY_PLAYER_TOOL_TABS.filter((tab) => playerToolAllowed(tab.id, capabilities)).map((tab) => (
                                <button
                                  type="button"
                                  key={tab.id}
                                  className={playerProfileTool === tab.id ? "active" : ""}
                                  onClick={() => setPlayerProfileTool(tab.id)}
                                  role="tab"
                                  aria-selected={playerProfileTool === tab.id}
                                >
                                  <tab.Icon size={15} />
                                  {tab.label}
                                </button>
                              ))}
                            </>
                          )}
                          <button
                            type="button"
                            className="player-tool-tab-toggle"
                            aria-expanded={playerToolTabsExpanded}
                            title={
                              playerToolTabsExpanded
                                ? t("Collapse")
                                : t("Notes, Emails, Transactions, Passes, Portals")
                            }
                            onClick={() => {
                              // Closing the bar while one of the five is
                              // open would leave the body on a tab with
                              // no pill, so it falls back to the first.
                              if (playerToolTabsExpanded && SECONDARY_PLAYER_TOOLS.has(playerProfileTool)) {
                                setPlayerProfileTool("bookings");
                              }
                              setPlayerToolTabsExpanded(!playerToolTabsExpanded);
                            }}
                          >
                            {playerToolTabsExpanded ? <ChevronLeft size={15} /> : <ChevronRight size={15} />}
                          </button>
                        </div>
                      )}

                      {playerToolExpanded && playerProfileTool === "bookings" ? (
                        <div className="player-tool-body">
                          <div className="player-tool-card">
                            <div className="player-tool-card-header">
                              <div>
                                <strong><ClarityCalendar size={16} />{t("Bookings")}</strong>
                                <span>{tn(playerToolAppointments.length, "{count} booking", "{count} bookings")}
                                  {playerToolUpcomingCount ? t(" · {playerToolUpcomingCount} upcoming", { playerToolUpcomingCount }) : ""}
                                </span>
                              </div>
                              <button
                                type="button"
                                className="outline-button"
                                onClick={() => switchView("calendar")}
                              >{t("Book a lesson")}</button>
                            </div>
                            {playerToolAppointments.length ? (
                              playerToolAppointments.map((appointment) => {
                                const appointmentDays = buildWeekDays(itemWeek(appointment));
                                const service = itemService(appointment, services);
                                const upcoming = playerToolUpcomingIds.has(appointment.id);
                                return (
                                  <div className="player-tool-row" key={appointment.id}>
                                    <span className="player-tool-row-when">
                                      {appointmentDays[appointment.day].label}
                                      <br />
                                      <span>{formatTime(appointment.start)}</span>
                                    </span>
                                    <div className="player-tool-row-main">
                                      <strong>{service?.name ?? appointment.title}</strong>
                                      <span>
                                        {upcoming ? t("Upcoming") : t("Completed")} ·{" "}
                                        {formatRange(appointment.start, appointment.duration)}
                                        {appointment.note ? ` · ${appointment.note}` : ""}
                                      </span>
                                    </div>
                                    <div className="player-tool-row-actions">
                                      <button
                                        type="button"
                                        className="outline-button"
                                        onClick={() => {
                                          switchView("calendar");
                                          setSelectedId(appointment.id);
                                        }}
                                      >{t("Open")}</button>
                                    </div>
                                  </div>
                                );
                              })
                            ) : (
                              <p className="player-tool-card-empty">{t("No bookings yet.")}</p>
                            )}
                          </div>
                        </div>
                      ) : playerToolExpanded && playerProfileTool === "reviews" ? (
                        <div className="player-tool-body">
                          <div className="player-tool-card">
                            <div className="player-tool-card-header">
                              <div>
                                <strong><ClarityAssessments size={16} />{t("Swing reviews")}</strong>
                                <span>{tn(playerSwingReviewGroups.length, "{count} review · videos, screenshot notes and practice", "{count} reviews · videos, screenshot notes and practice")}</span>
                              </div>
                              <span className="swing-review-header-actions">
                                <button type="button" className="outline-button" onClick={() => setDrillLibraryOpen({})}>
                                  <ClarityLessonsProgrammes size={15} />{t("Drill library")}</button>
                                <button
                                  type="button"
                                  className="primary-button"
                                  onClick={() => startSwingReviewForClient(notesWorkspaceClient)}
                                >
                                  <ImagePlus size={15} />{t("New swing review")}</button>
                              </span>
                            </div>
                            {playerPracticeLoadState === "loading" ? (
                              <Loading what={t("swing reviews")} className="player-tool-card-empty" />
                            ) : playerSwingReviewGroups.length ? (
                              playerSwingReviewGroups.map((review) => {
                                const expanded = openSwingReviewId === review.id;
                                const totalItems =
                                  review.videos.length +
                                  review.cloudVideos.length +
                                  review.notes.length +
                                  review.analysisNotes.length +
                                  review.screenshots.length +
                                  review.practice.length +
                                  (reviewDocuments[review.id]?.blocks.filter((block) => block.type !== "video").length || 0);
                                const reviewTitle = reviewDocuments[review.id]?.title || "";
                                return (
                                  <article className={`swing-review-record${expanded ? " is-expanded" : ""}`} key={review.id}>
                                    <button
                                      type="button"
                                      className="swing-review-record-toggle"
                                      aria-expanded={expanded}
                                      onClick={() => setOpenSwingReviewId(expanded ? null : review.id)}
                                    >
                                      <span className="player-tool-row-when">
                                        {profileWhenParts(review.at).day || t("Review")}
                                        {profileWhenParts(review.at).time ? <><br /><span>{profileWhenParts(review.at).time}</span></> : null}
                                      </span>
                                      <span className="player-tool-row-main">
                                        <strong>{reviewTitle || t("Swing review")}</strong>
                                        <span>{tn(totalItems, "{count} item in this review file", "{count} items in this review file")}</span>
                                      </span>
                                      {expanded ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
                                    </button>
                                    {expanded ? (() => {
                                      const client = notesWorkspaceClient;
                                      const savedIds = [
                                        ...review.videos.map((video) => video.savedVideoId),
                                        ...review.cloudVideos.map((video) => video.savedVideoId || video.savedVideo?.savedVideoId || ""),
                                      ];
                                      const document = reviewDocuments[review.id];
                                      const displayBlocks = reviewDisplayBlocks(review.id, savedIds);
                                      // A position on the page has to mean the same thing
                                      // to the sheet and to whatever lands there later, so
                                      // videos it was only showing are written in first.
                                      const settlePage = () => {
                                        if (!document) {
                                          updateReviewDocument(review.id, client.id, { title: "", blocks: displayBlocks }, { immediate: true });
                                        }
                                      };
                                      const sheetVideos: Record<string, SheetVideo> = {};
                                      for (const video of review.videos) {
                                        sheetVideos[video.savedVideoId] = {
                                          savedVideoId: video.savedVideoId,
                                          title: video.title,
                                          thumbnailDataUrl: video.thumbnailDataUrl,
                                          duration: video.source.duration,
                                          snapshots: (video.analysisSnapshot.focusSnapshots || []).map((snapshot) => ({
                                            id: snapshot.id,
                                            title: snapshot.title,
                                            note: snapshot.note,
                                            currentTime: snapshot.currentTime,
                                            imageDataUrl: snapshot.imageDataUrl || undefined,
                                          })),
                                          notes: (video.analysisSnapshot.notes || []).map((note) => ({ id: note.id, text: note.text, time: note.time })),
                                        };
                                      }
                                      for (const video of review.cloudVideos) {
                                        const id = video.savedVideoId || video.savedVideo?.savedVideoId || "";
                                        if (!id || sheetVideos[id]) continue;
                                        sheetVideos[id] = {
                                          savedVideoId: id,
                                          title: video.savedVideo?.title || t("Cloud video"),
                                          cloudOnly: true,
                                          snapshots: [],
                                          notes: [],
                                        };
                                      }
                                      return (
                                        <div className="swing-review-record-body">
                                          <Suspense fallback={<Loading what={t("swing review")} />}>
                                            <SwingReviewSheet
                                              businessName={coachAccount.businessName}
                                              logoUrl={brandSettings.showLogo ? brandSettings.logoPreview : ""}
                                              coachName={coachAccount.coachName}
                                              playerName={client.name}
                                              reviewAt={review.at}
                                              title={document?.title || ""}
                                              blocks={displayBlocks}
                                              onChange={(next) => updateReviewDocument(review.id, client.id, next)}
                                              saveState={reviewSaveStates[review.id] || "idle"}
                                              videos={sheetVideos}
                                              sessionNotes={review.notes.map((note) => ({ id: note.id, label: note.title || t("Review note"), text: note.body }))}
                                              practice={review.practice.map((block) => ({
                                                id: block.id,
                                                title: block.title,
                                                content: block.content,
                                                meta: [block.status, block.dose].filter(Boolean).join(" · "),
                                              }))}
                                              onAddVideo={(index) => {
                                                settlePage();
                                                addVideoToReview(review.id, client, index);
                                              }}
                                              onAddDrill={(index) => {
                                                settlePage();
                                                setDrillLibraryOpen({ lessonId: review.id, index });
                                              }}
                                              onOpenVideo={(savedVideoId) => {
                                                reviewInsertRef.current = null;
                                                openVideoAnalysisForClient({
                                                  id: preferredVideoPlayerId(client, videoPlayerIds),
                                                  name: client.name,
                                                  savedVideoId,
                                                  lessonId: review.id,
                                                  lessonTitle: reviewLessonTitle(review.id),
                                                });
                                              }}
                                              onOpenSnapshot={(savedVideoId, snapshotId) =>
                                                setSnapshotFrameView({ reviewId: review.id, key: `${savedVideoId}-${snapshotId}` })
                                              }
                                              onMakeDrillCopy={(block) => void makeDrillCopy(review.id, client, block)}
                                              actions={
                                                displayBlocks.length === 0 && !review.notes.length && !review.practice.length && !document?.sentAt ? (
                                                  <button type="button" className="text-button" onClick={() => void discardEmptyReview(review.id)}>
                                                    <Trash2 size={14} />{t("Discard this empty review")}</button>
                                                ) : (
                                                  <>
                                                    <button
                                                      type="button"
                                                      className="primary-button"
                                                      disabled={sendingSwingReviewId === review.id}
                                                      onClick={() =>
                                                        void sendSwingReviewToPlayer(review, notesWorkspaceClient)
                                                      }
                                                    >
                                                      <Send size={15} />
                                                      {sendingSwingReviewId === review.id
                                                        ? t("Sending…")
                                                        : sentSwingReviewLink?.id === review.id || document?.sentAt
                                                          ? t("Send again")
                                                          : t("Send to player")}
                                                    </button>
                                                    {/* Only after a send, and only for that review: the
                                                      * raw token exists in the send's response and
                                                      * nowhere else, so there is no link to copy until
                                                      * one has been minted in this session. */}
                                                    {sentSwingReviewLink?.id === review.id ? (
                                                      <button
                                                        type="button"
                                                        className="outline-button"
                                                        onClick={() => {
                                                          void navigator.clipboard
                                                            ?.writeText(sentSwingReviewLink.url)
                                                            .then(() => setToast({ message: t("Viewing link copied.") }))
                                                            .catch(() =>
                                                              setToast({ message: t("Could not copy the link.") }),
                                                            );
                                                        }}
                                                      >
                                                        <ClarityIntegrations size={15} />{t("Copy viewing link")}</button>
                                                    ) : null}
                                                  </>
                                                )
                                              }
                                            />
                                          </Suspense>
                                          {snapshotFrameView?.reviewId === review.id ? (
                                            <Suspense fallback={<Loading what={t("the saved frame")} size="panel" />}>
                                              <SnapshotFrameViewer
                                                shots={review.screenshots.map((snapshot): FrameViewerShot => ({
                                                  key: `${snapshot.savedVideoId}-${snapshot.id}`,
                                                  savedVideoId: snapshot.savedVideoId,
                                                  videoTitle: snapshot.videoTitle,
                                                  title: snapshot.title,
                                                  note: snapshot.note,
                                                  currentTime: snapshot.currentTime,
                                                  captureKind: snapshot.captureKind,
                                                  cropRect: snapshot.cropRect,
                                                  imageUrl: snapshot.imageDataUrl || undefined,
                                                }))}
                                                initialKey={snapshotFrameView.key}
                                                resolveVideoUrl={resolveReviewVideoUrl}
                                                onClose={() => setSnapshotFrameView(null)}
                                              />
                                            </Suspense>
                                          ) : null}
                                        </div>
                                      );
                                    })() : null}
                                  </article>
                                );
                              })
                            ) : (
                              <div className="player-tool-card-empty">
                                <p>{t("No swing reviews yet.")}</p>
                                <span>{t("Start one to keep its videos, screenshot notes and practice together.")}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      ) : playerToolExpanded && playerProfileTool === "emails" ? (
                        <div className="player-tool-body">
                          <div className="player-tool-card">
                            <div className="player-tool-card-header">
                              <div>
                                <strong><ClarityEmail size={16} />{t("Emails")}</strong>
                                <span>{t("Everything sent to this person")}</span>
                              </div>
                            </div>
                            {playerToolNotifications.length ? (
                              playerToolNotifications.map((notification) => {
                                const when = profileWhenParts(notification.createdAt);
                                return (
                                  <div className="player-tool-row" key={notification.id}>
                                    <span className="player-tool-row-when">
                                      {when.day || "—"}
                                      {when.time ? (
                                        <>
                                          <br />
                                          <span>{when.time}</span>
                                        </>
                                      ) : null}
                                    </span>
                                    <div className="player-tool-row-main">
                                      <strong>
                                        {notification.subject || notificationKindLabel(notification.kind)}
                                      </strong>
                                      <span>{t("{kind} to {recipient} · {notification}", { kind: notificationKindLabel(notification.kind), recipient: notification.recipient, notification: notificationStatusLabel(notification) })}</span>
                                    </div>
                                  </div>
                                );
                              })
                            ) : (
                              <p className="player-tool-card-empty">{t("No emails sent to this person yet.")}</p>
                            )}
                          </div>
                        </div>
                      ) : playerToolExpanded && playerProfileTool === "transactions" ? (
                        <div className="player-tool-body">
                          <div className="player-tool-card">
                            <div className="player-tool-card-header">
                              <div>
                                <strong><ClarityPayments size={16} />{t("Transactions")}</strong>
                                <span>{t("Everything billed to this person")}</span>
                              </div>
                              {billingWorkspaceEnabled && (
                                <button
                                  type="button"
                                  className="outline-button"
                                  onClick={() => openPosCheckoutForClient(notesWorkspaceClient)}
                                >{t("New sale")}</button>
                              )}
                            </div>
                            {notesWorkspaceClient.id.startsWith("appointment-") ? (
                              <p className="player-tool-card-empty">{t("Save this booking contact as a client to track their transactions.")}</p>
                            ) : playerTransactionsLoadState === "loading" ? (
                              <Loading what={t("transactions")} className="player-tool-card-empty" />
                            ) : playerTransactionsLoadState === "error" ? (
                              <p className="player-tool-card-empty">{t("Could not load transactions.")}{" "}<button
                                  className="link-button"
                                  type="button"
                                  onClick={() => void fetchPlayerTransactions(notesWorkspaceClient.id)}
                                >{t("Retry")}</button>
                              </p>
                            ) : playerTransactions.length ? (
                              playerTransactions.map((row) =>
                                row.kind === "coupon" ? (
                                  <div className="player-tool-row" key={`coupon-${row.coupon.id}`}>
                                    <span className="player-tool-row-when">
                                      {transactionDateLabel(row.date)}
                                    </span>
                                    <div className="player-tool-row-main">
                                      <strong>{row.coupon.code}</strong>
                                      <span>{t("Gift voucher · {remainingValue} left", { remainingValue: formatMoney(row.coupon.remainingValue, row.coupon.currency) })}{row.coupon.issuedToName
                                          ? t(" · bought by {issuedToName}", { issuedToName: row.coupon.issuedToName })
                                          : ""}
                                      </span>
                                    </div>
                                  </div>
                                ) : row.kind === "sale" ? (
                                  <div className="player-tool-row" key={`sale-${row.sale.id}`}>
                                    <span className="player-tool-row-when">
                                      {transactionDateLabel(row.date)}
                                    </span>
                                    <div className="player-tool-row-main">
                                      <strong>{row.sale.description || row.sale.receiptNumber}</strong>
                                      <span>
                                        {formatMoney(row.sale.amount, row.sale.currency)} ·{" "}
                                        {posMethodLabel(row.sale)} · {row.sale.receiptNumber}
                                        {row.sale.isLessonPass ? t(" · Lesson pass") : ""}
                                      </span>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="player-tool-row" key={`invoice-${row.invoice.id}`}>
                                    <span className="player-tool-row-when">
                                      {transactionDateLabel(row.date)}
                                    </span>
                                    <div className="player-tool-row-main">
                                      <strong>{row.invoice.invoiceNumber}</strong>
                                      <span>
                                        {formatMoney(row.invoice.total, row.invoice.currency)} ·{" "}
                                        {row.invoice.status}
                                        {row.invoice.relation === "included"
                                          ? ` · ${t("billed to {name}", { name: row.invoice.customerName || t("someone else") })}`
                                          : ""}
                                      </span>
                                    </div>
                                    <div className="player-tool-row-actions">
                                      <button
                                        type="button"
                                        className="outline-button"
                                        onClick={() => {
                                          switchView("billing");
                                          void openInvoiceForEdit(row.invoice);
                                        }}
                                      >{t("Invoice")}</button>
                                    </div>
                                  </div>
                                ),
                              )
                            ) : (
                              <p className="player-tool-card-empty">{t("No transactions for this person yet.")}</p>
                            )}
                          </div>
                        </div>
                      ) : playerToolExpanded && playerProfileTool === "passes" ? (
                        <div className="player-tool-body">
                          <div className="player-tool-card">
                            <div className="player-tool-card-header">
                              <div>
                                <strong><ClarityPassesCredits size={16} />{t("Passes")}</strong>
                                <span>{t("Lesson credits held by this person")}</span>
                              </div>
                            </div>
                            {/* Passes are designed but not built -- see
                                docs/pass-system-design.md. There is no pass
                                record to read, so this says so rather than
                                showing an empty list that reads as "this
                                person has none". */}
                            <p className="player-tool-card-empty">{t("Passes are not built yet. Lesson packages sold through checkout show up under Transactions, tagged as a lesson pass.")}</p>
                          </div>
                        </div>
                      ) : playerToolExpanded && playerProfileTool === "portals" ? (
                        <div className="player-tool-body">
                          {(() => {
                            const portalPlayer = portalPlayers.find(
                              (entry) => entry.personId === notesWorkspaceClient.id && entry.status !== "disabled",
                            );
                            const busy = portalPlayerBusyId === notesWorkspaceClient.id;
                            return (
                              <div className="player-portal-access">
                                <div className="player-portal-access-body">
                                  <strong>{t("Player portal")}</strong>
                                  <span>
                                    {!notesWorkspaceClient.email
                                      ? t("Add an email address to give this player portal access.")
                                      : !portalPlayer
                                        ? t("No access yet. They can be given a login to see their lessons, notes and videos.")
                                        : portalPlayer.status === "active"
                                          ? portalPlayer.lastLoginAt
                                            ? t("Active · last signed in {when}", { when: formatTimestampForDisplay(portalPlayer.lastLoginAt) })
                                            : t("Active")
                                          : t("Invited · waiting for them to set a password")}
                                  </span>
                                </div>
                                <div className="player-portal-access-actions">
                                  <label className="player-caddy-pass-toggle" title={t("Issues a 30 day Clarity Caddy pass at the same time")}>
                                    <input
                                      type="checkbox"
                                      checked={includeCaddyPass}
                                      onChange={(event) => setIncludeCaddyPass(event.target.checked)}
                                      disabled={busy || !notesWorkspaceClient.email}
                                    />
                                    <span>{t("Include Clarity Caddy Pass")}</span>
                                  </label>
                                  <button
                                    type="button"
                                    className="outline-button"
                                    disabled={busy || !notesWorkspaceClient.email}
                                    onClick={() => void grantPortalAccess(notesWorkspaceClient)}
                                  >
                                    {portalPlayer ? t("Resend invite") : t("Give portal access")}
                                  </button>
                                  {portalPlayer && (
                                    <button
                                      type="button"
                                      className="outline-button"
                                      disabled={busy}
                                      onClick={() => void revokePortalAccess(portalPlayer.id, notesWorkspaceClient.id)}
                                    >{t("Remove access")}</button>
                                  )}
                                </div>
                              </div>
                            );
                          })()}

                          {/* Caddy is a separate product with separate access, so it gets its
                              own card rather than being folded into the portal row. */}
                          {(() => {
                            const entry = caddyStatuses[notesWorkspaceClient.id];
                            const hasPortal = portalPlayers.some(
                              (candidate) =>
                                candidate.personId === notesWorkspaceClient.id && candidate.status !== "disabled",
                            );
                            if (!hasPortal) return null;
                            const status = entry?.status;
                            const detail = !entry
                              ? t("Checking…")
                              : status?.unavailable === "unreachable"
                                ? t("Could not read Caddy status right now.")
                                : status?.unavailable === "not_configured"
                                  ? t("Clarity Caddy is not connected to this deployment.")
                                  : !status?.connected
                                    ? t("No Clarity Caddy account yet.")
                                    : status.expiresAt
                                      ? t("Account: Connected · Access: {access} until {until}", {
                                          access: status.active ? status.access : t("Free"),
                                          until: formatTimestampForDisplay(status.expiresAt),
                                        })
                                      : t("Account: Connected · Access: {access}", {
                                          access: status.active ? status.access : t("Free"),
                                        });
                            return (
                              <div className="player-caddy-card">
                                <div className="player-caddy-card-body">
                                  <strong>{t("Clarity Caddy")}</strong>
                                  <span>{detail}</span>
                                  {status?.connected && status.coachCount && status.coachCount > 1 ? (
                                    <span>{tn(status.coachCount - 1, "Also coached by {count} other.", "Also coached by {count} others.")}</span>
                                  ) : null}
                                </div>
                                <div className="player-caddy-card-actions">
                                  {!entry ? (
                                    <button
                                      type="button"
                                      className="outline-button"
                                      onClick={() => void refreshCaddyStatus(notesWorkspaceClient.id)}
                                    >{t("Check Caddy")}</button>
                                  ) : entry.deepLink ? (
                                    <a
                                      className="outline-button"
                                      href={entry.deepLink}
                                      target="_blank"
                                      rel="noreferrer noopener"
                                    >{t("Open in Clarity Caddy ↗")}</a>
                                  ) : (
                                    <button
                                      type="button"
                                      className="outline-button"
                                      onClick={() => void refreshCaddyStatus(notesWorkspaceClient.id)}
                                    >{t("Retry")}</button>
                                  )}
                                </div>
                              </div>
                            );
                          })()}

                          {isAdminUser && (
                            <div className="player-portal-access">
                              <div className="player-portal-access-body">
                                <strong>{t("Danger zone")}</strong>
                                <span>{t("Permanently delete this player: their record, bookings, practice blocks, videos, lesson notes and portal login. No email is sent, and this cannot be undone.")}</span>
                              </div>
                              <div className="player-portal-access-actions">
                                <button
                                  type="button"
                                  className="danger-button"
                                  disabled={personDeleteBusyId === notesWorkspaceClient.id}
                                  onClick={() => void hardDeletePerson(notesWorkspaceClient)}
                                >
                                  <Trash2 size={16} />
                                  {personDeleteBusyId === notesWorkspaceClient.id
                                    ? t("Deleting…")
                                    : t("Delete permanently")}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      ) : playerToolExpanded && playerProfileTool === "notes" ? (
                        <div className="player-tool-body">
                          <Suspense fallback={<Loading what={t("voice notes")} />}>
                            <ClarityVoiceTextPanel
                              fieldLabel={t("Lesson note")}
                              placeholder={t("Type or dictate the coach lesson note.")}
                              onCommit={(text) => saveLessonNoteForClient(notesWorkspaceClient, text, "voice")}
                            />
                          </Suspense>
                          <div className="lesson-notes-list">
                            {notesWorkspaceLessonNotes.length ? (
                              notesWorkspaceLessonNotes.map((note) => (
                                <article className="lesson-note-card" key={note.id}>
                                  <div>
                                    <strong>{profileRecordTitle(notesWorkspaceClient.name, note.updatedAt || note.createdAt)}</strong>
                                    <span>
                                      {note.title || t("Lesson note")} · {note.source === "voice" ? t("Voice note") : t("Typed note")}
                                      {note.lessonId && playerToolVideos.some((video) => video.lessonId === note.lessonId)
                                        ? t(" · Linked lesson video")
                                        : ""}
                                    </span>
                                  </div>
                                  <p>{note.body}</p>
                                  <button
                                    type="button"
                                    className="outline-button"
                                    onClick={() => void deleteLessonNote(note.id)}
                                    disabled={lessonNoteBusy}
                                  >
                                    <Trash2 size={14} />{t("Delete")}</button>
                                </article>
                              ))
                            ) : (
                              <p className="notes-empty">{t("No lesson notes yet.")}</p>
                            )}
                          </div>
                        </div>
                      ) : playerToolExpanded && playerProfileTool === "practice" ? (
                        <div className="player-tool-body">
                          {/* Two readings of the same thing. The list
                              answers "what is this player working on",
                              which is the question the profile is open
                              for; the module's own panel is the composer
                              and the wall, and opens over it on demand. */}
                          {playerPracticeComposer ? (
                            <>
                              <div className="player-tool-inline-actions">
                                <button
                                  type="button"
                                  className="outline-button"
                                  onClick={() => setPlayerPracticeComposer(false)}
                                >
                                  <ChevronLeft size={15} />{t("Back to practice list")}</button>
                              </div>
                            <Suspense fallback={<Loading what={t("practice")} />}>
                              <PracticeBlockPanel
                                // Keyed so switching player remounts rather
                                // than showing the previous player's blocks
                                // until the fetch lands.
                                key={notesWorkspaceClient.id}
                                player={{ id: notesWorkspaceClient.id, name: notesWorkspaceClient.name }}
                                onUnauthorized={() => setAuthStatus("guest")}
                                onToast={(message) => setToast({ message })}
                              />
                            </Suspense>
                            </>
                          ) : (
                            <div className="player-tool-card">
                              <div className="player-tool-card-header">
                                <div>
                                  <strong><ClarityLessonsProgrammes size={16} />{t("Practice")}</strong>
                                  <span>{tn(activePlayerPracticeBlocks.length, "{count} active block", "{count} active blocks")}
                                    {playerPracticeExpiringCount
                                      ? t(" · {playerPracticeExpiringCount} expiring next lesson", { playerPracticeExpiringCount })
                                      : ""}
                                  </span>
                                </div>
                                <button
                                  type="button"
                                  className="outline-button"
                                  onClick={() => setPlayerPracticeComposer(true)}
                                >{t("Assign a block")}</button>
                              </div>
                              {playerPracticeLoadState === "loading" ? (
                                <Loading what={t("practice")} className="player-tool-card-empty" />
                              ) : playerPracticeLoadState === "error" ? (
                                <p className="player-tool-card-empty">{t("Could not load practice for this player.")}</p>
                              ) : activePlayerPracticeBlocks.length ? (
                                activePlayerPracticeBlocks.map((block) => (
                                  <div className="player-tool-row is-practice" key={block.id}>
                                    <span
                                      className="player-tool-row-tone"
                                      style={block.tone ? { background: block.tone } : undefined}
                                      title={block.typeLabel}
                                    >
                                      {block.typeLabel.slice(0, 1).toUpperCase()}
                                    </span>
                                    <div className="player-tool-row-main">
                                      <strong>{block.title}</strong>
                                      <span>
                                        {[
                                          block.typeLabel,
                                          block.steps
                                            ? tn(block.steps, "{count} step", "{count} steps")
                                            : "",
                                          block.dose,
                                          block.expiryType === "next_lesson"
                                            ? "expires next lesson"
                                            : block.expiryType === "set_date" && block.expiryDate
                                              ? `expires ${formatTimestampForDisplay(block.expiryDate)}`
                                              : "no expiry",
                                          block.hasVideo ? "video attached" : "",
                                        ]
                                          .filter(Boolean)
                                          .join(" · ")}
                                      </span>
                                    </div>
                                    <div className="player-tool-row-actions">
                                      <button
                                        type="button"
                                        className="outline-button"
                                        onClick={() => setPlayerPracticeComposer(true)}
                                      >{t("Open")}</button>
                                    </div>
                                  </div>
                                ))
                              ) : (
                                <p className="player-tool-card-empty">{t("Nothing set to practise yet.")}</p>
                              )}
                            </div>
                          )}
                        </div>
                      ) : playerToolExpanded ? (
                        <div className="player-tool-body">
                          {retiredLibraryEntries.length ? <details className="player-video-removed">
                            <summary>{t("Removed entries")} ({retiredLibraryEntries.length})</summary>
                            {retiredLibraryEntries.map((entry) => <div key={entry.savedVideoId}>
                              <span>{entry.title}</span>
                              <button type="button" className="outline-button" onClick={() => void restoreLibraryEntry(entry.savedVideoId)}>{t("Restore entry")}</button>
                            </div>)}
                          </details> : null}
                          <div className="player-video-toolbar">
                            <div className="player-video-toolbar-count">
                              <strong>{tn(playerVideoSummary.total, "{count} saved video", "{count} saved videos")}
                              </strong>
                              <span>{playerVideoSummary.detail}</span>
                            </div>
                            <div className="player-video-toolbar-actions">
                              <button
                                type="button"
                                className="outline-button"
                                onClick={() =>
                                  openVideoAnalysisForClient({
                                    id: preferredVideoPlayerId(notesWorkspaceClient, videoPlayerIds),
                                    name: notesWorkspaceClient.name,
                                  })
                                }
                              >
                                <ClarityVideoAnalysis size={15} />{t("Add video")}</button>
                              <div
                                className="player-video-view-toggle"
                                role="group"
                                aria-label={t("Video layout")}
                              >
                                <button
                                  type="button"
                                  title={t("Ledger")}
                                  aria-label={t("Ledger")}
                                  aria-pressed={playerVideoView === "ledger"}
                                  className={playerVideoView === "ledger" ? "active" : ""}
                                  onClick={() => setPlayerVideoView("ledger")}
                                >
                                  <List size={16} />
                                </button>
                                <button
                                  type="button"
                                  title={t("Shelf")}
                                  aria-label={t("Shelf")}
                                  aria-pressed={playerVideoView === "shelf"}
                                  className={playerVideoView === "shelf" ? "active" : ""}
                                  onClick={() => setPlayerVideoView("shelf")}
                                >
                                  <LayoutGrid size={16} />
                                </button>
                              </div>
                            </div>
                          </div>

                          {playerVideoView === "shelf" ? (
                            <div>
                              {playerVideoShelfGroups.length ? (
                                playerVideoShelfGroups.map((group) => (
                                  <div key={group.key}>
                                    <div className="player-video-shelf-group">
                                      <strong>{group.label}</strong>
                                      <span>{tn(group.clips.length, "{count} clip", "{count} clips")}
                                        {group.unseen ? t(" · {unseen} new", { unseen: group.unseen }) : ""}
                                      </span>
                                    </div>
                                    <div className="player-video-shelf-grid">
                                      {group.clips.map((clip) => (
                                        <article
                                          className={`player-video-shelf-card${clip.unseen ? " is-unseen" : ""}`}
                                          key={clip.key}
                                        >
                                          <button
                                            type="button"
                                            className={`player-video-shelf-thumb${clip.partner ? " is-pair" : ""}`}
                                            disabled={!clip.playable}
                                            title={clip.playable ? t("Play {title}", { title: clip.title }) : clip.title}
                                            onClick={() =>
                                              openVideoAnalysisForClient({
                                                id: preferredVideoPlayerId(
                                                  notesWorkspaceClient,
                                                  videoPlayerIds,
                                                ),
                                                name: notesWorkspaceClient.name,
                                                savedVideoId: clip.savedVideoId,
                                                pairedSavedVideoId: clip.partner?.savedVideoId,
                                              })
                                            }
                                          >
                                            {[clip, ...(clip.partner ? [clip.partner] : [])].map((angle) =>
                                              <img key={angle.key} src={angle.thumbnail || VIDEO_THUMBNAIL_PLACEHOLDER} alt="" loading="lazy" decoding="async" />,
                                            )}
                                            {clip.unseen ? (
                                              <span className="player-video-shelf-badge">{t("New")}</span>
                                            ) : null}
                                            {clip.duration ? (
                                              <span className="player-video-shelf-duration">
                                                {formatClipDuration(clip.duration)}
                                              </span>
                                            ) : null}
                                          </button>
                                          <div className="player-video-shelf-body">
                                            <strong>{clip.title}</strong>
                                            <div className="player-video-menu">
                                              <button type="button" className="icon-button" aria-label={t("Video options")} aria-haspopup="menu" aria-expanded={openSavedVideoMenuId === clip.key} onClick={() => setOpenSavedVideoMenuId(openSavedVideoMenuId === clip.key ? null : clip.key)}><ClarityMore size={16} /></button>
                                              {openSavedVideoMenuId === clip.key ? (
                                                <AnchoredMenu onClose={() => setOpenSavedVideoMenuId(null)} closeLabel={t("Close video options")}>
                                                  {[clip, ...(clip.partner ? [clip.partner] : [])].map((angle, index) => (
                                                    <div key={angle.key}>
                                                      {clip.partner ? <span>{t("Angle {value}", { value: index + 1 })}</span> : null}
                                                      {(["export", "share"] as const).map((action) => (
                                                        <button type="button" role="menuitem" key={action} disabled={!angle.playable} onPointerEnter={action === "share" ? () => warmLibraryShare(angle.savedVideoId, angle.title) : undefined} onFocus={action === "share" ? () => warmLibraryShare(angle.savedVideoId, angle.title) : undefined} onClick={() => {
                                                          setOpenSavedVideoMenuId(null);
                                                          deliverLibraryVideo(angle.savedVideoId, angle.title, action);
                                                        }}>{action === "export" ? t("Export") : t("Share")}</button>
                                                      ))}
                                                      <button type="button" role="menuitem" onClick={() => {
                                                        setOpenSavedVideoMenuId(null);
                                                        void retireLibraryEntry(angle.savedVideoId, angle.title, preferredVideoPlayerId(notesWorkspaceClient, videoPlayerIds));
                                                      }}>{t("Remove unavailable entry")}</button>
                                                    </div>
                                                  ))}
                                                </AnchoredMenu>
                                              ) : null}
                                            </div>
                                            <span>
                                              {clip.partner
                                                ? t("Same swing · 2 angles")
                                                : clip.kind === "submission"
                                                ? t("Player submission")
                                                : clip.kind === "recovery"
                                                  ? t("Recovery only")
                                                  : t("Local Storage")}
                                            </span>
                                          </div>
                                        </article>
                                      ))}
                                    </div>
                                  </div>
                                ))
                              ) : (
                                <p className="notes-empty">{t("No videos yet.")}</p>
                              )}
                              <button
                                type="button"
                                className="player-video-shelf-add"
                                onClick={() =>
                                  openVideoAnalysisForClient({
                                    id: preferredVideoPlayerId(notesWorkspaceClient, videoPlayerIds),
                                    name: notesWorkspaceClient.name,
                                  })
                                }
                              >{t("+ Add from Video Analysis")}</button>
                            </div>
                          ) : (
                          <div className="player-video-list">
                            {!managedLocalLibraryStatus.configured ? (
                              <article className="player-video-card is-library-status">
                                <div className="player-video-thumb is-empty">
                                  <ClarityFilesMedia size={16} />
                                </div>
                                <div className="player-video-card-body">
                                  <strong>{t("My Library not connected")}</strong>
                                  <span>{t("Videos stay available through device cache. Connect My Library only for permanent local copies.")}</span>
                                </div>
                                <div className="player-video-card-actions">
                                  <button
                                    type="button"
                                    className="primary-button"
                                    disabled={!managedLocalLibraryStatus.supported}
                                    onClick={() => void runManagedLibraryAction("choose")}
                                  >
                                    <ClarityFilesMedia size={14} />{t("Choose My Library")}</button>
                                </div>
                              </article>
                            ) : managedLocalLibraryStatus.health !== "healthy" ? (
                              <article className="player-video-card is-library-status">
                                <div className="player-video-thumb is-empty">
                                  <AlertTriangle size={16} />
                                </div>
                                <div className="player-video-card-body">
                                  <strong>{managedLocalLibraryStatus.message}</strong>
                                  <span>{t("Working from device cache. Reconnect My Library when available.")}</span>
                                </div>
                                <div className="player-video-card-actions">
                                  <button
                                    type="button"
                                    className="outline-button"
                                    onClick={() => void runManagedLibraryAction("reconnect")}
                                  >
                                    <RefreshCw size={14} />{t("Reconnect folder")}</button>
                                </div>
                              </article>
                            ) : null}
                            {playerToolVideos.length || playerToolCloudVideos.length || playerToolLegacyVideoRecords.length ? (
                              <>
                                {groupSameSwingAngles(
                                  playerToolVideos,
                                  (video) => video.savedVideoId,
                                  playerVideoAnglePairs,
                                ).map((angles) => {
                                  const renderSavedVideoCard = (video: SavedVideoItem) => {
                                  const cloudOperational = isClarityCloudOperational(clarityCloudHealth);
                                  const cloudStatus = video.cloud?.status || "not-uploaded";
                                  const isUploading =
                                    cloudOperational &&
                                    (uploadingSavedVideoIds.has(video.savedVideoId) ||
                                      video.cloud?.status === "preparing" ||
                                      video.cloud?.status === "session-created" ||
                                      video.cloud?.status === "uploading" ||
                                      video.cloud?.status === "verifying");
                                  const cloudLabel = getSavedVideoCloudStatusLabel(video, {
                                    isUploading,
                                    cloudConnected: googleDriveTransfer.connected,
                                    cloudState: googleDriveTransfer.state,
                                    cloudHealth: clarityCloudHealth,
                                  });
                                  const cloudErrorLabel =
                                    video.cloud?.status === "failed"
                                      ? savedVideoCloudErrorLabel(video.cloud.lastUploadErrorCode, video.cloud.errorMessage)
                                      : "";
                                  const canRetryCloud =
                                    video.local.status === "available" &&
                                    cloudOperational &&
                                    cloudStatus !== "ready" &&
                                    cloudStatus !== "imported" &&
                                    !isUploading;
                                  const sendLabel =
                                    cloudStatus === "failed"
                                      ? t("Retry upload")
                                      : cloudStatus === "paused"
                                        ? t("Resume upload")
                                        : t("Retry upload");
                                  const canPause =
                                    cloudOperational &&
                                    cloudStatus === "uploading" &&
                                    Number(video.cloud?.acceptedOffsetBytes || 0) > 0;
                                  const canCancel =
                                    cloudOperational &&
                                    (cloudStatus === "preparing" ||
                                      cloudStatus === "session-created" ||
                                      cloudStatus === "uploading" ||
                                      cloudStatus === "paused");
                                  const canRemoveTransfer = cloudOperational && cloudStatus === "failed";
                                  const hasDeviceCopy = video.local.status !== "missing";
                                  const canRemoveFromDevice =
                                    (cloudStatus === "ready" || cloudStatus === "imported") &&
                                    hasDeviceCopy;
                                  const cloudSaved = cloudStatus === "ready" || cloudStatus === "imported";
                                  const cloudFailed = cloudStatus === "failed" || !cloudOperational;
                                  const cloudState = isUploading
                                    ? "uploading"
                                    : cloudSaved
                                      ? "saved"
                                      : cloudFailed
                                        ? "failed"
                                        : "pending";
                                  const cloudBadgeLabel = isUploading
                                    ? t("Uploading to Clarity Cloud")
                                    : cloudSaved
                                      ? t("Saved in Clarity Cloud")
                                      : cloudStatus === "failed"
                                        ? cloudErrorLabel || t("Clarity Cloud upload failed")
                                        : !cloudOperational
                                          ? cloudLabel
                                          : t("Waiting to upload to Clarity Cloud");
                                  const videoTitle = profileRecordTitle(
                                    notesWorkspaceClient.name,
                                    video.updatedAt || video.createdAt,
                                  );
                                  const videoRawTitle = video.title || videoTitle;
                                  const menuOpen = openSavedVideoMenuId === video.savedVideoId;
                                  const closeMenu = () => setOpenSavedVideoMenuId(null);
                                  const playVideo = () =>
                                    openVideoAnalysisForClient({
                                      id: video.playerId,
                                      name: notesWorkspaceClient.name,
                                      savedVideoId: video.savedVideoId,
                                    });
                                  return (
                                    <article className="player-video-card" key={video.savedVideoId}>
                                      <button
                                        type="button"
                                        className="player-video-thumb-button"
                                        onClick={playVideo}
                                        title={t("Play {videoTitle}", { videoTitle })}
                                        aria-label={t("Play {videoTitle}", { videoTitle })}
                                      >
                                        <img
                                            className="player-video-thumb"
                                            src={video.thumbnailDataUrl || VIDEO_THUMBNAIL_PLACEHOLDER}
                                            loading="lazy" decoding="async"
                                            alt=""
                                          />
                                        <span className="player-video-thumb-play" aria-hidden="true">
                                          <Play size={14} />
                                        </span>
                                      </button>
                                      <div className="player-video-card-body">
                                        <strong title={videoRawTitle !== videoTitle ? videoRawTitle : undefined}>
                                          {videoTitle}
                                        </strong>
                                        {linkedLessonVideoIds.has(video.savedVideoId) ? (
                                          <span>{t("Linked lesson note")}</span>
                                        ) : null}
                                      </div>
                                      <div className="player-video-card-actions">
                                        <span
                                          className={`player-video-cloud-badge is-${cloudState}`}
                                          title={cloudBadgeLabel}
                                          aria-label={cloudBadgeLabel}
                                          role="img"
                                        >
                                          {cloudState === "uploading" ? (
                                            <CloudUpload size={16} />
                                          ) : cloudState === "saved" ? (
                                            <Cloud size={16} />
                                          ) : cloudState === "failed" ? (
                                            <CloudOff size={16} />
                                          ) : (
                                            <CloudUpload size={16} />
                                          )}
                                        </span>
                                        <div className="player-video-menu">
                                          <button
                                            type="button"
                                            className="icon-button"
                                            aria-haspopup="menu"
                                            aria-expanded={menuOpen}
                                            aria-label={t("Video options")}
                                            title={t("Video options")}
                                            onClick={() =>
                                              setOpenSavedVideoMenuId(menuOpen ? null : video.savedVideoId)
                                            }
                                          >
                                            <ClarityMore size={16} />
                                          </button>
                                          {menuOpen ? (
                                            <AnchoredMenu onClose={closeMenu} closeLabel={t("Close video options")}>
                                                <button
                                                  type="button"
                                                  role="menuitem"
                                                  onClick={() => {
                                                    closeMenu();
                                                    playVideo();
                                                  }}
                                                >
                                                  <Play size={14} />{t("Play")}</button>
                                                {(["export", "share"] as const).map((action) => (
                                                  <button type="button" role="menuitem" key={action} onPointerEnter={action === "share" ? () => warmLibraryShare(video.savedVideoId, videoRawTitle) : undefined} onFocus={action === "share" ? () => warmLibraryShare(video.savedVideoId, videoRawTitle) : undefined} onClick={() => {
                                                    closeMenu();
                                                    deliverLibraryVideo(video.savedVideoId, videoRawTitle, action);
                                                  }}>{action === "export" ? <Download size={14} /> : <Share2 size={14} />}{action === "export" ? t("Export") : t("Share")}</button>
                                                ))}
                                                {cloudOperational && canRetryCloud ? (
                                                  <button
                                                    type="button"
                                                    role="menuitem"
                                                    onClick={() => {
                                                      closeMenu();
                                                      void sendSavedVideoToPrimaryComputer(video);
                                                    }}
                                                  >
                                                    <Send size={14} />
                                                    {sendLabel}
                                                  </button>
                                                ) : null}
                                                {cloudOperational &&
                                                portalPlayers.some(
                                                  (entry) =>
                                                    entry.personId === notesWorkspaceClient.id &&
                                                    entry.status !== "disabled",
                                                ) ? (
                                                  <button
                                                    type="button"
                                                    role="menuitem"
                                                    onClick={() => {
                                                      closeMenu();
                                                      void sendSavedVideoToPlayer(
                                                        video,
                                                        notesWorkspaceClient.id,
                                                      );
                                                    }}
                                                  >
                                                    <Send size={14} />{t("Send to player")}</button>
                                                ) : null}
                                                {canPause ? (
                                                  <button
                                                    type="button"
                                                    role="menuitem"
                                                    onClick={() => {
                                                      closeMenu();
                                                      void pauseSavedVideoTransfer(video);
                                                    }}
                                                  >
                                                    <Pause size={14} />{t("Pause upload")}</button>
                                                ) : null}
                                                {canCancel ? (
                                                  <button
                                                    type="button"
                                                    role="menuitem"
                                                    onClick={() => {
                                                      closeMenu();
                                                      void cancelSavedVideoTransfer(video);
                                                    }}
                                                  >
                                                    <X size={14} />{t("Cancel upload")}</button>
                                                ) : null}
                                                {canRemoveTransfer ? (
                                                  <button
                                                    type="button"
                                                    role="menuitem"
                                                    onClick={() => {
                                                      closeMenu();
                                                      void removeSavedVideoTransfer(video);
                                                    }}
                                                  >
                                                    <X size={14} />{t("Clear failed upload")}</button>
                                                ) : null}
                                                {hasDeviceCopy && video.local.managed?.status !== "healthy" ? (
                                                  <button
                                                    type="button"
                                                    role="menuitem"
                                                    onClick={() => {
                                                      closeMenu();
                                                      void showSavedVideoInFinder(video);
                                                    }}
                                                  >
                                                    <ClarityFilesMedia size={14} />{t("Keep a copy in My Library")}</button>
                                                ) : null}
                                                {hasDeviceCopy ? (
                                                  <button
                                                    type="button"
                                                    role="menuitem"
                                                    onClick={() => {
                                                      closeMenu();
                                                      void revealSavedVideoFile(video);
                                                    }}
                                                  >
                                                    <ExternalLink size={14} />{t("Open stored file")}</button>
                                                ) : null}
                                                {hasDeviceCopy ? (
                                                  <button
                                                    type="button"
                                                    role="menuitem"
                                                    onClick={() => {
                                                      closeMenu();
                                                      void verifySavedVideoInLibrary(video);
                                                    }}
                                                  >
                                                    <Check size={14} />{t("Verify file")}</button>
                                                ) : null}
                                                {canRemoveFromDevice ? (
                                                  <button
                                                    type="button"
                                                    role="menuitem"
                                                    onClick={() => {
                                                      closeMenu();
                                                      void removeSavedVideoFromDevice(video);
                                                    }}
                                                  >
                                                    <X size={14} />{t("Free up space on this device")}</button>
                                                ) : null}
                                                <button
                                                  type="button"
                                                  role="menuitem"
                                                  onClick={() => {
                                                    closeMenu();
                                                    void renameSavedVideo(video);
                                                  }}
                                                >
                                                  <Pencil size={14} />{t("Rename")}</button>
                                                <button type="button" role="menuitem" onClick={() => {
                                                  closeMenu();
                                                  void retireLibraryEntry(video.savedVideoId, video.title, video.playerId);
                                                }}>{t("Remove unavailable entry")}</button>
                                                <button
                                                  type="button"
                                                  role="menuitem"
                                                  className="is-danger"
                                                  onClick={() => {
                                                    closeMenu();
                                                    void deleteSavedVideo(video);
                                                  }}
                                                >
                                                  <Trash2 size={14} />{t("Delete")}</button>
                                            </AnchoredMenu>
                                          ) : null}
                                        </div>
                                      </div>
                                    </article>
                                  );
                                  };
                                  if (angles.length === 1) return renderSavedVideoCard(angles[0]);
                                  // Two cameras on one swing: one package, opened together.
                                  return (
                                    <div className="player-video-pair" key={`pair-${angles[0].savedVideoId}`}>
                                      <div className="player-video-pair-head">
                                        <strong>{t("Same swing · 2 angles")}</strong>
                                        <button
                                          type="button"
                                          className="outline-button"
                                          onClick={() =>
                                            openVideoAnalysisForClient({
                                              id: angles[0].playerId,
                                              name: notesWorkspaceClient.name,
                                              savedVideoId: angles[0].savedVideoId,
                                              pairedSavedVideoId: angles[1].savedVideoId,
                                            })
                                          }
                                        >
                                          <Play size={14} />{t("Open both")}</button>
                                      </div>
                                      {angles.map(renderSavedVideoCard)}
                                    </div>
                                  );
                                })}
                                {playerToolCloudVideos.map((transfer) => {
                                  const savedVideo = transfer.savedVideo;
                                  const savedVideoId = transfer.savedVideoId || savedVideo?.savedVideoId || transfer.transferId;
                                  const timestamp = savedVideo?.updatedAt || savedVideo?.createdAt || transfer.readyToImportAt || "";
                                  const isDownloading = clarityCloudImportActionIds.has(savedVideoId);
                                  const cloudVideoTitle = profileRecordTitle(notesWorkspaceClient.name, timestamp);
                                  const cloudVideoRawTitle = savedVideo?.title || cloudVideoTitle;
                                  // A player submission is someone waiting on you, not your
                                  // own library syncing. It reads differently and keeps an
                                  // unseen dot until you open it.
                                  const isSubmission = transfer.direction === "player-submission";
                                  const isUnseen = isSubmission && !transfer.coachSeenAt;
                                  // A return is the coach's own outgoing video. It carries
                                  // the mirror of the dot above -- whether the player has
                                  // opened it -- which is the only thing the coach cannot
                                  // find out any other way.
                                  const isReturn = transfer.direction === "coach-return";
                                  return (
                                    <article
                                      className={`player-video-card is-cloud-only${isSubmission ? " is-player-submission" : ""}${isReturn ? " is-coach-return" : ""}${isUnseen ? " is-unseen" : ""}`}
                                      key={savedVideoId}
                                    >
                                      <button
                                        type="button"
                                        className="player-video-thumb-button"
                                        disabled={isDownloading}
                                        title={isDownloading ? t("Downloading from Clarity Cloud") : t("Play video")}
                                        aria-label={isDownloading ? t("Downloading from Clarity Cloud") : t("Play video")}
                                        onClick={() => void openPlayerSubmissionOrCloudVideo(transfer, notesWorkspaceClient.name)}
                                      >
                                        <img className="player-video-thumb" src={transfer.savedVideo?.thumbnailDataUrl || VIDEO_THUMBNAIL_PLACEHOLDER} alt="" loading="lazy" decoding="async" />
                                        <span className="player-video-thumb-play" aria-hidden="true">
                                          {isDownloading ? <Download size={14} /> : <Play size={14} />}
                                        </span>
                                      </button>
                                      <div className="player-video-card-body">
                                        <strong title={cloudVideoRawTitle !== cloudVideoTitle ? cloudVideoRawTitle : undefined}>
                                          {cloudVideoTitle}
                                        </strong>
                                        {isSubmission && (
                                          <span className="player-video-submission-meta">
                                            {isUnseen ? t("New · ") : ""}{t("Sent by")}{" "}{transfer.submittedByName || notesWorkspaceClient.name}
                                          </span>
                                        )}
                                        {isSubmission && transfer.playerMessage && (
                                          <span className="player-video-submission-note">
                                            “{transfer.playerMessage}”
                                          </span>
                                        )}
                                        {isReturn && (
                                          <span className="player-video-submission-meta">{t("Sent to {name} ·", { name: notesWorkspaceClient.name })}{" "}{transfer.playerSeenAt ? "opened" : "not opened yet"}
                                          </span>
                                        )}
                                        {isReturn && transfer.coachMessage && (
                                          <span className="player-video-submission-note">
                                            “{transfer.coachMessage}”
                                          </span>
                                        )}
                                      </div>
                                      <div className="player-video-card-actions">
                                          <button type="button" className="outline-button" onClick={() => void retireLibraryEntry(savedVideoId, cloudVideoRawTitle, savedVideo?.playerId || preferredVideoPlayerId(notesWorkspaceClient, videoPlayerIds))}>{t("Remove unavailable entry")}</button>

                                        <span
                                          className="player-video-cloud-badge is-saved"
                                          title={t("Saved in Clarity Cloud")}
                                          aria-label={t("Saved in Clarity Cloud")}
                                          role="img"
                                        >
                                          <Cloud size={16} />
                                        </span>
                                      </div>
                                    </article>
                                  );
                                })}
                                {playerToolLegacyVideoRecords.map((record) => (
                                  <article className="player-video-card is-legacy" key={record.slotKey}>
                                    <div className="player-video-thumb is-empty">
                                      <Archive size={16} />
                                    </div>
                                    <div className="player-video-card-body">
                                      <strong>{t("Recovery copy -")}{" "}{record.video.title || t("Video")}</strong>
                                      <span>{t("Safe to remove after saving · {duration} · Move to Saved Videos to keep it in the durable library", { duration: formatVideoDurationLabel(record.video.duration) })}</span>
                                    </div>
                                    <div className="player-video-card-actions">
                                      <button
                                        type="button"
                                        className="outline-button"
                                        onClick={() => void migrateLegacyVideo(record)}
                                      >
                                        <Archive size={14} />{t("Move to Saved Videos")}</button>
                                    </div>
                                  </article>
                                ))}
                              </>
                            ) : (
                              <p className="notes-empty">{t("No videos yet.")}</p>
                            )}
                          </div>
                          )}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
          {!playerProfilesDataReady ? (
            <div className="player-profiles-progress" role="status" aria-live="polite">
              <span className="player-profiles-progress-dot" aria-hidden="true" />
              <span>{t("Updating player activity")}<small>
                  {[
                    !playerProfilesSourcesReady.people ? "clients" : "",
                    !playerProfilesSourcesReady.notes ? "lesson notes" : "",
                    !playerProfilesSourcesReady.portal ? "portal access" : "",
                    !playerProfilesSourcesReady.videos ? "videos" : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
              </span>
            </div>
          ) : null}
        </div>
      </div>
      {videoDeliveryDialog}
    </section>
  );
}

export type PlayerAddDialogProps = {
  playerAddForVideoSave: boolean;
  playerAddSearch: string;
  playerAddNew: { name: string; email: string; phone: string; };
  setPlayerAddNew: Dispatch<SetStateAction<{ name: string; email: string; phone: string; }>>;
  closePlayerAddDialog: (chosen?: Pick<Person, "id" | "name" | "email" | "phone"> | null) => void;
  playerAddSaving: boolean;
  setPlayerAddSearch: Dispatch<SetStateAction<string>>;
  clients: ClientSummary[];
  playerProfiles: ClientSummary[];
  promoteExistingPlayer: (client: Pick<Person, "id" | "name" | "email" | "phone">) => void;
  createNewPlayer: () => Promise<void>;
};

/** The "Add player" dialog. Opened from the screen above, and from a video save
 * that needs a player to belong to, so it is rendered on its own. */
export function PlayerAddDialog(props: PlayerAddDialogProps) {
  const {
    playerAddForVideoSave,
    playerAddSearch,
    playerAddNew,
    setPlayerAddNew,
    closePlayerAddDialog,
    playerAddSaving,
    setPlayerAddSearch,
    clients,
    playerProfiles,
    promoteExistingPlayer,
    createNewPlayer,
  } = props;
  return (
    <div
      className="player-add-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={playerAddForVideoSave ? t("Save video to a player") : t("Add player profile")}
      onClick={() => closePlayerAddDialog()}
    >
      <div className="player-add-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="player-add-header">
          <h3>{playerAddForVideoSave ? t("Who is this video for?") : t("Add player profile")}</h3>
          <button
            type="button"
            className="icon-button"
            onClick={() => closePlayerAddDialog()}
            aria-label={t("Close")}
          >
            <X size={16} />
          </button>
        </div>

        <div className="player-add-section">
          <label>{playerAddForVideoSave ? t("Pick a player") : t("Add an existing client")}</label>
          <input
            value={playerAddSearch}
            onChange={(event) => setPlayerAddSearch(event.target.value)}
            placeholder={playerAddForVideoSave ? t("Search players and clients") : t("Search clients")}
          />
          <div className="player-add-results">
            {(playerAddSearch.trim().length > 0
              ? clients.filter((client) => clientMatchesSearchTerm(client, playerAddSearch.trim()))
              : playerAddForVideoSave
                ? playerProfiles
                : []
            )
                .slice(0, playerAddForVideoSave ? 20 : 6)
                .map((client) => (
                  <button
                    type="button"
                    key={client.id}
                    className="player-add-result"
                    onClick={() => promoteExistingPlayer(client)}
                  >
                    <span>{client.name}</span>
                    <span className="muted">{client.email || client.phone}</span>
                  </button>
                ))}
          </div>
        </div>

        <div className="player-add-divider">
          {playerAddForVideoSave ? "or create a new player" : "or add someone new"}
        </div>

        <div className="player-add-section">
          <input
            value={playerAddNew.name}
            onChange={(event) =>
              setPlayerAddNew((current) => ({ ...current, name: event.target.value }))
            }
            placeholder={t("Name")}
          />
          <input
            value={playerAddNew.email}
            onChange={(event) =>
              setPlayerAddNew((current) => ({ ...current, email: event.target.value }))
            }
            placeholder={t("Email")}
          />
          <input
            value={playerAddNew.phone}
            onChange={(event) =>
              setPlayerAddNew((current) => ({ ...current, phone: event.target.value }))
            }
            placeholder={t("Phone")}
          />
          <button
            type="button"
            className="primary-button"
            disabled={playerAddSaving}
            onClick={createNewPlayer}
          >
            {playerAddSaving
              ? t("Adding…")
              : playerAddForVideoSave
                ? t("Create player and save")
                : t("Add new player")}
          </button>
        </div>
      </div>
    </div>
  );
}
