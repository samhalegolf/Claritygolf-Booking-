/**
 * Sending a swing review out.
 *
 * The cases worth pinning down are the ones where a send would mislead the
 * player: a review with nothing in it, a link with no clock on it, and an
 * email that offers only the door the player has never opened.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  REVIEW_SHARE_TTL_DAYS,
  isSwingReviewLessonId,
  reviewAt,
  reviewEmail,
  reviewSendVerdict,
  reviewShareExpiry,
  reviewShareUrl,
  reviewShareVideo,
  swingReviewStartedAt,
} from "./swing-review-share.mts";
import { newSwingReviewLessonId } from "./swing-review.mts";

const target = (over: Record<string, unknown> = {}) => ({
  portalPlayerId: "portal-1",
  personId: "person-1",
  email: "chi@example.com",
  name: "Chi",
  ...over,
});

test("a review id made by one side is recognised by the other", () => {
  const id = newSwingReviewLessonId(1758153600000);
  assert.ok(isSwingReviewLessonId(id), "the coach's id must read as a review id here");
  assert.equal(swingReviewStartedAt(id), new Date(1758153600000).toISOString());
});

test("an ordinary lesson id is not a review", () => {
  assert.equal(isSwingReviewLessonId("lesson-123"), false);
  assert.equal(isSwingReviewLessonId(""), false);
  assert.equal(isSwingReviewLessonId(undefined), false);
});

test("a review with nothing in it is not sent", () => {
  const verdict = reviewSendVerdict({ target: target(), videoCount: 0, noteCount: 0, practiceCount: 0 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok === false ? verdict.reason : "", /nothing in this review/i);
});

test("notes alone are a review worth sending", () => {
  // A review the coach talked through without recording anything is still a
  // review. Requiring a video would silently drop that kind of work.
  assert.deepEqual(
    reviewSendVerdict({ target: target(), videoCount: 0, noteCount: 2, practiceCount: 0 }),
    { ok: true },
  );
});

test("a player with no portal is refused, not sent a link instead", () => {
  // The link is a way in, not a substitute for having somewhere to keep it.
  const verdict = reviewSendVerdict({ target: null, videoCount: 3, noteCount: 1, practiceCount: 0 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok === false ? verdict.reason : "", /portal access/i);
});

test("a player with no email address is refused", () => {
  const verdict = reviewSendVerdict({
    target: target({ email: "" }),
    videoCount: 1,
    noteCount: 0,
    practiceCount: 0,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok === false ? verdict.reason : "", /no email address/i);
});

test("the link carries a clock", () => {
  const now = Date.UTC(2026, 8, 18);
  const expiry = new Date(reviewShareExpiry(now)).getTime();
  assert.equal(expiry - now, REVIEW_SHARE_TTL_DAYS * 86400000);
});

test("the share url is the token and nothing else identifying", () => {
  const url = reviewShareUrl("https://claritygolf.app/", "tok en+/");
  assert.equal(url, "https://claritygolf.app/?reviewShare=tok%20en%2B%2F");
  // No app url configured means no link at all, rather than a relative one an
  // email client would render as text.
  assert.equal(reviewShareUrl("", "token"), "");
});

test("a video's notes arrive in swing order, and empty ones are dropped", () => {
  const video = reviewShareVideo(
    { savedVideoId: "saved-1", title: "Down the line", sizeBytes: 120, createdAt: "2026-09-18T00:00:00.000Z" },
    {
      analysis: {
        notes: [
          { id: "n2", text: "Left wrist at the top", time: 4.2 },
          { id: "n3", text: "   ", time: 0.1 },
          { id: "n1", text: "Takeaway", time: 1.1 },
        ],
        focusSnapshots: [
          { id: "s2", title: "Impact", note: "", currentTime: 6 },
          { id: "s1", title: "Top", note: "Watch the trail elbow", currentTime: 3 },
        ],
      },
    },
  );
  assert.deepEqual(video.notes.map((note) => note.id), ["n1", "n2"]);
  assert.deepEqual(video.screenshots.map((snapshot) => snapshot.id), ["s1", "s2"]);
});

test("a video whose analysis never arrived still renders", () => {
  // Analysis is a separate Drive file. A missing one is a thinner page, not a
  // broken review.
  const video = reviewShareVideo({ savedVideoId: "saved-1" }, null);
  assert.equal(video.title, "Swing video");
  assert.deepEqual(video.notes, []);
  assert.deepEqual(video.screenshots, []);
});

test("a review is dated by its newest part, not its id", () => {
  const id = newSwingReviewLessonId(Date.UTC(2026, 8, 1));
  assert.equal(
    reviewAt(id, ["2026-09-02T00:00:00.000Z", "", "2026-09-05T00:00:00.000Z"]),
    "2026-09-05T00:00:00.000Z",
  );
  // Nothing dated inside it falls back to when the coach started it.
  assert.equal(reviewAt(id, [null, undefined, ""]), new Date(Date.UTC(2026, 8, 1)).toISOString());
});

test("the email offers the link first and the portal second", () => {
  const email = reviewEmail({
    playerName: "Chi Wang",
    coachName: "Sam Hale",
    coachMessage: "Look at the takeaway",
    shareUrl: "https://claritygolf.app/?reviewShare=abc",
    portalUrl: "https://claritygolf.app",
    expiresAt: "2026-12-17T00:00:00.000Z",
    videoCount: 2,
    noteCount: 1,
    practiceCount: 1,
  });
  assert.equal(email.subject, "Sam Hale sent you a swing review");
  assert.match(email.text, /^Hi Chi,/);
  assert.match(email.text, /2 videos, 1 note and 1 practice block/);
  assert.match(email.text, /Look at the takeaway/);
  assert.ok(
    email.text.indexOf("?reviewShare=abc") < email.text.lastIndexOf("https://claritygolf.app"),
    "the no-sign-in link must come before the portal one",
  );
  assert.match(email.text, /This link works until/);
});

test("the email still reads when there is no coach name and no message", () => {
  const email = reviewEmail({
    playerName: "",
    coachName: "",
    coachMessage: "",
    shareUrl: "https://claritygolf.app/?reviewShare=abc",
    portalUrl: "https://claritygolf.app",
    expiresAt: "",
    videoCount: 1,
    noteCount: 0,
    practiceCount: 0,
  });
  assert.equal(email.subject, "Your swing review is ready");
  assert.match(email.text, /^Hi,/);
  assert.match(email.text, /Your coach has finished a swing review/);
  assert.doesNotMatch(email.text, /This link works until/);
});
