/**
 * The files a digital product hands over: an ebook's PDF and EPUB, a practice
 * plan, a zip of templates.
 *
 * They live in the `shop-downloads` storage bucket, one folder per business.
 * Unlike site-media the bucket is PRIVATE: these are the thing being sold, so
 * nothing in it has a public address. A file leaves it two ways only, both
 * through a signed address that expires:
 *
 *   in   The coach's browser uploads straight to storage with a one-off signed
 *        upload address (an ebook is far bigger than a function request may
 *        be, so it cannot come through the function like a picture does).
 *   out  A paid order asks for its file and is redirected to a signed address
 *        that lasts a minute; the receipt email's attachments are fetched by
 *        the mail provider from one that lasts an hour.
 *
 * What may be sold, and the shape of a product's file list, are in
 * shop-file-rules.mts. The bucket path is flat under the business's folder
 * (no sub-folders) so the sweep can list it in one call.
 */

import { MAX_SHOP_FILE_BYTES, SHOP_FILE_TYPES, safeShopFileName, shopFileExtension, type ShopFile } from "./shop-file-rules.mts";
import { trimmedEnv } from "./values.mts";

export const SHOP_FILES_BUCKET = "shop-downloads";

export class ShopFileError extends Error {
  status = 400;
  code = "invalid_file";
}

type StorageFetch = (input: string, init?: RequestInit) => Promise<Response>;

function storageBase() {
  const url = trimmedEnv("SUPABASE_URL");
  const key = trimmedEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw Object.assign(new Error("File storage is not configured on this installation."), { status: 503, code: "files_unavailable" });
  }
  return { base: `${url.replace(/\/$/, "")}/storage/v1`, key };
}

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

async function storageRequest(path: string, init: RequestInit, doFetch: StorageFetch) {
  const { base, key } = storageBase();
  const response = await doFetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, ...(init.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw Object.assign(new Error(`File storage answered ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`), {
      status: 502,
      code: "files_failed",
      storageStatus: response.status,
    });
  }
  return response;
}

function randomPrefix() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const values = new Uint8Array(16);
  globalThis.crypto.getRandomValues(values);
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
}

/** Make the private bucket. Already there is fine. */
async function ensureShopFilesBucket(doFetch: StorageFetch) {
  const { base, key } = storageBase();
  const response = await doFetch(`${base}/bucket`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ id: SHOP_FILES_BUCKET, name: SHOP_FILES_BUCKET, public: false, file_size_limit: MAX_SHOP_FILE_BYTES }),
    signal: AbortSignal.timeout(15000),
  });
  if (response.ok || response.status === 409) return;
  const detail = await response.text().catch(() => "");
  if (/already exists/i.test(detail)) return;
  throw Object.assign(new Error(`File storage could not make its bucket: ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ""}`), {
    status: 502,
    code: "files_failed",
  });
}

export type ShopFileUpload = ShopFile & {
  /** Where the browser PUTs the file's bytes. Good for two hours, once. */
  uploadUrl: string;
  /** The content type to send with it. */
  type: string;
};

/**
 * Begin an upload: check the file is one that may be sold, give it a place in
 * the business's folder, and hand back a signed address the browser sends
 * the bytes to. Nothing is on the product until the form is saved with it.
 */
export async function startShopFileUpload(
  accountId: string,
  input: { name: unknown; bytes: unknown },
  doFetch: StorageFetch = fetch,
): Promise<ShopFileUpload> {
  const name = safeShopFileName(input.name);
  const extension = shopFileExtension(name);
  const type = SHOP_FILE_TYPES[extension];
  if (!name || !type) {
    throw new ShopFileError("That kind of file can't be sold as a download. Use a PDF, EPUB, ZIP, audio, video, image or Office file.");
  }
  const bytes = Math.round(Number(input.bytes) || 0);
  if (bytes <= 0) throw new ShopFileError("That file is empty. Try choosing it again.");
  if (bytes > MAX_SHOP_FILE_BYTES) {
    throw new ShopFileError(`That file is too large. A download can be up to ${Math.round(MAX_SHOP_FILE_BYTES / 1024 / 1024)} MB.`);
  }
  const path = `${accountId}/${randomPrefix()}-${name.replace(/ /g, "-")}`;
  const sign = () => storageRequest(`/object/upload/sign/${SHOP_FILES_BUCKET}/${encodePath(path)}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, doFetch);
  let response: Response;
  try {
    response = await sign();
  } catch (error) {
    // The migration makes the bucket where it can. Where it could not, the
    // first upload makes it here and tries again, once.
    if (!/Bucket not found/i.test(error instanceof Error ? error.message : "")) throw error;
    await ensureShopFilesBucket(doFetch);
    response = await sign();
  }
  const signed = String(((await response.json()) as { url?: unknown }).url ?? "");
  if (!signed) throw Object.assign(new Error("File storage did not return an upload address."), { status: 502, code: "files_failed" });
  return { path, name, bytes, type, uploadUrl: `${storageBase().base}${signed}` };
}

/** The size of a stored file in bytes, or null when nothing is at that path. */
export async function shopFileBytes(path: string, doFetch: StorageFetch = fetch): Promise<number | null> {
  try {
    const response = await storageRequest(`/object/info/${SHOP_FILES_BUCKET}/${encodePath(path)}`, { method: "GET" }, doFetch);
    const info = (await response.json()) as { size?: unknown; metadata?: { size?: unknown } };
    const size = Number(info.size ?? info.metadata?.size);
    return Number.isFinite(size) && size > 0 ? Math.round(size) : null;
  } catch (error) {
    const status = Number((error as { storageStatus?: unknown })?.storageStatus);
    if (status === 400 || status === 404) return null;
    throw error;
  }
}

/**
 * A product's files as they really are in storage: each one checked to be
 * there, with the size storage holds rather than the one the browser claimed.
 * A file that never finished uploading is refused by name, so a product is
 * never saved selling something that is not there.
 *
 * `known` are the files already on the product: they were checked when they
 * were saved, and are not asked about again.
 */
export async function verifyShopFiles(files: ShopFile[], known: ShopFile[], doFetch: StorageFetch = fetch): Promise<ShopFile[]> {
  return Promise.all(
    files.map(async (file) => {
      const already = known.find((entry) => entry.path === file.path);
      if (already) return { ...file, bytes: already.bytes };
      const bytes = await shopFileBytes(file.path, doFetch);
      if (bytes === null) throw new ShopFileError(`${file.name} did not finish uploading. Upload it again, then save.`);
      return { ...file, bytes };
    }),
  );
}

/** A temporary address for one file, which downloads it under its own name. */
export async function signedShopFileUrl(file: Pick<ShopFile, "path" | "name">, seconds: number, doFetch: StorageFetch = fetch): Promise<string> {
  const response = await storageRequest(
    `/object/sign/${SHOP_FILES_BUCKET}/${encodePath(file.path)}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expiresIn: seconds }) },
    doFetch,
  );
  const signed = String(((await response.json()) as { signedURL?: unknown }).signedURL ?? "");
  if (!signed) throw Object.assign(new Error("File storage did not return a download address."), { status: 502, code: "files_failed" });
  return `${storageBase().base}${signed}${signed.includes("?") ? "&" : "?"}download=${encodeURIComponent(file.name)}`;
}

type StoredObject = { name: string; created_at?: string };

/**
 * Drop a business's uploads that no product hands over any more: a file
 * replaced by a new edition, or one uploaded to a form that was never saved.
 *
 * Runs after a product save. An upload younger than an hour is left alone
 * whatever the products say: it may belong to a form still open. A failed
 * sweep is logged and left -- untidy storage is not a failed save.
 */
export async function sweepUnusedShopFiles(accountId: string, keepPaths: readonly string[], doFetch: StorageFetch = fetch): Promise<number> {
  const keep = new Set(keepPaths);
  try {
    const response = await storageRequest(
      `/object/list/${SHOP_FILES_BUCKET}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prefix: `${accountId}/`, limit: 1000, offset: 0 }),
      },
      doFetch,
    );
    const objects = (await response.json()) as StoredObject[];
    const cutoff = Date.now() - 60 * 60 * 1000;
    const stale = objects
      .filter((object) => object.name && !object.name.endsWith("/"))
      .map((object) => ({ path: `${accountId}/${object.name}`, created: Date.parse(object.created_at || "") || 0 }))
      .filter((object) => !keep.has(object.path) && object.created < cutoff)
      .map((object) => object.path);
    if (!stale.length) return 0;
    await storageRequest(
      `/object/${SHOP_FILES_BUCKET}`,
      { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ prefixes: stale }) },
      doFetch,
    );
    return stale.length;
  } catch (error) {
    console.warn("shop_files:sweep_failed", accountId, error instanceof Error ? error.message : error);
    return 0;
  }
}
