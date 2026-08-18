/**
 * Rule 06's state machine, on its own so it can be tested without a browser.
 *
 * Three states a coach ever sees — resting, editing, saved — plus the two the
 * machine needs to be honest about the network: saving, and failed.
 *
 *   resting → editing    a pencil, or a keystroke on a focused row
 *   editing → resting    Escape, or Cancel
 *   editing → saving     Enter, or Save
 *   saving  → saved      committed; falls back to resting after 2s
 *   saving  → failed     stays put with the draft intact and a Retry
 *
 * The rules this encodes that are easy to get wrong:
 *
 *   A panel at rest never shows Save, disabled or otherwise. There is no
 *   `canSave` in the resting state because there is no button to grey out.
 *
 *   Saving an unchanged value is not a save. It resolves straight back to
 *   resting without touching the network or flashing "Saved" — a confirmation
 *   for something that did not happen teaches you to distrust the next one.
 *
 *   A failure keeps the draft. Losing what somebody typed because the network
 *   blinked is the one outcome with no recovery.
 */

export type InlineEditStatus = "resting" | "editing" | "saving" | "saved" | "failed";

export type InlineEditState<T> = {
  status: InlineEditStatus;
  /** What is committed — what the row shows at rest. */
  value: T;
  /** What is being typed. Equal to `value` outside an edit. */
  draft: T;
  /** When the last save landed, for the fading "Saved 09:41". */
  savedAt: number | null;
  error: string | null;
};

export type InlineEditEvent<T> =
  | { type: "edit" }
  | { type: "change"; draft: T }
  | { type: "cancel" }
  | { type: "save" }
  | { type: "resolved"; value: T; at: number }
  | { type: "rejected"; error: string }
  | { type: "settle" }
  /** The committed value changed underneath us — a reload, another device. */
  | { type: "sync"; value: T };

export function initialInlineEdit<T>(value: T): InlineEditState<T> {
  return { status: "resting", value, draft: value, savedAt: null, error: null };
}

const same = (a: unknown, b: unknown) => Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b);

export function isDirty<T>(state: InlineEditState<T>) {
  return !same(state.draft, state.value);
}

export function inlineEditReducer<T>(
  state: InlineEditState<T>,
  event: InlineEditEvent<T>,
): InlineEditState<T> {
  switch (event.type) {
    case "edit":
      // Re-entering an edit clears a stale "Saved" — two confirmations for one
      // change reads as two changes.
      if (state.status === "saving") return state;
      return { ...state, status: "editing", draft: state.value, savedAt: null, error: null };

    case "change":
      if (state.status !== "editing" && state.status !== "failed") return state;
      return { ...state, status: "editing", draft: event.draft, error: null };

    case "cancel":
      if (state.status === "saving") return state;
      return { ...state, status: "resting", draft: state.value, error: null };

    case "save":
      if (state.status === "saving") return state;
      // Nothing changed, so nothing is saved and nothing is claimed.
      if (!isDirty(state)) return { ...state, status: "resting", error: null };
      return { ...state, status: "saving", error: null };

    case "resolved":
      return {
        status: "saved",
        value: event.value,
        draft: event.value,
        savedAt: event.at,
        error: null,
      };

    case "rejected":
      // Draft survives. The row stays open so the fix is where the mistake is.
      return { ...state, status: "failed", error: event.error };

    case "settle":
      // The 2s fade. Only from "saved" — never yank a row out of an edit.
      return state.status === "saved" ? { ...state, status: "resting" } : state;

    case "sync":
      // An outside change wins only when nobody is mid-edit; otherwise it would
      // pull the ground out from under whoever is typing.
      if (state.status === "editing" || state.status === "saving" || state.status === "failed") {
        return { ...state, value: event.value };
      }
      return { ...state, value: event.value, draft: event.value };

    default:
      return state;
  }
}

/**
 * "Saved 09:41".
 *
 * A clock time rather than "just now", because the line outlives the moment:
 * on a control that commits on its own (a toggle, a picker) it is the only
 * record that anything happened, and "just now" stops being true a minute
 * later without anyone updating it.
 */
export function savedLabel(savedAt: number | null) {
  if (savedAt === null) return "";
  const stamp = new Date(savedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `Saved ${stamp}`;
}
