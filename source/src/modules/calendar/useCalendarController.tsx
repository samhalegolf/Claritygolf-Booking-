import {
  type CSSProperties,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
  type SetStateAction,
  useMemo,
  useRef,
} from "react";
import type { BusinessTerminology } from "../../../netlify/functions/_shared/business-terminology.mts";
import {
  axisMinuteToTop,
  buildDayColumns,
  type CalendarAxis,
  DAY_COUNT,
  dayColumnPixels,
  HOUR_HEIGHT,
  WEEK_FOCUS_INDEX,
  WEEK_PANEL_COUNT,
} from "../../calendar-axis";
import { activeLocale } from "../../lib/activeCountry";
import { t } from "../../lib/i18n";
import { clamp } from "../../lib/number";
import {
  ClientSummary,
  findClientMatch,
  hasClientMatchInput,
  normalizeMatchText,
  phoneValuesMatch,
} from "../clients/clientMatching";
import { NotificationRecord, notificationStatusLabel } from "../notifications/notificationModel";
import {
  calculateCustomGroupPrice,
  customGroupMaxParticipants,
  customGroupMinParticipants,
  isCustomGroupService,
  isScheduledGroupService,
  Service,
} from "../services/serviceModel";
import { isPhoneLayout } from "../phone/phoneLayout";
import { ClarityProfile } from "../shared/ClarityIcons";
import type { Toast } from "../shared/toast";
import type { CalendarState } from "./useCalendarState";
import type { CalendarInteraction } from "./useCalendarInteraction";
import {
  type AppUser,
  type CoachAccount,
  type CoachProfile,
  defaultLocationFromCoachAccount,
  defaultLocationId,
  firstCoachId,
  type Location,
  locationById,
  type WorkspaceAccount,
} from "../workspace/workspaceModel";
import {
  adminCustomGroupAttendee,
  AvailabilityWindow,
  type BookingCoachSnapshot,
  bookingCoachSnapshotFor,
  bookingLocationShortDisplay,
  bookingLocationSnapshotFor,
  type BookingStatus,
  type CalendarFeedStatus,
  CalendarItem,
  calendarItemCoachColumnId,
  calendarItemLocation,
  type CalendarPerspective,
  type CalendarSaveStatus,
  cleanBookingLocationSnapshot,
  customGroupBookerAttendee,
  dateForSlot,
  externalRescheduleMessage,
  formatRange,
  GroupSession,
  isExternallyOwned,
  itemService,
  itemSlot,
  itemWeek,
  locationSnapshot,
  newCalendarItemId,
  overlaps,
  type PendingBooking,
  type SlotCandidate,
  TOUCH_HOLD_MS,
  TOUCH_HOLD_TOLERANCE,
} from "./calendarModel";

export type CalendarControllerInputs = {
  calendarInteraction: CalendarInteraction;
  calendarState: CalendarState;
  visibleWeekItems: CalendarItem[];
  services: Service[];
  coachProfiles: CoachProfile[];
  accountCoachProfiles: CoachProfile[];
  activeCoachId: string;
  availabilityLocations: Location[];
  calendarStartMinutes: number;
  calendarEndMinutes: number;
  activeServices: Service[];
  scheduledGroupSlots: CalendarItem[];
  items: CalendarItem[];
  calendarCollapsedDays: boolean[];
  calendarAxis: CalendarAxis;
  calendarMinutesToTop: (minutes: number) => number;
  clients: ClientSummary[];
  locations: Location[];
  coachAccount: CoachAccount;
  setToast: Dispatch<SetStateAction<Toast | null>>;
  isGroupServiceSlotMatch: (service: Service | null | undefined, week: number, day: number, start: number) => boolean;
  setSelectedGroupSession: Dispatch<SetStateAction<GroupSession | null>>;
  setSelectedId: Dispatch<SetStateAction<string>>;
  isActiveGroupBooking: (status: BookingStatus | undefined) => boolean;
  effectiveCalendarPerspective: CalendarPerspective;
  locationCalendarCoachGroups: BookingCoachSnapshot[];
  slotFromClient: (clientX: number, clientY: number) => { day: number; start: number; x: number; y: number } | null;
  setActiveWeekState: (nextWeek: number) => void;
  gridHeight: number;
  calendarAvailability: AvailabilityWindow[][];
  clipCalendarSegment: (start: number, duration: number) => { start: number; duration: number } | null;
  calendarSegmentHeight: (start: number, duration: number) => number;
  hasMultipleAvailabilityLocations: boolean;
  availabilityLocationHue: (locationId?: string) => number | null;
  availabilityLocationLabel: (locationId?: string) => string;
  resetPointerTrail: (clientX: number, clientY: number) => void;
  setMovedState: (nextMoved: boolean) => void;
  attachGestureListeners: (options?: { blockTouchScroll?: boolean }) => void;
  requireLiveDatabase: (action?: string) => boolean;
  selectedCalendarLocationId: string;
  activeDockBooking: PendingBooking | null;
  updatePointerAt: (clientX: number, clientY: number) => void;
  appointmentServices: Service[];
  calendarBookingChoices: (service: Service) => { coachIds: string[]; locationIds: string[]; fixedCoachId: string; fixedLocationId: string };
  quickCreateAvailabilityError: (candidate: SlotCandidate, service?: Service, choice?: { coachId?: string; locationId?: string }) => string;
  isValidAppointmentSlot: (candidate: SlotCandidate, ignoreId?: string, service?: Service, options?: { candidateCoachId?: string; candidateLocationId?: string }) => boolean;
  confirmPastAdminLesson: (candidate: SlotCandidate) => boolean;
  activeAccountId: string;
  setItems: Dispatch<SetStateAction<CalendarItem[]>>;
  carveBusyBlocksForAppointment: (nextItems: CalendarItem[], appointment: SlotCandidate) => CalendarItem[];
  selectedGroupSession: GroupSession | null;
  selectedCalendarCoachId: string;
  currentAppUser: AppUser;
  isValidBlockSlot: (candidate: SlotCandidate, ignoreId?: string, options?: { coachId?: string; locationId?: string; locationOnly?: boolean }) => boolean;
  closeCalendarDetails: () => void;
  reconcileUndoByDelete: (itemId: string, previousItems: CalendarItem[]) => Promise<void>;
  isAdminUser: boolean;
  activeAccount: WorkspaceAccount;
  accountLocations: Location[];
  activeCoachList: CoachProfile[];
  calendarSaveStatus: CalendarSaveStatus;
  calendarFeedStatus: CalendarFeedStatus;
  calendarSaveError: string;
  calendarSaveFailureKind: "change" | "delete";
  endPointer: () => void;
  notificationsByAppointment: Map<string, NotificationRecord[]>;
  selectedId: string;
  terms: BusinessTerminology;
  quickCreateServices: Service[];
  /** The Week/Day switch: the week from a day, today from the week. */
  toggleCalendarDayView: () => void;
};

/**
 * The calendar screen's own logic: the week strip, the day columns, the
 * quick-create popover and the drag gestures that start on the grid.
 *
 * Called from App so its state outlives a trip to another screen. What it
 * shares with the rest of the workspace (the bookings, the week on show, the
 * pointer session the dock also drives) comes in through `app`; shrinking
 * that list is how the calendar becomes its own feature.
 */
export function useCalendarController(app: CalendarControllerInputs) {
  const {
    visibleWeekItems,
    services,
    coachProfiles,
    accountCoachProfiles,
    activeCoachId,
    availabilityLocations,
    calendarStartMinutes,
    calendarEndMinutes,
    activeServices,
    scheduledGroupSlots,
    items,
    calendarCollapsedDays,
    calendarAxis,
    calendarMinutesToTop,
    clients,
    locations,
    coachAccount,
    setToast,
    isGroupServiceSlotMatch,
    setSelectedGroupSession,
    setSelectedId,
    isActiveGroupBooking,
    effectiveCalendarPerspective,
    locationCalendarCoachGroups,
    slotFromClient,
    setActiveWeekState,
    gridHeight,
    calendarAvailability,
    clipCalendarSegment,
    calendarSegmentHeight,
    hasMultipleAvailabilityLocations,
    availabilityLocationHue,
    availabilityLocationLabel,
    resetPointerTrail,
    setMovedState,
    attachGestureListeners,
    requireLiveDatabase,
    selectedCalendarLocationId,
    activeDockBooking,
    updatePointerAt,
    appointmentServices,
    calendarBookingChoices,
    quickCreateAvailabilityError,
    isValidAppointmentSlot,
    confirmPastAdminLesson,
    activeAccountId,
    setItems,
    carveBusyBlocksForAppointment,
    selectedGroupSession,
    selectedCalendarCoachId,
    currentAppUser,
    isValidBlockSlot,
    closeCalendarDetails,
    reconcileUndoByDelete,
  } = app;
  const {
    quickCreate,
    floatingDrag,
    draft,
    quickClientSearch,
    pointerSessionRef,
    setQuickCreate,
    gridRef,
    weekStripRef,
    weekPanelsRef,
    weekPagerSyncingRef,
    weekSettleTimerRef,
    weekPagerStep,
    weekLandingTimerRef,
    cancelTouchHold,
    touchHoldCleanupRef,
    setHoldingItemId,
    touchHoldTimerRef,
    pointerStartRef,
    pointerClientRef,
    pointerKindRef,
    dragPreviewMetaRef,
    setFloatingDrag,
    setPointerSessionState,
    pendingQuickCreateRef,
    clickPlaceRef,
    setQuickClientSearch,
    setQuickMatchField,
    quickMatchField,
  } = app.calendarInteraction;
  const {
    activeWeek,
    calendarDayFocus,
    calendarTodayIndex,
    calendarNowMinutes,
    setCalendarHover,
    activeWeekRef,
    setCalendarDayFocus,
    setCalendarAxisMode,
    weekDays,
    setCalendarDetailMode,
  } = app.calendarState;

  const lastCalendarTapRef = useRef(0);
  const suppressBlankGestureUntilRef = useRef(0);
  const locationCalendarHasAppointments = visibleWeekItems.some((item) => item.kind === "appointment");
  const locationCalendarCoachItemCount = (coachId?: string) => {
    if (!coachId) return 0;
    return visibleWeekItems.filter((item) => {
      if (item.kind !== "appointment") return false;
      return calendarItemCoachColumnId(item, itemService(item, services), coachProfiles) === coachId;
    }).length;
  };
  // Where a window on the calendar is. Hours saved before locations existed
  // carry no locationId; they still belong to the one place the coach is
  // rostered, so read it off the coach. A coach at several places with an
  // unpinned window really is open at any of them, so that stays unresolved.
  const availabilityWindowLocationId = (window: AvailabilityWindow) => {
    if (window.locationId) return window.locationId;
    const coach = accountCoachProfiles.find((entry) => entry.id === (window.coachId || activeCoachId));
    const assigned = (coach?.assignedLocationIds ?? []).filter((id) =>
      availabilityLocations.some((location) => location.id === id),
    );
    return assigned.length === 1 ? assigned[0] : "";
  };
  const calendarHourMarks = useMemo(() => {
    const marks: number[] = [];
    for (let minutes = calendarStartMinutes; minutes <= calendarEndMinutes; minutes += 60) {
      marks.push(minutes);
    }
    return marks;
  }, [calendarStartMinutes, calendarEndMinutes]);
  // Resolve the quick-create service from all account services, not just the
  // appointment-style pick list: "Add person" on a scheduled group session sets
  // serviceId to the group service, which the pick list deliberately excludes.
  // Resolving against the pick list made the popover fall back to the "choose a
  // service" list of normal lessons instead of the group booking form.
  const quickCreateService = quickCreate?.serviceId
    ? activeServices.find((service) => service.id === quickCreate.serviceId) ?? null
    : null;

  const displayItems = useMemo(() => {
    const floatingItemId = floatingDrag?.itemId ?? "";
    const baseWeekItems = floatingItemId ? visibleWeekItems.filter((item) => item.id !== floatingItemId) : visibleWeekItems;
    if (!draft || draft.mode === "block" || draft.mode === "place") {
      return [...baseWeekItems, ...scheduledGroupSlots];
    }
    const withoutMoving = baseWeekItems.filter((item) => item.id !== draft.itemId);
    const movingItem = items.find((item) => item.id === draft.itemId);
    if (!movingItem || draft.week !== activeWeek) return [...withoutMoving, ...scheduledGroupSlots];
    return [
      ...withoutMoving,
      ...scheduledGroupSlots,
      { ...movingItem, week: draft.week, day: draft.day, start: draft.start, duration: draft.duration },
    ];
  }, [activeWeek, draft, floatingDrag, items, visibleWeekItems, scheduledGroupSlots]);
  const calendarDayColumns = useMemo(
    () => buildDayColumns(calendarCollapsedDays, calendarDayFocus),
    [calendarCollapsedDays, calendarDayFocus],
  );

  // Hour labels are dropped when they land inside a collapsed gap — the hour
  // never visibly happens there — and thinned when squashing has pushed two of
  // them within 15px of each other.
  const visibleCalendarHourMarks = useMemo(() => {
    if (!calendarAxis.squashed) return calendarHourMarks.map((hour, index) => ({ hour, top: index * HOUR_HEIGHT }));
    const marks: { hour: number; top: number }[] = [];
    let lastTop = Number.NEGATIVE_INFINITY;
    calendarHourMarks.forEach((hour) => {
      const segment = calendarAxis.segments.find((entry) => hour >= entry.start && hour < entry.end);
      if (segment?.quiet) return;
      const top = axisMinuteToTop(calendarAxis, hour);
      if (top - lastTop < 15) return;
      lastTop = top;
      marks.push({ hour, top });
    });
    return marks;
  }, [calendarAxis, calendarHourMarks]);

  const calendarQuietGaps = useMemo(
    () => (calendarAxis.squashed ? calendarAxis.segments.filter((segment) => segment.quiet) : []),
    [calendarAxis],
  );
  const calendarNowTop =
    calendarTodayIndex >= 0 && calendarNowMinutes >= calendarStartMinutes && calendarNowMinutes <= calendarEndMinutes
      ? calendarMinutesToTop(calendarNowMinutes)
      : null;

  const quickClientInput = {
    name: quickClientSearch,
    email: quickCreate?.email ?? "",
    phone: quickCreate?.phone ?? "",
  };
  const quickClientHasInput = hasClientMatchInput(quickClientInput);
  const quickClientSuggestion = useMemo(() => {
    if (!quickClientHasInput) return null;
    return findClientMatch(clients, quickClientInput);
  }, [quickClientHasInput, clients, quickClientSearch, quickCreate?.email, quickCreate?.phone]);
  const quickClientSuggestionApplied = Boolean(
    quickClientSuggestion &&
      normalizeMatchText(quickClientSearch) === normalizeMatchText(quickClientSuggestion.name) &&
      (!quickClientSuggestion.phone || phoneValuesMatch(quickClientSuggestion.phone, quickCreate?.phone ?? "", true)) &&
      (!quickClientSuggestion.email ||
        normalizeMatchText(quickClientSuggestion.email) === normalizeMatchText(quickCreate?.email ?? "")),
  );
  const showQuickClientSuggestion = Boolean(
    quickClientSuggestion && quickClientHasInput && !quickClientSuggestionApplied,
  );

  function showCalendarItemHover(
    event: ReactPointerEvent<HTMLElement>,
    item: CalendarItem,
    service: Service | undefined | null,
    latestClientEmail?: NotificationRecord,
    latestCoachEmail?: NotificationRecord,
    latestAdminEmail?: NotificationRecord,
  ) {
    if (pointerSessionRef.current) return;
    if (event.pointerType === "touch") return;
    const groupSessionContext = getGroupSessionContext(item);
    if (!groupSessionContext && item.kind !== "appointment" && item.kind !== "block") return;
    const rect = event.currentTarget.getBoundingClientRect();
    const cardWidth = 304;
    const gap = 14;
    const rightX = rect.right + gap;
    const leftX = rect.left - cardWidth - gap;
    const x = rightX + cardWidth < window.innerWidth - 16 ? rightX : Math.max(16, leftX);
    const y = clamp(rect.top - 12, 16, Math.max(16, window.innerHeight - 260));
    setCalendarHover({
      itemId: item.id,
      x,
      y,
      kind: groupSessionContext ? "group-session" : item.kind === "appointment" ? "appointment" : "blocked",
      client: groupSessionContext ? groupSessionContext.service.name : item.client || item.title,
      service: groupSessionContext
        ? t("Group Session · {booked}/{capacity} booked", { booked: groupSessionContext.bookedCount, capacity: groupSessionContext.capacity })
        : service?.name ?? t("Golf lesson"),
      time: `${dateForSlot(itemWeek(item), item.day).toLocaleDateString(activeLocale(), { weekday: "long", month: "short", day: "numeric" })}, ${formatRange(item.start, item.duration)}`,
      venue: bookingLocationShortDisplay(calendarItemLocation(item, service ?? undefined, locations, coachAccount)) || coachAccount.venueShortName || coachAccount.venueName,
      phone: groupSessionContext ? "" : item.phone || "",
      email: groupSessionContext ? "" : item.email || "",
      clientEmailStatus: latestClientEmail ? notificationStatusLabel(latestClientEmail) : t("No client email receipt yet"),
      coachEmailStatus: latestCoachEmail ? notificationStatusLabel(latestCoachEmail) : t("No coach receipt yet"),
      adminEmailStatus: latestAdminEmail ? notificationStatusLabel(latestAdminEmail) : t("No admin receipt yet"),
    });
  }

  function hideCalendarItemHover(itemId?: string) {
    setCalendarHover((current) => (!itemId || current?.itemId === itemId ? null : current));
  }

  function openGroupSessionFromSlot(item: CalendarItem): boolean {
    const failWith = (reason: string) => {
      setToast({ message: t("Unable to open group session: {reason}", { reason }) });
      return false;
    };

    const serviceId = item.serviceId;
    if (!serviceId) return failWith(t("missing serviceId"));

    const service = services.find((candidate) => candidate.id === serviceId);
    if (!service) return failWith("service not found");
    if (!isScheduledGroupService(service)) return failWith("service is not scheduled group");

    const week = itemWeek(item);
    const slotWeek = Number.isInteger(week) ? week : NaN;
    const slotData = {
      day: item.day,
      start: item.start,
      duration: item.duration,
    };

    if (item.syntheticGroupSlot || item.groupSlot) {
      if (!service || !Number.isInteger(slotWeek) || !Number.isInteger(slotData.day) || !Number.isFinite(slotData.start) || !Number.isFinite(slotData.duration)) {
        return failWith("slot does not match schedule");
      }
    } else {
      if (!service.groupSchedule || !service.groupSchedule.active) return failWith(t("missing groupSchedule"));
      if (!isGroupServiceSlotMatch(service, slotWeek, slotData.day, slotData.start)) return failWith("slot does not match schedule");
    }

    const candidateSession: GroupSession = {
      serviceId,
      week: slotWeek,
      day: slotData.day,
      start: slotData.start,
      duration: slotData.duration || service.duration,
    };
    const sessionService = services.find((candidate) => candidate.id === candidateSession.serviceId);
    if (!sessionService) return failWith(t("selectedGroupSessionDetails failed to resolve"));

    setSelectedGroupSession(candidateSession);
    setSelectedId("");
    setQuickCreate(null);
    return true;
  }

  function openGroupSessionForItem(item: CalendarItem) {
    return openGroupSessionFromSlot(item);
  }

  function isScheduledGroupSessionSlot(item: CalendarItem) {
    if (item.syntheticGroupSlot || item.groupSlot) return true;
    const service = itemService(item, services);
    return (
      item.readOnly &&
      item.kind === "block" &&
      isScheduledGroupService(service) &&
      isGroupServiceSlotMatch(service, itemWeek(item), item.day, item.start)
    );
  }

  function isGroupSessionAppointment(item: CalendarItem) {
    const service = itemService(item, services);
    return (
      item.kind === "appointment" &&
      isScheduledGroupService(service) &&
      isGroupServiceSlotMatch(service, itemWeek(item), item.day, item.start)
    );
  }

  function isGroupSessionItem(item: CalendarItem) {
    return isScheduledGroupSessionSlot(item) || isGroupSessionAppointment(item);
  }

  function getGroupSessionContext(item: CalendarItem) {
    if (!isGroupSessionItem(item)) return null;
    const service = itemService(item, services);
    if (!service || !isScheduledGroupService(service)) return null;
    const week = itemWeek(item);
    if (!Number.isInteger(week) || !Number.isInteger(item.day) || !Number.isFinite(item.start)) return null;
    const duration = Number.isFinite(item.duration) && item.duration > 0 ? item.duration : service.duration;
    if (!isScheduledGroupSessionSlot(item) && !isGroupServiceSlotMatch(service, week, item.day, item.start)) return null;
    const session: GroupSession = {
      serviceId: service.id,
      week,
      day: item.day,
      start: item.start,
      duration,
    };
    const candidate = {
      week: session.week,
      day: session.day,
      start: session.start,
      duration: session.duration,
    };
    const attendees = items
      .filter(
        (candidateItem) =>
          candidateItem.kind === "appointment" &&
          candidateItem.serviceId === service.id &&
          overlaps(itemSlot(candidateItem), candidate),
      )
      .sort((a, b) => (a.client ?? "").localeCompare(b.client ?? ""));
    const bookedCount = attendees.filter((appointment) => isActiveGroupBooking(appointment.status)).length;
    return {
      service,
      session,
      attendees,
      capacity: service.capacity,
      bookedCount,
    };
  }

  function handleCalendarItemClick(
    event: ReactMouseEvent<HTMLElement> | ReactPointerEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>,
    item: CalendarItem,
  ) {
    if (!isGroupSessionItem(item)) return false;
    event.preventDefault();
    event.stopPropagation();
    hideCalendarItemHover();
    return openGroupSessionForItem(item);
  }

  function coachIdFromLocationCalendarSlot(slot: { day: number; x: number }) {
    if (effectiveCalendarPerspective !== "location" || !locationCalendarCoachGroups.length) return undefined;
    const grid = gridRef.current;
    if (!grid) return undefined;
    const rect = grid.getBoundingClientRect();
    const column = dayColumnPixels(calendarCollapsedDays, rect.width, calendarDayFocus)[slot.day];
    const dayWidth = Math.max(1, column?.width ?? rect.width / DAY_COUNT);
    const xWithinDay = clamp(slot.x - (column?.left ?? slot.day * dayWidth), 0, Math.max(0, dayWidth - 1));
    const coachIndex = clamp(
      Math.floor((xWithinDay / dayWidth) * locationCalendarCoachGroups.length),
      0,
      locationCalendarCoachGroups.length - 1,
    );
    return locationCalendarCoachGroups[coachIndex]?.coachId;
  }

  function slotFromPointer(event: ReactPointerEvent<HTMLElement>) {
    return slotFromClient(event.clientX, event.clientY);
  }

  function handleWeekStripScroll() {
    const strip = weekStripRef.current;
    if (!strip) return;
    const panels = weekPanelsRef.current;
    if (panels) panels.scrollLeft = strip.scrollLeft;
    if (weekPagerSyncingRef.current) return;
    if (weekSettleTimerRef.current) window.clearTimeout(weekSettleTimerRef.current);
    weekSettleTimerRef.current = window.setTimeout(() => {
      weekSettleTimerRef.current = null;
      const index = clamp(Math.round(strip.scrollLeft / weekPagerStep()), 0, WEEK_PANEL_COUNT - 1);
      if (index === WEEK_FOCUS_INDEX) return;
      setActiveWeekState(activeWeekRef.current + (index - WEEK_FOCUS_INDEX));
    }, 140);
  }

  /**
   * Drag-to-page for pointers that cannot scroll sideways on their own. Touch
   * and trackpads scroll the strip natively; a mouse would be left with only
   * the toolbar arrows, and the strip says "grab" either way.
   */
  function beginWeekStripDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const strip = weekStripRef.current;
    if (!strip || event.pointerType === "touch") return;
    const startX = event.clientX;
    const startLeft = strip.scrollLeft;
    let dragged = false;

    const onMove = (move: globalThis.PointerEvent) => {
      const dx = move.clientX - startX;
      if (Math.abs(dx) > 3) dragged = true;
      strip.scrollLeft = startLeft - dx;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!dragged) {
        strip.classList.remove("is-grabbing");
        return;
      }
      // A decisive push pages; anything less falls back. Landing on whichever
      // panel happens to be nearest would mean dragging half the calendar's
      // width before the week changed, which is not what a swipe feels like.
      const step = weekPagerStep();
      const travelled = strip.scrollLeft - startLeft;
      const delta = Math.abs(travelled) > Math.max(40, step * 0.15) ? Math.sign(travelled) : 0;
      const left = step * clamp(WEEK_FOCUS_INDEX + delta, 0, WEEK_PANEL_COUNT - 1);
      // is-grabbing stays on until the strip has landed: it is what suspends
      // snapping, and re-enabling mandatory snap mid-flight cancels the scroll
      // and drops the strip back on whichever panel was nearest at the time.
      strip.scrollTo({ left, behavior: "smooth" });
      if (weekLandingTimerRef.current) window.clearTimeout(weekLandingTimerRef.current);
      weekLandingTimerRef.current = window.setTimeout(() => {
        weekLandingTimerRef.current = null;
        strip.scrollLeft = left;
        strip.classList.remove("is-grabbing");
      }, 320);
      // The scroll handler picks the landing up from here and commits the week.
    };

    strip.classList.add("is-grabbing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  /** Tap a day to fill the grid with it; tap the same day again for the week. */
  // A day heading always opens its day. Getting back to the week is the
  // Week/Day switch's job, so a second tap on the open day does nothing.
  function focusCalendarDay(dayIndex: number) {
    setCalendarDayFocus(dayIndex);
  }

  function cycleCalendarAxisMode() {
    suppressBlankGestureUntilRef.current = Date.now() + 360;
    setCalendarAxisMode((current) => (current === "week" ? "squash" : "week"));
  }

  /**
   * The 26px of the neighbouring week that stays visible past the edge. It
   * shows the shape of that week's availability and nothing else: at 26px a
   * booking card is unreadable, and keeping the panels inert means one live
   * week's worth of drag, drop and quick-create logic rather than three.
   */
  function renderWeekPeekPanel(offset: number) {
    return (
      <div className="week-pager-panel is-off-week" key={offset} aria-hidden="true">
        <div className="week-grid is-peek" style={{ height: gridHeight }}>
          {weekDays.map((day, dayIndex) => (
            <div
              className={`day-lane ${calendarCollapsedDays[dayIndex] ? "is-unavailable" : ""}`}
              key={day.label}
              hidden={calendarDayColumns[dayIndex].hidden}
              style={{ left: calendarDayColumns[dayIndex].left, width: calendarDayColumns[dayIndex].width }}
            >
              {calendarAvailability[dayIndex].map((window, index) => {
                const visibleWindow = clipCalendarSegment(window.start, window.end - window.start);
                if (!visibleWindow) return null;
                const bandTop = calendarMinutesToTop(visibleWindow.start);
                return (
                  <div
                    className="available-band"
                    key={`${day.label}-${index}`}
                    style={
                      {
                        top: bandTop,
                        height: calendarSegmentHeight(visibleWindow.start, visibleWindow.duration),
                        ["--band-offset" as string]: `${bandTop}px`,
                      } as CSSProperties
                    }
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    );
  }

  function toggleCalendarDetailMode() {
    suppressBlankGestureUntilRef.current = Date.now() + 360;
    setCalendarDetailMode((current) => !current);
  }

  function enableCalendarDetailMode() {
    suppressBlankGestureUntilRef.current = Date.now() + 360;
    setCalendarDetailMode(true);
  }

  function handleCalendarTouchStart(event: ReactTouchEvent<HTMLElement>) {
    const now = Date.now();
    if (event.touches.length > 1) {
      enableCalendarDetailMode();
      return;
    }
    if (now - lastCalendarTapRef.current < 320) {
      event.preventDefault();
      toggleCalendarDetailMode();
      lastCalendarTapRef.current = 0;
      return;
    }
    lastCalendarTapRef.current = now;
  }

  function renderAvailableBand(window: AvailabilityWindow, key: string) {
    const visibleWindow = clipCalendarSegment(window.start, window.end - window.start);
    if (!visibleWindow) return null;
    const bandTop = calendarMinutesToTop(visibleWindow.start);
    // The location view is one location already; everywhere else the band says
    // where the coach is working.
    const showLocation = hasMultipleAvailabilityLocations && effectiveCalendarPerspective !== "location";
    const locationId = showLocation ? availabilityWindowLocationId(window) : "";
    const hue = locationId ? availabilityLocationHue(locationId) : null;
    return (
      <div
        className={`available-band ${hue !== null ? "has-location" : ""}`}
        key={key}
        style={{
          top: bandTop,
          height: calendarSegmentHeight(visibleWindow.start, visibleWindow.duration),
          // The band draws its own hour ticks, and a window rarely opens on the
          // hour. Hand it its distance from the top of the grid so the ticks
          // count from the time gutter rather than from the band edge.
          ["--band-offset" as string]: `${bandTop}px`,
          ...(hue !== null ? { ["--location-hue" as string]: String(hue) } : {}),
        } as CSSProperties}
      >
        {showLocation ? <span className="available-band-location">{availabilityLocationLabel(locationId)}</span> : null}
      </div>
    );
  }

  // Android and desktop Chrome buzz; iOS Safari has no web haptic, which is why
  // the lift also has to read visually rather than relying on this.
  function pulseHoldFeedback() {
    try {
      navigator.vibrate?.(12);
    } catch {
      // A blocked or unsupported vibrate must never take the drag down with it.
    }
  }

  function waitForTouchHold(event: ReactPointerEvent<HTMLElement>, itemId: string, arm: () => void) {
    cancelTouchHold();
    const startX = event.clientX;
    const startY = event.clientY;

    const abandon = (moveEvent: globalThis.PointerEvent) => {
      if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < TOUCH_HOLD_TOLERANCE) return;
      cancelTouchHold();
    };
    const release = () => cancelTouchHold();

    window.addEventListener("pointermove", abandon);
    window.addEventListener("pointerup", release);
    // The browser fires pointercancel the moment it decides the touch is a
    // scroll, which is the cleanest signal that this was never a drag.
    window.addEventListener("pointercancel", release);
    window.addEventListener("scroll", release, true);

    touchHoldCleanupRef.current = () => {
      window.removeEventListener("pointermove", abandon);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("scroll", release, true);
    };

    setHoldingItemId(itemId);
    touchHoldTimerRef.current = window.setTimeout(() => {
      touchHoldTimerRef.current = null;
      touchHoldCleanupRef.current?.();
      touchHoldCleanupRef.current = null;
      setHoldingItemId(null);
      pulseHoldFeedback();
      arm();
    }, TOUCH_HOLD_MS);
  }

  function startMoveSession(
    target: HTMLElement,
    pointerId: number,
    pointerType: string,
    clientX: number,
    clientY: number,
    item: CalendarItem,
  ) {
    const slot = slotFromClient(clientX, clientY);
    if (!slot) return;
    const rect = target.getBoundingClientRect();
    pointerStartRef.current = { x: clientX, y: clientY };
    pointerClientRef.current = { x: clientX, y: clientY };
    resetPointerTrail(clientX, clientY);
    pointerKindRef.current = pointerType || "mouse";
    dragPreviewMetaRef.current = {
      width: rect.width,
      height: rect.height,
      offsetX: clientX - rect.left,
      offsetY: clientY - rect.top,
    };
    setFloatingDrag(null);
    setMovedState(false);
    setQuickCreate(null);
    setPointerSessionState({
      mode: "move",
      itemId: item.id,
      offsetMinutes: slot.start - item.start,
      origin: item,
    });
    if (target.isConnected) target.setPointerCapture(pointerId);
    attachGestureListeners({ blockTouchScroll: pointerType === "touch" });
  }

  function startResizeSession(
    target: HTMLElement,
    pointerId: number,
    pointerType: string,
    clientX: number,
    clientY: number,
    item: CalendarItem,
  ) {
    pointerStartRef.current = { x: clientX, y: clientY };
    pointerClientRef.current = { x: clientX, y: clientY };
    resetPointerTrail(clientX, clientY);
    pointerKindRef.current = pointerType || "mouse";
    dragPreviewMetaRef.current = null;
    setFloatingDrag(null);
    setMovedState(false);
    setQuickCreate(null);
    setPointerSessionState({ mode: "resize", itemId: item.id, origin: item });
    if (target.isConnected) target.setPointerCapture(pointerId);
    attachGestureListeners({ blockTouchScroll: pointerType === "touch" });
  }

  function beginMove(event: ReactPointerEvent<HTMLElement>, item: CalendarItem) {
    if (!requireLiveDatabase("move appointments")) return;
    if (isExternallyOwned(item)) {
      setToast({ message: externalRescheduleMessage(item) });
      return;
    }
    const target = event.currentTarget;
    const { pointerId, pointerType, clientX, clientY } = event;
    if (pointerType === "touch") {
      // stopPropagation, but no preventDefault: the grid must not read this as
      // a blank-space gesture, while the browser keeps the touch until the hold
      // completes so the week still scrolls under the finger.
      event.stopPropagation();
      waitForTouchHold(event, item.id, () =>
        startMoveSession(target, pointerId, pointerType, clientX, clientY, item),
      );
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    startMoveSession(target, pointerId, pointerType, clientX, clientY, item);
  }

  function beginResize(event: ReactPointerEvent<HTMLElement>, item: CalendarItem) {
    if (!requireLiveDatabase("resize appointments")) return;
    // Resizing moves the end time, which the external system owns just as much
    // as the start. Gating the drag but not this would leave the same drift
    // reachable by a different handle.
    if (isExternallyOwned(item)) {
      setToast({ message: externalRescheduleMessage(item) });
      return;
    }
    const target = event.currentTarget;
    const { pointerId, pointerType, clientX, clientY } = event;
    if (pointerType === "touch") {
      // The handle is a 9px strip along the bottom edge — the easiest thing on
      // the calendar to catch by accident, so it waits out the same hold. The
      // stop matters here: without it the card behind would start its own hold
      // and a resize would turn into a move.
      event.stopPropagation();
      waitForTouchHold(event, item.id, () =>
        startResizeSession(target, pointerId, pointerType, clientX, clientY, item),
      );
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    startResizeSession(target, pointerId, pointerType, clientX, clientY, item);
  }

  function beginBlankGesture(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    if (Date.now() < suppressBlankGestureUntilRef.current) return;
    if ((event.target as HTMLElement).closest("[data-calendar-item]")) return;
    const slot = slotFromPointer(event);
    if (!slot) return;
    pointerStartRef.current = { x: event.clientX, y: event.clientY };
    pointerClientRef.current = { x: event.clientX, y: event.clientY };
    resetPointerTrail(event.clientX, event.clientY);
    pointerKindRef.current = event.pointerType || "mouse";
    dragPreviewMetaRef.current = null;
    setFloatingDrag(null);
    pendingQuickCreateRef.current = {
      week: activeWeek,
      day: slot.day,
      start: slot.start,
      x: event.clientX,
      y: event.clientY,
      coachId: coachIdFromLocationCalendarSlot(slot),
      locationId: effectiveCalendarPerspective === "location" ? selectedCalendarLocationId : undefined,
      serviceId: "",
      phone: "",
      email: "",
      note: "",
      attendees: [],
      attendeeName: "",
      attendeeEmail: "",
      error: "",
    };
    clickPlaceRef.current = activeDockBooking
      ? {
          bookingId: activeDockBooking.id,
          candidate: {
            week: activeWeekRef.current,
            day: slot.day,
            start: slot.start,
            duration: activeDockBooking.duration,
          },
        }
      : null;
    setMovedState(false);
    setPointerSessionState(event.pointerType === "touch" ? null : { mode: "block", day: slot.day, start: slot.start });
    event.currentTarget.setPointerCapture(event.pointerId);
    attachGestureListeners();
  }

  function updatePointer(event: ReactPointerEvent<HTMLElement>) {
    updatePointerAt(event.clientX, event.clientY);
  }

  function applyQuickClient(client: ClientSummary) {
    setQuickClientSearch(client.name);
    setQuickCreate((current) =>
      current
        ? {
            ...current,
            phone: client.phone || current.phone,
            email: client.email || current.email,
            error: "",
          }
        : current,
    );
    setQuickMatchField("");
  }

  function quickClientMatchButton(field: "name" | "phone" | "email") {
    if (!quickClientSuggestion || !showQuickClientSuggestion || quickMatchField !== field) return null;
    return (
      <button
        className="client-match-prompt quick-field-match"
        onMouseDown={(event) => event.preventDefault()}
        onTouchStart={(event) => event.preventDefault()}
        onClick={() => applyQuickClient(quickClientSuggestion)}
        type="button"
      >
        <ClarityProfile size={15} />
        <span>
          <strong>{quickClientSuggestion.name}</strong>
          <em>{[quickClientSuggestion.phone, quickClientSuggestion.email].filter(Boolean).join(" · ")}</em>
        </span>
      </button>
    );
  }

  function updateQuickCreateField(field: "phone" | "email" | "note", value: string) {
    setQuickCreate((current) => (current ? { ...current, [field]: value, error: "" } : current));
  }

  function updateQuickCreateAttendeeDraft(field: "attendeeName" | "attendeeEmail", value: string) {
    setQuickCreate((current) => (current ? { ...current, [field]: value, error: "" } : current));
  }

  function addQuickCreateCustomGroupAttendee() {
    if (!quickCreate || !quickCreateService || !isCustomGroupService(quickCreateService)) return;
    if (quickCreate.attendeeEmail.trim() && !quickCreate.attendeeEmail.includes("@")) {
      setQuickCreate((current) => (current ? { ...current, error: "Enter a valid attendee email or leave it blank." } : current));
      return;
    }
    const attendee = adminCustomGroupAttendee(quickCreate.attendeeName, quickCreate.attendeeEmail);
    if (!attendee) {
      setQuickCreate((current) => (current ? { ...current, error: "Add an attendee name first." } : current));
      return;
    }
    const nextCount = 1 + quickCreate.attendees.length + 1;
    if (nextCount > customGroupMaxParticipants(quickCreateService)) {
      setQuickCreate((current) => (current ? { ...current, error: "This custom group is already at maximum size." } : current));
      return;
    }
    setQuickCreate((current) =>
      current
        ? {
            ...current,
            attendees: [...current.attendees, attendee],
            attendeeName: "",
            attendeeEmail: "",
            error: "",
          }
        : current,
    );
  }

  function removeQuickCreateCustomGroupAttendee(attendeeId: string) {
    setQuickCreate((current) =>
      current
        ? {
            ...current,
            attendees: current.attendees.filter((attendee) => attendee.id !== attendeeId),
            error: "",
          }
        : current,
    );
  }

  function selectQuickService(serviceId: string) {
    if (!quickCreate) return;
    const service = appointmentServices.find((candidate) => candidate.id === serviceId);
    if (!service) return;
    const candidate = {
      week: quickCreate.week,
      day: quickCreate.day,
      start: quickCreate.start,
      duration: service.duration,
    };
    const { fixedCoachId, fixedLocationId } = calendarBookingChoices(service);
    const choice = { coachId: fixedCoachId, locationId: fixedLocationId };
    setQuickCreate((current) =>
      current
        ? {
            ...current,
            serviceId,
            ...choice,
            attendees: [],
            attendeeName: "",
            attendeeEmail: "",
            error: quickCreateAvailabilityError(candidate, service, choice),
          }
        : current,
    );
    setQuickMatchField("name");
  }

  function chooseQuickCreateScope(field: "coachId" | "locationId", value: string) {
    setQuickCreate((current) => {
      if (!current || !quickCreateService) return current;
      const next = { ...current, [field]: value };
      const candidate = { week: next.week, day: next.day, start: next.start, duration: quickCreateService.duration };
      return {
        ...next,
        error: quickCreateAvailabilityError(candidate, quickCreateService, {
          coachId: next.coachId,
          locationId: next.locationId,
        }),
      };
    });
  }

  function backToQuickServiceChoice() {
    setQuickCreate((current) => {
      if (!current) return current;
      // "Add person" on a scheduled group session pins the service; going back
      // to the normal lesson pick list makes no sense there, so just close.
      const service = activeServices.find((candidate) => candidate.id === current.serviceId);
      if (isScheduledGroupService(service)) return null;
      return { ...current, serviceId: "", coachId: undefined, locationId: undefined, phone: "", email: "", note: "", error: "" };
    });
  }

  /** Books the quick-create time, and hands back the booking it made (null if it did not). */
  function confirmQuickAppointment(): CalendarItem | null {
    if (!quickCreate || !quickCreateService) return null;
    if (!requireLiveDatabase("create appointments")) return null;
    const typedClientName = quickClientSearch.trim();
    const clientName = typedClientName;
    if (!clientName) {
      setQuickCreate((current) => (current ? { ...current, error: "Add a client name." } : current));
      return null;
    }
    const quickCreateIsCustomGroup = isCustomGroupService(quickCreateService);
    if (quickCreateIsCustomGroup && quickCreate.attendees.length < customGroupMinParticipants(quickCreateService) - 1) {
      setQuickCreate((current) => (current ? { ...current, error: "Add at least one other person." } : current));
      return null;
    }
    const coachId = quickCreate.coachId || "";
    const locationId = quickCreate.locationId || "";
    if (!coachId || !locationId) {
      setQuickCreate((current) =>
        current ? { ...current, error: coachId ? "Choose a location." : "Choose a coach." } : current,
      );
      return null;
    }
    const candidate = {
      week: quickCreate.week,
      day: quickCreate.day,
      start: quickCreate.start,
      duration: quickCreateService.duration,
    };
    const choice = { candidateCoachId: coachId, candidateLocationId: locationId };
    if (!isValidAppointmentSlot(candidate, undefined, quickCreateService, choice)) {
      setQuickCreate((current) =>
        current
          ? { ...current, error: quickCreateAvailabilityError(candidate, quickCreateService, { coachId, locationId }) }
          : current,
      );
      return null;
    }
    if (!confirmPastAdminLesson(candidate)) return null;
    const chosenLocation = locationById(locations, locationId);
    const location = chosenLocation
      ? locationSnapshot(chosenLocation)
      : bookingLocationSnapshotFor(quickCreateService, locations, coachAccount);
    const item: CalendarItem = {
      id: newCalendarItemId("appt"),
      kind: "appointment",
      accountId: activeAccountId,
      title: clientName,
      client: clientName,
      serviceId: quickCreateService.id,
      coachId,
      locationId: location.locationId,
      coach: bookingCoachSnapshotFor(coachId, coachProfiles),
      ...candidate,
      phone: quickCreate.phone.trim(),
      email: quickCreate.email.trim(),
      note: quickCreate.note.trim(),
      location,
      ...(quickCreateIsCustomGroup
        ? {
            customGroup: true as const,
            attendees: [
              customGroupBookerAttendee(clientName, quickCreate.email),
              ...quickCreate.attendees,
            ],
            calculatedPrice: calculateCustomGroupPrice(quickCreateService, 1 + quickCreate.attendees.length),
          }
        : {}),
    };
    setItems(carveBusyBlocksForAppointment([...items, item], itemSlot(item)));
    if (
      !selectedGroupSession ||
      selectedGroupSession.serviceId !== quickCreateService.id ||
      selectedGroupSession.week !== quickCreate.week ||
      selectedGroupSession.day !== quickCreate.day ||
      selectedGroupSession.start !== quickCreate.start
    ) {
      setSelectedId("");
    }
    setQuickCreate(null);
    setQuickClientSearch("");
    return item;
  }

  function createBlockFromQuick(scope: "coach-location" | "location" = "coach-location") {
    if (!quickCreate) return;
    if (!requireLiveDatabase("create blocks")) return;
    const locationOnly = effectiveCalendarPerspective === "location" && scope === "location";
    const blockCoachId =
      locationOnly
        ? undefined
        : quickCreate.coachId || selectedCalendarCoachId || currentAppUser.coachId || firstCoachId(coachProfiles);
    const blockLocationId = quickCreate.locationId || selectedCalendarLocationId || defaultLocationId(locations);
    const candidate = { week: quickCreate.week, day: quickCreate.day, start: quickCreate.start, duration: 30 };
    if (!isValidBlockSlot(candidate, undefined, { coachId: blockCoachId, locationId: blockLocationId, locationOnly })) {
      setToast({ message: t("That block would overlap with another calendar item.") });
      return;
    }
    const previous = items;
    const item: CalendarItem = {
      id: newCalendarItemId("block"),
      kind: "block",
      accountId: activeAccountId,
      title: locationOnly ? t("Location unavailable") : t("Coach unavailable"),
      coachId: blockCoachId,
      locationId: blockLocationId,
      coach: blockCoachId ? bookingCoachSnapshotFor(blockCoachId, coachProfiles) : undefined,
      location: cleanBookingLocationSnapshot(locationSnapshot(locationById(locations, blockLocationId) ?? defaultLocationFromCoachAccount(coachAccount))),
      ...candidate,
      note: locationOnly ? "Location-wide quick block" : "Coach-location quick block",
    };
    setItems([...items, item]);
    closeCalendarDetails();
    setQuickCreate(null);
    setToast({
      message: t("Blocked {short}, {start}.", { short: weekDays[item.day].short, start: formatRange(item.start, item.duration) }),
      undo: () => {
        setItems(previous);
        void reconcileUndoByDelete(item.id, previous);
      },
    });
  }

  /**
   * Where the quick-create popover sits. `height` is the popover's measured
   * height, so a long list of lesson types is lifted to fit on screen rather
   * than running off the bottom.
   */
  function quickCreatePopoverStyle(height: number): CSSProperties {
    if (!quickCreate) return {};
    const zIndex = selectedGroupSession ? 120 : undefined;
    const viewport = window.visualViewport;
    const viewportWidth = viewport?.width ?? window.innerWidth;
    const viewportHeight = viewport?.height ?? window.innerHeight;
    const margin = 12;
    if (isPhoneLayout()) {
      // A phone gets a sheet along the bottom, above the tab bar, wherever the
      // tap was: the stylesheet places it (.app-shell.is-phone .quick-create).
      // With the keyboard up the bottom of the page is behind it, so the sheet
      // moves into the space left above the keyboard, close button and all.
      const keyboardUp = viewport && viewport.height < window.innerHeight - 120;
      if (!keyboardUp) return { zIndex };
      return { zIndex, top: viewport.offsetTop + 8, bottom: "auto", maxHeight: viewport.height - 16 };
    }
    const availableWidth = Math.max(280, viewportWidth - margin * 2);
    const availableHeight = Math.max(280, viewportHeight - margin * 2);
    const popoverWidth = Math.min(340, availableWidth);
    const usableHeight = Math.min(height, availableHeight);
    const left = clamp(quickCreate.x + 10, margin, Math.max(margin, viewportWidth - popoverWidth - margin));
    const top = clamp(quickCreate.y + 10, margin, Math.max(margin, viewportHeight - usableHeight - margin));

    return {
      left,
      top,
      width: popoverWidth,
      maxHeight: availableHeight,
      zIndex,
    };
  }

  const quickCreateIsCustomGroup = Boolean(quickCreate && quickCreateService && isCustomGroupService(quickCreateService));
  // The coach and place choices the quick-create form asks for, if any.
  const quickCreateChoices =
    quickCreate && quickCreateService && !isScheduledGroupService(quickCreateService)
      ? calendarBookingChoices(quickCreateService)
      : null;
  const quickCreateCandidate =
    quickCreate && quickCreateService
      ? { week: quickCreate.week, day: quickCreate.day, start: quickCreate.start, duration: quickCreateService.duration }
      : null;
  const quickCreateCustomGroupParticipantCount = quickCreateIsCustomGroup && quickCreate ? 1 + quickCreate.attendees.length : 1;
  const quickCreateCustomGroupPrice =
    quickCreateIsCustomGroup && quickCreateService
      ? calculateCustomGroupPrice(quickCreateService, quickCreateCustomGroupParticipantCount)
      : 0;

  return {
    ...app,
    ...app.calendarInteraction,
    ...app.calendarState,
    toggleCalendarDetailMode,
    handleCalendarTouchStart,
    locationCalendarHasAppointments,
    cycleCalendarAxisMode,
    handleWeekStripScroll,
    beginWeekStripDrag,
    focusCalendarDay,
    locationCalendarCoachItemCount,
    visibleCalendarHourMarks,
    renderWeekPeekPanel,
    beginBlankGesture,
    updatePointer,
    calendarQuietGaps,
    calendarDayColumns,
    renderAvailableBand,
    calendarNowTop,
    displayItems,
    isScheduledGroupSessionSlot,
    isGroupSessionItem,
    getGroupSessionContext,
    showCalendarItemHover,
    hideCalendarItemHover,
    beginMove,
    handleCalendarItemClick,
    openGroupSessionFromSlot,
    beginResize,
    quickCreatePopoverStyle,
    quickCreateService,
    selectQuickService,
    createBlockFromQuick,
    backToQuickServiceChoice,
    quickCreateChoices,
    chooseQuickCreateScope,
    quickCreateCandidate,
    confirmQuickAppointment,
    quickClientMatchButton,
    updateQuickCreateField,
    quickCreateIsCustomGroup,
    quickCreateCustomGroupParticipantCount,
    quickCreateCustomGroupPrice,
    removeQuickCreateCustomGroupAttendee,
    updateQuickCreateAttendeeDraft,
    addQuickCreateCustomGroupAttendee,
  };
}

export type CalendarController = ReturnType<typeof useCalendarController>;
