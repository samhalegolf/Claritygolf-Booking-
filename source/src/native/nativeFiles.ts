// Files the coach downloads (invoice PDFs, reports, snapshots, saved videos),
// inside the Clarity Booking staff app.
//
// A browser saves a file from a link or a new tab. The staff app's webview
// does neither: a new tab is handed to Safari or Chrome, which has no session
// cookie, and a download link does nothing at all. So inside the app the page
// fetches the file itself, writes it to the app's cache with the Filesystem
// plugin and offers the phone's share sheet (Save to Files, Mail, AirDrop...)
// with the Share plugin. In a browser, or the Player app, which has neither
// plugin, shareFileInApp() returns false and the caller does what it always did.

type Directory = "CACHE";

type FilesystemPlugin = {
  writeFile(options: { path: string; data: string; directory: Directory }): Promise<{ uri: string }>;
  appendFile(options: { path: string; data: string; directory: Directory }): Promise<void>;
  getUri(options: { path: string; directory: Directory }): Promise<{ uri: string }>;
};

type SharePlugin = {
  share(options: { files: string[]; title?: string }): Promise<unknown>;
};

type CapacitorGlobal = {
  isNativePlatform?: () => boolean;
  isPluginAvailable?: (name: string) => boolean;
  Plugins?: Record<string, unknown>;
};

function plugins() {
  const capacitor = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
  if (!capacitor?.isNativePlatform?.()) return null;
  if (!capacitor.isPluginAvailable?.("Filesystem") || !capacitor.isPluginAvailable?.("Share")) return null;
  const filesystem = capacitor.Plugins?.Filesystem as FilesystemPlugin | undefined;
  const share = capacitor.Plugins?.Share as SharePlugin | undefined;
  return filesystem && share ? { filesystem, share } : null;
}

// Written in pieces so a saved video is never one giant base64 string in
// memory. A multiple of 3 bytes, so each piece encodes without padding and the
// pieces join into one valid file.
const CHUNK_BYTES = 3 * 1024 * 1024;

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function fileNameFrom(response: Response, fallback: string) {
  const header = response.headers.get("content-disposition") || "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // Malformed header: the plain name or the fallback will do.
    }
  }
  return /filename="?([^";]+)"?/i.exec(header)?.[1] || fallback;
}

/** Only the name, never a path: it is written straight into the cache folder. */
function safeName(name: string) {
  return name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "clarity-file";
}

/**
 * Inside the staff app, save the file and open the share sheet, then resolve
 * true. Anywhere else resolve false without doing anything.
 *
 * `url` is fetched with the coach's session, so same-origin API routes work;
 * a data: URL works too. Throws if the file cannot be fetched or written.
 */
export async function shareFileInApp(source: { blob: Blob } | { url: string }, fileName: string): Promise<boolean> {
  const native = plugins();
  if (!native) return false;

  let blob: Blob;
  let name = fileName;
  if ("blob" in source) {
    blob = source.blob;
  } else {
    const response = await fetch(source.url, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error(`Download failed (${response.status}).`);
    name = fileNameFrom(response, fileName);
    blob = await response.blob();
  }

  const path = safeName(name);
  const directory: Directory = "CACHE";
  await native.filesystem.writeFile({ path, data: "", directory });
  for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
    const piece = new Uint8Array(await blob.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
    await native.filesystem.appendFile({ path, data: toBase64(piece), directory });
  }
  const { uri } = await native.filesystem.getUri({ path, directory });

  try {
    await native.share.share({ files: [uri], title: path });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/cancel|dismiss|abort/i.test(message)) return true;
    throw error;
  }
  return true;
}

/** True inside the staff app, where the phone's share sheet is the one way out. */
export function hasAppShareSheet() {
  return Boolean(plugins());
}

/**
 * Whether this browser can hand a file to another app (Messages, WhatsApp,
 * Mail...). Phones and Safari can; most desktop browsers can't, and get a
 * download instead.
 */
export function canShareFile(blob: Blob, fileName: string) {
  if (plugins()) return true;
  if (typeof navigator === "undefined" || typeof navigator.canShare !== "function") return false;
  try {
    return navigator.canShare({ files: [new File([blob], fileName, { type: blob.type })] });
  } catch {
    return false;
  }
}

/**
 * Hand a file to another app through the share sheet. Call it straight from a
 * tap: browsers only open the sheet in answer to one. Resolves false when the
 * person closed the sheet without picking anything.
 */
export async function shareFile(blob: Blob, fileName: string): Promise<boolean> {
  if (plugins()) return shareFileInApp({ blob }, fileName);
  if (!canShareFile(blob, fileName)) throw new Error("File sharing is unavailable here. Export the video, then open it in the app you want to use.");
  try {
    await navigator.share({ files: [new File([blob], fileName, { type: blob.type })] });
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return false;
    throw error;
  }
}

/** Save a copy to this computer's downloads. Browser only; the app shares. */
export function downloadFile(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = safeName(fileName);
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Save a standalone copy; iOS offers Save to Files in its system sheet. */
export async function exportFile(blob: Blob, fileName: string): Promise<void> {
  if (await shareFileInApp({ blob }, fileName)) return;
  downloadFile(blob, fileName);
}

export type VideoSaveHandle = {
  name: string;
  createWritable: () => Promise<{
    write: (data: Blob) => Promise<void>;
    close: () => Promise<void>;
    abort: () => Promise<void>;
  }>;
};

/** Request Save As on the original tap, before loading or rendering a video. */
export function chooseVideoExportDestination(fileName: string): Promise<VideoSaveHandle | null> {
  const picker = (globalThis as { showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<VideoSaveHandle> }).showSaveFilePicker;
  if (!picker || hasAppShareSheet()) return Promise.resolve(null);
  return picker.call(globalThis, {
    suggestedName: safeName(fileName),
    types: [{ description: "Video", accept: {
      "video/mp4": [".mp4"], "video/webm": [".webm"], "video/quicktime": [".mov"],
    } }],
  });
}

export async function writeVideoExport(handle: VideoSaveHandle, blob: Blob): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
}
