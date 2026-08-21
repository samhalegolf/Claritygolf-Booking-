// Local-only notes a guest player keeps for themselves.
//
// Modeled on clarityVoiceVocabularyStore.ts: no IndexedDB, no server round
// trip -- these are the guest's own scratch notes, stored on-device only,
// separate from the coach-authored "Lesson notes" a signed-in player sees
// (those come from GET /api/player/profile and never touch localStorage).

export type GuestNote = {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export const GUEST_NOTES_STORAGE_KEY = "clarity.guest.notes.v1";

export function listGuestNotes(storageKey = GUEST_NOTES_STORAGE_KEY): GuestNote[] {
  const storage = getStorage();
  if (!storage) return [];
  const raw = storage.getItem(storageKey);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isGuestNoteLike).map((note) => ({
      id: String(note.id),
      title: String(note.title || "").trim(),
      body: String(note.body || ""),
      createdAt: String(note.createdAt || new Date().toISOString()),
      updatedAt: String(note.updatedAt || note.createdAt || new Date().toISOString()),
    }));
  } catch {
    return [];
  }
}

function persistGuestNotes(notes: GuestNote[], storageKey = GUEST_NOTES_STORAGE_KEY): void {
  const storage = getStorage();
  if (!storage) return;
  storage.setItem(storageKey, JSON.stringify(notes));
}

/** Creates a note when `id` is omitted, otherwise updates the matching one. */
export function saveGuestNote(
  input: { id?: string; title: string; body: string },
  storageKey = GUEST_NOTES_STORAGE_KEY,
): GuestNote[] {
  const now = new Date().toISOString();
  const title = input.title.trim();
  const body = input.body.trim();
  const current = listGuestNotes(storageKey);
  const next = input.id
    ? current.map((note) => (note.id === input.id ? { ...note, title, body, updatedAt: now } : note))
    : [{ id: createGuestNoteId(), title, body, createdAt: now, updatedAt: now }, ...current];
  persistGuestNotes(next, storageKey);
  return next;
}

export function deleteGuestNote(id: string, storageKey = GUEST_NOTES_STORAGE_KEY): GuestNote[] {
  const next = listGuestNotes(storageKey).filter((note) => note.id !== id);
  persistGuestNotes(next, storageKey);
  return next;
}

function createGuestNoteId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `guest-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function isGuestNoteLike(value: unknown): value is GuestNote {
  return Boolean(value && typeof value === "object" && "id" in value && "title" in value && "body" in value);
}
