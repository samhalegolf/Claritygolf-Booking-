import { ArrowLeft, ArrowRight } from "lucide-react";
import { useMemo, useState } from "react";
import { t } from "../../lib/i18n";
import { buildWeekDays, type CalendarItem, formatTime, formatWeekTitle, getCurrentWeekOffset } from "../calendar/calendarModel";
import { QuickCreateForm } from "../calendar/QuickCreateForm";
import type { CalendarController } from "../calendar/useCalendarController";
import { WeekSlots } from "../public-booking/WeekSlots";
import type { QuickBookSlot } from "./quickBookModel";

/**
 * The phone's Book screen, laid out like the public booking page: every free
 * time in the week first, then who the booking is for. Picking a time opens
 * the calendar's own quick-create form underneath it, so a booking made here
 * is checked and saved exactly like one made by tapping the calendar.
 */
export function QuickBookScreen({
  calendar,
  slotsForWeek,
  onBooked,
}: {
  calendar: CalendarController;
  slotsForWeek: (week: number) => QuickBookSlot[];
  onBooked: (item: CalendarItem) => void;
}) {
  const { quickCreate, setQuickCreate, setQuickClientSearch } = calendar;
  const currentWeek = getCurrentWeekOffset();
  const [week, setWeek] = useState(currentWeek);
  const weekDays = useMemo(() => buildWeekDays(week), [week]);
  const picked = quickCreate ? buildWeekDays(quickCreate.week)[quickCreate.day] : null;

  function pick(slot: QuickBookSlot) {
    setQuickClientSearch("");
    setQuickCreate({
      week: slot.week,
      day: slot.day,
      start: slot.start,
      x: 0,
      y: 0,
      serviceId: "",
      phone: "",
      email: "",
      note: "",
      attendees: [],
      attendeeName: "",
      attendeeEmail: "",
      error: "",
    });
  }

  return (
    <section className="module-page today-page quick-book-page">
      <header className="today-header">
        <strong>{t("Book")}</strong>
        <span>{quickCreate ? formatWeekTitle(quickCreate.week) : t("Pick a time")}</span>
      </header>

      {quickCreate && picked ? (
        <>
          <button type="button" className="quick-book-time" onClick={() => setQuickCreate(null)}>
            <span>
              <strong>{formatTime(quickCreate.start)}</strong>
              <em>{picked.label}</em>
            </span>
            <span className="quick-book-change">{t("Change")}</span>
          </button>
          <div className="quick-create quick-book-form">
            <QuickCreateForm calendar={calendar} onCreated={onBooked} />
          </div>
        </>
      ) : (
        <div>
          <div className="booking-week-controls">
            <button type="button" onClick={() => setWeek((value) => value - 1)} disabled={week <= currentWeek}>
              <ArrowLeft size={15} />
              <span>{t("Previous week")}</span>
            </button>
            <strong>{formatWeekTitle(week)}</strong>
            <button type="button" onClick={() => setWeek((value) => value + 1)}>
              <span>{t("Next week")}</span>
              <ArrowRight size={15} />
            </button>
          </div>
          <WeekSlots
            week={week}
            slots={slotsForWeek(week)}
            dayLabel={(day) => weekDays[day].label}
            slotLabel={(slot) => formatTime(slot.start)}
            isSelected={() => false}
            onSelect={pick}
            emptyLabel={t("No free times this week.")}
          />
        </div>
      )}
    </section>
  );
}
