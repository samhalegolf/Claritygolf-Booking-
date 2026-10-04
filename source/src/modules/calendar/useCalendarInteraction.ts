import { useEffect, useRef, useState } from "react";
import { WEEK_FOCUS_INDEX, WEEK_PEEK } from "../../calendar-axis";
import {
  ARMED_TOUCH_DRAG_THRESHOLD,
  type Draft,
  FloatingDrag,
  MOUSE_DRAG_THRESHOLD,
  PlacementAnimation,
  PointerSession,
  QuickCreateState,
  SlotCandidate,
  TOUCH_DRAG_THRESHOLD,
} from "./calendarModel";

/**
 * What the calendar's gestures share: the drag or resize in progress, the
 * quick-create popover, and the refs the grid, the week strip and the dock
 * read while a pointer is down.
 *
 * Here too are the small helpers that touch nothing else (is the pointer over
 * the grid, has it moved far enough to be a drag, cancel a touch hold). The
 * handlers that drive a gesture stay with the screen that owns it -- the
 * calendar or the dock -- and both read this.
 */
export function useCalendarInteraction() {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pointerSession, setPointerSession] = useState<PointerSession>(null);
  // The card a finger is currently resting on, waiting out the hold. Drives
  // the press-in cue so the wait is visible rather than a dead half second.
  const [holdingItemId, setHoldingItemId] = useState<string | null>(null);
  const [quickCreate, setQuickCreate] = useState<QuickCreateState | null>(null);
  const [quickClientSearch, setQuickClientSearch] = useState("");
  const [quickMatchField, setQuickMatchField] = useState<"name" | "phone" | "email" | "">("");
  const [placementAnimation, setPlacementAnimation] = useState<PlacementAnimation | null>(null);
  const [floatingDrag, setFloatingDrag] = useState<FloatingDrag | null>(null);
  const [hasMoved, setHasMoved] = useState(false);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const pointerSessionRef = useRef<PointerSession>(null);
  const suppressItemClickRef = useRef(false);
  const suppressItemClickUntilRef = useRef(0);
  // The two halves of the week pager: the date strip takes the gesture, the
  // grid is driven from it and never scrolled directly.
  const weekStripRef = useRef<HTMLDivElement | null>(null);
  const weekPanelsRef = useRef<HTMLDivElement | null>(null);
  // The vertical scroller (.calendar-scroll). The week pager owns the
  // horizontal axis; this is the only thing that moves up and down.
  const calendarScrollRef = useRef<HTMLDivElement | null>(null);
  const weekSettleTimerRef = useRef<number | null>(null);
  const weekLandingTimerRef = useRef<number | null>(null);
  // Set while the pager repositions itself, so the scroll events that causes
  // are not read back as the user paging again.
  const weekPagerSyncingRef = useRef(false);
  const clickPlaceRef = useRef<null | { bookingId: string; candidate: SlotCandidate }>(null);
  const pointerClientRef = useRef({ x: 0, y: 0 });
  const pointerStartRef = useRef({ x: 0, y: 0 });
  const pointerKindRef = useRef<globalThis.PointerEvent["pointerType"]>("mouse");
  const dragPreviewMetaRef = useRef<null | { width: number; height: number; offsetX: number; offsetY: number }>(null);
  // The touch hold that has to complete before a card can be dragged.
  const touchHoldTimerRef = useRef<number | null>(null);
  const touchHoldCleanupRef = useRef<null | (() => void)>(null);
  const pendingQuickCreateRef = useRef<QuickCreateState | null>(null);
  // A business owner who coaches opens on their own calendar, where bookings
  // are theirs without asking. "All calendars" is still one pick away, and
  // once they pick a view it stays theirs.
  const calendarPerspectiveChosenRef = useRef(false);

  useEffect(() => {
    if (!quickCreate) setQuickClientSearch("");
  }, [quickCreate]);

  useEffect(
    () => () => {
      if (weekSettleTimerRef.current) window.clearTimeout(weekSettleTimerRef.current);
      if (weekLandingTimerRef.current) window.clearTimeout(weekLandingTimerRef.current);
    },
    [],
  );

  function isClientInsideGrid(clientX: number, clientY: number) {
    const grid = gridRef.current;
    if (!grid) return false;
    const rect = grid.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  }

  function setPointerSessionState(nextSession: PointerSession) {
    pointerSessionRef.current = nextSession;
    setPointerSession(nextSession);
  }

  function hasPointerMovedPastThreshold(clientX: number, clientY: number) {
    const deltaX = clientX - pointerStartRef.current.x;
    const deltaY = clientY - pointerStartRef.current.y;
    const threshold =
      pointerKindRef.current === "touch"
        ? pointerSessionRef.current
          ? ARMED_TOUCH_DRAG_THRESHOLD
          : TOUCH_DRAG_THRESHOLD
        : MOUSE_DRAG_THRESHOLD;
    return Math.hypot(deltaX, deltaY) >= threshold;
  }

  function setFloatingDragFromPointer(itemId: string, clientX: number, clientY: number) {
    const meta = dragPreviewMetaRef.current;
    if (!meta) return;
    setFloatingDrag({
      itemId,
      x: clientX - meta.offsetX,
      y: clientY - meta.offsetY,
      width: meta.width,
      height: meta.height,
    });
  }

  // --- Week pager ----------------------------------------------------------
  // The date strip is the only thing that takes the horizontal gesture; the
  // grid mirrors its scroll position and is never scrolled directly. Three
  // panels are mounted at a time and the focused week is always the middle
  // one, so landing on a neighbour swaps the week and re-centres underneath —
  // the panel you scrolled to becomes the panel you are looking at, which is
  // what makes the recentre invisible.
  function weekPagerStep() {
    const strip = weekStripRef.current;
    if (!strip) return 0;
    return Math.max(1, strip.clientWidth - WEEK_PEEK);
  }

  function centreWeekPager() {
    const strip = weekStripRef.current;
    const panels = weekPanelsRef.current;
    if (!strip) return;
    // Any pending landing would put the strip back on the panel we just came
    // from, so it goes with the week it belonged to — along with the class it
    // would otherwise have been left to clear.
    if (weekLandingTimerRef.current) {
      window.clearTimeout(weekLandingTimerRef.current);
      weekLandingTimerRef.current = null;
    }
    strip.classList.remove("is-grabbing");
    const left = weekPagerStep() * WEEK_FOCUS_INDEX;
    weekPagerSyncingRef.current = true;
    strip.scrollLeft = left;
    if (panels) panels.scrollLeft = left;
    window.setTimeout(() => {
      weekPagerSyncingRef.current = false;
    }, 60);
  }

  // --- Touch hold ----------------------------------------------------------
  // Arming a drag is split from starting one. A mouse arms on press, because a
  // press with a mouse is unambiguous; a finger arms only after TOUCH_HOLD_MS
  // of stillness. Everything below the arm point is shared, so a touch drag and
  // a mouse drag are the same gesture once running.

  function cancelTouchHold() {
    if (touchHoldTimerRef.current !== null) {
      window.clearTimeout(touchHoldTimerRef.current);
      touchHoldTimerRef.current = null;
    }
    touchHoldCleanupRef.current?.();
    touchHoldCleanupRef.current = null;
    setHoldingItemId(null);
  }

  return {
    draft,
    setDraft,
    pointerSession,
    holdingItemId,
    setHoldingItemId,
    quickCreate,
    setQuickCreate,
    quickClientSearch,
    setQuickClientSearch,
    quickMatchField,
    setQuickMatchField,
    placementAnimation,
    setPlacementAnimation,
    floatingDrag,
    setFloatingDrag,
    hasMoved,
    setHasMoved,
    gridRef,
    pointerSessionRef,
    suppressItemClickRef,
    suppressItemClickUntilRef,
    weekStripRef,
    weekPanelsRef,
    calendarScrollRef,
    weekSettleTimerRef,
    weekLandingTimerRef,
    weekPagerSyncingRef,
    clickPlaceRef,
    pointerClientRef,
    pointerStartRef,
    pointerKindRef,
    dragPreviewMetaRef,
    touchHoldTimerRef,
    touchHoldCleanupRef,
    pendingQuickCreateRef,
    calendarPerspectiveChosenRef,
    isClientInsideGrid,
    setPointerSessionState,
    hasPointerMovedPastThreshold,
    setFloatingDragFromPointer,
    weekPagerStep,
    centreWeekPager,
    cancelTouchHold,
  };
}

export type CalendarInteraction = ReturnType<typeof useCalendarInteraction>;
