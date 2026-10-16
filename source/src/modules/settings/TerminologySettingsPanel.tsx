// Settings › Business › Terminology: what this business calls its people, staff and services.
import { t } from "../../lib/i18n";
import { EditableSettingsBlock, SettingsGroup } from "./SettingsLayout";
import { ClarityServices } from "../shared/ClarityIcons";
import { BUSINESS_TERMINOLOGY_PRESETS, matchingTerminologyPreset } from "../../../netlify/functions/_shared/business-terminology.mts";
import type { BusinessTerminology, BusinessTerminologyPreset } from "../../../netlify/functions/_shared/business-terminology.mts";
import type { CoachAccount } from "../workspace/workspaceModel";
import type { EditableBlockStatus } from "./SettingsLayout";

export type TerminologySettingsPanelProps = {
  terminologyEditor: { savedValue: CoachAccount; draftValue: CoachAccount; status: EditableBlockStatus; dirty: boolean; errorMessage: string | null; edit: () => void; cancel: () => void; setDraftValue: (next: CoachAccount | ((current: CoachAccount) => CoachAccount)) => void; save: () => Promise<boolean>; };
  terminologyDraft: CoachAccount;
  terminologyIsLocked: boolean;
  startEditableBlock: (id: string) => void;
  cancelEditableBlock: (id: string) => void;
  applyTerminologyPreset: (preset: BusinessTerminologyPreset) => void;
  updateTerminologyDraft: (field: keyof BusinessTerminology, value: string) => void;
  saveEditableBlock: (id: string) => Promise<void>;
};

export function TerminologySettingsPanel(props: TerminologySettingsPanelProps) {
  const {
    terminologyEditor,
    terminologyDraft,
    terminologyIsLocked,
    startEditableBlock,
    cancelEditableBlock,
    applyTerminologyPreset,
    updateTerminologyDraft,
    saveEditableBlock,
  } = props;
  return (
    <SettingsGroup id="terminology" icon={ClarityServices} section="business" title={t("Terminology")}>
      <EditableSettingsBlock
        id="terminology-block"
        title={t("Terminology")}
        status={terminologyEditor.status}
        dirty={terminologyEditor.dirty}
        errorMessage={terminologyEditor.errorMessage}
        onEdit={() => startEditableBlock("terminology")}
        onCancel={() => cancelEditableBlock("terminology")}
        onSave={() => void saveEditableBlock("terminology")}
      >
        <div className="data-card wide">
          <p className="field-help">{t("Choose the words customers see. This does not change booking data, permissions, integrations, or how the calendar works.")}</p>
          <label className="settings-field">
            <span>{t("Preset")}</span>
            <select
              value={matchingTerminologyPreset(terminologyDraft)}
              disabled={terminologyIsLocked}
              onChange={(event) => applyTerminologyPreset(event.target.value as BusinessTerminologyPreset)}
            >
              {BUSINESS_TERMINOLOGY_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>{preset.label}</option>
              ))}
            </select>
          </label>
          <div className="service-form-grid">
            {([
              ["staffSingular", "Staff — singular"],
              ["staffPlural", "Staff — plural"],
              ["customerSingular", "Customer — singular"],
              ["customerPlural", "Customer — plural"],
              ["serviceSingular", "Service — singular"],
              ["servicePlural", "Service — plural"],
              ["resourceSingular", "Resource — singular"],
              ["resourcePlural", "Resource — plural"],
              ["assignmentPlural", "Practice module"],
              ["assignmentSingular", "Practice item"],
            ] as Array<[keyof BusinessTerminology, string]>).map(([field, label]) => (
              <label className="settings-field" key={field}>
                <span>{label}</span>
                <input
                  value={terminologyDraft.terminology[field]}
                  readOnly={terminologyIsLocked}
                  maxLength={40}
                  onChange={(event) => updateTerminologyDraft(field, event.target.value)}
                />
              </label>
            ))}
          </div>
        </div>
      </EditableSettingsBlock>
    </SettingsGroup>
  );
}
