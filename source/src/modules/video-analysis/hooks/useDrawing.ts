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

export interface UseDrawingResult extends UseDrawingState {
  setTool: (tool: DrawingTool) => void;
  pointerDown: (cursor: DrawingPoint) => void;
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
  }, []);

  const pointerDown = useCallback(
    (cursor: DrawingPoint) => {
      const { width, height } = videoDimensions;
      if (!width || !height) return;
      if (selectedTool === "select") {
        const hit = DrawingEngine.getObjectsAtPoint(objects, cursor, videoDimensions);
        if (hit.object && hit.handle) {
          setSelectedObjectId(hit.object.id);
          setInteraction({
            objectId: hit.object.id,
            handle: hit.handle,
            startX: cursor.x,
            startY: cursor.y,
            hasMoved: false,
          });
          setEditMode("edit");
        } else {
          setSelectedObjectId(null);
          setInteraction(null);
          setEditMode(null);
        }
        return;
      }
      const draft = DrawingEngine.createObject(selectedTool, cursor, videoDimensions);
      setDraftObject(draft);
      setEditMode("create");
      setInteraction(null);
    },
    [objects, selectedTool, videoDimensions]
  );

  const pointerMove = useCallback(
    (cursor: DrawingPoint) => {
      const { width, height } = videoDimensions;
      if (!width || !height) return;
      if (!draftObject) return;
      if (!editMode) return;
      if (editMode === "create") {
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
    [draftObject, editMode, interaction, objects, selectedObjectId, videoDimensions]
  );

  const pointerUp = useCallback(
    (cursor: DrawingPoint) => {
      if (!videoDimensions.width || !videoDimensions.height) return;
      if (!draftObject) {
        setEditMode(null);
        setInteraction(null);
        return;
      }
      if (editMode === "create") {
        if (DrawingEngine.canFinishDraft(draftObject)) {
          commit([...objects, draftObject]);
          setDraftObject(null);
        } else {
          setDraftObject(null);
          setEditMode(null);
        }
        return;
      }
      if (editMode === "edit" && selectedObjectId) {
        if (!interaction?.hasMoved) {
          setDraftObject(null);
          setInteraction(null);
          setEditMode(null);
          return;
        }
        let nextObjects = objects;
        if (draftObject.id === selectedObjectId) {
          nextObjects = objects.map((entry) =>
            entry.id === selectedObjectId ? draftObject : entry
          );
        }
        commit(nextObjects);
        return;
      }
      if (selectedObjectId) {
        const base = objects.find((entry) => entry.id === selectedObjectId);
        if (base && interaction) {
          const moved = DrawingEngine.transformObject(
            base,
            interaction.handle,
            cursor,
            { x: interaction.startX, y: interaction.startY },
            videoDimensions
          );
          const nextObjects = objects.map((entry) =>
            entry.id === selectedObjectId ? moved : entry
          );
          commit(nextObjects);
          return;
        }
      }
      setDraftObject(null);
      setInteraction(null);
      setEditMode(null);
    },
    [commit, draftObject, editMode, interaction, objects, selectedObjectId, videoDimensions]
  );

  const cancel = useCallback(() => {
    setSelectedObjectId(null);
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
  if (draftObject && editMode === "create" && !selectedObjectId) {
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

  return {
    objects: allObjects,
    selectedObjectId,
    selectedTool,
    draftObject: editMode ? draftObject : null,
    canUndo,
    canRedo,
    setTool,
    pointerDown,
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
