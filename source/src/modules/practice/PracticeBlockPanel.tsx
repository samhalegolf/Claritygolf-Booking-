import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import "./practice.css";
import { apiFetch } from "../auth/apiFetch";
import { listClarityCloudImportTransfers, type ClarityCloudImportTransfer } from "../video-analysis/utils/savedVideoLibrary";
import { PracticeBlockBuilder } from "./PracticeBlockBuilder";
import { PracticeWall } from "./PracticeWall";
import {
  practiceBlockMeta,
  practiceExpiryLabel,
  practiceOfferedTypes,
  practiceSteps,
  practiceTypeHasField,
  practiceTypeList,
  practiceTypeMeta,
  type PracticeBlock,
  type PracticePreset,
  type PracticeSuggestion,
  type PracticeTypeMeta,
} from "./practiceModel";
import {
  cachedPractice,
  clearPracticeDraft,
  emptyPracticeDraft,
  invalidatePractice,
  loadPractice,
  practiceDraftContent,
  practiceDraftFromBlock,
  practiceDraftIsWritten,
  readPracticeDraft,
  writePracticeDraft,
  type PracticeDraft,
} from "./practiceStore";

/* The coach's end of Practice. Owns its own loading, its own writes. The
 * console only tells it which player is open.
 *
 * Two halves, and the order matters: the composer is at the top because the
 * reason a coach opens this tab is nearly always to assign something, and the
 * wall is underneath because what this player has already been given is the
 * context for what to give them next. Nothing is behind a "+ New block"
 * button -- a form that is already open is one fewer click on the only action
 * anybody comes here for.
 *
 * A block is: what kind of work it is, what to do (a title and numbered
 * steps), how much of it (the dose), when it stops mattering (expiry), and
 * optionally a video showing what "it" looks like.
 */

export type PracticeBlockPanelProps = {
  player: { id: string; name: string };
  /** Called on a 401 so the app can drop back to its signed-out state. */
  onUnauthorized: () => void;
  onToast: (message: string) => void;
};

const STATUS_LABEL: Record<PracticeBlock["status"], string> = {
  active: "Active",
  completed: "Completed",
  expired: "Expired",
  archived: "Archived",
};

export function PracticeBlockPanel({ player, onUnauthorized, onToast }: PracticeBlockPanelProps) {
  const playerId = player.id;
  const playerName = player.name;

  /* The console re-renders on a timer (a notification poll, a clock), and
   * hands this panel fresh prop identities each time -- new callbacks, a new
   * `player` object. None of that is a change to *which* player is open, so
   * none of it may restart a fetch: an effect keyed on those identities
   * refires every few seconds, and each refire used to blank the composer
   * mid-sentence. The callbacks are held by reference and everything below
   * keys on the player's id alone.
   */
  const handlers = useRef({ onUnauthorized, onToast });
  useEffect(() => {
    handlers.current = { onUnauthorized, onToast };
  });

  /* Whatever the profile's own prefetch already got. Opening Practice from a
   * player whose profile has been on screen for a moment therefore paints
   * fully-formed, and the read below only revalidates. */
  const seed = cachedPractice(playerId);

  const [blocks, setBlocks] = useState<PracticeBlock[]>(seed?.blocks || []);
  const [firstLoad, setFirstLoad] = useState(!seed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");

  const [presets, setPresets] = useState<PracticePreset[]>(seed?.presets || []);
  const [suggestions, setSuggestions] = useState<PracticeSuggestion[]>(seed?.suggestions || []);
  const [storedTypes, setStoredTypes] = useState<PracticeTypeMeta[]>(seed?.blockTypes || []);

  const types = useMemo(() => practiceTypeList(storedTypes), [storedTypes]);
  const offeredTypes = useMemo(() => practiceOfferedTypes(types), [types]);

  /* The composer survives the panel being unmounted -- which happens more
   * often than it looks, since the console re-derives the client this panel
   * hangs off and a blink in that list takes it down and back up. */
  const [draft, setDraft] = useState<PracticeDraft>(
    () => readPracticeDraft(playerId) || emptyPracticeDraft(seed?.blockTypes?.[0]?.id || "drill"),
  );
  useEffect(() => {
    writePracticeDraft(playerId, draft);
  }, [draft, playerId]);

  const [openBrickId, setOpenBrickId] = useState<string | null>(null);

  const [videoPickerOpen, setVideoPickerOpen] = useState(false);
  const [videoOptions, setVideoOptions] = useState<ClarityCloudImportTransfer[]>([]);
  const [videoLoading, setVideoLoading] = useState(false);

  const request = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const response = await apiFetch(path, init);
      if (response.status === 401) {
        handlers.current.onUnauthorized();
        throw new Error("Admin login required");
      }
      const data = (await response.json().catch(() => ({}))) as {
        message?: string;
        block?: PracticeBlock;
        blocks?: PracticeBlock[];
        preset?: PracticePreset;
        presets?: PracticePreset[];
        suggestions?: PracticeSuggestion[];
        warning?: string;
      };
      if (!response.ok) throw new Error(data?.message || "Practice request failed.");
      return data;
    },
    [],
  );

  /* Reads that overtake each other. A save triggers a reload while an earlier
   * one may still be in flight, and a rename triggers another on top of that
   * -- the slower response must not win just because it landed last. Each read
   * claims a number and only writes if it is still the newest. */
  const readToken = useRef(0);

  /**
   * One read, through the store, so it is shared with whatever the profile
   * already prefetched. Everything the panel shows arrives together.
   */
  const load = useCallback(async () => {
    const token = (readToken.current += 1);
    try {
      const snapshot = await loadPractice(playerId);
      if (token !== readToken.current) return;
      setBlocks(snapshot.blocks);
      setPresets(snapshot.presets);
      setSuggestions(snapshot.suggestions);
      setStoredTypes(snapshot.blockTypes);
      setError(snapshot.error);
    } catch (caught) {
      if (token !== readToken.current) return;
      if ((caught as { code?: string })?.code === "unauthorized") handlers.current.onUnauthorized();
      else setError(caught instanceof Error ? caught.message : "Could not load practice.");
    } finally {
      setFirstLoad(false);
    }
  }, [playerId]);

  /** After a write: drop the cache so the next read is real, then re-read. */
  const reload = useCallback(async () => {
    invalidatePractice(playerId);
    await load();
  }, [load, playerId]);

  useEffect(() => {
    void load();
  }, [load]);

  /* The composer opens on whichever kind the coach picked last. If that kind
   * has since been retired or deleted in settings, fall back to the first one
   * still offered rather than leaving a tab selected that no longer exists. */
  useEffect(() => {
    if (!offeredTypes.length) return;
    if (offeredTypes.some((type) => type.id === draft.blockType)) return;
    setDraft((current) => ({ ...current, blockType: offeredTypes[0].id }));
  }, [draft.blockType, offeredTypes]);

  const openVideoPicker = useCallback(async () => {
    setVideoPickerOpen(true);
    if (videoOptions.length || videoLoading) return;
    setVideoLoading(true);
    try {
      const transfers = await listClarityCloudImportTransfers("coach", playerId);
      setVideoOptions(transfers.filter((transfer) => transfer.savedVideo?.savedVideoId));
    } catch {
      // A picker that fails to load still lets the coach save without a video.
    } finally {
      setVideoLoading(false);
    }
  }, [playerId, videoOptions.length, videoLoading]);

  const selectedVideoTitle = useMemo(() => {
    if (!draft.linkedVideoId) return "";
    return videoOptions.find((t) => t.savedVideo?.savedVideoId === draft.linkedVideoId)?.savedVideo?.title || "";
  }, [draft.linkedVideoId, videoOptions]);

  const openBlock = useMemo(
    () => blocks.find((block) => block.id === openBrickId) || null,
    [blocks, openBrickId],
  );

  /**
   * Saves the draft, then reloads. Returns the new block's id -- and only for
   * a create, because the flight animation is "this became a brick", which an
   * edit to a brick already on the wall is not.
   */
  const save = useCallback(
    async (candidate: PracticeDraft, alsoFavourite: boolean): Promise<string | null> => {
      if (busy) return null;
      const content = practiceDraftContent(candidate);
      const title = candidate.title.trim() || practiceTypeMeta(types, candidate.blockType).titleHint;
      if (!content) {
        setError("Write at least one step before saving.");
        return null;
      }
      if (
        candidate.expiryType === "set_date" &&
        !candidate.expiryDate &&
        practiceTypeHasField(practiceTypeMeta(types, candidate.blockType), "expiry")
      ) {
        setError("Pick a date for this block's expiry.");
        return null;
      }
      setBusy(true);
      setError("");
      setWarning("");
      try {
        /* A field the type does not offer is not saved, even if the draft is
         * still carrying a value for it -- from a starter, or from the tab the
         * coach was on before they switched. The composer is the only place
         * that field was visible, so leaving it on the block would put an
         * expiry or a linked video on something that shows neither. */
        const meta = practiceTypeMeta(types, candidate.blockType);
        const expiryType = practiceTypeHasField(meta, "expiry") ? candidate.expiryType : "none";
        const body = {
          id: candidate.id || undefined,
          playerId,
          playerName,
          title,
          content,
          blockType: candidate.blockType,
          dose: practiceTypeHasField(meta, "dose") ? candidate.dose.trim() : "",
          expiryType,
          // End of the picked day, not its start -- a block set to expire
          // "31 Aug" should still be usable on the 31st, not vanish at its
          // first moment.
          expiryDate: expiryType === "set_date" ? `${candidate.expiryDate}T23:59:59Z` : undefined,
          linkedVideoId: practiceTypeHasField(meta, "video") ? candidate.linkedVideoId || undefined : undefined,
        };
        const data = await request("/api/practice-blocks", {
          method: candidate.id ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (alsoFavourite) {
          // Its own request, and its own failure: a favourite that didn't save
          // must not read as an assignment that didn't happen.
          try {
            await request("/api/practice-block-presets", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ title, content, blockType: candidate.blockType, dose: candidate.dose.trim() }),
            });
          } catch {
            handlers.current.onToast(`Assigned, but "${title}" could not be saved to favourites.`);
          }
        }

        if (data.warning === "no_upcoming_booking") {
          setWarning(`${playerName} has no upcoming lesson. Saved with no expiry instead.`);
        }
        setDraft(emptyPracticeDraft(candidate.blockType));
        setVideoPickerOpen(false);
        await reload();
        handlers.current.onToast(candidate.id ? "Practice block updated." : `Practice block assigned to ${playerName}.`);
        return candidate.id ? null : data.block?.id || null;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not save that block.");
        return null;
      } finally {
        setBusy(false);
      }
    },
    [busy, playerId, playerName, reload, request, types],
  );

  const archive = useCallback(
    async (blockId: string) => {
      const block = blocks.find((item) => item.id === blockId);
      if (block && !window.confirm(`Remove "${block.title}" from ${playerName}'s wall?`)) return;
      setBusy(true);
      setError("");
      try {
        await request(`/api/practice-blocks?id=${encodeURIComponent(blockId)}`, { method: "DELETE" });
        setOpenBrickId((current) => (current === blockId ? null : current));
        await reload();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not remove that block.");
      } finally {
        setBusy(false);
      }
    },
    [blocks, playerName, reload, request],
  );

  const saveFavourite = useCallback(
    async (favourite: { title: string; content: string; blockType: PracticeBlock["blockType"]; dose: string }) => {
      if (busy) return;
      const replacing = presets.some((preset) => preset.title.toLowerCase() === favourite.title.toLowerCase());
      setBusy(true);
      setError("");
      try {
        await request("/api/practice-block-presets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(favourite),
        });
        await reload();
        handlers.current.onToast(replacing ? `Favourite "${favourite.title}" updated.` : `Saved "${favourite.title}" to favourites.`);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not save that favourite.");
      } finally {
        setBusy(false);
      }
    },
    [busy, presets, reload, request],
  );

  const renamePreset = useCallback(
    async (preset: PracticePreset, title: string) => {
      // Optimistic: a rename is one word changing on a tile the coach is
      // looking at, and a round trip's worth of stale text reads as a bug.
      setPresets((current) => current.map((item) => (item.id === preset.id ? { ...item, title } : item)));
      try {
        await request("/api/practice-block-presets", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: preset.id, title }),
        });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not rename that favourite.");
      }
      await reload();
    },
    [reload, request],
  );

  const removePreset = useCallback(
    async (preset: PracticePreset) => {
      if (busy) return;
      if (!window.confirm(`Remove "${preset.title}" from favourites? Blocks already assigned from it stay as they are.`)) {
        return;
      }
      setBusy(true);
      setError("");
      try {
        await request(`/api/practice-block-presets?id=${encodeURIComponent(preset.id)}`, { method: "DELETE" });
        await reload();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not remove that favourite.");
      } finally {
        setBusy(false);
      }
    },
    [busy, reload, request],
  );

  const reorderPresets = useCallback(
    async (orderedIds: string[]) => {
      // The rail is filtered by the picked type, so the ids handed back are a
      // slice of the whole list. Everything not in that slice keeps the
      // position it had, and the slice is written into the gaps it occupied --
      // otherwise dragging inside "Drill" would silently shuffle "Game".
      const positions = presets
        .map((preset, index) => ({ preset, index }))
        .filter((entry) => orderedIds.includes(entry.preset.id))
        .map((entry) => entry.index);
      const next = presets.slice();
      orderedIds.forEach((id, slot) => {
        const preset = presets.find((item) => item.id === id);
        if (preset && positions[slot] !== undefined) next[positions[slot]] = preset;
      });
      setPresets(next);
      try {
        await request("/api/practice-block-presets", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order: next.map((preset) => preset.id) }),
        });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not save that order.");
        await reload();
      }
    },
    [presets, reload, request],
  );

  const dismissSuggestion = useCallback(
    async (suggestion: PracticeSuggestion) => {
      setSuggestions((current) => current.filter((item) => item.title !== suggestion.title));
      try {
        await request("/api/practice-block-presets/dismiss", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: suggestion.title }),
        });
      } catch {
        // It's back on the next load if this failed -- no error worth showing
        // above the composer for a chip the coach has already stopped seeing.
      }
    },
    [request],
  );

  const editBlock = useCallback(
    (block: PracticeBlock) => {
      if (practiceDraftIsWritten(draft) && !window.confirm("Replace what you've written with this block?")) return;
      setDraft(practiceDraftFromBlock(block));
      setWarning("");
      setVideoPickerOpen(false);
    },
    [draft],
  );

  /* Nothing here waits for the server.
   *
   * The composer needs no data to be usable -- a coach opening Practice is
   * almost always about to write a block, and holding the whole tab behind a
   * spinner made the one thing they came for the last thing to arrive. The
   * rails and the wall fill in around it. A later refresh does not blank
   * anything either: replacing a half-written block with a spinner is how a
   * coach loses work.
   */

  const videoControl = (
    <div className="practice-video-field">
      {draft.linkedVideoId ? (
        <span className="practice-video-selected">
          <span>{selectedVideoTitle || "Linked video"}</span>
          <button
            type="button"
            className="practice-video-cancel"
            onClick={() => setDraft({ ...draft, linkedVideoId: "" })}
          >
            Remove
          </button>
        </span>
      ) : (
        <button type="button" className="practice-clear" onClick={() => void openVideoPicker()}>
          Link a video
        </button>
      )}
      {videoPickerOpen && !draft.linkedVideoId && (
        <div className="practice-video-picker">
          {videoLoading ? (
            <p className="practice-video-empty">Loading {playerName}'s videos…</p>
          ) : videoOptions.length ? (
            <ul className="practice-video-options">
              {videoOptions.map((transfer) => (
                <li key={transfer.savedVideo?.savedVideoId}>
                  <button
                    type="button"
                    className="outline-button"
                    onClick={() => {
                      setDraft({ ...draft, linkedVideoId: transfer.savedVideo?.savedVideoId || "" });
                      setVideoPickerOpen(false);
                    }}
                  >
                    {transfer.savedVideo?.title || "Saved video"}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="practice-video-empty">No videos for {playerName} yet.</p>
          )}
          <button type="button" className="practice-video-cancel" onClick={() => setVideoPickerOpen(false)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className="practice-panel">
      <PracticeBlockBuilder
        draft={draft}
        onDraftChange={setDraft}
        types={types}
        presets={presets}
        suggestions={suggestions}
        busy={busy}
        onSave={save}
        onCancelEdit={() => {
          setDraft(emptyPracticeDraft(draft.blockType));
          setError("");
          setWarning("");
          setVideoPickerOpen(false);
        }}
        onRenamePreset={(preset, title) => void renamePreset(preset, title)}
        onRemovePreset={(preset) => void removePreset(preset)}
        onReorderPresets={(ids) => void reorderPresets(ids)}
        onDismissSuggestion={(suggestion) => void dismissSuggestion(suggestion)}
        loading={firstLoad}
        videoControl={videoControl}
      />

      {warning && (
        <p className="practice-warning" role="alert">
          {warning}
        </p>
      )}
      {error && (
        <p className="practice-error" role="alert">
          {error}
        </p>
      )}

      <PracticeWall
        blocks={blocks}
        types={types}
        openId={openBrickId}
        onOpen={(id) => setOpenBrickId((current) => (current === id ? null : id))}
        onRemove={(id) => void archive(id)}
        emptyNote={
          firstLoad
            ? "Loading the wall…"
            : `Nothing assigned to ${playerName} yet. The first block you save starts the wall.`
        }
      />

      {openBlock && (
        <div
          className="practice-detail"
          data-practice-type={openBlock.blockType}
          style={{ "--practice-tone": practiceTypeMeta(types, openBlock.blockType).tone } as CSSProperties}
        >
          <div className="practice-detail-head">
            <div>
              <span className="practice-detail-kind">{practiceTypeMeta(types, openBlock.blockType).label}</span>
              <strong>{openBlock.title}</strong>
              <span className="practice-detail-meta">
                {practiceBlockMeta(openBlock)} · {practiceExpiryLabel(openBlock)}
              </span>
            </div>
            <button
              type="button"
              className="practice-detail-close"
              title="Close"
              aria-label="Close"
              onClick={() => setOpenBrickId(null)}
            >
              ×
            </button>
          </div>

          <ol>
            {practiceSteps(openBlock.content).map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ol>

          <div className="practice-detail-actions">
            <span className={`practice-status-badge practice-status-${openBlock.status}`}>
              {STATUS_LABEL[openBlock.status]}
            </span>
            {openBlock.status === "active" && (
              <button type="button" className="outline-button" disabled={busy} onClick={() => editBlock(openBlock)}>
                Edit
              </button>
            )}
            <button
              type="button"
              className="outline-button"
              disabled={busy}
              onClick={() =>
                void saveFavourite({
                  title: openBlock.title,
                  content: openBlock.content,
                  blockType: openBlock.blockType,
                  dose: openBlock.dose,
                })
              }
            >
              ★ Favourite
            </button>
            <button type="button" className="outline-button" disabled={busy} onClick={() => void archive(openBlock.id)}>
              Remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default PracticeBlockPanel;
