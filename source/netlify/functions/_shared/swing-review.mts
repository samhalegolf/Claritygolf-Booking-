/**
 * A swing review, as the player asks for one.
 *
 * The thing being created is an ordinary booking. That is not a shortcut --
 * the pass schema says it outright: "a swing review is a booking of a service
 * whose lessonFormat is 'video-review' ... it already flows through the normal
 * booking path with a server-set deadline instead of a slot". So a review
 * request lands in the coach's calendar with a turnaround date, settles like
 * any other booking, and is paid for with a credit covering that service.
 *
 * What this module owns is the small amount of judgement in front of that: is
 * there a review service to book, is the request substantial enough to send,
 * and which of the player's passes can pay for it. The booking itself is
 * created by createPublicBooking, and the credit is taken by reservePassCredit
 * -- neither is reimplemented here.
 */

const text = (value: unknown, max = 4000) => String(value ?? "").trim().slice(0, max);

/* The turnaround the portal promises must be the turnaround the deadline is
 * actually set from, so this mirrors cleanReviewTurnaroundDays in
 * booking-core.mts exactly rather than approximating it.
 *
 * The case that made this worth its own function: `Number(0) || 3` is 3, so a
 * service with a turnaround of 0 had the portal promising three days while
 * videoReviewDueSlot set the deadline one day out. Clamping, not defaulting,
 * is what the server does with a finite number. */
const REVIEW_DEFAULT_TURNAROUND_DAYS = 3;
const REVIEW_MAX_TURNAROUND_DAYS = 30;

function cleanTurnaroundDays(value: unknown) {
  const days = Number(value);
  if (!Number.isFinite(days)) return REVIEW_DEFAULT_TURNAROUND_DAYS;
  return Math.max(1, Math.min(REVIEW_MAX_TURNAROUND_DAYS, Math.round(days)));
}

export type ReviewService = {
  id: string;
  name: string;
  price: number;
  turnaroundDays: number;
  acceptsCrossRedemption: boolean;
};

/**
 * The service a review is booked against.
 *
 * Exactly one, or none. A business with two video-review services has a
 * catalogue question to answer -- which is "the" review? -- and guessing picks
 * the wrong price and the wrong turnaround, so the portal offers nothing and
 * the coach fixes the catalogue.
 */
export function findReviewService(services: unknown): ReviewService | null {
  if (!Array.isArray(services)) return null;
  const candidates = services.filter((service) => {
    const entry = service as Record<string, unknown>;
    return (
      entry?.lessonFormat === "video-review" &&
      entry?.active !== false &&
      entry?.archived !== true &&
      text(entry?.id, 120)
    );
  }) as Array<Record<string, unknown>>;

  if (candidates.length !== 1) return null;
  const service = candidates[0];
  return {
    id: text(service.id, 120),
    name: text(service.name, 180) || "Video review",
    price: Number(service.price) || 0,
    turnaroundDays: cleanTurnaroundDays(service.reviewTurnaroundDays),
    acceptsCrossRedemption: service.acceptsCrossRedemption !== false,
  };
}

export type ReviewDraft = {
  notes: string;
  hasVideo: boolean;
};

export type ReviewDraftVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Is there enough here to send?
 *
 * One of the two is enough, deliberately. A video with no words is the common
 * case -- "look at this" -- and words with no video is a real question a coach
 * can answer from what they already know about the player. Requiring both
 * would turn the second kind of request into no request at all.
 *
 * Neither is not a review. It would book a deadline, take a credit, and give
 * the coach nothing to look at.
 */
export function reviewDraftVerdict(draft: ReviewDraft): ReviewDraftVerdict {
  if (draft.hasVideo) return { ok: true };
  if (text(draft.notes).length > 0) return { ok: true };
  return {
    ok: false,
    reason: "Add a video, a note about what you want looked at, or both.",
  };
}

/** The lesson id a review's parts are filed under, matching the coach's side
 *  (startSwingReviewForClient in App.tsx) so both ends group the same way. */
export function newSwingReviewLessonId(now = Date.now()) {
  return `swing-review-${now}`;
}

export type ReviewPaymentOption = {
  passId: string;
  name: string;
  creditsAvailable: number;
  expiresAt: string | null;
};

/**
 * Which of this player's passes can pay for a review, best first.
 *
 * "Best" is the one that expires soonest, which is the same order the ledger
 * spends in -- so the pass the portal offers is the pass the server would have
 * chosen anyway, and a player is never quietly nudged into burning a credit
 * that had longer to live.
 */
export function reviewPaymentOptions(
  passes: Array<{
    id: string;
    name: string;
    status: string;
    creditsAvailable: number;
    coversServiceIds: string[];
    nextExpiry: string | null;
    expiresAt: string | null;
  }>,
  reviewServiceId: string,
): ReviewPaymentOption[] {
  const wanted = text(reviewServiceId, 120);
  if (!wanted) return [];
  return passes
    .filter(
      (pass) =>
        pass.status === "active" &&
        pass.creditsAvailable > 0 &&
        pass.coversServiceIds.includes(wanted),
    )
    .map((pass) => ({
      passId: pass.id,
      name: pass.name,
      creditsAvailable: pass.creditsAvailable,
      expiresAt: pass.nextExpiry || pass.expiresAt,
    }))
    .sort((left, right) => {
      // A pass that never expires is spent last: it is the one with nothing to
      // lose by waiting.
      if (!left.expiresAt && !right.expiresAt) return 0;
      if (!left.expiresAt) return 1;
      if (!right.expiresAt) return -1;
      return left.expiresAt.localeCompare(right.expiresAt);
    });
}
