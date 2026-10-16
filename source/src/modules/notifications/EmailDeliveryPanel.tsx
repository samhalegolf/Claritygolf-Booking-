// Settings › Email / SMS › Sender & delivery.
import { t } from "../../lib/i18n";
import { ClarityEmail, ClarityIntegrations } from "../shared/ClarityIcons";
import { EditableSettingsBlock, SettingsGroup } from "../settings/SettingsLayout";
import { clamp } from "../../lib/number";
import { ExternalLink } from "lucide-react";
import type { EditableBlockStatus } from "../settings/SettingsLayout";
import type { CoachAccount } from "../workspace/workspaceModel";
import type { NotificationSettings } from "./notificationSettings";
import type { Dispatch, SetStateAction } from "react";

export type EmailDeliveryPanelProps = {
  emailNotificationsEditor: { savedValue: NotificationSettings; draftValue: NotificationSettings; status: EditableBlockStatus; dirty: boolean; errorMessage: string | null; edit: () => void; cancel: () => void; setDraftValue: (next: NotificationSettings | ((current: NotificationSettings) => NotificationSettings)) => void; save: () => Promise<boolean>; };
  notificationSettings: NotificationSettings;
  coachAccount: CoachAccount;
  emailNotificationsDraft: NotificationSettings;
  emailNotificationsIsLocked: boolean;
  updateNotificationBlockDraft: (editor: { savedValue: NotificationSettings; draftValue: NotificationSettings; status: EditableBlockStatus; dirty: boolean; errorMessage: string | null; edit: () => void; cancel: () => void; setDraftValue: (next: NotificationSettings | ((current: NotificationSettings) => NotificationSettings)) => void; save: () => Promise<boolean>; }, field: keyof NotificationSettings, value: NotificationSettings[keyof NotificationSettings]) => void;
  testEmailState: "idle" | "sending" | "sent";
  testEmailAddress: string;
  startEditableBlock: (id: string) => void;
  cancelEditableBlock: (id: string) => void;
  setTestEmailAddress: Dispatch<SetStateAction<string>>;
  saveEditableBlock: (id: string) => Promise<void>;
  sendTestEmail: () => Promise<void>;
};

export function EmailDeliveryPanel(props: EmailDeliveryPanelProps) {
  const {
    emailNotificationsEditor,
    notificationSettings,
    coachAccount,
    emailNotificationsDraft,
    emailNotificationsIsLocked,
    updateNotificationBlockDraft,
    testEmailState,
    testEmailAddress,
    startEditableBlock,
    cancelEditableBlock,
    setTestEmailAddress,
    saveEditableBlock,
    sendTestEmail,
  } = props;
  return (
    <SettingsGroup id="email-notifications" icon={ClarityIntegrations} section="email-sms" title={t("Sender & delivery")} className="notification-card">
      <EditableSettingsBlock
        id="email-notifications-block"
        title={t("Sender & delivery")}
        status={emailNotificationsEditor.status}
        dirty={emailNotificationsEditor.dirty}
        errorMessage={emailNotificationsEditor.errorMessage}
        onEdit={() => startEditableBlock("email-notifications")}
        onCancel={() => cancelEditableBlock("email-notifications")}
        onSave={() => void saveEditableBlock("email-notifications")}
      >
      <div className="settings-summary-grid">
        <span>
          <strong>{notificationSettings.notificationFromName || t("Not set")}</strong>{t("from")}</span>
        <span>
          <strong>{notificationSettings.replyToEmail || coachAccount.contactEmail || t("Not set")}</strong>{t("reply-to")}</span>
        <span>
          <strong>{notificationSettings.notificationDelaySeconds}s</strong>{t("delay")}</span>
      </div>
      <details className="settings-subsection">
        <summary className="settings-subsection-title">
          <ClarityEmail size={18} />
          <div>
            <span>{t("Sender identity")}</span>
            <strong>{notificationSettings.configuredSenderEmailAddress || "Provider-controlled"}</strong>
          </div>
        </summary>
        <label className="settings-field">
          <span>{t("Email sender name")}</span>
          <input
            placeholder={t("Your business name")}
            value={emailNotificationsDraft.notificationFromName}
            readOnly={emailNotificationsIsLocked}
            maxLength={120}
            onChange={(event) =>
              updateNotificationBlockDraft(emailNotificationsEditor, "notificationFromName", event.target.value.slice(0, 120))}
          />
        </label>
        <p className="field-help">{t("This is the display name clients see in their inbox.")}</p>
        <label className="settings-field">
          <span>{t("Sender email address")}</span>
          <input
            value={notificationSettings.configuredSenderEmailAddress}
            type="email"
            readOnly
            disabled
            placeholder={t("Sender address controlled by provider")}
          />
        </label>
        <p className="field-help">{t("The sender email address is controlled by your configured email provider/domain.")}</p>
        <label className="settings-field">
          <span>{t("Reply-to email")}</span>
          <input
            value={emailNotificationsDraft.replyToEmail}
            readOnly={emailNotificationsIsLocked}
            onChange={(event) => updateNotificationBlockDraft(emailNotificationsEditor, "replyToEmail", event.target.value)}
            placeholder={coachAccount.contactEmail}
          />
        </label>
      </details>
      <details className="settings-subsection">
        <summary className="settings-subsection-title">
          <ClarityEmail size={18} />
          <div>
            <span>{t("Delivery")}</span>
            <strong>{notificationSettings.notificationEmail || coachAccount.contactEmail}</strong>
          </div>
        </summary>
        <label className="settings-field">
          <span>{t("Admin notification email")}</span>
          <input
            value={emailNotificationsDraft.notificationEmail}
            readOnly={emailNotificationsIsLocked}
            onChange={(event) => updateNotificationBlockDraft(emailNotificationsEditor, "notificationEmail", event.target.value)}
            placeholder={coachAccount.contactEmail}
          />
        </label>
        <label className="settings-field">
          <span>{t("Coach email (fallback)")}</span>
          <input
            value={emailNotificationsDraft.coachEmail}
            readOnly={emailNotificationsIsLocked}
            onChange={(event) => updateNotificationBlockDraft(emailNotificationsEditor, "coachEmail", event.target.value)}
            placeholder={t("coach@example.com")}
            type="email"
          />
        </label>
        <p className="field-help">{t("Coach booking alerts go to the email on the coach profile of whoever is taking the lesson (Settings → Coaches). This address is only used if that profile has no email.")}</p>
        <label className="settings-field">
          <span>{t("Notification delay seconds")}</span>
          <input
            value={emailNotificationsDraft.notificationDelaySeconds}
            readOnly={emailNotificationsIsLocked}
            min={30}
            step={5}
            inputMode="numeric"
            onChange={(event) =>
              updateNotificationBlockDraft(
                emailNotificationsEditor,
                "notificationDelaySeconds",
                clamp(Number(event.target.value || 30), 30, 3600),
              )
            }
            type="text"
          />
        </label>
      </details>
      <details className="settings-subsection">
        <summary className="settings-subsection-title">
          <ExternalLink size={18} />
          <div>
            <span>{t("Google review link")}</span>
            <strong>{notificationSettings.googleReviewUrl ? t("Configured") : t("Not set")}</strong>
          </div>
        </summary>
        <label className="settings-field">
          <span>{t("Google review URL")}</span>
          <input
            type="url"
            value={emailNotificationsDraft.googleReviewUrl}
            readOnly={emailNotificationsIsLocked}
            maxLength={700}
            onChange={(event) => updateNotificationBlockDraft(emailNotificationsEditor, "googleReviewUrl", event.target.value.slice(0, 700))}
            placeholder={t("direct Google review link")}
          />
        </label>
        <p className="field-help">{t("Used for optional review buttons in client emails. Leave blank to hide review links.")}</p>
      </details>
      <details className="settings-subsection">
        <summary className="settings-subsection-title">
          <ClarityEmail size={18} />
          <div>
            <span>{t("Test send")}</span>
            <strong>{testEmailAddress || notificationSettings.notificationEmail || coachAccount.contactEmail}</strong>
          </div>
        </summary>
        <label className="settings-field">
          <span>{t("Send test to")}</span>
          <input
            value={testEmailAddress}
            onChange={(event) => setTestEmailAddress(event.target.value)}
            placeholder={notificationSettings.notificationEmail || coachAccount.contactEmail}
            type="email"
          />
        </label>
        {/* A connectivity check, not a preview: test-email.mts sends
            fixed wording through the provider and does not read the
            templates or the sender identity above. Say so, rather
            than letting it look like a way to proof a message. */}
        <p className="field-help">{t("Checks that the email provider is reachable. It sends fixed test wording to this address only — not your templates, and never a client.")}</p>
        <button className="outline-button" onClick={sendTestEmail} disabled={testEmailState === "sending"} type="button">
          <ClarityEmail size={16} />
          {testEmailState === "sending" ? t("Sending...") : testEmailState === "sent" ? t("Sent") : t("Send Test Email")}
        </button>
      </details>
      </EditableSettingsBlock>
    </SettingsGroup>
  );
}
