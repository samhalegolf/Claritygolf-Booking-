import { useEffect, useRef, useState } from "react";

/**
 * Where a navigation snapshot lives on a history entry. Namespaced because the
 * entry is shared: the checkout cleanup in PlayerPortal and the login cleanup
 * both call replaceState on it too.
 */
const NAV_KEY = "clarityNav";

/**
 * Give an in-app view switch its own browser history entry.
 *
 * Neither shell is a router -- the view is React state -- so until this hook
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
  /** False while the shell has nowhere to navigate -- the booking widget. */
  enabled?: boolean;
}) {
  const { state, restore, enabled = true } = options;
  const serialized = JSON.stringify(state ?? null);
  // Refs, not state: these steer the effects below and must not re-run them,
  // and nothing renders from them.
  const restoreRef = useRef(restore);
  const lastRef = useRef<string | null>(null);
  const poppingRef = useRef(false);
  restoreRef.current = restore;
  // A restore the shell refuses -- Back onto a screen that has since gone away
  // -- leaves the state exactly as it was, so the entry-writing effect below
  // would never run and the entry would keep describing a screen nobody can
  // reach. Counting pops gives that effect a reason to run either way.
  const [popTick, setPopTick] = useState(0);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    function handlePop(event: PopStateEvent) {
      const entry = (event.state as Record<string, unknown> | null)?.[NAV_KEY];
      // No snapshot means the entry predates the shell -- the page the app was
      // opened from. The browser is leaving and there is nothing to restore.
      if (entry === undefined) return;
      lastRef.current = JSON.stringify(entry);
      poppingRef.current = true;
      setPopTick((tick) => tick + 1);
      restoreRef.current(entry as T);
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
    // Merged rather than replaced: whatever else is on the entry is not ours.
    const entry = { ...(window.history.state as object | null), [NAV_KEY]: JSON.parse(serialized) };
    if (lastRef.current === null || poppingRef.current) {
      // The first state the shell settles on owns the entry the page loaded
      // with, and a restore is already standing on the entry it came from:
      // both mark where they are rather than stacking a duplicate.
      window.history.replaceState(entry, "");
    } else {
      window.history.pushState(entry, "");
    }
    lastRef.current = serialized;
    poppingRef.current = false;
  }, [enabled, popTick, serialized]);
}
