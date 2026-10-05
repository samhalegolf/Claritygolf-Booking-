import { type RefObject, useEffect, useRef, useState } from "react";

/** A step the phone can take sideways: where it goes, and what that page is called. */
export type PhoneStep = { label: string; go: () => void };

/** How far, as a share of the screen, a swipe has to travel to count. */
const COMMIT_SHARE = 0.3;
/** A quick flick counts however short it is (px per ms). */
const FLICK_SPEED = 0.5;
/** Movement before the gesture decides whether it is sideways at all. */
const DECIDE_PX = 10;
const SETTLE_MS = 200;

/** Somewhere a sideways drag already means something: a field, or a strip that scrolls sideways. */
function claimsSideways(target: EventTarget | null, panel: HTMLElement) {
  for (let node = target instanceof Element ? target : null; node && node !== panel; node = node.parentElement) {
    if (node.matches("input, textarea, select, [contenteditable='true'], [data-no-swipe]")) return true;
    const overflowX = getComputedStyle(node).overflowX;
    if ((overflowX === "auto" || overflowX === "scroll") && node.scrollWidth > node.clientWidth) return true;
  }
  return false;
}

/**
 * The phone's sideways swipe between a menu and the page inside it, alongside
 * the topbar's Back arrow.
 *
 * The screen reads as a stack of paper: a page you stepped into sits on top
 * of the one it came from, whose edge shows down the left. Swiping right
 * slides the top sheet off to uncover that one (Back); swiping left on a menu
 * slides the page you were last on back over it (Forward). Both follow the
 * finger and only commit past a third of the screen or on a flick, so a
 * half-swipe lets go and settles back.
 *
 * The page is moved by writing its transform directly rather than through
 * React state, so dragging re-renders this component and not the workspace.
 */
export function PhoneStepSwipe({
  panelRef,
  back,
  forward,
  paper = true,
}: {
  panelRef: RefObject<HTMLElement | null>;
  back: PhoneStep | null;
  forward: PhoneStep | null;
  /**
   * Draw the sheets underneath. Off for a page that already lies over the
   * real screen it came from (the client profile over the list): sliding it
   * uncovers that screen itself.
   */
  paper?: boolean;
}) {
  // Which sheet is showing beside the page while a drag is under way.
  const [revealing, setRevealing] = useState<"back" | "forward" | null>(null);
  const incomingRef = useRef<HTMLDivElement>(null);
  const stepsRef = useRef({ back, forward });
  stepsRef.current = { back, forward };

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    let start: { x: number; y: number; at: number } | null = null;
    let direction: "back" | "forward" | null = null;
    let offset = 0;

    const width = () => panel.clientWidth || window.innerWidth;

    function place(dx: number, animate: boolean) {
      if (!panel) return;
      const transition = animate ? `transform ${SETTLE_MS}ms ease` : "none";
      if (direction === "back") {
        panel.style.transition = transition;
        panel.style.transform = dx ? `translateX(${dx}px)` : "";
      } else if (incomingRef.current) {
        incomingRef.current.style.transition = transition;
        incomingRef.current.style.transform = `translateX(${width() + dx}px)`;
      }
    }

    function reset() {
      if (!panel) return;
      panel.style.transition = "";
      panel.style.transform = "";
      start = null;
      direction = null;
      offset = 0;
      setRevealing(null);
    }

    function onStart(event: TouchEvent) {
      if (event.touches.length !== 1 || claimsSideways(event.target, panel!)) return;
      const { back: canBack, forward: canForward } = stepsRef.current;
      if (!canBack && !canForward) return;
      const touch = event.touches[0];
      start = { x: touch.clientX, y: touch.clientY, at: event.timeStamp };
      direction = null;
      offset = 0;
    }

    function onMove(event: TouchEvent) {
      if (!start) return;
      const touch = event.touches[0];
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (!direction) {
        if (Math.abs(dx) < DECIDE_PX && Math.abs(dy) < DECIDE_PX) return;
        const sideways = Math.abs(dx) > Math.abs(dy) * 1.4;
        const wanted = dx > 0 ? "back" : "forward";
        if (!sideways || !stepsRef.current[wanted]) {
          start = null;
          return;
        }
        direction = wanted;
        setRevealing(wanted);
      }
      event.preventDefault();
      offset = direction === "back" ? Math.max(0, dx) : Math.min(0, dx);
      place(offset, false);
    }

    function onEnd(event: TouchEvent) {
      if (!start || !direction) {
        start = null;
        return;
      }
      const elapsed = Math.max(1, event.timeStamp - start.at);
      const distance = Math.abs(offset);
      const step = stepsRef.current[direction];
      const commit = Boolean(step) && (distance > width() * COMMIT_SHARE || distance / elapsed > FLICK_SPEED);
      const finalOffset = commit ? (direction === "back" ? width() : -width()) : 0;
      place(finalOffset, true);
      window.setTimeout(() => {
        if (commit) step?.go();
        reset();
      }, SETTLE_MS);
      start = null;
    }

    panel.addEventListener("touchstart", onStart, { passive: true });
    panel.addEventListener("touchmove", onMove, { passive: false });
    panel.addEventListener("touchend", onEnd);
    panel.addEventListener("touchcancel", onEnd);
    return () => {
      panel.removeEventListener("touchstart", onStart);
      panel.removeEventListener("touchmove", onMove);
      panel.removeEventListener("touchend", onEnd);
      panel.removeEventListener("touchcancel", onEnd);
      reset();
    };
  }, [panelRef]);

  return (
    <>
      {/* The sheet underneath: its edge always, its face while a swipe uncovers it. */}
      {back && paper ? (
        <div className={`phone-paper is-under ${revealing === "back" ? "is-revealed" : ""}`} aria-hidden="true">
          <strong>{back.label}</strong>
        </div>
      ) : null}
      {/* The sheet you were last on, waiting off to the right. */}
      {forward && paper ? (
        <div className="phone-paper-edge is-right" aria-hidden="true" />
      ) : null}
      {revealing === "forward" && forward && paper ? (
        <div className="phone-paper is-incoming" ref={incomingRef} aria-hidden="true" style={{ transform: "translateX(100%)" }}>
          <strong>{forward.label}</strong>
        </div>
      ) : null}
    </>
  );
}
