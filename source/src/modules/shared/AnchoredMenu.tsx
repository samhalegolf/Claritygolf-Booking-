// A small pop-up menu that floats above the page instead of inside its row.
// Rendered into <body>, so a parent with overflow:hidden (rounded list boxes,
// scrolling panels) can never cut it off. It anchors to whatever element it is
// placed inside (put it next to the button that opens it), opens below that
// element, and flips above when there isn't room underneath. Scrolling,
// resizing, Escape or a click outside closes it.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import "./anchoredMenu.css";

const GAP = 4;
const EDGE = 8;

export function AnchoredMenu(props: {
  onClose: () => void;
  className?: string;
  closeLabel: string;
  children: ReactNode;
}) {
  const { onClose, className, closeLabel, children } = props;
  const markerRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const anchor = markerRef.current?.parentElement;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const a = anchor.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const below = a.bottom + GAP;
    const top =
      below + p.height <= window.innerHeight - EDGE
        ? below
        : Math.max(EDGE, a.top - GAP - p.height);
    const left = Math.min(Math.max(EDGE, a.right - p.width), window.innerWidth - EDGE - p.width);
    setPosition({ top, left });
  }, []);

  useEffect(() => {
    const close = () => onCloseRef.current();
    const onScroll = (event: Event) => {
      // The menu's own scrolling (very long menus on short screens) is fine.
      if (panelRef.current?.contains(event.target as Node)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <>
      <span ref={markerRef} hidden />
      {createPortal(
        <>
          <button type="button" className="anchored-menu-scrim" aria-label={closeLabel} onClick={onClose} />
          <div
            ref={panelRef}
            className={`anchored-menu-panel ${className || ""}`}
            role="menu"
            style={{
              top: position?.top ?? 0,
              left: position?.left ?? 0,
              visibility: position ? "visible" : "hidden",
            }}
          >
            {children}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
