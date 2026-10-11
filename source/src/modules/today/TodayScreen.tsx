import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { t } from "../../lib/i18n";
import {
  buildWeekDays,
  businessNow,
  type CalendarItem,
  formatRange,
  getCurrentWeekOffset,
  itemService,
} from "../calendar/calendarModel";
import type { Service } from "../services/serviceModel";
import { ClarityCalendar, ClarityNewBooking } from "../shared/ClarityIcons";
import { featuredBooking, type TodayBooking, todaySummary, todaysBookings } from "./todayModel";

/** The minute of the business's day, moving on once a minute so "on now" stays true. */
function useBusinessMinute() {
  const [minutes, setMinutes] = useState(() => businessNow().minutes);
  useEffect(() => {
    const id = window.setInterval(() => setMinutes(businessNow().minutes), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return minutes;
}

const STATE_LABEL: Record<TodayBooking["state"], string> = {
  done: t("Done"),
  now: t("On now"),
  next: t("Up next"),
  later: "",
};

/** How far a finger has to travel sideways, more than up or down, to count as a swipe. */
const SWIPE_MIN_PX = 50;

/** The week and weekday `offset` days from today, in the calendar's week/day terms. */
function dayFromToday(offset: number) {
  const currentWeek = getCurrentWeekOffset();
  const todayIndex = Math.max(0, buildWeekDays(currentWeek).findIndex((weekDay) => weekDay.isToday));
  const index = todayIndex + offset;
  const week = currentWeek + Math.floor(index / 7);
  const day = ((index % 7) + 7) % 7;
  return { week, day, label: buildWeekDays(week)[day]?.label ?? "" };
}

/**
 * The phone layout's first screen: today's bookings for this coach (or the
 * whole business, for an admin), the one on now or coming next, and the two
 * things a coach most often does from here.
 *
 * Swipe sideways (or use the arrows) to look at the days either side. Tapping
 * Today in the tab bar again remounts this screen, which brings it back.
 */
export function TodayScreen({
  items,
  services,
  inScope,
  onOpenBooking,
  onNewBooking,
  onOpenCalendar,
}: {
  items: CalendarItem[];
  services: Service[];
  inScope: (item: CalendarItem) => boolean;
  onOpenBooking: (item: CalendarItem) => void;
  onNewBooking: () => void;
  onOpenCalendar: () => void;
}) {
  const nowMinutes = useBusinessMinute();
  const [offset, setOffset] = useState(0);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const isToday = offset === 0;
  const { week, day, label } = dayFromToday(offset);
  // Another day is read against its own end (past) or start (future): all
  // done, or nothing yet on now.
  const clock = isToday ? nowMinutes : offset < 0 ? Number.POSITIVE_INFINITY : -1;
  const rows = todaysBookings(items, { week, day, nowMinutes: clock, inScope }).map((row) =>
    isToday || row.state === "done" ? row : { ...row, state: "later" as const },
  );
  const featured = isToday ? featuredBooking(rows) : undefined;
  const summary = todaySummary(rows);
  const who = (item: CalendarItem) => item.client || item.title;
  const what = (item: CalendarItem) => itemService(item, services)?.name ?? "";

  return (
    <section
      className="module-page today-page"
      onTouchStart={(event) => {
        const touch = event.touches[0];
        touchStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
      }}
      onTouchEnd={(event) => {
        const start = touchStart.current;
        const touch = event.changedTouches[0];
        touchStart.current = null;
        if (!start || !touch) return;
        const dx = touch.clientX - start.x;
        const dy = touch.clientY - start.y;
        if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        setOffset((current) => current + (dx < 0 ? 1 : -1));
      }}
    >
      <header className="today-header">
        <button
          type="button"
          className="icon-button"
          onClick={() => setOffset((current) => current - 1)}
          aria-label={t("Previous day")}
          title={t("Previous day")}
        >
          <ChevronLeft size={20} />
        </button>
        <div className="today-header-day">
          <strong>{label}</strong>
          <span>
            {summary.total
              ? t("{total} booked · {done} done · {remaining} to go", summary)
              : isToday
                ? t("Nothing booked today")
                : t("Nothing booked")}
          </span>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={() => setOffset((current) => current + 1)}
          aria-label={t("Next day")}
          title={t("Next day")}
        >
          <ChevronRight size={20} />
        </button>
      </header>

      {featured && (
        <article className={`today-featured is-${featured.state}`}>
          <span className="today-featured-label">{STATE_LABEL[featured.state]}</span>
          <strong>{who(featured.item)}</strong>
          <span>
            {formatRange(featured.item.start, featured.item.duration)}
            {what(featured.item) ? ` · ${what(featured.item)}` : ""}
          </span>
          <button type="button" className="primary-button" onClick={() => onOpenBooking(featured.item)}>
            {t("Open booking")}
          </button>
        </article>
      )}

      <div className="today-actions">
        <button type="button" className="outline-button" onClick={onNewBooking}>
          <ClarityNewBooking size={18} />
          {t("New booking")}
        </button>
        <button type="button" className="outline-button" onClick={onOpenCalendar}>
          <ClarityCalendar size={18} />
          {t("Open calendar")}
        </button>
      </div>

      {rows.length > 0 && (
        <ol className="today-list">
          {rows.map(({ item, state }) => (
            <li key={item.id}>
              <button type="button" className={`today-row is-${state}`} onClick={() => onOpenBooking(item)}>
                <span className="today-row-time">{formatRange(item.start, item.duration)}</span>
                <span className="today-row-who">
                  <strong>{who(item)}</strong>
                  {what(item) ? <span>{what(item)}</span> : null}
                </span>
                {STATE_LABEL[state] ? <span className="today-row-state">{STATE_LABEL[state]}</span> : null}
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
