import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cleanDrillInput,
  cleanLinkUrl,
  cleanReviewBlocks,
  drillToBlock,
  reviewBlockVideoIds,
  visibleReviewBlocks,
  youtubeEmbedUrl,
  youtubeIdFrom,
  youtubeStartFrom,
} from "./review-document.mts";

test("youtubeIdFrom reads every link shape a coach is likely to paste", () => {
  const id = "dQw4w9WgXcQ";
  assert.equal(youtubeIdFrom(id), id);
  assert.equal(youtubeIdFrom(`https://www.youtube.com/watch?v=${id}&t=42s`), id);
  assert.equal(youtubeIdFrom(`https://youtu.be/${id}?t=10`), id);
  assert.equal(youtubeIdFrom(`https://m.youtube.com/shorts/${id}`), id);
  assert.equal(youtubeIdFrom(`youtube.com/embed/${id}`), id);
  assert.equal(youtubeIdFrom(`https://www.youtube-nocookie.com/embed/${id}`), id);
  assert.equal(youtubeIdFrom("https://vimeo.com/12345"), "");
  assert.equal(youtubeIdFrom("https://evil.example/watch?v=dQw4w9WgXcQ"), "");
  assert.equal(youtubeIdFrom(""), "");
});

test("youtubeStartFrom understands plain seconds and 1m30s", () => {
  assert.equal(youtubeStartFrom("https://youtu.be/dQw4w9WgXcQ?t=42"), 42);
  assert.equal(youtubeStartFrom("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s"), 90);
  assert.equal(youtubeStartFrom("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), 0);
});

test("youtubeEmbedUrl crops to the drill's part of the clip", () => {
  const url = youtubeEmbedUrl("dQw4w9WgXcQ", 12.4, 30.2);
  assert.match(url, /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?/);
  assert.match(url, /start=12/);
  assert.match(url, /end=31/);
  assert.equal(youtubeEmbedUrl("not an id"), "");
});

test("cleanLinkUrl allows http(s) only and adds https to a bare domain", () => {
  assert.equal(cleanLinkUrl("example.com/drill"), "https://example.com/drill");
  assert.equal(cleanLinkUrl("http://example.com"), "http://example.com/");
  assert.equal(cleanLinkUrl("javascript:alert(1)"), "");
  assert.equal(cleanLinkUrl("data:text/html,hi"), "");
  assert.equal(cleanLinkUrl("localhost"), "");
});

test("cleanReviewBlocks keeps order, drops unknown types and de-duplicates ids", () => {
  const blocks = cleanReviewBlocks([
    { id: "a", type: "video", savedVideoId: "v1" },
    { id: "a", type: "note", title: "Grip", body: "Weaker" },
    { id: "x", type: "script", body: "<script>" },
    { id: "b", type: "video", savedVideoId: "" },
    { id: "c", type: "link", url: "javascript:alert(1)", label: "Bad" },
  ]);
  assert.deepEqual(
    blocks.map((block) => [block.id, block.type]),
    [
      ["a", "video"],
      ["a-1", "note"],
      ["c", "link"],
    ],
  );
  assert.equal(blocks[2].type === "link" && blocks[2].url, "");
});

test("a YouTube drill block keeps its crop and markers; a native one keeps its copy", () => {
  const [youtube, native] = cleanReviewBlocks([
    {
      id: "d1",
      type: "drill",
      title: "Gate drill",
      youtubeId: "https://youtu.be/dQw4w9WgXcQ",
      start: 10,
      end: 5,
      savedVideoId: "ignored",
      markers: [
        { id: "m2", time: 20, note: "Later" },
        { id: "m1", time: 12, note: "Earlier" },
        { id: "m3", time: 30, note: "" },
      ],
    },
    { id: "d2", type: "drill", title: "Step drill", savedVideoId: "copy-1", markers: [{ time: 1, note: "x" }] },
  ]);
  assert.ok(youtube.type === "drill");
  assert.equal(youtube.youtubeId, "dQw4w9WgXcQ");
  assert.equal(youtube.end, null, "an end before the start is dropped");
  assert.equal(youtube.savedVideoId, "");
  assert.deepEqual(youtube.markers.map((marker) => marker.note), ["Earlier", "Later"]);
  assert.ok(native.type === "drill");
  assert.equal(native.savedVideoId, "copy-1");
  assert.deepEqual(native.markers, []);
});

test("reviewBlockVideoIds lists video blocks and native drill copies", () => {
  const blocks = cleanReviewBlocks([
    { id: "1", type: "video", savedVideoId: "v1" },
    { id: "2", type: "drill", savedVideoId: "v2", title: "Drill" },
    { id: "3", type: "drill", youtubeId: "dQw4w9WgXcQ", title: "YT" },
  ]);
  assert.deepEqual(reviewBlockVideoIds(blocks), ["v1", "v2"]);
});

test("visibleReviewBlocks hides the coach's unfinished notes and links", () => {
  const blocks = cleanReviewBlocks([
    { id: "1", type: "note", title: "", body: "" },
    { id: "2", type: "link", url: "", label: "Nothing yet" },
    { id: "3", type: "note", title: "", body: "Kept" },
  ]);
  assert.deepEqual(visibleReviewBlocks(blocks).map((block) => block.id), ["3"]);
});

test("cleanDrillInput: a YouTube link wins, and only small image thumbnails survive", () => {
  const drill = cleanDrillInput({
    title: " Gate drill ",
    youtubeUrl: "https://youtu.be/dQw4w9WgXcQ",
    start: 4,
    end: 20,
    savedVideoId: "v1",
    thumbnailDataUrl: "data:image/jpeg;base64,AAAA",
  });
  assert.equal(drill.title, "Gate drill");
  assert.equal(drill.youtubeId, "dQw4w9WgXcQ");
  assert.equal(drill.savedVideoId, "");
  assert.equal(drill.thumbnailDataUrl, "");

  const native = cleanDrillInput({ title: "Step", savedVideoId: "v1", thumbnailDataUrl: "data:image/jpeg;base64,AAAA" });
  assert.equal(native.savedVideoId, "v1");
  assert.equal(native.thumbnailDataUrl, "data:image/jpeg;base64,AAAA");
  assert.equal(cleanDrillInput({ thumbnailDataUrl: "javascript:x" }).thumbnailDataUrl, "");
});

test("drillToBlock copies the words and clip but never the original's video", () => {
  const block = drillToBlock(
    { id: "drill-1", title: "Step", notes: "Feet together", youtubeId: "", start: 0, end: null },
    "b1",
  );
  assert.equal(block.drillId, "drill-1");
  assert.equal(block.savedVideoId, "");
  assert.equal(block.notes, "Feet together");
});
