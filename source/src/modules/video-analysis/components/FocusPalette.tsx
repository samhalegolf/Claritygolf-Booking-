import { ToolButton } from "./ToolButton";
import { IconFocusArea } from "./VideoIcons";
import { t } from "../../../lib/i18n";

interface FocusPaletteProps {
  onSelectArea: () => void;
  onClose: () => void;
}

export function FocusPalette({
  onSelectArea,
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
    </div>
  );
}
