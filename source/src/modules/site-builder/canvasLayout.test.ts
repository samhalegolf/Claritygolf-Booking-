import assert from "node:assert/strict";
import test from "node:test";

import { CANVAS_COLUMNS, cleanSitePageContent, newCanvasItem, newSiteBlock, type SiteBlock, type SiteCanvasBlock } from "../../../netlify/functions/_shared/site/document.mts";
import { addItem, arrangeFreely, dragBox, duplicateItem, placeItem, readingOrder, restackItem } from "./canvasLayout";

const canvas = () => newSiteBlock("canvas") as SiteCanvasBlock;

test("moving keeps the size and stays inside the grid", () => {
  const box = { x: 2, y: 3, w: 6, h: 4 };
  assert.deepEqual(dragBox(box, "move", 3, 2), { x: 5, y: 5, w: 6, h: 4 });
  assert.deepEqual(dragBox(box, "move", 100, -100), { x: CANVAS_COLUMNS - 6, y: 0, w: 6, h: 4 });
});

test("pulling an edge moves only that edge, and never past the other side", () => {
  const box = { x: 4, y: 4, w: 6, h: 6 };
  assert.deepEqual(dragBox(box, "se", 2, 3), { x: 4, y: 4, w: 8, h: 9 });
  assert.deepEqual(dragBox(box, "nw", -2, -1), { x: 2, y: 3, w: 8, h: 7 });
  assert.deepEqual(dragBox(box, "w", 20, 0), { x: 9, y: 4, w: 1, h: 6 }, "at least one column");
  assert.deepEqual(dragBox(box, "n", 0, 20), { x: 4, y: 9, w: 6, h: 1 }, "at least one row");
  assert.deepEqual(dragBox(box, "e", 100, 0), { x: 4, y: 4, w: CANVAS_COLUMNS - 4, h: 6 });
});

test("a section grows to hold an item dragged below it", () => {
  const block = canvas();
  const [first] = block.items;
  const next = placeItem(block, first.id, { x: 0, y: 40, w: 4, h: 5 });
  assert.equal(next.rows, 45);
  assert.equal(next.items[0].y, 40);
});

test("a new item lands below everything, and a copy beside its original", () => {
  const block = canvas();
  const added = addItem(block, newCanvasItem("shape"));
  const shape = added.items[added.items.length - 1];
  const lowest = Math.max(...block.items.map((item) => item.y + item.h));
  assert.ok(shape.y > lowest);
  const copied = duplicateItem({ ...block, ...added }, shape.id, "item-copy");
  const copy = copied.items.find((item) => item.id === "item-copy")!;
  assert.equal(copy.x, shape.x + 1);
  assert.equal(copy.y, shape.y + 2);
});

test("restacking and reading order", () => {
  const block = canvas();
  const ids = block.items.map((item) => item.id);
  assert.deepEqual(restackItem(block.items, ids[0], 1).map((item) => item.id), [ids[1], ids[0], ...ids.slice(2)]);
  assert.deepEqual(restackItem(block.items, ids[0], -1).map((item) => item.id), ids, "nothing below the bottom one");
  assert.deepEqual(readingOrder(block.items)[0], block.items.reduce((top, item) => (item.y < top.y || (item.y === top.y && item.x < top.x) ? item : top)).id);
});

test("a hero turned into a free layout keeps its words, buttons, picture, id and style", () => {
  const hero = { ...newSiteBlock("hero"), layout: "split", image: { url: "https://example.com/a.jpg", alt: "Coach" } } as Extract<SiteBlock, { type: "hero" }>;
  hero.style = { ...hero.style, theme: "dark" };
  const free = arrangeFreely(hero)!;
  assert.equal(free.id, hero.id);
  assert.equal(free.style.theme, "dark");
  const texts = free.items.filter((item) => item.kind === "text").map((item) => item.text);
  assert.ok(texts.includes(hero.heading));
  assert.equal(free.items.filter((item) => item.kind === "button").length, hero.buttons.length);
  assert.equal(free.items.find((item) => item.kind === "image")?.image?.url, "https://example.com/a.jpg");
  assert.deepEqual(cleanSitePageContent({ blocks: [free] }).blocks[0], free, "the cleaner keeps it as it is");
  assert.equal(arrangeFreely(newSiteBlock("faq")), null);
});

test("the cleaner keeps items inside the grid and drops what it does not know", () => {
  const [block] = cleanSitePageContent({
    blocks: [{ type: "canvas", rows: 2, items: [{ kind: "text", x: 30, y: -4, w: 50, h: 3, text: "Hi" }, { kind: "video" }, { kind: "image", x: 20, w: 10, image: { url: "http://insecure.example/a.jpg" } }] }],
  }).blocks as SiteCanvasBlock[];
  assert.equal(block.items.length, 2);
  assert.deepEqual([block.items[0].x, block.items[0].y, block.items[0].w], [0, 0, CANVAS_COLUMNS]);
  assert.equal(block.items[1].x + block.items[1].w <= CANVAS_COLUMNS, true);
  assert.equal(block.items[1].image, null, "http pictures are not kept");
  assert.ok(block.rows >= 4);
});
