import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import {
  PRACTICE_TYPES,
  practiceContentFromSteps,
  practiceRailLabel,
  practiceSteps,
  practiceTypeMeta,
  type ExpiryType,
  type PracticeBlock,
  type PracticeBlockType,
  type PracticePreset,
  type PracticeSuggestion,
} from "./practiceModel";

/* The composer.
 *
 * Three columns that are one thing: what the coach assigns most (Often), what
 * they are writing now, and what they chose to keep (Saved). Both rails only
 * ever fill the form -- they never assign anything, and they never touch
 * expiry or the linked video, because those two are about this player right
 * now and a starter knows nothing about either.
 *
 * The type is picked first and then everything downstream agrees with it: the
 * tab grows into the frame the fields sit in, both rails filter to that type,
 * and the brick the block becomes on the wall carries the same colour. Picking
 * "Drill" is therefore also a filter, which is the whole reason the tabs are
 * above the rails' content rather than beside the title field.
 */

export type PracticeDraftStep = { id: number; text: string };

export type PracticeDraft = {
  /** Set when editing an existing block; null for a new one. */
  id: string | null;
  blockType: PracticeBlockType;
  title: string;
  steps: PracticeDraftStep[];
  dose: string;
  expiryType: ExpiryType;
  /** yyyy-mm-dd, only meaningful when expiryType === "set_date". */
  expiryDate: string;
  linkedVideoId: string;
  nextStepId: number;
};

export function emptyPracticeDraft(blockType: PracticeBlockType = "drill"): PracticeDraft {
  return {
    id: null,
    blockType,
    title: "",
    steps: [{ id: 1, text: "" }],
    dose: "",
    // A block a coach writes between lessons is nearly always for the gap
    // before the next one, so that is the default rather than "no expiry".
    expiryType: "next_lesson",
    expiryDate: "",
    linkedVideoId: "",
    nextStepId: 2,
  };
}

export function practiceDraftFromBlock(block: PracticeBlock): PracticeDraft {
  const steps = practiceSteps(block.content);
  return {
    id: block.id,
    blockType: block.blockType,
    title: block.title,
    steps: (steps.length ? steps : [""]).map((text, index) => ({ id: index + 1, text })),
    dose: block.dose || "",
    expiryType: block.expiryType,
    expiryDate: block.expiryType === "set_date" && block.expiryDate ? block.expiryDate.slice(0, 10) : "",
    linkedVideoId: block.linkedVideoId || "",
    nextStepId: Math.max(steps.length, 1) + 1,
  };
}

export function practiceDraftContent(draft: PracticeDraft) {
  return practiceContentFromSteps(draft.steps.map((step) => step.text));
}

export function practiceDraftIsWritten(draft: PracticeDraft) {
  return Boolean(draft.title.trim()) || draft.steps.some((step) => step.text.trim());
}

/* Rail tiers.
 *
 * The form holds a 330px floor, so as the panel narrows the rails give up
 * their full titles first and then leave the row entirely rather than
 * squeezing the fields. The thresholds are the sum of what each tier needs:
 * 330 + two 96px rails + gaps, then 330 + two 56px rails + gaps.
 */
type RailTier = "full" | "short" | "top";

const TIER_FULL = 546;
const TIER_SHORT = 466;
/** A narrow-tier rail tile, plus its gap. */
const NARROW_TILE = 92;

export type PracticeBlockBuilderProps = {
  draft: PracticeDraft;
  onDraftChange: (draft: PracticeDraft) => void;
  presets: PracticePreset[];
  suggestions: PracticeSuggestion[];
  busy: boolean;
  /** Resolves to the saved block's id, or null if the save failed. */
  onSave: (draft: PracticeDraft, alsoFavourite: boolean) => Promise<string | null>;
  onCancelEdit: () => void;
  onRenamePreset: (preset: PracticePreset, title: string) => void;
  onRemovePreset: (preset: PracticePreset) => void;
  onReorderPresets: (orderedIds: string[]) => void;
  onDismissSuggestion: (suggestion: PracticeSuggestion) => void;
  /** Rendered into the action row -- the video picker, which is the panel's. */
  videoControl?: React.ReactNode;
};

export function PracticeBlockBuilder({
  draft,
  onDraftChange,
  presets,
  suggestions,
  busy,
  onSave,
  onCancelEdit,
  onRenamePreset,
  onRemovePreset,
  onReorderPresets,
  onDismissSuggestion,
  videoControl,
}: PracticeBlockBuilderProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);

  const [tier, setTier] = useState<RailTier>("full");
  const [rowWidth, setRowWidth] = useState(TIER_FULL);
  const [openRail, setOpenRail] = useState<"often" | "saved" | null>(null);
  const [editingSuggestions, setEditingSuggestions] = useState(false);
  const [editingFavourites, setEditingFavourites] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [order, setOrder] = useState<string[] | null>(null);

  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const width = node.clientWidth;
      const next: RailTier = width >= TIER_FULL ? "full" : width >= TIER_SHORT ? "short" : "top";
      setRowWidth(width);
      setTier(next);
      // The "+N" popup belongs to the narrow tier only -- leaving it open
      // through a resize would strand it over the rails it came from.
      if (next !== "top") setOpenRail(null);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, []);

  const narrow = tier === "top";
  const typeMeta = practiceTypeMeta(draft.blockType);

  /** How many tiles a narrow rail can show on its one line before it clips. */
  const fitCount = useMemo(() => {
    if (!narrow) return Number.POSITIVE_INFINITY;
    const boxWidth = (rowWidth - 8) / 2;
    return Math.max(1, Math.floor((boxWidth - 12) / NARROW_TILE));
  }, [narrow, rowWidth]);

  /* The picked tab filters both rails: only that type's blocks are offered.
   * Custom is the exception and shows everything, because "custom" is not a
   * kind of block so much as the absence of one. */
  const shownPresets = useMemo(() => {
    const filtered = draft.blockType === "custom" ? presets : presets.filter((p) => p.blockType === draft.blockType);
    // A drag is applied locally the moment it happens and only persisted on
    // drop, so the rail follows the pointer without a round trip per hover.
    if (!order) return filtered;
    const rank = new Map(order.map((id, index) => [id, index]));
    return [...filtered].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  }, [draft.blockType, order, presets]);

  const shownSuggestions = useMemo(
    () =>
      draft.blockType === "custom"
        ? suggestions
        : suggestions.filter((suggestion) => suggestion.blockType === draft.blockType),
    [draft.blockType, suggestions],
  );

  const applyStarter = useCallback(
    (source: { title: string; content: string; blockType: PracticeBlockType; dose: string }) => {
      if (practiceDraftIsWritten(draft) && !window.confirm("Replace what you've written with this one?")) return;
      const steps = practiceSteps(source.content);
      let nextStepId = draft.nextStepId;
      onDraftChange({
        ...draft,
        title: source.title,
        blockType: source.blockType,
        dose: source.dose,
        steps: (steps.length ? steps : [""]).map((text) => ({ id: nextStepId++, text })),
        nextStepId,
      });
    },
    [draft, onDraftChange],
  );

  const setStepText = useCallback(
    (stepId: number, text: string) => {
      onDraftChange({
        ...draft,
        steps: draft.steps.map((step) => (step.id === stepId ? { ...step, text } : step)),
      });
    },
    [draft, onDraftChange],
  );

  const addStep = useCallback(() => {
    onDraftChange({
      ...draft,
      steps: [...draft.steps, { id: draft.nextStepId, text: "" }],
      nextStepId: draft.nextStepId + 1,
    });
  }, [draft, onDraftChange]);

  const removeStep = useCallback(
    (stepId: number) => {
      // Never below one: an empty first step is a prompt, no steps at all is a
      // form with nowhere to type.
      const remaining = draft.steps.filter((step) => step.id !== stepId);
      onDraftChange({
        ...draft,
        steps: remaining.length ? remaining : [{ id: draft.nextStepId, text: "" }],
        nextStepId: remaining.length ? draft.nextStepId : draft.nextStepId + 1,
      });
    },
    [draft, onDraftChange],
  );

  const canSave = Boolean(draft.title.trim() || draft.steps.some((step) => step.text.trim()));

  const submit = useCallback(
    async (alsoFavourite: boolean) => {
      if (busy || !canSave) return;
      const frame = frameRef.current;
      const from = frame ? frame.getBoundingClientRect() : null;
      const savedId = await onSave(draft, alsoFavourite);
      if (savedId && from) startFlight(savedId, from, draft.blockType, draft.title.trim() || typeMeta.titleHint);
    },
    [busy, canSave, draft, onSave, typeMeta.titleHint],
  );

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void submit(false);
    },
    [submit],
  );

  const commitRename = useCallback(() => {
    const preset = presets.find((item) => item.id === renamingId);
    setRenamingId(null);
    if (!preset) return;
    const title = renameText.trim();
    if (!title || title === preset.title) return;
    onRenamePreset(preset, title);
  }, [onRenamePreset, presets, renameText, renamingId]);

  const dropDrag = useCallback(() => {
    setDragId(null);
    if (order) onReorderPresets(order);
    setOrder(null);
  }, [onReorderPresets, order]);

  const railClass = (which: "often" | "saved") =>
    `practice-rail practice-rail-${which}${narrow ? " practice-rail-narrow" : ""}`;

  const oftenHidden = narrow ? Math.max(0, shownSuggestions.length - fitCount) : 0;
  const savedHidden = narrow ? Math.max(0, shownPresets.length - fitCount) : 0;
  const visibleSuggestions = narrow ? shownSuggestions.slice(0, fitCount) : shownSuggestions;
  const visiblePresets = narrow ? shownPresets.slice(0, fitCount) : shownPresets;

  const emptyNote = `None for ${typeMeta.label.toLowerCase()} yet`;

  const suggestionTile = (suggestion: PracticeSuggestion) => (
    <div className="practice-tile-wrap" key={suggestion.title}>
      <button
        type="button"
        className="practice-tile"
        data-practice-type={suggestion.blockType}
        title={`${suggestion.title} — ${practiceSteps(suggestion.content).length} steps${
          suggestion.dose ? ` · ${suggestion.dose}` : ""
        } · used ${suggestion.uses}×`}
        onClick={() => applyStarter(suggestion)}
      >
        <strong>{practiceRailLabel(suggestion.title, tier === "short")}</strong>
      </button>
      {editingSuggestions && (
        <button
          type="button"
          className="practice-tile-remove"
          title="Stop suggesting this"
          aria-label={`Stop suggesting ${suggestion.title}`}
          onClick={() => onDismissSuggestion(suggestion)}
        >
          ×
        </button>
      )}
    </div>
  );

  const favouriteTile = (preset: PracticePreset, draggable: boolean) => (
    <div
      className="practice-tile-wrap practice-tile-wrap-fav"
      key={preset.id}
      data-dragging={dragId === preset.id ? "1" : undefined}
      draggable={draggable && renamingId !== preset.id}
      onDragStart={() => {
        setDragId(preset.id);
        setOrder(shownPresets.map((item) => item.id));
      }}
      onDragOver={(event) => {
        if (!dragId || dragId === preset.id) return;
        event.preventDefault();
        setOrder((current) => {
          const list = (current || shownPresets.map((item) => item.id)).slice();
          const from = list.indexOf(dragId);
          const to = list.indexOf(preset.id);
          if (from < 0 || to < 0 || from === to) return current;
          list.splice(to, 0, list.splice(from, 1)[0]);
          return list;
        });
      }}
      /* The reorder is persisted from onDragEnd alone. onDrop fires first and
         only needs to accept the drop -- doing the write in both would send
         the same order twice for every drag. */
      onDrop={(event) => event.preventDefault()}
      onDragEnd={dropDrag}
    >
      {renamingId === preset.id ? (
        <input
          className="practice-tile-rename"
          value={renameText}
          autoFocus
          onChange={(event) => setRenameText(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitRename();
            if (event.key === "Escape") setRenamingId(null);
          }}
        />
      ) : (
        <button
          type="button"
          className="practice-tile"
          data-practice-type={preset.blockType}
          title={`${preset.title} — ${practiceSteps(preset.content).length} steps${preset.dose ? ` · ${preset.dose}` : ""}`}
          onClick={() => applyStarter(preset)}
        >
          <strong>{practiceRailLabel(preset.title, tier === "short")}</strong>
          {editingFavourites && (
            <span className="practice-tile-tools">
              <span
                role="button"
                tabIndex={0}
                title={`Rename "${preset.title}"`}
                onClick={(event) => {
                  event.stopPropagation();
                  setRenamingId(preset.id);
                  setRenameText(preset.title);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.stopPropagation();
                  event.preventDefault();
                  setRenamingId(preset.id);
                  setRenameText(preset.title);
                }}
              >
                ✎
              </span>
              <span
                role="button"
                tabIndex={0}
                title={`Remove "${preset.title}" from favourites`}
                onClick={(event) => {
                  event.stopPropagation();
                  onRemovePreset(preset);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.stopPropagation();
                  event.preventDefault();
                  onRemovePreset(preset);
                }}
              >
                ×
              </span>
            </span>
          )}
        </button>
      )}
    </div>
  );

  return (
    <div className="practice-builder" ref={rootRef} data-tier={tier}>
      <div className={railClass("often")}>
        <div className="practice-rail-head">
          <strong>{tier === "short" ? "Oft" : "Often"}</strong>
          {oftenHidden > 0 || openRail === "often" ? (
            <button
              type="button"
              className="practice-rail-more"
              title={openRail === "often" ? "Close" : `Show all ${shownSuggestions.length}`}
              onClick={() => setOpenRail((current) => (current === "often" ? null : "often"))}
            >
              {openRail === "often" ? "×" : `+${oftenHidden}`}
            </button>
          ) : null}
          <button
            type="button"
            className="practice-rail-edit"
            data-on={editingSuggestions ? "1" : undefined}
            title={editingSuggestions ? "Done editing suggestions" : "Edit suggestions"}
            aria-label={editingSuggestions ? "Done editing suggestions" : "Edit suggestions"}
            onClick={() => setEditingSuggestions((current) => !current)}
          >
            ✎
          </button>
        </div>
        <div className="practice-rail-list">{visibleSuggestions.map(suggestionTile)}</div>
        {!shownSuggestions.length && <span className="practice-rail-empty">{emptyNote}</span>}
        {openRail === "often" && <div className="practice-rail-popup">{shownSuggestions.map(suggestionTile)}</div>}
      </div>

      <form className="practice-form" onSubmit={onSubmit}>
        <div className="practice-type-strip">
          <div className="practice-type-tabs">
            {PRACTICE_TYPES.filter((type) => type.id !== "custom").map((type) => (
              <button
                type="button"
                key={type.id}
                className="practice-type-tab"
                data-practice-type={type.id}
                data-on={draft.blockType === type.id ? "1" : undefined}
                aria-pressed={draft.blockType === type.id}
                title={`${type.label} — ${type.hint}`}
                onClick={() => onDraftChange({ ...draft, blockType: type.id })}
              >
                <strong>{type.label}</strong>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="practice-type-tab practice-type-tab-custom"
            data-practice-type="custom"
            data-on={draft.blockType === "custom" ? "1" : undefined}
            aria-pressed={draft.blockType === "custom"}
            title="Custom — set your own"
            onClick={() => onDraftChange({ ...draft, blockType: "custom" })}
          >
            <strong>Custom</strong>
          </button>
        </div>

        <div className="practice-frame" data-practice-type={draft.blockType} ref={frameRef}>
          <input
            className="practice-title-input"
            value={draft.title}
            onChange={(event) => onDraftChange({ ...draft, title: event.target.value })}
            placeholder={typeMeta.titleHint}
            maxLength={200}
            aria-label="Block title"
          />

          <div className="practice-steps">
            {draft.steps.map((step, index) => (
              <div className="practice-step" key={step.id}>
                <span className="practice-step-number" aria-hidden="true">
                  {index + 1}
                </span>
                <textarea
                  rows={2}
                  value={step.text}
                  onChange={(event) => setStepText(step.id, event.target.value)}
                  placeholder={index === 0 ? "What to do, in one instruction." : "Then…"}
                  aria-label={`Step ${index + 1}`}
                />
                {index === 0 && (
                  <span className="practice-dose">
                    <input
                      value={draft.dose}
                      onChange={(event) => onDraftChange({ ...draft, dose: event.target.value })}
                      placeholder={typeMeta.doseHint || "How much"}
                      maxLength={60}
                      aria-label="How much of it"
                    />
                    {draft.dose && (
                      <button
                        type="button"
                        title="Remove this dose"
                        aria-label="Remove this dose"
                        onClick={() => onDraftChange({ ...draft, dose: "" })}
                      >
                        ×
                      </button>
                    )}
                  </span>
                )}
                {draft.steps.length > 1 && (
                  <button
                    type="button"
                    className="practice-step-remove"
                    title={`Remove step ${index + 1}`}
                    aria-label={`Remove step ${index + 1}`}
                    onClick={() => removeStep(step.id)}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            <button type="button" className="practice-step-add" onClick={addStep}>
              + Add step
            </button>
          </div>
        </div>

        <div className="practice-actions">
          <label className="practice-expiry">
            <span>
              {draft.expiryType === "none"
                ? "No expiry"
                : draft.expiryType === "set_date"
                  ? "Expires on date"
                  : "Expires next lesson"}
              <em aria-hidden="true">▾</em>
            </span>
            <select
              value={draft.expiryType}
              aria-label="Expiry"
              onChange={(event) => onDraftChange({ ...draft, expiryType: event.target.value as ExpiryType })}
            >
              <option value="none">No expiry</option>
              <option value="set_date">Set date</option>
              <option value="next_lesson">Expires next lesson</option>
            </select>
          </label>

          {draft.expiryType === "set_date" && (
            <input
              type="date"
              className="practice-expiry-date"
              value={draft.expiryDate}
              aria-label="Expiry date"
              required
              onChange={(event) => onDraftChange({ ...draft, expiryDate: event.target.value })}
            />
          )}

          {videoControl}

          <button type="submit" className="primary-button" disabled={busy || !canSave}>
            {draft.id ? "Save changes" : "Save"}
          </button>

          {/* Only on a new block. Favouriting an edit would keep the corrected
              wording as a template, which is rarely what a correction means. */}
          {!draft.id && (
            <button
              type="button"
              className="practice-star"
              title="Save and add to favourites"
              aria-label="Save and add to favourites"
              disabled={busy || !canSave}
              onClick={() => void submit(true)}
            >
              ★
            </button>
          )}

          <button type="button" className="practice-clear" onClick={onCancelEdit}>
            {draft.id ? "Cancel" : "Clear"}
          </button>
        </div>
      </form>

      <div className={railClass("saved")}>
        <div className="practice-rail-head">
          <strong>{tier === "short" ? "Sav" : "Saved"}</strong>
          {savedHidden > 0 || openRail === "saved" ? (
            <button
              type="button"
              className="practice-rail-more"
              title={openRail === "saved" ? "Close" : `Show all ${shownPresets.length}`}
              onClick={() => setOpenRail((current) => (current === "saved" ? null : "saved"))}
            >
              {openRail === "saved" ? "×" : `+${savedHidden}`}
            </button>
          ) : null}
          <button
            type="button"
            className="practice-rail-edit"
            data-on={editingFavourites ? "1" : undefined}
            title={editingFavourites ? "Done editing favourites" : "Edit favourites"}
            aria-label={editingFavourites ? "Done editing favourites" : "Edit favourites"}
            onClick={() => {
              setEditingFavourites((current) => !current);
              setRenamingId(null);
            }}
          >
            ✎
          </button>
        </div>
        <div className="practice-rail-list">{visiblePresets.map((preset) => favouriteTile(preset, !narrow))}</div>
        {!shownPresets.length && (
          <span className="practice-rail-empty">
            {presets.length ? emptyNote : "Save one with ★"}
          </span>
        )}
        {openRail === "saved" && (
          <div className="practice-rail-popup">{shownPresets.map((preset) => favouriteTile(preset, false))}</div>
        )}
      </div>
    </div>
  );
}

/* --- The flight -------------------------------------------------------------
 *
 * A saved block travels from the composer to its slot on the wall: the frame's
 * own footprint shrinks to brick size, squares off its corners and takes the
 * type colour on the way down. It exists so the wall is understood as where
 * blocks go, once, on the first save -- after that it is a half-second the
 * coach stops noticing.
 *
 * Both rects are measured, never guessed, so it lands exactly where the real
 * brick then appears. It runs on a detached node outside React: nothing about
 * it is state, it cannot be interacted with, and it must not re-render the
 * wall it is flying towards.
 * ------------------------------------------------------------------------- */
function startFlight(id: string, from: DOMRect, blockType: PracticeBlockType, title: string) {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

  window.requestAnimationFrame(() => {
    const target = document.querySelector<HTMLElement>(`[data-brick="${CSS.escape(id)}"]`);
    if (!target) return;

    const card = document.createElement("div");
    card.className = "practice-flight";
    card.dataset.practiceType = blockType;
    card.setAttribute("aria-hidden", "true");
    const label = document.createElement("strong");
    label.textContent = title;
    card.append(label);
    card.style.left = `${from.left}px`;
    card.style.top = `${from.top}px`;
    card.style.width = `${from.width}px`;
    card.style.height = `${from.height}px`;
    document.body.append(card);

    // The brick is held invisible until its stand-in has arrived, so the two
    // are never both on screen.
    target.dataset.pending = "1";

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        // Re-measured here rather than before the frame: laying a brick can
        // start a new course and shove the whole wall down by 73px.
        card.dataset.moving = "1";
        const slot = target.getBoundingClientRect();
        card.style.left = `${slot.left}px`;
        card.style.top = `${slot.top}px`;
        card.style.width = `${slot.width}px`;
        card.style.height = `${slot.height}px`;
      });
    });

    // transitionend fires once per property, and a backstop timer sits behind
    // it so a dropped event can never leave the real brick invisible. Both
    // routes run this, so it has to be idempotent.
    let landed = false;
    const land = () => {
      if (landed) return;
      landed = true;
      card.remove();
      delete target.dataset.pending;
      target.dataset.justLaid = "1";
      window.setTimeout(() => delete target.dataset.justLaid, 700);
    };
    card.addEventListener("transitionend", (event) => {
      if (event.propertyName === "top") land();
    });
    window.setTimeout(land, 900);
  });
}

export default PracticeBlockBuilder;
