// Settings › Booking › Booking page: notice, policy and the look of the public page.
import { t, tn } from "../../lib/i18n";
import { EditableSettingsBlock, SettingsGroup } from "./SettingsLayout";
import { ClarityAdmin, ClarityBookingPages, ClaritySessions } from "../shared/ClarityIcons";
import { Check, Copy, ExternalLink, Eye } from "lucide-react";
import { MIN_BOOKING_NOTICE_PRESETS_HOURS } from "./bookingNotice";
import type { NotificationSettings } from "../notifications/notificationSettings";
import type { CoachAccount } from "../workspace/workspaceModel";
import type { EditableBlockStatus } from "./SettingsLayout";
import type { Dispatch, SetStateAction } from "react";

export type BookingSettingsPanelProps = {
  selectedBookingScreen: { label: string; publicUrl: string; iframeCode: string; id: string; path: string; };
  bookingScreenNameEditor: { savedValue: Record<string, string>; draftValue: Record<string, string>; status: EditableBlockStatus; dirty: boolean; errorMessage: string | null; edit: () => void; cancel: () => void; setDraftValue: (next: Record<string, string> | ((current: Record<string, string>) => Record<string, string>)) => void; save: () => Promise<boolean>; };
  lookBusyEditor: { savedValue: NotificationSettings; draftValue: NotificationSettings; status: EditableBlockStatus; dirty: boolean; errorMessage: string | null; edit: () => void; cancel: () => void; setDraftValue: (next: NotificationSettings | ((current: NotificationSettings) => NotificationSettings)) => void; save: () => Promise<boolean>; };
  bookingNoticeEditor: { savedValue: NotificationSettings; draftValue: NotificationSettings; status: EditableBlockStatus; dirty: boolean; errorMessage: string | null; edit: () => void; cancel: () => void; setDraftValue: (next: NotificationSettings | ((current: NotificationSettings) => NotificationSettings)) => void; save: () => Promise<boolean>; };
  startEditableBlock: (id: string) => void;
  cancelEditableBlock: (id: string) => void;
  bookingNoticeIsLocked: boolean;
  updateBookingNoticeHours: (hours: number) => void;
  lookBusy: boolean;
  copyBookingScreenValue: (value: string, kind: "url" | "iframe", screenId: string) => void;
  copiedBookingScreenLinkId: string | null;
  copiedBookingScreenIframeId: string | null;
  bookingNoticeDraftSummary: string;
  bookingNoticeDraftHours: number;
  lookBusyIsLocked: boolean;
  updateNotificationBlockDraft: (editor: { savedValue: NotificationSettings; draftValue: NotificationSettings; status: EditableBlockStatus; dirty: boolean; errorMessage: string | null; edit: () => void; cancel: () => void; setDraftValue: (next: NotificationSettings | ((current: NotificationSettings) => NotificationSettings)) => void; save: () => Promise<boolean>; }, field: keyof NotificationSettings, value: NotificationSettings[keyof NotificationSettings]) => void;
  bookingScreenEmbeds: { label: string; publicUrl: string; iframeCode: string; id: string; path: string; }[];
  selectedBookingScreenId: string;
  confirmDiscardEditableBlock: (blockTitle: string) => boolean;
  setSelectedBookingScreenId: Dispatch<SetStateAction<string>>;
  bookingScreenNameDraft: Record<string, string>;
  bookingScreenNameIsLocked: boolean;
  coachAccount: CoachAccount;
  saveEditableBlock: (id: string) => Promise<void>;
};

export function BookingSettingsPanel(props: BookingSettingsPanelProps) {
  const {
    selectedBookingScreen,
    bookingScreenNameEditor,
    lookBusyEditor,
    bookingNoticeEditor,
    startEditableBlock,
    cancelEditableBlock,
    bookingNoticeIsLocked,
    updateBookingNoticeHours,
    lookBusy,
    copyBookingScreenValue,
    copiedBookingScreenLinkId,
    copiedBookingScreenIframeId,
    bookingNoticeDraftSummary,
    bookingNoticeDraftHours,
    lookBusyIsLocked,
    updateNotificationBlockDraft,
    bookingScreenEmbeds,
    selectedBookingScreenId,
    confirmDiscardEditableBlock,
    setSelectedBookingScreenId,
    bookingScreenNameDraft,
    bookingScreenNameIsLocked,
    coachAccount,
    saveEditableBlock,
  } = props;
  return (
    <SettingsGroup id="booking-page" icon={ClarityBookingPages} section="booking" title={t("Booking page")} className="booking-page-settings">
      <details className="settings-subsection">
        <summary className="settings-subsection-title">
          <Eye size={18} />
          <div>
            <span>{t("Preview")}</span>
            <strong>{t("As your device shows it")}</strong>
          </div>
        </summary>
        {/* The real booking page, not a copy of it: whatever a player sees on
            the selected booking screen is what shows here. A copy drifted every
            time the page changed. Anything booked here is a real booking. */}
        {selectedBookingScreen ? (
          <div className="booking-screen-preview booking-page-live-preview">
            <iframe
              src={selectedBookingScreen.publicUrl}
              title={`${coachAccount.businessName} ${selectedBookingScreen.label} preview`}
            />
            <p className="field-help">{t("This is your live booking page. Anything you book here is a real booking.")}</p>
          </div>
        ) : null}
      </details>
      <EditableSettingsBlock
        id="booking-page-notice-block"
        title={t("Booking Page notice")}
        status={bookingNoticeEditor.status}
        dirty={bookingNoticeEditor.dirty}
        errorMessage={bookingNoticeEditor.errorMessage}
        onEdit={() => startEditableBlock("booking-page-notice")}
        onCancel={() => cancelEditableBlock("booking-page-notice")}
        onSave={() => void saveEditableBlock("booking-page-notice")}
      >
      <details className="settings-subsection">
        <summary className="settings-subsection-title">
          <ClaritySessions size={18} />
          <div>
            <span>{t("Minimum notice before a public booking")}</span>
            <strong>{bookingNoticeDraftSummary}</strong>
          </div>
        </summary>
        <label className="settings-field">
          <span>{t("Minimum notice in hours")}</span>
          <input
            type="number"
            min={0}
            max={168}
            step={0.25}
            value={bookingNoticeDraftHours}
            readOnly={bookingNoticeIsLocked}
            onChange={(event) => updateBookingNoticeHours(Math.max(0, Number(event.target.value || 0)))}
          />
        </label>
        <p className="field-help">{t("Clients can only book or reschedule after that buffer.")}</p>
        <div className="minimum-notice-presets" aria-label={t("Quick notice presets")}>
          {MIN_BOOKING_NOTICE_PRESETS_HOURS.map((hours) => (
            <button
              className="outline-button"
              disabled={bookingNoticeIsLocked}
              key={hours}
              onClick={() => updateBookingNoticeHours(hours)}
              type="button"
            >
              {hours === 0 ? t("No buffer") : tn(hours, "{count} hour", "{count} hours")}
            </button>
          ))}
        </div>
        <button className="outline-button" disabled={bookingNoticeIsLocked} onClick={() => updateBookingNoticeHours(0)} type="button">{t("Clear buffer")}</button>
      </details>
      </EditableSettingsBlock>
      <EditableSettingsBlock
        id="booking-page-look-busy-block"
        title={t("Look busy")}
        status={lookBusyEditor.status}
        dirty={lookBusyEditor.dirty}
        errorMessage={lookBusyEditor.errorMessage}
        onEdit={() => startEditableBlock("booking-page-look-busy")}
        onCancel={() => cancelEditableBlock("booking-page-look-busy")}
        onSave={() => void saveEditableBlock("booking-page-look-busy")}
      >
      <details className="settings-subsection">
        <summary className="settings-subsection-title">
          <ClaritySessions size={18} />
          <div>
            <span>{t("Look busy")}</span>
            <strong>{lookBusy ? t("On — fewer gaps between lessons") : t("Off — every open time is shown")}</strong>
          </div>
        </summary>
        <label className="settings-toggle">
          <input
            checked={lookBusy}
            disabled={lookBusyIsLocked}
            onChange={(event) => updateNotificationBlockDraft(lookBusyEditor, "publicBookingLookBusy", event.target.checked)}
            type="checkbox"
          />
          <span>{t("Only offer times next to an existing booking or the start or end of your day")}</span>
        </label>
        <p className="field-help">{t("Your booking page shows fewer times, so your diary looks in demand and lessons book back to back instead of leaving gaps.")}</p>
      </details>
      </EditableSettingsBlock>
      <EditableSettingsBlock
        id="booking-screen-name-block"
        title={t("Booking Page screen name")}
        status={bookingScreenNameEditor.status}
        dirty={bookingScreenNameEditor.dirty}
        errorMessage={bookingScreenNameEditor.errorMessage}
        onEdit={() => startEditableBlock("booking-screen-name")}
        onCancel={() => cancelEditableBlock("booking-screen-name")}
        onSave={() => void saveEditableBlock("booking-screen-name")}
      >
              <details className="settings-subsection">
                <summary className="settings-subsection-title">
                  <ClarityAdmin size={18} />
                  <div>
                    <span>{t("Booking screen embeds")}</span>
                    <strong>{t("Squarespace iframe")}</strong>
                  </div>
                </summary>
              <div className="embed-panel">
                <div className="booking-screen-tabs" role="tablist" aria-label={t("Booking screen embeds")}>
                  {bookingScreenEmbeds.map((bookingScreen) => (
                    <button
                      className={`booking-screen-tab ${selectedBookingScreenId === bookingScreen.id ? "active" : ""}`}
                      key={bookingScreen.id}
                      onClick={() => {
                        if (bookingScreenNameEditor.dirty && !confirmDiscardEditableBlock(t("Booking Page screen name"))) return;
                        if (bookingScreenNameEditor.dirty) bookingScreenNameEditor.cancel();
                        setSelectedBookingScreenId(bookingScreen.id);
                      }}
                      type="button"
                    >
                      {bookingScreen.label}
                    </button>
                  ))}
                </div>
                {selectedBookingScreen && (
                  <div className="booking-screen-embed-card">
                    <label className="settings-field">
                      <span>{t("Screen name")}</span>
                      <input
                        value={bookingScreenNameDraft[selectedBookingScreen.id] || selectedBookingScreen.label}
                        readOnly={bookingScreenNameIsLocked}
                        onChange={(event) =>
                          bookingScreenNameEditor.setDraftValue((current) => ({
                            ...current,
                            [selectedBookingScreen.id]: event.target.value,
                          }))
                        }
                        type="text"
                      />
                    </label>
                    <div className="settings-field">
                      <span>{t("Slug")}</span>
                      <code className="booking-screen-slug">{selectedBookingScreen.path}</code>
                    </div>
                    <div className="settings-field">
                      <span>{t("Public link")}</span>
                      <code className="booking-screen-link">{selectedBookingScreen.publicUrl}</code>
                    </div>
                    <div className="embed-actions">
                      <button
                        className="outline-button"
                        onClick={() => copyBookingScreenValue(selectedBookingScreen.publicUrl, "url", selectedBookingScreen.id)}
                        type="button"
                      >
                        {copiedBookingScreenLinkId === `${selectedBookingScreen.id}-url` ? <Check size={16} /> : <Copy size={16} />}
                        {copiedBookingScreenLinkId === `${selectedBookingScreen.id}-url` ? t("Copied link") : t("Copy public link")}
                      </button>
                      <a className="outline-button" href={selectedBookingScreen.publicUrl} target="_blank" rel="noreferrer">
                        <ExternalLink size={16} />{t("Open widget")}</a>
                    </div>
                    <div className="settings-field">
                      <span>{t("Iframe embed")}</span>
                      <div className="embed-code booking-screen-iframe">
                        <ClarityAdmin size={18} />
                        <code>{selectedBookingScreen.iframeCode}</code>
                      </div>
                    </div>
                    <div className="embed-actions">
                      <button
                        className="outline-button"
                        onClick={() => copyBookingScreenValue(selectedBookingScreen.iframeCode, "iframe", selectedBookingScreen.id)}
                        type="button"
                      >
                        {copiedBookingScreenIframeId === `${selectedBookingScreen.id}-iframe` ? (
                          <Check size={16} />
                        ) : (
                          <Copy size={16} />
                        )}
                        {copiedBookingScreenIframeId === `${selectedBookingScreen.id}-iframe` ? t("Copied iframe") : t("Copy iframe")}
                      </button>
                    </div>
                  </div>
                )}
              </div>
      </details>
      </EditableSettingsBlock>
    </SettingsGroup>
  );
}
