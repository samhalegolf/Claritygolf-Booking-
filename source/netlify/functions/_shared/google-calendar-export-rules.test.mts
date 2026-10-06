import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultGoogleCalendarExportRules,
  exportRulesAllow,
  normalizeGoogleCalendarExportRules,
} from "./google-calendar-export-rules.mts";

test("no saved rules sends everything, as sync did before", () => {
  assert.deepEqual(normalizeGoogleCalendarExportRules(undefined), defaultGoogleCalendarExportRules);
  assert.deepEqual(normalizeGoogleCalendarExportRules("nonsense"), defaultGoogleCalendarExportRules);
  const rules = normalizeGoogleCalendarExportRules({});
  assert.equal(exportRulesAllow({ kind: "appointment", serviceId: "a" }, rules), true);
  assert.equal(exportRulesAllow({ kind: "block" }, rules), true);
  assert.equal(exportRulesAllow({ kind: "unavailable" }, rules), true);
});

test("each kind has its own switch", () => {
  const rules = normalizeGoogleCalendarExportRules({ lessons: true, blocks: false, unavailable: false });
  assert.equal(exportRulesAllow({ kind: "appointment" }, rules), true);
  assert.equal(exportRulesAllow({ kind: "block" }, rules), false);
  assert.equal(exportRulesAllow({ kind: "unavailable" }, rules), false);
  assert.equal(exportRulesAllow({ kind: "appointment" }, normalizeGoogleCalendarExportRules({ lessons: false })), false);
});

test("an excluded lesson type stays off Google, the rest still go", () => {
  const rules = normalizeGoogleCalendarExportRules({ excludedServiceIds: ["fitting", " fitting ", "", 4] });
  assert.deepEqual(rules.excludedServiceIds, ["fitting"]);
  assert.equal(exportRulesAllow({ kind: "appointment", serviceId: "fitting" }, rules), false);
  assert.equal(exportRulesAllow({ kind: "appointment", serviceId: "lesson" }, rules), true);
  assert.equal(exportRulesAllow({ kind: "appointment", serviceId: "" }, rules), true);
});

test("a missing item is never sent", () => {
  assert.equal(exportRulesAllow(null, defaultGoogleCalendarExportRules), false);
});
