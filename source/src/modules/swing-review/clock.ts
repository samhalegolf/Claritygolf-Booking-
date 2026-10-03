/** 75.4 -> "1:15". Whole seconds: these label moments in a swing video, and a
 *  tenth of a second is the snapshot's job, not the label's. */
export function formatClock(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** "1:15", "75" or "1:02:03" -> seconds. Null for anything else, so an
 *  unreadable time is refused rather than read as zero. */
export function parseClock(value: string): number | null {
  const typed = value.trim();
  if (!typed) return null;
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(typed)) return null;
  const parts = typed.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.slice(1).some((part) => part >= 60)) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}
