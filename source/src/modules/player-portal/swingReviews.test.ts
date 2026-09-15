import assert from "node:assert/strict";
import test from "node:test";

import {
  groupSwingReviews,
  isSwingReviewLessonId,
  swingReviewStartedAt,
} from "./swingReviews";
import type {
  ClarityCloudImportTransfer,
  SavedVideoItem,
} from "../video-analysis/utils/savedVideoLibrary";

/* The grouping is the whole feature: a review has no record of its own, so if
 * the lesson id stops arriving -- or stops being matched -- the portal shows
 * a player nothing and says, truthfully, that there is nothing there. These
 * pin the two ways that has already happened once: a normaliser dropping the
 * id on its way to the player, and a screenshot arriving without its picture.
 */

const REVIEW = "swing-review-1757808000000";
const OTHER_REVIEW = "swing-review-1757894400000";

function savedVideo(over: Partial<SavedVideoItem> & { savedVideoId: string }): SavedVideoItem {
  return {
    playerId: "player-1",
    title: "Driver",
    analysisId: "analysis-1",
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
    capturedAt: "2026-09-14T00:00:00.000Z",
    source: { mimeType: "video/mp4", sizeBytes: 1 },
    local: { status: "available" },
    analysisSnapshot: { focusSnapshots: [], notes: [] },
    workspaceSnapshot: {},
    ...over,
  } as unknown as SavedVideoItem;
}

function transfer(
  over: Partial<ClarityCloudImportTransfer> & { savedVideoId: string },
): ClarityCloudImportTransfer {
  return {
    transferId: `t-${over.savedVideoId}`,
    status: "ready",
    expectedSizeBytes: 1,
    acceptedOffsetBytes: 1,
    chunkSizeBytes: 1,
    ...over,
  } as unknown as ClarityCloudImportTransfer;
}

const note = (id: string, lessonId?: string, updatedAt = "2026-09-14T01:00:00.000Z") => ({
  id,
  lessonId,
  createdAt: "2026-09-14T01:00:00.000Z",
  updatedAt,
});

const block = (id: string, linkedVideoId: string | null) => ({ id, linkedVideoId, title: id });

const empty = { savedVideos: [], cloudVideos: [], notes: [], practice: [] };

test("a lesson id is a review only with the coach's prefix", () => {
  assert.equal(isSwingReviewLessonId(REVIEW), true);
  assert.equal(isSwingReviewLessonId("lesson-123"), false);
  assert.equal(isSwingReviewLessonId(""), false);
  assert.equal(isSwingReviewLessonId(undefined), false);
});

test("a note alone is enough to make a review appear", () => {
  // The case that matters most: notes are server-side and reach the player
  // without the coach sending anything, so this is what a player sees first.
  const reviews = groupSwingReviews({ ...empty, notes: [note("n1", REVIEW)] });
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].id, REVIEW);
  assert.equal(reviews[0].notes.length, 1);
  assert.equal(reviews[0].itemCount, 1);
});

test("a note with no lesson id is left where it was", () => {
  // The bug this feature was built on top of: the server used to strip
  // lessonId, and every note arrived looking exactly like this one.
  const reviews = groupSwingReviews({ ...empty, notes: [note("n1"), note("n2", "lesson-9")] });
  assert.deepEqual(reviews, []);
});

test("videos, notes and practice with one id come back as one review", () => {
  const reviews = groupSwingReviews({
    savedVideos: [savedVideo({ savedVideoId: "v1", lessonId: REVIEW })],
    cloudVideos: [],
    notes: [note("n1", REVIEW)],
    practice: [block("p1", "v1"), block("p2", "v-elsewhere"), block("p3", null)],
  });
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].videos.length, 1);
  assert.equal(reviews[0].notes.length, 1);
  assert.deepEqual(
    reviews[0].practice.map((entry) => entry.id),
    ["p1"],
    "only practice linked to one of this review's videos belongs to it",
  );
});

test("a cloud copy of a video already on this device is not a second video", () => {
  const reviews = groupSwingReviews({
    savedVideos: [savedVideo({ savedVideoId: "v1", lessonId: REVIEW })],
    cloudVideos: [
      transfer({ savedVideoId: "v1", savedVideo: { lessonId: REVIEW, title: "Driver" } as never }),
    ],
    notes: [],
    practice: [],
  });
  assert.equal(reviews[0].videos.length, 1);
  assert.equal(reviews[0].cloudVideos.length, 0);
  assert.equal(reviews[0].itemCount, 1);
});

test("practice linked to a video still in the cloud belongs to the review", () => {
  // The player has not downloaded it yet. The practice is still theirs, and
  // the review is where it makes sense.
  const reviews = groupSwingReviews({
    savedVideos: [],
    cloudVideos: [
      transfer({ savedVideoId: "v9", savedVideo: { lessonId: REVIEW, title: "Irons" } as never }),
    ],
    notes: [],
    practice: [block("p1", "v9")],
  });
  assert.deepEqual(
    reviews[0].practice.map((entry) => entry.id),
    ["p1"],
  );
});

test("an unopened coach return marks the review, a seen one does not", () => {
  const unseen = groupSwingReviews({
    ...empty,
    cloudVideos: [
      transfer({
        savedVideoId: "v1",
        direction: "coach-return",
        coachMessage: "Look at the takeaway",
        savedVideo: { lessonId: REVIEW } as never,
      }),
    ],
  });
  assert.equal(unseen[0].unseen, true);
  assert.equal(unseen[0].coachMessage, "Look at the takeaway");

  const seen = groupSwingReviews({
    ...empty,
    cloudVideos: [
      transfer({
        savedVideoId: "v1",
        direction: "coach-return",
        playerSeenAt: "2026-09-15T00:00:00.000Z",
        savedVideo: { lessonId: REVIEW } as never,
      }),
    ],
  });
  assert.equal(seen[0].unseen, false);
});

test("the player's own submission is not something waiting for them", () => {
  const reviews = groupSwingReviews({
    ...empty,
    cloudVideos: [
      transfer({
        savedVideoId: "v1",
        direction: "player-submission",
        savedVideo: { lessonId: REVIEW } as never,
      }),
    ],
  });
  assert.equal(reviews[0].unseen, false);
  assert.equal(reviews[0].coachMessage, "");
});

test("a screenshot keeps its words and its timestamp when the picture is gone", () => {
  // compactSavedVideoAnalysisJson strips imageDataUrl on upload, so anything
  // that came back over the cloud looks like this. The note and the second it
  // was taken at are what the portal has left to show.
  const reviews = groupSwingReviews({
    ...empty,
    savedVideos: [
      savedVideo({
        savedVideoId: "v1",
        lessonId: REVIEW,
        title: "Driver",
        analysisSnapshot: {
          focusSnapshots: [
            { id: "s1", title: "Impact", note: "Hands ahead", currentTime: 3.42 },
          ],
          notes: [{ id: "a1", text: "Better", time: 1.5 }],
        } as never,
      }),
    ],
  });
  const [shot] = reviews[0].screenshots;
  assert.equal(shot.title, "Impact");
  assert.equal(shot.note, "Hands ahead");
  assert.equal(shot.currentTime, 3.42);
  assert.equal(shot.imageDataUrl, undefined);
  assert.equal(shot.videoTitle, "Driver");
  assert.equal(reviews[0].analysisNotes[0].text, "Better");
  assert.equal(reviews[0].itemCount, 3, "video + screenshot + analysis note");
});

test("reviews come back newest first", () => {
  const reviews = groupSwingReviews({
    ...empty,
    notes: [
      note("n1", REVIEW, "2026-09-14T01:00:00.000Z"),
      note("n2", OTHER_REVIEW, "2026-09-15T01:00:00.000Z"),
    ],
  });
  assert.deepEqual(
    reviews.map((review) => review.id),
    [OTHER_REVIEW, REVIEW],
  );
});

test("a review with nothing dated in it still sorts by when it was started", () => {
  const reviews = groupSwingReviews({
    ...empty,
    notes: [note("n1", REVIEW, ""), note("n2", OTHER_REVIEW, "")].map((entry) => ({
      ...entry,
      createdAt: "",
    })),
  });
  assert.deepEqual(
    reviews.map((review) => review.id),
    [OTHER_REVIEW, REVIEW],
  );
  assert.equal(reviews[1].at, swingReviewStartedAt(REVIEW));
});

test("a malformed review id does not throw, it just has no clock", () => {
  assert.equal(swingReviewStartedAt("swing-review-nonsense"), "");
  const reviews = groupSwingReviews({
    ...empty,
    notes: [{ id: "n1", lessonId: "swing-review-nonsense", createdAt: "", updatedAt: "" }],
  });
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].at, "");
});
