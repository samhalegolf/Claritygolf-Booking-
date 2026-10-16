// Settings › Developer › Video storage: the local library, Clarity Cloud and
// their diagnostics. This group used to share its id with the Google Calendar
// group under Booking, so a link to one could land on the other.
import { t } from "../../lib/i18n";
import { Archive, ArrowRight, Check, Copy, Download, ExternalLink, RefreshCw, Upload, X } from "lucide-react";
import { ClarityAccessPermissions, ClarityAdmin, ClarityCalendarSync, ClarityFilesMedia, ClarityVideoAnalysis } from "../shared/ClarityIcons";
import { SettingsGroup } from "./SettingsLayout";
import { profileRecordDateLabel } from "../player-profiles/profileFormat";
import { getClarityCloudActionLabel, getLocalStorageActionLabel } from "../../storageHealth";
import type { ClarityCloudAction, ClarityCloudHealth, GoogleDriveTransferStatus, LocalStorageAction, LocalStorageHealth } from "../../storageHealth";
import type { CalendarFeedStatus, CalendarItem, CalendarSaveStatus } from "../calendar/calendarModel";
import type { ClarityCloudImportTransfer, ManagedLocalVideoLibraryStatus } from "../video-analysis/utils/savedVideoLibrary";
import type { CoachAccount } from "../workspace/workspaceModel";
import type { GoogleDriveActionState } from "./googleCalendarTypes";
import type { Dispatch, SetStateAction } from "react";

export type VideoStoragePanelProps = {
  googleDriveTransfer: GoogleDriveTransferStatus;
  managedLocalLibraryStatus: ManagedLocalVideoLibraryStatus;
  clarityCloudHealth: ClarityCloudHealth;
  googleDriveAction: GoogleDriveActionState;
  localStorageHealth: LocalStorageHealth;
  copiedSync: "url" | "key" | null;
  localStoragePrimaryAction: "choose-folder" | "reconnect-folder" | "locate-library" | undefined;
  clarityCloudPrimaryAction: "connect" | "grant-permission" | "reconnect" | "open-setup-details" | "retry-setup" | "retry" | undefined;
  calendarFeedStatus: CalendarFeedStatus;
  clarityCloudImports: ClarityCloudImportTransfer[];
  clarityCloudImportActionIds: Set<string>;
  portalPlayerBusyId: string;
  calendarFeedUrl: string;
  items: CalendarItem[];
  copySyncText: (kind: "url" | "key") => void;
  storageDiagnosticsOpen: boolean;
  setStorageDiagnosticsOpen: Dispatch<SetStateAction<boolean>>;
  calendarSaveStatus: CalendarSaveStatus;
  calendarSaveError: string;
  syncBaseUrl: string;
  setSyncBaseUrl: Dispatch<SetStateAction<string>>;
  coachAccount: CoachAccount;
  regenerateSyncKey: () => void;
  runManagedLibraryAction: (action: "choose" | "reconnect" | "move" | "verify" | "rescan" | "migrate") => Promise<void>;
  runLocalStorageHealthAction: (action?: LocalStorageAction) => Promise<void>;
  runClarityCloudHealthAction: (action?: ClarityCloudAction) => Promise<void>;
  refreshClarityCloudImports: () => Promise<void>;
  addGuestAsPlayer: (transfer: ClarityCloudImportTransfer) => Promise<void>;
  importClarityCloudTransfer: (transfer: ClarityCloudImportTransfer) => Promise<void>;
  connectGoogleDriveTransfer: () => Promise<void>;
  testGoogleDriveTransfer: () => Promise<void>;
  disconnectGoogleDriveTransfer: () => Promise<void>;
};

export function VideoStoragePanel(props: VideoStoragePanelProps) {
  const {
    googleDriveTransfer,
    managedLocalLibraryStatus,
    clarityCloudHealth,
    googleDriveAction,
    localStorageHealth,
    copiedSync,
    localStoragePrimaryAction,
    clarityCloudPrimaryAction,
    calendarFeedStatus,
    clarityCloudImports,
    clarityCloudImportActionIds,
    portalPlayerBusyId,
    calendarFeedUrl,
    items,
    copySyncText,
    storageDiagnosticsOpen,
    setStorageDiagnosticsOpen,
    calendarSaveStatus,
    calendarSaveError,
    syncBaseUrl,
    setSyncBaseUrl,
    coachAccount,
    regenerateSyncKey,
    runManagedLibraryAction,
    runLocalStorageHealthAction,
    runClarityCloudHealthAction,
    refreshClarityCloudImports,
    addGuestAsPlayer,
    importClarityCloudTransfer,
    connectGoogleDriveTransfer,
    testGoogleDriveTransfer,
    disconnectGoogleDriveTransfer,
  } = props;
  return (
    <SettingsGroup id="video-storage" icon={ClarityVideoAnalysis} section="developer" title={t("Video storage")} className="sync-card">

      <section className="settings-subsection video-storage-section" aria-labelledby="video-storage-heading">
        <div className="video-storage-heading">
          <div>
            <span>{t("VIDEO STORAGE")}</span>
            <h3 id="video-storage-heading">{t("My Library and Clarity Cloud")}</h3>
          </div>
          <ClarityVideoAnalysis size={20} />
        </div>

        <div className="video-storage-grid">
          <article className={`storage-card is-${localStorageHealth.state}`}>
            <div className="storage-card-header">
              <ClarityFilesMedia size={18} />
              <div>
                <span>{t("My Library")}</span>
                <strong>{localStorageHealth.statusLabel}</strong>
              </div>
            </div>
            <p>{localStorageHealth.message}</p>
            <span className="storage-provider-line">{localStorageHealth.detail}</span>
            {localStoragePrimaryAction ? (
              <button
                className="primary-button"
                disabled={!managedLocalLibraryStatus.supported}
                onClick={() => void runLocalStorageHealthAction(localStoragePrimaryAction)}
                type="button"
              >
                <ClarityFilesMedia size={16} />
                {getLocalStorageActionLabel(localStoragePrimaryAction)}
              </button>
            ) : null}
          </article>

          <article className={`storage-card is-${clarityCloudHealth.state}`}>
            <div className="storage-card-header">
              <Upload size={18} />
              <div>
                <span>{t("Clarity Cloud")}</span>
                <strong>{clarityCloudHealth.statusLabel}</strong>
              </div>
            </div>
            <p>{clarityCloudHealth.message}</p>
            <span className="storage-provider-line">{t("Powered by {providerLabel}", { providerLabel: clarityCloudHealth.providerLabel })}</span>
            {clarityCloudPrimaryAction ? (
              <button
                className="primary-button"
                disabled={googleDriveAction !== "idle"}
                onClick={() => void runClarityCloudHealthAction(clarityCloudPrimaryAction)}
                type="button"
              >
                <ExternalLink size={16} />
                {googleDriveAction === "connecting"
                  ? t("Opening provider")
                  : googleDriveAction === "testing"
                    ? t("Checking")
                    : getClarityCloudActionLabel(clarityCloudPrimaryAction)}
              </button>
            ) : null}
          </article>
        </div>

        <section className="storage-transfer-inbox" aria-label={t("Clarity Cloud catalogue")}>
          <div className="storage-transfer-inbox-header">
            <div>
              <span>{t("CLARITY CLOUD CATALOGUE")}</span>
              <h4>{t("Available in Clarity Cloud")}</h4>
            </div>
            <button
              type="button"
              className="outline-button"
              disabled={!googleDriveTransfer.connected || !googleDriveTransfer.incomingImportReady}
              onClick={() => void refreshClarityCloudImports()}
            >
              <RefreshCw size={16} />{t("Refresh")}</button>
          </div>
          {clarityCloudImports.length ? (
            <div className="storage-transfer-list">
              {clarityCloudImports.map((transfer) => {
                const savedVideoId = transfer.savedVideoId || transfer.savedVideo?.savedVideoId || transfer.transferId;
                const statusLabel =
                  transfer.catalogueStatus === "complete"
                    ? t("Available")
                    : transfer.catalogueStatus === "imported" || transfer.catalogueStatus === "cleanup_scheduled"
                      ? t("Available on this device")
                      : transfer.catalogueStatus === "repair_required"
                        ? t("Needs repair")
                        : t("Available");
                const canImport =
                  (transfer.catalogueStatus === "ready_to_import" ||
                    transfer.catalogueStatus === "complete" ||
                    transfer.catalogueStatus === "cleanup_scheduled") &&
                  !clarityCloudImportActionIds.has(savedVideoId);
                // Someone with no account sent this. It is unclaimed
                // until the coach adds them, and it expires if they
                // never do.
                const isGuestSubmission = transfer.direction === "guest-submission";
                const guestUnclaimed = isGuestSubmission && !transfer.claimedAt;
                return (
                  <article
                    className={`storage-transfer-row${isGuestSubmission ? " is-guest-submission" : ""}`}
                    key={savedVideoId}
                  >
                    <div className="storage-transfer-icon">
                      <Download size={16} />
                    </div>
                    <div className="storage-transfer-copy">
                      <strong>{transfer.savedVideo?.title || t("Saved video")}</strong>
                      <span>
                        {statusLabel}
                        {transfer.savedVideo?.createdAt ? ` · ${profileRecordDateLabel(transfer.savedVideo.createdAt)}` : ""}
                        {transfer.video?.sizeBytes ? t(" · {value} MB", { value: Math.round(transfer.video.sizeBytes / 1024 / 1024) }) : ""}
                      </span>
                      {isGuestSubmission && (
                        <>
                          {/* Say plainly that none of this was checked. */}
                          <span>{t("Sent by")}{" "}{transfer.submittedByName || "someone"}
                            {transfer.submittedByEmail ? ` · ${transfer.submittedByEmail}` : ""}
                            {guestUnclaimed ? t(" · no account yet") : ""}
                          </span>
                          {transfer.playerMessage && <span>“{transfer.playerMessage}”</span>}
                          {guestUnclaimed && transfer.cleanupAfter && (
                            <span>{t("Expires {cleanupAfter} unless you add them.", { cleanupAfter: profileRecordDateLabel(transfer.cleanupAfter) })}</span>
                          )}
                        </>
                      )}
                    </div>
                    {guestUnclaimed && (
                      <button
                        type="button"
                        className="outline-button"
                        disabled={Boolean(portalPlayerBusyId)}
                        onClick={() => void addGuestAsPlayer(transfer)}
                      >
                        {portalPlayerBusyId === transfer.guestSenderId ? t("Adding") : t("Add as player")}
                      </button>
                    )}
                    <button
                      type="button"
                      className="primary-button"
                      disabled={!canImport}
                      onClick={() => void importClarityCloudTransfer(transfer)}
                    >
                      <Download size={16} />
                      {clarityCloudImportActionIds.has(savedVideoId) ? t("Downloading") : t("Download to this device")}
                    </button>
                  </article>
                );
              })}
            </div>
          ) : (
            <p className="storage-transfer-empty">
              {googleDriveTransfer.connected
                ? t("No Cloud videos are available yet.")
                : t("Connect Clarity Cloud to see transfers from other devices.")}
            </p>
          )}
        </section>

        <details
          className="storage-diagnostics"
          open={storageDiagnosticsOpen}
          onToggle={(event) => setStorageDiagnosticsOpen(event.currentTarget.open)}
        >
          <summary className="settings-subsection-title">
            <ClarityAdmin size={18} />
            <div>
              <span>{t("Advanced storage diagnostics")}</span>
              <strong>{t("Local Storage and Clarity Cloud")}</strong>
            </div>
          </summary>
          <div className="storage-diagnostics-grid">
            <div className="storage-diagnostics-group">
              <h4>{t("Local Storage")}</h4>
              <div className="sync-meta">
                <span>{t("Browser support")}</span>
                <strong>{managedLocalLibraryStatus.supported ? t("Supported") : "Browser-only"}</strong>
              </div>
              <div className="sync-meta">
                <span>{t("Directory handle")}</span>
                <strong>{managedLocalLibraryStatus.configured ? t("Available") : t("Not selected")}</strong>
              </div>
              <div className="sync-meta">
                <span>{t("Verification")}</span>
                <strong>{managedLocalLibraryStatus.health === "healthy" ? t("Write/read passed") : managedLocalLibraryStatus.message}</strong>
              </div>
              <div className="sync-meta">
                <span>{t("Cache state")}</span>
                <strong>{t("IndexedDB recovery enabled")}</strong>
              </div>
              <div className="sync-meta">
                <span>{t("Safe error code")}</span>
                <strong>{"safeErrorCode" in localStorageHealth && localStorageHealth.safeErrorCode ? localStorageHealth.safeErrorCode : t("None")}</strong>
              </div>
              <div className="sync-actions">
                <button
                  className="outline-button"
                  disabled={!managedLocalLibraryStatus.supported}
                  onClick={() => void runManagedLibraryAction("choose")}
                  type="button"
                >
                  <ClarityFilesMedia size={16} />{t("Change folder")}</button>
                <button
                  className="outline-button"
                  disabled={!managedLocalLibraryStatus.supported}
                  onClick={() => void runManagedLibraryAction("move")}
                  type="button"
                >
                  <ArrowRight size={16} />{t("Move library")}</button>
                <button
                  className="outline-button"
                  disabled={!managedLocalLibraryStatus.configured}
                  onClick={() => void runManagedLibraryAction("reconnect")}
                  type="button"
                >
                  <RefreshCw size={16} />{t("Reconnect handle")}</button>
                <button
                  className="outline-button"
                  disabled={!managedLocalLibraryStatus.configured}
                  onClick={() => void runManagedLibraryAction("verify")}
                  type="button"
                >
                  <Check size={16} />{t("Verify library")}</button>
                <button
                  className="outline-button"
                  disabled={!managedLocalLibraryStatus.configured}
                  onClick={() => void runManagedLibraryAction("rescan")}
                  type="button"
                >
                  <RefreshCw size={16} />{t("Rescan library")}</button>
                <button
                  className="outline-button"
                  disabled={!managedLocalLibraryStatus.configured}
                  onClick={() => void runManagedLibraryAction("migrate")}
                  type="button"
                >
                  <Archive size={16} />{t("Migrate cache")}</button>
              </div>
            </div>

            <div className="storage-diagnostics-group">
              <h4>{t("Clarity Cloud")}</h4>
              <div className="sync-meta">
                <span>{t("Provider")}</span>
                <strong>{clarityCloudHealth.providerLabel}</strong>
              </div>
              <div className="sync-meta">
                <span>{t("OAuth connection")}</span>
                <strong>{googleDriveTransfer.connected ? googleDriveTransfer.accountEmail || t("Connected") : t("Not connected")}</strong>
              </div>
              <div className="sync-meta">
                <span>{t("Permission")}</span>
                <strong>{googleDriveTransfer.driveScopeGranted ? t("Granted") : t("Required")}</strong>
              </div>
              <div className="sync-meta">
                <span>{t("Transfer folder")}</span>
                <strong>{googleDriveTransfer.inboxFolderId ? t("Ready") : t("Not ready")}</strong>
              </div>
              <div className="sync-meta">
                <span>{t("Upload service")}</span>
                <strong>{googleDriveTransfer.uploadRouteReady === false ? t("Unavailable") : t("Available")}</strong>
              </div>
              <div className="sync-meta">
                <span>{t("Chunked transport")}</span>
                <strong>{googleDriveTransfer.chunkedTransportReady === false ? t("Unavailable") : t("Available")}</strong>
              </div>
              <div className="sync-meta">
                <span>{t("Incoming import")}</span>
                <strong>{googleDriveTransfer.incomingImportReady ? t("Ready") : t("Next step")}</strong>
              </div>
              <div className="sync-meta">
                <span>{t("Safe error code")}</span>
                <strong>{"safeErrorCode" in clarityCloudHealth && clarityCloudHealth.safeErrorCode ? clarityCloudHealth.safeErrorCode : t("None")}</strong>
              </div>
              <div className="sync-meta">
                <span>{t("Missing configuration")}</span>
                <strong>{googleDriveTransfer.missingConfiguration?.length ? googleDriveTransfer.missingConfiguration.join(", ") : t("None")}</strong>
              </div>
              <div className="sync-actions">
                <button
                  className="outline-button"
                  disabled={googleDriveAction !== "idle"}
                  onClick={connectGoogleDriveTransfer}
                  type="button"
                >
                  <ExternalLink size={16} />
                  {googleDriveTransfer.connected ? t("Reconnect provider") : t("Connect provider")}
                </button>
                <button
                  className="outline-button"
                  disabled={googleDriveAction !== "idle"}
                  onClick={testGoogleDriveTransfer}
                  type="button"
                >
                  <RefreshCw size={16} />
                  {googleDriveAction === "testing" ? t("Testing") : t("Test connection")}
                </button>
                <button
                  className="outline-button"
                  disabled={!googleDriveTransfer.inboxFolderId && !googleDriveTransfer.rootFolderId}
                  onClick={() => {
                    const folderId = googleDriveTransfer.inboxFolderId || googleDriveTransfer.rootFolderId;
                    if (folderId) {
                      window.open(`https://drive.google.com/drive/folders/${folderId}`, "_blank", "noopener,noreferrer");
                    }
                  }}
                  type="button"
                >
                  <ExternalLink size={16} />{t("Open transfer inbox")}</button>
                <button
                  className="danger-button"
                  disabled={googleDriveAction !== "idle" || !googleDriveTransfer.connected}
                  onClick={disconnectGoogleDriveTransfer}
                  type="button"
                >
                  <X size={16} />
                  {googleDriveAction === "disconnecting" ? t("Disconnecting") : t("Disconnect provider")}
                </button>
              </div>
            </div>
          </div>
        </details>
      </section>

      <div className={`sync-status ${calendarFeedStatus}`}>
        <span>{t("Feed endpoint")}</span>
        <strong>
          {calendarFeedStatus === "connected"
            ? calendarSaveStatus === "failed"
              ? t("Connected — save needs retry")
              : t("Connected")
            : calendarFeedStatus === "checking"
              ? t("Checking")
              : t("Offline")}
        </strong>
        <em>{calendarSaveError || calendarFeedUrl}</em>
      </div>
      <details className="settings-subsection">
        <summary className="settings-subsection-title">
          <ClarityAccessPermissions size={18} />
          <div>
            <span>{t("Google Calendar")}</span>
            <strong>
              {items.filter((item) => item.kind === "appointment").length}{" "}{t("appointments,")}{" "}{items.filter((item) => item.kind === "block").length}{" "}{t("busy blocks")}</strong>
          </div>
        </summary>
        <label className="sync-field">
          <span>{t("Live booking app URL")}</span>
          <input
            value={syncBaseUrl}
            onChange={(event) => setSyncBaseUrl(event.target.value)}
            placeholder={coachAccount.bookingUrl}
          />
        </label>

        <div className="sync-output">
          <span>{t("Subscription URL")}</span>
          <code>{calendarFeedUrl}</code>
        </div>

        <div className="sync-actions">
          <button className="outline-button" onClick={() => copySyncText("url")}>
            {copiedSync === "url" ? <Check size={16} /> : <Copy size={16} />}
            {copiedSync === "url" ? t("Copied URL") : t("Copy URL")}
          </button>
          <button className="outline-button" onClick={() => copySyncText("key")}>
            {copiedSync === "key" ? <Check size={16} /> : <ClarityAccessPermissions size={16} />}
            {copiedSync === "key" ? t("Copied key") : t("Copy key")}
          </button>
          <button className="outline-button" onClick={regenerateSyncKey}>
            <RefreshCw size={16} />{t("Regenerate")}</button>
          <a
            className="outline-button"
            href="https://calendar.google.com/calendar/u/0/r/settings/addbyurl"
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={16} />{t("Google")}</a>
        </div>
      </details>
    </SettingsGroup>
  );
}
