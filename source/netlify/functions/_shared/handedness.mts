/**
 * A player's handedness, as chosen on the public booking page.
 *
 * It travels on the appointment as the first line of `note` rather than as its
 * own calendar_items column. The note already survives every path an
 * appointment takes (public save, whole-calendar save, reschedule, the Optix
 * sweep's row read), whereas a new field would have to be carried by each of
 * those normalisers or be silently dropped by the next calendar save. It also
 * puts the handedness in front of the coach on the card, and a coach who edits
 * the line edits the bay choice with it.
 */
export type Handedness = "right" | "left";

const HANDEDNESS_LINE = /^\s*Handedness:\s*(left|right)\b/im;

export function cleanHandedness(value: unknown): Handedness {
  return String(value || "").trim().toLowerCase() === "left" ? "left" : "right";
}

export function handednessNoteLine(handedness: Handedness): string {
  return `Handedness: ${handedness === "left" ? "Left" : "Right"}`;
}

/** Null when the note says nothing, so callers can tell "right" from "unknown". */
export function handednessFromNote(note: unknown): Handedness | null {
  const match = HANDEDNESS_LINE.exec(String(note || ""));
  return match ? cleanHandedness(match[1]) : null;
}
