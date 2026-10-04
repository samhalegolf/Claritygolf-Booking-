import { useEffect, useState } from "react";
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

/**
 * The phone layout's first screen: today's bookings for this coach (or the
 * whole business, for an admin), the one on now or coming next, and the two
 * things a coach most often does from here.
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
  const week = getCurrentWeekOffset();
  const weekDays = buildWeekDays(week);
  const day = Math.max(0, weekDays.findIndex((weekDay) => weekDay.isToday));
  const rows = todaysBookings(items, { week, day, nowMinutes, inScope });
  const featured = featuredBooking(rows);
  const summary = todaySummary(rows);
  const who = (item: CalendarItem) => item.client || item.title;
  const what = (item: CalendarItem) => itemService(item, services)?.name ?? "";

  return (
    <section className="module-page today-page">
      <header className="today-header">
        <strong>{weekDays[day]?.label}</strong>
        <span>
          {summary.total
            ? t("{total} booked · {done} done · {remaining} to go", summary)
            : t("Nothing booked today")}
        </span>
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
