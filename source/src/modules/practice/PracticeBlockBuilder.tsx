import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";

import {
  practiceOfferedTypes,
  practiceRailLabel,
  practiceSteps,
  practiceTypeHasField,
  practiceTypeMeta,
  type ExpiryType,
  type PracticeBlockType,
  type PracticePreset,
  type PracticeSuggestion,
  type PracticeTypeMeta,
} from "./practiceModel";
import { practiceDraftIsWritten, type PracticeDraft } from "./practiceStore";

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
  /** The account's own kinds of block, already resolved and un-archived. */
  types: PracticeTypeMeta[];
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
  /** First read still in flight. The form works without it; the rails don't. */
  loading?: boolean;
  /** Rendered into the action row -- the video picker, which is the panel's. */
  videoControl?: React.ReactNode;
};

export function PracticeBlockBuilder({
  draft,
  onDraftChange,
  types,
  presets,
  suggestions,
  busy,
  onSave,
  onCancelEdit,
  onRenamePreset,
  onRemovePreset,
  onReorderPresets,
  onDismissSuggestion,
  loading = false,
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
  const offered = useMemo(() => practiceOfferedTypes(types), [types]);
  const typeMeta = practiceTypeMeta(types, draft.blockType);
  const tone = typeMeta.tone;
  /* Which halves of the composer this kind offers. A type with steps switched
   * off still has a body -- it is one box instead of a numbered list, because
   * "no steps" means "don't make me number a single instruction", not "no
   * instructions". */
  const showSteps = practiceTypeHasField(typeMeta, "steps");
  const showDose = practiceTypeHasField(typeMeta, "dose");
  const showExpiry = practiceTypeHasField(typeMeta, "expiry");
  const showVideo = practiceTypeHasField(typeMeta, "video");

  /* The last type in the list is picked out on its own at the right, the way
   * "Custom" always was: the ones before it are the shapes a coach reaches
   * for, and the last is the escape hatch. With one type there is no strip to
   * split and it simply sits alone. */
  const stripTypes = offered.length > 1 ? offered.slice(0, -1) : offered;
  const lastType = offered.length > 1 ? offered[offered.length - 1] : null;

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
      const from = frameRef.current?.getBoundingClientRect() ?? null;
      const savedId = await onSave(draft, alsoFavourite);

      /* Hold the composer still.
       *
       * Saving changes the height of everything above the fold at once: the
       * composer collapses back to one empty step, and the wall below it gains
       * a brick and sometimes a whole new course. A coach scrolled down to the
       * composer would find the page had moved several hundred pixels under
       * them, which reads as being thrown out of Practice rather than as a
       * successful save. Measured either side and corrected, so from the
       * coach's point of view the composer does not move at all.
       *
       * After a frame, so React has painted the new heights -- and before the
       * flight, whose start and end rects are both viewport-relative and would
       * otherwise be measured against two different scroll positions.
       */
      window.requestAnimationFrame(() => {
        if (from && frameRef.current) {
          const drift = frameRef.current.getBoundingClientRect().top - from.top;
          if (Math.abs(drift) > 1) window.scrollBy(0, drift);
        }
        if (savedId && from) startFlight(savedId, from, tone, draft.title.trim() || typeMeta.titleHint);
      });
    },
    [busy, canSave, draft, onSave, tone, typeMeta.titleHint],
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
        style={{ "--practice-tone": practiceTypeMeta(types, suggestion.blockType).tone } as CSSProperties}
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
          style={{ "--practice-tone": practiceTypeMeta(types, preset.blockType).tone } as CSSProperties}
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
        {/* Silence, not "none yet", until the read lands -- otherwise every
            open of the tab flashes an empty state that turns out to be wrong. */}
        {!shownSuggestions.length && !loading && <span className="practice-rail-empty">{emptyNote}</span>}
        {openRail === "often" && <div className="practice-rail-popup">{shownSuggestions.map(suggestionTile)}</div>}
      </div>

      <form className="practice-form" onSubmit={onSubmit}>
        <div className="practice-type-strip">
          <div className="practice-type-tabs">
            {stripTypes.map((type) => (
              <button
                type="button"
                key={type.id}
                className="practice-type-tab"
                data-practice-type={type.id}
                style={{ "--practice-tone": type.tone } as CSSProperties}
                data-on={draft.blockType === type.id ? "1" : undefined}
                aria-pressed={draft.blockType === type.id}
                title={type.hint ? `${type.label} — ${type.hint}` : type.label}
                onClick={() => onDraftChange({ ...draft, blockType: type.id })}
              >
                <strong>{type.label}</strong>
              </button>
            ))}
          </div>
          {lastType && (
            <button
              type="button"
              className="practice-type-tab practice-type-tab-custom"
              data-practice-type={lastType.id}
              style={{ "--practice-tone": lastType.tone } as CSSProperties}
              data-on={draft.blockType === lastType.id ? "1" : undefined}
              aria-pressed={draft.blockType === lastType.id}
              title={lastType.hint ? `${lastType.label} — ${lastType.hint}` : lastType.label}
              onClick={() => onDraftChange({ ...draft, blockType: lastType.id })}
            >
              <strong>{lastType.label}</strong>
            </button>
          )}
        </div>

        <div
          className="practice-frame"
          data-practice-type={draft.blockType}
          style={{ "--practice-tone": typeMeta.tone } as CSSProperties}
          ref={frameRef}
        >
          <input
            className="practice-title-input"
            value={draft.title}
            onChange={(event) => onDraftChange({ ...draft, title: event.target.value })}
            placeholder={typeMeta.titleHint}
            maxLength={200}
            aria-label="Block title"
          />

          <div className="practice-steps">
            {(showSteps ? draft.steps : draft.steps.slice(0, 1)).map((step, index) => (
              <div className="practice-step" key={step.id}>
                {showSteps && (
                  <span className="practice-step-number" aria-hidden="true">
                    {index + 1}
                  </span>
                )}
                <textarea
                  rows={showSteps ? 2 : 4}
                  value={step.text}
                  onChange={(event) => setStepText(step.id, event.target.value)}
                  placeholder={
                    !showSteps ? "What to practise." : index === 0 ? "What to do, in one instruction." : "Then…"
                  }
                  aria-label={showSteps ? `Step ${index + 1}` : "What to practise"}
                />
                {showDose && index === 0 && (
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
                {showSteps && draft.steps.length > 1 && (
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
            {showSteps && (
              <button type="button" className="practice-step-add" onClick={addStep}>
                + Add step
              </button>
            )}
          </div>
        </div>

        <div className="practice-actions">
          {showExpiry ? (
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
          ) : (
            // Nothing to decide, but the row still needs its left edge pushed
            // out so the buttons stay where they always are.
            <span className="practice-actions-spacer" />
          )}

          {showExpiry && draft.expiryType === "set_date" && (
            <input
              type="date"
              className="practice-expiry-date"
              value={draft.expiryDate}
              aria-label="Expiry date"
              required
              onChange={(event) => onDraftChange({ ...draft, expiryDate: event.target.value })}
            />
          )}

          {showVideo && videoControl}

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
        {!shownPresets.length && !loading && (
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
function startFlight(id: string, from: DOMRect, tone: string, title: string) {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

  window.requestAnimationFrame(() => {
    const target = document.querySelector<HTMLElement>(`[data-brick="${CSS.escape(id)}"]`);
    if (!target) return;

    const card = document.createElement("div");
    card.className = "practice-flight";
    card.dataset.practiceType = "flight";
    card.style.setProperty("--practice-tone", tone);
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
