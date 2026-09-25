/**
 * Clashes in a business's weekly availability: a coach down as working at two
 * locations at the same time. Allowed (Settings warns and lets the coach save
 * anyway), never silent.
 */
type AvailabilityWindowLike = { coachId?: string; locationId?: string; start: number; end: number };

export type AvailabilityConflict = {
  coachId: string;
  day: number;
  start: number;
  end: number;
  locationIds: [string, string];
};

/**
 * Times a coach is down as working at two locations at once. Only windows
 * pinned to different locations clash: a window with no location is the old
 * "anywhere" and says nothing about where the coach is.
 */
export function availabilityConflicts(availability: AvailabilityWindowLike[][], fallbackCoachId: string): AvailabilityConflict[] {
  const conflicts: AvailabilityConflict[] = [];
  availability.forEach((dayWindows, day) => {
    const pinned = dayWindows.filter((window) => window.locationId);
    pinned.forEach((first, firstIndex) => {
      pinned.slice(firstIndex + 1).forEach((second) => {
        if ((first.coachId || fallbackCoachId) !== (second.coachId || fallbackCoachId)) return;
        if (first.locationId === second.locationId) return;
        const start = Math.max(first.start, second.start);
        const end = Math.min(first.end, second.end);
        if (end <= start) return;
        conflicts.push({
          coachId: first.coachId || fallbackCoachId,
          day,
          start,
          end,
          locationIds: [first.locationId || "", second.locationId || ""],
        });
      });
    });
  });
  return conflicts;
}

