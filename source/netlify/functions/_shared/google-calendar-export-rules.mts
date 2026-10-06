/**
 * Selective event export: which of a coach's Clarity items go to their Google
 * Calendar, and how much of a lesson the event shows.
 *
 * The other half of selective import. Before this, every lesson, block and
 * unavailable hour went across. A coach who shares their Google calendar with
 * family, or who only wants lessons there and not their admin blocks, had no
 * way to say so.
 *
 * Anything that stops passing these rules is deleted from Google on the next
 * sync, through the same path a cancelled booking already takes.
 *
 * Pure module: no network, no database. Give it an item and the rules and it
 * says yes or no.
 */

export type GoogleCalendarExportRules = {
  /** Booked lessons. */
  lessons: boolean;
  /** Blocked time made in Clarity. */
  blocks: boolean;
  /** The weekly hours outside the coach's availability. */
  unavailable: boolean;
  /** Lesson types that stay off Google, by service id. Empty sends them all. */
  excludedServiceIds: string[];
  /** Client name, phone and email on lesson events. Off sends "Lesson" and the lesson type only. */
  clientDetails: boolean;
};

export const defaultGoogleCalendarExportRules: GoogleCalendarExportRules = {
  lessons: true,
  blocks: true,
  unavailable: true,
  excludedServiceIds: [],
  clientDetails: true,
};

/** Missing or malformed fields fall back to the default, which is everything — what sync did before rules existed. */
export function normalizeGoogleCalendarExportRules(raw: unknown): GoogleCalendarExportRules {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const flag = (key: keyof GoogleCalendarExportRules) =>
    typeof value[key] === "boolean" ? (value[key] as boolean) : (defaultGoogleCalendarExportRules[key] as boolean);
  const excluded = Array.isArray(value.excludedServiceIds) ? value.excludedServiceIds : [];
  return {
    lessons: flag("lessons"),
    blocks: flag("blocks"),
    unavailable: flag("unavailable"),
    excludedServiceIds: [...new Set(excluded.filter((id): id is string => typeof id === "string" && id.trim() !== "").map((id) => id.trim()))],
    clientDetails: flag("clientDetails"),
  };
}

/** Whether the rules let this item onto Google. Busy-ness (cancelled, imported) is decided separately. */
export function exportRulesAllow(item: { kind?: string; serviceId?: string } | null | undefined, rules: GoogleCalendarExportRules) {
  if (!item) return false;
  if (item.kind === "unavailable") return rules.unavailable;
  if (item.kind === "block") return rules.blocks;
  if (!rules.lessons) return false;
  return !(item.serviceId && rules.excludedServiceIds.includes(item.serviceId));
}
