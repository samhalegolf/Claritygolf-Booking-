/* The coach's calls for a review's page and the drill library.
 *
 * Thin on purpose: the server cleans every write (review-document.mts), so the
 * only judgement here is turning a failed response into a sentence. */

import { apiFetch } from "../auth/apiFetch";
import { t } from "../../lib/i18n";
import type {
  Drill,
  ReviewBlock,
  ReviewDocument,
} from "../../../netlify/functions/_shared/review-document.mts";

export type { Drill, ReviewBlock, ReviewDocument };

const base = "/api/video-transfer";

/** Where a drill's own video is filed in the saved video library and Clarity
 *  Cloud. Not a person, so it never shows in a player's videos. */
export const DRILL_LIBRARY_PLAYER_ID = "drill-library";
/** The lesson id a drill's video is saved under: `drill-<drill id>`. */
export const DRILL_LESSON_PREFIX = "drill-";

async function failure(response: Response, fallback: string) {
  const body = (await response.json().catch(() => ({}))) as { message?: string };
  return new Error(body.message || fallback);
}

export function newBlockId() {
  return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export async function fetchReviewDocuments(playerId: string): Promise<ReviewDocument[]> {
  const response = await apiFetch(`${base}/review/docs?playerId=${encodeURIComponent(playerId)}`);
  if (!response.ok) throw await failure(response, t("Could not load this player's review pages."));
  const body = (await response.json()) as { documents?: ReviewDocument[] };
  return Array.isArray(body.documents) ? body.documents : [];
}

export async function saveReviewDocument(input: {
  lessonId: string;
  playerId: string;
  title: string;
  blocks: ReviewBlock[];
}): Promise<ReviewDocument> {
  const response = await apiFetch(`${base}/review/doc`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await failure(response, t("Could not save this review."));
  const body = (await response.json()) as { document: ReviewDocument };
  return body.document;
}

/** Throw away a review that was started and never sent. */
export async function discardReviewDocument(lessonId: string): Promise<void> {
  const response = await apiFetch(`${base}/review/doc?lessonId=${encodeURIComponent(lessonId)}`, { method: "DELETE" });
  if (!response.ok) throw await failure(response, t("Could not discard this review."));
}

export type DrillDraft = {
  title: string;
  notes: string;
  /** A YouTube link (or id). Empty for a drill with its own video. */
  youtubeUrl: string;
  start: number;
  end: number | null;
  savedVideoId: string;
  thumbnailDataUrl: string;
  authorName: string;
};

export async function fetchDrills(): Promise<Drill[]> {
  const response = await apiFetch(`${base}/drills`);
  if (!response.ok) throw await failure(response, t("Could not load the drill library."));
  const body = (await response.json()) as { drills?: Drill[] };
  return Array.isArray(body.drills) ? body.drills : [];
}

export async function saveDrill(draft: DrillDraft, drillId?: string): Promise<Drill> {
  const response = await apiFetch(drillId ? `${base}/drills/${encodeURIComponent(drillId)}` : `${base}/drills`, {
    method: drillId ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  });
  if (!response.ok) throw await failure(response, t("Could not save this drill."));
  const body = (await response.json()) as { drill: Drill };
  return body.drill;
}

export async function deleteDrill(drillId: string): Promise<void> {
  const response = await apiFetch(`${base}/drills/${encodeURIComponent(drillId)}`, { method: "DELETE" });
  if (!response.ok) throw await failure(response, t("Could not delete this drill."));
}
