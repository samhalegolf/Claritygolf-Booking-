import assert from "node:assert/strict";
import test from "node:test";

import {
  axisMinuteToTop,
  axisTopToMinute,
  buildCalendarAxis,
  buildDayColumns,
  dayColumnPixels,
  dayFromGridX,
  formatDurationLabel,
  COLLAPSED_DAY_WIDTH,
  DAY_COUNT,
  HOUR_HEIGHT,
  SQUASH_GAP_MAX_HEIGHT,
} from "./calendar-axis.ts";

const DAY_START = 7 * 60;
const DAY_END = 20 * 60;

const at = (hour: number, minute = 0) => hour * 60 + minute;

test("week view is the identity mapping", () => {
  const axis = buildCalendarAxis(DAY_START, DAY_END, [{ start: at(9), duration: 60 }], false);

  assert.equal(axis.squashed, false);
  assert.equal(axis.height, ((DAY_END - DAY_START) / 60) * HOUR_HEIGHT);
  assert.equal(axisMinuteToTop(axis, DAY_START), 0);
  assert.equal(axisMinuteToTop(axis, at(8)), HOUR_HEIGHT);
  // Acceptance: a 9-10am booking measures exactly one hour row.
  assert.equal(axisMinuteToTop(axis, at(10)) - axisMinuteToTop(axis, at(9)), HOUR_HEIGHT);
});

test("an empty week is left alone rather than collapsed to a hairline", () => {
  const axis = buildCalendarAxis(DAY_START, DAY_END, [], true);

  assert.equal(axis.squashed, false);
  assert.equal(axis.height, ((DAY_END - DAY_START) / 60) * HOUR_HEIGHT);
});

test("squash keeps busy time at full scale and collapses the dead stretches", () => {
  // 9-10am and 5-6pm, with seven hours of nothing between them.
  const axis = buildCalendarAxis(
    DAY_START,
    DAY_END,
    [
      { start: at(9), duration: 60 },
      { start: at(17), duration: 60 },
    ],
    true,
  );

  assert.equal(axis.squashed, true);

  const busy = axis.segments.filter((segment) => !segment.quiet);
  const quiet = axis.segments.filter((segment) => segment.quiet);
  assert.equal(quiet.length, 3, "leading, middle and trailing gaps");

  busy.forEach((segment) => {
    assert.equal(segment.height, ((segment.end - segment.start) / 60) * HOUR_HEIGHT);
  });
  quiet.forEach((segment) => {
    assert.ok(segment.height <= SQUASH_GAP_MAX_HEIGHT);
    assert.ok(segment.height < ((segment.end - segment.start) / 60) * HOUR_HEIGHT);
  });

  // Every minute of the day is still accounted for, and the heights add up to
  // the axis height — squashing hides time, it never drops it.
  assert.equal(axis.segments[0].start, DAY_START);
  assert.equal(axis.segments[axis.segments.length - 1].end, DAY_END);
  axis.segments.forEach((segment, index) => {
    if (index === 0) return;
    assert.equal(segment.start, axis.segments[index - 1].end, "segments are contiguous");
  });
  const summed = axis.segments.reduce((total, segment) => total + segment.height, 0);
  assert.ok(Math.abs(summed - axis.height) < 1e-9);
});

test("a longer dead spell still reads as longer than a short one", () => {
  // Both weeks open with a 9-10am lesson, so the gap after it starts at 10:20
  // once the 20-minute pad is applied. Only the next lesson's time differs.
  const gapAfterMorning = (nextLessonHour: number) =>
    buildCalendarAxis(
      DAY_START,
      DAY_END,
      [
        { start: at(9), duration: 60 },
        { start: at(nextLessonHour), duration: 60 },
      ],
      true,
    ).segments.find((segment) => segment.quiet && segment.start === at(10, 20));

  const short = gapAfterMorning(12);
  const long = gapAfterMorning(15);

  assert.ok(short && long);
  assert.ok(long.height > short.height, `${long.height} should exceed ${short.height}`);
  // Both are still a fraction of the time they stand in for.
  assert.ok(long.height < ((long.end - long.start) / 60) * HOUR_HEIGHT);
});

test("a quiet stretch under 45 minutes is left at full scale", () => {
  // 9-10 and 10:40-11:40 leaves 40 minutes between, which the 20-minute pads
  // shrink to nothing — so nothing collapses at all.
  const axis = buildCalendarAxis(
    DAY_START,
    DAY_END,
    [
      { start: at(9), duration: 60 },
      { start: at(10, 40), duration: 60 },
    ],
    true,
  );

  const middle = axis.segments.filter(
    (segment) => segment.start >= at(9) && segment.end <= at(11, 40) && segment.quiet,
  );
  assert.deepEqual(middle, [], "the short gap between the two lessons is not collapsed");
});

test("the mapping and its inverse agree in both views", () => {
  const busy = [
    { start: at(9), duration: 60 },
    { start: at(17), duration: 45 },
  ];
  for (const squashed of [false, true]) {
    const axis = buildCalendarAxis(DAY_START, DAY_END, busy, squashed);
    for (let minute = DAY_START; minute <= DAY_END; minute += 5) {
      const roundTrip = axisTopToMinute(axis, axisMinuteToTop(axis, minute));
      assert.ok(
        Math.abs(roundTrip - minute) < 1e-6,
        `squashed=${squashed} minute=${minute} came back as ${roundTrip}`,
      );
    }
  }
});

test("positions outside the day clamp to the ends of the axis", () => {
  const axis = buildCalendarAxis(DAY_START, DAY_END, [{ start: at(9), duration: 60 }], true);

  assert.equal(axisMinuteToTop(axis, 0), 0);
  assert.equal(axisMinuteToTop(axis, 24 * 60), axis.height);
  assert.equal(axisTopToMinute(axis, -50), DAY_START);
  assert.equal(axisTopToMinute(axis, axis.height + 50), DAY_END);
});

test("hour marks inside a collapsed gap are identifiable as such", () => {
  const axis = buildCalendarAxis(
    DAY_START,
    DAY_END,
    [
      { start: at(9), duration: 60 },
      { start: at(17), duration: 60 },
    ],
    true,
  );
  const inGap = (hour: number) =>
    Boolean(axis.segments.find((segment) => hour >= segment.start && hour < segment.end)?.quiet);

  assert.equal(inGap(at(13)), true, "1pm falls in the collapsed middle");
  assert.equal(inGap(at(9)), false, "9am is inside the morning lesson");
});

test("day columns share the width evenly when nothing is collapsed", () => {
  const columns = buildDayColumns(Array.from({ length: DAY_COUNT }, () => false));

  assert.equal(columns.length, DAY_COUNT);
  assert.equal(columns[0].left, "0%");
  columns.forEach((column) => {
    assert.equal(column.width, `${100 / DAY_COUNT}%`);
    assert.equal(column.collapsed, false);
  });
});

test("collapsed days take a fixed hairline and the rest share what is left", () => {
  const collapsed = [false, false, false, false, false, true, true];
  const columns = buildDayColumns(collapsed);

  assert.equal(columns[5].width, `${COLLAPSED_DAY_WIDTH}px`);
  assert.equal(columns[6].width, `${COLLAPSED_DAY_WIDTH}px`);
  assert.equal(columns[0].width, "calc(((100% - 52px) / 5))");
  // Sunday starts one hairline after Saturday.
  assert.ok(columns[6].left.includes("26px"));

  // The pixel table has to agree with the CSS one, or hit-testing lands in the
  // wrong lane. 1000px wide, two hairlines, five columns of 189.6px.
  const pixels = dayColumnPixels(collapsed, 1000);
  assert.equal(pixels[5].width, COLLAPSED_DAY_WIDTH);
  assert.ok(Math.abs(pixels[0].width - (1000 - 52) / 5) < 1e-9);
  const total = pixels.reduce((sum, column) => sum + column.width, 0);
  assert.ok(Math.abs(total - 1000) < 1e-9);
});

test("a pointer lands in the day it is over, collapsed columns included", () => {
  const none = Array.from({ length: DAY_COUNT }, () => false);
  assert.equal(dayFromGridX(none, 700, 0), 0);
  assert.equal(dayFromGridX(none, 700, 350), 3);
  assert.equal(dayFromGridX(none, 700, 699), 6);

  const collapsed = [false, false, false, false, false, true, true];
  const pixels = dayColumnPixels(collapsed, 1000);
  collapsed.forEach((_, day) => {
    const middle = pixels[day].left + pixels[day].width / 2;
    assert.equal(dayFromGridX(collapsed, 1000, middle), day);
  });
  // Past the right edge still resolves rather than falling off the end.
  assert.equal(dayFromGridX(collapsed, 1000, 4000), DAY_COUNT - 1);
});

test("day view gives one day the whole grid and draws none of the others", () => {
  const none = Array.from({ length: DAY_COUNT }, () => false);
  const columns = buildDayColumns(none, 3);

  assert.equal(columns.length, DAY_COUNT);
  assert.deepEqual(columns[3], { left: "0%", width: "100%", collapsed: false, hidden: false });
  columns.forEach((column, day) => {
    if (day === 3) return;
    assert.equal(column.hidden, true, `day ${day} is not drawn`);
    assert.equal(column.width, "0%");
  });

  // Squash's collapsed days do not survive into day view: there is one column,
  // so there is nothing for a hairline to sit beside.
  const collapsed = [false, false, false, false, false, true, true];
  buildDayColumns(collapsed, 3).forEach((column) => assert.equal(column.collapsed, false));
});

test("in day view every pointer position is that day", () => {
  const none = Array.from({ length: DAY_COUNT }, () => false);

  assert.equal(dayFromGridX(none, 700, 0, 5), 5);
  assert.equal(dayFromGridX(none, 700, 350, 5), 5);
  assert.equal(dayFromGridX(none, 700, 699, 5), 5);
  // Still the week's rule when nothing is focused.
  assert.equal(dayFromGridX(none, 700, 350, null), 3);

  const pixels = dayColumnPixels(none, 700, 5);
  assert.equal(pixels[5].width, 700);
  assert.equal(pixels[5].left, 0);
  assert.equal(pixels[0].width, 0);
});

test("gap durations read as a coach would say them", () => {
  assert.equal(formatDurationLabel(45), "45m");
  assert.equal(formatDurationLabel(60), "1h");
  assert.equal(formatDurationLabel(210), "3h 30m");
  assert.equal(formatDurationLabel(209.6), "3h 30m");
});
