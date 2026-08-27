/**
 * Selective external calendar import.
 *
 * The coach's Google account holds far more than the commitments Clarity needs
 * to know about. Mirroring a whole calendar solved the double-booking problem
 * by importing everything, which is a blunt trade: a dentist appointment and a
 * Golf HQ lesson arrive on equal terms, and there is no way to say "pull the
 * lessons, leave the rest".
 *
 * A rule is that missing sentence. It names an external source the coach cares
 * about — "Golf HQ Portal" — and says how to recognise its events:
 *
 *   - **aliases**: the spellings that identify the source. Matched against the
 *     organiser and creator addresses *and* the event's own words, because the
 *     same source arrives both ways: a portal that writes events from its own
 *     address, and the coach typing "Golf HQ" into a Google event by hand.
 *   - **keywords**: an optional narrowing. With none, every event from that
 *     source comes in. With "lesson", only the source's lessons do. This is the
 *     part that makes the feature general — one coach narrows by "lesson",
 *     another by "fitting", and neither needs a code change.
 *   - **calendarIds**: where to look. Empty means every calendar on the
 *     account.
 *
 * Nothing matches nothing. An event that satisfies no rule is not imported, so
 * the calendar only ever fills with time the coach has explicitly asked to see.
 *
 * Pure module: no network, no database, no settings access. Give it an event
 * and a rule and it says yes or no.
 */

import type { GoogleEvent } from "./google-calendar-import.mts";

export type GoogleCalendarImportRule = {
  id: string;
  name: string;
  aliases: string[];
  keywords: string[];
  /** Calendars to scan. Empty means every calendar on the account. */
  calendarIds: string[];
  /** Show the event's own title on the block, or just "Busy". */
  showLabel: boolean;
  enabled: boolean;
};

const maxRules = 25;
const maxTermsPerField = 25;
const maxTermLength = 120;
const maxNameLength = 80;
const maxCalendarsPerRule = 50;
const maxCalendarIdLength = 320;

function text(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * Terms come from a UI where the coach types freely, so both a JSON array and a
 * comma or newline separated string have to land in the same place. Blank and
 * duplicate terms are dropped: a stray trailing comma should not create an
 * empty alias that matches every event on the calendar.
 */
export function normalizeTerms(value: unknown, max = maxTermsPerField): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,\n]/)
      : [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const entry of raw) {
    const term = text(entry, maxTermLength);
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= max) break;
  }
  return terms;
}

function normalizeCalendarIds(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\n]/) : [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of raw) {
    const id = text(entry, maxCalendarIdLength);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= maxCalendarsPerRule) break;
  }
  return ids;
}

function ruleId(value: unknown, index: number) {
  const id = text(value, 64).replace(/[^a-zA-Z0-9_-]/g, "");
  return id || `rule-${index + 1}`;
}

export function cleanGoogleCalendarImportRule(value: unknown, index = 0): GoogleCalendarImportRule {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    id: ruleId(candidate.id, index),
    name: text(candidate.name, maxNameLength),
    aliases: normalizeTerms(candidate.aliases),
    keywords: normalizeTerms(candidate.keywords),
    calendarIds: normalizeCalendarIds(candidate.calendarIds),
    showLabel: candidate.showLabel !== false,
    enabled: candidate.enabled !== false,
  };
}

/**
 * A rule with no aliases matches nothing.
 *
 * The alternative — treating "no aliases" as "match everything" — turns a
 * half-finished rule into a full calendar mirror the moment it is saved, which
 * is precisely the behaviour this feature replaced. A rule the coach has not
 * finished describing should stay inert.
 */
export function ruleIsUsable(rule: GoogleCalendarImportRule) {
  return rule.enabled && rule.aliases.length > 0;
}

export function normalizeGoogleCalendarImportRules(value: unknown): GoogleCalendarImportRule[] {
  const raw = Array.isArray(value) ? value : [];
  const seenIds = new Set<string>();
  const rules: GoogleCalendarImportRule[] = [];
  for (const [index, entry] of raw.entries()) {
    if (rules.length >= maxRules) break;
    const rule = cleanGoogleCalendarImportRule(entry, index);
    // Ids key the block rows, so a duplicate would let two rules fight over the
    // same import. Later duplicates get a fresh id rather than being dropped.
    let id = rule.id;
    let suffix = 2;
    while (seenIds.has(id)) id = `${rule.id}-${suffix++}`;
    seenIds.add(id);
    rules.push({ ...rule, id });
  }
  return rules;
}

/**
 * Everything about an event a rule is allowed to look at, lowercased once.
 *
 * Organiser and creator cover the portal-writes-it case; summary and
 * description cover the coach-types-it case. Location is in there too because
 * "Golf HQ" is as likely to be the venue as the organiser.
 */
export function eventMatchText(event: GoogleEvent) {
  const parts = [
    event?.summary,
    event?.description,
    event?.location,
    event?.organizer?.email,
    event?.organizer?.displayName,
    event?.creator?.email,
    event?.creator?.displayName,
  ];
  return parts
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" \n ")
    .toLowerCase();
}

function containsAny(haystack: string, terms: string[]) {
  return terms.some((term) => haystack.includes(term.toLowerCase()));
}

/**
 * Does this event belong to this rule?
 *
 * Both halves must pass: the event has to look like it came from the source,
 * and — if the rule narrows — has to be the kind of thing the coach wanted from
 * that source. Substring matching, case-insensitive, so "lesson" catches
 * "Lesson", "lessons" and "Group Lesson" without the coach learning a syntax.
 */
export function eventMatchesImportRule(event: GoogleEvent, rule: GoogleCalendarImportRule) {
  if (!ruleIsUsable(rule)) return false;
  const haystack = eventMatchText(event);
  if (!haystack) return false;
  if (!containsAny(haystack, rule.aliases)) return false;
  if (rule.keywords.length && !containsAny(haystack, rule.keywords)) return false;
  return true;
}

/**
 * The rule that owns an event, or null if none does.
 *
 * First match wins, in the order the coach arranged them. An event can only
 * produce one block, so overlapping rules resolve by position rather than
 * silently importing the same hour twice under two names.
 */
export function findImportRuleForEvent(event: GoogleEvent, rules: GoogleCalendarImportRule[]) {
  for (const rule of rules) {
    if (eventMatchesImportRule(event, rule)) return rule;
  }
  return null;
}

/** Does this rule read from this calendar? Empty scope means all of them. */
export function ruleCoversCalendar(rule: GoogleCalendarImportRule, calendarId: string) {
  return rule.calendarIds.length === 0 || rule.calendarIds.includes(calendarId);
}

/**
 * The calendars that need fetching, given the rules in play.
 *
 * A rule scoped to nothing forces the full account; otherwise only the named
 * calendars are read. Fetching a calendar no rule looks at is a Google API call
 * spent on events that can never be imported.
 */
export function calendarsToScan(rules: GoogleCalendarImportRule[], allCalendarIds: string[]) {
  const usable = rules.filter(ruleIsUsable);
  if (!usable.length) return [];
  if (usable.some((rule) => rule.calendarIds.length === 0)) return [...allCalendarIds];
  const wanted = new Set<string>();
  for (const rule of usable) {
    for (const id of rule.calendarIds) wanted.add(id);
  }
  // Only calendars the account actually has: a rule pointing at a calendar that
  // was removed or unshared should be inert, not a 404 that fails the sync.
  return allCalendarIds.filter((id) => wanted.has(id));
}
