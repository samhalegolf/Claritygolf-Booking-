/** Bound preparation by inactivity, while allowing long exports that make progress. */
export async function prepareWithProgress<T>(
  prepare: (signal: AbortSignal, progress: (fraction: number) => void) => Promise<T>,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
  idleMs = 90_000,
): Promise<T> {
  signal.throwIfAborted();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let lastProgress = -1;
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(
      "Video preparation stopped responding. Check that the video is available and your device has free space, then try again.",
    )), idleMs);
  };
  let rejectAbort: (() => void) | undefined;
  try {
    reset();
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const task = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return prepare(controller.signal, (fraction) => {
        if (stopped || controller.signal.aborted) return;
        if (Number.isFinite(fraction) && fraction > lastProgress) {
          lastProgress = fraction;
          reset();
          onProgress(Math.max(0, Math.min(1, fraction)));
        }
      });
    });
    return await Promise.race([task, aborted]);
  } finally {
    stopped = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
  }
}
