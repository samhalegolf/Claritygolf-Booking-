import assert from "node:assert/strict";
import test from "node:test";

import { clipTimeAt, exportTimeline, layoutExportPanes } from "./videoExport";

test("a single portrait phone clip keeps its own size", () => {
  const layout = layoutExportPanes([{ width: 1080, height: 1920 }]);
  assert.deepEqual([layout.width, layout.height], [1080, 1920]);
});

test("a small clip is never blown up", () => {
  const layout = layoutExportPanes([{ width: 640, height: 360 }]);
  assert.deepEqual([layout.width, layout.height], [640, 360]);
});

test("two clips sit side by side at one height, within the size cap", () => {
  const layout = layoutExportPanes([
    { width: 1080, height: 1920 },
    { width: 1920, height: 1080 },
  ]);
  assert.ok(layout.width <= 1920 && layout.height <= 1920);
  assert.equal(layout.rects[0].height, layout.rects[1].height);
  assert.equal(layout.rects[1].x, layout.rects[0].width);
  assert.equal(layout.width, layout.rects[0].width + layout.rects[1].width);
  for (const value of [layout.width, layout.height, ...layout.rects.map((rect) => rect.width)]) {
    assert.equal(value % 2, 0, "H.264 needs even sizes");
  }
});

test("the timeline covers both clips when one is ahead of the other", () => {
  // Right playhead 2s ahead of the left: the right clip's opening 2s show
  // while the left waits on its first frame.
  const timeline = exportTimeline([
    { durationS: 5, offsetS: 0 },
    { durationS: 5, offsetS: 2 },
  ]);
  assert.equal(timeline.startS, -2);
  assert.equal(timeline.frameCount, 7 * 30);
});

test("a clip holds its first and last frames outside its own length", () => {
  const timeline = { startS: -2 };
  const left = { durationS: 5, offsetS: 0 };
  assert.equal(clipTimeAt(0, timeline, left), 0);
  assert.ok(clipTimeAt(10_000, timeline, left) < 5);
  assert.ok(clipTimeAt(10_000, timeline, left) > 4.99);
  assert.equal(clipTimeAt(90, timeline, left), 1);
});
