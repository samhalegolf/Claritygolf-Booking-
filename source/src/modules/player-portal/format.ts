/** Date formatting shared by the portal's screens and its video shelf. */
export function formatDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** A position in a video, as m:ss. What a screenshot or a timed note is
 *  anchored to -- and the only way back to the moment when the picture itself
 *  did not survive the trip to the cloud. */
export function formatClock(seconds: number) {
  const total = Math.max(0, Math.round(seconds || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
