import { t } from "../../../lib/i18n";

export type FriendlyMarkerLabel =
  | "Setup"
  | "Takeaway"
  | "Top"
  | "Delivery"
  | "Impact"
  | "Finish";

export interface TimelineMarker {
  id: string;
  label: FriendlyMarkerLabel;
  time: number;
  color?: string;
  thumbnail?: string;
}

/** The marker's name as the reader sees it. The label itself stays English: it is saved. */
export const MARKER_LABEL_TEXT: Record<FriendlyMarkerLabel, string> = {
  Setup: t("Setup"),
  Takeaway: t("Takeaway"),
  Top: t("Top"),
  Delivery: t("Delivery"),
  Impact: t("Impact"),
  Finish: t("Finish"),
};
