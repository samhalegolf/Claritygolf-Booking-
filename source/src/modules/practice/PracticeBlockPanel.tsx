import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import "./practice.css";
import { apiFetch } from "../auth/apiFetch";
import { listClarityCloudImportTransfers, type ClarityCloudImportTransfer } from "../video-analysis/utils/savedVideoLibrary";
import {
  practiceAssignedLabel,
  practiceExpiryLabel,
  type ExpiryType,
  type PracticeBlock,
  type PracticePreset,
  type PracticeSuggestion,
} from "./practiceModel";

/* The coach's end of Practice. Owns its own loading, its own writes. The
 * console only tells it which player is open.
 *
 * A block is three things: what to do (title + content), when it stops
 * mattering (expiry), and optionally a video that shows what "it" looks
 * like. Nothing here is a category picker -- that was the old feature; this
 * one is plain text plus an expiry a coach barely has to think about.
 *
 * The composer opens on two rows of starter chips so the common case isn't
 * retyping: presets the coach saved, and the titles they assign most across
 * the roster. Both only fill the text fields -- expiry and video stay this
 * assignment's decision, because those are about this player right now.
 */

export type PracticeBlockPanelProps = {
  player: { id: string; name: string };
  /** Called on a 401 so the app can drop back to its signed-out state. */
  onUnauthorized: () => void;
  onToast: (message: string) => void;
};

type ComposerState = {
  id: string | null; // set when editing an existing block
  title: string;
  content: string;
  expiryType: ExpiryType;
  expiryDate: string; // yyyy-mm-dd, only meaningful when expiryType === "set_date"
  linkedVideoId: string;
};

function emptyComposer(): ComposerState {
  return { id: null, title: "", content: "", expiryType: "none", expiryDate: "", linkedVideoId: "" };
}

function composerFromBlock(block: PracticeBlock): ComposerState {
  return {
    id: block.id,
    title: block.title,
    content: block.content,
    expiryType: block.expiryType,
    expiryDate: block.expiryType === "set_date" && block.expiryDate ? block.expiryDate.slice(0, 10) : "",
    linkedVideoId: block.linkedVideoId || "",
  };
}

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

  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [warning, setWarning] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

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
   * Presets and suggestions in one call -- the composer wants both at the same
   * moment. A failure here is swallowed: starters are a shortcut, and losing
   * them shouldn't put an error above a composer that still works fine.
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
    // and what this player already has active, so the chips must re-read.
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
    if (!composer?.linkedVideoId) return "";
    return videoOptions.find((t) => t.savedVideo?.savedVideoId === composer.linkedVideoId)?.savedVideo?.title || "";
  }, [composer?.linkedVideoId, videoOptions]);

  /**
   * Fills the text fields from a chip. Expiry and linked video are left alone
   * -- a starter says what to practise, not for how long or against which
   * swing. Anything already typed is confirmed before it's overwritten,
   * because a misclick here would otherwise wipe a paragraph.
   */
  const applyStarter = useCallback(
    (title: string, content: string) => {
      if (!composer) return;
      const hasText = Boolean(composer.title.trim() || composer.content.trim());
      if (hasText && !window.confirm("Replace what you've written with this one?")) return;
      setComposer({ ...composer, title, content });
    },
    [composer],
  );

  const saveAsPreset = useCallback(async () => {
    if (!composer || busy) return;
    const title = composer.title.trim();
    const content = composer.content.trim();
    if (!title || !content) return;
    const replacing = presets.some((preset) => preset.title.toLowerCase() === title.toLowerCase());
    setBusy(true);
    setError("");
    try {
      await request("/api/practice-block-presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content }),
      });
      await loadStarters();
      onToast(replacing ? `Preset "${title}" updated.` : `Saved "${title}" as a preset.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save that preset.");
    } finally {
      setBusy(false);
    }
  }, [busy, composer, loadStarters, onToast, presets, request]);

  const removePreset = useCallback(
    async (preset: PracticePreset) => {
      if (busy) return;
      if (!window.confirm(`Delete the preset "${preset.title}"? Blocks already assigned from it stay as they are.`)) {
        return;
      }
      setBusy(true);
      setError("");
      try {
        await request(`/api/practice-block-presets?id=${encodeURIComponent(preset.id)}`, { method: "DELETE" });
        await loadStarters();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not delete that preset.");
      } finally {
        setBusy(false);
      }
    },
    [busy, loadStarters, request],
  );

  const save = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!composer || busy) return;
      const title = composer.title.trim();
      const content = composer.content.trim();
      if (!title || !content) return;
      if (composer.expiryType === "set_date" && !composer.expiryDate) {
        setError("Pick a date for this block's expiry.");
        return;
      }
      setBusy(true);
      setError("");
      setWarning("");
      try {
        const body = {
          id: composer.id || undefined,
          playerId: player.id,
          playerName: player.name,
          title,
          content,
          expiryType: composer.expiryType,
          // End of the picked day, not its start -- a block set to expire
          // "31 Aug" should still be usable on the 31st, not vanish at its
          // first moment.
          expiryDate: composer.expiryType === "set_date" ? `${composer.expiryDate}T23:59:59Z` : undefined,
          linkedVideoId: composer.linkedVideoId || undefined,
        };
        const data = composer.id
          ? await request("/api/practice-blocks", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            })
          : await request("/api/practice-blocks", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
        if (data.warning === "no_upcoming_booking") {
          setWarning(`${player.name} has no upcoming lesson. Saved with no expiry instead.`);
        } else {
          setComposer(null);
        }
        await load();
        onToast(composer.id ? "Practice block updated." : `Practice block assigned to ${player.name}.`);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not save that block.");
      } finally {
        setBusy(false);
      }
    },
    [busy, composer, load, onToast, player.id, player.name, request],
  );

  const archive = useCallback(
    async (blockId: string) => {
      setBusy(true);
      setError("");
      try {
        await request(`/api/practice-blocks?id=${encodeURIComponent(blockId)}`, { method: "DELETE" });
        await load();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not archive that block.");
      } finally {
        setBusy(false);
      }
    },
    [load, request],
  );

  if (loading) return <div className="module-loading">Loading practice…</div>;

  return (
    <div className="practice-panel">
      {!composer && (
        <button
          type="button"
          className="primary-button"
          onClick={() => {
            setComposer(emptyComposer());
            setWarning("");
            setVideoPickerOpen(false);
          }}
        >
          + New Practice Block
        </button>
      )}

      {composer && (
        <form className="practice-composer" onSubmit={save}>
          {/* New blocks only. Editing an existing one is a correction to that
              block, not a fresh start, so the chips would only be in the way. */}
          {!composer.id && (presets.length > 0 || suggestions.length > 0) && (
            <div className="practice-starters">
              {presets.length > 0 && (
                <div className="practice-starter-group">
                  <span className="practice-starter-label">Your presets</span>
                  <ul className="practice-starter-chips">
                    {presets.map((preset) => (
                      <li className="practice-starter-chip" key={preset.id}>
                        <button type="button" onClick={() => applyStarter(preset.title, preset.content)}>
                          {preset.title}
                        </button>
                        <button
                          type="button"
                          className="practice-starter-remove"
                          title={`Delete the preset "${preset.title}"`}
                          aria-label={`Delete the preset ${preset.title}`}
                          disabled={busy}
                          onClick={() => void removePreset(preset)}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {suggestions.length > 0 && (
                <div className="practice-starter-group">
                  <span className="practice-starter-label">Used often</span>
                  <ul className="practice-starter-chips">
                    {suggestions.map((suggestion) => (
                      <li className="practice-starter-chip" key={suggestion.title}>
                        <button type="button" onClick={() => applyStarter(suggestion.title, suggestion.content)}>
                          {suggestion.title}
                          <em>×{suggestion.uses}</em>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <label className="practice-field">
            <span>Title</span>
            <input
              value={composer.title}
              onChange={(event) => setComposer({ ...composer, title: event.target.value })}
              placeholder="Start Line Control"
              maxLength={200}
              autoFocus
              required
            />
          </label>

          <label className="practice-field">
            <span>What to practise</span>
            <textarea
              value={composer.content}
              onChange={(event) => setComposer({ ...composer, content: event.target.value })}
              rows={5}
              placeholder="Hit 10 balls using the alignment gate. Focus only on starting the ball inside the intended window."
              required
            />
          </label>

          <fieldset className="practice-expiry-field">
            <legend>Expiry</legend>
            <div className="practice-expiry-options">
              {(["none", "set_date", "next_lesson"] as ExpiryType[]).map((option) => (
                <label className="practice-expiry-option" key={option}>
                  <input
                    type="radio"
                    name="expiryType"
                    checked={composer.expiryType === option}
                    onChange={() => setComposer({ ...composer, expiryType: option })}
                  />
                  {option === "none" ? "No expiry" : option === "set_date" ? "Set date" : "Next lesson"}
                </label>
              ))}
            </div>
            {composer.expiryType === "set_date" && (
              <input
                type="date"
                className="practice-expiry-date"
                value={composer.expiryDate}
                onChange={(event) => setComposer({ ...composer, expiryDate: event.target.value })}
                required
              />
            )}
          </fieldset>

          <div className="practice-video-field">
            {composer.linkedVideoId ? (
              <div className="practice-video-selected">
                <span>Linked video: {selectedVideoTitle || "Saved video"}</span>
                <button type="button" className="outline-button" onClick={() => setComposer({ ...composer, linkedVideoId: "" })}>
                  Remove
                </button>
              </div>
            ) : videoPickerOpen ? (
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
                          onClick={() =>
                            setComposer({ ...composer, linkedVideoId: transfer.savedVideo?.savedVideoId || "" })
                          }
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
            ) : (
              <button type="button" className="outline-button" onClick={() => void openVideoPicker()}>
                Link a video
              </button>
            )}
          </div>

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

          <div className="practice-composer-actions">
            <button type="submit" className="primary-button" disabled={busy || !composer.title.trim() || !composer.content.trim()}>
              {composer.id ? "Save changes" : "Assign"}
            </button>
            <button
              type="button"
              className="outline-button"
              disabled={busy || !composer.title.trim() || !composer.content.trim()}
              onClick={() => void saveAsPreset()}
            >
              Save as preset
            </button>
            <button
              type="button"
              className="outline-button"
              onClick={() => {
                setComposer(null);
                setError("");
                setWarning("");
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="practice-block-list">
        {blocks.length ? (
          blocks.map((block) => (
            <article className="practice-block-card" key={block.id}>
              <div className="practice-block-head">
                <div>
                  <strong>{block.title}</strong>
                  <span className={`practice-status-badge practice-status-${block.status}`}>
                    {STATUS_LABEL[block.status]}
                  </span>
                </div>
                <span className="practice-block-meta">
                  {practiceAssignedLabel(block)} · {practiceExpiryLabel(block)}
                </span>
              </div>
              <p className={expandedId === block.id ? "" : "practice-block-clamped"}>{block.content}</p>
              <div className="practice-block-actions">
                <button
                  type="button"
                  className="practice-block-toggle"
                  onClick={() => setExpandedId(expandedId === block.id ? null : block.id)}
                >
                  {expandedId === block.id ? "Show less" : "Show full text"}
                </button>
                {block.status === "active" && (
                  <>
                    <button
                      type="button"
                      className="outline-button"
                      disabled={busy}
                      onClick={() => {
                        setComposer(composerFromBlock(block));
                        setWarning("");
                        setVideoPickerOpen(false);
                      }}
                    >
                      Edit
                    </button>
                    <button type="button" className="outline-button" disabled={busy} onClick={() => void archive(block.id)}>
                      Archive
                    </button>
                  </>
                )}
              </div>
            </article>
          ))
        ) : (
          <p className="notes-empty">No practice blocks yet.</p>
        )}
      </div>

      {error && !composer && (
        <p className="practice-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export default PracticeBlockPanel;
