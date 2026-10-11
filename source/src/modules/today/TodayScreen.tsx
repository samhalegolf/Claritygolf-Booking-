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
/** Movement before a touch is read as a sideways drag or a scroll. */
const DRAG_DECIDE_PX = 8;
/** One leg of the card slide: out, then the next day in. */
const SLIDE_MS = 180;

function reducedMotion() {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

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
 * Swipe sideways (or use the arrows) to look at the days either side. The day
 * moves like a card: it follows the finger, slides off, and the next day slides
 * in from the other side. On another day the date becomes a button back to
 * today; tapping Today in the tab bar again (which remounts this screen) does
 * the same.
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
  const cardRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; dx: number; sideways: boolean | null } | null>(null);
  const sliding = useRef(false);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((id) => window.clearTimeout(id)), []);

  /** Place the card `x` across (a CSS length), animated or not. Styled directly
   *  so a drag does not re-render the day on every touchmove. */
  function placeCard(x: string, animate: boolean) {
    const card = cardRef.current;
    if (!card) return;
    card.style.transition = animate ? `transform ${SLIDE_MS}ms ease-out, opacity ${SLIDE_MS}ms ease-out` : "none";
    card.style.transform = x === "0" ? "" : `translateX(${x})`;
    card.style.opacity = x.endsWith("%") && x !== "0" ? "0" : "";
  }

  /** Move `step` days (negative is back), sliding the card the way it went. */
  function moveDays(step: number) {
    if (!step || sliding.current) return;
    if (reducedMotion()) {
      placeCard("0", false);
      setOffset((current) => current + step);
      return;
    }
    sliding.current = true;
    // Forward in time leaves to the left, as a swipe left does.
    placeCard(step > 0 ? "-100%" : "100%", true);
    timers.current.push(
      window.setTimeout(() => {
        setOffset((current) => current + step);
        placeCard(step > 0 ? "100%" : "-100%", false);
        // Two frames, so the jump to the far side is painted before it slides back in.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            placeCard("0", true);
            timers.current.push(window.setTimeout(() => (sliding.current = false), SLIDE_MS));
          }),
        );
      }, SLIDE_MS),
    );
  }

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
        drag.current = touch && !sliding.current ? { x: touch.clientX, y: touch.clientY, dx: 0, sideways: null } : null;
      }}
      onTouchMove={(event) => {
        const current = drag.current;
        const touch = event.touches[0];
        if (!current || !touch) return;
        const dx = touch.clientX - current.x;
        const dy = touch.clientY - current.y;
        if (current.sideways === null) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_DECIDE_PX) return;
          current.sideways = Math.abs(dx) > Math.abs(dy);
        }
        if (!current.sideways) return;
        current.dx = dx;
        placeCard(`${dx}px`, false);
      }}
      onTouchEnd={() => {
        const current = drag.current;
        drag.current = null;
        if (!current?.sideways) return;
        if (Math.abs(current.dx) >= SWIPE_MIN_PX) moveDays(current.dx < 0 ? 1 : -1);
        else placeCard("0", true);
      }}
      onTouchCancel={() => {
        drag.current = null;
        placeCard("0", true);
      }}
    >
      <header className="today-header">
        <button
          type="button"
          className="icon-button"
          onClick={() => moveDays(-1)}
          aria-label={t("Previous day")}
          title={t("Previous day")}
        >
          <ChevronLeft size={20} />
        </button>
        <div className="today-header-day">
          {isToday ? (
            <strong>{label}</strong>
          ) : (
            <button
              type="button"
              className="today-back-button"
              onClick={() => moveDays(-offset)}
              aria-label={t("Back to today")}
              title={t("Back to today")}
            >
              {label}
            </button>
          )}
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
          onClick={() => moveDays(1)}
          aria-label={t("Next day")}
          title={t("Next day")}
        >
          <ChevronRight size={20} />
        </button>
      </header>

      {/* Not part of the day, so they stay put while the day slides. */}
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

      <div className="today-viewport">
        <div className="today-card" ref={cardRef}>
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
        </div>
      </div>
    </section>
  );
}
