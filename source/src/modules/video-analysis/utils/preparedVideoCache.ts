import { prepareWithProgress } from "./videoPreparation";

type Prepare<T> = (signal: AbortSignal, progress: (fraction: number) => void) => Promise<T>;

/** Keep only the current video's prepared file; changing edits invalidates it. */
export class PreparedVideoCache<T> {
  private entry?: {
    key: string;
    controller: AbortController;
    promise: Promise<T>;
    file?: T;
    progress?: (fraction: number) => void;
  };

  peek(key: string): T | undefined {
    return this.entry?.key === key ? this.entry.file : undefined;
  }

  prepare(key: string, prepare: Prepare<T>, progress?: (fraction: number) => void): Promise<T> {
    if (this.entry?.key === key) {
      this.entry.progress = progress;
      return this.entry.promise;
    }
    this.clear();
    const controller = new AbortController();
    const entry = {
      key, controller, promise: undefined as unknown as Promise<T>,
      file: undefined as T | undefined, progress,
    };
    this.entry = entry;
    entry.promise = prepareWithProgress(prepare, controller.signal,
      (fraction) => entry.progress?.(fraction)).then((file) => {
      if (this.entry === entry && !controller.signal.aborted) entry.file = file;
      return file;
    }).catch((error: unknown) => {
      if (this.entry === entry) this.entry = undefined;
      throw error;
    });
    return entry.promise;
  }

  clear() {
    this.entry?.controller.abort();
    this.entry = undefined;
  }
}
