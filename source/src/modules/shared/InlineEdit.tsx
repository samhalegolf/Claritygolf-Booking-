import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  initialInlineEdit,
  inlineEditReducer,
  isDirty,
  savedLabel,
  type InlineEditState,
} from "./inlineEditState";

/**
 * Rule 06: Save appears because there is something to save.
 *
 * A row is plain text with a quiet pencil until you touch it. Touch it and the
 * row tints, the field gets a border at the width of its content, and Save and
 * Cancel appear *inside that row* — never in a panel header, never in a page
 * footer. Save, and it goes back to being plain text with "Saved 09:41"
 * fading beside it.
 *
 * The state machine is in ./inlineEditState.ts, which is unit-tested; this file
 * is the presentation and the keyboard.
 *
 * There were four hand-rolled versions of this in App.tsx before this existed
 * (discountEditing, datesEditing, pullRangeEditing, editingInvoiceNumber) plus
 * EditableSettingsBlock, which put Save in a header. This replaces all five.
 */

/* --- One open edit at a time ---------------------------------------------- */

type Registry = {
  openId: string | null;
  open: (id: string, displace: () => void) => void;
  close: (id: string) => void;
};

const InlineEditContext = createContext<Registry | null>(null);

/**
 * Wrap a screen in this and only one row can be open at a time.
 *
 * Starting a second edit commits the first rather than cancelling it. That is
 * the deliberate reading of "commits or cancels": cancelling loses what
 * somebody typed with no way to get it back, while committing is visible — the
 * value changes and a Saved line appears — and reversible by editing again.
 * Silent loss is the worse failure of the two.
 */
export function InlineEditProvider({ children }: { children: ReactNode }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const displacers = useRef(new Map<string, () => void>());

  const open = useCallback((id: string, displace: () => void) => {
    setOpenId((current) => {
      if (current && current !== id) displacers.current.get(current)?.();
      return id;
    });
    displacers.current.set(id, displace);
  }, []);

  const close = useCallback((id: string) => {
    displacers.current.delete(id);
    setOpenId((current) => (current === id ? null : current));
  }, []);

  const value = useMemo(() => ({ openId, open, close }), [openId, open, close]);
  return <InlineEditContext.Provider value={value}>{children}</InlineEditContext.Provider>;
}

/* --- The row --------------------------------------------------------------- */

/** Rule 05 widths, by what the field holds rather than by a number of pixels. */
export type FieldWidth = "time" | "price" | "date" | "name" | "email" | "prose";

export type InlineEditRowProps<T extends string | number> = {
  label: string;
  value: T;
  onSave: (draft: T) => Promise<void> | void;
  /** How the committed value reads at rest. Defaults to the value itself. */
  format?: (value: T) => string;
  width?: FieldWidth;
  /** "hours before a lesson" — sits after the field, inside the edit row. */
  unit?: string;
  type?: "text" | "email" | "tel" | "number" | "date" | "time";
  /** Fixed choices render as a select and commit on change — see AutoSaved. */
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  disabled?: boolean;
};

export function InlineEditRow<T extends string | number>({
  label,
  value,
  onSave,
  format,
  width = "name",
  unit,
  type = "text",
  options,
  placeholder,
  disabled,
}: InlineEditRowProps<T>) {
  const id = useId();
  const registry = useContext(InlineEditContext);
  const [state, dispatch] = useReducer(
    inlineEditReducer as (s: InlineEditState<T>, e: Parameters<typeof inlineEditReducer<T>>[1]) => InlineEditState<T>,
    value,
    initialInlineEdit<T>,
  );
  const fieldRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null);
  const settleRef = useRef<number | null>(null);

  useEffect(() => dispatch({ type: "sync", value }), [value]);

  // The 2s fade. Cleared on unmount so a row that disappears mid-fade does not
  // fire a state update into nothing.
  useEffect(() => {
    if (state.status !== "saved") return;
    settleRef.current = window.setTimeout(() => dispatch({ type: "settle" }), 2000);
    return () => {
      if (settleRef.current !== null) window.clearTimeout(settleRef.current);
    };
  }, [state.status, state.savedAt]);

  const editing = state.status === "editing" || state.status === "failed" || state.status === "saving";

  useEffect(() => {
    if (editing) fieldRef.current?.focus();
  }, [editing]);

  const commit = useCallback(async () => {
    if (!isDirty(state)) {
      dispatch({ type: "save" });
      registry?.close(id);
      return;
    }
    dispatch({ type: "save" });
    try {
      await onSave(state.draft);
      dispatch({ type: "resolved", value: state.draft, at: Date.now() });
      registry?.close(id);
    } catch (error) {
      dispatch({
        type: "rejected",
        error: error instanceof Error ? error.message : "That could not be saved.",
      });
    }
  }, [state, onSave, registry, id]);

  function startEditing() {
    if (disabled) return;
    // Registered before opening, so displacing this row later commits it.
    registry?.open(id, () => void commit());
    dispatch({ type: "edit" });
  }

  function cancel() {
    dispatch({ type: "cancel" });
    registry?.close(id);
  }

  if (!editing) {
    const shown = format ? format(state.value) : String(state.value);
    return (
      <div className={`inline-row${disabled ? " is-locked" : ""}`}>
        <span className="inline-row-label">{label}</span>
        <button
          className="inline-row-value"
          onClick={startEditing}
          disabled={disabled}
          type="button"
          aria-label={`Edit ${label}`}
        >
          {shown || <em>Not set</em>}
        </button>
        {state.status === "saved" ? (
          <span className="inline-saved" aria-live="polite">{savedLabel(state.savedAt)}</span>
        ) : disabled ? null : (
          <span className="inline-row-pencil" aria-hidden="true">✎</span>
        )}
      </div>
    );
  }

  const saving = state.status === "saving";
  return (
    <div className="inline-row is-editing">
      <label className="inline-edit-field">
        <span className="inline-row-label">{label}</span>
        {options ? (
          <select
            ref={(node) => { fieldRef.current = node; }}
            value={String(state.draft)}
            disabled={saving}
            onChange={(event) => dispatch({ type: "change", draft: event.target.value as T })}
            onKeyDown={onKeys}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        ) : (
          <input
            ref={(node) => { fieldRef.current = node; }}
            className={`w-${width}`}
            value={String(state.draft)}
            type={type}
            placeholder={placeholder}
            disabled={saving}
            onChange={(event) =>
              dispatch({ type: "change", draft: (type === "number" ? Number(event.target.value) : event.target.value) as T })
            }
            onKeyDown={onKeys}
          />
        )}
      </label>
      {/* Wraps rather than pushing into the card's padding — Rule 06's "nothing
          inside a box touches its edge". */}
      <div className="inline-edit-actions">
        <button className="primary-button small" disabled={saving} onClick={() => void commit()} type="button">
          {saving ? "Saving…" : "Save"}
        </button>
        <button className="text-button" disabled={saving} onClick={cancel} type="button">
          Cancel
        </button>
        {unit ? <span className="inline-edit-unit">{unit}</span> : null}
      </div>
      {state.error ? (
        <p className="inline-error" role="alert">{state.error}</p>
      ) : null}
    </div>
  );

  /** The buttons are the visible spelling of these two keys. */
  function onKeys(event: React.KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      void commit();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  }
}

/* --- Controls that commit on their own ------------------------------------- */

/**
 * The status line for a toggle, a picker, a drag-to-reorder.
 *
 * Rule 06 is explicit that these get a line, never a Save button: the change
 * already happened the moment you made it, so a Save would be asking you to
 * confirm something that is already true. A failure gets a Retry, because that
 * is the one case where the screen and the server disagree.
 */
export function AutoSaved({
  savedAt,
  error,
  onRetry,
  busy,
}: {
  savedAt: number | null;
  error?: string | null;
  onRetry?: () => void;
  busy?: boolean;
}) {
  if (busy) return <span className="inline-working">Saving…</span>;
  if (error) {
    return (
      <span className="inline-error" role="alert">
        {error}
        {onRetry ? <button className="text-button" onClick={onRetry} type="button">Retry</button> : null}
      </span>
    );
  }
  if (savedAt === null) return null;
  return <span className="inline-saved" aria-live="polite">{savedLabel(savedAt)}</span>;
}
