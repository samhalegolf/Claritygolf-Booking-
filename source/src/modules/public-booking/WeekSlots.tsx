import { useState, type ReactNode } from "react";
import { ClaritySessions } from "../shared/ClarityIcons";

export type WeekSlot = { week: number; day: number; start: number };

type WeekSlotsProps<S extends WeekSlot> = {
  week: number;
  slots: S[];
  /** The heading over one day's times, e.g. "Monday, Oct 5". */
  dayLabel: (day: number) => string;
  slotLabel: (slot: S) => ReactNode;
  isSelected: (slot: S) => boolean;
  onSelect: (slot: S) => void;
  /** Shown when nothing in the week is free. */
  emptyLabel: string;
  /** Shown instead of the times while they load or when they failed to. */
  placeholder?: ReactNode;
};

/**
 * Every free time in the week, stacked under its day. The player reads the
 * whole week at a glance instead of opening one day at a time to find out it
 * is empty. Days with nothing free are left out.
 *
 * A new week slides in from the side the player moved towards, so it is clear
 * the times underneath have changed and not just re-rendered.
 */
export function WeekSlots<S extends WeekSlot>({ week, slots, dayLabel, slotLabel, isSelected, onSelect, emptyLabel, placeholder }: WeekSlotsProps<S>) {
  // Which way the week last moved. Derived during render (React's pattern for
  // state that follows a prop) so the first frame of the new week already has
  // its direction. It lives here rather than on the week's own element so it
  // survives the loading placeholder, and is cleared once the slide has played
  // so reloading the same week does not slide it in again.
  const [paging, setPaging] = useState({ week, direction: "none" as "next" | "previous" | "none" });
  if (paging.week !== week) setPaging({ week, direction: week > paging.week ? "next" : "previous" });

  if (placeholder) return <div className="booking-week-slots">{placeholder}</div>;

  const days = Array.from({ length: 7 }, (_, day) => ({ day, slots: slots.filter((slot) => slot.day === day) }))
    .filter((entry) => entry.slots.length);

  return (
    <div
      className={`booking-week-slots booking-week-enter-${paging.direction}`}
      key={week}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) setPaging((current) => ({ ...current, direction: "none" }));
      }}
    >
      {days.length ? (
        days.map(({ day, slots: daySlots }) => (
          <section className="booking-week-day" key={day}>
            <h4>{dayLabel(day)}</h4>
            <div className="time-slots">
              {daySlots.map((slot) => (
                <button
                  className={isSelected(slot) ? "selected-time" : ""}
                  key={`${slot.day}-${slot.start}`}
                  onClick={() => onSelect(slot)}
                  type="button"
                >
                  <ClaritySessions size={15} />
                  {slotLabel(slot)}
                </button>
              ))}
            </div>
          </section>
        ))
      ) : (
        <p className="booking-week-empty">{emptyLabel}</p>
      )}
    </div>
  );
}
