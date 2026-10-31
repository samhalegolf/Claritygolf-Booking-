/**
 * Pictures on a business's page.
 *
 * They live in the `site-media` storage bucket (created by the migration that
 * made the site tables), one folder per business, public to read because the
 * page they are on is public. Uploads come through the function with the
 * service key; the browser never holds a storage credential.
 *
 * The browser shrinks a picture before sending it (see imagePrep.ts), so what
 * arrives is already web-sized. The cap here is the backstop, and it sits
 * under the function's own request limit with room for the base64 overhead.
 */

import { trimmedEnv } from "../values.mts";

export const SITE_MEDIA_BUCKET = "site-media";
/** Bytes, after decoding. 3 MB base64 is 4 MB on the wire. */
export const MAX_SITE_IMAGE_BYTES = 3 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export class MediaInputError extends Error {
  status = 400;
  code = "invalid_image";
}

function storageBase() {
  const url = trimmedEnv("SUPABASE_URL");
  const key = trimmedEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw Object.assign(new Error("Image storage is not configured on this installation."), { status: 503, code: "media_unavailable" });
  }
  return { base: `${url.replace(/\/$/, "")}/storage/v1`, key };
}

/** The public address of an object in the bucket. */
export function siteMediaUrl(path: string): string {
  const { base } = storageBase();
  return `${base}/object/public/${SITE_MEDIA_BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** The bucket path an address refers to, or "" when it is not one of ours. */
export function siteMediaPathFromUrl(url: string): string {
  let prefix: string;
  try {
    prefix = `${storageBase().base}/object/public/${SITE_MEDIA_BUCKET}/`;
  } catch {
    return "";
  }
  if (!url.startsWith(prefix)) return "";
  return url
    .slice(prefix.length)
    .split("/")
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .join("/");
}

type StorageFetch = (input: string, init?: RequestInit) => Promise<Response>;

async function storageRequest(path: string, init: RequestInit, doFetch: StorageFetch = fetch) {
  const { base, key } = storageBase();
  const response = await doFetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, ...(init.headers || {}) },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw Object.assign(new Error(`Image storage answered ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`), {
      status: 502,
      code: "media_failed",
    });
  }
  return response;
}

export type UploadedImage = { url: string; path: string; bytes: number };

/**
 * Store one picture for a business and hand back its public address.
 *
 * `dataBase64` is the file's bytes; `type` decides the extension and what the
 * bucket serves it as. SVG is refused on purpose: an SVG can carry script,
 * and this bucket serves to a page strangers open.
 */
export async function uploadSiteImage(
  accountId: string,
  input: { type: unknown; dataBase64: unknown },
  doFetch: StorageFetch = fetch,
): Promise<UploadedImage> {
  const type = String(input.type ?? "").toLowerCase();
  const extension = IMAGE_TYPES[type];
  if (!extension) throw new MediaInputError("Use a JPG, PNG, WebP or GIF picture.");
  const raw = String(input.dataBase64 ?? "").replace(/^data:[^,]*,/, "");
  if (!raw) throw new MediaInputError("The picture arrived empty. Try choosing it again.");
  let bytes: Buffer;
  try {
    bytes = Buffer.from(raw, "base64");
  } catch {
    throw new MediaInputError("The picture could not be read.");
  }
  if (!bytes.length) throw new MediaInputError("The picture arrived empty. Try choosing it again.");
  if (bytes.length > MAX_SITE_IMAGE_BYTES) {
    throw new MediaInputError("That picture is too large. Pictures are shrunk automatically, so this one is unusually big: try a smaller export.");
  }
  const path = `${accountId}/${Date.now().toString(36)}-${randomSuffix()}.${extension}`;
  const put = () =>
    storageRequest(
      `/object/${SITE_MEDIA_BUCKET}/${path}`,
      {
        method: "POST",
        headers: { "content-type": type, "cache-control": "public, max-age=31536000, immutable", "x-upsert": "false" },
        body: new Uint8Array(bytes),
      },
      doFetch,
    );
  try {
    await put();
  } catch (error) {
    // The migration makes the bucket where it can. Where it could not, the
    // first upload makes it here and tries again, once.
    if (!/Bucket not found/i.test(error instanceof Error ? error.message : "")) throw error;
    await ensureSiteMediaBucket(doFetch);
    await put();
  }
  return { url: siteMediaUrl(path), path, bytes: bytes.length };
}

/** Make the public bucket. Already there is fine. */
export async function ensureSiteMediaBucket(doFetch: StorageFetch = fetch): Promise<void> {
  const { base, key } = storageBase();
  const response = await doFetch(`${base}/bucket`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      id: SITE_MEDIA_BUCKET,
      name: SITE_MEDIA_BUCKET,
      public: true,
      file_size_limit: 5 * 1024 * 1024,
      allowed_mime_types: Object.keys(IMAGE_TYPES),
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (response.ok || response.status === 409) return;
  const detail = await response.text().catch(() => "");
  if (/already exists/i.test(detail)) return;
  throw Object.assign(new Error(`Image storage could not make its bucket: ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ""}`), {
    status: 502,
    code: "media_failed",
  });
}

function randomSuffix() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const values = new Uint8Array(8);
  globalThis.crypto.getRandomValues(values);
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
}

type StoredObject = { name: string; created_at?: string };

/**
 * Drop a business's uploads that no saved page refers to any more.
 *
 * Runs after a save. An upload younger than an hour is left alone whatever
 * the page says: the coach may have just added it and not yet saved the
 * block that shows it. A failed sweep is logged and left -- storage that is
 * a little untidy is not a failed save.
 */
export async function sweepUnusedSiteImages(accountId: string, keepUrls: readonly string[], doFetch: StorageFetch = fetch): Promise<number> {
  const keep = new Set(keepUrls.map(siteMediaPathFromUrl).filter(Boolean));
  let removed = 0;
  try {
    const response = await storageRequest(
      `/object/list/${SITE_MEDIA_BUCKET}`,
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
    if (stale.length) {
      await storageRequest(
        `/object/${SITE_MEDIA_BUCKET}`,
        { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ prefixes: stale }) },
        doFetch,
      );
      removed = stale.length;
    }
  } catch (error) {
    console.warn("site_media:sweep_failed", accountId, error instanceof Error ? error.message : error);
  }
  return removed;
}
