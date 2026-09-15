/**
 * Asking for a swing review.
 *
 * The two refusals are the point. A request with nothing in it would book a
 * deadline and take a credit for a coach to look at nothing; a catalogue with
 * two review services has no answer to "which one", and guessing charges the
 * wrong price against the wrong turnaround.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  findReviewService,
  newSwingReviewLessonId,
  reviewDraftVerdict,
  reviewPaymentOptions,
} from "./swing-review.mts";
import { isSwingReviewLessonId } from "../../../src/modules/player-portal/swingReviews.ts";

const service = (over: Record<string, unknown> = {}) => ({
  id: "review-1",
  name: "Video Review",
  lessonFormat: "video-review",
  price: 15,
  reviewTurnaroundDays: 3,
  active: true,
  ...over,
});

test("the one review service is the one a review is booked against", () => {
  const found = findReviewService([service(), { id: "l", lessonFormat: "private", active: true }]);
  assert.equal(found?.id, "review-1");
  assert.equal(found?.price, 15);
  assert.equal(found?.turnaroundDays, 3);
});

test("two review services resolve to none, because neither is 'the' review", () => {
  // Guessing here charges the wrong price and promises the wrong turnaround.
  const found = findReviewService([service(), service({ id: "review-2", name: "Quick Review" })]);
  assert.equal(found, null);
});

test("an inactive or archived review is not offered", () => {
  assert.equal(findReviewService([service({ active: false })]), null);
  assert.equal(findReviewService([service({ archived: true })]), null);
});

test("a business selling no review offers none", () => {
  assert.equal(findReviewService([{ id: "l", lessonFormat: "private", active: true }]), null);
  assert.equal(findReviewService([]), null);
  assert.equal(findReviewService(null), null);
});

test("the promised turnaround is the one the deadline is set from", () => {
  // This mirrors cleanReviewTurnaroundDays in booking-core, which is what
  // videoReviewDueSlot actually uses. If the two ever disagree the portal
  // promises one date and the coach is owed it on another: a finite number is
  // clamped, and only a non-number falls back to the default.
  assert.equal(findReviewService([service({ reviewTurnaroundDays: 0 })])?.turnaroundDays, 1);
  assert.equal(findReviewService([service({ reviewTurnaroundDays: -4 })])?.turnaroundDays, 1);
  assert.equal(findReviewService([service({ reviewTurnaroundDays: 500 })])?.turnaroundDays, 30);
  // "" is Number 0, which is finite, so it clamps like 0 rather than falling
  // back -- exactly as the server treats it.
  assert.equal(findReviewService([service({ reviewTurnaroundDays: "" })])?.turnaroundDays, 1);
  assert.equal(findReviewService([service({ reviewTurnaroundDays: "soon" })])?.turnaroundDays, 3);
  assert.equal(findReviewService([service({ reviewTurnaroundDays: undefined })])?.turnaroundDays, 3);
});

test("either a video or a note is enough on its own", () => {
  assert.equal(reviewDraftVerdict({ notes: "", hasVideo: true }).ok, true);
  assert.equal(reviewDraftVerdict({ notes: "Look at my takeaway", hasVideo: false }).ok, true);
  assert.equal(reviewDraftVerdict({ notes: "Both", hasVideo: true }).ok, true);
});

test("an empty request is refused before it books anything", () => {
  const verdict = reviewDraftVerdict({ notes: "   ", hasVideo: false });
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok === false ? verdict.reason : "", /video|note/i);
});

test("the lesson id matches the one the coach's side groups on", () => {
  const id = newSwingReviewLessonId(1_757_808_000_000);
  assert.equal(id, "swing-review-1757808000000");
  assert.equal(isSwingReviewLessonId(id), true, "both ends must agree or the parts never meet");
});

/* --- Which credit pays --------------------------------------------------- */

const pass = (over: Record<string, unknown> = {}) => ({
  id: "pass-1",
  name: "Review credits",
  status: "active",
  creditsAvailable: 2,
  coversServiceIds: ["review-1"],
  nextExpiry: null,
  expiresAt: null,
  ...over,
}) as Parameters<typeof reviewPaymentOptions>[0][number];

test("only a live pass that covers the review can pay for it", () => {
  const options = reviewPaymentOptions(
    [
      pass(),
      pass({ id: "spent", creditsAvailable: 0 }),
      pass({ id: "expired", status: "expired" }),
      pass({ id: "elsewhere", coversServiceIds: ["lesson-60"] }),
    ],
    "review-1",
  );
  assert.deepEqual(options.map((entry) => entry.passId), ["pass-1"]);
});

test("the credit that expires soonest is offered first", () => {
  // The same order the ledger spends in, so the portal never nudges somebody
  // into burning a credit that had longer to live.
  const options = reviewPaymentOptions(
    [
      pass({ id: "later", nextExpiry: "2027-12-01T00:00:00.000Z" }),
      pass({ id: "sooner", nextExpiry: "2027-01-01T00:00:00.000Z" }),
    ],
    "review-1",
  );
  assert.deepEqual(options.map((entry) => entry.passId), ["sooner", "later"]);
});

test("a pass that never expires is spent last", () => {
  const options = reviewPaymentOptions(
    [
      pass({ id: "never", nextExpiry: null, expiresAt: null }),
      pass({ id: "dated", nextExpiry: "2027-01-01T00:00:00.000Z" }),
    ],
    "review-1",
  );
  assert.deepEqual(options.map((entry) => entry.passId), ["dated", "never"]);
});

test("no review service means nothing can pay for one", () => {
  assert.deepEqual(reviewPaymentOptions([pass()], ""), []);
});
