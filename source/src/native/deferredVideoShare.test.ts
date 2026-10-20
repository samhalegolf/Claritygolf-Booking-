import assert from "node:assert/strict";
import { test } from "node:test";
import { shareVideoDeferred } from "./deferredVideoShare";

test("native chooser opens before preparation; transfer is ordered and cancellation starts no work", async () => {
  const keys = ["__clarityVideoShare", "addEventListener", "removeEventListener"] as const;
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const originals = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const events = new EventTarget();
  const messages: Array<Record<string, unknown>> = [];
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const emit = (id: string, type: string) => events.dispatchEvent(new CustomEvent("clarity-video-share", { detail: { id, type } }));
  try {
    Object.defineProperty(globalThis, "addEventListener", { configurable: true, value: events.addEventListener.bind(events) });
    Object.defineProperty(globalThis, "removeEventListener", { configurable: true, value: events.removeEventListener.bind(events) });
    Object.defineProperty(globalThis, "__clarityVideoShare", { configurable: true, value: { version: 1, post: async (message: Record<string, unknown>) => { messages.push(message); } } });
    let preparations = 0;
    const bytes = new Uint8Array(300_000).fill(42);
    const prepare = async () => { preparations++; return { blob: new Blob([bytes], { type: "video/mp4" }), fileName: "clip.mp4" }; };
    const task = shareVideoDeferred("clip.mp4", prepare, new AbortController().signal, () => {});
    assert.equal(messages[0].action, "present", "native chooser is opened synchronously from the original tap");
    assert.equal(preparations, 0);
    emit("wrong-id", "prepare");
    await tick();
    assert.equal(preparations, 0);
    const id = messages[0].id as string;
    emit(id, "prepare"); emit(id, "prepare");
    for (let tries = 0; tries < 30 && !messages.some((message) => message.action === "finish"); tries++) await tick();
    assert.equal(preparations, 1);
    const chunks = messages.filter((message) => message.action === "chunk");
    assert.deepEqual(chunks.map((message) => message.offset), [0, 256 * 1024]);
    const copy = Buffer.concat(chunks.map((message) => Buffer.from(message.data as string, "base64")));
    assert.deepEqual(copy, Buffer.from(bytes));
    assert.equal(messages.at(-1)?.action, "finish");
    emit(id, "complete");
    assert.equal(await task, true);

    messages.length = 0;
    const cancel = new AbortController();
    const cancelled = shareVideoDeferred("clip.mp4", prepare, cancel.signal, () => {});
    cancel.abort();
    assert.equal(await cancelled, false);
    assert.equal(preparations, 1, "closing chooser never invokes preparation");
    emit(messages[0].id as string, "prepare");
    await tick();
    assert.equal(preparations, 1, "late native requests are ignored");

    messages.length = 0;
    const saved = shareVideoDeferred("clip.mp4", prepare, new AbortController().signal, () => {}, "export");
    assert.equal(messages[0].action, "save");
    assert.equal(preparations, 1, "Save As also opens before preparation");
    const saveID = messages[0].id as string;
    emit(saveID, "cancelled");
    assert.equal(await saved, false);

    messages.length = 0;
    const failed = shareVideoDeferred("clip.mp4", async () => { throw new Error("Encoder failed"); }, new AbortController().signal, () => {});
    emit(messages[0].id as string, "prepare");
    await assert.rejects(failed, /Encoder failed/);
    assert.equal(messages.at(-1)?.action, "fail");
  } finally {
    keys.forEach((key, index) => {
      const descriptor = originals[index];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globals, key);
    });
  }
});
