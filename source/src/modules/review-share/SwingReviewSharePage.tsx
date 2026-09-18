import { Loading } from "../shared/Loading";
import { useEffect, useState } from "react";

import { reviewShareToken } from "../shared/bookingHandoff";

// The player's view of a swing review their coach sent them.
//
// Genuinely no-login, on the same terms as the coach's guest-video page: the
// token in the URL is the whole credential, so forwarding the email forwards
// the review. That is a deliberate trade, bounded by the link expiring and by
// there being exactly one review behind it -- and it is the right trade here,
// because the alternative is a player who has never signed in being asked to
// remember a password before they can watch what was made for them.
//
// The email offers this page and the portal together. This page says so again
// at the bottom rather than pretending it is the only way in: the portal keeps
// every review for good, and this link does not.
//
// Styling is the existing .login-shell / .login-card pair from styles.css, the
// same shell VideoSharePage uses, so this needs no stylesheet of its own.

type ReviewVideo = {
  savedVideoId: string;
  title: string;
  sizeBytes: number;
  mimeType: string;
  durationSeconds: number | null;
  createdAt: string;
  notes: Array<{ id: string; text: string; time: number }>;
  screenshots: Array<{ id: string; title: string; note: string; currentTime: number }>;
};

type ReviewResponse = {
  ok?: boolean;
  review?: {
    playerName: string;
    coachName: string;
    businessName: string;
    reviewAt: string;
    coachMessage: string;
    expiresAt: string;
    videos: ReviewVideo[];
    notes: Array<{ id: string; title: string; body: string; createdAt: string }>;
    practice: Array<{ id: string; title: string; content: string; dose: string; status: string }>;
  };
};

const reviewUrl = (token: string, path = "") =>
  `/api/video-transfer/review/share/${encodeURIComponent(token)}${path}`;

const videoUrl = (token: string, savedVideoId: string) =>
  reviewUrl(token, `/video/${encodeURIComponent(savedVideoId)}`);

function formatClock(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function formatDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/* The page is one column of cards on every width. A swing review is read top to
 * bottom -- video, what the coach said about it, then the next video -- and the
 * phone in a car park is the screen it is actually opened on. */
const cardStyle: React.CSSProperties = {
  border: "1px solid var(--c-border)",
  borderRadius: 12,
  padding: 14,
  display: "grid",
  gap: 10,
};

const noteStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto 1fr",
  gap: 10,
  alignItems: "baseline",
};

/* .primary-button is shaped for a <button>; on an <a> the browser adds its own
   underline on top of a filled pill, which reads as a broken link rather than a
   button. */
const linkButtonStyle: React.CSSProperties = { textDecoration: "none" };

const stampStyle: React.CSSProperties = {
  fontVariantNumeric: "tabular-nums",
  opacity: 0.65,
  fontSize: "0.85em",
};

export default function SwingReviewSharePage() {
  const [token] = useState(reviewShareToken);
  const [state, setState] = useState<"loading" | "ready" | "gone">("loading");
  const [review, setReview] = useState<ReviewResponse["review"] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(reviewUrl(token), { cache: "no-store" });
        if (!response.ok) throw new Error("gone");
        const data = (await response.json()) as ReviewResponse;
        if (cancelled) return;
        if (!data.review) throw new Error("gone");
        setReview(data.review);
        setState("ready");
      } catch {
        if (!cancelled) setState("gone");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state === "loading") return <Loading size="screen" what="your review" />;

  // One message for expired, revoked, wrong and never-existed alike -- the
  // server does not distinguish them either, and neither should this.
  if (state === "gone" || !review) {
    return (
      <main className="login-shell">
        <div className="login-card">
          <h1>This link has expired</h1>
          <p>
            Review links are good for a limited time. Your player portal keeps every review for
            good — sign in there, or ask your coach to send it again.
          </p>
          <a className="primary-button" href="/" style={linkButtonStyle}>
            Go to your portal
          </a>
        </div>
      </main>
    );
  }

  const sentBy = review.coachName || review.businessName;

  return (
    <main className="login-shell">
      <div className="login-card" style={{ display: "grid", gap: 18, maxWidth: 640 }}>
        <div>
          <p className="eyebrow">Swing review</p>
          <h1>{review.playerName ? `${review.playerName}'s swing review` : "Your swing review"}</h1>
          <p>
            {sentBy ? `From ${sentBy}.` : ""}
            {formatDate(review.reviewAt) ? ` ${formatDate(review.reviewAt)}.` : ""}
          </p>
        </div>

        {review.coachMessage && (
          <div style={cardStyle}>
            <strong>A note from your coach</strong>
            <p style={{ margin: 0 }}>{review.coachMessage}</p>
          </div>
        )}

        {review.videos.map((video) => (
          <section key={video.savedVideoId} style={cardStyle}>
            <strong>{video.title}</strong>
            {/* preload="metadata" rather than "auto": these are phone-recorded
             *  swings of 20-150 MB and a review can hold three of them. The
             *  <video> element issues its own Range requests once played. */}
            <video
              controls
              playsInline
              preload="metadata"
              src={videoUrl(token, video.savedVideoId)}
              style={{ width: "100%", borderRadius: 9, background: "#000" }}
            />
            {(() => {
              /* One timeline, not two lists.
               *
               * A typed note and a screenshot caption are the same thing to the
               * player -- something the coach said about a moment in this swing
               * -- and they arrive as separate arrays. Rendering them as
               * separate blocks made the timestamps run 0:01, 0:04, then 0:03,
               * 0:06 down the page, which reads as a bug rather than as two
               * kinds of note. Merged and sorted, they read as the commentary
               * they are, and each stamp says where to scrub the video above.
               *
               * Screenshots keep their title in bold: their picture is stripped
               * on upload, so the title is all that is left of the frame. */
              const moments = [
                ...video.notes.map((note) => ({
                  key: `note-${note.id}`,
                  time: note.time,
                  title: "",
                  text: note.text,
                })),
                ...video.screenshots.map((snapshot) => ({
                  key: `snapshot-${snapshot.id}`,
                  time: snapshot.currentTime,
                  title: snapshot.title,
                  text: snapshot.note,
                })),
              ].sort((left, right) => left.time - right.time);
              if (!moments.length) return null;
              return (
                <div style={{ display: "grid", gap: 8 }}>
                  {moments.map((moment) => (
                    <div key={moment.key} style={noteStyle}>
                      <span style={stampStyle}>{formatClock(moment.time)}</span>
                      <span>
                        {moment.title ? <strong>{moment.title}</strong> : null}
                        {moment.title && moment.text ? " — " : ""}
                        {moment.text}
                      </span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </section>
        ))}

        {review.notes.map((note) => (
          <section key={note.id} style={cardStyle}>
            <strong>{note.title}</strong>
            <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{note.body}</p>
          </section>
        ))}

        {review.practice.length > 0 && (
          <section style={cardStyle}>
            <strong>Practice from this review</strong>
            {review.practice.map((block) => (
              <div key={block.id}>
                <strong>{block.title}</strong>
                {block.content && <p style={{ margin: "4px 0 0" }}>{block.content}</p>}
                {block.dose && <p style={{ margin: "4px 0 0", opacity: 0.7 }}>{block.dose}</p>}
              </div>
            ))}
          </section>
        )}

        <div>
          <a className="primary-button" href="/" style={linkButtonStyle}>
            Sign in to your player portal
          </a>
          <p style={{ marginTop: 10 }}>
            Your portal keeps every review, video and practice block for good, and it is where you
            send your own swings in.
            {formatDate(review.expiresAt) ? ` This link stops working on ${formatDate(review.expiresAt)}.` : ""}
          </p>
        </div>
      </div>
    </main>
  );
}
