// Device-local state for Player Profiles.
//
// A "player profile" is a client who has notes or a stored video, or who has
// been manually promoted. Manual promotions and activity timestamps are kept in
// localStorage (per-device), consistent with the on-device video storage model.
// Nothing here touches the backend.

const MANUAL_KEY = "clarity.playerProfiles.manual";
const NOTES_STAMP_KEY = "clarity.playerProfiles.notesStamp";
const CREATED_STAMP_KEY = "clarity.playerProfiles.created";

export interface PlayerProfilesLocalState {
  manualIds: string[];
  notesStamps: Record<string, string>;
  createdStamps: Record<string, string>;
}

const readJson = <T>(key: string, fallback: T): T => {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const writeJson = (key: string, value: unknown) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore; profile hints are a best-effort convenience.
  }
};

export const loadPlayerProfilesState = (): PlayerProfilesLocalState => ({
  manualIds: readJson<string[]>(MANUAL_KEY, []),
  notesStamps: readJson<Record<string, string>>(NOTES_STAMP_KEY, {}),
  createdStamps: readJson<Record<string, string>>(CREATED_STAMP_KEY, {}),
});

export const addManualPlayer = (
  state: PlayerProfilesLocalState,
  id: string
): PlayerProfilesLocalState => {
  if (!id || state.manualIds.includes(id)) return state;
  const manualIds = [...state.manualIds, id];
  const createdStamps = state.createdStamps[id]
    ? state.createdStamps
    : { ...state.createdStamps, [id]: new Date().toISOString() };
  writeJson(MANUAL_KEY, manualIds);
  writeJson(CREATED_STAMP_KEY, createdStamps);
  return { ...state, manualIds, createdStamps };
};

export const stampNotesUpdate = (
  state: PlayerProfilesLocalState,
  id: string
): PlayerProfilesLocalState => {
  if (!id) return state;
  const notesStamps = { ...state.notesStamps, [id]: new Date().toISOString() };
  writeJson(NOTES_STAMP_KEY, notesStamps);
  return { ...state, notesStamps };
};
