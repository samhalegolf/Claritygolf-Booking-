// A picture as the coach chose it, made web-sized before it leaves the browser.
//
// Phone photos are 4000px and 5 MB; a landing page wants 1600px and 200 KB.
// Shrinking here keeps the upload under the function's limit and the page
// fast for every visitor, and nothing on the server has to decode images.

const MAX_EDGE = 1800;
const QUALITY = 0.86;

export type PreparedImage = { type: string; dataBase64: string; bytes: number };

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("unreadable"));
    };
    image.src = url;
  });
}

function toBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, QUALITY));
}

async function base64Of(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/**
 * Shrink and re-encode. A GIF is sent as it is (re-encoding would lose the
 * animation); everything else becomes WebP where the browser can make one,
 * or JPEG, with transparency kept as PNG.
 *
 * `printable` is for a picture that goes into a PDF (the gift card), which
 * takes JPEG and PNG only: no WebP, and a GIF becomes a still PNG.
 */
export async function prepareImage(file: File, options: { printable?: boolean } = {}): Promise<PreparedImage> {
  if (!file.type.startsWith("image/")) throw new Error("not-an-image");
  if (file.type === "image/gif" && !options.printable) {
    return { type: file.type, dataBase64: await base64Of(file), bytes: file.size };
  }
  const image = await loadImage(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("unreadable");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const wantsAlpha = file.type === "image/png" || file.type === "image/gif";
  const candidates = options.printable
    ? [wantsAlpha ? "image/png" : "image/jpeg"]
    : wantsAlpha
      ? ["image/webp", "image/png"]
      : ["image/webp", "image/jpeg"];
  for (const type of candidates) {
    const blob = await toBlob(canvas, type);
    // Safari used to answer a WebP request with a PNG: only trust a blob of
    // the type asked for.
    if (blob && blob.type === type) return { type, dataBase64: await base64Of(blob), bytes: blob.size };
  }
  throw new Error("unreadable");
}
