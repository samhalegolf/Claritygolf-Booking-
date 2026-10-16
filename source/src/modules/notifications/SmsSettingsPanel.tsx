// Settings › Email / SMS › SMS: the Text Machine hook.
import { t } from "../../lib/i18n";
import { EditableSettingsBlock, SettingsGroup } from "../settings/SettingsLayout";
import { ClarityMessages } from "../shared/ClarityIcons";
import { Check, Phone } from "lucide-react";
import type { EditableBlockStatus } from "../settings/SettingsLayout";
import type { NotificationSettings } from "./notificationSettings";

export type SmsSettingsPanelProps = {
  textMachineEditor: { savedValue: NotificationSettings; draftValue: NotificationSettings; status: EditableBlockStatus; dirty: boolean; errorMessage: string | null; edit: () => void; cancel: () => void; setDraftValue: (next: NotificationSettings | ((current: NotificationSettings) => NotificationSettings)) => void; save: () => Promise<boolean>; };
  notificationSettings: NotificationSettings;
  textMachineDraft: NotificationSettings;
  textMachineIsLocked: boolean;
  updateNotificationBlockDraft: (editor: { savedValue: NotificationSettings; draftValue: NotificationSettings; status: EditableBlockStatus; dirty: boolean; errorMessage: string | null; edit: () => void; cancel: () => void; setDraftValue: (next: NotificationSettings | ((current: NotificationSettings) => NotificationSettings)) => void; save: () => Promise<boolean>; }, field: keyof NotificationSettings, value: NotificationSettings[keyof NotificationSettings]) => void;
  startEditableBlock: (id: string) => void;
  cancelEditableBlock: (id: string) => void;
  saveEditableBlock: (id: string) => Promise<void>;
};

export function SmsSettingsPanel(props: SmsSettingsPanelProps) {
  const {
    textMachineEditor,
    notificationSettings,
    textMachineDraft,
    textMachineIsLocked,
    updateNotificationBlockDraft,
    startEditableBlock,
    cancelEditableBlock,
    saveEditableBlock,
  } = props;
  return (
    <SettingsGroup id="text-machine" icon={ClarityMessages} section="email-sms" title={t("SMS")} className="notification-card">
      <EditableSettingsBlock
        id="text-machine-block"
        title={t("SMS")}
        status={textMachineEditor.status}
        dirty={textMachineEditor.dirty}
        errorMessage={textMachineEditor.errorMessage}
        onEdit={() => startEditableBlock("text-machine")}
        onCancel={() => cancelEditableBlock("text-machine")}
        onSave={() => void saveEditableBlock("text-machine")}
      >
      <div className="settings-summary-grid">
        <span>
          <strong>{notificationSettings.smsProviderName || t("Not set")}</strong>{t("provider")}</span>
        <span>
          <strong>{notificationSettings.sendClientSms ? t("On") : t("Off")}</strong>{t("customer")}</span>
        <span>
          <strong>{notificationSettings.sendAdminSms ? t("On") : t("Off")}</strong>{t("admin")}</span>
      </div>
      <details className="settings-subsection">
        <summary className="settings-subsection-title">
          <Phone size={18} />
          <div>
            <span>{t("Provider")}</span>
            <strong>{notificationSettings.smsProviderName || t("Connect later")}</strong>
          </div>
        </summary>
        <label className="settings-field">
          <span>{t("Provider name")}</span>
          <input
            value={textMachineDraft.smsProviderName}
            readOnly={textMachineIsLocked}
            onChange={(event) => updateNotificationBlockDraft(textMachineEditor, "smsProviderName", event.target.value)}
            placeholder={t("Twilio, MessageMedia, Zapier...")}
          />
        </label>
        <label className="settings-field">
          <span>{t("Webhook or API URL")}</span>
          <input
            value={textMachineDraft.smsWebhookUrl}
            readOnly={textMachineIsLocked}
            onChange={(event) => updateNotificationBlockDraft(textMachineEditor, "smsWebhookUrl", event.target.value)}
            placeholder="https://..."
          />
        </label>
        <label className="settings-field">
          <span>{t("Sender or text number")}</span>
          <input
            value={textMachineDraft.smsFromNumber}
            readOnly={textMachineIsLocked}
            onChange={(event) => updateNotificationBlockDraft(textMachineEditor, "smsFromNumber", event.target.value)}
            placeholder="+64..."
          />
        </label>
      </details>
      <details className="settings-subsection">
        <summary className="settings-subsection-title">
          <Check size={18} />
          <div>
            <span>{t("Send rules")}</span>
            <strong>
              {[notificationSettings.sendClientSms && t("Customer"), notificationSettings.sendAdminSms && t("Admin")]
                .filter(Boolean)
                .join(` ${t("and")} `) || t("Off")}
            </strong>
          </div>
        </summary>
        <label className="settings-toggle">
          <input
            checked={textMachineDraft.sendClientSms}
            disabled={textMachineIsLocked}
            onChange={(event) => updateNotificationBlockDraft(textMachineEditor, "sendClientSms", event.target.checked)}
            type="checkbox"
          />
          <span>{t("Send client text confirmation")}</span>
        </label>
        <label className="settings-toggle">
          <input
            checked={textMachineDraft.sendAdminSms}
            disabled={textMachineIsLocked}
            onChange={(event) => updateNotificationBlockDraft(textMachineEditor, "sendAdminSms", event.target.checked)}
            type="checkbox"
          />
          <span>{t("Send admin text alert")}</span>
        </label>
        <p className="field-help">{t("What each text says is written on the message itself, in Notifications › Templates.")}</p>
      </details>
      </EditableSettingsBlock>
    </SettingsGroup>
  );
}
