/* A swing review, assembled on the player's side.
 *
 * A review has no record of its own anywhere. It is a lesson id -- literally
 * `swing-review-<ms>` -- that the coach stamps onto everything they touch
 * during one sitting: the videos, the notes typed beside them, the practice
 * that came out of it. The review *is* that id, and reading one back means
 * gathering everything wearing it.
 *
 * The coach's app does the same gathering (playerSwingReviewGroups in App.tsx)
 * from the coach's own four lists. This does it from the player's four, which
 * are a strict subset -- so a review always reads thinner here than it does on
 * the coach's screen, and each of the gaps is deliberate:
 *
 *   - A video the coach never sent stays on the coach's phone, so the player's
 *     copy of the review simply has one fewer video in it.
 *   - Screenshot images are stripped on upload (compactSavedVideoAnalysisJson),
 *     so a screenshot that arrived over the cloud has its title, its note and
 *     its timestamp but no picture. `imageDataUrl` is optional here for that
 *     reason, and the portal renders the timestamp when it is missing rather
 *     than an empty frame.
 *
 * Nothing here decides what a player may see. Every list handed in has already
 * been filtered to this player by the server or by their own device.
 */

import type {
  ClarityCloudImportTransfer,
  SavedVideoItem,
} from "../video-analysis/utils/savedVideoLibrary";

/** The prefix startSwingReviewForClient() stamps on. The one link between the
 *  coach's side and this one, so it is named rather than inlined twice. */
export const SWING_REVIEW_LESSON_PREFIX = "swing-review-";

export function isSwingReviewLessonId(lessonId?: string | null) {
  return Boolean(lessonId && lessonId.startsWith(SWING_REVIEW_LESSON_PREFIX));
}

/** The review's own clock, out of the id the coach generated. Used only when
 *  nothing inside the review carries a date -- a review that is one note old
 *  still has to sort somewhere. */
export function swingReviewStartedAt(lessonId: string): string {
  const stamp = Number(lessonId.slice(SWING_REVIEW_LESSON_PREFIX.length));
  if (!Number.isFinite(stamp) || stamp <= 0) return "";
  return new Date(stamp).toISOString();
}

/** The shapes this needs, rather than the portal's full types: the grouping
 *  does not care what else a note or a practice block carries. */
type ReviewNoteLike = {
  id: string;
  lessonId?: string;
  createdAt?: string;
  updatedAt?: string;
};

type ReviewPracticeLike = {
  id: string;
  linkedVideoId: string | null;
};

export type SwingReviewScreenshot = {
  id: string;
  title: string;
  note?: string;
  /** Seconds into the video. The fallback when the picture did not travel. */
  currentTime: number;
  imageDataUrl?: string;
  savedVideoId: string;
  videoTitle: string;
};

export type SwingReviewAnalysisNote = {
  id: string;
  text: string;
  time: number;
  videoTitle: string;
};

export type SwingReview<
  TNote extends ReviewNoteLike,
  TPractice extends ReviewPracticeLike,
> = {
  id: string;
  /** Newest thing in the review, or the id's own stamp if it holds nothing. */
  at: string;
  /** On this device, and openable. */
  videos: SavedVideoItem[];
  /** In the cloud and not on this device, so these offer a download. */
  cloudVideos: ClarityCloudImportTransfer[];
  notes: TNote[];
  practice: TPractice[];
  screenshots: SwingReviewScreenshot[];
  analysisNotes: SwingReviewAnalysisNote[];
  /** The note the coach attached when they sent a video back, if they did. */
  coachMessage: string;
  /** Holds a returned video this player has not opened yet. */
  unseen: boolean;
  itemCount: number;
};

export type SwingReviewSources<
  TNote extends ReviewNoteLike,
  TPractice extends ReviewPracticeLike,
> = {
  savedVideos: SavedVideoItem[];
  cloudVideos: ClarityCloudImportTransfer[];
  notes: TNote[];
  practice: TPractice[];
};

/**
 * Every swing review this player can see, newest first.
 *
 * A review appears as soon as any one of its four parts reaches the player --
 * usually a lesson note, which is server-side and arrives without the coach
 * doing anything further. That is deliberate: these notes already show in the
 * portal's Notes tab today, so grouping them exposes nothing new. It only
 * stops them arriving as loose paper.
 */
export function groupSwingReviews<
  TNote extends ReviewNoteLike,
  TPractice extends ReviewPracticeLike,
>({
  savedVideos,
  cloudVideos,
  notes,
  practice,
}: SwingReviewSources<TNote, TPractice>): SwingReview<TNote, TPractice>[] {
  const reviewVideos = savedVideos.filter((video) => isSwingReviewLessonId(video.lessonId));

  // A cloud row for a video already on this device is the same video twice.
  // The local copy wins: it can be opened, and it is the one carrying the
  // analysis.
  const onDevice = new Set(savedVideos.map((video) => video.savedVideoId));
  const reviewCloudVideos = cloudVideos.filter(
    (transfer) =>
      isSwingReviewLessonId(transfer.savedVideo?.lessonId) &&
      !onDevice.has(transfer.savedVideoId),
  );

  const reviewIds = new Set(
    [
      ...reviewVideos.map((video) => video.lessonId),
      ...reviewCloudVideos.map((transfer) => transfer.savedVideo?.lessonId),
      ...notes.filter((note) => isSwingReviewLessonId(note.lessonId)).map((note) => note.lessonId),
    ].filter((id): id is string => Boolean(id)),
  );

  return [...reviewIds]
    .map((id) => {
      const videos = reviewVideos.filter((video) => video.lessonId === id);
      const reviewCloud = reviewCloudVideos.filter(
        (transfer) => transfer.savedVideo?.lessonId === id,
      );
      const reviewNotes = notes.filter((note) => note.lessonId === id);

      // Practice is filed against a video, never against the review, so the
      // only way back is through the review's own videos. A block linked to a
      // video the player has not been sent stays in the Practice tab where it
      // already was -- it does not vanish, it just has no review to sit under.
      const videoIds = new Set([
        ...videos.map((video) => video.savedVideoId),
        ...reviewCloud.map((transfer) => transfer.savedVideoId),
      ]);
      const reviewPractice = practice.filter(
        (block) => block.linkedVideoId && videoIds.has(block.linkedVideoId),
      );

      const at =
        [
          ...videos.map((video) => video.capturedAt || video.createdAt),
          ...reviewCloud.map((transfer) => transfer.savedVideo?.createdAt || ""),
          ...reviewNotes.map((note) => note.updatedAt || note.createdAt || ""),
        ]
          .filter(Boolean)
          .sort()
          .at(-1) || swingReviewStartedAt(id);

      const screenshots = videos.flatMap((video) =>
        (video.analysisSnapshot?.focusSnapshots || []).map((snapshot) => ({
          id: snapshot.id,
          title: snapshot.title,
          note: snapshot.note,
          currentTime: snapshot.currentTime,
          imageDataUrl: snapshot.imageDataUrl,
          savedVideoId: video.savedVideoId,
          videoTitle: video.title,
        })),
      );

      const analysisNotes = videos.flatMap((video) =>
        (video.analysisSnapshot?.notes || []).map((note) => ({
          id: note.id,
          text: note.text,
          time: note.time,
          videoTitle: video.title,
        })),
      );

      const returned = reviewCloud.find((transfer) => transfer.direction === "coach-return");

      return {
        id,
        at,
        videos,
        cloudVideos: reviewCloud,
        notes: reviewNotes,
        practice: reviewPractice,
        screenshots,
        analysisNotes,
        coachMessage: returned?.coachMessage || "",
        unseen: reviewCloud.some(
          (transfer) => transfer.direction === "coach-return" && !transfer.playerSeenAt,
        ),
        itemCount:
          videos.length +
          reviewCloud.length +
          reviewNotes.length +
          reviewPractice.length +
          screenshots.length +
          analysisNotes.length,
      };
    })
    // Newest first, and the id breaks a tie -- two reviews made the same day
    // must not swap places between renders.
    .sort((left, right) => right.at.localeCompare(left.at) || right.id.localeCompare(left.id));
}
