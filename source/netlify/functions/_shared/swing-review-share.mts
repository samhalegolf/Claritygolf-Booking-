/**
 * Sending a finished swing review to the player it is about.
 *
 * The coach's side of the review already existed: a lesson id stamped on every
 * video, note and practice block from one sitting, re-gathered at both ends.
 * What was missing was the last gesture -- handing it over -- and that gesture
 * needs three things the review itself does not have:
 *
 *   1. One email for one review. Every video in a review travels as its own
 *      coach-return, and each of those would otherwise announce itself. A coach
 *      who worked three angles sent one review, not three videos.
 *   2. A way in that is not the portal. A player who has never signed in should
 *      still be able to watch what they were sent, from the email, on a phone,
 *      without being asked to remember a password first.
 *   3. A clock on that way in. A link that is the whole credential must expire,
 *      because an email is forwardable and forever is not a security property.
 *
 * This module owns the judgement in all three. The routes in video-transfer.mts
 * own the Drive bytes and the database; nothing here touches either, so all of
 * it is testable without a network.
 */

const text = (value: unknown, max = 600) => String(value ?? "").trim().slice(0, max);

/**
 * How long a review link lives.
 *
 * Longer than the guest share's retention window on purpose. A guest link is
 * racing the deletion of the bytes behind it; this one points at a video that
 * lives in the coach's Drive indefinitely, and the only clock on it is how long
 * an emailed credential should stay good. Ninety days is about one coaching
 * block -- long enough that a player coming back to it in the winter still
 * finds it, short enough that a forwarded email from last season is dead.
 */
export const REVIEW_SHARE_TTL_DAYS = 90;

export function reviewShareExpiry(now = Date.now()): string {
  return new Date(now + REVIEW_SHARE_TTL_DAYS * 86400000).toISOString();
}

/** The prefix startSwingReviewForClient() stamps on, and the one link between
 *  the coach's app, the player's portal and this module. */
export const SWING_REVIEW_LESSON_PREFIX = "swing-review-";

export function isSwingReviewLessonId(lessonId: unknown): boolean {
  return typeof lessonId === "string" && lessonId.startsWith(SWING_REVIEW_LESSON_PREFIX);
}

/** The review's own clock, recovered from the id the coach generated. Used when
 *  nothing inside the review carries a date of its own. */
export function swingReviewStartedAt(lessonId: string): string {
  const stamp = Number(lessonId.slice(SWING_REVIEW_LESSON_PREFIX.length));
  if (!Number.isFinite(stamp) || stamp <= 0) return "";
  return new Date(stamp).toISOString();
}

export function reviewShareUrl(appUrl: string, token: string): string {
  const base = text(appUrl, 400).replace(/\/$/, "");
  if (!base || !token) return "";
  return `${base}/?reviewShare=${encodeURIComponent(token)}`;
}

export function portalSignInUrl(appUrl: string): string {
  const base = text(appUrl, 400).replace(/\/$/, "");
  return base || "";
}

export type ReviewSendTarget = {
  /** portal_players.id. A review is only ever sent to someone with a portal. */
  portalPlayerId: string;
  /** The canonical person id, which is what the videos get filed under. */
  personId: string;
  email: string;
  name: string;
};

export type ReviewSendVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Is there a review here, and somewhere to send it?
 *
 * Deliberately permissive about *what* the review holds: a review that is one
 * video is a review, and so is one that is three notes and no video at all --
 * the coach decides what was worth saying. What it refuses is the two cases
 * where sending would mislead somebody:
 *
 *   - An empty review. The email would promise work that is not there.
 *   - A player with no portal. The video has to land somewhere permanent, and
 *     the link is a way *in*, not a replacement for having anywhere to keep it.
 *     This is the same rule sendSavedVideoToPlayer already applies per video.
 */
export function reviewSendVerdict(input: {
  target: ReviewSendTarget | null;
  videoCount: number;
  noteCount: number;
  practiceCount: number;
}): ReviewSendVerdict {
  if (!input.target) {
    return { ok: false, reason: "Give this player portal access first — that is where the review is kept." };
  }
  if (!text(input.target.email, 180).includes("@")) {
    return { ok: false, reason: "This player has no email address on file, so there is nowhere to send it." };
  }
  if (input.videoCount + input.noteCount + input.practiceCount === 0) {
    return { ok: false, reason: "There is nothing in this review yet. Add a video or a note before sending it." };
  }
  return { ok: true };
}

export type ReviewShareVideo = {
  savedVideoId: string;
  title: string;
  sizeBytes: number;
  mimeType: string;
  durationSeconds: number | null;
  createdAt: string;
  /** Timestamped notes the coach typed against this video. */
  notes: Array<{ id: string; text: string; time: number }>;
  /** Screenshot captions. The pictures are stripped on upload, so these carry
   *  their title, note and timestamp and the page renders the timestamp. */
  screenshots: Array<{ id: string; title: string; note: string; currentTime: number }>;
};

export type ReviewSharePayload = {
  playerName: string;
  coachName: string;
  businessName: string;
  reviewAt: string;
  coachMessage: string;
  expiresAt: string;
  videos: ReviewShareVideo[];
  notes: Array<{ id: string; title: string; body: string; createdAt: string }>;
  practice: Array<{ id: string; title: string; content: string; dose: string; status: string }>;
};

/** The analysis file a finalized transfer leaves in Drive, as much of it as
 *  this page reads. Everything else in there stays where it is. */
type AnalysisFile = {
  analysis?: {
    notes?: Array<{ id?: unknown; text?: unknown; time?: unknown }>;
    focusSnapshots?: Array<{ id?: unknown; title?: unknown; note?: unknown; currentTime?: unknown }>;
  };
};

const seconds = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
};

/**
 * One video, as the share page sees it.
 *
 * Note what is not here: no Drive ids, no account id, no transfer id, no
 * player id. The page is reachable by anyone holding the token, so it is handed
 * the review and nothing that would let it ask about anything else -- the same
 * rule the guest share page follows.
 */
export function reviewShareVideo(
  row: {
    savedVideoId: string;
    title?: string;
    mimeType?: string;
    sizeBytes?: number;
    durationSeconds?: number | null;
    createdAt?: string;
  },
  analysis: AnalysisFile | null,
): ReviewShareVideo {
  const notes = Array.isArray(analysis?.analysis?.notes) ? analysis!.analysis!.notes! : [];
  const snapshots = Array.isArray(analysis?.analysis?.focusSnapshots)
    ? analysis!.analysis!.focusSnapshots!
    : [];
  return {
    savedVideoId: text(row.savedVideoId, 160),
    title: text(row.title, 180) || "Swing video",
    sizeBytes: Number(row.sizeBytes) || 0,
    mimeType: text(row.mimeType, 80) || "video/mp4",
    durationSeconds: Number(row.durationSeconds) || null,
    createdAt: text(row.createdAt, 40),
    notes: notes
      .map((note, index) => ({
        id: text(note?.id, 120) || `note-${index}`,
        text: text(note?.text, 2000),
        time: seconds(note?.time),
      }))
      .filter((note) => note.text)
      // In the order they happen in the swing, which is the order the coach
      // said them and the order the player will scrub through.
      .sort((left, right) => left.time - right.time),
    screenshots: snapshots
      .map((snapshot, index) => ({
        id: text(snapshot?.id, 120) || `snapshot-${index}`,
        title: text(snapshot?.title, 180) || "Screenshot",
        note: text(snapshot?.note, 2000),
        currentTime: seconds(snapshot?.currentTime),
      }))
      .sort((left, right) => left.currentTime - right.currentTime),
  };
}

/**
 * When the review happened.
 *
 * The newest thing in it, because a review the coach came back to the next day
 * is a review from the next day. The id's own stamp is the fallback for a
 * review whose parts carry no dates at all.
 */
export function reviewAt(lessonId: string, dates: Array<string | undefined | null>): string {
  const newest = dates
    .map((value) => text(value, 40))
    .filter(Boolean)
    .sort()
    .at(-1);
  return newest || swingReviewStartedAt(lessonId);
}

/**
 * The email.
 *
 * text/plain only, and for the same reason the video emails are: the coach's
 * message is free text and a plaintext body has no injection surface. If an
 * HTML variant is ever added, the message and both names have to go through
 * escapeHtml first.
 *
 * Both ways in are offered, in this order. The link is first because it is the
 * one that works right now, on the phone the email was opened on, with nothing
 * to remember. The portal is second because it is the one that still works in a
 * year, and because a player who signs in once has everything rather than this
 * one review.
 */
export function reviewEmail(input: {
  playerName: string;
  coachName: string;
  coachMessage: string;
  shareUrl: string;
  portalUrl: string;
  expiresAt: string;
  videoCount: number;
  noteCount: number;
  practiceCount: number;
}): { subject: string; text: string } {
  const coach = text(input.coachName, 120);
  const subject = coach ? `${coach} sent you a swing review` : "Your swing review is ready";
  const parts: string[] = [];
  const firstName = text(input.playerName, 120).split(/\s+/)[0] || "";

  parts.push(firstName ? `Hi ${firstName},` : "Hi,");
  parts.push("");
  parts.push(
    coach
      ? `${coach} has finished a swing review for you.`
      : "Your coach has finished a swing review for you.",
  );

  const contents = [
    input.videoCount ? `${input.videoCount} video${input.videoCount === 1 ? "" : "s"}` : "",
    input.noteCount ? `${input.noteCount} note${input.noteCount === 1 ? "" : "s"}` : "",
    input.practiceCount
      ? `${input.practiceCount} practice block${input.practiceCount === 1 ? "" : "s"}`
      : "",
  ].filter(Boolean);
  if (contents.length) parts.push(`It has ${listSentence(contents)} in it.`);

  const message = text(input.coachMessage, 600);
  if (message) {
    parts.push("");
    parts.push(`Their note: ${message}`);
  }

  if (input.shareUrl) {
    parts.push("");
    parts.push("Watch it here — no sign-in needed:");
    parts.push(input.shareUrl);
    const expiry = expiryLabel(input.expiresAt);
    if (expiry) parts.push(`This link works until ${expiry}.`);
  }

  if (input.portalUrl) {
    parts.push("");
    parts.push(
      "Your player portal keeps every review, video and practice block for good — sign in any time:",
    );
    parts.push(input.portalUrl);
  }

  return { subject, text: parts.join("\n") };
}

function listSentence(items: string[]): string {
  if (items.length <= 1) return items[0] || "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function expiryLabel(value: string): string {
  const date = new Date(text(value, 40));
  if (Number.isNaN(date.getTime())) return "";
  return date.toDateString();
}
