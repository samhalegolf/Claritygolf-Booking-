import { useEffect, useMemo, useRef, useState } from "react";
import type { CalendarAxisMode } from "../../calendar-axis";
import {
  buildWeekDays,
  businessNow,
  CalendarHoverPreview,
  CalendarPerspective,
  formatWeekTitle,
  getCurrentWeekOffset,
} from "./calendarModel";

/**
 * The calendar's shared state: which week is on show, how it is laid out, which
 * day and coach or location it is focused on, the hover preview and the
 * current-time line.
 *
 * The calendar screen reads it, and so do Book, the dock and the appointment
 * details, which is why it lives here rather than inside the screen. App calls
 * it once, where this state used to be declared.
 */
export function useCalendarState({ timeZone }: { timeZone: string }) {
  const [calendarHover, setCalendarHover] = useState<CalendarHoverPreview | null>(null);
  const [activeWeek, setActiveWeek] = useState(getCurrentWeekOffset);
  const [calendarDetailMode, setCalendarDetailMode] = useState(false);
  const [calendarAxisMode, setCalendarAxisMode] = useState<CalendarAxisMode>("week");
  // Day view: which weekday fills the grid, or null for the whole week. Phones
  // start on a day because seven columns across a phone leaves 45px each, which
  // is not enough for a client's name.
  const [calendarDayFocus, setCalendarDayFocus] = useState<number | null>(null);
  // Minute of the day the now line is drawn at. Ticks on its own so the line
  // creeps down the column without anything else having to re-render it.
  const [calendarNowMinutes, setCalendarNowMinutes] = useState(() => businessNow().minutes);
  // Which calendar day it currently is. buildWeekDays reads new Date() when it
  // runs and is memoised on the week, so a calendar left open overnight kept
  // yesterday labelled Today and drew the now line down yesterday's column
  // until the week was changed. Ticked by the same interval as the minute
  // above; a string date so re-renders happen once a day, not once a minute.
  const [todayStamp, setTodayStamp] = useState(() => businessNow().date.toDateString());
  const [calendarPerspective, setCalendarPerspective] = useState<CalendarPerspective>("all");
  const [calendarCoachFilterId, setCalendarCoachFilterId] = useState("");
  const [calendarLocationFilterId, setCalendarLocationFilterId] = useState("");
  const activeWeekRef = useRef(activeWeek);
  // todayStamp is a dependency, not decoration: isToday is baked in here.
  const weekDays = useMemo(() => buildWeekDays(activeWeek), [activeWeek, todayStamp, timeZone]);
  const weekTitle = useMemo(() => formatWeekTitle(activeWeek), [activeWeek]);

  // The now line is drawn once, in today's column, and only when the week on
  // screen is the one today falls in.
  const calendarTodayIndex = weekDays.findIndex((day) => day.isToday);
  // Read by the breakpoint effect, which must not re-run when the week changes.
  const calendarTodayIndexRef = useRef(calendarTodayIndex);
  calendarTodayIndexRef.current = calendarTodayIndex;

  // A phone opens on a day and a desktop on the week. Keyed off crossing the
  // breakpoint rather than every render, so tapping back to the week on a phone
  // sticks until the viewport itself changes.
  useEffect(() => {
    const narrow = () => window.matchMedia("(max-width: 640px)").matches;
    let wasNarrow: boolean | null = null;
    const sync = () => {
      const isNarrow = narrow();
      if (isNarrow === wasNarrow) return;
      wasNarrow = isNarrow;
      setCalendarDayFocus(isNarrow ? (calendarTodayIndexRef.current >= 0 ? calendarTodayIndexRef.current : 0) : null);
    };
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  useEffect(() => {
    const update = () => {
      const now = businessNow();
      setCalendarNowMinutes(now.minutes);
      // Unchanged on 1439 of every 1440 ticks, and React drops a set to the
      // same string, so this costs nothing until the date actually rolls over.
      setTodayStamp(now.date.toDateString());
    };
    // Straight away as well, so a time zone change moves the now line at once.
    update();
    const tick = window.setInterval(update, 60_000);
    return () => window.clearInterval(tick);
  }, [timeZone]);

  return {
    calendarHover,
    setCalendarHover,
    activeWeek,
    setActiveWeek,
    calendarDetailMode,
    setCalendarDetailMode,
    calendarAxisMode,
    setCalendarAxisMode,
    calendarDayFocus,
    setCalendarDayFocus,
    calendarNowMinutes,
    calendarPerspective,
    setCalendarPerspective,
    calendarCoachFilterId,
    setCalendarCoachFilterId,
    calendarLocationFilterId,
    setCalendarLocationFilterId,
    activeWeekRef,
    weekDays,
    weekTitle,
    calendarTodayIndex,
  };
}

export type CalendarState = ReturnType<typeof useCalendarState>;
