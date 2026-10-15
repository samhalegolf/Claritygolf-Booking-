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
  } catch {
    // Closing the share sheet without picking anything rejects. Not an error.
  }
  return true;
}
