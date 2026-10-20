type NativeShareHost = {
  version: number;
  canSave?: boolean;
  post: (message: Record<string, unknown>) => Promise<unknown>;
};
export type ShareStage = "choosing" | "preparing" | "handover";
export type ShareVideo = { blob: Blob; fileName: string };
type Prepare = (signal: AbortSignal, progress: (fraction: number) => void) => Promise<ShareVideo>;
const CHUNK = 256 * 1024;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const EVENT = "clarity-video-share";

function host(): NativeShareHost | null {
  const value = (globalThis as { __clarityVideoShare?: NativeShareHost }).__clarityVideoShare;
  return value?.version === 1 && typeof value.post === "function" ? value : null;
}
export function hasDeferredVideoShare() { return host() !== null; }
export function hasDeferredVideoExport() { return host()?.canSave === true; }

/** Present now; the native destination/provider asks for bytes only when needed. */
export function shareVideoDeferred(
  name: string, prepare: Prepare, signal: AbortSignal,
  onProgress: (stage: ShareStage, fraction: number) => void,
  action: "share" | "export" = "share",
): Promise<boolean> {
  const native = host();
  if (!native) return Promise.reject(new Error("Native video sharing is unavailable."));
  if (signal.aborted) return Promise.resolve(false);
  const id = crypto.randomUUID();
  const work = new AbortController();
  let settled = false;
  let preparing = false;
  let timeout: ReturnType<typeof setTimeout>;
  let resolve!: (sent: boolean) => void;
  let reject!: (error: Error) => void;
  const result = new Promise<boolean>((yes, no) => { resolve = yes; reject = no; });
  const post = (action: string, data: Record<string, unknown> = {}) => native.post({ action, id, ...data });
  const clean = () => {
    clearTimeout(timeout);
    work.abort();
    globalThis.removeEventListener(EVENT, receive);
    globalThis.removeEventListener("pagehide", abort);
    signal.removeEventListener("abort", abort);
  };
  const finish = (sent: boolean, error?: Error) => {
    if (settled) return;
    settled = true;
    clean();
    if (error) reject(error); else resolve(sent);
  };
  const abort = () => { void post("cancel").catch(() => undefined); finish(false); };
  const fail = (reason: unknown) => {
    if (settled) return;
    const error = reason instanceof Error ? reason : new Error("Could not prepare video.");
    void post("fail", { message: error.message }).catch(() => undefined);
    finish(false, error);
  };
  const prepareAndSend = async () => {
    if (preparing || settled) return;
    preparing = true;
    onProgress("preparing", 0);
    const file = await prepare(work.signal, (fraction) => {
      if (!settled) onProgress("preparing", Math.min(0.8, Math.max(0, fraction) * 0.8));
    });
    if (settled) return;
    if (!file.blob.size || file.blob.size > MAX_BYTES) throw new Error("Video is empty or exceeds the 2 GB sharing limit.");
    for (let offset = 0; offset < file.blob.size; offset += CHUNK) {
      if (settled) return;
      work.signal.throwIfAborted();
      const bytes = new Uint8Array(await file.blob.slice(offset, offset + CHUNK).arrayBuffer());
      if (settled) return;
      let binary = "";
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      }
      await post("chunk", { offset, data: btoa(binary) });
      if (!settled) onProgress("preparing", 0.8 + 0.2 * Math.min(offset + CHUNK, file.blob.size) / file.blob.size);
    }
    if (settled) return;
    await post("finish", { size: file.blob.size });
    if (!settled) onProgress("handover", 1);
  };
  function receive(event: Event) {
    const detail = (event as CustomEvent<{ id: string; type: string; message?: string }>).detail;
    if (!detail || detail.id !== id || settled) return;
    if (detail.type === "prepare") void prepareAndSend().catch(fail);
    else if (detail.type === "complete") finish(true);
    else if (detail.type === "cancelled") finish(false);
    else if (detail.type === "error") finish(false, new Error(detail.message || "Video sharing failed."));
  }
  globalThis.addEventListener(EVENT, receive);
  globalThis.addEventListener("pagehide", abort);
  signal.addEventListener("abort", abort, { once: true });
  timeout = setTimeout(() => {
    void post("cancel").catch(() => undefined);
    finish(false, new Error("Video sharing timed out. Please try again."));
  }, 15 * 60 * 1000);
  onProgress("choosing", 0);
  // Must run on the Share icon's original tap, before any asynchronous work.
  try { void post(action === "export" ? "save" : "present", { name }).catch(fail); } catch (error) { fail(error); }
  return result;
}
