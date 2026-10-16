// Settings › Business › Theme: light or dark, and the calendar colours.
import { t } from "../../lib/i18n";
import { SettingsGroup } from "./SettingsLayout";
import { ClarityPreferences, ClaritySettings } from "../shared/ClarityIcons";
import { Eye, Moon, Sun } from "lucide-react";
import type { BrandSettings, ThemeMode } from "../workspace/workspaceModel";
import type { Dispatch, SetStateAction } from "react";

export type ThemeSettingsPanelProps = {
  themeMode: ThemeMode;
  brandSettings: BrandSettings;
  setThemeMode: Dispatch<SetStateAction<ThemeMode>>;
  setBookingLogoVisible: (showLogo: boolean) => void;
};

export function ThemeSettingsPanel(props: ThemeSettingsPanelProps) {
  const {
    themeMode,
    brandSettings,
    setThemeMode,
    setBookingLogoVisible,
  } = props;
  return (
    <SettingsGroup id="theme" icon={ClarityPreferences} section="business" title={t("Theme")} className="notification-card">
      <details className="settings-subsection">
        <summary className="settings-subsection-title">
          <ClaritySettings size={18} />
          <div>
            <span>{t("Admin workspace")}</span>
            <strong>{themeMode === "dark" ? t("Dark workspace") : t("Light workspace")}</strong>
          </div>
        </summary>
        <div className="booking-surface-setting">
          <div>
            <span>{t("Admin theme")}</span>
            <strong>{themeMode === "dark" ? t("Dark workspace") : t("Light workspace")}</strong>
          </div>
          <button
            aria-label={themeMode === "dark" ? t("Switch admin theme to light") : t("Switch admin theme to dark")}
            aria-pressed={themeMode === "dark"}
            className={`theme-switch theme-toggle ${themeMode === "dark" ? "is-dark" : "is-light"}`}
            data-testid="admin-theme-switch"
            onClick={() => setThemeMode((current) => (current === "dark" ? "light" : "dark"))}
            type="button"
          >
            <span className={themeMode === "light" ? "active" : ""} aria-hidden="true">
              <Sun size={15} />
            </span>
            <span className={themeMode === "dark" ? "active" : ""} aria-hidden="true">
              <Moon size={15} />
            </span>
          </button>
        </div>
      </details>
      <details className="settings-subsection">
        <summary className="settings-subsection-title">
          <Eye size={18} />
          <div>
            <span>{t("Booking surface")}</span>
            <strong>{t("Follows each visitor's device")}</strong>
          </div>
        </summary>
        {/* The dark/light choice used to live here. It was one
            machine's preference applied to everyone who opened the
            booking page, so the cards now follow the reader's own
            browser instead. */}
        <div className="booking-surface-setting">
          <div>
            <span>{t("Booking logo")}</span>
            <strong>{brandSettings.showLogo ? t("Logo shown") : t("No logo")}</strong>
          </div>
          <button
            aria-label={brandSettings.showLogo ? t("Hide booking logo") : t("Show booking logo")}

            aria-pressed={brandSettings.showLogo}
            className={`theme-switch logo-toggle ${brandSettings.showLogo ? "is-dark" : "is-light"}`}
            onClick={() => setBookingLogoVisible(!brandSettings.showLogo)}
            type="button"
          >
            <span className={!brandSettings.showLogo ? "active" : ""} aria-hidden="true">{t("Off")}</span>
            <span className={brandSettings.showLogo ? "active" : ""} aria-hidden="true">{t("On")}</span>
          </button>
        </div>
      </details>
    </SettingsGroup>
  );
}
