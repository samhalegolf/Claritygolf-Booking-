/**
 * A swing review, held while the player is away paying for it.
 *
 * Buying a review sends them to Stripe, which means leaving the page. The note
 * they typed and the video they picked have to still be here when they come
 * back, and there is nowhere else to put them: the request has not been made
 * yet, so the server has nothing to hold.
 *
 * Losing it is survivable by design. The purchase gives them a credit whatever
 * happens, so a lost draft costs the typing, not the money -- they come back to
 * a credit they can spend on a new review. That is why this is allowed to be
 * localStorage and is not worth a server round trip.
 */

const KEY = "clarity.player.reviewDraft.v1";

export type StoredReviewDraft = {
  notes: string;
  savedVideoId: string;
  /** When it was stashed, so a forgotten one does not resurface next month. */
  at: number;
};

/** Long enough for a card payment and a bad connection, short enough that a
 *  draft abandoned days ago does not reappear attached to a new purchase. */
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

export function stashReviewDraft(draft: { notes: string; savedVideoId: string }) {
  try {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ ...draft, at: Date.now() } satisfies StoredReviewDraft),
    );
  } catch {
    // Private windows and cleared site data both throw. The purchase still
    // works; they retype the note.
  }
}

export function takeReviewDraft(): StoredReviewDraft | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    // Read once. Whatever happens next, this draft has been spent -- leaving it
    // behind is how one note ends up attached to two reviews.
    window.localStorage.removeItem(KEY);
    const parsed = JSON.parse(raw) as Partial<StoredReviewDraft>;
    const at = Number(parsed?.at) || 0;
    if (!at || Date.now() - at > MAX_AGE_MS) return null;
    const notes = typeof parsed.notes === "string" ? parsed.notes : "";
    const savedVideoId = typeof parsed.savedVideoId === "string" ? parsed.savedVideoId : "";
    if (!notes && !savedVideoId) return null;
    return { notes, savedVideoId, at };
  } catch {
    return null;
  }
}

export function clearReviewDraft() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to do, and nothing depends on it having worked.
  }
}
