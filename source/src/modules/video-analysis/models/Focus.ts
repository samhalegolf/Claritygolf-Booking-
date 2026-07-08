export type FocusMode = "area" | "track";

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

