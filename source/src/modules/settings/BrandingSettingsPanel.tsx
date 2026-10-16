// Settings › Business › Business branding: logo and brand colours.
import { t } from "../../lib/i18n";
import { swatchStyle } from "./brandSwatch";
import { EditableSettingsBlock, SettingsGroup } from "./SettingsLayout";
import { Check, ImagePlus, Sparkles } from "lucide-react";
import { ClarityCalendar, ClarityPlayerPortal } from "../shared/ClarityIcons";
import { calendarColorFields, defaultCalendarColors } from "../workspace/workspaceModel";
import type { BrandSettings, CoachAccount } from "../workspace/workspaceModel";
import type { EditableBlockStatus } from "./SettingsLayout";
import type { ChangeEvent } from "react";

export type BrandingSettingsPanelProps = {
  brandSettings: BrandSettings;
  brandSaveState: "idle" | "saving" | "saved";
  businessNameEditor: { savedValue: CoachAccount; draftValue: CoachAccount; status: EditableBlockStatus; dirty: boolean; errorMessage: string | null; edit: () => void; cancel: () => void; setDraftValue: (next: CoachAccount | ((current: CoachAccount) => CoachAccount)) => void; save: () => Promise<boolean>; };
  updateBrandSetting: <K extends keyof BrandSettings>(field: K, value: BrandSettings[K]) => void;
  bookingBrandName: string;
  bookingBrandWords: string[];
  startEditableBlock: (id: string) => void;
  cancelEditableBlock: (id: string) => void;
  businessNameDraft: CoachAccount;
  businessNameIsLocked: boolean;
  coachAccount: CoachAccount;
  resetBrandSettings: () => void;
  saveBrandSettings: (nextBrand?: BrandSettings, options?: { silent?: boolean; }) => Promise<void>;
  saveEditableBlock: (id: string) => Promise<void>;
  handleLogoUpload: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
};

export function BrandingSettingsPanel(props: BrandingSettingsPanelProps) {
  const {
    brandSettings,
    brandSaveState,
    businessNameEditor,
    updateBrandSetting,
    bookingBrandName,
    bookingBrandWords,
    startEditableBlock,
    cancelEditableBlock,
    businessNameDraft,
    businessNameIsLocked,
    coachAccount,
    resetBrandSettings,
    saveBrandSettings,
    saveEditableBlock,
    handleLogoUpload,
  } = props;
  return (
    <SettingsGroup id="coach-branding" icon={ClarityPlayerPortal} section="business" title={t("Business branding")} className="brand-vein-card">

      <div className="brand-vein-preview">
        <div className="brand-vein-logo">
          {brandSettings.logoPreview ? (
            <img src={brandSettings.logoPreview} alt={`${bookingBrandName} logo preview`} />
          ) : (
            <strong>{bookingBrandWords.map((word) => word[0]).join("").slice(0, 3).toUpperCase()}</strong>
          )}
        </div>
        <div>
          <span>{t("Current business brand")}</span>
          <strong>{brandSettings.coachName}</strong>
          <em>{brandSettings.logoName || t("No logo uploaded yet")}</em>
        </div>
      </div>

      <EditableSettingsBlock
        id="business-name-block"
        title={t("Business name")}
        status={businessNameEditor.status}
        dirty={businessNameEditor.dirty}
        errorMessage={businessNameEditor.errorMessage}
        onEdit={() => startEditableBlock("business-name")}
        onCancel={() => cancelEditableBlock("business-name")}
        onSave={() => void saveEditableBlock("business-name")}
      >
        <label className="settings-field">
          <span>{t("Business name")}</span>
          <input
            value={businessNameDraft.businessName}
            readOnly={businessNameIsLocked}
            maxLength={100}
            onChange={(event) =>
              // Kept raw while typing: cleaning trims, which ate the
              // space between words. saveCoachAccount cleans on save.
              businessNameEditor.setDraftValue((current) => ({ ...current, businessName: event.target.value }))
            }
          />
        </label>
        <p className="field-help">{t("Shown on your booking page, invoices and emails.")}</p>
      </EditableSettingsBlock>

      <details className="settings-subsection">
        <summary className="settings-subsection-title">
          <ImagePlus size={18} />
          <div>
            <span>{t("Logo and colours")}</span>
            <strong>{brandSettings.logoName || t("Upload coach logo")}</strong>
          </div>
        </summary>
        <label className="settings-field">
          <span>{t("Brand name")}</span>
          <input
            value={brandSettings.coachName}
            maxLength={80}
            onChange={(event) => updateBrandSetting("coachName", event.target.value)}
            onBlur={() => void saveBrandSettings()}
            placeholder={coachAccount.businessName}
          />
        </label>
        <div className="brand-swatches" aria-label={t("Extracted logo colours")}>
          <span style={swatchStyle(brandSettings.neutral)}>
            <em>{t("Neutral")}</em>
            {brandSettings.neutral}
          </span>
          <span style={swatchStyle(brandSettings.primary)}>
            <em>{t("Primary")}</em>
            {brandSettings.primary}
          </span>
          <span style={swatchStyle(brandSettings.secondary)}>
            <em>{t("Secondary")}</em>
            {brandSettings.secondary}
          </span>
          <span style={swatchStyle(brandSettings.accent)}>
            <em>{t("Ink")}</em>
            {brandSettings.accent}
          </span>
        </div>
        <div className="brand-vein-actions">
          <label className="outline-button logo-upload">
            <ImagePlus size={16} />{t("Upload logo")}<input accept="image/*" onChange={handleLogoUpload} type="file" />
          </label>
          <button className="outline-button" onClick={() => void saveBrandSettings()}>
            {brandSaveState === "saved" ? <Check size={16} /> : <Sparkles size={16} />}
            {brandSaveState === "saving" ? t("Saving") : brandSaveState === "saved" ? t("Saved") : t("Apply")}
          </button>
          <button className="outline-button" onClick={resetBrandSettings}>{t("Reset")}</button>
        </div>
      </details>

      <details className="settings-subsection">
        <summary className="settings-subsection-title">
          <ClarityCalendar size={18} />
          <div>
            <span>{t("Calendar colours")}</span>
            <strong>{t("Booking outlines")}</strong>
          </div>
        </summary>
        <p className="settings-note">{t("A booking card is filled with its lesson type's colour, which you set on the lesson type itself. These two are the outlines it can wear on top: a border once the lesson is done, and a ring around the card while a bay is held for it. They sit on different edges, so a completed lesson with a live bay shows both.")}</p>
        <div className="calendar-colour-fields">
          {calendarColorFields.map(({ key, label, hint }) => (
            <label className="calendar-colour-field" key={key}>
              <input
                type="color"
                value={brandSettings.calendarColors[key]}
                aria-label={`${label} ${hint.toLowerCase()}`}
                onChange={(event) =>
                  updateBrandSetting("calendarColors", {
                    ...brandSettings.calendarColors,
                    [key]: event.target.value,
                  })
                }
                onBlur={() => void saveBrandSettings()}
              />
              <span>
                <strong>{label}</strong>
                <em>{hint}</em>
              </span>
              <code>{brandSettings.calendarColors[key]}</code>
            </label>
          ))}
        </div>
        <div className="brand-vein-actions">
          <button className="outline-button" onClick={() => void saveBrandSettings()}>
            {brandSaveState === "saved" ? <Check size={16} /> : <Sparkles size={16} />}
            {brandSaveState === "saving" ? t("Saving") : brandSaveState === "saved" ? t("Saved") : t("Apply")}
          </button>
          <button
            className="outline-button"
            onClick={() =>
              void saveBrandSettings({ ...brandSettings, calendarColors: defaultCalendarColors })
            }
          >{t("Reset calendar colours")}</button>
        </div>
      </details>
    </SettingsGroup>
  );
}
