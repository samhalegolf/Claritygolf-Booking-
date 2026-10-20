import assert from "node:assert/strict";
import test from "node:test";
import { prepareWithProgress } from "./videoPreparation";

test("a stalled source rejects and aborts its work", async () => {
  let signal: AbortSignal | undefined;
  await assert.rejects(prepareWithProgress(async (next) => {
    signal = next;
    return new Promise<never>(() => {});
  }, new AbortController().signal, () => {}, 15), /stopped responding/);
  assert.equal(signal?.aborted, true);
});

test("cancel rejects even when the producer ignores cancellation", async () => {
  const controller = new AbortController();
  const promise = prepareWithProgress(async () => new Promise<never>(() => {}),
    controller.signal, () => {}, 1000);
  controller.abort();
  await assert.rejects(promise, { name: "AbortError" });
});

test("ongoing progress allows work beyond the inactivity window", async () => {
  const seen: number[] = [];
  const result = await prepareWithProgress(async (_, progress) => {
    for (const value of [0.25, 0.5, 0.75, 1]) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      progress(value);
    }
    return "video";
  }, new AbortController().signal, (value) => seen.push(value), 50);
  assert.equal(result, "video");
  assert.deepEqual(seen, [0.25, 0.5, 0.75, 1]);
});

test("late progress after cancellation cannot update a new operation", async () => {
  let report: ((value: number) => void) | undefined;
  let updates = 0;
  const controller = new AbortController();
  const promise = prepareWithProgress(async (_, progress) => {
    report = progress;
    return new Promise<never>(() => {});
  }, controller.signal, () => { updates += 1; });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(promise, { name: "AbortError" });
  report?.(1);
  assert.equal(updates, 0);
});
