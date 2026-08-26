import { useCallback, useEffect, useMemo, useState } from "react";

import "./practice.css";
import { apiFetch } from "../auth/apiFetch";
import { listClarityCloudImportTransfers, type ClarityCloudImportTransfer } from "../video-analysis/utils/savedVideoLibrary";
import {
  PracticeBlockBuilder,
  emptyPracticeDraft,
  practiceDraftContent,
  practiceDraftFromBlock,
  practiceDraftIsWritten,
  type PracticeDraft,
} from "./PracticeBlockBuilder";
import { PracticeWall } from "./PracticeWall";
import {
  practiceBlockMeta,
  practiceExpiryLabel,
  practiceSteps,
  practiceTypeMeta,
  type PracticeBlock,
  type PracticePreset,
  type PracticeSuggestion,
} from "./practiceModel";

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
  const [blocks, setBlocks] = useState<PracticeBlock[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");

  const [draft, setDraft] = useState<PracticeDraft>(() => emptyPracticeDraft());
  const [openBrickId, setOpenBrickId] = useState<string | null>(null);

  const [presets, setPresets] = useState<PracticePreset[]>([]);
  const [suggestions, setSuggestions] = useState<PracticeSuggestion[]>([]);

  const [videoPickerOpen, setVideoPickerOpen] = useState(false);
  const [videoOptions, setVideoOptions] = useState<ClarityCloudImportTransfer[]>([]);
  const [videoLoading, setVideoLoading] = useState(false);

  const request = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const response = await apiFetch(path, init);
      if (response.status === 401) {
        onUnauthorized();
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
    [onUnauthorized],
  );

  /**
   * Favourites and suggestions in one call -- the composer wants both at the
   * same moment. A failure here is swallowed: the rails are a shortcut, and
   * losing them shouldn't put an error above a composer that still works.
   */
  const loadStarters = useCallback(async () => {
    try {
      const data = await request(`/api/practice-block-presets?playerId=${encodeURIComponent(player.id)}`);
      setPresets(Array.isArray(data.presets) ? data.presets : []);
      setSuggestions(Array.isArray(data.suggestions) ? data.suggestions : []);
    } catch {
      setPresets([]);
      setSuggestions([]);
    }
  }, [player.id, request]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await request(`/api/practice-blocks?playerId=${encodeURIComponent(player.id)}`);
      setBlocks(Array.isArray(data.blocks) ? data.blocks : []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load practice.");
    } finally {
      setLoading(false);
    }
    // After the list, always: assigning a block changes both the use counts
    // and what this player already has active, so the rails must re-read.
    await loadStarters();
  }, [loadStarters, player.id, request]);

  useEffect(() => {
    void load();
  }, [load]);

  const openVideoPicker = useCallback(async () => {
    setVideoPickerOpen(true);
    if (videoOptions.length || videoLoading) return;
    setVideoLoading(true);
    try {
      const transfers = await listClarityCloudImportTransfers("coach", player.id);
      setVideoOptions(transfers.filter((transfer) => transfer.savedVideo?.savedVideoId));
    } catch {
      // A picker that fails to load still lets the coach save without a video.
    } finally {
      setVideoLoading(false);
    }
  }, [player.id, videoOptions.length, videoLoading]);

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
      const title = candidate.title.trim() || practiceTypeMeta(candidate.blockType).titleHint;
      if (!content) {
        setError("Write at least one step before saving.");
        return null;
      }
      if (candidate.expiryType === "set_date" && !candidate.expiryDate) {
        setError("Pick a date for this block's expiry.");
        return null;
      }
      setBusy(true);
      setError("");
      setWarning("");
      try {
        const body = {
          id: candidate.id || undefined,
          playerId: player.id,
          playerName: player.name,
          title,
          content,
          blockType: candidate.blockType,
          dose: candidate.dose.trim(),
          expiryType: candidate.expiryType,
          // End of the picked day, not its start -- a block set to expire
          // "31 Aug" should still be usable on the 31st, not vanish at its
          // first moment.
          expiryDate: candidate.expiryType === "set_date" ? `${candidate.expiryDate}T23:59:59Z` : undefined,
          linkedVideoId: candidate.linkedVideoId || undefined,
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
            onToast(`Assigned, but "${title}" could not be saved to favourites.`);
          }
        }

        if (data.warning === "no_upcoming_booking") {
          setWarning(`${player.name} has no upcoming lesson. Saved with no expiry instead.`);
        }
        setDraft(emptyPracticeDraft(candidate.blockType));
        setVideoPickerOpen(false);
        await load();
        onToast(candidate.id ? "Practice block updated." : `Practice block assigned to ${player.name}.`);
        return candidate.id ? null : data.block?.id || null;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not save that block.");
        return null;
      } finally {
        setBusy(false);
      }
    },
    [busy, load, onToast, player.id, player.name, request],
  );

  const archive = useCallback(
    async (blockId: string) => {
      const block = blocks.find((item) => item.id === blockId);
      if (block && !window.confirm(`Remove "${block.title}" from ${player.name}'s wall?`)) return;
      setBusy(true);
      setError("");
      try {
        await request(`/api/practice-blocks?id=${encodeURIComponent(blockId)}`, { method: "DELETE" });
        setOpenBrickId((current) => (current === blockId ? null : current));
        await load();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not remove that block.");
      } finally {
        setBusy(false);
      }
    },
    [blocks, load, player.name, request],
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
        await loadStarters();
        onToast(replacing ? `Favourite "${favourite.title}" updated.` : `Saved "${favourite.title}" to favourites.`);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not save that favourite.");
      } finally {
        setBusy(false);
      }
    },
    [busy, loadStarters, onToast, presets, request],
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
      await loadStarters();
    },
    [loadStarters, request],
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
        await loadStarters();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not remove that favourite.");
      } finally {
        setBusy(false);
      }
    },
    [busy, loadStarters, request],
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
        await loadStarters();
      }
    },
    [loadStarters, presets, request],
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

  if (loading) return <div className="module-loading">Loading practice…</div>;

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
            <p className="practice-video-empty">Loading {player.name}'s videos…</p>
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
            <p className="practice-video-empty">No videos for {player.name} yet.</p>
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
        openId={openBrickId}
        onOpen={(id) => setOpenBrickId((current) => (current === id ? null : id))}
        onRemove={(id) => void archive(id)}
        emptyNote={`Nothing assigned to ${player.name} yet. The first block you save starts the wall.`}
      />

      {openBlock && (
        <div className="practice-detail" data-practice-type={openBlock.blockType}>
          <div className="practice-detail-head">
            <div>
              <span className="practice-detail-kind">{practiceTypeMeta(openBlock.blockType).label}</span>
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
