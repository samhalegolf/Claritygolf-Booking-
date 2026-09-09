// The client list, owned in one place.
//
// The workspace used to hold this in a useState and refetch it from wherever
// happened to need it, only after the calendar had painted. Here it is a small
// store any screen can read, that can be asked for before the workspace has
// even mounted, and that answers one in-flight request to everyone who asks
// while it is loading. Same shape as modules/practice/practiceStore.

import { useSyncExternalStore } from "react";

import { apiFetch } from "../auth/apiFetch";
import { cleanPeople, type Person } from "./clientsModel";

export type ClientsLoadStatus = "idle" | "loading" | "loaded" | "error";

export type ClientsState = {
  people: Person[];
  status: ClientsLoadStatus;
  /** Set when the last read failed. A stale list stays on screen with it. */
  error: string;
  /** When the list last came from the server. 0 until it has. */
  loadedAt: number;
};

const initialState: ClientsState = { people: [], status: "idle", error: "", loadedAt: 0 };

let state: ClientsState = initialState;
let inFlight: Promise<Person[]> | null = null;
const listeners = new Set<() => void>();

function emit(next: Partial<ClientsState>) {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

export function subscribeClients(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getClientsState() {
  return state;
}

/** The list and its status, for components. Re-renders on every change. */
export function useClientsState() {
  return useSyncExternalStore(subscribeClients, getClientsState, getClientsState);
}

function unauthorizedError() {
  return Object.assign(new Error("Admin login required"), { code: "unauthorized" });
}

/** The session is gone: the caller decides what that means for the screen. */
export function isUnauthorizedClientsError(error: unknown) {
  return Boolean(error) && typeof error === "object" && (error as { code?: string }).code === "unauthorized";
}

/**
 * Read the list from the server. One request at a time: a second call while
 * one is in flight joins it rather than starting another. `maxAgeMs` lets a
 * boot-time caller accept a list that arrived moments ago from a prefetch,
 * instead of asking again; leave it out after a write, when only fresh will do.
 */
export function loadClients(options: { maxAgeMs?: number } = {}): Promise<Person[]> {
  if (inFlight) return inFlight;
  if (options.maxAgeMs && state.loadedAt && Date.now() - state.loadedAt < options.maxAgeMs) {
    return Promise.resolve(state.people);
  }
  // A list already on screen stays "loaded" while it revalidates; only a first
  // read shows as loading.
  emit({ status: state.loadedAt ? "loaded" : "loading", error: "" });
  inFlight = (async () => {
    const response = await apiFetch("/api/people");
    if (response.status === 401) throw unauthorizedError();
    const data = (await response.json().catch(() => ({}))) as { people?: unknown[]; message?: string };
    if (!response.ok) throw new Error(data?.message || `Clients returned ${response.status}.`);
    const people = cleanPeople(Array.isArray(data.people) ? data.people : []);
    emit({ people, status: "loaded", error: "", loadedAt: Date.now() });
    return people;
  })();
  return inFlight
    .catch((error: unknown) => {
      emit({
        status: state.loadedAt ? "loaded" : "error",
        error: error instanceof Error ? error.message : "Could not load clients.",
      });
      throw error;
    })
    .finally(() => {
      inFlight = null;
    });
}

/**
 * Start a read if none has happened yet. Safe to call from the entry point
 * before anything is on screen: a failure here is nobody's problem, because
 * the workspace does its own read when it boots and joins this one if it is
 * still going.
 */
export function prefetchClients() {
  if (inFlight || state.loadedAt) return;
  void loadClients().catch(() => undefined);
}

/** A write answered with the whole list: take it as the new truth. */
export function replaceClients(people: Person[]) {
  emit({ people, status: "loaded", error: "", loadedAt: Date.now() });
}

/**
 * Forget everything. Called when the session ends, so the next person to sign
 * in on this browser -- possibly for a different business -- never sees the
 * previous list, even for a frame.
 */
export function resetClients() {
  inFlight = null;
  emit(initialState);
}
