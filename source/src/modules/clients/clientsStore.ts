// The client list, owned in one place.
//
// The workspace used to hold this in a useState and refetch it from wherever
// happened to need it, only after the calendar had painted. Here it is a small
// store any screen can read, that can be asked for before the workspace has
// even mounted, and that answers one in-flight request to everyone who asks
// while it is loading. The machinery is modules/shared/remoteListStore; lesson
// notes use the same one.

import { createRemoteListStore, isUnauthorizedError, type RemoteListStatus } from "../shared/remoteListStore";
import { cleanPeople, type Person } from "./clientsModel";

export type ClientsLoadStatus = RemoteListStatus;

export type ClientsState = {
  people: Person[];
  status: ClientsLoadStatus;
  error: string;
  loadedAt: number;
};

const store = createRemoteListStore<Person>({
  path: "/api/people",
  rows: (data) => data.people as unknown[],
  clean: (rows) => cleanPeople(rows),
  failure: "Could not load clients.",
});

function toClientsState(): ClientsState {
  const { items, status, error, loadedAt } = store.getState();
  return { people: items, status, error, loadedAt };
}

// The list is kept under its own name -- "people" is what every reader in the
// workspace already calls it -- so the wrapper below is the one place the two
// vocabularies meet.
let cached: ClientsState = toClientsState();
let cachedFrom = store.getState();
export function getClientsState(): ClientsState {
  const current = store.getState();
  if (current !== cachedFrom) {
    cachedFrom = current;
    cached = toClientsState();
  }
  return cached;
}

export const subscribeClients = store.subscribe;

/** The list and its status, for components. Re-renders on every change. */
export function useClientsState(): ClientsState {
  // Same object for the same underlying state, or useSyncExternalStore loops.
  store.useState();
  return getClientsState();
}

export const isUnauthorizedClientsError = isUnauthorizedError;
export const loadClients = store.load;
export const prefetchClients = store.prefetch;
export const replaceClients = store.replace;
export const resetClients = store.reset;
