/**
 * What a digital product's files may be: the rules with no I/O in them, so
 * the shop's shelf (online-shop.mts) and the browser can read a product's
 * files without pulling in storage. shop-files.mts does the storing.
 *
 * What a product hands over is the `download_files` list on its row: each
 * entry a path in the private shop-downloads bucket, the file's name as the
 * buyer sees it, and its size.
 */

/** Per file. The bucket enforces the same number. */
export const MAX_SHOP_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_SHOP_FILES_PER_PRODUCT = 6;
/**
 * The most a receipt email carries as attachments, all files together.
 * Mailboxes commonly refuse a message over 25 MB, and an attachment grows by
 * a third in transit, so 15 MB of files is a 20 MB email. Over this the
 * email carries the download links alone.
 */
export const MAX_EMAIL_ATTACHMENT_BYTES = 15 * 1024 * 1024;

/**
 * What may be sold as a download. A list of what is allowed rather than what
 * is not: anything a browser would run (html, svg, js) or a computer would
 * (exe, dmg) has no business being handed to a buyer from here.
 */
export const SHOP_FILE_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  epub: "application/epub+zip",
  mobi: "application/x-mobipocket-ebook",
  azw3: "application/vnd.amazon.ebook",
  zip: "application/zip",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  csv: "text/csv",
};

export type ShopFile = {
  /** Where it is in the bucket: "<accountId>/<random>-<name>". */
  path: string;
  /** The file's name as the buyer downloads it: "The Clarity Method.pdf". */
  name: string;
  bytes: number;
};

/** The lower-case extension of a file name, or "". */
export function shopFileExtension(name: string) {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim());
  return match ? match[1].toLowerCase() : "";
}

/** How a file is named to a buyer choosing between them: "PDF", "EPUB". */
export function shopFileFormat(name: string): string {
  return shopFileExtension(name).toUpperCase();
}

/**
 * A file name with nothing in it a path, a header or a shell could trip on.
 * A name with no plain letters left (one written in kanji, say) keeps its
 * extension and is called "download".
 */
export function safeShopFileName(value: unknown): string {
  const given = String(value ?? "").trim();
  const extension = shopFileExtension(given);
  const base = (extension ? given.slice(0, -(extension.length + 1)) : given)
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[\\/:*?"<>|#%&{}$!'`=+@^~[\];,.]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  if (!given) return "";
  return `${base || "download"}${extension ? `.${extension}` : ""}`;
}

/**
 * The download_files column, or whatever a product form sends: the files of
 * this business only, each of a kind that may be sold, one per format.
 *
 * One per format because that is what a buyer is offered ("PDF", "EPUB") and
 * how an order's link names the file it wants; a second PDF would be a file
 * nobody could reach.
 */
export function cleanShopFiles(value: unknown, accountId: string): ShopFile[] {
  const list = typeof value === "string" ? (() => { try { return JSON.parse(value); } catch { return []; } })() : value;
  if (!Array.isArray(list) || !accountId) return [];
  const formats = new Set<string>();
  const files: ShopFile[] = [];
  for (const entry of list) {
    const raw = (entry || {}) as Record<string, unknown>;
    const path = String(raw.path ?? "").trim();
    const name = safeShopFileName(raw.name);
    const bytes = Math.round(Number(raw.bytes) || 0);
    const format = shopFileFormat(name);
    // Its own folder, and nothing below it: the path is "<account>/<file>".
    if (!path.startsWith(`${accountId}/`) || path.slice(accountId.length + 1).includes("/") || path.includes("..")) continue;
    if (!SHOP_FILE_TYPES[format.toLowerCase()] || shopFileExtension(path) !== format.toLowerCase()) continue;
    if (bytes <= 0 || bytes > MAX_SHOP_FILE_BYTES || formats.has(format)) continue;
    formats.add(format);
    files.push({ path, name, bytes });
    if (files.length >= MAX_SHOP_FILES_PER_PRODUCT) break;
  }
  return files;
}
