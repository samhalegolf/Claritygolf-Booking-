import { GripVertical, Minimize2, X } from "lucide-react";
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatDurationLabel, WEEK_PANEL_OFFSETS } from "../../calendar-axis";
import { t } from "../../lib/i18n";
import { notificationStatusLabel } from "../notifications/notificationModel";
import { ClarityCalendar } from "../shared/ClarityIcons";
import { activeLocations, canUseFeature, locationById } from "../workspace/workspaceModel";
import {
  bookingLocationShortDisplay,
  buildWeekDays,
  calendarItemLocation,
  calendarLessonColor,
  formatRange,
  formatTime,
  isCoachLocationBlock,
  isCoachOnlyBlock,
  isLocationOnlyBlock,
  isSlotInPast,
  itemService,
  itemWeek,
  resolvedCalendarItemCoachId,
  resolvedCalendarItemLocationId,
} from "./calendarModel";
import { QuickCreateForm } from "./QuickCreateForm";
import type { CalendarController } from "./useCalendarController";

/** The calendar screen. Everything it shows and does comes from its controller. */
export function CalendarView({ calendar }: { calendar: CalendarController }) {
  const {
    pointerSession,
    activeDockBooking,
    isAdminUser,
    effectiveCalendarPerspective,
    calendarPerspectiveChosenRef,
    setCalendarPerspective,
    activeAccount,
    accountLocations,
    selectedCalendarLocationId,
    availabilityLocationHue,
    setCalendarLocationFilterId,
    activeCoachList,
    selectedCalendarCoachId,
    setCalendarCoachFilterId,
    calendarDetailMode,
    toggleCalendarDetailMode,
    handleCalendarTouchStart,
    toggleCalendarDayView,
    weekTitle,
    calendarSaveStatus,
    calendarFeedStatus,
    calendarSaveError,
    calendarSaveFailureKind,
    locationCalendarCoachGroups,
    locationCalendarHasAppointments,
    calendarAxisMode,
    cycleCalendarAxisMode,
    weekStripRef,
    handleWeekStripScroll,
    beginWeekStripDrag,
    weekDays,
    activeWeek,
    calendarCollapsedDays,
    calendarDayFocus,
    focusCalendarDay,
    locationCalendarCoachItemCount,
    calendarScrollRef,
    gridHeight,
    visibleCalendarHourMarks,
    weekPanelsRef,
    renderWeekPeekPanel,
    gridRef,
    calendarAxis,
    beginBlankGesture,
    updatePointer,
    pointerClientRef,
    endPointer,
    calendarQuietGaps,
    calendarDayColumns,
    calendarAvailability,
    activeCoachId,
    renderAvailableBand,
    calendarNowTop,
    calendarTodayIndex,
    displayItems,
    clipCalendarSegment,
    services,
    coachProfiles,
    draft,
    calendarMinutesToTop,
    calendarSegmentHeight,
    placementAnimation,
    notificationsByAppointment,
    isScheduledGroupSessionSlot,
    isGroupSessionItem,
    getGroupSessionContext,
    locations,
    coachAccount,
    selectedId,
    holdingItemId,
    showCalendarItemHover,
    hideCalendarItemHover,
    beginMove,
    handleCalendarItemClick,
    suppressItemClickRef,
    suppressItemClickUntilRef,
    setSelectedGroupSession,
    setSelectedId,
    setQuickCreate,
    openGroupSessionFromSlot,
    beginResize,
    terms,
    quickCreate,
    hasMoved,
  } = calendar;

  return (
    <section
      className={`workspace ${pointerSession?.mode === "place" || activeDockBooking ? "placing-from-dock" : ""}`}
    >
      <div className="calendar-folder">
      {/* Which calendar you're looking at, as folder tabs on top of it:
          places on the left, people on the right. A coach who isn't an
          admin only ever sees their own, so they get no tabs. */}
      {isAdminUser ? (
        <div className="calendar-scope-tabs" role="tablist" aria-label={t("Calendar")}>
          <div className="calendar-scope-tab-group">
            <button
              type="button"
              role="tab"
              aria-selected={effectiveCalendarPerspective === "all"}
              className={effectiveCalendarPerspective === "all" ? "is-active" : ""}
              onClick={() => {
                calendarPerspectiveChosenRef.current = true;
                setCalendarPerspective("all");
              }}
            >{t("All")}</button>
            {canUseFeature(activeAccount, "locationCalendar")
              ? activeLocations(accountLocations).map((location) => {
                  const isActive =
                    effectiveCalendarPerspective === "location" && selectedCalendarLocationId === location.id;
                  return (
                    <button
                      type="button"
                      role="tab"
                      key={location.id}
                      aria-selected={isActive}
                      className={`is-location ${isActive ? "is-active" : ""}`}
                      style={{ ["--location-hue" as string]: String(availabilityLocationHue(location.id)) } as CSSProperties}
                      onClick={() => {
                        calendarPerspectiveChosenRef.current = true;
                        setCalendarPerspective("location");
                        setCalendarLocationFilterId(location.id);
                      }}
                    >
                      {location.shortName || location.name}
                    </button>
                  );
                })
              : null}
          </div>
          <div className="calendar-scope-tab-group">
            {activeCoachList.map((coach) => {
              const isActive = effectiveCalendarPerspective === "coach" && selectedCalendarCoachId === coach.id;
              return (
                <button
                  type="button"
                  role="tab"
                  key={coach.id}
                  aria-selected={isActive}
                  className={isActive ? "is-active" : ""}
                  onClick={() => {
                    calendarPerspectiveChosenRef.current = true;
                    setCalendarPerspective("coach");
                    setCalendarCoachFilterId(coach.id);
                  }}
                >
                  {coach.displayName || coach.name}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      <div
        className={`calendar-card ${calendarDetailMode ? "calendar-detail-mode" : ""}`}
        onDoubleClick={toggleCalendarDetailMode}
        onTouchStart={handleCalendarTouchStart}
      >
        <div className="calendar-toolbar">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {/* Says which of the two you are on. Tapping a day heading is how
                you get into a day; this is how you get back out to the week,
                and from the week it opens today. */}
            <button
              className={`calendar-span-switch ${calendarDayFocus !== null ? "is-day" : "is-week"}`}
              onClick={toggleCalendarDayView}
              type="button"
              aria-label={calendarDayFocus !== null ? t("Show the whole week") : t("Show today")}
            >
              <span>{t("Week")}</span>
              <span>{t("Day")}</span>
            </button>
            <h2>{weekTitle}</h2>
          </div>
          <div className={`calendar-save-pill ${calendarSaveStatus}`}>
            <strong>
              {calendarSaveStatus === "saving"
                ? t("Saving")
                : calendarSaveStatus === "saved"
                  ? t("Saved")
                  : calendarSaveStatus === "failed"
                    ? t("Not saved")
                    : calendarFeedStatus === "connected"
                      ? t("Live database")
                      : t("Not connected")}
            </strong>
            {calendarSaveStatus === "failed" && calendarSaveError ? <span>{calendarSaveError}</span> : null}
          </div>
        </div>
        {calendarSaveStatus === "failed" && (
          <div className="calendar-save-warning">
            {calendarSaveFailureKind === "delete"
              ? t("The delete didn't go through, so the lesson was put back on the calendar. Delete it again to retry.")
              : t("Your latest change was not saved. Please try again; the app will retry when you make another change.")}
          </div>
        )}
        {effectiveCalendarPerspective === "location" && !locationCalendarCoachGroups.length ? (
          <div className="calendar-save-warning">{t("No active coaches are assigned to this location yet.")}</div>
        ) : null}
        {effectiveCalendarPerspective === "location" && locationCalendarCoachGroups.length && !locationCalendarHasAppointments ? (
          <div className="calendar-save-warning">{t("No appointments at this location for the selected week.")}</div>
        ) : null}

        <div className={`calendar-header-row ${calendarDayFocus !== null ? "is-day-view" : ""}`}>
          <div className="time-gutter">
            {/* Sits above the time gutter because that is the corner the
                axis belongs to: it changes how the vertical scale reads,
                not what the week contains. */}
            <button
              type="button"
              className={`axis-cycle-button ${calendarAxisMode === "squash" ? "is-squashed" : ""}`}
              onClick={cycleCalendarAxisMode}
              aria-pressed={calendarAxisMode === "squash"}
              title={
                calendarAxisMode === "squash"
                  ? t("Squash view: quiet stretches collapsed. Switch to the full week.")
                  : t("Week view: every hour at full height. Switch to squash.")
              }
            >
              {calendarAxisMode === "squash" ? <Minimize2 size={16} /> : <ClarityCalendar size={16} />}
              <small>{calendarAxisMode === "squash" ? t("Squash") : t("Week")}</small>
            </button>
          </div>
          <div
            className="week-strip"
            ref={weekStripRef}
            onScroll={handleWeekStripScroll}
            onPointerDown={beginWeekStripDrag}
          >
            {WEEK_PANEL_OFFSETS.map((offset) => (
              <div className={`week-strip-panel ${offset === 0 ? "" : "is-off-week"}`} key={offset}>
                {(offset === 0 ? weekDays : buildWeekDays(activeWeek + offset)).map((day, dayIndex) => (
                  // In day view the strip is the day picker: the headings
                  // stay where they are and tapping one fills the grid with
                  // it. The open day stands up as a folder tab joined to the
                  // grid, so which day you are on reads at a glance.
                  <button
                    type="button"
                    className={`day-heading ${day.isToday ? "today" : ""} ${
                      offset === 0 && calendarCollapsedDays[dayIndex] ? "is-unavailable" : ""
                    } ${offset === 0 && calendarDayFocus === dayIndex ? "is-focused-day" : ""}`}
                    key={day.label}
                    aria-pressed={offset === 0 ? calendarDayFocus === dayIndex : undefined}
                    onClick={() => (offset === 0 ? focusCalendarDay(dayIndex) : undefined)}
                  >
                    {offset === 0 && calendarCollapsedDays[dayIndex] ? (
                      <span className="day-label">{day.short}</span>
                    ) : (
                      <>
                        <span>{day.short}</span>
                        <strong>{day.date}</strong>
                        {offset === 0 &&
                        effectiveCalendarPerspective === "location" &&
                        locationCalendarCoachGroups.length ? (
                          <div className="location-coach-columns" aria-label={t("Coach columns")}>
                            {locationCalendarCoachGroups.map((coach) => (
                              <em key={coach.coachId || coach.name}>
                                <span>{coach.displayName || coach.name}</span>
                                <small>{t("{coachId} appt", { coachId: locationCalendarCoachItemCount(coach.coachId) })}</small>
                              </em>
                            ))}
                          </div>
                        ) : null}
                      </>
                    )}
                  </button>
                ))}
              </div>
            ))}
            <div className="week-pager-spacer" aria-hidden="true" />
          </div>
        </div>

        <div className="calendar-scroll" ref={calendarScrollRef}>
          <div className="time-column" style={{ height: gridHeight }}>
            {visibleCalendarHourMarks.map(({ hour, top }) => {
              return (
                <div className="time-label" key={hour} style={{ top }}>
                  {hour === 12 * 60 ? t("Noon") : formatTime(hour).replace(":00 ", "")}
                </div>
              );
            })}
          </div>

          {/* Driven, never scrolled directly: it mirrors the date strip. */}
          <div className="week-pager" ref={weekPanelsRef}>
            {renderWeekPeekPanel(-1)}
            <div className="week-pager-panel">
          <div
            ref={gridRef}
            className={`week-grid ${pointerSession ? "is-grabbing" : ""} ${
              calendarAxis.squashed ? "is-squashed" : ""
            } ${calendarDayFocus !== null ? "is-day-view" : ""}`}
            style={{ height: gridHeight }}
            onPointerDown={beginBlankGesture}
            onPointerMove={updatePointer}
            onPointerUp={(event) => {
              pointerClientRef.current = { x: event.clientX, y: event.clientY };
              endPointer();
            }}
            onPointerCancel={(event) => {
              pointerClientRef.current = { x: event.clientX, y: event.clientY };
              endPointer();
            }}
            onPointerLeave={(event) => {
              if (pointerSession) updatePointer(event);
            }}
          >
            {/* Full-width markers for the stretches squash collapsed, so the
                time that was skipped is stated rather than just missing. */}
            {calendarQuietGaps.map((gap) => (
              <div className="quiet-gap" key={gap.start} style={{ top: gap.top, height: gap.height }}>
                <small>{t("{value} quiet · {start} – {end}", { value: formatDurationLabel(gap.end - gap.start), start: formatTime(gap.start), end: formatTime(gap.end) })}</small>
              </div>
            ))}

            {weekDays.map((day, dayIndex) => (
              <div
                className={`day-lane ${calendarCollapsedDays[dayIndex] ? "is-unavailable" : ""}`}
                key={day.label}
                hidden={calendarDayColumns[dayIndex].hidden}
                style={{ left: calendarDayColumns[dayIndex].left, width: calendarDayColumns[dayIndex].width }}
              >
                {effectiveCalendarPerspective === "location" && locationCalendarCoachGroups.length > 1
                  ? // One lane per coach, in the same order and width as the
                    // columns their bookings land in, each carrying only
                    // that coach's hours. An empty lane is a coach not
                    // working that day.
                    locationCalendarCoachGroups.map((coach, coachIndex) => (
                      <div
                        className="location-coach-lane"
                        key={coach.coachId || coach.name}
                        style={{
                          left: `${(coachIndex * 100) / locationCalendarCoachGroups.length}%`,
                          width: `${100 / locationCalendarCoachGroups.length}%`,
                        }}
                      >
                        {calendarAvailability[dayIndex]
                          .filter((window) => (window.coachId || activeCoachId) === coach.coachId)
                          .map((window, index) => renderAvailableBand(window, `${day.label}-${coach.coachId}-${index}`))}
                      </div>
                    ))
                  : calendarAvailability[dayIndex].map((window, index) =>
                      renderAvailableBand(window, `${day.label}-${index}`),
                    )}
              </div>
            ))}

            {calendarNowTop !== null && !calendarDayColumns[calendarTodayIndex]?.hidden ? (
              <div
                className="calendar-now-line"
                aria-hidden="true"
                style={{
                  top: calendarNowTop,
                  left: calendarDayColumns[calendarTodayIndex].left,
                  width: calendarDayColumns[calendarTodayIndex].width,
                }}
              />
            ) : null}

            {displayItems.map((item) => {
              const visibleItem = clipCalendarSegment(item.start, item.duration);
              if (!visibleItem) return null;
              // Day view draws one day; the rest are not on screen at all.
              if (calendarDayColumns[item.day]?.hidden) return null;
              const service = itemService(item, services);
              const resolvedItemCoachId = resolvedCalendarItemCoachId(item, service, coachProfiles);
              const activeDraft =
                draft && (draft.mode === "move" || draft.mode === "resize") && draft.itemId === item.id
                  ? draft
                  : null;
              const invalid = activeDraft ? !activeDraft.valid : false;
              const top = calendarMinutesToTop(visibleItem.start);
              const height = calendarSegmentHeight(visibleItem.start, visibleItem.duration);
              const dayColumn = calendarDayColumns[item.day] ?? calendarDayColumns[0];
              const coachColumnCount =
                effectiveCalendarPerspective === "location" ? Math.max(1, locationCalendarCoachGroups.length) : 1;
              const locationWideBlock = effectiveCalendarPerspective === "location" && isLocationOnlyBlock(item);
              const coachColumnIndex =
                effectiveCalendarPerspective === "location" && !locationWideBlock
                  ? Math.max(
                      0,
                      locationCalendarCoachGroups.findIndex(
                        (coach) => coach.coachId === resolvedItemCoachId,
                      ),
                    )
                  : 0;
              // Widths come off the day column rather than a flat 1/7 so a
              // card still lands in its lane when squash view has collapsed
              // some of the other days to a hairline.
              const columnWidth =
                locationWideBlock || coachColumnCount === 1
                  ? dayColumn.width
                  : `calc(${dayColumn.width} / ${coachColumnCount})`;
              const columnLeft = coachColumnIndex
                ? `calc(${dayColumn.left} + ${coachColumnIndex} * ${
                    columnWidth.startsWith("calc") ? columnWidth.slice(4) : `(${columnWidth})`
                  })`
                : dayColumn.left;
              const flyAnimation = placementAnimation?.itemId === item.id ? placementAnimation : null;
              const itemNotifications = notificationsByAppointment.get(item.id) ?? [];
              const latestClientEmail = itemNotifications.find((notification) => notification.kind.includes("client"));
              const latestCoachEmail = itemNotifications.find((notification) => notification.kind.includes("coach"));
              const latestAdminEmail = itemNotifications.find((notification) => notification.kind.includes("admin"));
              // A card fades only once the lesson is over, so "already
              // happened" never gets confused with "cancelled" — status is
              // carried by the border instead.
              const isPastItem =
                item.kind === "appointment" &&
                isSlotInPast({ week: itemWeek(item), day: item.day, start: item.start + item.duration });
              const scheduledGroupSession = isScheduledGroupSessionSlot(item);
              const groupSessionItem = isGroupSessionItem(item);
              const groupSessionContext = getGroupSessionContext(item);
              // The bay or room this lesson holds rides along with the place.
              // The location view already is one place, so it shows the bay alone.
              const itemResourceName = item.resourceId
                ? locationById(locations, resolvedCalendarItemLocationId(item, service, locations, coachAccount))
                    ?.resources?.find((resource) => resource.id === item.resourceId)?.name ?? ""
                : "";
              const itemLocationTag =
                item.kind === "appointment" || groupSessionContext
                  ? [
                      effectiveCalendarPerspective === "location"
                        ? ""
                        : bookingLocationShortDisplay(calendarItemLocation(item, service, locations, coachAccount)),
                      itemResourceName,
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : "";
              const tooltipRows = [
                groupSessionContext ? t("Group Session") : item.client || item.title,
                groupSessionContext
                  ? t("Booked: {booked}/{capacity}", { booked: groupSessionContext.bookedCount, capacity: groupSessionContext.capacity })
                  : service?.name ?? (item.kind === "block" ? t("Blocked time") : t("Lesson")),
                formatRange(item.start, item.duration),
                latestClientEmail ? t("Client email: {status}", { status: notificationStatusLabel(latestClientEmail) }) : "",
                latestCoachEmail ? t("Coach email: {status}", { status: notificationStatusLabel(latestCoachEmail) }) : "",
                latestAdminEmail ? t("Admin email: {status}", { status: notificationStatusLabel(latestAdminEmail) }) : "",

              ].filter(Boolean);
              return (
                <article
                  data-calendar-item
                  key={item.id}
                  className={`calendar-item ${item.kind} ${
                    isLocationOnlyBlock(item) ? "location-wide-block" : ""
                  } ${isCoachLocationBlock(item) ? "coach-location-block" : ""} ${
                    isCoachOnlyBlock(item) ? "coach-only-block" : ""
                  } ${selectedId === item.id ? "selected" : ""} ${
                    invalid ? "invalid" : ""
	                      } ${flyAnimation ? "just-placed-from-dock" : ""} ${
	                        pointerSession?.mode === "move" && pointerSession.itemId === item.id ? "is-lifted" : ""
	                      } ${
	                        pointerSession?.mode === "resize" && pointerSession.itemId === item.id ? "is-resizing" : ""
	                      } ${holdingItemId === item.id ? "is-holding" : ""} ${
	                        item.kind === "appointment" && item.status ? `status-${item.status}` : ""
	                      } ${
                    item.kind === "appointment" && item.bayBooked ? "has-bay" : ""
                  } ${isPastItem ? "is-past" : ""}`}

                  aria-label={tooltipRows.join(", ")}
                  onPointerEnter={(event) =>
                    showCalendarItemHover(event, item, service, latestClientEmail, latestCoachEmail, latestAdminEmail)
                  }
                  onPointerLeave={() => hideCalendarItemHover(item.id)}
                  style={{
                    top,
                    height: Math.max(height, 34),
                    // Tucked inside the availability card behind it (inset
                    // 3px left / 15px right) with 2px to spare on each
                    // side, so a day column always reads wider than the
                    // bookings sitting in it.
                    left: `calc(${columnLeft} + var(--card-inset-left, 5px))`,
                    width: `calc(${columnWidth} - var(--card-inset-total, 22px))`,
                    // The fill is the lesson type. Set here rather than by
                    // a class because the palette is per service, and
                    // services are whatever this coach sells.
                    ...(item.kind === "appointment" && calendarLessonColor(service)
                      ? ({ "--lesson-type-color": calendarLessonColor(service) } as CSSProperties)
                      : {}),
                    ...(scheduledGroupSession ? ({ cursor: "pointer" } as CSSProperties) : {}),
                    ...(flyAnimation
                      ? ({
                          "--dock-fly-x": `${flyAnimation.fromX}px`,
                          "--dock-fly-y": `${flyAnimation.fromY}px`,
                        } as CSSProperties)
                      : {}),
                  }}
                  onPointerDown={(event) => {
                    if (scheduledGroupSession) {
                      event.stopPropagation();
                      hideCalendarItemHover();
                      return;
                    }
                    if (item.readOnly || groupSessionItem) return;
                    hideCalendarItemHover();
                    beginMove(event, item);
                  }}
                  onPointerUp={(event) => {
                    if (groupSessionItem && !scheduledGroupSession) {
                      event.preventDefault();
                      handleCalendarItemClick(event, item);
                    }
                  }}
                  onClick={(event) => {
                    if (suppressItemClickRef.current || Date.now() < suppressItemClickUntilRef.current) return;
                    if (groupSessionItem && !scheduledGroupSession) {
                      event.preventDefault();
                      event.stopPropagation();
                      handleCalendarItemClick(event, item);
                      return;
                    }
                    event.stopPropagation();
                    setSelectedGroupSession(null);
                    setSelectedId(item.id);
                    setQuickCreate(null);
                  }}
                  onKeyDown={(event) => {
                    if ((event.key === "Enter" || event.key === " ") && groupSessionItem && !scheduledGroupSession) {
                      handleCalendarItemClick(event, item);
                    }
                  }}
                >
                  {item.readOnly ? null : (
                    <div className="item-grip" aria-hidden="true">
                      <GripVertical size={14} />
                    </div>
                    )}
                    {scheduledGroupSession ? (
                      <button
                        type="button"
                        className="outline-button"
                        onPointerDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          openGroupSessionFromSlot(item);
                        }}
                      >{t("Open session")}</button>
                    ) : null}
                    <div className="item-content">
                    <strong>{groupSessionContext ? groupSessionContext.service.name : item.kind === "appointment" ? item.client || item.title : item.title}</strong>
                    <span>
                      {groupSessionContext
                        ? t("Group Session")
                        : item.kind === "block" && isLocationOnlyBlock(item)
                          ? t("Location unavailable")
                          : item.kind === "block" && isCoachLocationBlock(item)
                            ? t("Coach unavailable")
                            : service?.name ?? t("Busy")}
                    </span>
                    <em>
                      {groupSessionContext
                        ? t("{start} · {bookedCount}/{capacity} booked", { start: formatRange(item.start, item.duration), bookedCount: groupSessionContext.bookedCount, capacity: groupSessionContext.capacity })
                        : formatRange(item.start, item.duration)}
                    </em>
                    {itemLocationTag ? <small className="item-location-tag">{itemLocationTag}</small> : null}
                  </div>
                  {/* The C/O/A email dots lived here. Email status is still on
                      the booking card and in the hover tooltip; three letters
                      on every card was noise on the one view that has to stay
                      readable at a glance. */}
                  {item.readOnly ? null : (
                    <button
                      className="resize-handle"
                      aria-label={t("Resize calendar item")}
                      onPointerDown={(event) => beginResize(event, item)}
                    />
                  )}
                </article>
              );
            })}

            {draft?.mode === "block" && (
              (() => {
                const visibleDraft = clipCalendarSegment(draft.start, draft.duration);
                if (!visibleDraft) return null;
                return (
                  <div
                    className={`calendar-item block draft-block ${draft.valid ? "" : "invalid"}`}
                    style={{
                      top: calendarMinutesToTop(visibleDraft.start),
                      height: Math.max(calendarSegmentHeight(visibleDraft.start, visibleDraft.duration), 24),
                      left: `calc(${(calendarDayColumns[draft.day] ?? calendarDayColumns[0]).left} + var(--card-inset-left, 5px))`,
                      width: `calc(${(calendarDayColumns[draft.day] ?? calendarDayColumns[0]).width} - var(--card-inset-total, 22px))`,
                    }}
                  >
                    <div className="item-content">
                      <strong>{t("Busy")}</strong>
                      <span>{t("New blocked time")}</span>
                      <em>{formatRange(draft.start, draft.duration)}</em>
                    </div>
                  </div>
                );
              })()
            )}

            {draft?.mode === "place" && pointerSession?.mode === "place" && (
              (() => {
                const visibleDraft = clipCalendarSegment(draft.start, draft.duration);
                if (!visibleDraft) return null;
                return (
                  <div
                    className={`calendar-item appointment draft-place ${draft.valid ? "" : "invalid"}`}
                    style={{
                      top: calendarMinutesToTop(visibleDraft.start),
                      height: Math.max(calendarSegmentHeight(visibleDraft.start, visibleDraft.duration), 34),
                      left: `calc(${(calendarDayColumns[draft.day] ?? calendarDayColumns[0]).left} + var(--card-inset-left, 5px))`,
                      width: `calc(${(calendarDayColumns[draft.day] ?? calendarDayColumns[0]).width} - var(--card-inset-total, 22px))`,
                    }}
                  >
                    <div className="item-grip" aria-hidden="true">
                      <GripVertical size={14} />
                    </div>
                    <div className="item-content">
                      <strong>{pointerSession.booking.client}</strong>
                      <span>
                        {services.find((service) => service.id === pointerSession.booking.serviceId)?.name ?? terms.serviceSingular}
                      </span>
                      <em>{formatRange(draft.start, draft.duration)}</em>
                    </div>
                  </div>
                );
              })()
            )}
          </div>
            </div>
            {renderWeekPeekPanel(1)}
            <div className="week-pager-spacer" aria-hidden="true" />
          </div>
        </div>

        {quickCreate && !hasMoved && <QuickCreatePopover calendar={calendar} />}
      </div>
      </div>

    </section>
  );
}

/**
 * The quick-create popover over the time tapped. It measures itself so the
 * controller can keep all of it on screen, and follows the keyboard on a
 * phone. The header and close button stay put; only the body scrolls.
 */
function QuickCreatePopover({ calendar }: { calendar: CalendarController }) {
  const { quickCreate, quickCreatePopoverStyle, setQuickCreate, weekDays } = calendar;
  const popoverRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [, setViewportChanges] = useState(0);

  useLayoutEffect(() => {
    const measured = popoverRef.current?.offsetHeight ?? 0;
    if (Math.abs(measured - height) > 1) setHeight(measured);
  });

  useEffect(() => {
    const onViewportChange = () => setViewportChanges((count) => count + 1);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", onViewportChange);
    viewport?.addEventListener("scroll", onViewportChange);
    window.addEventListener("resize", onViewportChange);
    return () => {
      viewport?.removeEventListener("resize", onViewportChange);
      viewport?.removeEventListener("scroll", onViewportChange);
      window.removeEventListener("resize", onViewportChange);
    };
  }, []);

  if (!quickCreate) return null;
  return (
    <div className="quick-create" ref={popoverRef} style={quickCreatePopoverStyle(height)}>
      <button className="popover-close" aria-label={t("Close quick create")} onClick={() => setQuickCreate(null)}>
        <X size={15} />
      </button>
      <span>{`${weekDays[quickCreate.day].short}, ${formatTime(quickCreate.start)}`}</span>
      <strong>{t("Quick create")}</strong>
      <div className="quick-create-body">
        <QuickCreateForm calendar={calendar} allowBlocks />
      </div>
    </div>
  );
}
