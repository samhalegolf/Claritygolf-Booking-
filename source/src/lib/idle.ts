/**
 * Run `task` when the browser has a quiet moment, or after `fallbackMs` if it
 * never offers one (Safari has no requestIdleCallback). Returns a cancel.
 */
export function whenIdle(task: () => void, fallbackMs: number): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(() => task(), { timeout: fallbackMs * 2 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(task, fallbackMs);
  return () => window.clearTimeout(id);
}
