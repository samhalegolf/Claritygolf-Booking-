import { Plus, X } from "lucide-react";
import {
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type SetStateAction,
  useMemo,
  useState,
} from "react";
import { lookBusyStarts } from "../../../netlify/functions/_shared/look-busy.mts";
import { t } from "../../lib/i18n";
import { formatMoney } from "../../lib/money";
import {
  availabilityForCoach,
  type AvailabilityWindow,
  availabilityWindowCoversLocation,
  bookingCoachSnapshotFor,
  bookingLocationDisplay,
  bookingLocationSnapshotFor,
  BookingSlot,
  type BookingStatus,
  CalendarItem,
  CustomGroupAttendee,
  customGroupStatusLabel,
  formatTime,
  isInactiveForConflict,
  isLocationOnlyBlock,
  itemService,
  itemSlot,
  itemWeek,
  locationSnapshot,
  newCalendarItemId,
  overlaps,
  resolvedCalendarItemCoachId,
  resolvedCalendarItemLocationId,
  SlotCandidate,
  type WeekDay,
} from "../calendar/calendarModel";
import {
  bookingInputName,
  ClientSummary,
  findClientMatch,
  hasClientMatchInput,
  normalizeMatchText,
  phoneValuesMatch,
  splitClientName,
} from "../clients/clientMatching";
import { isBookingLogoHiddenByUrl } from "../public-booking/bookingScreens";
import {
  calculateCustomGroupPrice,
  customGroupMaxParticipants,
  customGroupMinParticipants,
  isCustomGroupService,
  isScheduledGroupService,
  Service,
  servicePriceLabel,
} from "../services/serviceModel";
import type { View } from "../shared/appView";
import type { Toast } from "../shared/toast";
import {
  type BrandSettings,
  type CoachAccount,
  type CoachProfile,
  type Location,
  locationById,
} from "../workspace/workspaceModel";
import { BookingForm, PublicBookingSection, useBookingCardScheme } from "./bookingModel";

export type BookingFlowInputs = {
  currentScreenPublicServices: Service[];
  bookingServiceId: string;
  bookingBrandWords: string[];
  bookingBrandName: string;
  brandSettings: BrandSettings;
  clients: ClientSummary[];
  serviceBookingOptions: (service: Service) => { coachId: string; locationId: string }[];
  activeWeek: number;
  isGroupServiceSlotMatch: (service: Service | null | undefined, week: number, day: number, start: number) => boolean;
  hasCollision: (candidate: SlotCandidate, ignoreId?: string, service?: Service, options?: { candidateCoachId?: string; candidateLocationId?: string }) => boolean;
  accountAvailability: AvailabilityWindow[][];
  fallbackCoachId: string;
  lookBusy: boolean;
  items: CalendarItem[];
  services: Service[];
  locations: Location[];
  coachAccount: CoachAccount;
  coachProfiles: CoachProfile[];
  accountCoachProfiles: CoachProfile[];
  accountLocations: Location[];
  bookingStart: number | null;
  bookingDaySelected: boolean;
  openPublicBookingSection: PublicBookingSection;
  weekDays: WeekDay[];
  isActiveGroupBooking: (status: BookingStatus | undefined) => boolean;
  setToast: Dispatch<SetStateAction<Toast | null>>;
  setOpenPublicBookingSection: Dispatch<SetStateAction<PublicBookingSection>>;
  setBookingServiceId: Dispatch<SetStateAction<string>>;
  setBookingDaySelected: Dispatch<SetStateAction<boolean>>;
  setBookingStart: Dispatch<SetStateAction<number | null>>;
  activeAccountId: string;
  setItems: Dispatch<SetStateAction<CalendarItem[]>>;
  carveBusyBlocksForAppointment: (nextItems: CalendarItem[], appointment: SlotCandidate) => CalendarItem[];
  closeCalendarDetails: () => void;
  setActiveView: Dispatch<SetStateAction<View>>;
  moveWeek: (delta: number) => void;
  weekTitle: string;
};

/**
 * Booking a lesson the way a customer does: choose the lesson type, then a
 * time, then the client's details, then confirm -- and the appointment lands
 * on the coach's calendar.
 *
 * Shown today as the live preview in Settings > Booking page. Its own state
 * and steps live here so a Book screen elsewhere (the phone app's) can drive
 * the same flow with its own layout.
 */
export function useBookingFlow(app: BookingFlowInputs) {
  const {
    currentScreenPublicServices,
    bookingServiceId,
    bookingBrandWords,
    bookingBrandName,
    brandSettings,
    clients,
    serviceBookingOptions,
    activeWeek,
    isGroupServiceSlotMatch,
    hasCollision,
    accountAvailability,
    fallbackCoachId,
    lookBusy,
    items,
    services,
    locations,
    coachAccount,
    coachProfiles,
    accountCoachProfiles,
    accountLocations,
    bookingStart,
    bookingDaySelected,
    openPublicBookingSection,
    weekDays,
    isActiveGroupBooking,
    setToast,
    setOpenPublicBookingSection,
    setBookingServiceId,
    setBookingDaySelected,
    setBookingStart,
    activeAccountId,
    setItems,
    carveBusyBlocksForAppointment,
    closeCalendarDetails,
    setActiveView,
  } = app;

  const bookingCardScheme = useBookingCardScheme();
  const [bookingDay, setBookingDay] = useState(0);
  // A player's details come from their session. The effect below fills them in.
  const [bookingForm, setBookingForm] = useState<BookingForm>({
    firstName: "",
    lastName: "",
    phone: "",
    email: "",
  });
  const [customGroupAttendees, setCustomGroupAttendees] = useState<CustomGroupAttendee[]>([]);
  const [customGroupAttendeeDraft, setCustomGroupAttendeeDraft] = useState({ name: "", email: "" });
  const [bookingSubmitError, setBookingSubmitError] = useState("");
  const selectedBookingService =
    currentScreenPublicServices.find((service) => service.id === bookingServiceId) ?? null;
  const visiblePublicServices = selectedBookingService ? [selectedBookingService] : currentScreenPublicServices;
  const isCustomGroupBooking = isCustomGroupService(selectedBookingService);
  const customGroupParticipantCount = isCustomGroupBooking ? 1 + customGroupAttendees.length : 1;
  const customGroupCalculatedPrice = isCustomGroupBooking
    ? calculateCustomGroupPrice(selectedBookingService, customGroupParticipantCount)
    : 0;
  const customGroupRemainingAttendees = isCustomGroupBooking
    ? Math.max(0, customGroupMaxParticipants(selectedBookingService) - customGroupParticipantCount)
    : 0;
  const bookingBrandPrimary = bookingBrandWords.slice(0, -1).join(" ") || bookingBrandName;
  const bookingBrandSecondary = bookingBrandWords.length > 1 ? bookingBrandWords.at(-1) : "";
  const showBookingBrandLogo = brandSettings.showLogo && !isBookingLogoHiddenByUrl();
  const bookingClientInput = {
    firstName: bookingForm.firstName,
    lastName: bookingForm.lastName,
    email: bookingForm.email,
    phone: bookingForm.phone,
  };
  const bookingClientHasInput = hasClientMatchInput(bookingClientInput);
  const bookingClientSuggestion = useMemo(() => {
    if (!bookingClientHasInput) return null;
    return findClientMatch(clients, bookingClientInput);
  }, [
    bookingClientHasInput,
    clients,
    bookingForm.firstName,
    bookingForm.lastName,
    bookingForm.email,
    bookingForm.phone,
  ]);
  const bookingClientSuggestionApplied = Boolean(
    bookingClientSuggestion &&
      normalizeMatchText(bookingInputName(bookingClientInput)) ===
        normalizeMatchText(bookingClientSuggestion.name) &&
      (!bookingClientSuggestion.phone ||
        phoneValuesMatch(bookingClientSuggestion.phone, bookingForm.phone, true)) &&
      (!bookingClientSuggestion.email ||
        normalizeMatchText(bookingClientSuggestion.email) === normalizeMatchText(bookingForm.email)),
  );
  const showBookingClientSuggestion = Boolean(
    bookingClientSuggestion && bookingClientHasInput && !bookingClientSuggestionApplied,
  );


  const bookingSlots = useMemo<BookingSlot[]>(() => {
    if (!selectedBookingService) return [];

    const bookingOptions = serviceBookingOptions(selectedBookingService);

    if (isScheduledGroupService(selectedBookingService)) {
      const schedule = selectedBookingService.groupSchedule;
      if (!schedule?.active) return [];
      const candidate = {
        week: activeWeek,
        day: schedule.dayOfWeek,
        start: schedule.startMinutes,
        duration: selectedBookingService.duration,
      };
      // A scheduled group is one session, with the first coach at the first place.
      const [{ coachId, locationId }] = bookingOptions;
      if (!isGroupServiceSlotMatch(selectedBookingService, activeWeek, schedule.dayOfWeek, schedule.startMinutes)) return [];
      if (hasCollision(candidate, undefined, selectedBookingService, { candidateCoachId: coachId, candidateLocationId: locationId })) return [];
      const remainingSpots = getGroupSlotRemainingSpots(candidate, selectedBookingService);
      if (!remainingSpots) return [];
      return [
        {
          week: candidate.week,
          day: candidate.day,
          start: candidate.start,
          remainingSpots,
          coachId,
          locationId,
        },
      ];
    }

    // Each time once, with the first coach and place (in the lesson type's
    // order) who are free for it -- the same rule the booking server uses,
    // Look busy included, across the whole week.
    const duration = selectedBookingService.duration;
    const slots: BookingSlot[] = [];
    const offered = new Set<string>();
    bookingOptions.forEach(({ coachId, locationId }) => {
      const coachAvailability = availabilityForCoach(accountAvailability, coachId, fallbackCoachId);
      for (let day = 0; day < 7; day += 1) {
        const windows = (coachAvailability[day] ?? []).filter((window) =>
          availabilityWindowCoversLocation(window, locationId),
        );
        const busy = lookBusy
          ? items
              .filter((item) => {
                if (itemWeek(item) !== activeWeek || item.day !== day || isInactiveForConflict(item)) return false;
                const service = itemService(item, services);
                return isLocationOnlyBlock(item)
                  ? resolvedCalendarItemLocationId(item, service, locations, coachAccount) === locationId
                  : resolvedCalendarItemCoachId(item, service, coachProfiles) === coachId;
              })
              .map((item) => ({ start: item.start, end: item.start + item.duration }))
          : [];
        windows.forEach((window) => {
          const starts: number[] = [];
          if (lookBusy) starts.push(...lookBusyStarts(window, duration, busy));
          else for (let start = window.start; start + duration <= window.end; start += 30) starts.push(start);
          for (const start of starts) {
            if (offered.has(`${day}:${start}`)) continue;
            const candidate = { week: activeWeek, day, start, duration };
            if (!hasCollision(candidate, undefined, selectedBookingService, { candidateCoachId: coachId, candidateLocationId: locationId })) {
              offered.add(`${day}:${start}`);
              slots.push({ week: activeWeek, day, start, remainingSpots: 0, coachId, locationId });
            }
          }
        });
      }
    });
    return slots.sort((a, b) => a.day - b.day || a.start - b.start);
  }, [
    accountAvailability,
    accountCoachProfiles,
    accountLocations,
    activeWeek,
    selectedBookingService,
    coachAccount,
    coachProfiles,
    locations,
    lookBusy,
    services,
    items,
    fallbackCoachId,
  ]);
  const visibleBookingSlots =
    bookingStart === null ? bookingSlots : bookingSlots.filter((slot) => slot.day === bookingDay && slot.start === bookingStart);

  const isAppointmentStepComplete = Boolean(selectedBookingService);
  const isDateTimeStepComplete = bookingDaySelected && bookingStart !== null;
  const isBookingCustomerDetailsComplete =
    bookingForm.firstName.trim() !== "" &&
    bookingForm.lastName.trim() !== "" &&
    bookingForm.email.trim() !== "";
  const isBookingInformationComplete =
    isBookingCustomerDetailsComplete &&
    (!isCustomGroupBooking || customGroupAttendees.length >= customGroupMinParticipants(selectedBookingService) - 1);
  const isInformationStepComplete = isDateTimeStepComplete && isBookingInformationComplete;
  const showCapturedCustomerDetailsSummary =
    isBookingCustomerDetailsComplete && (!isCustomGroupBooking || isBookingInformationComplete || !isDateTimeStepComplete);
  const bookingCustomerSummaryName =
    [bookingForm.firstName.trim(), bookingForm.lastName.trim()].filter(Boolean).join(" ") || t("Information complete");
  const bookingCustomerSummaryContact =
    [bookingForm.phone.trim(), bookingForm.email.trim()].filter(Boolean).join(" · ") || t("Customer details captured");

  const isAppointmentSectionOpen = openPublicBookingSection === "appointment";
  const isDateTimeSectionOpen = openPublicBookingSection === "datetime";
  const isInformationSectionOpen = openPublicBookingSection === "information";

  const appointmentSummaryName = selectedBookingService
    ? selectedBookingService.name
    : t("Choose an appointment type");
  const appointmentSummaryDescription = selectedBookingService?.description?.trim() || "";
  const appointmentSummaryLessonNote = selectedBookingService
    ? (selectedBookingService.lessonNote || selectedBookingService.location || "").trim()
    : "";
  const selectedBookingLocation = selectedBookingService
    ? bookingLocationSnapshotFor(selectedBookingService, locations, coachAccount)
    : bookingLocationSnapshotFor(undefined, locations, coachAccount);
  const appointmentSummaryDuration = selectedBookingService
    ? t("{duration} min · {price}", {
        duration: selectedBookingService.duration,
        price: isCustomGroupService(selectedBookingService)
          ? `${formatMoney(calculateCustomGroupPrice(selectedBookingService, customGroupMinParticipants(selectedBookingService)))}+`
          : servicePriceLabel(selectedBookingService),
      })
    : t("Select a lesson to continue");
  const dateTimeSummaryLocation = bookingLocationDisplay(selectedBookingLocation).slice(0, 180);
  const bookingDaySummary = bookingDaySelected ? weekDays[bookingDay]?.label ?? "" : t("No day selected");
  const dateTimeSummaryLine = isDateTimeStepComplete
    ? `${bookingDaySummary}, ${formatTime(bookingStart ?? 0)}`
    : bookingDaySelected
      ? bookingDaySummary
      : t("Choose a day");

  function getGroupSlotRemainingSpots(candidate: SlotCandidate, service?: Service) {
    if (!service || !isScheduledGroupService(service)) return 0;
    const bookedCount = items.filter(
      (item) =>
        item.kind === "appointment" &&
        item.serviceId === service.id &&
        overlaps(itemSlot(item), candidate) &&
        isActiveGroupBooking(item.status),
    ).length;
    return Math.max(0, service.capacity - bookedCount);
  }

  function applyBookingClient(client: ClientSummary) {
    const { firstName, lastName } = splitClientName(client.name);
    setBookingSubmitError("");
    setBookingForm({
      firstName,
      lastName,
      phone: client.phone,
      email: client.email,
    });
  }

  function updateBookingForm(field: keyof BookingForm, value: string) {
    setBookingSubmitError("");
    setBookingForm((current) => ({ ...current, [field]: value }));
  }

  function updateCustomGroupAttendeeDraft(field: "name" | "email", value: string) {
    setCustomGroupAttendeeDraft((current) => ({ ...current, [field]: value }));
  }

  function addCustomGroupAttendee() {
    if (!isCustomGroupBooking) return;
    const name = customGroupAttendeeDraft.name.trim();
    const email = customGroupAttendeeDraft.email.trim().toLowerCase();
    if (!name) {
      setToast({ message: t("Add a name for the attendee.") });
      return;
    }
    if (email && !email.includes("@")) {
      setToast({ message: t("Enter a valid attendee email or leave it blank.") });
      return;
    }
    if (customGroupParticipantCount >= customGroupMaxParticipants(selectedBookingService)) {
      setToast({ message: t("This custom group is already at its maximum size.") });
      return;
    }
    setCustomGroupAttendees((current) => [
      ...current,
      {
        id: `attendee-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        email: email || undefined,
        status: email ? "invited" : "manual",
      },
    ]);
    setCustomGroupAttendeeDraft({ name: "", email: "" });
  }

  function removeCustomGroupAttendee(attendeeId: string) {
    setCustomGroupAttendees((current) => current.filter((attendee) => attendee.id !== attendeeId));
  }

  function setPublicBookingSection(section: PublicBookingSection) {
    setOpenPublicBookingSection(section);
  }

  function handlePublicBookingServiceSelect(serviceId: string) {
    const isCurrent = serviceId === bookingServiceId;
    setBookingServiceId(isCurrent ? "" : serviceId);
    setBookingSubmitError("");
    setCustomGroupAttendees([]);
    setCustomGroupAttendeeDraft({ name: "", email: "" });
    setBookingDaySelected(false);
    setBookingStart(null);
    setOpenPublicBookingSection(isCurrent ? "appointment" : "datetime");
  }

  const isGroupBookingTimeSelection =
    isScheduledGroupService(selectedBookingService);

  function handlePublicBookingTimeSelect(slot: BookingSlot) {
    const next = bookingDaySelected && bookingDay === slot.day && bookingStart === slot.start ? null : slot.start;
    setBookingSubmitError("");
    setBookingDay(slot.day);
    setBookingDaySelected(next !== null);
    setBookingStart(next);
    setOpenPublicBookingSection(next === null ? "datetime" : "information");
  }

  function handleBookingMatchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") event.currentTarget.blur();
  }

  async function confirmPublicBooking() {
    if (!selectedBookingService || bookingStart === null) {
      const message = t("Choose a lesson time before confirming.");
      setBookingSubmitError(message);
      setToast({ message });
      return;
    }
    setBookingSubmitError("");
    // Typed values are authoritative. A saved-client suggestion only changes
    // the booking after the user explicitly clicks it and fills these fields.
    const firstName = bookingForm.firstName.trim();
    const lastName = bookingForm.lastName.trim();
    const phone = bookingForm.phone.trim();
    const email = bookingForm.email.trim();
    const client = [firstName, lastName].filter(Boolean).join(" ").trim();

    if (!firstName || !lastName || !email) {
      const message = t("First name, last name, and email are required.");
      setBookingSubmitError(message);
      setToast({ message });
      return;
    }
    if (isCustomGroupBooking && customGroupAttendees.length < customGroupMinParticipants(selectedBookingService) - 1) {
      const message = t("Add at least one other person before confirming.");
      setBookingSubmitError(message);
      setToast({ message });
      return;
    }

    // The coach and place the chosen time was offered with.
    const chosenSlot = bookingSlots.find((slot) => slot.day === bookingDay && slot.start === bookingStart);
    const [firstOption] = serviceBookingOptions(selectedBookingService);
    const chosenLocation = locationById(locations, chosenSlot?.locationId || firstOption.locationId);
    const selectedBooking = {
      service: selectedBookingService,
      week: activeWeek,
      day: bookingDay,
      start: bookingStart,
      duration: selectedBookingService.duration,
      location: chosenLocation
        ? locationSnapshot(chosenLocation)
        : bookingLocationSnapshotFor(selectedBookingService, locations, coachAccount),
      coachId: chosenSlot?.coachId || firstOption.coachId,
    };
    const selectedBookingCoach = bookingCoachSnapshotFor(selectedBooking.coachId, coachProfiles);
    const candidate = {
      week: selectedBooking.week,
      day: selectedBooking.day,
      start: selectedBooking.start,
      duration: selectedBooking.duration,
    };
    if (
      hasCollision(candidate, undefined, selectedBookingService, {
        candidateCoachId: selectedBooking.coachId,
        candidateLocationId: selectedBooking.location.locationId,
      })
    ) {
      const message = t("That time has just been taken. Pick another slot.");
      setBookingSubmitError(message);
      setOpenPublicBookingSection("information");
      setToast({ message });
      return;
    }

    const item: CalendarItem = {
      id: newCalendarItemId("appt"),
      kind: "appointment",
      accountId: activeAccountId,
      ...candidate,
      serviceId: selectedBooking.service.id,
      coachId: selectedBooking.coachId,
      locationId: selectedBooking.location.locationId,
      coach: selectedBookingCoach,
      client,
      title: client,
      phone,
      email,
      note: "Booked from public booking page.",
      location: selectedBooking.location,
      ...(isCustomGroupBooking
        ? {
            customGroup: true as const,
            attendees: [
              { id: `booker-${Date.now()}`, name: client, email, status: "booker" as const },
              ...customGroupAttendees,
            ],
            calculatedPrice: customGroupCalculatedPrice,
          }
        : {}),
    };
    setItems(carveBusyBlocksForAppointment([...items, item], itemSlot(item)));
    closeCalendarDetails();
    setActiveView("calendar");
    setBookingStart(null);
    setCustomGroupAttendees([]);
    setCustomGroupAttendeeDraft({ name: "", email: "" });
    setBookingForm({ firstName: "", lastName: "", phone: "", email: "" });
    setBookingSubmitError("");
    setToast({
      message: t("{client} booked {name} on {short} at {start}.", { client, name: selectedBooking.service.name, short: weekDays[item.day].short, start: formatTime(item.start) }),
    });
  }

  const customGroupAttendeePanel = isCustomGroupBooking ? (
    <div className="custom-group-panel">
      <div className="custom-group-summary">
        <span>{t("Attendees")}</span>
        <strong>
          {customGroupParticipantCount} / {customGroupMaxParticipants(selectedBookingService)}
        </strong>
        <em>{formatMoney(customGroupCalculatedPrice)}</em>
      </div>
      <div className="booking-form custom-group-attendee-form">
        <input
          value={customGroupAttendeeDraft.name}
          onChange={(event) => updateCustomGroupAttendeeDraft("name", event.target.value)}
          placeholder={t("Attendee name")}
        />
        <input
          value={customGroupAttendeeDraft.email}
          autoComplete="email"
          inputMode="email"
          onChange={(event) => updateCustomGroupAttendeeDraft("email", event.target.value)}
          placeholder={t("Email optional")}
          type="email"
        />
      </div>
      <button
        className="outline-button"
        disabled={customGroupRemainingAttendees <= 0}
        onClick={addCustomGroupAttendee}
        type="button"
      >
        <Plus size={16} />{t("Add attendee")}</button>
      <div className="custom-group-attendee-list">
        <div className="custom-group-attendee-row">
          <span>
            <strong>{[bookingForm.firstName, bookingForm.lastName].filter(Boolean).join(" ").trim() || t("Booker")}</strong>
            <em>{bookingForm.email || t("Email required")}</em>
          </span>
          <small>{customGroupStatusLabel("booker")}</small>
        </div>
        {customGroupAttendees.map((attendee) => (
          <div className="custom-group-attendee-row" key={attendee.id}>
            <span>
              <strong>{attendee.name}</strong>
              <em>{attendee.email || t("Manual attendee")}</em>
            </span>
            <small>{customGroupStatusLabel(attendee.status)}</small>
            <button
              className="icon-button small"
              onClick={() => removeCustomGroupAttendee(attendee.id)}
              aria-label={t("Remove {name}", { name: attendee.name })}
              type="button"
            >
              <X size={15} />
            </button>
          </div>
        ))}
      </div>
      {customGroupAttendees.length < customGroupMinParticipants(selectedBookingService) - 1 && (
        <p className="field-help">{t("Add at least one other person before confirming.")}</p>
      )}
    </div>
  ) : null;

  return {
    ...app,
    bookingCardScheme,
    showBookingBrandLogo,
    bookingBrandPrimary,
    bookingBrandSecondary,
    isAppointmentSectionOpen,
    isAppointmentStepComplete,
    setPublicBookingSection,
    visiblePublicServices,
    handlePublicBookingServiceSelect,
    appointmentSummaryName,
    appointmentSummaryDuration,
    appointmentSummaryDescription,
    appointmentSummaryLessonNote,
    isDateTimeSectionOpen,
    isDateTimeStepComplete,
    selectedBookingService,
    visibleBookingSlots,
    isGroupBookingTimeSelection,
    bookingDay,
    handlePublicBookingTimeSelect,
    dateTimeSummaryLine,
    dateTimeSummaryLocation,
    isInformationSectionOpen,
    showCapturedCustomerDetailsSummary,
    bookingForm,
    updateBookingForm,
    handleBookingMatchKeyDown,
    bookingClientSuggestion,
    showBookingClientSuggestion,
    applyBookingClient,
    customGroupAttendeePanel,
    bookingSubmitError,
    isInformationStepComplete,
    confirmPublicBooking,
    bookingCustomerSummaryName,
    bookingCustomerSummaryContact,
  };
}

export type BookingFlow = ReturnType<typeof useBookingFlow>;
