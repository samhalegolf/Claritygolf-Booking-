/**
 * Geometry for the admin week calendar: the vertical axis that turns minutes
 * into pixels, and the day columns that turn days into widths.
 *
 * This lives outside App.tsx because it is the part with arithmetic worth
 * testing. Squash view is only trustworthy if the mapping and its inverse
 * agree, and that is not something you can see by looking at the screen.
 */

/** Height of one hour in week view. The --hour-height CSS token mirrors it. */
export const HOUR_HEIGHT = 72;
export const DAY_COUNT = 7;

/**
 * The calendar's vertical axis, as a list of segments that each map a stretch
 * of the day onto a stretch of pixels.
 *
 * Week view is one segment at a flat 72px an hour — the identity mapping.
 * Squash view keeps that scale over the parts of the week that have something
 * in them and compresses the dead stretches between, so a coach with two
 * lessons either side of a four-hour hole can see both without scrolling.
 * Every top and height on the grid goes through this, which is what keeps
 * bands, cards, blocks, hour labels and the now line on one shared axis in
 * both views.
 *
 * A collapsed gap keeps a little of its length (a four-hour hole still reads
 * as longer than a one-hour one) but nothing like its real height, so the
 * mapping is piecewise-linear rather than linear and has to be inverted
 * segment by segment to turn a pointer position back into a time.
 */
export type CalendarAxisMode = "week" | "squash";

export type CalendarAxisSegment = {
  start: number;
  end: number;
  top: number;
  height: number;
  /** True when this stretch is collapsed: nothing is booked in it. */
  quiet: boolean;
};

export type CalendarAxis = {
  segments: CalendarAxisSegment[];
  height: number;
  squashed: boolean;
};

/** Breathing room kept either side of a booking before a stretch counts as dead. */
export const SQUASH_BUSY_PAD_MINUTES = 20;
/** Below this, a quiet stretch is left at full scale — collapsing it would save nothing. */
export const SQUASH_GAP_MINUTES = 45;
export const SQUASH_GAP_BASE_HEIGHT = 14;
export const SQUASH_GAP_MINUTE_HEIGHT = 0.09;
export const SQUASH_GAP_MAX_HEIGHT = 44;
/** Width a day with nothing in it collapses to in squash view. */
export const COLLAPSED_DAY_WIDTH = 26;

/**
 * How much of the neighbouring week stays visible past the right edge. It is
 * also the width of the spacer appended after the last week panel: without
 * trailing room the final panel can never satisfy scroll-snap-align: start,
 * and mandatory snapping then cancels programmatic smooth scrolls, so paging
 * backward from the last week silently fails.
 */
export const WEEK_PEEK = 26;
/** Previous, current, next. The focused week is always the middle one. */
export const WEEK_PANEL_COUNT = 3;
export const WEEK_FOCUS_INDEX = 1;
export const WEEK_PANEL_OFFSETS = [-1, 0, 1];

export function buildCalendarAxis(
  startMinutes: number,
  endMinutes: number,
  busy: { start: number; duration: number }[],
  squashed: boolean,
): CalendarAxis {
  const span = Math.max(0, endMinutes - startMinutes);
  const fullHeight = (span / 60) * HOUR_HEIGHT;
  const identity: CalendarAxis = {
    segments: [{ start: startMinutes, end: endMinutes, top: 0, height: fullHeight, quiet: false }],
    height: fullHeight,
    squashed: false,
  };
  if (!squashed || span <= 0) return identity;

  const padded = busy
    .map((entry) => ({
      start: Math.max(startMinutes, entry.start - SQUASH_BUSY_PAD_MINUTES),
      end: Math.min(endMinutes, entry.start + entry.duration + SQUASH_BUSY_PAD_MINUTES),
    }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start);

  const merged: { start: number; end: number }[] = [];
  padded.forEach((range) => {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  });

  // Nothing booked all week: squashing would collapse the whole thing to a
  // single hairline, which tells the coach less than the empty week does.
  if (!merged.length) return identity;

  const segments: CalendarAxisSegment[] = [];
  let top = 0;
  const push = (start: number, end: number, quiet: boolean) => {
    if (end <= start) return;
    const minutes = end - start;
    const height = quiet
      ? Math.min(SQUASH_GAP_MAX_HEIGHT, SQUASH_GAP_BASE_HEIGHT + minutes * SQUASH_GAP_MINUTE_HEIGHT)
      : (minutes / 60) * HOUR_HEIGHT;
    segments.push({ start, end, top, height, quiet });
    top += height;
  };

  let cursor = startMinutes;
  merged.forEach((range) => {
    push(cursor, range.start, range.start - cursor >= SQUASH_GAP_MINUTES);
    push(range.start, range.end, false);
    cursor = range.end;
  });
  push(cursor, endMinutes, endMinutes - cursor >= SQUASH_GAP_MINUTES);

  if (!segments.length) return identity;
  return { segments, height: top, squashed: true };
}

export function axisMinuteToTop(axis: CalendarAxis, minutes: number) {
  const segments = axis.segments;
  if (!segments.length) return 0;
  if (minutes <= segments[0].start) return 0;
  if (minutes >= segments[segments.length - 1].end) return axis.height;
  for (const segment of segments) {
    if (minutes > segment.end) continue;
    const span = segment.end - segment.start;
    if (span <= 0) return segment.top;
    return segment.top + ((minutes - segment.start) / span) * segment.height;
  }
  return axis.height;
}

export function axisTopToMinute(axis: CalendarAxis, top: number) {
  const segments = axis.segments;
  if (!segments.length) return 0;
  if (top <= 0) return segments[0].start;
  for (const segment of segments) {
    if (top > segment.top + segment.height) continue;
    if (segment.height <= 0) return segment.start;
    return segment.start + ((top - segment.top) / segment.height) * (segment.end - segment.start);
  }
  return segments[segments.length - 1].end;
}

/**
 * Day column geometry, as CSS length expressions so lanes and cards can stay
 * on percentages and keep working at any grid width. Collapsed days take a
 * fixed 26px and the rest share what is left, which is the same rule the
 * header row follows — the two have to agree or the columns and their headings
 * drift apart.
 */
export type DayColumn = { left: string; width: string; collapsed: boolean; hidden: boolean };

/**
 * Day view: one day fills the grid and the other six are not drawn.
 *
 * It is a column layout rather than a separate calendar because everything
 * above the columns — the bands, the cards, the squash axis, the now line, the
 * pointer maths that turns a drop back into a day — already works off this
 * table. Seven columns on a phone leaves 45px a day, which is not enough for a
 * name; one column leaves the lot.
 */
function focusedDayColumns(focusedDay: number): DayColumn[] {
  return Array.from({ length: DAY_COUNT }, (_, day) => ({
    left: "0%",
    width: day === focusedDay ? "100%" : "0%",
    collapsed: false,
    hidden: day !== focusedDay,
  }));
}

export function buildDayColumns(collapsedDays: boolean[], focusedDay: number | null = null): DayColumn[] {
  if (focusedDay !== null) return focusedDayColumns(focusedDay);
  const collapsedCount = collapsedDays.filter(Boolean).length;
  if (!collapsedCount) {
    return collapsedDays.map((_, day) => ({
      left: `${(day / DAY_COUNT) * 100}%`,
      width: `${100 / DAY_COUNT}%`,
      collapsed: false,
      hidden: false,
    }));
  }
  const expandedCount = Math.max(1, DAY_COUNT - collapsedCount);
  const share = `((100% - ${collapsedCount * COLLAPSED_DAY_WIDTH}px) / ${expandedCount})`;
  let collapsedBefore = 0;
  let expandedBefore = 0;
  return collapsedDays.map((collapsed) => {
    const column = {
      left: `calc(${collapsedBefore * COLLAPSED_DAY_WIDTH}px + ${expandedBefore} * ${share})`,
      width: collapsed ? `${COLLAPSED_DAY_WIDTH}px` : `calc(${share})`,
      collapsed,
      hidden: false,
    };
    if (collapsed) collapsedBefore += 1;
    else expandedBefore += 1;
    return column;
  });
}

/** The same rule in pixels, for turning a pointer position back into a day. */
export function dayColumnPixels(collapsedDays: boolean[], gridWidth: number, focusedDay: number | null = null) {
  if (focusedDay !== null) {
    return Array.from({ length: DAY_COUNT }, (_, day) => ({
      left: 0,
      width: day === focusedDay ? gridWidth : 0,
    }));
  }
  const collapsedCount = collapsedDays.filter(Boolean).length;
  const expandedCount = Math.max(1, DAY_COUNT - collapsedCount);
  const share = collapsedCount
    ? Math.max(0, gridWidth - collapsedCount * COLLAPSED_DAY_WIDTH) / expandedCount
    : gridWidth / DAY_COUNT;
  let left = 0;
  return collapsedDays.map((collapsed) => {
    const width = collapsed ? COLLAPSED_DAY_WIDTH : share;
    const column = { left, width };
    left += width;
    return column;
  });
}

export function dayFromGridX(
  collapsedDays: boolean[],
  gridWidth: number,
  x: number,
  focusedDay: number | null = null,
) {
  // In day view every position in the grid is that one day, whatever the x.
  if (focusedDay !== null) return focusedDay;
  const columns = dayColumnPixels(collapsedDays, gridWidth);
  for (let day = 0; day < columns.length; day += 1) {
    if (x < columns[day].left + columns[day].width) return day;
  }
  return DAY_COUNT - 1;
}

/** "3h 30m" / "45m" — how much time a collapsed gap skipped over. */
export function formatDurationLabel(minutes: number) {
  const whole = Math.round(minutes);
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  if (!hours) return `${rest}m`;
  if (!rest) return `${hours}h`;
  return `${hours}h ${rest}m`;
}
