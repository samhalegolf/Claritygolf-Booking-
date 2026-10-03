// The drill and exercise library.
//
// Every coach in the business sees every drill and can drop any of them into a
// review; only the coach who made a drill can change or delete it (the server
// enforces that -- `mine` here only decides which buttons to show).
//
// A drill is a video and some notes. The video is either a YouTube clip,
// cropped to the part that matters, or the coach's own recording, made in the
// analysis workspace and kept in Clarity Cloud so the rest of the team can use
// it too. Dropping one into a review copies it: the review's version can be
// re-worded and snapshotted without touching the library.

import { useEffect, useMemo, useState } from "react";
import { Clapperboard, Dumbbell, Pencil, Plus, Trash2, X, Youtube } from "lucide-react";
import { t } from "../../lib/i18n";
import {
  youtubeIdFrom,
  youtubeStartFrom,
  youtubeThumbnailUrl,
} from "../../../netlify/functions/_shared/review-document.mts";
import { deleteDrill, fetchDrills, saveDrill, type Drill, type DrillDraft } from "./reviewDocumentApi";
import { formatClock, parseClock } from "./clock";
import "./swingReview.css";

export type DrillLibraryProps = {
  /** Given, each drill offers "Add to review". Left out, the library is for managing. */
  onPick?: (drill: Drill) => void;
  onClose: () => void;
  /** The signed-in coach's name, stamped on drills they make. */
  authorName: string;
  /** Record or upload the video for a drill with its own video. The drill is
   *  saved first, so this always has an id to file the video under. */
  onRecordVideo: (drill: Drill) => void;
  /** A drill to open straight into its editor, e.g. after its video was saved. */
  initialEditId?: string;
};

type EditorState = { drill: Drill | null; kind: "youtube" | "own" };

function drillThumb(drill: Drill) {
  return drill.youtubeId ? youtubeThumbnailUrl(drill.youtubeId) : drill.thumbnailDataUrl;
}

export function DrillLibrary(props: DrillLibraryProps) {
  const [drills, setDrills] = useState<Drill[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchDrills()
      .then((list) => {
        if (cancelled) return;
        setDrills(list);
        const initial = props.initialEditId ? list.find((drill) => drill.id === props.initialEditId) : undefined;
        if (initial?.mine) setEditor({ drill: initial, kind: initial.youtubeId ? "youtube" : "own" });
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : t("Could not load the drill library."));
      });
    return () => {
      cancelled = true;
    };
    // initialEditId is read once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase();
    const list = drills || [];
    if (!words) return list;
    return list.filter((drill) => `${drill.title} ${drill.notes} ${drill.authorName}`.toLowerCase().includes(words));
  }, [drills, query]);

  async function remove(drill: Drill) {
    if (!window.confirm(t("Delete {title} from the library? Reviews it was added to keep their copy.", { title: drill.title }))) return;
    try {
      await deleteDrill(drill.id);
      setDrills((current) => (current || []).filter((entry) => entry.id !== drill.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("Could not delete this drill."));
    }
  }

  function saved(drill: Drill) {
    setDrills((current) => [drill, ...(current || []).filter((entry) => entry.id !== drill.id)]);
  }

  return (
    <div className="details-overlay" role="presentation" onPointerDown={props.onClose}>
      <aside
        className="details-panel details-modal drill-library-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("Drill library")}
        onPointerDown={(event) => event.stopPropagation()}
        style={{ width: "min(680px, calc(100vw - 32px))" }}
      >
        <div className="panel-header">
          <span>
            <Dumbbell size={16} /> {t("Drill library")}
          </span>
          <button className="icon-button small" onClick={props.onClose} aria-label={t("Close")} type="button">
            <X size={17} />
          </button>
        </div>

        {editor ? (
          <DrillEditor
            key={editor.drill?.id || "new"}
            state={editor}
            authorName={props.authorName}
            onCancel={() => setEditor(null)}
            onSaved={(drill) => {
              saved(drill);
              setEditor(null);
            }}
            onRecordVideo={(drill) => {
              saved(drill);
              props.onRecordVideo(drill);
            }}
          />
        ) : (
          <div className="drill-library">
            <div className="drill-library-top">
              <input
                type="search"
                value={query}
                placeholder={t("Search drills")}
                onChange={(event) => setQuery(event.target.value)}
                aria-label={t("Search drills")}
              />
              <button type="button" className="primary-button" onClick={() => setEditor({ drill: null, kind: "youtube" })}>
                <Plus size={15} />
                {t("New drill")}
              </button>
            </div>
            {error ? <p className="srs-warn">{error}</p> : null}
            {drills === null && !error ? <p className="drill-empty">{t("Loading drills…")}</p> : null}
            {drills !== null && !shown.length ? (
              <p className="drill-empty">
                {drills.length
                  ? t("No drills match that search.")
                  : t("No drills yet. Make one from a YouTube link or your own video, and the whole team can use it.")}
              </p>
            ) : null}
            <div className="drill-list">
              {shown.map((drill) => (
                <div className="drill-row" key={drill.id}>
                  <span className="drill-thumb">
                    {drillThumb(drill) ? <img src={drillThumb(drill)} alt="" loading="lazy" /> : <Dumbbell size={18} />}
                  </span>
                  <span className="drill-row-main">
                    <strong>{drill.title}</strong>
                    <span>
                      {drill.youtubeId ? t("YouTube") : drill.savedVideoId ? t("Own video") : t("Notes only")}
                      {drill.authorName ? ` · ${drill.authorName}` : ""}
                      {drill.notes ? ` · ${drill.notes}` : ""}
                    </span>
                  </span>
                  <span className="drill-row-actions">
                    {drill.mine ? (
                      <>
                        <button
                          type="button"
                          className="icon-button small"
                          onClick={() => setEditor({ drill, kind: drill.youtubeId ? "youtube" : "own" })}
                          aria-label={t("Edit {title}", { title: drill.title })}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          type="button"
                          className="icon-button small"
                          onClick={() => void remove(drill)}
                          aria-label={t("Delete {title}", { title: drill.title })}
                        >
                          <Trash2 size={14} />
                        </button>
                      </>
                    ) : null}
                    {props.onPick ? (
                      <button type="button" className="outline-button" onClick={() => props.onPick?.(drill)}>
                        <Plus size={14} />
                        {t("Add")}
                      </button>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}

function DrillEditor({
  state,
  authorName,
  onCancel,
  onSaved,
  onRecordVideo,
}: {
  state: EditorState;
  authorName: string;
  onCancel: () => void;
  onSaved: (drill: Drill) => void;
  onRecordVideo: (drill: Drill) => void;
}) {
  const original = state.drill;
  const [kind, setKind] = useState<"youtube" | "own">(state.kind);
  const [title, setTitle] = useState(original?.title || "");
  const [notes, setNotes] = useState(original?.notes || "");
  const [youtubeUrl, setYoutubeUrl] = useState(
    original?.youtubeId ? `https://youtu.be/${original.youtubeId}` : "",
  );
  const [start, setStart] = useState(original?.youtubeId && original.start ? formatClock(original.start) : "");
  const [end, setEnd] = useState(original?.youtubeId && original.end ? formatClock(original.end) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const youtubeId = youtubeIdFrom(youtubeUrl);

  function draft(): DrillDraft {
    const startSeconds = parseClock(start) ?? (youtubeId ? youtubeStartFrom(youtubeUrl) : 0);
    return {
      title: title.trim(),
      notes: notes.trim(),
      youtubeUrl: kind === "youtube" ? youtubeUrl : "",
      start: startSeconds,
      end: parseClock(end),
      // Switching a drill from its own video to YouTube drops the video: a
      // drill is one clip, and the server keeps whichever it is given.
      savedVideoId: kind === "own" ? original?.savedVideoId || "" : "",
      thumbnailDataUrl: kind === "own" ? original?.thumbnailDataUrl || "" : "",
      authorName,
    };
  }

  async function submit(thenRecord: boolean) {
    if (!title.trim()) return setError(t("Give the drill a name."));
    if (kind === "youtube" && youtubeUrl && !youtubeId) return setError(t("That does not look like a YouTube link."));
    setBusy(true);
    setError("");
    try {
      const drill = await saveDrill(draft(), original?.id);
      if (thenRecord) onRecordVideo(drill);
      else onSaved(drill);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("Could not save this drill."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="drill-editor">
      <h2>{original ? t("Edit drill") : t("New drill")}</h2>
      <label>
        {t("Name")}
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("e.g. Alignment stick gate")} />
      </label>

      <div className="drill-video-kind" role="radiogroup" aria-label={t("Drill video")}>
        <button
          type="button"
          role="radio"
          aria-checked={kind === "youtube"}
          className={kind === "youtube" ? "primary-button" : "outline-button"}
          onClick={() => setKind("youtube")}
        >
          <Youtube size={15} />
          {t("YouTube link")}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={kind === "own"}
          className={kind === "own" ? "primary-button" : "outline-button"}
          onClick={() => setKind("own")}
        >
          <Clapperboard size={15} />
          {t("Your own video")}
        </button>
      </div>

      {kind === "youtube" ? (
        <>
          <label>
            {t("YouTube link")}
            <input
              value={youtubeUrl}
              inputMode="url"
              placeholder="https://youtu.be/…"
              onChange={(event) => {
                setYoutubeUrl(event.target.value);
                const from = youtubeStartFrom(event.target.value);
                if (from && !start) setStart(formatClock(from));
              }}
            />
          </label>
          {youtubeId ? <img src={youtubeThumbnailUrl(youtubeId)} alt="" style={{ width: 200, borderRadius: 8 }} /> : null}
          <div className="srs-crop">
            <span>{t("Play from")}</span>
            <input className="srs-clock" value={start} placeholder="0:00" onChange={(event) => setStart(event.target.value)} aria-label={t("Play from")} />
            <span>{t("to")}</span>
            <input className="srs-clock" value={end} placeholder={t("end")} onChange={(event) => setEnd(event.target.value)} aria-label={t("Play to")} />
          </div>
        </>
      ) : (
        <p className="srs-hint">
          {original?.savedVideoId
            ? t("This drill has its own video. Record or upload again to replace it.")
            : t("Save, then record or upload the video in the analysis workspace. It is kept in Clarity Cloud so the whole team can use it.")}
        </p>
      )}

      <label>
        {t("Notes")}
        <textarea value={notes} rows={5} onChange={(event) => setNotes(event.target.value)} placeholder={t("How to do it, and what to feel")} />
      </label>

      {error ? <p className="srs-warn">{error}</p> : null}

      <div className="drill-editor-actions">
        <button type="button" className="outline-button" onClick={onCancel} disabled={busy}>
          {t("Cancel")}
        </button>
        {kind === "own" ? (
          <button type="button" className="primary-button" onClick={() => void submit(true)} disabled={busy}>
            <Clapperboard size={15} />
            {original?.savedVideoId ? t("Save and replace video") : t("Save and add video")}
          </button>
        ) : null}
        {kind === "youtube" || original?.savedVideoId ? (
          <button type="button" className={kind === "own" ? "outline-button" : "primary-button"} onClick={() => void submit(false)} disabled={busy}>
            {busy ? t("Saving…") : t("Save drill")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
