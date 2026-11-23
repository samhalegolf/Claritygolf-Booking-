// A digital product's files: the PDF and EPUB of an ebook, uploaded by the
// coach and handed to whoever buys it.
//
// A file is too big to go through a function the way a picture does, so it
// goes in two steps: the server checks it may be sold and gives back a one-off
// signed address in the private shop-downloads bucket, and the browser sends
// the bytes straight there. Nothing is on the product until its form is saved.
// The server half is netlify/functions/_shared/shop-files.mts.

import { t } from "../../lib/i18n";
import { SHOP_FILE_TYPES, shopFileFormat, type ShopFile } from "../../../netlify/functions/_shared/shop-file-rules.mts";

/** One file a download hands over, as the product row keeps it. */
export type ProductFile = ShopFile;

/** What a file comes as, for the coach to read: "PDF", "EPUB". */
export const fileFormat = shopFileFormat;

/** The file picker's filter: the kinds that may be sold. */
export const PRODUCT_FILE_ACCEPT = Object.keys(SHOP_FILE_TYPES).map((extension) => `.${extension}`).join(",");

/** A size a person reads: "840 KB", "12.4 MB". */
export function fileSizeLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export async function uploadProductFile(file: File): Promise<ProductFile> {
  const failed = t("Could not upload that file. Check your connection and try again.");
  const response = await fetch("/api/billing/product-files", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ name: file.name, bytes: file.size }),
  });
  const ticket = await response.json().catch(() => null);
  // A refusal says why in a sentence (too large, a kind that can't be sold).
  if (!response.ok) throw new Error(typeof ticket?.message === "string" && response.status < 500 ? ticket.message : failed);
  const sent = await fetch(String(ticket.uploadUrl), {
    method: "PUT",
    headers: { "content-type": String(ticket.type), "x-upsert": "false" },
    body: file,
  }).catch(() => null);
  if (!sent?.ok) throw new Error(failed);
  return { path: String(ticket.path), name: String(ticket.name), bytes: file.size };
}
