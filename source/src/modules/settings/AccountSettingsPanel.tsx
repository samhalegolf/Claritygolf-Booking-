// Settings › Account: plan, security, sign-in and the way out.
import { t } from "../../lib/i18n";
import { SettingsGroup } from "./SettingsLayout";
import { Check } from "lucide-react";
import { ClarityAccessPermissions, ClarityPayments, ClarityProfile } from "../shared/ClarityIcons";
import { SUBSCRIPTION_STATUS_LABEL, UNLIMITED_ACCOUNT_LIMIT, accountFeatureLabel, isAccountActive } from "../workspace/workspaceModel";
import type { AccountLimits } from "../workspace/workspaceModel";
import type { BusinessTerminology } from "../../../netlify/functions/_shared/business-terminology.mts";
import type { ProfileTarget } from "../business-hub/BusinessHubPanel";
import type { AccountEntitlements, AccountFeatureKey, WorkspaceAccount } from "../workspace/workspaceModel";
import type { PasswordChangeForm } from "./accountTypes";
import type { Dispatch, FormEvent, SetStateAction } from "react";

export type AccountSettingsPanelProps = {
  activeAccount: WorkspaceAccount;
  showPasswordFields: boolean;
  terms: BusinessTerminology;
  passwordChangeForm: PasswordChangeForm;
  updatePasswordChangeForm: <K extends keyof PasswordChangeForm>(field: K, value: PasswordChangeForm[K]) => void;
  passwordChangeState: "idle" | "saving" | "saved";
  passwordRequirements: { label: string; met: boolean; }[];
  passwordChangeMessage: string;
  accountUsage: { maxCoaches: number; maxLocations: number; maxUsers: number; maxServices: number; maxBookingScreens: 3; };
  activeAccountEntitlements: AccountEntitlements;
  enabledAccountFeatures: AccountFeatureKey[];
  setShowPasswordFields: Dispatch<SetStateAction<boolean>>;
  openProfileTarget: (target: ProfileTarget, label?: string) => void;
  handleChangePassword: (event: FormEvent<HTMLFormElement>) => Promise<void>;
};

export function AccountSettingsPanel(props: AccountSettingsPanelProps) {
  const {
    activeAccount,
    showPasswordFields,
    terms,
    passwordChangeForm,
    updatePasswordChangeForm,
    passwordChangeState,
    passwordRequirements,
    passwordChangeMessage,
    accountUsage,
    activeAccountEntitlements,
    enabledAccountFeatures,
    setShowPasswordFields,
    openProfileTarget,
    handleChangePassword,
  } = props;
  return (
    <SettingsGroup id="coach-account" icon={ClarityProfile} section="account" title={t("Account")} className="notification-card account-card">
      <details className="settings-subsection">
        <summary className="settings-subsection-title">
          <ClarityPayments size={18} />
          <div>
            <span>{t("Plan")}</span>
            <strong className="account-plan-heading">
              {activeAccount.planKey.charAt(0).toUpperCase() + activeAccount.planKey.slice(1)}
              <em className={`account-status-pill ${isAccountActive(activeAccount) ? "is-ok" : "is-bad"}`}>
                {SUBSCRIPTION_STATUS_LABEL[activeAccount.subscriptionStatus]}
              </em>
            </strong>
          </div>
        </summary>
        <dl className="account-plan-details">
          <div>
            <dt>{t("Workspace")}</dt>
            <dd>{activeAccount.name}</dd>
          </div>
          <div>
            <dt>{t("Workspace ID")}</dt>
            <dd>{activeAccount.slug}</dd>
          </div>
        </dl>
        <div className="account-usage-grid">
          {(
            [
              ["maxCoaches", terms.staffPlural],
              ["maxLocations", t("Locations")],
              ["maxUsers", t("Team logins")],
              ["maxServices", t("{serviceSingular} types", { serviceSingular: terms.serviceSingular })],
              ["maxBookingScreens", t("Booking screens")],
            ] as Array<[keyof AccountLimits, string]>
          ).map(([limitName, label]) => {
            const used = accountUsage[limitName];
            const limit = activeAccountEntitlements.limits[limitName];
            const unlimited = limit >= UNLIMITED_ACCOUNT_LIMIT;
            const share = unlimited || limit <= 0 ? 0 : Math.min(used / limit, 1);
            return (
              <div key={limitName} className="account-usage-tile">
                <span>{label}</span>
                <strong>
                  {used}
                  <small>{unlimited ? t(" · unlimited") : ` ${t("of {limit}", { limit })}`}</small>

                </strong>
                {!unlimited && (
                  <div className={`account-usage-meter${share >= 1 ? " is-full" : ""}`} aria-hidden="true">
                    <i style={{ width: `${share * 100}%` }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="account-feature-block">
          <span className="account-feature-heading">{t("Included in your plan")}</span>
          <ul className="account-feature-list">
            {enabledAccountFeatures.map((feature) => (
              <li key={feature}>
                <Check size={14} aria-hidden="true" />
                {accountFeatureLabel(feature, terms)}
              </li>
            ))}
          </ul>
        </div>
      </details>
      <div className="account-settings-groups">
        <details className="settings-subsection">
          <summary className="settings-subsection-title">
            <ClarityAccessPermissions size={18} />
            <div>
              <span>{t("Security")}</span>
              <strong>{t("Password")}</strong>
            </div>
          </summary>
          <form className="security-settings-form" onSubmit={handleChangePassword}>
            <p className="field-help">{t("Enter your current password, then choose a new one. You'll stay signed in on this device.")}</p>
            <label className="settings-field">
              <span>{t("Current password")}</span>
              <input
                value={passwordChangeForm.currentPassword}
                onChange={(event) => updatePasswordChangeForm("currentPassword", event.target.value)}
                type={showPasswordFields ? "text" : "password"}
                autoComplete="current-password"
                required
              />
            </label>
            <label className="settings-field">
              <span>{t("New password")}</span>
              <input
                value={passwordChangeForm.newPassword}
                onChange={(event) => updatePasswordChangeForm("newPassword", event.target.value)}
                type={showPasswordFields ? "text" : "password"}
                autoComplete="new-password"
                aria-describedby="password-requirements"
                required
              />
            </label>
            <label className="settings-field">
              <span>{t("Confirm new password")}</span>
              <input
                value={passwordChangeForm.confirmPassword}
                onChange={(event) => updatePasswordChangeForm("confirmPassword", event.target.value)}
                type={showPasswordFields ? "text" : "password"}
                autoComplete="new-password"
                required
              />
            </label>
            <label className="show-password-toggle">
              <input
                checked={showPasswordFields}
                onChange={(event) => setShowPasswordFields(event.target.checked)}
                type="checkbox"
              />
              <span>{t("Show passwords")}</span>
            </label>
            <ul id="password-requirements" className="password-requirements">
              {passwordRequirements.map((requirement) => (
                <li key={requirement.label} className={requirement.met ? "is-met" : undefined}>
                  {requirement.met ? <Check size={14} aria-hidden="true" /> : <span aria-hidden="true" className="password-requirement-dot" />}
                  {requirement.label}
                </li>
              ))}
            </ul>
            {passwordChangeMessage && (
              <div className={passwordChangeState === "saved" ? "auth-success" : "auth-error"} role="status">
                {passwordChangeMessage}
              </div>
            )}
            <div className="security-settings-actions">
              <button
                className="primary-button"
                disabled={passwordChangeState === "saving" || !passwordRequirements.every((requirement) => requirement.met)}
                type="submit"
              >
                {passwordChangeState === "saving" ? t("Updating…") : t("Update password")}
              </button>
            </div>
          </form>
        </details>

        {/* Billing settings are edited in one place, Billing › Settings.
            This used to be a second editor bound to the same state. */}
        <div className="settings-subsection settings-pointer">
          <p className="field-help">{t("Invoicing defaults, payment methods, discounts and expense categories are in Billing › Settings.")}</p>
          <button
            className="outline-button"
            onClick={() => openProfileTarget({ kind: "billing", section: "settings" }, t("Billing Settings"))}
            type="button"
          >
            {t("Open Billing Settings")}
          </button>
        </div>
      </div>
    </SettingsGroup>
  );
}
