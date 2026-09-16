import { useEffect, useRef, useState } from "react";

/**
 * Where a navigation snapshot lives on a history entry. Namespaced because the
 * entry is shared: the checkout cleanup in PlayerPortal and the login cleanup
 * both call replaceState on it too.
 */
const NAV_KEY = "clarityNav";

/** A snapshot, plus where in our own trail the entry carrying it sits. */
type NavEntry<T> = { at: number; state: T };

/**
 * Give an in-app view switch, and every modal over it, its own browser history
 * entry.
 *
 * Neither shell is a router -- the screen is React state -- so until this hook
 * every screen shared the single entry the page loaded with, and Back left the
 * app outright: from Settings, from a player's notes, from anywhere. Each
 * distinct navigation state now pushes an entry carrying a snapshot of itself,
 * and Back hands that snapshot back instead of unloading the page. Back from
 * the first screen still leaves, which is what a browser is supposed to do.
 *
 * The URL is deliberately untouched. Reload behaviour, the booking-widget and
 * embed parameters, and the post-login URL cleanups all read the query string,
 * and none of them should change meaning because someone opened a tab.
 *
 * `state` must be JSON-serialisable: it is cloned into the history entry, and
 * its serialisation is also what decides that a navigation happened at all.
 */
export function useBackNavigation<T>(options: {
  /** The navigation state as it stands this render. */
  state: T;
  /** Put the shell back into a state a previous entry recorded. */
  restore: (state: T) => void;
  /**
   * How many dismissible layers -- modals, sheets, popovers -- a state has
   * open. A state that closes one is a step back rather than a step forward:
   * see the collapse below. Shells with no layers can leave this out.
   */
  depth?: (state: T) => number;
  /** False while the shell has nowhere to navigate -- the booking widget. */
  enabled?: boolean;
}) {
  const { state, restore, depth, enabled = true } = options;
  const serialized = JSON.stringify(state ?? null);
  // Refs, not state: these steer the effects below and must not re-run them,
  // and nothing renders from them.
  const restoreRef = useRef(restore);
  const depthRef = useRef(depth);
  const stateRef = useRef(state);
  // The snapshots of the entries this hook has written, and which one we are
  // standing on. The browser will not tell us either, so we keep our own copy
  // and stamp the index into each entry to find our place again after a pop.
  const trailRef = useRef<string[]>([]);
  const atRef = useRef(-1);
  const lastRef = useRef<string | null>(null);
  const poppingRef = useRef(false);
  restoreRef.current = restore;
  depthRef.current = depth;
  stateRef.current = state;
  // A restore the shell refuses -- Back onto a screen that has since gone away,
  // or a modal that will not close over an unsaved edit -- leaves the state
  // exactly as it was, so the entry-writing effect below would never run and
  // the entry would keep describing a screen nobody is on. Counting pops gives
  // that effect a reason to run either way.
  const [popTick, setPopTick] = useState(0);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    function handlePop(event: PopStateEvent) {
      const entry = (event.state as Record<string, unknown> | null)?.[NAV_KEY] as NavEntry<T> | undefined;
      // No snapshot means the entry predates the shell -- the page the app was
      // opened from. The browser is leaving and there is nothing to restore.
      if (!entry) return;
      atRef.current = entry.at;
      lastRef.current = JSON.stringify(entry.state);
      poppingRef.current = true;
      setPopTick((tick) => tick + 1);
      restoreRef.current(entry.state);
    }
    window.addEventListener("popstate", handlePop);
    return () => window.removeEventListener("popstate", handlePop);
  }, [enabled]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    if (lastRef.current === serialized) {
      poppingRef.current = false;
      return;
    }

    // Closing a modal by hand lands on the state the entry underneath already
    // describes. Stepping back onto that entry rather than stacking a copy of
    // it is what makes the close button and Back agree: without this, closing
    // a modal would leave an entry whose only effect is to reopen it, and Back
    // would appear to do nothing.
    const measure = depthRef.current;
    const previous = atRef.current > 0 ? trailRef.current[atRef.current - 1] : undefined;
    if (!poppingRef.current && measure && lastRef.current !== null && previous === serialized) {
      const closedALayer = measure(JSON.parse(lastRef.current) as T) > measure(stateRef.current);
      if (closedALayer) {
        // lastRef is left alone: the pop this triggers reports the entry it
        // lands on, and settles everything from there.
        window.history.back();
        return;
      }
    }

    // A layer that refused to close -- an unsaved edit the coach chose to keep
    // -- means the Back press must not count for anything. The entry it
    // consumed goes back on, so both the screen and the history stay where they
    // were and the next Back asks the same question again.
    //
    // A restore refused for the other reason, a destination that no longer
    // exists, is not the same thing and must not do this: pushing there would
    // put the dead screen back in front of the coach every time they pressed
    // Back. That one falls through to the rewrite below, and Back keeps going.
    const popped = poppingRef.current && lastRef.current !== null ? (JSON.parse(lastRef.current) as T) : null;
    const layerRefused = popped !== null && measure ? measure(stateRef.current) > measure(popped) : false;

    // Otherwise: a restore already stands on its own entry, and the first state
    // the shell settles on owns the entry the page loaded with, so both mark
    // where they are rather than stacking a duplicate.
    const replace = !layerRefused && (atRef.current < 0 || poppingRef.current);
    const at = replace ? Math.max(atRef.current, 0) : atRef.current + 1;
    // Merged rather than replaced: whatever else is on the entry is not ours.
    const entry = {
      ...(window.history.state as object | null),
      [NAV_KEY]: { at, state: JSON.parse(serialized) } satisfies NavEntry<T>,
    };
    if (replace) window.history.replaceState(entry, "");
    else window.history.pushState(entry, "");
    // Anything ahead of here is either gone (a push drops the forward stack) or
    // no longer describes what its entry holds (a rewrite), so stop modelling
    // it. An unmodelled entry still restores; it just cannot collapse.
    trailRef.current = trailRef.current.slice(0, at);
    trailRef.current[at] = serialized;
    atRef.current = at;
    lastRef.current = serialized;
    poppingRef.current = false;
  }, [enabled, popTick, serialized]);
}
