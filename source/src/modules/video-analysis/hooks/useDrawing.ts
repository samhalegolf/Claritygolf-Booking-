import { useCallback, useEffect, useRef, useState } from "react";
import {
  DrawingHandle,
  DrawingObject,
  DrawingPoint,
  DrawingTool,
} from "../models/Drawing";
import { Dimensions, DrawingEngine } from "../engines/DrawingEngine";

interface DrawingInteraction {
  objectId: string;
  handle: DrawingHandle;
  startX: number;
  startY: number;
  hasMoved: boolean;
}

interface UseDrawingState {
  objects: DrawingObject[];
  selectedObjectId: string | null;
  /** The object whose handles are showing: the one being edited, the one a
   *  finger has armed, or the one the cursor is over. */
  activeObjectId: string | null;
  /** True while the cursor is over something that a press would pick up. */
  hoverGrabbable: boolean;
  selectedTool: DrawingTool;
  draftObject: DrawingObject | null;
  canUndo: boolean;
  canRedo: boolean;
}

export interface UseDrawingOptions {
  initialObjects: DrawingObject[];
  videoDimensions: Dimensions;
  onChange?: (objects: DrawingObject[]) => void;
}

export interface PointerMeta {
  pointerType?: string;
}

export interface UseDrawingResult extends UseDrawingState {
  setTool: (tool: DrawingTool) => void;
  pointerDown: (cursor: DrawingPoint, meta?: PointerMeta) => void;
  /** Mouse movement with nothing pressed. Null when the cursor leaves. */
  pointerHover: (cursor: DrawingPoint | null) => void;
  /** Whether a press here would land on an existing shape. */
  hitTest: (cursor: DrawingPoint) => boolean;
  pointerMove: (cursor: DrawingPoint) => void;
  pointerUp: (cursor: DrawingPoint) => void;
  cancel: () => void;
  deleteSelected: () => void;
  deleteByIds: (objectIds: string[]) => void;
  clearAll: () => void;
  isDrawingActionActive: boolean;
  isObjectDragging: boolean;
  draggingObjectId: string | null;
  selectObject: (objectId: string | null) => void;
  undo: () => void;
  redo: () => void;
  nudgeSelected: (
    direction: -1 | 1,
    axis: "x" | "y",
    shift: boolean,
    heldFrames: number
  ) => void;
}

const MAX_HISTORY = 80;

type EditMode = "create" | "edit" | null;

interface HistoryState {
  states: DrawingObject[][];
  index: number;
}

const emptyHistory = (objects: DrawingObject[]): HistoryState => ({
  states: [objects],
  index: 0,
});
const DRAG_START_THRESHOLD_PX = 4;
// A finger has no hover, so with a drawing tool in hand it says "pick this up
// instead of drawing" by holding still on top of it. Long enough not to fire
// on an ordinary quick stroke, short enough not to feel like a wait.
const LONG_PRESS_MS = 420;
const LONG_PRESS_SLOP_PX = 8;

interface PendingLongPress {
  timer: ReturnType<typeof setTimeout>;
  objectId: string;
  handle: DrawingHandle;
  x: number;
  y: number;
}

export function useDrawing({
  initialObjects,
  videoDimensions,
  onChange,
}: UseDrawingOptions): UseDrawingResult {
  const [objects, setObjects] = useState<DrawingObject[]>(initialObjects);
  const [history, setHistory] = useState<HistoryState>(emptyHistory(initialObjects));
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [selectedTool, setSelectedTool] = useState<DrawingTool>("select");
  const [draftObject, setDraftObject] = useState<DrawingObject | null>(null);
  const [interaction, setInteraction] = useState<DrawingInteraction | null>(null);
  const [editMode, setEditMode] = useState<EditMode>(null);
  // What the cursor is over, and what a finger has held down on. Both only
  // decide whether handles are drawn and whether a press picks something up;
  // neither is a selection, so neither survives a tool change.
  const [hoveredObjectId, setHoveredObjectId] = useState<string | null>(null);
  const [armedObjectId, setArmedObjectId] = useState<string | null>(null);
  const longPressRef = useRef<PendingLongPress | null>(null);
  const syncedRef = useRef("");

  const cancelLongPress = useCallback(() => {
    if (!longPressRef.current) return;
    clearTimeout(longPressRef.current.timer);
    longPressRef.current = null;
  }, []);

  useEffect(() => cancelLongPress, [cancelLongPress]);

  const canUndo = history.index > 0;
  const canRedo = history.index < history.states.length - 1;

  useEffect(() => {
    const nextKey = JSON.stringify(initialObjects);
    if (nextKey === syncedRef.current) return;
    // Protected boundary: do not merge external persistence snapshots into the local edit history.
    syncedRef.current = nextKey;
    setObjects(initialObjects);
    setHistory(emptyHistory(initialObjects));
    setDraftObject(null);
    setInteraction(null);
    setEditMode(null);
    setSelectedObjectId(null);
    setHoveredObjectId(null);
    setArmedObjectId(null);
  }, [initialObjects]);

  const setSyncedObjects = (next: DrawingObject[]) => {
    syncedRef.current = JSON.stringify(next);
  };

  const isDrawingActionActive = !!(
    (editMode === "create" || editMode === "edit") &&
    draftObject
  );
  const draggingObjectId =
    editMode === "edit" && interaction?.hasMoved && interaction.objectId
      ? interaction.objectId
      : null;

  const commit = useCallback(
    (next: DrawingObject[]) => {
      setObjects(next);
      setHistory((prev) => {
        const sliced = prev.states.slice(0, prev.index + 1);
        const withNext = [...sliced, next];
        const trimmed =
          withNext.length > MAX_HISTORY
            ? withNext.slice(withNext.length - MAX_HISTORY)
            : withNext;
        const nextIndex = trimmed.length - 1;
        return { states: trimmed, index: nextIndex };
      });
      setDraftObject(null);
      setInteraction(null);
      setEditMode(null);
      setSyncedObjects(next);
      onChange?.(next);
    },
    [onChange]
  );

  const setTool = useCallback(
    (tool: DrawingTool) => {
      cancelLongPress();
      setSelectedTool(tool);
      setDraftObject(null);
      setInteraction(null);
      setEditMode(null);
      setArmedObjectId(null);
      setHoveredObjectId(null);
    },
    [cancelLongPress]
  );

  const beginEdit = useCallback(
    (objectId: string, handle: DrawingHandle, cursor: DrawingPoint) => {
      setSelectedObjectId(objectId);
      setInteraction({
        objectId,
        handle,
        startX: cursor.x,
        startY: cursor.y,
        hasMoved: false,
      });
      setEditMode("edit");
      setDraftObject(null);
    },
    []
  );

  /**
   * Mouse movement with nothing pressed.
   *
   * This is the whole affordance on a desktop: the handles are not a state the
   * shape is left in after it is drawn, they are what the shape shows when the
   * cursor is on it, saying "press here and you will move this rather than
   * draw a new one".
   */
  const pointerHover = useCallback(
    (cursor: DrawingPoint | null) => {
      if (!cursor) {
        setHoveredObjectId(null);
        return;
      }
      const { width, height } = videoDimensions;
      if (!width || !height) return;
      // Mid-gesture the handles that matter are already up.
      if (editMode) return;
      const hit = DrawingEngine.getObjectsAtPoint(
        objects,
        cursor,
        videoDimensions,
        selectedTool !== "select"
      );
      setHoveredObjectId(hit.object ? hit.object.id : null);
    },
    [editMode, objects, selectedTool, videoDimensions]
  );

  const hitTest = useCallback(
    (cursor: DrawingPoint) => {
      const { width, height } = videoDimensions;
      if (!width || !height) return false;
      return Boolean(
        DrawingEngine.getObjectsAtPoint(
          objects,
          cursor,
          videoDimensions,
          selectedTool !== "select"
        ).object
      );
    },
    [objects, selectedTool, videoDimensions]
  );

  const pointerDown = useCallback(
    (cursor: DrawingPoint, meta?: PointerMeta) => {
      const { width, height } = videoDimensions;
      if (!width || !height) return;
      cancelLongPress();

      const hit = DrawingEngine.getObjectsAtPoint(
        objects,
        cursor,
        videoDimensions,
        selectedTool !== "select"
      );
      const isTouch = meta?.pointerType === "touch";

      if (hit.object && hit.handle) {
        // Picking up what is already there beats drawing a new one -- with a
        // mouse the handles under the cursor have already said as much, and a
        // finger that has held the shape long enough has asked for it.
        const needsHold =
          isTouch && selectedTool !== "select" && armedObjectId !== hit.object.id;
        if (!needsHold) {
          setArmedObjectId(hit.object.id);
          beginEdit(hit.object.id, hit.handle, cursor);
          return;
        }
        const objectId = hit.object.id;
        const handle = hit.handle;
        const startX = cursor.x;
        const startY = cursor.y;
        setSelectedObjectId(null);
        // Undecided: the stroke starts as usual, and the hold takes it back if
        // the finger stays put. Moving off first cancels the hold and leaves a
        // normal stroke behind.
        longPressRef.current = {
          objectId,
          handle,
          x: startX,
          y: startY,
          timer: setTimeout(() => {
            longPressRef.current = null;
            setArmedObjectId(objectId);
            beginEdit(objectId, handle, { x: startX, y: startY });
          }, LONG_PRESS_MS),
        };
      } else {
        setArmedObjectId(null);
        setSelectedObjectId(null);
      }

      if (selectedTool === "select") {
        setDraftObject(null);
        setInteraction(null);
        setEditMode(null);
        return;
      }
      const draft = DrawingEngine.createObject(selectedTool, cursor, videoDimensions);
      setDraftObject(draft);
      setEditMode("create");
      setInteraction(null);
    },
    [armedObjectId, beginEdit, cancelLongPress, objects, selectedTool, videoDimensions]
  );

  const pointerMove = useCallback(
    (cursor: DrawingPoint) => {
      const { width, height } = videoDimensions;
      if (!width || !height) return;
      const pending = longPressRef.current;
      if (
        pending &&
        Math.hypot(cursor.x - pending.x, cursor.y - pending.y) > LONG_PRESS_SLOP_PX
      ) {
        // Travelled: this was a stroke that happened to start on something.
        cancelLongPress();
      }
      if (!editMode) return;
      if (editMode === "create") {
        if (!draftObject) return;
        setDraftObject(DrawingEngine.updateDraftObject(draftObject, cursor, videoDimensions));
        return;
      }
      if (editMode === "edit" && interaction && selectedObjectId) {
        const target = objects.find((entry) => entry.id === selectedObjectId);
        if (!target || !interaction) return;
        const movedPx = Math.hypot(
          cursor.x - interaction.startX,
          cursor.y - interaction.startY
        );
        if (!interaction.hasMoved && movedPx < DRAG_START_THRESHOLD_PX) {
          return;
        }
        const nextInteraction =
          interaction.hasMoved ? interaction : { ...interaction, hasMoved: true };
        if (!interaction.hasMoved) {
          setInteraction(nextInteraction);
        }
        const updated = DrawingEngine.transformObject(
          target,
          interaction.handle,
          cursor,
          { x: interaction.startX, y: interaction.startY },
          videoDimensions
        );
        setDraftObject(updated);
      }
    },
    [
      cancelLongPress,
      draftObject,
      editMode,
      interaction,
      objects,
      selectedObjectId,
      videoDimensions,
    ]
  );

  const pointerUp = useCallback(
    (cursor: DrawingPoint) => {
      cancelLongPress();
      if (!videoDimensions.width || !videoDimensions.height) return;
      if (editMode === "create") {
        if (draftObject && DrawingEngine.canFinishDraft(draftObject)) {
          commit([...objects, draftObject]);
          // Released is placed. The shape drops its handles and becomes part of
          // the picture; it used to stay selected, which left every press after
          // it dragging the thing that had just been put down. Getting it back
          // is hovering it (or holding it, on a phone), not remembering it is
          // still live. The tool drops to select so the next press is not
          // another shape nobody asked for.
          setSelectedObjectId(null);
          setArmedObjectId(null);
          setHoveredObjectId(null);
          setSelectedTool("select");
          return;
        }
        setDraftObject(null);
        setInteraction(null);
        setEditMode(null);
        return;
      }
      // A press that never passed the drag threshold is a selection, not an edit.
      if (editMode === "edit" && selectedObjectId && interaction?.hasMoved) {
        const base = objects.find((entry) => entry.id === selectedObjectId);
        const moved =
          draftObject && draftObject.id === selectedObjectId
            ? draftObject
            : base
              ? DrawingEngine.transformObject(
                  base,
                  interaction.handle,
                  cursor,
                  { x: interaction.startX, y: interaction.startY },
                  videoDimensions
                )
              : null;
        if (moved) {
          commit(objects.map((entry) => (entry.id === selectedObjectId ? moved : entry)));
          return;
        }
      }
      setDraftObject(null);
      setInteraction(null);
      setEditMode(null);
    },
    [
      cancelLongPress,
      commit,
      draftObject,
      editMode,
      interaction,
      objects,
      selectedObjectId,
      videoDimensions,
    ]
  );

  const cancel = useCallback(() => {
    cancelLongPress();
    setSelectedObjectId(null);
    setArmedObjectId(null);
    setHoveredObjectId(null);
    setDraftObject(null);
    setInteraction(null);
    setEditMode(null);
    setSelectedTool("select");
  }, [cancelLongPress]);

  const deleteByIds = useCallback(
    (objectIds: string[]) => {
      if (!objectIds.length) return;
      const objectIdSet = new Set(objectIds);
      const nextObjects = objects.filter((entry) => !objectIdSet.has(entry.id));
      if (nextObjects.length === objects.length) return;
      if (selectedObjectId && objectIdSet.has(selectedObjectId)) {
        setSelectedObjectId(null);
      }
      setArmedObjectId((current) => (current && objectIdSet.has(current) ? null : current));
      setHoveredObjectId((current) => (current && objectIdSet.has(current) ? null : current));
      commit(nextObjects);
    },
    [commit, objects, selectedObjectId]
  );

  const deleteSelected = useCallback(() => {
    if (!selectedObjectId) return;
    deleteByIds([selectedObjectId]);
  }, [deleteByIds, selectedObjectId]);

  const clearAll = useCallback(() => {
    if (!objects.length) return;
    deleteByIds(objects.map((entry) => entry.id));
  }, [deleteByIds, objects]);

  const nudgeSelected = useCallback(
    (direction: -1 | 1, axis: "x" | "y", shift: boolean, heldFrames = 1) => {
      if (!selectedObjectId) return;
      if (!videoDimensions.width || !videoDimensions.height) return;
      const target = objects.find((entry) => entry.id === selectedObjectId);
      if (!target) return;
      const baseStep = shift ? 0.012 : 0.005;
      const speed = Math.max(1, heldFrames);
      const normalizedStep = baseStep * speed;
      const deltaX = axis === "x" ? direction * normalizedStep : 0;
      const deltaY = axis === "y" ? direction * normalizedStep : 0;
      const moved = DrawingEngine.moveObject(target, deltaX, deltaY);
      const nextObjects = objects.map((entry) =>
        entry.id === selectedObjectId ? moved : entry
      );
      commit(nextObjects);
    },
    [commit, objects, selectedObjectId, videoDimensions.height, videoDimensions.width]
  );

  const selectObject = useCallback((objectId: string | null) => {
    setSelectedObjectId(objectId);
    // Nothing in hand means nothing in hand: a shape a finger had armed keeps
    // its handles otherwise, and keeps grabbing the next press with it.
    if (!objectId) {
      setArmedObjectId(null);
      setHoveredObjectId(null);
    }
  }, []);

  const undo = useCallback(() => {
    setHistory((prev) => {
      if (prev.index <= 0) return prev;
      const nextIndex = prev.index - 1;
      const nextObjects = prev.states[nextIndex];
      setObjects(nextObjects);
      setSyncedObjects(nextObjects);
      onChange?.(nextObjects);
      return { ...prev, index: nextIndex };
    });
  }, [onChange]);

  const redo = useCallback(() => {
    setHistory((prev) => {
      if (prev.index >= prev.states.length - 1) return prev;
      const nextIndex = prev.index + 1;
      const nextObjects = prev.states[nextIndex];
      setObjects(nextObjects);
      setSyncedObjects(nextObjects);
      onChange?.(nextObjects);
      return { ...prev, index: nextIndex };
    });
  }, [onChange]);

  const allObjects = [...objects];
  const isObjectDragging = !!draggingObjectId;
  if (draftObject && editMode === "create") {
    allObjects.push(draftObject);
  }
  if (draftObject && editMode === "edit" && selectedObjectId) {
    const contains = objects.some((entry) => entry.id === selectedObjectId);
    if (contains) {
      const replaced = objects.map((entry) =>
        entry.id === selectedObjectId ? draftObject : entry
      );
      // replaced is just used for UI render; it should not become history until pointer release
      allObjects.length = 0;
      allObjects.push(...replaced);
    }
  }

  // Handles belong to whatever is in hand right now: the shape being edited,
  // the one a finger armed, or the one under the cursor.
  const activeObjectId = selectedObjectId || armedObjectId || hoveredObjectId || null;

  return {
    objects: allObjects,
    selectedObjectId,
    activeObjectId,
    hoverGrabbable: Boolean(hoveredObjectId),
    selectedTool,
    draftObject: editMode ? draftObject : null,
    canUndo,
    canRedo,
    setTool,
    pointerDown,
    pointerHover,
    hitTest,
    pointerMove,
    pointerUp,
    cancel,
    deleteByIds,
    clearAll,
    isDrawingActionActive,
    isObjectDragging,
    draggingObjectId,
    deleteSelected,
    selectObject,
    undo,
    redo,
    nudgeSelected,
  };
}
