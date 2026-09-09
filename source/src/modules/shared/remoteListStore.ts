// A list the server owns and the app reads: one copy, one request at a time,
// readable before anything is on screen. Clients and lesson notes are both
// this shape, and Player Profiles wants both before it is worth looking at, so
// the machinery lives here once and each list is a few lines on top.

import { useSyncExternalStore } from "react";

import { apiFetch } from "../auth/apiFetch";

export type RemoteListStatus = "idle" | "loading" | "loaded" | "error";

export type RemoteListState<T> = {
  items: T[];
  status: RemoteListStatus;
  /** Set when the last read failed. A stale list stays on screen with it. */
  error: string;
  /** When the list last came from the server. 0 until it has. */
  loadedAt: number;
};

export type RemoteListStore<T> = {
  subscribe: (listener: () => void) => () => void;
  getState: () => RemoteListState<T>;
  /** The list and its status, for components. Re-renders on every change. */
  useState: () => RemoteListState<T>;
  /**
   * Read the list from the server. One request at a time: a second call while
   * one is in flight joins it rather than starting another. `maxAgeMs` lets a
   * boot-time caller accept a list that arrived moments ago from a prefetch
   * instead of asking again; leave it out after a write, when only fresh will do.
   */
  load: (options?: { maxAgeMs?: number }) => Promise<T[]>;
  /**
   * Start a read if none has happened yet. Safe to call from the entry point
   * before anything is on screen: a failure here is nobody's problem, because
   * the workspace does its own read when it boots and joins this one if it is
   * still going.
   */
  prefetch: () => void;
  /** A write answered with the whole list: take it as the new truth. */
  replace: (items: T[]) => void;
  /**
   * Forget everything. Called when the session ends, so the next person to
   * sign in on this browser -- possibly for a different business -- never
   * sees the previous list, even for a frame.
   */
  reset: () => void;
};

function unauthorizedError() {
  return Object.assign(new Error("Admin login required"), { code: "unauthorized" });
}

/** The session is gone: the caller decides what that means for the screen. */
export function isUnauthorizedError(error: unknown) {
  return Boolean(error) && typeof error === "object" && (error as { code?: string }).code === "unauthorized";
}

export function createRemoteListStore<T>(config: {
  /** The GET route that answers with the list. */
  path: string;
  /** Where in the answer the raw rows are. */
  rows: (data: Record<string, unknown>) => unknown[];
  /** The rows, cleaned into the app's shape. */
  clean: (rows: unknown[]) => T[];
  /** What to say when the server gave no reason. */
  failure: string;
}): RemoteListStore<T> {
  const initialState: RemoteListState<T> = { items: [], status: "idle", error: "", loadedAt: 0 };
  let state = initialState;
  let inFlight: Promise<T[]> | null = null;
  const listeners = new Set<() => void>();

  function emit(next: Partial<RemoteListState<T>>) {
    state = { ...state, ...next };
    listeners.forEach((listener) => listener());
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  const getState = () => state;

  function load(options: { maxAgeMs?: number } = {}): Promise<T[]> {
    if (inFlight) return inFlight;
    if (options.maxAgeMs && state.loadedAt && Date.now() - state.loadedAt < options.maxAgeMs) {
      return Promise.resolve(state.items);
    }
    // A list already on screen stays "loaded" while it revalidates; only a
    // first read shows as loading.
    emit({ status: state.loadedAt ? "loaded" : "loading", error: "" });
    inFlight = (async () => {
      const response = await apiFetch(config.path);
      if (response.status === 401) throw unauthorizedError();
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(typeof data?.message === "string" ? data.message : `${config.failure} (${response.status}).`);
      }
      const rows = config.rows(data);
      const items = config.clean(Array.isArray(rows) ? rows : []);
      emit({ items, status: "loaded", error: "", loadedAt: Date.now() });
      return items;
    })();
    return inFlight
      .catch((error: unknown) => {
        emit({
          status: state.loadedAt ? "loaded" : "error",
          error: error instanceof Error ? error.message : config.failure,
        });
        throw error;
      })
      .finally(() => {
        inFlight = null;
      });
  }

  return {
    subscribe,
    getState,
    useState: () => useSyncExternalStore(subscribe, getState, getState),
    load,
    prefetch: () => {
      if (inFlight || state.loadedAt) return;
      void load().catch(() => undefined);
    },
    replace: (items) => emit({ items, status: "loaded", error: "", loadedAt: Date.now() }),
    reset: () => {
      inFlight = null;
      emit(initialState);
    },
  };
}
