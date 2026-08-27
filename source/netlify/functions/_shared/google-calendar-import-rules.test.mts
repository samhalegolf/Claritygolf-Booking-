import assert from "node:assert/strict";
import test from "node:test";

import {
  calendarsToScan,
  cleanGoogleCalendarImportRule,
  eventMatchesImportRule,
  findImportRuleForEvent,
  normalizeGoogleCalendarImportRules,
  normalizeTerms,
  ruleCoversCalendar,
  ruleIsUsable,
} from "./google-calendar-import-rules.mts";

function rule(overrides: Record<string, unknown> = {}) {
  return cleanGoogleCalendarImportRule({
    id: "golf-hq",
    name: "Golf HQ Portal",
    aliases: ["Golf HQ"],
    ...overrides,
  });
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    status: "confirmed",
    summary: "Golf HQ lesson - Ryan Haste",
    start: { dateTime: "2026-08-21T07:00:00+12:00" },
    end: { dateTime: "2026-08-21T08:00:00+12:00" },
    ...overrides,
  };
}

test("an alias matches the event's own words", () => {
  assert.equal(eventMatchesImportRule(event(), rule()), true);
  assert.equal(eventMatchesImportRule(event({ summary: "Dentist" }), rule()), false);
});

// The same source arrives two ways: written by the portal, and typed by the
// coach. One rule has to catch both or the coach keeps a second rule per source.
test("an alias matches the organiser or creator as well as the title", () => {
  const written = event({ summary: "Lesson", organizer: { email: "bookings@golfhq.co.nz" } });
  assert.equal(eventMatchesImportRule(written, rule({ aliases: ["golfhq.co.nz"] })), true);

  const typed = event({ summary: "Lesson", creator: { displayName: "Golf HQ Reception" } });
  assert.equal(eventMatchesImportRule(typed, rule()), true);

  const venue = event({ summary: "Lesson", location: "Golf HQ, Albany" });
  assert.equal(eventMatchesImportRule(venue, rule()), true);

  const body = event({ summary: "Lesson", description: "Booked via Golf HQ portal" });
  assert.equal(eventMatchesImportRule(body, rule()), true);
});

test("matching ignores case and matches inside words", () => {
  assert.equal(eventMatchesImportRule(event({ summary: "GOLF HQ LESSON" }), rule()), true);
  assert.equal(eventMatchesImportRule(event({ summary: "Group lessons at Golf HQ" }), rule({ keywords: ["lesson"] })), true);
});

// The point of the feature: one coach narrows by "lesson", another by
// "fitting", and neither needs the code changed.
test("keywords narrow a source without excluding it entirely", () => {
  const lessonsOnly = rule({ keywords: ["lesson"] });
  assert.equal(eventMatchesImportRule(event(), lessonsOnly), true);
  assert.equal(eventMatchesImportRule(event({ summary: "Golf HQ staff meeting" }), lessonsOnly), false);

  // No keywords means everything from the source.
  assert.equal(eventMatchesImportRule(event({ summary: "Golf HQ staff meeting" }), rule()), true);
});

test("keywords alone are not enough — the source still has to match", () => {
  const lessonsOnly = rule({ keywords: ["lesson"] });
  assert.equal(eventMatchesImportRule(event({ summary: "Swim lesson" }), lessonsOnly), false);
});

// A half-finished rule must not quietly mirror the whole calendar, which is
// exactly what the old whole-calendar import did.
test("a rule with no aliases imports nothing", () => {
  const empty = rule({ aliases: [] });
  assert.equal(ruleIsUsable(empty), false);
  assert.equal(eventMatchesImportRule(event(), empty), false);
});

test("a disabled rule imports nothing", () => {
  const off = rule({ enabled: false });
  assert.equal(ruleIsUsable(off), false);
  assert.equal(eventMatchesImportRule(event(), off), false);
});

test("an event matching no rule is not claimed", () => {
  assert.equal(findImportRuleForEvent(event({ summary: "Dentist" }), [rule()]), null);
});

// One event, one block. Overlapping rules resolve by position rather than
// importing the same hour twice under two names.
test("the first matching rule claims the event", () => {
  const rules = [rule({ id: "lessons", keywords: ["lesson"] }), rule({ id: "everything" })];
  assert.equal(findImportRuleForEvent(event(), rules)?.id, "lessons");
  assert.equal(findImportRuleForEvent(event({ summary: "Golf HQ meeting" }), rules)?.id, "everything");
});

test("terms accept a typed comma list and drop blanks and duplicates", () => {
  assert.deepEqual(normalizeTerms("Golf HQ, golfhq.com, , Golf HQ"), ["Golf HQ", "golfhq.com"]);
  assert.deepEqual(normalizeTerms(["  spaced  ", ""]), ["spaced"]);
  assert.deepEqual(normalizeTerms(undefined), []);
});

test("duplicate rule ids are separated so they cannot fight over the same import", () => {
  const rules = normalizeGoogleCalendarImportRules([
    { id: "same", aliases: ["a"] },
    { id: "same", aliases: ["b"] },
  ]);
  assert.equal(rules.length, 2);
  assert.notEqual(rules[0].id, rules[1].id);
});

test("an empty calendar scope means every calendar", () => {
  assert.equal(ruleCoversCalendar(rule(), "work@example.com"), true);
  assert.equal(ruleCoversCalendar(rule({ calendarIds: ["work@example.com"] }), "work@example.com"), true);
  assert.equal(ruleCoversCalendar(rule({ calendarIds: ["work@example.com"] }), "personal@example.com"), false);
});

test("only calendars a rule actually reads are scanned", () => {
  const all = ["primary", "work@example.com", "personal@example.com"];
  assert.deepEqual(calendarsToScan([rule({ calendarIds: ["work@example.com"] })], all), ["work@example.com"]);
  assert.deepEqual(calendarsToScan([rule()], all), all);
  assert.deepEqual(calendarsToScan([], all), []);
  // A rule pointing at a calendar that was unshared goes quiet rather than
  // failing the sync with a 404.
  assert.deepEqual(calendarsToScan([rule({ calendarIds: ["gone@example.com"] })], all), []);
});

test("no usable rules means no calendars are fetched at all", () => {
  assert.deepEqual(calendarsToScan([rule({ aliases: [] }), rule({ enabled: false })], ["primary"]), []);
});
