import assert from "node:assert/strict";
import test from "node:test";
import { PreparedVideoCache } from "./preparedVideoCache";
import { shareFile } from "../../../native/nativeFiles";

test("a warm video opens sharing on the icon's call stack, with no further preparation", async () => {
  const cache = new PreparedVideoCache<{blob: Blob; fileName: string}>();
  let prepares = 0;
  const file = { blob: new Blob(["video"], {type: "video/mp4"}), fileName: "swing.mp4" };
  await cache.prepare("original", async () => { prepares += 1; return file; });
  await cache.prepare("original", async () => { throw Error("must reuse"); });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let opened = false;
  try {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
      canShare: () => true,
      share: () => { opened = true; return Promise.resolve(); },
    }});
    const ready = cache.peek("original")!;
    const pending = shareFile(ready.blob, ready.fileName);
    assert.equal(opened, true, "the sheet is requested before awaiting");
    assert.equal(prepares, 1);
    await pending;
  } finally {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else Reflect.deleteProperty(globalThis, "navigator");
    cache.clear();
  }
});

test("changing video or edits aborts old work and cannot share a stale file", async () => {
  const cache = new PreparedVideoCache<string>();
  let oldSignal: AbortSignal | undefined;
  let finishOld: ((file: string) => void) | undefined;
  const old = cache.prepare("old", async (signal) => {
    oldSignal = signal;
    return new Promise<string>((resolve) => { finishOld = resolve; });
  });
  const rejected = assert.rejects(old, { name: "AbortError" });
  await Promise.resolve();
  await cache.prepare("edited", async () => "edited file");
  assert.equal(oldSignal?.aborted, true);
  await rejected;
  finishOld?.("stale file");
  await Promise.resolve();
  assert.equal(cache.peek("old"), undefined);
  assert.equal(cache.peek("edited"), "edited file");
  cache.clear();
  assert.equal(cache.peek("edited"), undefined);
});

test("failed staging can be retried", async () => {
  const cache = new PreparedVideoCache<string>();
  await assert.rejects(cache.prepare("video", async () => {throw Error("offline");}), /offline/);
  assert.equal(await cache.prepare("video", async () => "retried"), "retried");
  cache.clear();
});
