// Every lesson note in the workspace, owned in one place.
//
// Player Profiles promotes a client to a profile when a note references them,
// so the list of profiles cannot be right until the notes have answered. That
// makes this the other half of the client list: same store shape, prefetched
// by the entry point for a returning coach, one request shared by everyone
// who asks while it is in flight.

import { createRemoteListStore, isUnauthorizedError, type RemoteListStatus } from "../shared/remoteListStore";
import { cleanLessonNotes, type LessonNote } from "./lessonNotesModel";

export type LessonNotesLoadStatus = RemoteListStatus;

export type LessonNotesState = {
  notes: LessonNote[];
  status: LessonNotesLoadStatus;
  error: string;
  loadedAt: number;
};

const store = createRemoteListStore<LessonNote>({
  path: "/api/notes",
  rows: (data) => data.notes as unknown[],
  clean: (rows) => cleanLessonNotes(rows),
  failure: "Could not load lesson notes.",
});

let cached: LessonNotesState | null = null;
let cachedFrom = store.getState();
export function getLessonNotesState(): LessonNotesState {
  const current = store.getState();
  if (!cached || current !== cachedFrom) {
    cachedFrom = current;
    cached = { notes: current.items, status: current.status, error: current.error, loadedAt: current.loadedAt };
  }
  return cached;
}

export const subscribeLessonNotes = store.subscribe;

/** The notes and their status, for components. Re-renders on every change. */
export function useLessonNotesState(): LessonNotesState {
  store.useState();
  return getLessonNotesState();
}

export const isUnauthorizedNotesError = isUnauthorizedError;
export const loadLessonNotes = store.load;
export const prefetchLessonNotes = store.prefetch;
export const replaceLessonNotes = store.replace;
export const resetLessonNotes = store.reset;
