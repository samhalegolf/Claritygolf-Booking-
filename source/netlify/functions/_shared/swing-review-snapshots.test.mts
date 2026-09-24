/**
 * Screenshots travelling with a swing review.
 *
 * The cases worth pinning are the ones that would put the wrong picture in
 * front of a player, or let a later send quietly unlink a picture that did
 * reach them.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_SNAPSHOT_IMAGE_BYTES,
  carryImageFileIds,
  publicSnapshots,
  safeSnapshotId,
  snapshotHasImage,
  snapshotImageAppProperties,
  snapshotRect,
  snapshotUploadVerdict,
} from "./swing-review-snapshots.mts";

const analysis = (focusSnapshots: unknown[]) => ({ savedVideoId: "v1", analysis: { focusSnapshots } });

test("a snapshot id the app generates is accepted, anything that could reach a Drive query is not", () => {
  assert.equal(safeSnapshotId("focus-left-1789693658287-abc"), "focus-left-1789693658287-abc");
  assert.equal(safeSnapshotId("x' or name contains 'a"), "");
  assert.equal(safeSnapshotId("../etc"), "");
  assert.equal(safeSnapshotId(""), "");
});

test("an upload is refused when it is the wrong type, empty or too large", () => {
  const base = { snapshotId: "s1", contentType: "image/jpeg", sizeBytes: 1000 };
  assert.deepEqual(snapshotUploadVerdict(base), { ok: true, mimeType: "image/jpeg" });
  assert.equal(snapshotUploadVerdict({ ...base, contentType: "text/html" }).ok, false);
  assert.equal(snapshotUploadVerdict({ ...base, sizeBytes: 0 }).ok, false);
  assert.equal(snapshotUploadVerdict({ ...base, sizeBytes: MAX_SNAPSHOT_IMAGE_BYTES + 1 }).ok, false);
  assert.equal(snapshotUploadVerdict({ ...base, snapshotId: "" }).ok, false);
  assert.deepEqual(snapshotUploadVerdict({ ...base, contentType: "image/png; charset=binary" }), {
    ok: true,
    mimeType: "image/png",
  });
});

test("a picture's Drive label names the account, the video and the snapshot", () => {
  // The lookup is keyed on all three so one video's screenshot id can never
  // fetch another video's picture, even if two ids collide.
  assert.deepEqual(
    snapshotImageAppProperties({ accountId: "a", savedVideoId: "v", snapshotId: "s", clarityVersion: "1" }),
    {
      clarityType: "focus-snapshot",
      clarityAccountId: "a",
      claritySavedVideoId: "v",
      claritySnapshotId: "s",
      clarityVersion: "1",
    },
  );
});

test("a reader gets where and when each snapshot was taken, in swing order, and no Drive ids", () => {
  const list = publicSnapshots(
    analysis([
      {
        id: "late",
        title: "Frame capture",
        currentTime: 2.4,
        captureKind: "frame",
        cropRect: { x: 0, y: 0, width: 1, height: 1 },
        imageFileId: "drive-1",
      },
      {
        id: "early",
        title: "Focus snapshot",
        note: "Scapula connected",
        currentTime: 0.8,
        captureKind: "area",
        cropRect: { x: 0.2, y: 0.3, width: 0.25, height: 0.4 },
      },
    ]),
  );
  assert.deepEqual(list, [
    {
      id: "early",
      title: "Focus snapshot",
      note: "Scapula connected",
      currentTime: 0.8,
      captureKind: "area",
      cropRect: { x: 0.2, y: 0.3, width: 0.25, height: 0.4 },
      hasImage: false,
    },
    {
      id: "late",
      title: "Frame capture",
      note: "",
      currentTime: 2.4,
      captureKind: "frame",
      cropRect: null,
      hasImage: true,
    },
  ]);
  assert.ok(!JSON.stringify(list).includes("drive-1"));
});

test("a snapshot saved before captureKind existed is treated as an area crop", () => {
  const [snapshot] = publicSnapshots(analysis([{ id: "s1", cropRect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }]));
  assert.equal(snapshot.captureKind, "area");
  assert.deepEqual(snapshot.cropRect, { x: 0.1, y: 0.1, width: 0.2, height: 0.2 });
});

test("a crop box is clamped inside the frame and a degenerate one is dropped", () => {
  const clamped = snapshotRect({ x: 0.8, y: -1, width: 0.5, height: 0.5 })!;
  assert.equal(clamped.x, 0.8);
  assert.equal(clamped.y, 0);
  assert.ok(Math.abs(clamped.width - 0.2) < 1e-9, "the box stops at the right edge");
  assert.equal(clamped.height, 0.5);
  assert.equal(snapshotRect({ x: 0.1, y: 0.1, width: 0, height: 0.2 }), null);
  assert.equal(snapshotRect({ x: "a", y: 0, width: 1, height: 1 }), null);
  assert.equal(snapshotRect(null), null);
});

test("only a snapshot the analysis lists with a picture can be fetched", () => {
  const file = analysis([
    { id: "with", imageFileId: "drive-1" },
    { id: "without" },
  ]);
  assert.equal(snapshotHasImage(file, "with"), true);
  assert.equal(snapshotHasImage(file, "without"), false);
  assert.equal(snapshotHasImage(file, "never-existed"), false);
  assert.equal(snapshotHasImage(null, "with"), false);
});

test("a later send from a device without the picture keeps the link another device uploaded", () => {
  const previous = analysis([
    { id: "s1", imageFileId: "drive-1" },
    { id: "s2", imageFileId: "drive-2" },
  ]);
  const incoming = analysis([
    { id: "s1", note: "edited on the Mac" },
    { id: "s3", note: "new, no picture" },
  ]);
  const merged = carryImageFileIds(previous, incoming) as any;
  assert.deepEqual(merged.analysis.focusSnapshots, [
    { id: "s1", note: "edited on the Mac", imageFileId: "drive-1" },
    { id: "s3", note: "new, no picture" },
  ]);
  // s2 was deleted on the sending device, so it stays deleted.
  assert.equal(merged.analysis.focusSnapshots.length, 2);
});

test("a picture the sender re-uploaded keeps the id it sent", () => {
  const merged = carryImageFileIds(
    analysis([{ id: "s1", imageFileId: "old" }]),
    analysis([{ id: "s1", imageFileId: "new" }]),
  ) as any;
  assert.equal(merged.analysis.focusSnapshots[0].imageFileId, "new");
});
