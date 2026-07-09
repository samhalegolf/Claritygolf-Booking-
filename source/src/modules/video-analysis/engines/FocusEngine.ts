import { FocusMode, FocusState, FocusWindow } from "../models/Focus";
import { createId } from "../utils/frameMath";
import { FocusAreaRect } from "../models/Focus";

const isFocusAreaRect = (value: unknown): value is FocusAreaRect => {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as FocusAreaRect).x === "number" &&
    typeof (value as FocusAreaRect).y === "number" &&
    typeof (value as FocusAreaRect).width === "number" &&
    typeof (value as FocusAreaRect).height === "number"
  );
};

export class FocusEngine {
  static createWindow(state: FocusState, mode: FocusMode, area?: unknown): FocusState {
    const validArea = isFocusAreaRect(area) ? area : undefined;
    const window: FocusWindow = {
      id: createId("focus"),
      mode,
      enabled: true,
      createdAt: new Date().toISOString(),
      ...(validArea ? { area: validArea } : {}),
    };
    return {
      ...state,
      windows: [...state.windows, window],
      activeWindowId: window.id,
    };
  }

  static closeWindow(state: FocusState, windowId: string): FocusState {
    const windows = state.windows.filter((entry) => entry.id !== windowId);
    return {
      ...state,
      windows,
      activeWindowId:
        state.activeWindowId === windowId ? undefined : state.activeWindowId,
    };
  }
}
