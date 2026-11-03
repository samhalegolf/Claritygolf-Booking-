// The free layout's grid maths: where an item lands when it is dragged or
// stretched, and how an ordinary section is laid out as free items.
//
// Everything here works in grid cells (CANVAS_COLUMNS across, rows of
// CANVAS_ROW_PX), never pixels: the renderer turns the pointer's movement
// into cells and asks these functions for the item's new box.

import {
  CANVAS_COLUMNS,
  CANVAS_MAX_ROWS,
  canvasRowsNeeded,
  newCanvasItem,
  type SiteBlock,
  type SiteCanvasBlock,
  type SiteCanvasItem,
} from "../../../netlify/functions/_shared/site/document.mts";

export type CanvasBox = Pick<SiteCanvasItem, "x" | "y" | "w" | "h">;

/** Which edges a handle pulls: "move" for the item itself, or any of n, s, e, w and the corners. */
export type CanvasHandle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const CANVAS_RESIZE_HANDLES: readonly CanvasHandle[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * The box after the pointer has moved `dx` columns and `dy` rows from where
 * it was pressed. Moving keeps the size; pulling an edge moves only that edge,
 * and never past the opposite one, so a box is always at least one cell.
 */
export function dragBox(start: CanvasBox, handle: CanvasHandle, dx: number, dy: number): CanvasBox {
  if (handle === "move") {
    return { ...start, x: clamp(start.x + dx, 0, CANVAS_COLUMNS - start.w), y: clamp(start.y + dy, 0, CANVAS_MAX_ROWS - start.h) };
  }
  let { x, y, w, h } = start;
  if (handle.includes("e")) w = clamp(start.w + dx, 1, CANVAS_COLUMNS - start.x);
  if (handle.includes("w")) {
    x = clamp(start.x + dx, 0, start.x + start.w - 1);
    w = start.w + start.x - x;
  }
  if (handle.includes("s")) h = clamp(start.h + dy, 1, CANVAS_MAX_ROWS - start.y);
  if (handle.includes("n")) {
    y = clamp(start.y + dy, 0, start.y + start.h - 1);
    h = start.h + start.y - y;
  }
  return { x, y, w, h };
}

/** The items with one of them in a new box, and the rows the section then needs. */
export function placeItem(block: SiteCanvasBlock, itemId: string, box: CanvasBox): Pick<SiteCanvasBlock, "items" | "rows"> {
  const items = block.items.map((item) => (item.id === itemId ? { ...item, ...box } : item));
  return { items, rows: canvasRowsNeeded(items, block.rows) };
}

/** Items in reading order, top to bottom then left to right: the order they stack in on a phone. */
export function readingOrder(items: readonly SiteCanvasItem[]): string[] {
  return [...items].sort((a, b) => a.y - b.y || a.x - b.x).map((item) => item.id);
}

/** A new item put below everything already in the section, so it never lands on top of something. */
export function addItem(block: SiteCanvasBlock, item: SiteCanvasItem): Pick<SiteCanvasBlock, "items" | "rows"> {
  const below = block.items.length ? canvasRowsNeeded(block.items, 0) + 1 : 1;
  const placed = { ...item, x: Math.min(item.x || 2, CANVAS_COLUMNS - item.w), y: below };
  const items = [...block.items, placed];
  return { items, rows: canvasRowsNeeded(items, block.rows) };
}

/** A copy of an item, nudged down and right so it is seen to be a second one. */
export function duplicateItem(block: SiteCanvasBlock, itemId: string, newId: string): Pick<SiteCanvasBlock, "items" | "rows"> {
  const index = block.items.findIndex((item) => item.id === itemId);
  if (index < 0) return { items: block.items, rows: block.rows };
  const source = block.items[index];
  const { x, y } = dragBox(source, "move", 1, 2);
  const copy = { ...structuredClone(source), id: newId, x, y };
  const items = [...block.items.slice(0, index + 1), copy, ...block.items.slice(index + 1)];
  return { items, rows: canvasRowsNeeded(items, block.rows) };
}

/** An item drawn one step further forward (+1) or back (-1). Later items are drawn on top. */
export function restackItem(items: readonly SiteCanvasItem[], itemId: string, delta: 1 | -1): SiteCanvasItem[] {
  const index = items.findIndex((item) => item.id === itemId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= items.length) return [...items];
  const next = [...items];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

/** The sections that can be turned into a free layout: the ones made of a heading, words, buttons and a picture. */
export function canArrangeFreely(block: SiteBlock): boolean {
  return block.type === "hero" || block.type === "text" || block.type === "cta" || block.type === "image";
}

/**
 * The same section as a free layout, laid out roughly as it was drawn, so the
 * coach can then move its parts. The section's id and style are kept, so links
 * to it and its colours still work.
 */
export function arrangeFreely(block: SiteBlock): SiteCanvasBlock | null {
  if (!canArrangeFreely(block)) return null;
  const items: SiteCanvasItem[] = [];
  const cover = block.type === "hero" && block.layout === "cover" && Boolean(block.image);
  const centred = (block.type === "hero" && (block.layout === "centre" || block.layout === "cover")) || (block.type === "text" && block.align === "centre") || block.type === "cta";
  const hasPicture = (block.type === "hero" || block.type === "image") && Boolean(block.image);
  const split = block.type === "hero" && hasPicture && block.layout !== "cover" && block.layout !== "centre";
  const pictureFirst = block.type === "hero" && block.layout === "split-left";
  // Words take the whole width, or half beside a picture.
  const wordsX = split ? (pictureFirst ? 13 : 1) : centred ? 4 : 1;
  const wordsW = split ? 10 : centred ? 16 : 18;
  let y = 2;
  const words = (text: string, size: SiteCanvasItem["size"], rows: number) => {
    if (!text) return;
    items.push({ ...newCanvasItem("text", y, { text }), x: wordsX, w: wordsW, h: rows, size, align: centred ? "centre" : "left" });
    y += rows + 1;
  };

  if (block.type === "hero") {
    words(block.eyebrow, "small", 2);
    words(block.heading, "h1", 8);
    words(block.text, "lead", 4);
  } else if (block.type === "text") {
    words(block.heading, "h2", 4);
    words(block.body, "body", Math.max(4, Math.ceil(block.body.length / 70) * 2));
  } else if (block.type === "cta") {
    words(block.heading, "h2", 4);
    words(block.text, "lead", 3);
  }

  const buttons = block.type === "hero" ? block.buttons : block.type === "cta" && block.button ? [block.button] : [];
  if (buttons.length) {
    const width = 5;
    const across = buttons.length * width + (buttons.length - 1);
    let x = centred ? Math.round((CANVAS_COLUMNS - across) / 2) : wordsX;
    for (const button of buttons) {
      items.push({ ...newCanvasItem("button", y, { button: button.label }), x, w: width, href: button.href, buttonStyle: button.style });
      x += width + 1;
    }
    y += 4;
  }

  if ((block.type === "hero" || block.type === "image") && block.image) {
    const corners = block.shape === "circle" ? "circle" : block.shape === "rounded" ? "rounded" : "square";
    if (cover) {
      // The picture behind everything: first, so it is drawn under the words.
      items.unshift({ ...newCanvasItem("image", 0), x: 0, w: CANVAS_COLUMNS, h: y + 2, image: block.image, corners });
    } else if (split) {
      items.push({ ...newCanvasItem("image", 2), x: pictureFirst ? 1 : 13, w: 10, h: Math.max(y, 20), image: block.image, corners });
    } else {
      const caption = block.type === "image" ? block.caption : "";
      items.push({ ...newCanvasItem("image", y), x: 1, w: 22, h: 24, image: block.image, corners });
      y += 25;
      if (caption) words(caption, "small", 2);
    }
  }

  return { id: block.id, style: block.style, type: "canvas", items, rows: canvasRowsNeeded(items, y + 1) };
}
