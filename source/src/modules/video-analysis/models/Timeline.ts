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
