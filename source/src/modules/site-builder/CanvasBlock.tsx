// A free layout section, drawn.
//
// On the page the items sit on a grid (CANVAS_COLUMNS across, rows of
// CANVAS_ROW_PX), each covering its own cells; on a phone they stack in
// reading order (site.css). In the editor's edit mode the section is also
// where it is arranged, the way Squarespace's Fluid Engine works: press and
// drag an item to move it, pull one of its eight handles to stretch it, pull
// the bar under the section to make the section taller or shorter, and
// double-click words to type over them. Every move snaps to the grid and is
// written back once, when the pointer lets go; while it is held only this
// section redraws.
//
// The pointer is captured by whatever was pressed, so a drag keeps going
// when it leaves the item, and the maths works in the preview frame's own
// coordinates.

import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from "react";
import { createContext, useContext, useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpToLine, Copy, Heading, Image as ImageIcon, MousePointerClick, Pencil, Square, Trash2, Type } from "lucide-react";

import {
  CANVAS_COLUMNS,
  CANVAS_MAX_ROWS,
  CANVAS_MIN_ROWS,
  CANVAS_ROW_PX,
  canvasRowsNeeded,
  newCanvasItem,
  siteId,
  type SiteButton,
  type SiteCanvasBlock,
  type SiteCanvasItem,
  type SiteCanvasItemKind,
} from "../../../netlify/functions/_shared/site/document.mts";
import { CANVAS_RESIZE_HANDLES, addItem, dragBox, duplicateItem, placeItem, readingOrder, restackItem, type CanvasBox, type CanvasHandle } from "./canvasLayout";
import { EditableText } from "./EditableText";
import type { SiteEditorHooks } from "./SiteRenderer";

/** The editor's hooks, for a free layout drawn in edit mode. Null on the public page and in the plain preview. */
export const CanvasEditor = createContext<SiteEditorHooks | null>(null);

type LinkProps = { href: string; target?: string; rel?: string };

type Drag = {
  itemId: string;
  handle: CanvasHandle | "rows";
  startX: number;
  startY: number;
  box: CanvasBox;
  rows: number;
  moved: boolean;
};

/** Pixels the pointer must travel before a press becomes a drag, so a click stays a click. */
const DRAG_SLOP = 3;

const HEADING_TAG = { h1: "h1", h2: "h2", h3: "h3" } as const;

export function CanvasBlock({
  block,
  Button,
  linkProps,
}: {
  block: SiteCanvasBlock;
  Button: (props: { button: SiteButton | null; className?: string }) => ReactNode;
  linkProps: (href: string) => LinkProps;
}) {
  const editor = useContext(CanvasEditor);
  const gridRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  // Where the held item (and the section's height) is while the pointer is down.
  const [live, setLive] = useState<{ itemId: string; box: CanvasBox; rows: number } | null>(null);
  // The same, kept for the pointer's letting go, which can come before the page has redrawn.
  const liveRef = useRef(live);
  const hold = (next: typeof live) => {
    liveRef.current = next;
    setLive(next);
  };
  const [typing, setTyping] = useState("");

  const selectedId = editor?.canvasItem?.block === block.id ? editor.canvasItem.item : "";
  const order = readingOrder(block.items);
  const boxOf = (item: SiteCanvasItem): CanvasBox => (live && live.itemId === item.id ? live.box : item);
  const rows = live ? live.rows : block.rows;

  const change = (next: Pick<SiteCanvasBlock, "items" | "rows">) => editor?.changeCanvas(block.id, next);
  const remove = (itemId: string) => {
    change({ items: block.items.filter((item) => item.id !== itemId), rows: block.rows });
    editor?.selectCanvasItem(block.id, null);
  };
  const add = (kind: SiteCanvasItemKind, heading = false) => {
    if (!editor) return;
    const words = editor.labels.canvas;
    const fresh = newCanvasItem(kind, 0, { text: heading ? words.newHeading : words.newText, button: words.newButton });
    const item = heading ? { ...fresh, size: "h2" as const, w: 14, h: 5 } : fresh;
    change(addItem(block, item));
    editor?.selectCanvasItem(block.id, item.id);
  };

  // --- The pointer ------------------------------------------------------------

  const begin = (event: PointerEvent<HTMLElement>, item: SiteCanvasItem | null, handle: CanvasHandle | "rows") => {
    if (!editor || event.button !== 0) return;
    if (item && typing === item.id) return;
    event.stopPropagation();
    if (item) {
      editor.selectCanvasItem(block.id, item.id);
      event.currentTarget.closest<HTMLElement>(".site-canvas-item")?.focus({ preventScroll: true });
    }
    // Stacked on a phone, the items are picked but not dragged: the grid is not there to drag on.
    const grid = gridRef.current;
    if (!grid || grid.ownerDocument.defaultView?.getComputedStyle(grid).display !== "grid") return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { itemId: item?.id || "", handle, startX: event.clientX, startY: event.clientY, box: item ? { x: item.x, y: item.y, w: item.w, h: item.h } : { x: 0, y: 0, w: 1, h: 1 }, rows: block.rows, moved: false };
  };

  const move = (event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    const grid = gridRef.current;
    if (!drag || !grid) return;
    const pxX = event.clientX - drag.startX;
    const pxY = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(pxX, pxY) < DRAG_SLOP) return;
    drag.moved = true;
    const dx = Math.round(pxX / (grid.getBoundingClientRect().width / CANVAS_COLUMNS));
    const dy = Math.round(pxY / CANVAS_ROW_PX);
    if (drag.handle === "rows") {
      const wanted = Math.min(CANVAS_MAX_ROWS, Math.max(CANVAS_MIN_ROWS, drag.rows + dy));
      // Never shorter than reaches the lowest item.
      hold({ itemId: "", box: drag.box, rows: Math.max(canvasRowsNeeded(block.items, 0), wanted) });
      return;
    }
    const box = dragBox(drag.box, drag.handle, dx, dy);
    const items = block.items.map((item) => (item.id === drag.itemId ? { ...item, ...box } : item));
    hold({ itemId: drag.itemId, box, rows: canvasRowsNeeded(items, block.rows) });
  };

  const end = () => {
    const drag = dragRef.current;
    const landed = liveRef.current;
    dragRef.current = null;
    hold(null);
    if (!drag?.moved || !landed) return;
    if (drag.handle === "rows") change({ items: block.items, rows: landed.rows });
    else change(placeItem(block, drag.itemId, landed.box));
  };

  const nudge = (event: KeyboardEvent<HTMLElement>, item: SiteCanvasItem) => {
    if (!editor || typing === item.id) return;
    const step = event.shiftKey ? 4 : 1;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[event.key]) {
      event.preventDefault();
      const [dx, dy] = moves[event.key];
      change(placeItem(block, item.id, dragBox(item, "move", dx, dy)));
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      remove(item.id);
    } else if (event.key === "Enter" && item.kind === "text") {
      event.preventDefault();
      setTyping(item.id);
    } else if (event.key === "Escape") {
      editor.selectCanvasItem(block.id, null);
    }
  };

  // --- What each item shows ---------------------------------------------------

  const content = (item: SiteCanvasItem) => {
    switch (item.kind) {
      case "text": {
        const heading = item.size === "h1" || item.size === "h2" || item.size === "h3";
        const className = `site-canvas-words is-${item.size}${heading ? " site-heading" : ""}`;
        if (editor && typing === item.id) {
          return (
            <EditableText
              as={heading ? HEADING_TAG[item.size as keyof typeof HEADING_TAG] : "div"}
              value={item.text}
              className={className}
              multiline
              autoFocus
              onCommit={(text) => change({ items: block.items.map((candidate) => (candidate.id === item.id ? { ...candidate, text } : candidate)), rows: block.rows })}
              onDone={() => setTyping("")}
            />
          );
        }
        const Tag = heading ? HEADING_TAG[item.size as keyof typeof HEADING_TAG] : "div";
        return (
          <Tag className={className}>
            {item.text.split(/\n\s*\n/).map((paragraph, index) =>
              heading ? (
                <span key={index}>{index ? <br /> : null}{lines(paragraph)}</span>
              ) : (
                <p key={index}>{lines(paragraph)}</p>
              ),
            )}
          </Tag>
        );
      }
      case "image": {
        const picture = item.image ? <img src={item.image.url} alt={item.image.alt} loading="lazy" draggable={false} /> : <div className="site-placeholder" />;
        return item.href && !editor ? <a className="site-canvas-link" {...linkProps(item.href)}>{picture}</a> : picture;
      }
      case "button":
        return <Button button={{ label: item.text, href: item.href, style: item.buttonStyle }} className="site-canvas-button" />;
      case "shape":
        return null;
    }
  };

  // --- Editing controls -------------------------------------------------------

  const tool = (label: string, onPress: () => void, icon: ReactNode, className = "site-edit-tool") => (
    <button
      type="button"
      className={className}
      aria-label={label}
      title={label}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onPress();
      }}
    >
      {icon}
    </button>
  );

  const itemChrome = (item: SiteCanvasItem, index: number) => {
    if (!editor || selectedId !== item.id) return null;
    const { canvas: labels } = editor.labels;
    return (
      <>
        {CANVAS_RESIZE_HANDLES.map((handle) => (
          <span key={handle} className={`site-canvas-handle is-${handle}`} aria-hidden="true" onPointerDown={(event) => begin(event, item, handle)} />
        ))}
        <div className={`site-edit-toolbar site-canvas-toolbar${item.y < 3 ? " is-below" : ""}`}>
          {tool(labels.edit, () => editor.editCanvasItem(block.id, item.id), <Pencil size={14} />)}
          {index < block.items.length - 1 ? tool(labels.forward, () => change({ items: restackItem(block.items, item.id, 1), rows: block.rows }), <ArrowUpToLine size={15} />) : null}
          {index > 0 ? tool(labels.backward, () => change({ items: restackItem(block.items, item.id, -1), rows: block.rows }), <ArrowDownToLine size={15} />) : null}
          {tool(labels.duplicate, () => change(duplicateItem(block, item.id, siteId("item"))), <Copy size={15} />)}
          {tool(labels.remove, () => remove(item.id), <Trash2 size={15} />)}
        </div>
      </>
    );
  };

  const editing = Boolean(editor);

  return (
    <section className={`site-container site-canvas${editing ? " is-arranging" : ""}`}>
      <div
        className="site-canvas-grid"
        ref={gridRef}
        style={{ "--site-canvas-rows": rows, "--site-canvas-columns": CANVAS_COLUMNS, "--site-canvas-row": `${CANVAS_ROW_PX}px` } as CSSProperties}
        onPointerDown={editing ? (event) => { if (event.target === event.currentTarget) editor?.selectCanvasItem(block.id, null); } : undefined}
        onPointerMove={editing ? move : undefined}
        onPointerUp={editing ? end : undefined}
        onPointerCancel={editing ? end : undefined}
      >
        {block.items.map((item, index) => {
          const box = boxOf(item);
          const selected = selectedId === item.id;
          return (
            <div
              key={item.id}
              className={`site-canvas-item is-${item.kind} is-fill-${item.fill} is-corners-${item.corners} is-align-${item.align}${selected ? " is-picked" : ""}${live?.itemId === item.id ? " is-held" : ""}${typing === item.id ? " is-typing" : ""}`}
              style={{ gridColumn: `${box.x + 1} / span ${box.w}`, gridRow: `${box.y + 1} / span ${box.h}`, zIndex: index + 1, order: order.indexOf(item.id), "--site-canvas-h": box.h } as CSSProperties}
              tabIndex={editing ? 0 : undefined}
              onPointerDown={editing ? (event) => begin(event, item, "move") : undefined}
              onDoubleClick={
                editing
                  ? (event) => {
                      event.stopPropagation();
                      if (item.kind === "text") setTyping(item.id);
                      else editor?.editCanvasItem(block.id, item.id);
                    }
                  : undefined
              }
              onKeyDown={editing ? (event) => nudge(event, item) : undefined}
            >
              {content(item)}
              {itemChrome(item, index)}
            </div>
          );
        })}
      </div>
      {editor ? (
        <>
          <div className="site-canvas-rows-handle" title={editor.labels.canvas.height} onPointerDown={(event) => begin(event, null, "rows")} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
            <span />
          </div>
          <div className="site-canvas-addbar">
            {tool(editor.labels.canvas.addHeading, () => add("text", true), <><Heading size={14} /> <span>{editor.labels.canvas.heading}</span></>, "site-edit-tool is-labelled")}
            {tool(editor.labels.canvas.addText, () => add("text"), <><Type size={14} /> <span>{editor.labels.canvas.text}</span></>, "site-edit-tool is-labelled")}
            {tool(editor.labels.canvas.addPicture, () => add("image"), <><ImageIcon size={14} /> <span>{editor.labels.canvas.picture}</span></>, "site-edit-tool is-labelled")}
            {tool(editor.labels.canvas.addButton, () => add("button"), <><MousePointerClick size={14} /> <span>{editor.labels.canvas.button}</span></>, "site-edit-tool is-labelled")}
            {tool(editor.labels.canvas.addShape, () => add("shape"), <><Square size={14} /> <span>{editor.labels.canvas.shape}</span></>, "site-edit-tool is-labelled")}
          </div>
        </>
      ) : null}
    </section>
  );
}

function lines(text: string): ReactNode {
  return text.split("\n").map((line, index, all) => (
    <span key={index}>
      {line}
      {index < all.length - 1 ? <br /> : null}
    </span>
  ));
}
