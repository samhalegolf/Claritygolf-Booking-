// A sent review's page, read-only, as the player meets it -- on the emailed
// link and in their portal. Each host draws its own videos (they stream from
// different places), so a video arrives here as a render function; everything
// else on the page looks the same wherever it is read.

import type { ReactNode } from "react";
import { Dumbbell, ExternalLink } from "lucide-react";
import { t } from "../../lib/i18n";
import {
  visibleReviewBlocks,
  youtubeEmbedUrl,
  type ReviewBlock,
} from "../../../netlify/functions/_shared/review-document.mts";
import { formatClock } from "./clock";
import "./reviewBlocks.css";

export type ReviewBlocksViewProps = {
  blocks: ReviewBlock[];
  /** Draws one saved video, or null when this reader cannot reach it. */
  renderVideo: (savedVideoId: string) => ReactNode;
};

export function ReviewBlocksView({ blocks, renderVideo }: ReviewBlocksViewProps) {
  return (
    <>
      {visibleReviewBlocks(blocks).map((block) => {
        if (block.type === "video") {
          const video = renderVideo(block.savedVideoId);
          return video ? <div key={block.id}>{video}</div> : null;
        }
        if (block.type === "note") {
          return (
            <section className="rbv-card" key={block.id}>
              {block.title ? <strong>{block.title}</strong> : null}
              {block.body ? <p className="rbv-text">{block.body}</p> : null}
            </section>
          );
        }
        if (block.type === "link") {
          let host = "";
          try {
            host = new URL(block.url).hostname;
          } catch {
            return null;
          }
          return (
            <a className="rbv-card rbv-link" key={block.id} href={block.url} target="_blank" rel="noopener noreferrer">
              <strong>{block.label || host}</strong>
              <span>
                <ExternalLink size={13} /> {host}
              </span>
            </a>
          );
        }
        const video = block.savedVideoId ? renderVideo(block.savedVideoId) : null;
        return (
          <section className="rbv-card rbv-drill" key={block.id}>
            <span className="rbv-eyebrow">
              <Dumbbell size={13} /> {t("Drill")}
            </span>
            {block.title ? <strong>{block.title}</strong> : null}
            {block.youtubeId ? (
              <div className="rbv-embed">
                <iframe
                  src={youtubeEmbedUrl(block.youtubeId, block.start, block.end)}
                  title={block.title || t("Drill video")}
                  allow="encrypted-media; picture-in-picture; fullscreen"
                  referrerPolicy="strict-origin-when-cross-origin"
                  allowFullScreen
                  loading="lazy"
                />
              </div>
            ) : (
              video
            )}
            {block.markers.length ? (
              <ul className="rbv-moments">
                {block.markers.map((marker) => (
                  <li key={marker.id}>
                    <em>{formatClock(marker.time)}</em>
                    <span>{marker.note}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {block.notes ? <p className="rbv-text">{block.notes}</p> : null}
          </section>
        );
      })}
    </>
  );
}
