// Settings › Booking › Player portal booking widget.
import { t } from "../../lib/i18n";
import { EditableSettingsBlock, SettingsGroup } from "./SettingsLayout";
import { ClarityNewBooking } from "../shared/ClarityIcons";
import { ExternalLink } from "lucide-react";
import { PLAYER_BOOKING_EMBED_DEFAULT_HEIGHT, PLAYER_BOOKING_EMBED_DEFAULT_LABEL, PLAYER_BOOKING_EMBED_MAX_HEIGHT, PLAYER_BOOKING_EMBED_MIN_HEIGHT } from "../../../netlify/functions/_shared/player-booking-embed.mts";
import type { NotificationSettings } from "../notifications/notificationSettings";
import type { EditableBlockStatus } from "./SettingsLayout";

export type PlayerBookingEmbedPanelProps = {
  playerBookingEmbedEditor: { savedValue: NotificationSettings; draftValue: NotificationSettings; status: EditableBlockStatus; dirty: boolean; errorMessage: string | null; edit: () => void; cancel: () => void; setDraftValue: (next: NotificationSettings | ((current: NotificationSettings) => NotificationSettings)) => void; save: () => Promise<boolean>; };
  playerBookingEmbedDraft: NotificationSettings;
  playerBookingEmbedIsLocked: boolean;
  updateNotificationBlockDraft: (editor: { savedValue: NotificationSettings; draftValue: NotificationSettings; status: EditableBlockStatus; dirty: boolean; errorMessage: string | null; edit: () => void; cancel: () => void; setDraftValue: (next: NotificationSettings | ((current: NotificationSettings) => NotificationSettings)) => void; save: () => Promise<boolean>; }, field: keyof NotificationSettings, value: NotificationSettings[keyof NotificationSettings]) => void;
  startEditableBlock: (id: string) => void;
  cancelEditableBlock: (id: string) => void;
  saveEditableBlock: (id: string) => Promise<void>;
};

export function PlayerBookingEmbedPanel(props: PlayerBookingEmbedPanelProps) {
  const {
    playerBookingEmbedEditor,
    playerBookingEmbedDraft,
    playerBookingEmbedIsLocked,
    updateNotificationBlockDraft,
    startEditableBlock,
    cancelEditableBlock,
    saveEditableBlock,
  } = props;
  return (
    <SettingsGroup id="player-booking-embed" icon={ClarityNewBooking} section="booking" title={t("Player portal booking widget")}>
      <EditableSettingsBlock
        id="player-booking-embed-block"
        title={t("Player portal booking widget")}
        status={playerBookingEmbedEditor.status}
        dirty={playerBookingEmbedEditor.dirty}
        errorMessage={playerBookingEmbedEditor.errorMessage}
        onEdit={() => startEditableBlock("player-booking-embed")}
        onCancel={() => cancelEditableBlock("player-booking-embed")}
        onSave={() => void saveEditableBlock("player-booking-embed")}
      >
        <details className="settings-subsection">
          <summary className="settings-subsection-title">
            <ExternalLink size={18} />
            <div>
              <span>{t("Outside booking page")}</span>
              <strong>
                {playerBookingEmbedDraft.playerBookingEmbedUrl
                  ? t("Shown as \"{playerBookingEmbedLabel}\"", { playerBookingEmbedLabel: playerBookingEmbedDraft.playerBookingEmbedLabel })
                  : t("Not set")}
              </strong>
            </div>
          </summary>
          <label className="settings-field">
            <span>{t("Booking page address")}</span>
            <input
              type="url"
              inputMode="url"
              placeholder="https://booking.yourvenue.com/…"
              value={playerBookingEmbedDraft.playerBookingEmbedUrl}
              readOnly={playerBookingEmbedIsLocked}
              onChange={(event) =>
                updateNotificationBlockDraft(
                  playerBookingEmbedEditor,
                  "playerBookingEmbedUrl",
                  event.target.value.slice(0, 700),
                )
              }
            />
          </label>
          <p className="field-help">{t("Must start with https. Leave it empty and players see no extra tab. Some providers block being framed — open the tab in the portal to check before telling players about it.")}</p>
          <div className="service-form-row">
            <label className="settings-field">
              <span>{t("Tab name")}</span>
              <input
                placeholder={PLAYER_BOOKING_EMBED_DEFAULT_LABEL}
                value={playerBookingEmbedDraft.playerBookingEmbedLabel}
                readOnly={playerBookingEmbedIsLocked}
                onChange={(event) =>
                  updateNotificationBlockDraft(
                    playerBookingEmbedEditor,
                    "playerBookingEmbedLabel",
                    event.target.value.slice(0, 24),
                  )
                }
              />
            </label>
            <label className="settings-field">
              <span>{t("Starting height in pixels")}</span>
              <input
                type="number"
                min={PLAYER_BOOKING_EMBED_MIN_HEIGHT}
                max={PLAYER_BOOKING_EMBED_MAX_HEIGHT}
                step={20}
                value={playerBookingEmbedDraft.playerBookingEmbedHeight}
                readOnly={playerBookingEmbedIsLocked}
                onChange={(event) =>
                  updateNotificationBlockDraft(
                    playerBookingEmbedEditor,
                    "playerBookingEmbedHeight",
                    Number(event.target.value || PLAYER_BOOKING_EMBED_DEFAULT_HEIGHT),
                  )
                }
              />
            </label>
          </div>
          <p className="field-help">{t("The tab is called \"Bay\", \"Tee times\" or whatever your players call it. The height is only a starting point — providers that ask for more room get it.")}</p>
          <label className="settings-field">
            <span>{t("Line above the widget")}</span>
            <input
              placeholder={t("Bays only — lessons are under Lessons.")}
              value={playerBookingEmbedDraft.playerBookingEmbedIntro}
              readOnly={playerBookingEmbedIsLocked}
              onChange={(event) =>
                updateNotificationBlockDraft(
                  playerBookingEmbedEditor,
                  "playerBookingEmbedIntro",
                  event.target.value.slice(0, 240),
                )
              }
            />
          </label>
          <p className="field-help">{t("Optional. Worth setting if the difference between this and booking a lesson is not obvious.")}</p>
        </details>
      </EditableSettingsBlock>
    </SettingsGroup>
  );
}
