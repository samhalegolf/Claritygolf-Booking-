import assert from "node:assert/strict";
import test from "node:test";

import { calendarItemsPatch, type CalendarItem } from "./modules/calendar/calendarModel";

const lesson = (id: string, overrides: Partial<CalendarItem> = {}): CalendarItem => ({
  id,
  kind: "appointment",
  week: 0,
  day: 1,
  start: 540,
  duration: 60,
  title: "Lesson",
  ...overrides,
});

test("an unchanged calendar saves nothing", () => {
  const items = [lesson("a"), lesson("b")];
  assert.deepEqual(calendarItemsPatch(items, items.map((item) => ({ ...item }))), { upserts: [], deletes: [] });
});

test("a moved, a new and a removed booking are the whole patch", () => {
  const baseline = [lesson("keep"), lesson("move"), lesson("gone")];
  const desired = [lesson("keep"), lesson("move", { start: 600 }), lesson("new", { day: 3 })];
  const { upserts, deletes } = calendarItemsPatch(baseline, desired);
  assert.deepEqual(upserts.map((item) => item.id), ["move", "new"]);
  assert.deepEqual(deletes, ["gone"]);
});

test("server-owned fields never become a write on their own", () => {
  const baseline = [lesson("a")];
  const desired = [lesson("a", { resourceId: "bay-2", bayBooked: true, updatedAt: "2026-10-07T00:00:00Z" })];
  assert.deepEqual(calendarItemsPatch(baseline, desired), { upserts: [], deletes: [] });
});
