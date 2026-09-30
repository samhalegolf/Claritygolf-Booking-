import assert from "node:assert/strict";
import test from "node:test";

import { CameraBlockedError, QUALITY_LADDER, findByName, openCameraById, selectionIndex } from "./terminalCameras";

const refusal = (name: string) => Object.assign(new Error(name), { name });
const fakeStream = {} as MediaStream;

test("a camera that refuses full HD is asked again at lower quality until it opens", async () => {
  const asked: MediaStreamConstraints[] = [];
  const stream = await openCameraById("cam-1", async (constraints) => {
    asked.push(constraints);
    if (asked.length < 3) throw refusal("NotReadableError");
    return fakeStream;
  });
  assert.equal(stream, fakeStream);
  assert.equal(asked.length, 3);
  // Always pinned to the camera asked for, never whichever the browser likes.
  for (const constraints of asked) {
    assert.deepEqual((constraints.video as MediaTrackConstraints).deviceId, { exact: "cam-1" });
  }
});

test("the last step asks for nothing but the camera", async () => {
  let calls = 0;
  const stream = await openCameraById("cam-1", async () => {
    calls += 1;
    if (calls < QUALITY_LADDER.length) throw refusal("OverconstrainedError");
    return fakeStream;
  });
  assert.equal(stream, fakeStream);
  assert.equal(calls, QUALITY_LADDER.length);
  assert.deepEqual(QUALITY_LADDER.at(-1), {});
});

test("a camera that is not here is given up on at once", async () => {
  let calls = 0;
  const stream = await openCameraById("gone", async () => {
    calls += 1;
    throw refusal("NotFoundError");
  });
  assert.equal(stream, null);
  assert.equal(calls, 1);
});

test("blocked camera access is reported, not retried", async () => {
  await assert.rejects(
    openCameraById("cam-1", async () => {
      throw refusal("NotAllowedError");
    }),
    CameraBlockedError,
  );
});

// Two of the same webcam is an ordinary bay: same model, same name.
const present = [
  { deviceId: "a", label: "Logitech BRIO (046d:085e)" },
  { deviceId: "b", label: "Logitech BRIO (046d:085e)" },
];

test("two cameras with the same name are told apart by id", () => {
  const selection = [{ deviceId: "b", label: "Logitech BRIO (046d:085e)" }];
  assert.equal(selectionIndex(present[0], selection, present), -1);
  assert.equal(selectionIndex(present[1], selection, present), 0);
});

test("a camera that came back under a new id is found by name", () => {
  const selection = [{ deviceId: "old-id", label: "Sam's iPhone Camera" }];
  const now = [{ deviceId: "new-id", label: "Sam's iPhone Camera" }];
  assert.equal(selectionIndex(now[0], selection, now), 0);
  assert.deepEqual(findByName(now, selection[0], new Set()), now[0]);
});

test("finding by name never takes a camera already in use", () => {
  const wanted = { deviceId: "gone", label: "Logitech BRIO (046d:085e)" };
  assert.deepEqual(findByName(present, wanted, new Set(["a"])), present[1]);
  assert.equal(findByName(present, wanted, new Set(["a", "b"])), null);
});
