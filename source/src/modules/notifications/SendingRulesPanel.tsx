// Settings › Email / SMS › What sends.
import { t } from "../../lib/i18n";
import { SettingsGroup } from "../settings/SettingsLayout";
import { reminderLeadLabel, reminderLeadMinutesFrom } from "./reminderLead";
import { clamp } from "../../lib/number";
import { ClarityNotifications } from "../shared/ClarityIcons";
import type { NotificationSettings } from "./notificationSettings";
import type { Dispatch, JSX, SetStateAction } from "react";

export type SendingRulesPanelProps = {
  sendingRuleChecked: (field: keyof NotificationSettings) => boolean;
  sendingRuleSaving: "" | keyof NotificationSettings;
  sendingRuleStatus: (field: keyof NotificationSettings) => JSX.Element | null;
  reminderLeadMinutes: number;
  notificationSettings: NotificationSettings;
  commitReminderLead: () => void;
  setReminderLeadDraft: Dispatch<SetStateAction<number | null>>;
  sendingRuleError: string;
  commitSendingRule: (field: keyof NotificationSettings, patch: Partial<NotificationSettings>) => Promise<void>;
};

export function SendingRulesPanel(props: SendingRulesPanelProps) {
  const {
    sendingRuleChecked,
    sendingRuleSaving,
    sendingRuleStatus,
    reminderLeadMinutes,
    notificationSettings,
    commitReminderLead,
    setReminderLeadDraft,
    sendingRuleError,
    commitSendingRule,
  } = props;
  return (
    <SettingsGroup id="email-sending-rules" icon={ClarityNotifications} section="email-sms" title={t("What sends")} className="notification-card">
      <section className="sending-rules" id="email-sending-rules-block">
        <div className="sending-rules-head">
          <span>{t("What sends")}</span>
          <em>{t("Each switch saves on its own — there is nothing to press.")}</em>
        </div>
        <label className="settings-toggle sending-rule">
          <input
            checked={sendingRuleChecked("sendClientEmail")}
            disabled={sendingRuleSaving !== ""}
            onChange={(event) => void commitSendingRule("sendClientEmail", { sendClientEmail: event.target.checked })}
            type="checkbox"
          />
          <span>{t("Send client confirmation email")}</span>
          {sendingRuleStatus("sendClientEmail")}
        </label>
        <label className="settings-toggle sending-rule">
          <input
            checked={sendingRuleChecked("sendCoachEmail")}
            disabled={sendingRuleSaving !== ""}
            onChange={(event) => void commitSendingRule("sendCoachEmail", { sendCoachEmail: event.target.checked })}
            type="checkbox"
          />
          <span>{t("Send coach booking alert")}</span>
          {sendingRuleStatus("sendCoachEmail")}
        </label>
        <label className="settings-toggle sending-rule">
          <input
            checked={sendingRuleChecked("sendAdminEmail")}
            disabled={sendingRuleSaving !== ""}
            onChange={(event) => void commitSendingRule("sendAdminEmail", { sendAdminEmail: event.target.checked })}
            type="checkbox"
          />
          <span>{t("Send admin booking alert")}</span>
          {sendingRuleStatus("sendAdminEmail")}
        </label>
        <label className="settings-toggle sending-rule">
          <input
            checked={sendingRuleChecked("sendLessonTypeChangeEmail")}
            disabled={sendingRuleSaving !== ""}
            onChange={(event) =>
              void commitSendingRule("sendLessonTypeChangeEmail", {
                sendLessonTypeChangeEmail: event.target.checked,
              })
            }
            type="checkbox"
          />
          <span>{t("Email when a lesson type changes")}</span>
          {sendingRuleStatus("sendLessonTypeChangeEmail")}
        </label>
        <p className="field-help">{t("Off by default. Switching a booking between lesson types on the lesson card stays silent, so tidying your own calendar doesn't mail the client. Real reschedules still send either way.")}</p>

        <label className="settings-toggle sending-rule">
          <input
            checked={sendingRuleChecked("reminderEnabled")}
            disabled={sendingRuleSaving !== ""}
            onChange={(event) => void commitSendingRule("reminderEnabled", { reminderEnabled: event.target.checked })}
            type="checkbox"
          />
          <span>{t("Send clients a reminder email before their lesson")}</span>
          {sendingRuleStatus("reminderEnabled")}
        </label>
        {notificationSettings.reminderEnabled && (
          <>
            <div className="settings-field-row">
              <label className="settings-field">
                <span>{t("Days before")}</span>
                <input
                  value={Math.floor(reminderLeadMinutes / 1440)}
                  min={0}
                  max={14}
                  inputMode="numeric"
                  type="number"
                  onBlur={commitReminderLead}
                  onChange={(event) =>
                    setReminderLeadDraft(
                      reminderLeadMinutesFrom(
                        clamp(Number(event.target.value || 0), 0, 14),
                        Math.round((reminderLeadMinutes % 1440) / 60),
                      ),
                    )
                  }
                />
              </label>
              <label className="settings-field">
                <span>{t("Hours before")}</span>
                <input
                  value={Math.round((reminderLeadMinutes % 1440) / 60)}
                  min={0}
                  max={23}
                  inputMode="numeric"
                  type="number"
                  onBlur={commitReminderLead}
                  onChange={(event) =>
                    setReminderLeadDraft(
                      reminderLeadMinutesFrom(
                        Math.floor(reminderLeadMinutes / 1440),
                        clamp(Number(event.target.value || 0), 0, 23),
                      ),
                    )
                  }
                />
              </label>
            </div>
            <p className="field-help">{t("Currently {reminderLeadMinutes} before the lesson. Saved when you leave the box. Sent once per lesson, to the client only — a lesson booked inside the reminder window skips it, because the confirmation they just received already has the details.", { reminderLeadMinutes: reminderLeadLabel(notificationSettings.reminderLeadMinutes) })}</p>
          </>
        )}
        {sendingRuleError ? (
          <p className="workspace-save-error" role="alert">
            {sendingRuleError}
          </p>
        ) : null}
      </section>
    </SettingsGroup>
  );
}
