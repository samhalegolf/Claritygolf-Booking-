export type VideoVisualPresetId =
  | "original"
  | "brighten"
  | "dark-indoor"
  | "backlit"
  | "detail";

export type VideoVisualPreset = {
  id: VideoVisualPresetId;
  label: string;
  description: string;
  cssFilter: string;
};

const STORAGE_KEY = "clarity.video.visualPreset";

export const VIDEO_VISUAL_PRESETS: ReadonlyArray<VideoVisualPreset> = [
  {
    id: "original",
    label: "Original",
    description: "No visual enhancement.",
    cssFilter: "none",
  },
  {
    id: "brighten",
    label: "Brighten",
    description: "A gentle lift for slightly dark clips.",
    cssFilter: "brightness(1.22) contrast(1.04) saturate(0.98)",
  },
  {
    id: "dark-indoor",
    label: "Dark Indoor",
    description: "Lifts dark indoor bays while keeping bright screens under control.",
    cssFilter: "brightness(1.38) contrast(0.94) saturate(0.92)",
  },
  {
    id: "backlit",
    label: "Backlit",
    description: "Pulls the golfer forward when the background is much brighter.",
    cssFilter: "brightness(1.30) contrast(0.88) saturate(0.90)",
  },
  {
    id: "detail",
    label: "Detail",
    description: "Adds restrained contrast for body and club edges.",
    cssFilter: "brightness(1.04) contrast(1.18) saturate(0.94)",
  },
];

export const DEFAULT_VIDEO_VISUAL_PRESET: VideoVisualPresetId = "original";

export function getVideoVisualPreset(id: VideoVisualPresetId): VideoVisualPreset {
  return (
    VIDEO_VISUAL_PRESETS.find((preset) => preset.id === id) ??
    VIDEO_VISUAL_PRESETS[0]
  );
}

export function loadVideoVisualPreset(): VideoVisualPresetId {
  if (typeof window === "undefined") return DEFAULT_VIDEO_VISUAL_PRESET;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY) as VideoVisualPresetId | null;
    return VIDEO_VISUAL_PRESETS.some((preset) => preset.id === stored)
      ? (stored as VideoVisualPresetId)
      : DEFAULT_VIDEO_VISUAL_PRESET;
  } catch {
    return DEFAULT_VIDEO_VISUAL_PRESET;
  }
}

export function saveVideoVisualPreset(id: VideoVisualPresetId) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // A blocked/ephemeral store should never stop the coach changing the view.
  }
}
