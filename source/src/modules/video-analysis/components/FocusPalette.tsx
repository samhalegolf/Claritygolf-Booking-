import { ToolButton } from "./ToolButton";
import { IconFocusArea, IconFocusTrackBeta } from "./VideoIcons";
import { t } from "../../../lib/i18n";

interface FocusPaletteProps {
  onSelectArea: () => void;
  onSelectTrack: () => void;
  onClose: () => void;
}

export function FocusPalette({
  onSelectArea,
  onSelectTrack,
  onClose,
}: FocusPaletteProps) {
  return (
    <div className="focus-palette">
      <ToolButton
        icon={<IconFocusArea />}
        label={t("Area Focus")}
        tooltip={t("Area Focus")}
        onClick={() => {
          onSelectArea();
          onClose();
        }}
      />
      <ToolButton
        icon={(
          <span className="focus-beta-icon" aria-hidden="true">
            <IconFocusTrackBeta />
            <span className="focus-beta-mark" aria-hidden="true">
              β
            </span>
          </span>
        )}
        label={t("Track Focus Beta")}
        tooltip={t("Track Focus Beta")}
        onClick={() => {
          onSelectTrack();
          onClose();
        }}
      />
    </div>
  );
}
