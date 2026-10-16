// Only "area" exists. The type stays because saved workspace snapshots carry the
// field; "track" was a placeholder that never did anything and is read as area.
export type FocusMode = "area";

export interface FocusAreaRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FocusWindow {
  id: string;
  mode: FocusMode;
  area?: FocusAreaRect;
  enabled: boolean;
  createdAt: string;
}

export interface FocusState {
  isOpen: boolean;
  windows: FocusWindow[];
  activeWindowId?: string;
}

