// A lesson note as the workspace understands it, and the normaliser that turns
// the server's answer into that shape. Moved out of App.tsx so the notes store
// and Player Profiles can exist without importing the whole workspace.

export type LessonNoteSource = "typed" | "voice";

export type LessonNote = {
  id: string;
  accountId: string;
  playerId: string;
  playerName: string;
  lessonId: string;
  calendarItemId: string;
  title: string;
  body: string;
  source: LessonNoteSource;
  createdAt: string;
  updatedAt: string;
};

export type NotesResult = {
  note?: LessonNote;
  notes?: LessonNote[];
};

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value : value == null ? fallback : String(value);
}

export function cleanLessonNote(note: Partial<LessonNote> & { id?: unknown } = {}, fallbackAccountId = ""): LessonNote {
  const createdAt = text(note.createdAt) || new Date().toISOString();
  return {
    id: text(note.id),
    accountId: text(note.accountId) || fallbackAccountId,
    playerId: text(note.playerId),
    playerName: text(note.playerName),
    lessonId: text(note.lessonId),
    calendarItemId: text(note.calendarItemId),
    title: text(note.title) || "Lesson note",
    body: text(note.body),
    source: note.source === "voice" ? "voice" : "typed",
    createdAt,
    updatedAt: text(note.updatedAt) || createdAt,
  };
}

/** Cleaned, without the empties, newest first. */
export function cleanLessonNotes(notes: unknown[], fallbackAccountId = ""): LessonNote[] {
  return notes
    .map((note) => cleanLessonNote((note ?? {}) as Partial<LessonNote>, fallbackAccountId))
    .filter((note) => note.playerId && note.body)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
