export const THUMBNAIL_MAX_LENGTH = 44_000;
export function safeVideoThumbnail(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= THUMBNAIL_MAX_LENGTH &&
    /^data:image\/(jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value) ? value : undefined;
}

