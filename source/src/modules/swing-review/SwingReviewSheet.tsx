// A swing review, laid out like the finished thing.
//
// Same idea as the invoice and email templates: the coach edits the page the
// player will read, not a form that produces it. A header (who it is from, who
// it is for, when), then the review itself as a column of blocks, with a +
// between every pair of blocks to put the next thing exactly where it goes.
//
// A new review is an empty page with one big +: start with a video, a note, a
// link or a drill, in whatever order the review wants to be read in. Starting
// with a video goes straight into the analysis workspace; when it is saved, the
// video comes back here with its snapshots and notes on it.
//
// Presentational: the page is handed its blocks and reports every edit back
// through onChange. Saving, opening the workspace and the drill library are
// the caller's.

import { useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  Clapperboard,
  Dumbbell,
  ExternalLink,
  ImageIcon,
  Link2,
  NotebookPen,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { t } from "../../lib/i18n";
import {
  cleanLinkUrl,
  youtubeEmbedUrl,
  type DrillMarker,
  type ReviewBlock,
  type ReviewBlockType,
  type ReviewDrillBlock,
} from "../../../netlify/functions/_shared/review-document.mts";
import { newBlockId } from "./reviewDocumentApi";
import { formatClock, parseClock } from "./clock";
import "./swingReview.css";

/** A saved video as the page shows it: the frame, and what the coach marked on it. */
export type SheetVideo = {
  savedVideoId: string;
  title: string;
  thumbnailDataUrl?: string;
  /** Seconds. Places the snapshot markers along the strip. */
  duration?: number;
  /** In Clarity Cloud and not on this device. */
  cloudOnly?: boolean;
  snapshots: Array<{ id: string; title: string; note?: string; currentTime: number; imageDataUrl?: string }>;
  notes: Array<{ id: string; text: string; time: number }>;
};

export type SwingReviewSheetProps = {
  businessName: string;
  logoUrl: string;
  coachName: string;
  playerName: string;
  /** ISO date the review is from. */
  reviewAt: string;
  title: string;
  blocks: ReviewBlock[];
  onChange: (next: { title: string; blocks: ReviewBlock[] }) => void;
  saveState: "idle" | "saving" | "saved" | "error";
  /** Every saved video the page might show, by id. */
  videos: Record<string, SheetVideo>;
  /** Lesson notes and practice filed under this review the old way. Shown,
   *  not edited: they live in the Notes and Practice tools. */
  sessionNotes: Array<{ id: string; label: string; text: string }>;
  practice: Array<{ id: string; title: string; content: string; meta: string }>;
  /** Record or pick a video; it lands at `index` once saved. */
  onAddVideo: (index: number) => void;
  /** Choose a drill from the library; it lands at `index`. */
  onAddDrill: (index: number) => void;
  onOpenVideo: (savedVideoId: string) => void;
  onOpenSnapshot: (savedVideoId: string, snapshotId: string) => void;
  /** Copy a drill's own video into this review and open it to trim and snapshot. */
  onMakeDrillCopy: (block: ReviewDrillBlock) => void;
  /** Send and share controls, at the foot of the page. */
  actions?: ReactNode;
};

const blockChoices = (): Array<{ type: ReviewBlockType; label: string; hint: string; icon: ReactNode }> => [
  { type: "video", label: t("Video"), hint: t("Record or pick a swing, then snapshot and mark it up"), icon: <Clapperboard size={18} /> },
  { type: "note", label: t("Note"), hint: t("A heading and what you want them to know"), icon: <NotebookPen size={18} /> },
  { type: "link", label: t("Link"), hint: t("A web page worth reading or watching"), icon: <Link2 size={18} /> },
  { type: "drill", label: t("Drill"), hint: t("From your drill library, yours to adapt"), icon: <Dumbbell size={18} /> },
];

function formatDay(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

export function SwingReviewSheet(props: SwingReviewSheetProps) {
  const { blocks, title } = props;
  const [menuAt, setMenuAt] = useState<number | null>(null);

  const update = (next: ReviewBlock[]) => props.onChange({ title, blocks: next });
  const replace = (block: ReviewBlock) => update(blocks.map((entry) => (entry.id === block.id ? block : entry)));

  function insert(type: ReviewBlockType, index: number) {
    setMenuAt(null);
    // Videos and drills come back from somewhere else -- the workspace, the
    // library -- and are placed when they arrive.
    if (type === "video") return props.onAddVideo(index);
    if (type === "drill") return props.onAddDrill(index);
    const block: ReviewBlock =
      type === "note"
        ? { id: newBlockId(), type: "note", title: "", body: "" }
        : { id: newBlockId(), type: "link", url: "", label: "" };
    update([...blocks.slice(0, index), block, ...blocks.slice(index)]);
  }

  function move(index: number, by: -1 | 1) {
    const target = index + by;
    if (target < 0 || target >= blocks.length) return;
    const next = [...blocks];
    [next[index], next[target]] = [next[target], next[index]];
    update(next);
  }

  function remove(block: ReviewBlock) {
    // A video block is only the page pointing at the video. Removing it keeps
    // the video, which stays in the player's library.
    update(blocks.filter((entry) => entry.id !== block.id));
  }

  const choices = (index: number) => (
    <div className="srs-choices" role="menu">
      {blockChoices().map((choice) => (
        <button key={choice.type} type="button" role="menuitem" className="srs-choice" onClick={() => insert(choice.type, index)}>
          {choice.icon}
          <span>
            <strong>{choice.label}</strong>
            <small>{choice.hint}</small>
          </span>
        </button>
      ))}
    </div>
  );

  const inserter = (index: number) =>
    menuAt === index ? (
      <div className="srs-insert is-open">
        {choices(index)}
        <button type="button" className="srs-insert-close" onClick={() => setMenuAt(null)} aria-label={t("Close")}>
          <X size={14} />
        </button>
      </div>
    ) : (
      <div className="srs-insert">
        <button type="button" className="srs-plus" onClick={() => setMenuAt(index)} aria-label={t("Add a block here")}>
          <Plus size={15} />
        </button>
      </div>
    );

  const day = formatDay(props.reviewAt);
  const from = props.coachName && props.businessName && props.coachName !== props.businessName
    ? `${props.coachName} · ${props.businessName}`
    : props.coachName || props.businessName;

  return (
    <div className="srs">
      <div className="srs-toolbar">
        <span className="srs-dashed-key">
          <span className="srs-dashed-swatch" />
          {t("Dashed is yours to write")}
        </span>
        <span className={`srs-save is-${props.saveState}`}>
          {props.saveState === "saving"
            ? t("Saving…")
            : props.saveState === "saved"
              ? t("Saved")
              : props.saveState === "error"
                ? t("Not saved — check your connection")
                : ""}
        </span>
      </div>

      <article className="srs-sheet">
        <header className="srs-head">
          <span className={`srs-logo${props.logoUrl ? "" : " is-empty"}`}>
            {props.logoUrl ? <img src={props.logoUrl} alt="" /> : <ImageIcon size={18} />}
          </span>
          <div className="srs-from">
            <span className="srs-eyebrow">{t("Swing review")}</span>
            {from ? <strong>{from}</strong> : null}
          </div>
          <div className="srs-meta">
            <strong>{props.playerName}</strong>
            {day ? <span>{day}</span> : null}
          </div>
        </header>

        <input
          className={`srs-title${title ? "" : " is-empty"}`}
          value={title}
          placeholder={t("Give this review a title")}
          onChange={(event) => props.onChange({ title: event.target.value, blocks })}
          aria-label={t("Review title")}
        />

        {blocks.length === 0 ? (
          <div className="srs-start">
            <span className="srs-start-plus">
              <Plus size={22} />
            </span>
            <p>{t("Choose where to start. You can keep adding blocks in any order.")}</p>
            {choices(0)}
          </div>
        ) : (
          <>
            {inserter(0)}
            {blocks.map((block, index) => (
              <div key={block.id}>
                <section className={`srs-block is-${block.type}`}>
                  <div className="srs-block-tools">
                    <button type="button" onClick={() => move(index, -1)} disabled={index === 0} aria-label={t("Move up")}>
                      <ArrowUp size={14} />
                    </button>
                    <button type="button" onClick={() => move(index, 1)} disabled={index === blocks.length - 1} aria-label={t("Move down")}>
                      <ArrowDown size={14} />
                    </button>
                    <button type="button" onClick={() => remove(block)} aria-label={t("Remove from the review")}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <BlockEditor block={block} onChange={replace} sheet={props} />
                </section>
                {inserter(index + 1)}
              </div>
            ))}
          </>
        )}

        {props.sessionNotes.length || props.practice.length ? (
          <section className="srs-session">
            <span className="srs-eyebrow">{t("Also from this session")}</span>
            {props.sessionNotes.map((note) => (
              <div className="srs-session-row" key={note.id}>
                <strong>{note.label}</strong>
                <p>{note.text}</p>
              </div>
            ))}
            {props.practice.map((block) => (
              <div className="srs-session-row is-practice" key={block.id}>
                <strong>{block.title}</strong>
                <p>{block.content}</p>
                {block.meta ? <span>{block.meta}</span> : null}
              </div>
            ))}
          </section>
        ) : null}

        {props.actions ? <footer className="srs-actions">{props.actions}</footer> : null}
      </article>
    </div>
  );
}

function BlockEditor({
  block,
  onChange,
  sheet,
}: {
  block: ReviewBlock;
  onChange: (block: ReviewBlock) => void;
  sheet: SwingReviewSheetProps;
}) {
  if (block.type === "note") {
    return (
      <>
        <input
          className={`srs-note-title${block.title ? "" : " is-empty"}`}
          value={block.title}
          placeholder={t("Heading")}
          onChange={(event) => onChange({ ...block, title: event.target.value })}
          aria-label={t("Note heading")}
        />
        <textarea
          className={`srs-note-body${block.body ? "" : " is-empty"}`}
          value={block.body}
          rows={Math.max(3, block.body.split("\n").length + 1)}
          placeholder={t("What you want them to know")}
          onChange={(event) => onChange({ ...block, body: event.target.value })}
          aria-label={t("Note")}
        />
      </>
    );
  }

  if (block.type === "link") {
    return <LinkEditor block={block} onChange={onChange} />;
  }

  if (block.type === "video") {
    const video = sheet.videos[block.savedVideoId];
    return video ? (
      <SheetVideoView video={video} sheet={sheet} />
    ) : (
      <p className="srs-missing">{t("This video is not on this device or in Clarity Cloud yet.")}</p>
    );
  }

  return <DrillEditor block={block} onChange={onChange} sheet={sheet} />;
}

function LinkEditor({
  block,
  onChange,
}: {
  block: Extract<ReviewBlock, { type: "link" }>;
  onChange: (block: ReviewBlock) => void;
}) {
  // Typed as written, cleaned on the way out, so a half-typed address is not
  // rewritten under the coach's cursor.
  const [typed, setTyped] = useState(block.url);
  const clean = cleanLinkUrl(typed);
  return (
    <div className="srs-link">
      <input
        className={`srs-note-title${block.label ? "" : " is-empty"}`}
        value={block.label}
        placeholder={t("What it is")}
        onChange={(event) => onChange({ ...block, label: event.target.value })}
        aria-label={t("Link label")}
      />
      <input
        className={`srs-link-url${typed ? "" : " is-empty"}`}
        value={typed}
        inputMode="url"
        placeholder={t("Paste a web address")}
        onChange={(event) => {
          setTyped(event.target.value);
          onChange({ ...block, url: cleanLinkUrl(event.target.value) });
        }}
        aria-label={t("Web address")}
      />
      {typed && !clean ? <small className="srs-warn">{t("That does not look like a web address.")}</small> : null}
      {clean ? (
        <a className="srs-link-open" href={clean} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={13} />
          {new URL(clean).hostname}
        </a>
      ) : null}
    </div>
  );
}

/** The video as the player will meet it: the frame, a strip with a marker at
 *  every snapshot, the snapshots themselves, then the timestamped notes. */
function SheetVideoView({ video, sheet }: { video: SheetVideo; sheet: SwingReviewSheetProps }) {
  const duration =
    video.duration ||
    Math.max(1, ...video.snapshots.map((shot) => shot.currentTime), ...video.notes.map((note) => note.time)) + 0.5;
  return (
    <div className="srs-video">
      <button type="button" className="srs-video-frame" onClick={() => sheet.onOpenVideo(video.savedVideoId)}>
        {video.thumbnailDataUrl ? <img src={video.thumbnailDataUrl} alt="" /> : <Clapperboard size={26} />}
        <span className="srs-video-open">{t("Open in analysis")}</span>
      </button>
      <strong className="srs-video-title">{video.title}</strong>
      {video.snapshots.length || video.notes.length ? (
        <div className="srs-markers" aria-label={t("Snapshot markers")}>
          {video.notes.map((note) => (
            <span
              key={`n-${note.id}`}
              className="srs-marker is-note"
              style={{ left: `${Math.min(100, (note.time / duration) * 100)}%` }}
              title={`${formatClock(note.time)} ${note.text}`}
            />
          ))}
          {video.snapshots.map((shot) => (
            <button
              key={`s-${shot.id}`}
              type="button"
              className="srs-marker"
              style={{ left: `${Math.min(100, (shot.currentTime / duration) * 100)}%` }}
              onClick={() => sheet.onOpenSnapshot(video.savedVideoId, shot.id)}
              aria-label={t("Show {title} in the video", { title: shot.title })}
              title={`${formatClock(shot.currentTime)} ${shot.title}`}
            />
          ))}
        </div>
      ) : (
        <small className="srs-hint">{t("No snapshots yet — open it in analysis to add some.")}</small>
      )}
      {video.snapshots.length ? (
        <div className="srs-shots">
          {[...video.snapshots]
            .sort((left, right) => left.currentTime - right.currentTime)
            .map((shot) => (
              <button
                key={shot.id}
                type="button"
                className="srs-shot"
                onClick={() => sheet.onOpenSnapshot(video.savedVideoId, shot.id)}
              >
                {shot.imageDataUrl ? <img src={shot.imageDataUrl} alt="" /> : <span className="srs-shot-blank"><ImageIcon size={16} /></span>}
                <span>
                  <em>{formatClock(shot.currentTime)}</em> <strong>{shot.title}</strong>
                </span>
                {shot.note ? <small>{shot.note}</small> : null}
              </button>
            ))}
        </div>
      ) : null}
      {video.notes.length ? (
        <ul className="srs-moments">
          {[...video.notes]
            .sort((left, right) => left.time - right.time)
            .map((note) => (
              <li key={note.id}>
                <em>{formatClock(note.time)}</em>
                <span>{note.text}</span>
              </li>
            ))}
        </ul>
      ) : null}
    </div>
  );
}

function DrillEditor({
  block,
  onChange,
  sheet,
}: {
  block: ReviewDrillBlock;
  onChange: (block: ReviewBlock) => void;
  sheet: SwingReviewSheetProps;
}) {
  const video = block.savedVideoId ? sheet.videos[block.savedVideoId] : undefined;
  return (
    <div className="srs-drill">
      <span className="srs-eyebrow">
        <Dumbbell size={13} /> {t("Drill")}
      </span>
      <input
        className={`srs-note-title${block.title ? "" : " is-empty"}`}
        value={block.title}
        placeholder={t("Drill name")}
        onChange={(event) => onChange({ ...block, title: event.target.value })}
        aria-label={t("Drill name")}
      />

      {block.youtubeId ? (
        <YoutubeDrillEditor block={block} onChange={onChange} />
      ) : video ? (
        <SheetVideoView video={video} sheet={sheet} />
      ) : block.savedVideoId ? (
        <p className="srs-missing">{t("This video is not on this device or in Clarity Cloud yet.")}</p>
      ) : block.drillId ? (
        <button type="button" className="srs-make-copy" onClick={() => sheet.onMakeDrillCopy(block)}>
          <Clapperboard size={16} />
          <span>
            <strong>{t("Open the drill video")}</strong>
            <small>{t("Add your own snapshots and notes. Your copy saves into this review; the library drill stays as it is.")}</small>
          </span>
        </button>
      ) : null}

      <textarea
        className={`srs-note-body${block.notes ? "" : " is-empty"}`}
        value={block.notes}
        rows={Math.max(3, block.notes.split("\n").length + 1)}
        placeholder={t("How to do it, and what to feel")}
        onChange={(event) => onChange({ ...block, notes: event.target.value })}
        aria-label={t("Drill notes")}
      />
    </div>
  );
}

function ClockInput({
  value,
  onChange,
  label,
  placeholder,
}: {
  value: number | null;
  onChange: (seconds: number | null) => void;
  label: string;
  placeholder: string;
}) {
  const [typed, setTyped] = useState(value === null ? "" : formatClock(value));
  return (
    <input
      className="srs-clock"
      value={typed}
      placeholder={placeholder}
      inputMode="numeric"
      aria-label={label}
      onChange={(event) => setTyped(event.target.value)}
      onBlur={() => {
        const seconds = parseClock(typed);
        onChange(seconds);
        setTyped(seconds === null ? "" : formatClock(seconds));
      }}
    />
  );
}

/** A YouTube drill: the clip cropped to the part that matters, and notes
 *  pinned to moments in it. YouTube does not let a page take a picture of a
 *  frame, so a marker here is a time and a sentence rather than a snapshot. */
function YoutubeDrillEditor({
  block,
  onChange,
}: {
  block: ReviewDrillBlock;
  onChange: (block: ReviewBlock) => void;
}) {
  const [markerTime, setMarkerTime] = useState("");
  const [markerNote, setMarkerNote] = useState("");

  function addMarker() {
    const time = parseClock(markerTime);
    if (time === null || !markerNote.trim()) return;
    const marker: DrillMarker = { id: newBlockId(), time, note: markerNote.trim() };
    onChange({ ...block, markers: [...block.markers, marker].sort((left, right) => left.time - right.time) });
    setMarkerTime("");
    setMarkerNote("");
  }

  return (
    <div className="srs-youtube">
      <div className="srs-embed">
        <iframe
          src={youtubeEmbedUrl(block.youtubeId, block.start, block.end)}
          title={block.title || t("Drill video")}
          allow="encrypted-media; picture-in-picture; fullscreen"
          referrerPolicy="strict-origin-when-cross-origin"
          loading="lazy"
        />
      </div>
      <div className="srs-crop">
        <span>{t("Play from")}</span>
        <ClockInput
          value={block.start || 0}
          placeholder="0:00"
          label={t("Play from")}
          onChange={(seconds) => onChange({ ...block, start: seconds ?? 0 })}
        />
        <span>{t("to")}</span>
        <ClockInput
          value={block.end}
          placeholder={t("end")}
          label={t("Play to")}
          onChange={(seconds) => onChange({ ...block, end: seconds && seconds > block.start ? seconds : null })}
        />
      </div>
      {block.markers.length ? (
        <ul className="srs-moments">
          {block.markers.map((marker) => (
            <li key={marker.id}>
              <em>{formatClock(marker.time)}</em>
              <span>{marker.note}</span>
              <button
                type="button"
                className="srs-moment-remove"
                onClick={() => onChange({ ...block, markers: block.markers.filter((entry) => entry.id !== marker.id) })}
                aria-label={t("Remove")}
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="srs-marker-add">
        <input
          className="srs-clock"
          value={markerTime}
          placeholder="0:00"
          inputMode="numeric"
          onChange={(event) => setMarkerTime(event.target.value)}
          aria-label={t("Marker time")}
        />
        <input
          value={markerNote}
          placeholder={t("A note at this moment")}
          onChange={(event) => setMarkerNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") addMarker();
          }}
          aria-label={t("Marker note")}
        />
        <button type="button" className="outline-button" onClick={addMarker} disabled={!markerNote.trim() || parseClock(markerTime) === null}>
          <Plus size={14} />
          {t("Marker")}
        </button>
      </div>
    </div>
  );
}
