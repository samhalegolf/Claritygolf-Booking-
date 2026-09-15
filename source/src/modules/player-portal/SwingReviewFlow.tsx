// Asking for a swing review, in two screens.
//
// The split is the point. The first screen is about the swing -- pick the
// video, say what you want looked at -- and the second is about paying for it.
// Putting the price on the first screen turns "show my coach this" into a
// purchase decision before the player has finished having the thought.
//
// Either half of the first screen is enough on its own. A video with no words
// is the common case ("look at this"), and words with no video is a real
// question a coach can answer from what they already know. Demanding both
// turns the second kind of request into no request at all.
//
// Nothing here decides what a credit may pay for. The server sends the passes
// that cover a review and whether a card can be taken at all; this screen only
// renders the answer.

import { useState } from "react";

import { formatDate } from "./format";
import type { SavedVideoItem } from "../video-analysis/utils/savedVideoLibrary";

export type ReviewPassOption = {
  passId: string;
  name: string;
  creditsAvailable: number;
  expiresAt: string | null;
};

export type ReviewOffer = {
  serviceId: string;
  name: string;
  price: number;
  currency: string;
  turnaroundDays: number;
  passOptions: ReviewPassOption[];
  canBuy: boolean;
};

export type SwingReviewDraft = { notes: string; savedVideoId: string };

export type SwingReviewFlowProps = {
  review: ReviewOffer;
  /** What is already on this device, to send without filming again. */
  savedVideos: SavedVideoItem[];
  busy: boolean;
  error: string;
  /** Opens the camera / library sheet. The portal owns that, not this screen. */
  onRecord: () => void;
  onRedeem: (draft: SwingReviewDraft, passId: string) => void;
  onBuy: (draft: SwingReviewDraft) => void;
  onCancel: () => void;
};

export function SwingReviewFlow({
  review,
  savedVideos,
  busy,
  error,
  onRecord,
  onRedeem,
  onBuy,
  onCancel,
}: SwingReviewFlowProps) {
  const [step, setStep] = useState<"compose" | "pay">("compose");
  const [notes, setNotes] = useState("");
  const [savedVideoId, setSavedVideoId] = useState("");

  const draft: SwingReviewDraft = { notes: notes.trim(), savedVideoId };
  const hasSomething = Boolean(draft.savedVideoId) || draft.notes.length > 0;
  const credit = review.passOptions[0] || null;
  const chosenVideo = savedVideos.find((video) => video.savedVideoId === savedVideoId) || null;

  if (step === "pay") {
    return (
      <section className="player-portal-section swing-review-flow">
        <h2>Send it</h2>
        <p className="player-portal-lead">
          {review.name} — back with you within {review.turnaroundDays} day
          {review.turnaroundDays === 1 ? "" : "s"}.
        </p>

        <div className="swing-review-summary">
          <span>{chosenVideo ? chosenVideo.title : "No video"}</span>
          <span>{draft.notes ? `"${draft.notes.slice(0, 90)}${draft.notes.length > 90 ? "…" : ""}"` : "No note"}</span>
        </div>

        {error && (
          <p className="player-portal-error-line" role="alert">
            {error}
          </p>
        )}

        {/* A credit they already hold is always the offer. Showing a price
            beside it would invite paying twice for the same thing. */}
        {credit ? (
          <>
            <button
              className="player-portal-primary"
              type="button"
              disabled={busy}
              onClick={() => onRedeem(draft, credit.passId)}
            >
              {busy ? "Sending…" : "Use a credit"}
            </button>
            <p className="player-portal-empty">
              {credit.name} — {credit.creditsAvailable} left
              {credit.expiresAt && formatDate(credit.expiresAt)
                ? `, use by ${formatDate(credit.expiresAt)}`
                : ""}
            </p>
          </>
        ) : review.canBuy ? (
          <>
            <button
              className="player-portal-primary"
              type="button"
              disabled={busy}
              onClick={() => onBuy(draft)}
            >
              {busy ? "Opening…" : `Pay ${review.currency} ${review.price.toFixed(2)}`}
            </button>
            <p className="player-portal-empty">
              Card payment. Your note and video are kept while you pay.
            </p>
          </>
        ) : (
          <p className="player-portal-empty">
            You have no review credits left, and card payments are not set up. Ask your coach.
          </p>
        )}

        <button className="player-portal-ghost" type="button" disabled={busy} onClick={() => setStep("compose")}>
          Back
        </button>
      </section>
    );
  }

  return (
    <section className="player-portal-section swing-review-flow">
      <h2>New swing review</h2>
      <p className="player-portal-lead">
        Send a swing, a question, or both. Your coach marks it up and sends it back.
      </p>

      {/* Videos already on the phone come first: the usual case is a swing
          filmed minutes ago, and making them film it again to send it is the
          fastest way to have it not sent. */}
      {savedVideos.length > 0 && (
        <div className="swing-review-picker">
          {savedVideos.slice(0, 12).map((video) => (
            <button
              type="button"
              key={video.savedVideoId}
              className={`swing-review-pick${video.savedVideoId === savedVideoId ? " is-chosen" : ""}`}
              aria-pressed={video.savedVideoId === savedVideoId}
              onClick={() =>
                setSavedVideoId((current) =>
                  current === video.savedVideoId ? "" : video.savedVideoId,
                )
              }
            >
              {video.thumbnailDataUrl ? (
                <img src={video.thumbnailDataUrl} alt="" />
              ) : (
                <span className="swing-review-pick-blank" />
              )}
              <small>{video.title}</small>
            </button>
          ))}
        </div>
      )}

      <button className="player-portal-ghost" type="button" onClick={onRecord}>
        {savedVideos.length ? "Film a new one" : "Film or upload a swing"}
      </button>

      <label className="player-portal-field">
        <span>What would you like looked at?</span>
        <textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          rows={4}
          placeholder="Anything in particular — a shot shape, a feeling, a hole you keep losing."
        />
      </label>

      {error && (
        <p className="player-portal-error-line" role="alert">
          {error}
        </p>
      )}

      <div className="player-portal-note-form-actions">
        <button className="player-portal-ghost" type="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="player-portal-primary"
          type="button"
          disabled={!hasSomething}
          onClick={() => setStep("pay")}
        >
          Continue
        </button>
      </div>
      {!hasSomething && (
        <p className="player-portal-empty">Pick a video, write a note, or both.</p>
      )}
    </section>
  );
}

export default SwingReviewFlow;
