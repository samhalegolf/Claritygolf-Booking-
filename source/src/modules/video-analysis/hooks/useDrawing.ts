import { useCallback, useEffect, useRef, useState } from "react";
import {
  DrawingHandle,
  DrawingObject,
  DrawingPoint,
  DrawingTool,
} from "../models/Drawing";
import { Dimensions, DrawingEngine, hitReachFor } from "../engines/DrawingEngine";

interface DrawingInteraction {
  objectId: string;
  handle: DrawingHandle;
  startX: number;
  startY: number;
  hasMoved: boolean;
  /** How far the press may wander before it counts as a drag. */
  dragThresholdPx: number;
}

interface UseDrawingState {
  objects: DrawingObject[];
  selectedObjectId: string | null;
  /** The object whose handles are showing: the one being edited, or the one
   *  the select tool's cursor is over. */
  activeObjectId: string | null;
  /** True while the select tool's cursor is over something a press would pick up. */
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
  hitTest: (cursor: DrawingPoint, meta?: PointerMeta) => boolean;
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

// A cursor sits still when it is told to; a fingertip does not. A tap on a
// shape has to be able to land, roll a little and lift without having shifted
// the shape, so a finger gets the same slop a phone gives its own gestures.
const DRAG_START_THRESHOLD_MOUSE_PX = 4;
const DRAG_START_THRESHOLD_TOUCH_PX = 10;

const dragThresholdFor = (pointerType?: string) =>
  pointerType === "touch" ? DRAG_START_THRESHOLD_TOUCH_PX : DRAG_START_THRESHOLD_MOUSE_PX;

/**
 * The drawing layer's one rule: a drawing tool draws, the select tool moves.
 *
 * With Line, Angle, Circle or Draw in hand a press always starts a new shape,
 * even on top of an old one, and the tool stays in hand afterwards so the
 * next line does not mean going back to the rail. Moving, resizing and
 * deleting are what Select is for, and nothing else picks a shape up.
 */
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
  // What the select tool's cursor is over. It only decides whether handles are
  // drawn; it is not a selection, so it does not survive a tool change.
  const [hoveredObjectId, setHoveredObjectId] = useState<string | null>(null);
  const syncedRef = useRef("");

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

  const setTool = useCallback((tool: DrawingTool) => {
    setSelectedTool(tool);
    setDraftObject(null);
    setInteraction(null);
    setEditMode(null);
    setHoveredObjectId(null);
    // A shape left selected under a drawing tool would keep its handles up
    // while promising a move that the tool will not make.
    if (tool !== "select") {
      setSelectedObjectId(null);
    }
  }, []);

  /**
   * Mouse movement with nothing pressed.
   *
   * This is the whole affordance on a desktop: the handles are not a state the
   * shape is left in after it is drawn, they are what the shape shows when the
   * select tool's cursor is on it, saying "press here and you will move this".
   * A drawing tool shows nothing, because under it a press draws regardless.
   */
  const pointerHover = useCallback(
    (cursor: DrawingPoint | null) => {
      if (!cursor || selectedTool !== "select") {
        setHoveredObjectId(null);
        return;
      }
      const { width, height } = videoDimensions;
      if (!width || !height) return;
      // Mid-gesture the handles that matter are already up.
      if (editMode) return;
      const hit = DrawingEngine.getObjectsAtPoint(objects, cursor, videoDimensions);
      setHoveredObjectId(hit.object ? hit.object.id : null);
    },
    [editMode, objects, selectedTool, videoDimensions]
  );

  const hitTest = useCallback(
    (cursor: DrawingPoint, meta?: PointerMeta) => {
      const { width, height } = videoDimensions;
      if (!width || !height) return false;
      return Boolean(
        DrawingEngine.getObjectsAtPoint(
          objects,
          cursor,
          videoDimensions,
          hitReachFor(meta?.pointerType)
        ).object
      );
    },
    [objects, videoDimensions]
  );

  const pointerDown = useCallback(
    (cursor: DrawingPoint, meta?: PointerMeta) => {
      const { width, height } = videoDimensions;
      if (!width || !height) return;

      if (selectedTool !== "select") {
        setSelectedObjectId(null);
        setDraftObject(DrawingEngine.createObject(selectedTool, cursor, videoDimensions));
        setEditMode("create");
        setInteraction(null);
        return;
      }

      const hit = DrawingEngine.getObjectsAtPoint(
        objects,
        cursor,
        videoDimensions,
        hitReachFor(meta?.pointerType)
      );
      if (!hit.object || !hit.handle) {
        setSelectedObjectId(null);
        setDraftObject(null);
        setInteraction(null);
        setEditMode(null);
        return;
      }
      setSelectedObjectId(hit.object.id);
      setInteraction({
        objectId: hit.object.id,
        handle: hit.handle,
        startX: cursor.x,
        startY: cursor.y,
        hasMoved: false,
        dragThresholdPx: dragThresholdFor(meta?.pointerType),
      });
      setEditMode("edit");
      setDraftObject(null);
    },
    [objects, selectedTool, videoDimensions]
  );

  const pointerMove = useCallback(
    (cursor: DrawingPoint) => {
      const { width, height } = videoDimensions;
      if (!width || !height) return;
      if (!editMode) return;
      if (editMode === "create") {
        if (!draftObject) return;
        setDraftObject(DrawingEngine.updateDraftObject(draftObject, cursor, videoDimensions));
        return;
      }
      if (editMode === "edit" && interaction && selectedObjectId) {
        const target = objects.find((entry) => entry.id === selectedObjectId);
        if (!target) return;
        const movedPx = Math.hypot(
          cursor.x - interaction.startX,
          cursor.y - interaction.startY
        );
        if (!interaction.hasMoved && movedPx < interaction.dragThresholdPx) {
          return;
        }
        if (!interaction.hasMoved) {
          setInteraction({ ...interaction, hasMoved: true });
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
    [draftObject, editMode, interaction, objects, selectedObjectId, videoDimensions]
  );

  const pointerUp = useCallback(
    (cursor: DrawingPoint) => {
      if (!videoDimensions.width || !videoDimensions.height) return;
      if (editMode === "create") {
        if (draftObject && DrawingEngine.canFinishDraft(draftObject)) {
          // Released is placed. The shape joins the picture with no handles
          // and no selection, and the tool stays in hand: a coach marking a
          // frame draws a plane, then a spine line, then a circle, and
          // should not have to fetch the tool again for each. Getting a shape
          // back is the select tool's job.
          commit([...objects, draftObject]);
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
    [commit, draftObject, editMode, interaction, objects, selectedObjectId, videoDimensions]
  );

  /** Drop whatever is in progress and put the tool down. */
  const cancel = useCallback(() => {
    setSelectedObjectId(null);
    setHoveredObjectId(null);
    setDraftObject(null);
    setInteraction(null);
    setEditMode(null);
    setSelectedTool("select");
  }, []);

  const deleteByIds = useCallback(
    (objectIds: string[]) => {
      if (!objectIds.length) return;
      const objectIdSet = new Set(objectIds);
      const nextObjects = objects.filter((entry) => !objectIdSet.has(entry.id));
      if (nextObjects.length === objects.length) return;
      if (selectedObjectId && objectIdSet.has(selectedObjectId)) {
        setSelectedObjectId(null);
      }
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
    if (!objectId) {
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
  // or the one under the select tool's cursor.
  const activeObjectId = selectedObjectId || hoveredObjectId || null;

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
