/**
 * The shape of a swing review's page, and of a drill in the drill library.
 *
 * Shared by the server (which cleans every write with these functions) and the
 * coach's app and the player's pages (which render the same blocks), so the
 * two ends can never disagree about what a block is.
 *
 * A review page is an ordered list of blocks:
 *
 *   video  -- a saved video, by id. Its snapshots and timestamped notes live on
 *             the video itself, where the analysis workspace keeps them.
 *   note   -- a heading and some text.
 *   link   -- a web address with a label.
 *   drill  -- a copy of a drill from the library. Either a YouTube clip (with
 *             its own start/end and timestamped notes) or the review's own
 *             copy of the drill's video, saved like any other review video.
 *
 * Nothing here touches the network or the database.
 */

const text = (value: unknown, max = 600) => String(value ?? "").trim().slice(0, max);

/** Generous, but bounded: the page is one JSON column. */
export const MAX_REVIEW_BLOCKS = 120;

export type ReviewVideoBlock = { id: string; type: "video"; savedVideoId: string };
export type ReviewNoteBlock = { id: string; type: "note"; title: string; body: string };
export type ReviewLinkBlock = { id: string; type: "link"; url: string; label: string };

export type DrillMarker = { id: string; time: number; note: string };

export type ReviewDrillBlock = {
  id: string;
  type: "drill";
  /** The library drill this was copied from. Informational: the copy is the
   *  review's own, and editing it never changes the original. */
  drillId: string;
  title: string;
  notes: string;
  /** A YouTube drill. Empty for a drill with its own video. */
  youtubeId: string;
  /** The part of the YouTube clip that matters, in seconds. */
  start: number;
  end: number | null;
  /** Timestamped notes on a YouTube clip. YouTube does not let a page grab
   *  frames, so these are times and words rather than pictures. */
  markers: DrillMarker[];
  /** A drill with its own video: the review's copy of it, saved under the
   *  review like any other review video, snapshots and all. */
  savedVideoId: string;
};

export type ReviewBlock = ReviewVideoBlock | ReviewNoteBlock | ReviewLinkBlock | ReviewDrillBlock;
export type ReviewBlockType = ReviewBlock["type"];

export type ReviewDocument = {
  lessonId: string;
  playerId: string;
  title: string;
  blocks: ReviewBlock[];
  sentAt: string;
  createdAt: string;
  updatedAt: string;
};

export type Drill = {
  id: string;
  title: string;
  notes: string;
  youtubeId: string;
  start: number;
  end: number | null;
  savedVideoId: string;
  thumbnailDataUrl: string;
  authorName: string;
  /** True when the coach asking made it, which is who may change it. */
  mine: boolean;
  createdAt: string;
  updatedAt: string;
};

const seconds = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) / 100 : 0;
};

const optionalSeconds = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number * 100) / 100 : null;
};

/**
 * The 11-character id out of anything a coach is likely to paste: a watch URL,
 * a youtu.be link, a Shorts or embed link, or the bare id. Empty when it is
 * not a YouTube video.
 */
export function youtubeIdFrom(input: unknown): string {
  const value = text(input, 400);
  if (!value) return "";
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return "";
  }
  const host = url.hostname.replace(/^www\.|^m\.|^music\./, "").toLowerCase();
  let candidate = "";
  if (host === "youtu.be") {
    candidate = url.pathname.split("/")[1] || "";
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const [first, second] = url.pathname.split("/").filter(Boolean);
    if (first === "watch") candidate = url.searchParams.get("v") || "";
    else if (first === "shorts" || first === "embed" || first === "live" || first === "v") candidate = second || "";
  }
  return /^[A-Za-z0-9_-]{11}$/.test(candidate) ? candidate : "";
}

/** The start time a YouTube link carries (`t=` or `start=`), in seconds. */
export function youtubeStartFrom(input: unknown): number {
  const value = text(input, 400);
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return 0;
  }
  const raw = url.searchParams.get("t") || url.searchParams.get("start") || "";
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) return Number(raw);
  const match = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!match) return 0;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

/** The privacy-enhanced embed, cropped to the drill's start and end. */
export function youtubeEmbedUrl(youtubeId: string, start = 0, end: number | null = null): string {
  if (!/^[A-Za-z0-9_-]{11}$/.test(youtubeId)) return "";
  const params = new URLSearchParams({ rel: "0", modestbranding: "1", playsinline: "1" });
  if (start > 0) params.set("start", String(Math.floor(start)));
  if (end && end > start) params.set("end", String(Math.ceil(end)));
  return `https://www.youtube-nocookie.com/embed/${youtubeId}?${params.toString()}`;
}

export function youtubeThumbnailUrl(youtubeId: string): string {
  return /^[A-Za-z0-9_-]{11}$/.test(youtubeId) ? `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg` : "";
}

/**
 * A link a player will be asked to open. http(s) only -- a `javascript:` or
 * `data:` address in a page someone else opens is the whole of an XSS -- and a
 * bare domain is given https rather than refused.
 */
export function cleanLinkUrl(input: unknown): string {
  const value = text(input, 2000);
  if (!value) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (!url.hostname.includes(".")) return "";
    return url.toString();
  } catch {
    return "";
  }
}

const blockId = (value: unknown, index: number) =>
  text(value, 80).replace(/[^A-Za-z0-9_-]/g, "") || `block-${index}`;

function cleanMarkers(value: unknown): DrillMarker[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 60)
    .map((marker, index) => ({
      id: blockId(marker?.id, index),
      time: seconds(marker?.time),
      note: text(marker?.note, 1000),
    }))
    .filter((marker) => marker.note)
    .sort((left, right) => left.time - right.time);
}

/**
 * One block, cleaned, or null when there is nothing left of it worth keeping.
 * Unknown types are dropped rather than passed through: whatever is stored
 * here is rendered on a page the player opens.
 */
export function cleanReviewBlock(value: unknown, index = 0): ReviewBlock | null {
  const input = (value || {}) as Record<string, unknown>;
  const id = blockId(input.id, index);
  switch (input.type) {
    case "video": {
      const savedVideoId = text(input.savedVideoId, 160);
      return savedVideoId ? { id, type: "video", savedVideoId } : null;
    }
    case "note":
      // An empty note is kept: the coach has just added it and is about to
      // type. The pages that show the review skip empty ones.
      return { id, type: "note", title: text(input.title, 180), body: text(input.body, 8000) };
    case "link":
      return { id, type: "link", url: cleanLinkUrl(input.url), label: text(input.label, 180) };
    case "drill": {
      const youtubeId = youtubeIdFrom(input.youtubeId);
      const start = seconds(input.start);
      const end = optionalSeconds(input.end);
      return {
        id,
        type: "drill",
        drillId: text(input.drillId, 120),
        title: text(input.title, 180),
        notes: text(input.notes, 8000),
        youtubeId,
        start: youtubeId ? start : 0,
        end: youtubeId && end && end > start ? end : null,
        markers: youtubeId ? cleanMarkers(input.markers) : [],
        savedVideoId: youtubeId ? "" : text(input.savedVideoId, 160),
      };
    }
    default:
      return null;
  }
}

/** Every block, cleaned, in order, with ids made unique and the list capped. */
export function cleanReviewBlocks(value: unknown): ReviewBlock[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const blocks: ReviewBlock[] = [];
  for (const [index, entry] of value.slice(0, MAX_REVIEW_BLOCKS).entries()) {
    const block = cleanReviewBlock(entry, index);
    if (!block) continue;
    if (seen.has(block.id)) block.id = `${block.id}-${index}`;
    seen.add(block.id);
    blocks.push(block);
  }
  return blocks;
}

/** The saved videos a page shows: video blocks, and drills with their own copy. */
export function reviewBlockVideoIds(blocks: readonly ReviewBlock[]): string[] {
  return blocks.flatMap((block) =>
    block.type === "video" ? [block.savedVideoId] : block.type === "drill" && block.savedVideoId ? [block.savedVideoId] : [],
  );
}

/**
 * What a player sees of a page: empty notes and links that never got an
 * address are the coach's unfinished work, not something to show.
 */
export function visibleReviewBlocks(blocks: readonly ReviewBlock[]): ReviewBlock[] {
  return blocks.filter((block) => {
    if (block.type === "note") return Boolean(block.title || block.body);
    if (block.type === "link") return Boolean(block.url);
    if (block.type === "drill") return Boolean(block.youtubeId || block.savedVideoId || block.title || block.notes);
    return true;
  });
}

export type DrillInput = {
  title: string;
  notes: string;
  youtubeId: string;
  start: number;
  end: number | null;
  savedVideoId: string;
  thumbnailDataUrl: string;
  authorName: string;
};

/** A thumbnail is a small JPEG data URL or nothing; anything else is dropped. */
function cleanThumbnail(value: unknown): string {
  const raw = String(value ?? "");
  if (raw.length > 200_000) return "";
  return /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(raw) ? raw : "";
}

/**
 * A drill as written by the coach. A YouTube link wins over a saved video if
 * both somehow arrive -- a drill is one video, not two.
 */
export function cleanDrillInput(value: unknown): DrillInput {
  const input = (value || {}) as Record<string, unknown>;
  const youtubeId = youtubeIdFrom(input.youtubeId ?? input.youtubeUrl);
  const start = youtubeId ? seconds(input.start) : 0;
  const end = youtubeId ? optionalSeconds(input.end) : null;
  return {
    title: text(input.title, 180),
    notes: text(input.notes, 8000),
    youtubeId,
    start,
    end: end && end > start ? end : null,
    savedVideoId: youtubeId ? "" : text(input.savedVideoId, 160),
    thumbnailDataUrl: youtubeId ? "" : cleanThumbnail(input.thumbnailDataUrl),
    authorName: text(input.authorName, 120),
  };
}

/** A drill dropped into a review: the review's own copy of its words and clip. */
export function drillToBlock(drill: Pick<Drill, "id" | "title" | "notes" | "youtubeId" | "start" | "end">, id: string): ReviewDrillBlock {
  return {
    id,
    type: "drill",
    drillId: drill.id,
    title: drill.title,
    notes: drill.notes,
    youtubeId: drill.youtubeId,
    start: drill.youtubeId ? drill.start : 0,
    end: drill.youtubeId ? drill.end : null,
    markers: [],
    // A drill with its own video gets the review's copy once the coach has
    // saved it from the workspace; until then there is no video to point at.
    savedVideoId: "",
  };
}
